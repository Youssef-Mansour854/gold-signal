import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, EVALUATOR_VERSION } from "../mongo/evaluator/index.ts";
import { canonicalJson } from "../mongo/canonical.mjs";

const ENTRY_RULE = {
  version: "v1",
  definition: {
    entry_delay_seconds: 30,
    buy_price_field: "ask",
    sell_price_field: "bid",
    trigger: "first_executable",
    derivation: "cost_model_mid",
  },
};
const COST_MODEL = { version: "v1", spread_usd: 0.25, slippage_usd: 0.05, commission_usd: 0 };
const PARAMS = { timeoutMinutes: 120, targetsR: [1, 2, 3], stopPercent: 0.5 };

function bar(ts, o, h, l, c, extra = {}) {
  return { ts_open: new Date(ts), o, h, l, c, ...extra };
}

function signal(overrides = {}) {
  return {
    strategy_id: "baseline-sma-5-12",
    direction: "BUY",
    bar_ts: new Date("2026-01-01T00:00:00.000Z"),
    published_at: new Date("2026-01-01T00:00:05.000Z"),
    entry_ref: 100,
    stop: 99.5,
    target: 100.5,
    planned_risk_usd_per_001lot: 0.5,
    ...overrides,
  };
}

const ENTRY_BAR = bar("2026-01-01T00:00:35.000Z", 100, 100.2, 99.9, 100.1);

function input(bars, overrides = {}) {
  return {
    signal: signal(),
    bars: [ENTRY_BAR, ...bars],
    entryRule: ENTRY_RULE,
    costModel: COST_MODEL,
    strategyParams: PARAMS,
    source: "gold-api",
    symbol: "XAU/USD",
    tf: "tick",
    ...overrides,
  };
}

test("evaluator has an explicit version", () => {
  assert.equal(EVALUATOR_VERSION, "v1.0.0");
});

test("target only: touch fills at the target on the bid for a long", () => {
  const { outcome, events } = evaluate(input([
    bar("2026-01-01T00:01:00.000Z", 100, 101, 99.8, 100.5),
  ]));
  assert.equal(outcome.exit_type, "TARGET");
  assert.equal(outcome.exit_price, 100.5);
  assert.equal(outcome.entry_price, 100.125);
  assert.equal(outcome.gross, 0.375);
  assert.equal(outcome.net, 0.325);
  assert.equal(outcome.ambiguous, false);
  assert.deepEqual(events.map((event) => event.type), ["ENTRY", "TOUCH_TARGET", "EXIT"]);
});

test("stop only: touch fills at the stop and costs reduce net", () => {
  const { outcome } = evaluate(input([
    bar("2026-01-01T00:01:00.000Z", 100, 100.4, 99, 99.2),
  ]));
  assert.equal(outcome.exit_type, "STOP");
  assert.equal(outcome.exit_price, 99.5);
  assert.equal(outcome.gross, -0.625);
  assert.equal(outcome.net, -0.675);
  assert.equal(outcome.r_realized, -1.35);
});

test("both levels in one bar: stop wins and is marked ambiguous without finer data", () => {
  const { outcome, events } = evaluate(input([
    bar("2026-01-01T00:01:00.000Z", 100, 101, 99, 100),
  ]));
  assert.equal(outcome.exit_type, "STOP");
  assert.equal(outcome.ambiguous, true);
  assert.equal(outcome.resolved_by, "assumed_stop");
  assert.equal(outcome.exit_reason_code, "AMBIGUOUS_ASSUMED_STOP");
  assert.ok(events.some((event) => event.reason_code === "AMBIGUOUS_ASSUMED_STOP"));
});

test("both levels in one bar: finer ticks resolve the first touch", () => {
  const { outcome } = evaluate(input([
    bar("2026-01-01T00:01:00.000Z", 100, 101, 99, 100),
  ], {
    ticks: [{ ts: new Date("2026-01-01T00:01:10.000Z"), bid: 100.6, ask: 100.65 }],
  }));
  assert.equal(outcome.exit_type, "TARGET");
  assert.equal(outcome.ambiguous, false);
  assert.equal(outcome.resolved_by, "tick");
  assert.equal(outcome.exit_price, 100.6);
});

