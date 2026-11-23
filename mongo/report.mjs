import { withMongo } from "./config.mjs";
import { computeReport, formatReport, num } from "./reporting.mjs";

function parseArgs(argv) {
  const args = { strategy: "all", since: null, evaluator: null, includeLegacy: false, seed: 42, iterations: 2000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--include-legacy") args.includeLegacy = true;
    else if (["--strategy", "--since", "--evaluator", "--seed", "--iterations"].includes(flag)) {
      args[flag.slice(2)] = argv[++index];
    } else throw new Error(`Unknown option: ${flag}`);
  }
  args.seed = Number(args.seed);
  args.iterations = Number(args.iterations);
  if (!Number.isInteger(args.seed) || !Number.isInteger(args.iterations) || args.iterations < 1) {
    throw new Error("--seed and --iterations must be positive integers.");
  }
  if (args.since && Number.isNaN(new Date(args.since).getTime())) throw new Error("--since must be an ISO date.");
  return args;
}

function baseFilter(args, timeField) {
  const filter = {};
  if (args.strategy !== "all") filter.strategy_id = args.strategy;
  if (args.since) filter[timeField] = { $gte: new Date(args.since) };
  if (!args.includeLegacy) filter.legacy_unverified = { $ne: true };
  return filter;
}

/** The only producer of aggregate report numbers. Reads MongoDB, never SQLite. */
export async function generateReports(db, args, rng) {
  const signalFilter = baseFilter(args, "bar_ts");
  const outcomeFilter = baseFilter(args, "entry_time");
  if (args.evaluator) outcomeFilter.evaluator_version = args.evaluator;

  const [signals, outcomes] = await Promise.all([
    db.collection("signals").find(signalFilter).toArray(),
    db.collection("outcomes").find(outcomeFilter).toArray(),
  ]);
  const ids = signals.map((signal) => signal._id);
  const [statuses, publications] = await Promise.all([
    db.collection("signal_status_log").find({ signal_id: { $in: ids } }).toArray(),
    db.collection("publications").find({ signal_id: { $in: ids } }).toArray(),
  ]);

  const strategyIds = args.strategy === "all"
    ? [...new Set([...signals.map((signal) => signal.strategy_id),
      ...outcomes.map((outcome) => outcome.strategy_id)])].sort()
    : [args.strategy];

  const reports = [];
  for (const strategyId of strategyIds.length > 0 ? [...strategyIds, "all"] : []) {
    const scoped = (rows) => strategyId === "all" ? rows : rows.filter((row) => row.strategy_id === strategyId);
    const scopedSignals = scoped(signals);
    const scopedIds = new Set(scopedSignals.map((signal) => String(signal._id)));
    reports.push(computeReport({
      strategyId,
      evaluatorVersion: args.evaluator ?? "any",
      signals: scopedSignals,
      statuses: statuses.filter((status) => scopedIds.has(String(status.signal_id))),
      publications: publications.filter((publication) => scopedIds.has(String(publication.signal_id))),
      outcomes: scoped(outcomes),
      rng,
      bootstrapIterations: args.iterations,
      since: args.since,
    }));
  }
  return reports;
}

/** Re-query and sum outcome net directly, so the report's net_units can be tied out. */
export async function outcomeNetSum(db, args) {
  const filter = baseFilter(args, "entry_time");
  if (args.evaluator) filter.evaluator_version = args.evaluator;
  const rows = await db.collection("outcomes").find(filter, { projection: { net: 1 } }).toArray();
  return rows.reduce((sum, row) => sum + num(row.net), 0);
}

export function assertReportsTieOut(reports, netSum) {
  for (const report of reports) {
    if (report.strategy_id !== "all") continue;
    if (Math.abs(report.net_units - netSum) > 1e-6) {
      throw new Error(`Report net_units ${report.net_units} does not tie out to DB sum ${netSum}.`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { mulberry32 } = await import("./reporting.mjs");
  await withMongo({}, async (db) => {
    const reports = await generateReports(db, args, mulberry32(args.seed));
    const netSum = await outcomeNetSum(db, args);
    assertReportsTieOut(reports, netSum);
    for (const report of reports) console.log(formatReport(report));
  });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/mongo/report.mjs")) {
  main().catch((error) => {
    console.error(`Report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
