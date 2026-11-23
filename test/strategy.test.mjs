import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateManagedLevels,
  calculatePartialResultPercent,
  calculateResultPercent,
  calculateSignal,
  calculateVirtualPnl,
  calculateVirtualPosition,
  getCloseOutcome,
  resolveSignalTransition,
  hasReachedStop,
  hasReachedTarget,
} from "../server/strategy.mjs";
import { advanceManagedTrade, expireManagedTrade } from "../server/trade-management.mjs";
import {
  calculateEstimatedTradeCosts,
  getCostEstimateConfig,
} from "../server/trade-costs.mjs";
import {
  getNewYorkDate,
  isHighImpactReleaseDay,
  normalizeFredRelease,
} from "../server/economic-calendar.mjs";
import {
  advanceComparisonTrade,
  calculateComparisonPosition,
  clampComparisonTradeToEquity,
  calculateEmaSeries,
  getStrategySignal,
  calculateRsi,
  isStaleComparisonQuote,
} from "../server/strategy-comparison.mjs";

test("signal waits until it has 12 prices", () => {
  assert.equal(calculateSignal(Array(11).fill(100)), null);
});

test("signal follows matching short-average and overall-price direction", () => {
  const rising = Array.from({ length: 12 }, (_, index) => 100 + index);
  const falling = Array.from({ length: 12 }, (_, index) => 112 - index);

  assert.equal(calculateSignal(rising).direction, "buy");
  assert.equal(calculateSignal(falling).direction, "sell");
  assert.equal(calculateSignal(Array(12).fill(100)).direction, "wait");
});

test("buy recommendations close as success at target and failure at stop", () => {
  const recommendation = {
    direction: "buy",
    entry_price: 100,
    take_profit: 101,
    stop_loss: 99.5,
  };

  assert.equal(getCloseOutcome(recommendation, 101), "success");
  assert.equal(getCloseOutcome(recommendation, 99.5), "failed");
  assert.equal(getCloseOutcome(recommendation, 100), null);
  assert.ok(Math.abs(calculateResultPercent(recommendation, 101.2) - 1.2) < 1e-10);
});

test("sell recommendations close using inverse price levels", () => {
  const recommendation = {
    direction: "sell",
    entry_price: 100,
    take_profit: 99,
    stop_loss: 100.5,
  };

  assert.equal(getCloseOutcome(recommendation, 99), "success");
  assert.equal(getCloseOutcome(recommendation, 100.5), "failed");
  assert.equal(calculateResultPercent(recommendation, 99), 1);
});

test("three risk-multiple targets and dynamic stop directions are correct", () => {
  assert.deepEqual(calculateManagedLevels("buy", 100, 99.5), {
    takeProfits: [100.5, 101, 101.5],
  });
  assert.deepEqual(calculateManagedLevels("sell", 100, 100.5), {
    takeProfits: [99.5, 99, 98.5],
  });
  assert.equal(hasReachedTarget("buy", 100.5, 100.6), true);
  assert.equal(hasReachedTarget("sell", 99.5, 99.4), true);
  assert.equal(hasReachedStop("buy", 100, 99.9), true);
  assert.equal(hasReachedStop("sell", 100, 100.1), true);
});

test("partial PnL is weighted by the closed position fraction", () => {
  assert.ok(Math.abs(calculatePartialResultPercent("buy", 100, 100.5, 1 / 3) - 0.1666666667) < 1e-8);
  assert.ok(Math.abs(calculatePartialResultPercent("sell", 100, 99.5, 1 / 3) - 0.1666666667) < 1e-8);
});

test("TP1 closes one third and moves the stop to entry", () => {
  const { recommendation, events } = advanceManagedTrade(makeBuyTrade(), 100.5);

  assert.equal(recommendation.status, "open");
  assert.equal(recommendation.next_target, 2);
  assert.ok(Math.abs(recommendation.remaining_fraction - 2 / 3) < 1e-10);
  assert.equal(recommendation.stop_loss, 100);
  assert.equal(events[0].eventType, "target_hit");
  assert.equal(events[1].eventType, "stop_moved");
});

