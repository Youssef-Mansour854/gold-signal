import { EVALUATOR_VERSION, withMongo } from "./config.mjs";
import { decimalNumber } from "./canonical.mjs";
import { evaluate } from "./evaluator/index.ts";
import { verifyLedger } from "./ledger.mjs";
import { insertPlain } from "./store.mjs";
import { computeReport } from "./reporting.mjs";
import { dictionaryEntries, validatorFieldPaths } from "./schema/dictionary.mjs";

const EPSILON = 1e-6;
const TF_MS = { m1: 60_000, m5: 300_000, m15: 900_000, m60: 3_600_000 };

function num(value) {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : decimalNumber(value);
}

function equal(a, b) {
  return typeof a === "number" && typeof b === "number"
    ? Math.abs(a - b) <= EPSILON
    : a === b;
}

function checkResult(checkName, pass, details, evaluatorVersion) {
  return { check_name: checkName, pass, details, evaluator_version: evaluatorVersion };
}

async function loadContext(db, evaluatorVersion, includeLegacy) {
  const legacyFilter = includeLegacy ? {} : { legacy_unverified: { $ne: true } };
  const [outcomes, signals, statuses, publications, priceBars, entryRules, costModels, strategyVersions,
    outcomeEvents, dictionary, hypotheses, integrityRuns] = await Promise.all([
    db.collection("outcomes").find({ evaluator_version: evaluatorVersion, ...legacyFilter }).toArray(),
    db.collection("signals").find(legacyFilter).toArray(),
    db.collection("signal_status_log").find(legacyFilter).toArray(),
    db.collection("publications").find({}).toArray(),
    db.collection("price_bars").find({ is_closed: true }).sort({ ts_open: 1 }).toArray(),
    db.collection("entry_rules").find({}).toArray(),
    db.collection("cost_models").find({}).toArray(),
    db.collection("strategy_versions").find({}).toArray(),
    db.collection("outcome_events").find({ evaluator_version: evaluatorVersion }).toArray(),
    db.collection("data_dictionary").find({}).toArray(),
    db.collection("hypotheses").find({}).toArray(),
    db.collection("integrity_runs").find({}).toArray(),
  ]);
  return {
    outcomes, signals, statuses, publications, priceBars, entryRules, costModels,
    strategyVersions, outcomeEvents, dictionary, hypotheses, integrityRuns,
    signalById: new Map(signals.map((signal) => [String(signal._id), signal])),
  };
}

function barsFor(outcome, priceBars) {
  const ref = outcome.data_range_ref;
  if (!ref) return [];
  return priceBars
    .filter((bar) => bar.source === ref.source && bar.symbol === ref.symbol && bar.tf === ref.tf
      && bar.ts_open >= ref.from && bar.ts_open <= ref.to)
    .map((bar) => ({
      ts_open: new Date(bar.ts_open),
      o: num(bar.o), h: num(bar.h), l: num(bar.l), c: num(bar.c),
      bid: bar.bid === undefined ? undefined : num(bar.bid),
      ask: bar.ask === undefined ? undefined : num(bar.ask),
      tf: bar.tf,
    }));
}

