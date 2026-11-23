export const STRATEGY_VERSION = "sma-5-12-v1";
export const TRADE_MANAGEMENT_VERSION = "r-3tp-v1";
export const STOP_PERCENT = 0.5;
export const REQUIRED_SAMPLES = 12;
export const TARGET_R_MULTIPLIERS = [1, 2, 3];
export const VIRTUAL_ACCOUNT_START_USD = 1000;
export const VIRTUAL_ACCOUNT_LOT_STEP_USD = 100;
export const VIRTUAL_ACCOUNT_LOT_STEP_SIZE = 0.01;
export const VIRTUAL_ACCOUNT_OUNCES_PER_LOT = 100;

export function calculateSignal(prices) {
  if (prices.length < REQUIRED_SAMPLES) return null;

  const recent = prices.slice(-REQUIRED_SAMPLES);
  const shortAverage = recent.slice(-5).reduce((sum, price) => sum + price, 0) / 5;
  const longAverage = recent.reduce((sum, price) => sum + price, 0) / recent.length;
  const changePercent = ((recent.at(-1) - recent[0]) / recent[0]) * 100;

  let direction = "wait";
  if (shortAverage > longAverage && changePercent > 0) direction = "buy";
  if (shortAverage < longAverage && changePercent < 0) direction = "sell";

  return { direction, shortAverage, longAverage, changePercent };
}

// A blocked state (open trade or news guard) must not consume a signal change:
// keep the last actionable direction until the block is lifted. A return to
// "wait" is always recorded so the next move counts as a fresh transition.
export function resolveSignalTransition(signalDirection, previousDirection, canOpen) {
  const shouldOpen = signalDirection !== "wait"
    && previousDirection !== signalDirection
    && canOpen;
  const nextDirection = canOpen || signalDirection === "wait"
    ? signalDirection
    : previousDirection;
  return { shouldOpen, nextDirection };
}

export function getCloseOutcome(recommendation, currentPrice) {
  if (recommendation.direction === "buy") {
    if (currentPrice >= recommendation.take_profit) return "success";
    if (currentPrice <= recommendation.stop_loss) return "failed";
  } else {
    if (currentPrice <= recommendation.take_profit) return "success";
    if (currentPrice >= recommendation.stop_loss) return "failed";
  }
  return null;
}

export function calculateResultPercent(recommendation, exitPrice) {
  const movement = recommendation.direction === "buy"
    ? exitPrice - recommendation.entry_price
    : recommendation.entry_price - exitPrice;
  return (movement / recommendation.entry_price) * 100;
}

export function calculateManagedLevels(direction, entryPrice, initialStopLoss) {
  const risk = Math.abs(entryPrice - initialStopLoss);
  if (!Number.isFinite(risk) || risk <= 0) {
    throw new Error("Initial stop loss must define a positive risk distance.");
  }

  const directionSign = direction === "buy" ? 1 : -1;
  return {
    takeProfits: TARGET_R_MULTIPLIERS.map(
      (multiple) => entryPrice + directionSign * risk * multiple,
    ),
  };
}

export function calculatePartialResultPercent(direction, entryPrice, exitPrice, fraction) {
  const movement = direction === "buy"
    ? exitPrice - entryPrice
    : entryPrice - exitPrice;
  return (movement / entryPrice) * 100 * fraction;
}

export function calculateVirtualPosition(entryPrice, initialStopLoss, accountEquityUsd) {
  if (!Number.isFinite(accountEquityUsd) || accountEquityUsd <= 0) {
    throw new Error("Account equity must be a positive finite number.");
  }
  const riskUsdPerOunce = Math.abs(entryPrice - initialStopLoss);
  if (!Number.isFinite(riskUsdPerOunce) || riskUsdPerOunce <= 0) {
    throw new Error("Initial stop must define a positive dollar risk.");
  }

  const completeHundreds = Math.floor(accountEquityUsd / VIRTUAL_ACCOUNT_LOT_STEP_USD);
  const lotSize = Math.max(
    VIRTUAL_ACCOUNT_LOT_STEP_SIZE,
    completeHundreds * VIRTUAL_ACCOUNT_LOT_STEP_SIZE,
  );
  const quantityOunces = lotSize * VIRTUAL_ACCOUNT_OUNCES_PER_LOT;
  const riskBudgetUsd = riskUsdPerOunce * quantityOunces;
  return {
    accountEquityUsd,
    lotSize,
    ouncesPerLot: VIRTUAL_ACCOUNT_OUNCES_PER_LOT,
    riskBudgetUsd,
    riskUsdPerOunce,
    quantityOunces,
  };
}

export function calculateVirtualPnl(direction, entryPrice, exitPrice, quantityOunces) {
  if (!Number.isFinite(quantityOunces) || quantityOunces <= 0) {
    throw new Error("Virtual quantity must be a positive finite number.");
  }
  const pointMove = direction === "buy"
    ? exitPrice - entryPrice
    : entryPrice - exitPrice;
  return {
    pointMove,
    grossUsd: pointMove * quantityOunces,
  };
}

export function hasReachedTarget(direction, targetPrice, currentPrice) {
  return direction === "buy"
    ? currentPrice >= targetPrice
    : currentPrice <= targetPrice;
}

export function hasReachedStop(direction, stopPrice, currentPrice) {
  return direction === "buy"
    ? currentPrice <= stopPrice
    : currentPrice >= stopPrice;
}
