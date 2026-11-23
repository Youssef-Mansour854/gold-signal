export const COMPARISON_STARTING_EQUITY_USD = 100;
export const COMPARISON_TRADE_LIMIT_MS = 120 * 60 * 1000;
export const COMPARISON_STOP_PERCENT = 0.5;
export const COMPARISON_COST_USD_PER_OUNCE = 0.57;
export const COMPARISON_OUNCES_PER_LOT = 100;
export const COMPARISON_STALE_QUOTE_MS = 15 * 60 * 1000;

// A quote carries no new market information when it repeats the last price,
// and it is too old to open a position after a long collection gap.
export function isStaleComparisonQuote(quote, previousQuote) {
  if (!quote || !previousQuote) return false;
  if (quote.price === previousQuote.price) return true;
  return Date.parse(quote.observedAt) - Date.parse(previousQuote.observedAt)
    > COMPARISON_STALE_QUOTE_MS;
}

export const COMPARISON_STRATEGIES = [
  { id: "baseline-sma-5-12", name: "الأساسية · SMA 5/12" },
  { id: "sma-10-20", name: "SMA 10/20" },
  { id: "donchian-20", name: "Donchian 20" },
  { id: "rsi-14", name: "RSI 14" },
  { id: "macd-12-26-9", name: "MACD 12/26/9" },
];

export const COMPARISON_SIZING_MODES = [
  { id: "risk-1", name: "مخاطرة 1%", sizing: "risk", riskPercent: 1 },
  { id: "risk-2", name: "مخاطرة 2%", sizing: "risk", riskPercent: 2 },
  { id: "fixed-001-per-100", name: "0.01 لوت لكل 100$", sizing: "fixed", usdPerLot: 100 },
];

export function getStrategySignal(strategyId, prices) {
  if (!Array.isArray(prices) || prices.length === 0) return "wait";

  if (strategyId === "baseline-sma-5-12" || strategyId === "sma-5-12") {
    if (prices.length < 12) return "wait";
    const recent = prices.slice(-12);
    const shortAverage = recent.slice(-5).reduce((sum, value) => sum + value, 0) / 5;
    const longAverage = recent.reduce((sum, value) => sum + value, 0) / 12;
    const changePercent = ((recent.at(-1) - recent[0]) / recent[0]) * 100;
    if (shortAverage > longAverage && changePercent > 0) return "buy";
    if (shortAverage < longAverage && changePercent < 0) return "sell";
    return "wait";
  }

  if (strategyId === "sma-10-20") {
    if (prices.length < 20) return "wait";
    const recent = prices.slice(-20);
    const shortAverage = recent.slice(-10).reduce((sum, value) => sum + value, 0) / 10;
    const longAverage = recent.reduce((sum, value) => sum + value, 0) / 20;
    const changePercent = ((recent.at(-1) - recent.at(-10)) / recent.at(-10)) * 100;
    if (shortAverage > longAverage && changePercent > 0) return "buy";
    if (shortAverage < longAverage && changePercent < 0) return "sell";
    return "wait";
  }

  if (strategyId === "donchian-20") {
    if (prices.length < 21) return "wait";
    const recent = prices.slice(-21);
    const previous = recent.slice(0, -1);
    const current = recent.at(-1);
    if (current > Math.max(...previous)) return "buy";
    if (current < Math.min(...previous)) return "sell";
    return "wait";
  }

  if (strategyId === "rsi-14") {
    if (prices.length < 15) return "wait";
    const rsi = calculateRsi(prices, 14);
    if (rsi >= 55) return "buy";
    if (rsi <= 45) return "sell";
  }

  if (strategyId === "macd-12-26-9") {
    if (prices.length < 35) return "wait";
    const fastSeries = calculateEmaSeries(prices, 12);
    const slowSeries = calculateEmaSeries(prices, 26);
    const macdSeries = [];
    for (let index = 0; index < prices.length; index += 1) {
      if (fastSeries[index] === null || slowSeries[index] === null) continue;
      macdSeries.push(fastSeries[index] - slowSeries[index]);
    }
    if (macdSeries.length < 9) return "wait";
    // Canonical MACD: the signal line is an EMA9 of the MACD line itself.
    const signal = calculateEmaSeries(macdSeries, 9).at(-1);
    const macd = macdSeries.at(-1);
    if (macd > signal) return "buy";
    if (macd < signal) return "sell";
  }

  return "wait";
}

// EMA seeded with the SMA of the first `period` values, as used by standard MACD.
// Returns one value per input, with nulls until the seed window is complete.
export function calculateEmaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return [];
  const series = new Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);
  let ema = calculateSimpleAverage(values.slice(0, period));
  series[period - 1] = ema;
  for (let index = period; index < values.length; index += 1) {
    ema = (values[index] - ema) * multiplier + ema;
    series[index] = ema;
  }
  return series;
}

export function calculateEma(prices, period) {
  const series = calculateEmaSeries(prices, period);
  return series.length ? series.at(-1) : 0;
}