test("gap through stop fills at the open, not at the stop", () => {
  const { outcome } = evaluate(input([
    bar("2026-01-01T00:01:00.000Z", 99, 99.4, 98.8, 99.1),
  ]));
  assert.equal(outcome.exit_type, "STOP");
  assert.equal(outcome.exit_reason_code, "GAP_STOP_FILLED_AT_OPEN");
  assert.equal(outcome.exit_price, 98.875);
});

test("gap through target fills at the target, not at the open", () => {
  const { outcome } = evaluate(input([
    bar("2026-01-01T00:01:00.000Z", 101, 101.4, 100.8, 101.1),
  ]));
  assert.equal(outcome.exit_type, "TARGET");
  assert.equal(outcome.exit_reason_code, "GAP_TARGET_FILLED_AT_TARGET");
  assert.equal(outcome.exit_price, 100.5);
});

test("bid/ask asymmetry: BUY pays ask, SELL receives bid, long exit uses bid", () => {
  // All quote components are exact binary fractions so expectations are exact.
  const quotedBar = bar("2026-01-01T00:00:35.000Z", 100, 100.2, 99.9, 100.1, {
    bid: 99.625, ask: 100.375, spread: 0.75,
  });
  const buy = evaluate(input([], {
    bars: [
      quotedBar,
      bar("2026-01-01T00:01:00.000Z", 100, 100.875, 100, 100.5, {
        bid: 100.25, ask: 101, spread: 0.75,
      }),
    ],
  }));
  assert.equal(buy.outcome.entry_price, 100.375);
  assert.equal(buy.outcome.exit_price, 100.5);
  assert.equal(buy.outcome.exit_type, "TARGET");

  const sell = evaluate(input([], {
    signal: signal({ direction: "SELL", stop: 100.5, target: 99.5 }),
    bars: [
      quotedBar,
      bar("2026-01-01T00:01:00.000Z", 100, 100, 99.125, 99.125, {
        bid: 99.25, ask: 100, spread: 0.75,
      }),
    ],
  }));
  assert.equal(sell.outcome.entry_price, 99.625);
  assert.equal(sell.outcome.exit_price, 99.5);
  assert.equal(sell.outcome.exit_type, "TARGET");
});

test("not_filled: no quote after the delay is stored as an outcome with no cost", () => {
  const { outcome, events } = evaluate(input([], {
    bars: [bar("2026-01-01T00:00:10.000Z", 100, 100, 100, 100)],
  }));
  assert.equal(outcome.exit_type, "NOT_FILLED");
  assert.equal(outcome.exit_reason_code, "NO_FILL_NO_QUOTE_AFTER_DELAY");
  assert.equal(outcome.net, 0);
  assert.equal(events.length, 0);
});

test("not_filled: a limit price that is never traded through is stored, not deleted", () => {
  const { outcome } = evaluate(input([
    bar("2026-01-01T00:01:00.000Z", 101, 101.2, 100.9, 101.1),
  ], {
    signal: signal({ order_type: "limit", entry_ref: 99 }),
  }));
  assert.equal(outcome.exit_type, "NOT_FILLED");
  assert.equal(outcome.exit_reason_code, "NO_FILL_PRICE_NEVER_TRIGGERED");
});

test("timeout: strategy time stop exits at the close of the first bar past the limit", () => {
  const { outcome, events } = evaluate(input([
    bar("2026-01-01T00:01:00.000Z", 100, 100.2, 99.9, 100.1),
    bar("2026-01-01T00:02:00.000Z", 100.1, 100.3, 100, 100.2),
  ], { strategyParams: { ...PARAMS, timeoutMinutes: 1 } }));
  assert.equal(outcome.exit_type, "TIMEOUT");
  assert.equal(outcome.exit_reason_code, "TIMEOUT_STRATEGY");
  assert.equal(outcome.exit_time.toISOString(), "2026-01-01T00:02:00.000Z");
  assert.equal(outcome.exit_price, 100.075);
  assert.ok(events.some((event) => event.type === "TIMEOUT"));
});