function recomputeCheck(context) {
  const mismatches = [];
  let checked = 0;
  let skippedLegacy = 0;
  for (const outcome of context.outcomes) {
    if (outcome.legacy_unverified || outcome.evaluator_version === "legacy-unverified") {
      skippedLegacy += 1;
      continue;
    }
    const signal = context.signalById.get(String(outcome.signal_id));
    if (!signal) continue;
    const publication = context.publications.find((row) => String(row.signal_id) === String(signal._id));
    const entryRule = context.entryRules.find((row) => row.version === outcome.entry_rule_version);
    const costModel = context.costModels.find((row) => row.version === outcome.cost_model_version);
    const strategyVersion = context.strategyVersions.find(
      (row) => row.params_hash === signal.strategy_version_id,
    ) ?? context.strategyVersions.find((row) => row.strategy_id === outcome.strategy_id);
    if (!publication || !entryRule || !costModel || !strategyVersion) {
      mismatches.push({ signal_id: String(signal._id), fields: ["MISSING_INPUT"] });
      continue;
    }
    const bars = barsFor(outcome, context.priceBars);
    const result = evaluate({
      signal: {
        strategy_id: outcome.strategy_id,
        direction: signal.direction,
        bar_ts: new Date(signal.bar_ts),
        published_at: new Date(publication.sent_at),
        entry_ref: num(signal.entry_ref),
        stop: num(signal.stop),
        target: num(signal.target),
        planned_risk_usd_per_001lot: num(signal.planned_risk_usd_per_001lot),
        order_type: signal.order_type,
        zone_low: signal.zone_low === undefined ? undefined : num(signal.zone_low),
        zone_high: signal.zone_high === undefined ? undefined : num(signal.zone_high),
      },
      bars,
      entryRule: {
        version: entryRule.version,
        definition: {
          entry_delay_seconds: entryRule.definition.entry_delay_seconds,
          buy_price_field: entryRule.definition.buy_price_field,
          sell_price_field: entryRule.definition.sell_price_field,
          trigger: entryRule.definition.trigger,
          derivation: entryRule.definition.derivation,
        },
      },
      costModel: {
        version: costModel.version,
        spread_usd: num(costModel.spread_usd),
        slippage_usd: num(costModel.slippage_usd),
        commission_usd: num(costModel.commission_usd),
      },
      strategyParams: {
        timeoutMinutes: strategyVersion.params.timeoutMinutes,
        targetsR: strategyVersion.params.targetsR,
        stopPercent: strategyVersion.params.stopPercent,
        trailingAfterR: strategyVersion.params.trailingAfterR,
      },
      evaluatorVersion: outcome.evaluator_version,
      source: outcome.data_range_ref.source,
      symbol: outcome.data_range_ref.symbol,
      tf: outcome.data_range_ref.tf,
    });
    const expected = result.outcome;
    const fields = [];
    const comparisons = [
      ["entry_price", expected.entry_price, num(outcome.entry_price)],
      ["exit_price", expected.exit_price, num(outcome.exit_price)],
      ["exit_type", expected.exit_type, outcome.exit_type],
      ["net", expected.net, num(outcome.net)],
      ["mfe", expected.mfe, num(outcome.mfe)],
      ["mae", expected.mae, num(outcome.mae)],
    ];
    for (const [field, wanted, actual] of comparisons) {
      if (!equal(wanted, actual)) fields.push(field);
    }
    if (expected.ambiguous !== Boolean(outcome.ambiguous)) fields.push("ambiguous");
    checked += 1;
    if (fields.length > 0) mismatches.push({ signal_id: String(signal._id), fields });
  }
  return checkResult(
    "outcome_recompute",
    mismatches.length === 0,
    { checked, skipped_legacy: skippedLegacy, mismatches },
    "",
  );
}

function exitConsistencyCheck(context) {
  const wrongRange = [];
  const strayEvents = [];
  for (const outcome of context.outcomes) {
    if (outcome.legacy_unverified) continue;
    const ref = outcome.data_range_ref;
    const bar = ref ? context.priceBars.find((candidate) => candidate.source === ref.source
      && candidate.symbol === ref.symbol && candidate.tf === ref.tf
      && candidate.ts_open.getTime() === new Date(outcome.exit_time).getTime()) : null;
    if (bar) {
      // Widen the raw bar range by half the stored spread so a quote-derived
      // exit on either side of the book is accepted; no other slack is given.
      const spread = num(bar.spread ?? 0) / 2;
      const low = Math.min(num(bar.l) - spread, num(bar.bid ?? num(bar.l)));
      const high = Math.max(num(bar.h) + spread, num(bar.ask ?? num(bar.h)));
      const price = num(outcome.exit_price);
      if (price < low - EPSILON || price > high + EPSILON) {
        wrongRange.push({ signal_id: String(outcome.signal_id), price, low, high });
      }
    }
  }
  for (const event of context.outcomeEvents) {
    const outcome = context.outcomes.find((row) => String(row.signal_id) === String(event.signal_id));
    if (!outcome) continue;
    if (event.ts < new Date(outcome.entry_time)
      || event.ts > new Date(outcome.exit_time)) {
      strayEvents.push({ signal_id: String(event.signal_id), type: event.type });
    }
  }
  return checkResult(
    "exit_consistency",
    wrongRange.length === 0 && strayEvents.length === 0,
    { wrong_range: wrongRange, stray_events: strayEvents },
    "",
  );
}