export function calculateSimpleAverage(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Wilder's RSI: SMA seed for the first 14 changes, then Wilder smoothing.
export function calculateRsi(prices, period = 14) {
  if (!Array.isArray(prices) || prices.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = prices[index] - prices[index - 1];
    if (change > 0) gains += change;
    if (change < 0) losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < prices.length; index += 1) {
    const change = prices[index] - prices[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  if (averageGain === 0) return 0;
  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

export function calculateComparisonPosition(sizingMode, equityUsd, entryPrice, stopLoss) {
  if (sizingMode.sizing === "risk") {
    const riskUsdPerOunce = Math.abs(entryPrice - stopLoss);
    const quantityOunces = equityUsd * (sizingMode.riskPercent / 100) / riskUsdPerOunce;
    return {
      quantityOunces,
      lotSize: quantityOunces / COMPARISON_OUNCES_PER_LOT,
      riskBudgetUsd: equityUsd * (sizingMode.riskPercent / 100),
    };
  }

  const completeHundreds = Math.floor(equityUsd / sizingMode.usdPerLot);
  const lotSize = Math.max(0.01, completeHundreds * 0.01);
  const quantityOunces = lotSize * COMPARISON_OUNCES_PER_LOT;
  return {
    quantityOunces,
    lotSize,
    riskBudgetUsd: Math.abs(entryPrice - stopLoss) * quantityOunces,
  };
}

export function advanceComparisonTrade(trade, price, observedAt, options = {}) {
  if (trade.status !== "open") return trade;
  const elapsed = Date.parse(observedAt) - Date.parse(trade.openedAt);
  let remaining = trade.remainingFraction;
  let realizedGross = trade.realizedGrossPercent;
  let nextTarget = trade.nextTarget;
  let stopLoss = trade.stopLoss;
  const events = [];

  while (nextTarget <= 3) {
    const target = trade[`takeProfit${nextTarget}`];
    const reached = trade.direction === "buy" ? price >= target : price <= target;
    if (!reached) break;
    const fraction = nextTarget === 3 ? remaining : Math.min(1 / 3, remaining);
    const movement = trade.direction === "buy"
      ? price - trade.entryPrice
      : trade.entryPrice - price;
    const grossContribution = movement / trade.entryPrice * 100 * fraction;
    realizedGross += grossContribution;
    remaining = Math.max(0, remaining - fraction);
    if (nextTarget === 1) stopLoss = trade.entryPrice;
    if (nextTarget === 2) stopLoss = trade.takeProfit1;
    events.push({
      type: "target_hit",
      targetNumber: nextTarget,
      price,
      fraction,
      pointMove: trade.direction === "buy" ? price - trade.entryPrice : trade.entryPrice - price,
    });
    nextTarget += 1;
    if (nextTarget === 4) {
      return closeComparisonTrade(trade, price, observedAt, "take_profit_3", remaining, realizedGross, stopLoss, events);
    }
  }

  const stopped = trade.direction === "buy"
    ? price <= stopLoss
    : price >= stopLoss;
  if (stopped) {
    const movement = trade.direction === "buy"
      ? price - trade.entryPrice
      : trade.entryPrice - price;
    const grossContribution = movement / trade.entryPrice * 100 * remaining;
    realizedGross += grossContribution;
    remaining = 0;
    return closeComparisonTrade(trade, price, observedAt, "stop_loss", remaining, realizedGross, stopLoss, events);
  }

  // Defer the expiry on stale quotes so a flat, hours-old price cannot close a
  // trade with zero movement and leave only the estimated cost as a loss.
  if (elapsed >= COMPARISON_TRADE_LIMIT_MS && !options.deferExpiry) {
    const movement = trade.direction === "buy"
      ? price - trade.entryPrice
      : trade.entryPrice - price;
    const grossContribution = movement / trade.entryPrice * 100 * remaining;
    realizedGross += grossContribution;
    remaining = 0;
    return closeComparisonTrade(trade, price, observedAt, "time_limit", remaining, realizedGross, stopLoss, events);
  }

  return {
    ...trade,
    stopLoss,
    nextTarget,
    remainingFraction: remaining,
    realizedGrossPercent: realizedGross,
  };
}

// A fixed-size account cannot lose more than its remaining equity. Keep the
// stored gross percent consistent with the clamped gross USD/cost values.
export function clampComparisonTradeToEquity(trade, equityUsd, sizingMode) {
  if (sizingMode.sizing !== "fixed" || trade.netUsd >= 0 || equityUsd + trade.netUsd >= 0) {
    return trade;
  }
  const netUsd = -equityUsd;
  const grossUsd = netUsd + trade.estimatedCostUsd;
  const grossBaseUsd = trade.quantityOunces * trade.entryPrice;
  return {
    ...trade,
    status: "failed",
    netUsd,
    grossUsd,
    realizedGrossPercent: grossBaseUsd > 0
      ? (grossUsd / grossBaseUsd) * 100
      : trade.realizedGrossPercent,
  };
}

export function closeComparisonTrade(trade, price, observedAt, closeReason, remaining, grossPercent, stopLoss, events) {
  const grossUsd = trade.quantityOunces * ((grossPercent / 100) * trade.entryPrice);
  const estimatedCostUsd = trade.quantityOunces * COMPARISON_COST_USD_PER_OUNCE;
  const netUsd = grossUsd - estimatedCostUsd;
  return {
    ...trade,
    status: netUsd >= 0 ? "success" : "failed",
    stopLoss,
    remainingFraction: remaining,
    nextTarget: 4,
    realizedGrossPercent: grossPercent,
    exitPrice: price,
    closedAt: observedAt,
    closeReason,
    grossUsd,
    estimatedCostUsd,
    netUsd,
    events,
  };
}