test("costs are charged once: the spread is inside bid/ask and not subtracted again", () => {
  const cost = { version: "v2", spread_usd: 999, slippage_usd: 0.05, commission_usd: 0.02 };
  const quoted = (ts, mid) => bar(ts, mid, mid + 0.4, mid - 0.4, mid, {
    bid: mid - 0.125, ask: mid + 0.125, spread: 0.25,
  });
  const { outcome } = evaluate({
    ...input([
      bar("2026-01-01T00:01:00.000Z", 100, 101, 99.8, 100.5, {
        bid: 100.375, ask: 100.625, spread: 0.25,
      }),
    ]),
    signal: signal(),
    bars: [
      quoted("2026-01-01T00:00:35.000Z", 100),
      quoted("2026-01-01T00:01:00.000Z", 100.5),
    ],
    costModel: cost,
  });
  assert.equal(outcome.entry_price, 100.125);
  assert.equal(outcome.gross, 0.375);
  assert.equal(outcome.slippage_cost, 0.05);
  assert.equal(outcome.commission_cost, 0.02);
  assert.equal(outcome.net, 0.305);
});

test("golden dataset reproduces the expected outcome exactly", () => {
  const { outcome, events } = evaluate(input([
    bar("2026-01-01T00:00:50.000Z", 100.125, 100.25, 100, 100.125),
    bar("2026-01-01T00:01:00.000Z", 100.125, 100.375, 100.125, 100.25),
    bar("2026-01-01T00:01:10.000Z", 100.25, 100.75, 100.25, 100.5),
  ]));
  const detail = {
    evaluator_version: outcome.evaluator_version,
    exit_type: outcome.exit_type,
    exit_reason_code: outcome.exit_reason_code,
    entry_time: outcome.entry_time.toISOString(),
    entry_price: outcome.entry_price,
    exit_time: outcome.exit_time.toISOString(),
    exit_price: outcome.exit_price,
    gross: outcome.gross,
    slippage_cost: outcome.slippage_cost,
    net: outcome.net,
    r_planned: outcome.r_planned,
    r_realized: outcome.r_realized,
    mfe: outcome.mfe,
    mae: outcome.mae,
    duration_s: outcome.duration_s,
    data_range_ref: outcome.data_range_ref,
    events: events.map((event) => [event.type, event.price, event.reason_code]),
  };
  assert.deepEqual(detail, {
    evaluator_version: "v1.0.0",
    exit_type: "TARGET",
    exit_reason_code: "TARGET_TOUCH",
    entry_time: "2026-01-01T00:00:35.000Z",
    entry_price: 100.125,
    exit_time: "2026-01-01T00:01:10.000Z",
    exit_price: 100.5,
    gross: 0.375,
    slippage_cost: 0.05,
    net: 0.325,
    r_planned: 0.5,
    r_realized: 0.65,
    mfe: 0.5,
    mae: -0.25,
    duration_s: 35,
    data_range_ref: {
      source: "gold-api",
      symbol: "XAU/USD",
      tf: "tick",
      from: new Date("2026-01-01T00:00:35.000Z"),
      to: new Date("2026-01-01T00:01:10.000Z"),
    },
    events: [
      ["ENTRY", 100.125, "ENTRY_FIRST_EXECUTABLE"],
      ["TOUCH_TARGET", 100.5, "TARGET_TOUCH"],
      ["EXIT", 100.5, "TARGET_TOUCH"],
    ],
  });
});

test("golden dataset evaluation is byte-identical across repeated runs", () => {
  const build = () => input([
    bar("2026-01-01T00:00:50.000Z", 100.125, 100.25, 100, 100.125),
    bar("2026-01-01T00:01:00.000Z", 100.125, 100.375, 100.125, 100.25),
    bar("2026-01-01T00:01:10.000Z", 100.25, 100.75, 100.25, 100.5),
  ]);
  const serialize = (result) => canonicalJson({ outcome: result.outcome, events: result.events });
  const sharedInput = build();
  const inputSnapshot = canonicalJson(sharedInput);

  const first = serialize(evaluate(sharedInput));
  const second = serialize(evaluate(build()));
  const third = serialize(evaluate(sharedInput));

  assert.equal(first, second);
  assert.equal(first, third);
  assert.equal(canonicalJson(sharedInput), inputSnapshot);
});