function timeOrderCheck(context) {
  const violations = [];
  for (const outcome of context.outcomes) {
    const signal = context.signalById.get(String(outcome.signal_id));
    if (!signal) continue;
    const publication = context.publications.find((row) => String(row.signal_id) === String(signal._id));
    const times = [
      ["bar_ts", new Date(signal.bar_ts)],
      ["generated_at", new Date(signal.generated_at)],
      ["published_at", publication ? new Date(publication.sent_at) : new Date(signal.generated_at)],
      ["entry_time", new Date(outcome.entry_time)],
      ["exit_time", new Date(outcome.exit_time)],
    ];
    for (let index = 1; index < times.length; index += 1) {
      if (times[index][1] < times[index - 1][1]) {
        violations.push({
          signal_id: String(signal._id),
          pair: [times[index - 1][0], times[index][0]],
        });
      }
    }
  }
  return checkResult("time_order", violations.length === 0, { violations }, "");
}

function linkCheck(context) {
  const missingStatus = context.signals
    .filter((signal) => !context.statuses.some((status) => String(status.signal_id) === String(signal._id)))
    .map((signal) => String(signal._id));
  const missingMessageId = context.publications
    .filter((publication) => !publication.message_id)
    .map((publication) => String(publication.signal_id));
  const orphanOutcomes = context.outcomes
    .filter((outcome) => !context.signalById.has(String(outcome.signal_id)))
    .map((outcome) => String(outcome.signal_id));
  return checkResult(
    "required_links",
    missingStatus.length === 0 && missingMessageId.length === 0 && orphanOutcomes.length === 0,
    { missing_status: missingStatus, missing_message_id: missingMessageId, orphan_outcomes: orphanOutcomes },
    "",
  );
}

function countCheck(context) {
  const counts = context.statuses.reduce((acc, status) => {
    acc[status.status] = (acc[status.status] ?? 0) + 1;
    return acc;
  }, {});
  const terminal = ["published", "rejected", "expired", "cancelled"]
    .reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  const pending = context.signals.length - terminal;
  const ok = pending >= 0 && terminal <= context.signals.length;
  return checkResult("count_reconciliation", ok, {
    signals: context.signals.length,
    terminal,
    pending,
    status_counts: counts,
  }, "");
}

function barsCheck(context) {
  const groups = new Map();
  const duplicates = [];
  for (const bar of context.priceBars) {
    const key = `${bar.source}|${bar.symbol}|${bar.tf}|${bar.ts_open.toISOString()}`;
    if (groups.has(key)) duplicates.push(key);
    (groups.get(key) ?? groups.set(key, []).get(key)).push(bar);
  }
  const gaps = [];
  const skippedTf = [];
  for (const [key, bars] of groups) {
    const tf = bars[0].tf;
    const expectedMs = TF_MS[tf];
    if (!expectedMs) {
      skippedTf.push(tf);
      continue;
    }
    const sorted = [...bars].sort((a, b) => a.ts_open - b.ts_open);
    for (let index = 1; index < sorted.length; index += 1) {
      const delta = sorted[index].ts_open - sorted[index - 1].ts_open;
      if (delta > expectedMs * 1.5) {
        gaps.push({ key, from: sorted[index - 1].ts_open.toISOString(), to: sorted[index].ts_open.toISOString() });
      }
    }
  }
  return checkResult("bars_quality", duplicates.length === 0 && gaps.length === 0, {
    duplicates, gaps, gap_check_skipped_tf: [...new Set(skippedTf)],
  }, "");
}