test("a moved stop closes the remainder and retains realized partial profit", () => {
  const afterFirstTarget = advanceManagedTrade(makeBuyTrade(), 100.5).recommendation;
  const { recommendation, events } = advanceManagedTrade(afterFirstTarget, 100);

  assert.equal(recommendation.status, "success");
  assert.equal(recommendation.remaining_fraction, 0);
  assert.ok(Math.abs(recommendation.result_percent - 0.1666666667) < 1e-8);
  assert.equal(events[0].eventType, "stopped_out");
});

test("TP3 closes the final portion and records a completed trade", () => {
  const { recommendation, events } = advanceManagedTrade(makeBuyTrade(), 101.5);

  assert.equal(recommendation.status, "success");
  assert.equal(recommendation.next_target, 4);
  assert.equal(recommendation.remaining_fraction, 0);
  assert.equal(recommendation.close_reason, "take_profit_3");
  assert.equal(events.filter((event) => event.eventType === "target_hit").length, 3);
});

test("initial stop closes the full position as failed and sell targets are inverse", () => {
  const stoppedBuy = advanceManagedTrade(makeBuyTrade(), 99.5).recommendation;
  const stoppedSell = advanceManagedTrade(makeSellTrade(), 100.5).recommendation;
  const firstSellTarget = advanceManagedTrade(makeSellTrade(), 99.5).recommendation;

  assert.equal(stoppedBuy.status, "failed");
  assert.equal(stoppedSell.status, "failed");
  assert.equal(firstSellTarget.stop_loss, 100);
  assert.equal(firstSellTarget.next_target, 2);
});

test("120-minute expiry closes only the remaining quantity at the supplied fresh quote", () => {
  const afterFirstTarget = advanceManagedTrade(makeBuyTrade(), 100.5).recommendation;
  const { recommendation, events } = expireManagedTrade(afterFirstTarget, 100.2);

  assert.equal(recommendation.status, "success");
  assert.equal(recommendation.close_reason, "time_limit");
  assert.equal(recommendation.remaining_fraction, 0);
  assert.ok(Math.abs(recommendation.result_percent - 0.3) < 1e-10);
  assert.equal(events[0].eventType, "trade_closed");
  assert.ok(Math.abs(events[0].quantityFraction - 2 / 3) < 1e-10);
});

test("generic per-ounce costs remain explicitly estimated and reduce net results", () => {
  const config = getCostEstimateConfig({});
  const costs = calculateEstimatedTradeCosts(2000, 1, config);

  assert.equal(config.model.id, "generic-xauusd-estimate-v1");
  assert.equal(costs.spreadUsdPerOunce, 0.3);
  assert.equal(costs.slippageUsdPerOunce, 0.2);
  assert.equal(costs.commissionUsdPerOunce, 0.07);
  assert.ok(Math.abs(costs.totalUsdPerOunce - 0.57) < 1e-10);
  assert.ok(costs.netResultPercent < 1);
});

test("a $1000 virtual account uses 0.10 lots at 100 ounces per lot", () => {
  const position = calculateVirtualPosition(2000, 1980, 1000);

  assert.equal(position.lotSize, 0.1);
  assert.equal(position.quantityOunces, 10);
  assert.equal(position.riskBudgetUsd, 200);
  const pnl = calculateVirtualPnl("buy", 2000, 2010, position.quantityOunces);

  assert.equal(pnl.pointMove, 10);
  assert.equal(pnl.grossUsd, 100);
});

test("cost estimates reject invalid configured values instead of silently falling back", () => {
  assert.throws(
    () => getCostEstimateConfig({ GOLD_ESTIMATED_SPREAD_USD_PER_OUNCE: "-1" }),
    /must be a finite number/,
  );
});

