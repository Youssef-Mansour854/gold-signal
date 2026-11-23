import test from "node:test";
import assert from "node:assert/strict";
import { Decimal128 } from "mongodb";
import {
  betaInc, cairoTime, computeReport, formatReport, mulberry32, num, tTestP,
} from "../mongo/reporting.mjs";

function outcome(index, { net, gross = net + 0.05, r, type = "TARGET", version = "v1.0.0" } = {}) {
  const entry = new Date(Date.UTC(2026, 0, 1, 0, index, 0));
  return {
    signal_id: `signal-${index}`,
    strategy_id: "baseline-sma-5-12",
    evaluator_version: version,
    entry_rule_version: "v1",
    cost_model_version: "v1",
    entry_time: entry,
    exit_time: new Date(entry.getTime() + 60_000),
    exit_type: type,
    ambiguous: false,
    gross: Decimal128.fromString(String(gross)),
    slippage_cost: Decimal128.fromString("0.05"),
    commission_cost: Decimal128.fromString("0"),
    net: Decimal128.fromString(String(net)),
    r_realized: Decimal128.fromString(String(r ?? net)),
  };
}

function baseRows() {
  const outcomes = [
    outcome(1, { net: 0.5 }),
    outcome(2, { net: -0.25 }),
    outcome(3, { net: 0.75 }),
    outcome(4, { net: 0, type: "NOT_FILLED" }),
  ];
  return {
    signals: outcomes.map((row) => ({ _id: row.signal_id, strategy_id: row.strategy_id })),
    outcomes,
    statuses: [
      { status: "generated" }, { status: "published" }, { status: "published" },
      { status: "published" }, { status: "expired" },
    ],
    publications: outcomes.map((row) => ({ signal_id: row.signal_id })),
  };
}

test("statistics helpers produce known values", () => {
  assert.ok(Math.abs(betaInc(2, 3, 0.5) - 0.6875) < 1e-9);
  assert.ok(Math.abs(tTestP([1, 2, 3, 4, 5]) - 0.0132356) < 1e-5);
  assert.equal(tTestP([1]), null);
  assert.equal(tTestP([0, 0, 0]), 1);
  assert.equal(num(Decimal128.fromString("1.5")), 1.5);
  assert.equal(num(null), 0);
});

test("Cairo display column is UTC+2 and can cross midnight", () => {
  assert.equal(cairoTime(new Date("2026-01-01T23:30:00.000Z")), "2026-01-02 01:30");
  assert.equal(cairoTime(new Date("2026-01-01T10:00:00.000Z")), "2026-01-01 12:00");
});

test("report totals tie out to stored Decimal128 outcome sums", () => {
  const rows = baseRows();
  const report = computeReport({ ...rows, rng: mulberry32(7), bootstrapIterations: 32 });
  const dbSum = rows.outcomes.reduce((sum, row) => sum + num(row.net), 0);
  assert.equal(report.net_units, 1);
  assert.equal(dbSum, 1);
  assert.equal(report.counts.signals, 4);
  assert.equal(report.counts.trades, 3);
  assert.equal(report.counts.not_filled, 1);
  assert.equal(report.win_rate, 2 / 3);
  assert.deepEqual(report.exit_mix, { TARGET: 3, NOT_FILLED: 1 });
  assert.equal(report.max_drawdown_units, -0.25);
  assert.ok(Math.abs(report.profit_factor - 6.75) < 1e-9);
  assert.deepEqual(report.versions, [["v1.0.0", "v1", "v1"]]);
  assert.deepEqual(report.flags, ["LOW_SAMPLE"]);
});

test("bootstrap is deterministic with a seed and covers trade-level plus clustered samples", () => {
  const rows = baseRows();
  const first = computeReport({ ...rows, rng: mulberry32(42), bootstrapIterations: 64 });
  const second = computeReport({ ...rows, rng: mulberry32(42), bootstrapIterations: 64 });
  assert.deepEqual(first.bootstrap_ci, second.bootstrap_ci);
  assert.equal(first.bootstrap_ci.trade_level.length, 2);
  assert.equal(first.bootstrap_ci.day_clustered.length, 2);
  assert.ok(first.bootstrap_ci.trade_level[0] <= first.bootstrap_ci.trade_level[1]);
});

test("mixed versions produce NOT_COMPARABLE and session rows carry both time columns", () => {
  const rows = baseRows();
  rows.outcomes[1] = outcome(2, { net: -0.25, version: "v0.9.0" });
  const report = computeReport({ ...rows, rng: mulberry32(1), bootstrapIterations: 16 });
  assert.deepEqual(report.flags, ["LOW_SAMPLE", "NOT_COMPARABLE"]);
  assert.equal(report.versions.length, 2);
  const session = Object.values(report.sessions).find((row) => row.trades > 0);
  assert.ok(session.first_utc.endsWith("Z"));
  assert.match(session.first_cairo, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(formatReport(report), /flags=LOW_SAMPLE,NOT_COMPARABLE/);
});

test("period mismatch is flagged when rows predate --since", () => {
  const rows = baseRows();
  const report = computeReport({ ...rows, since: "2026-02-01T00:00:00.000Z", rng: mulberry32(3), bootstrapIterations: 8 });
  assert.ok(report.flags.includes("PERIOD_FILTER_MISMATCH"));
});