function tieOutCheck(context, evaluatorVersion) {
  const report = computeReport({
    strategyId: "all",
    evaluatorVersion,
    signals: context.signals,
    statuses: context.statuses,
    publications: context.publications,
    outcomes: context.outcomes,
    rng: () => 0.5,
    bootstrapIterations: 2,
  });
  const directSum = context.outcomes.reduce((sum, outcome) => sum + num(outcome.net), 0);
  const ok = Math.abs(report.net_units - directSum) <= EPSILON;
  return checkResult("aggregate_tieout", ok, {
    report_net_units: report.net_units,
    db_net_units: directSum,
    trades: report.counts.trades,
  }, evaluatorVersion);
}

async function dictionaryCheck(db, context) {
  const covered = new Set(context.dictionary.map((entry) => `${entry.collection}.${entry.field}`));
  const missing = validatorFieldPaths()
    .map(({ collection, field }) => ({ collection, field }))
    .filter(({ collection, field }) => !covered.has(`${collection}.${field}`));
  const locallyMissing = dictionaryEntries().length === 0;
  return checkResult("dictionary_coverage", missing.length === 0 && !locallyMissing, {
    stored_entries: context.dictionary.length,
    validator_fields: validatorFieldPaths().length,
    missing,
  }, "");
}

function hypothesisCheck(context, hypothesisId) {
  const violations = [];
  for (const run of context.integrityRuns) {
    const ref = run.details?.analysis_ref;
    if (!ref) continue;
    const hypothesis = context.hypotheses.find((row) => String(row._id) === String(ref));
    if (!hypothesis || new Date(hypothesis.registered_at) > new Date(run.run_ts)) {
      violations.push({ analysis_ref: String(ref), run_ts: new Date(run.run_ts).toISOString() });
    }
  }
  if (hypothesisId) {
    const hypothesis = context.hypotheses.find((row) => String(row._id) === String(hypothesisId));
    if (!hypothesis || new Date(hypothesis.registered_at) > new Date()) {
      violations.push({ analysis_ref: String(hypothesisId), run_ts: new Date().toISOString() });
    }
  }
  return checkResult("hypothesis_order", violations.length === 0, { violations }, "");
}

/** Runs all ten checks and stores one integrity_runs document per check. */
export async function runIntegrityChecks(db, {
  evaluatorVersion = EVALUATOR_VERSION,
  hypothesisId = null,
  includeLegacy = false,
  persist = true,
  runTs = new Date(),
} = {}) {
  const context = await loadContext(db, evaluatorVersion, includeLegacy);
  const ledger = await verifyLedger(db);
  const checks = [
    recomputeCheck(context),
    exitConsistencyCheck(context),
    timeOrderCheck(context),
    linkCheck(context),
    countCheck(context),
    barsCheck(context),
    tieOutCheck(context, evaluatorVersion),
    { check_name: "ledger_chain", pass: ledger.ok, details: ledger, evaluator_version: evaluatorVersion },
    await dictionaryCheck(db, context),
    hypothesisCheck(context, hypothesisId),
  ];

  const stored = [];
  for (const check of checks) {
    const document = {
      run_ts: runTs,
      check_name: check.check_name,
      result: check.pass ? "pass" : "fail",
      details: check.details,
      evaluator_version: evaluatorVersion,
      provenance: "evaluator",
    };
    const saved = persist ? await insertPlain(db, "integrity_runs", document) : document;
    stored.push({ ...check, stored_id: saved._id ? String(saved._id) : null });
  }
  const report = {
    run_ts: runTs.toISOString(),
    evaluator_version: evaluatorVersion,
    ok: stored.every((check) => check.pass),
    failed: stored.filter((check) => !check.pass).map((check) => check.check_name),
    checks: stored,
  };
  return report;
}

async function main() {
  const args = { evaluatorVersion: EVALUATOR_VERSION, hypothesisId: null };
  for (let index = 0; index < process.argv.slice(2).length; index += 1) {
    const flag = process.argv.slice(2)[index];
    if (flag === "--evaluator") args.evaluatorVersion = process.argv.slice(2)[++index];
    else if (flag === "--hypothesis") args.hypothesisId = process.argv.slice(2)[++index];
    else throw new Error(`Unknown option: ${flag}`);
  }
  await withMongo({}, async (db) => {
    const report = await runIntegrityChecks(db, args);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/mongo/integrity.mjs")) {
  main().catch((error) => {
    console.error(`Integrity check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