test("baseline and four independent comparison strategies produce signals", () => {
  const rising = Array.from({ length: 30 }, (_, index) => 100 + index);
  assert.equal(getStrategySignal("baseline-sma-5-12", rising), "buy");
  assert.equal(getStrategySignal("sma-5-12", rising), "buy");
  assert.equal(getStrategySignal("sma-10-20", rising), "buy");
  assert.equal(getStrategySignal("donchian-20", rising), "buy");
  assert.equal(getStrategySignal("rsi-14", rising), "buy");
});

test("comparison sizing provides 1%, 2%, and fixed 0.01 lot models", () => {
  const onePercent = calculateComparisonPosition(
    { sizing: "risk", riskPercent: 1 },
    100,
    2000,
    1980,
  );
  const twoPercent = calculateComparisonPosition(
    { sizing: "risk", riskPercent: 2 },
    100,
    2000,
    1980,
  );
  const fixed = calculateComparisonPosition(
    { sizing: "fixed", usdPerLot: 100 },
    100,
    2000,
    1980,
  );

  assert.equal(onePercent.quantityOunces, 0.05);
  assert.equal(twoPercent.quantityOunces, 0.1);
  assert.equal(fixed.lotSize, 0.01);
  assert.equal(fixed.quantityOunces, 1);
});

test("FRED calendar only accepts known high-impact U.S. release names and valid dates", () => {
  assert.deepEqual(normalizeFredRelease({
    release_id: 10,
    release_name: "Consumer Price Index",
    date: "2026-12-10",
  }), {
    id: "10:2026-12-10",
    releaseId: 10,
    name: "Consumer Price Index",
    date: "2026-12-10",
    impact: "high",
    source: "FRED",
  });
  assert.equal(normalizeFredRelease({
    release_id: 10,
    release_name: "Consumer Price Index",
    date: "2026-02-30",
  }), null);
  assert.equal(normalizeFredRelease({
    release_id: 999,
    release_name: "Weekly Petroleum Status Report",
    date: "2026-12-10",
  }), null);
  assert.equal(normalizeFredRelease({
    release_id: 101,
    release_name: "FOMC Press Release",
    date: "2026-12-10",
  }), null);
  assert.equal(normalizeFredRelease({
    release_id: 263,
    release_name: "Debt to Gross Domestic Product Ratios",
    date: "2026-12-10",
  }), null);
});

test("FRED event dates are compared in New York time and block only matching dates", () => {
  const events = [{ date: "2026-11-20", impact: "high" }];
  assert.equal(getNewYorkDate(new Date("2026-11-21T02:00:00Z")), "2026-11-20");
  assert.equal(isHighImpactReleaseDay(events, "2026-11-20"), true);
  assert.equal(isHighImpactReleaseDay(events, "2026-11-21"), false);
});

test("blocked states keep the last actionable signal instead of consuming the transition", () => {
  assert.deepEqual(
    resolveSignalTransition("sell", "buy", false),
    { shouldOpen: false, nextDirection: "buy" },
  );
  assert.deepEqual(
    resolveSignalTransition("sell", "buy", true),
    { shouldOpen: true, nextDirection: "sell" },
  );
  assert.deepEqual(
    resolveSignalTransition("wait", "buy", false),
    { shouldOpen: false, nextDirection: "wait" },
  );
  assert.deepEqual(
    resolveSignalTransition("buy", "wait", true),
    { shouldOpen: true, nextDirection: "buy" },
  );
});

test("MACD comparison uses SMA-seeded EMA lines and an EMA9 signal", () => {
  assert.deepEqual(calculateEmaSeries([1, 2, 3, 4, 5, 6], 3), [null, null, 2, 3, 4, 5]);

  const prices = Array.from(
    { length: 40 },
    (_, index) => 100 + index * 0.7 + Math.sin(index / 2) * 3,
  );
  assert.equal(getStrategySignal("macd-12-26-9", prices), "buy");
});

test("RSI 14 uses Wilder smoothing with an SMA seed", () => {
  const prices = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
    45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
  ];
  assert.ok(Math.abs(calculateRsi(prices) - 57.91502067) < 1e-6);
  assert.equal(calculateRsi(Array.from({ length: 20 }, (_, index) => 100 + index)), 100);
  assert.equal(calculateRsi(Array.from({ length: 20 }, (_, index) => 120 - index)), 0);
});

test("fixed-sizing loss clamp keeps gross percent consistent with capped loss", () => {
  const trade = {
    status: "failed",
    netUsd: -150,
    grossUsd: -143,
    estimatedCostUsd: 7,
    quantityOunces: 1,
    entryPrice: 2000,
    realizedGrossPercent: -7.15,
  };
  const clamped = clampComparisonTradeToEquity(
    trade,
    100,
    { sizing: "fixed", usdPerLot: 100 },
  );

  assert.equal(clamped.netUsd, -100);
  assert.equal(clamped.grossUsd, -93);
  assert.ok(Math.abs(clamped.realizedGrossPercent - (-93 / 2000) * 100) < 1e-10);
});

test("comparison close keeps target events recorded in the same tick", () => {
  const trade = {
    status: "open",
    direction: "buy",
    entryPrice: 100,
    stopLoss: 100,
    takeProfit1: 100.5,
    takeProfit2: 101,
    takeProfit3: 101.5,
    nextTarget: 2,
    remainingFraction: 2 / 3,
    realizedGrossPercent: 0.1666666667,
    quantityOunces: 1,
    lotSize: 0.01,
    openedAt: "2026-01-01T00:00:00.000Z",
  };
  const closed = advanceComparisonTrade(trade, 101, "2026-01-01T02:01:00.000Z");

  assert.equal(closed.closeReason, "time_limit");
  assert.equal(closed.events.length, 1);
  assert.equal(closed.events[0].targetNumber, 2);
});

test("stale comparison quotes are repeats or arrivals after a long gap", () => {
  const previous = { price: 3539, observedAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(isStaleComparisonQuote({
    price: 3539, observedAt: "2026-01-01T00:01:00.000Z",
  }, previous), true);
  assert.equal(isStaleComparisonQuote({
    price: 3540, observedAt: "2026-01-01T00:20:00.000Z",
  }, previous), true);
  assert.equal(isStaleComparisonQuote({
    price: 3540, observedAt: "2026-01-01T00:01:00.000Z",
  }, previous), false);
  assert.equal(isStaleComparisonQuote({
    price: 3540, observedAt: "2026-01-01T00:01:00.000Z",
  }, null), false);
});

test("a flat stale quote does not expire a comparison trade on cost alone", () => {
  const trade = {
    status: "open",
    direction: "buy",
    entryPrice: 3539,
    stopLoss: 3521.305,
    takeProfit1: 3556.695,
    takeProfit2: 3574.39,
    takeProfit3: 3592.085,
    nextTarget: 1,
    remainingFraction: 1,
    realizedGrossPercent: 0,
    quantityOunces: 1,
    lotSize: 0.01,
    openedAt: "2026-01-01T00:00:00.000Z",
  };
  const observedAt = "2026-01-01T03:00:00.000Z";
  assert.equal(advanceComparisonTrade(trade, 3539, observedAt).closeReason, "time_limit");
  const deferred = advanceComparisonTrade(trade, 3539, observedAt, { deferExpiry: true });
  assert.equal(deferred.status, "open");
  assert.equal(deferred.closeReason, undefined);
  assert.equal(deferred.entryPrice, trade.entryPrice);
});

function makeBuyTrade() {
  return {
    status: "open",
    direction: "buy",
    entry_price: 100,
    take_profit_1: 100.5,
    take_profit_2: 101,
    take_profit_3: 101.5,
    stop_loss: 99.5,
    next_target: 1,
    remaining_fraction: 1,
    realized_percent: 0,
  };
}

function makeSellTrade() {
  return {
    status: "open",
    direction: "sell",
    entry_price: 100,
    take_profit_1: 99.5,
    take_profit_2: 99,
    take_profit_3: 98.5,
    stop_loss: 100.5,
    next_target: 1,
    remaining_fraction: 1,
    realized_percent: 0,
  };
}
