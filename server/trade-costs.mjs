export const COST_ESTIMATE_MODEL = Object.freeze({
  id: "generic-xauusd-estimate-v1",
  label: "تقدير عام غير مرتبط بوسيط",
});

export function getCostEstimateConfig(environment = process.env) {
  return {
    model: COST_ESTIMATE_MODEL,
    spreadUsdPerOunce: readNonNegativeNumber(
      environment.GOLD_ESTIMATED_SPREAD_USD_PER_OUNCE,
      0.3,
      "GOLD_ESTIMATED_SPREAD_USD_PER_OUNCE",
    ),
    slippageUsdPerOuncePerSide: readNonNegativeNumber(
      environment.GOLD_ESTIMATED_SLIPPAGE_USD_PER_OUNCE_PER_SIDE,
      0.1,
      "GOLD_ESTIMATED_SLIPPAGE_USD_PER_OUNCE_PER_SIDE",
    ),
    commissionUsdPerOuncePerSide: readNonNegativeNumber(
      environment.GOLD_ESTIMATED_COMMISSION_USD_PER_OUNCE_PER_SIDE,
      0.035,
      "GOLD_ESTIMATED_COMMISSION_USD_PER_OUNCE_PER_SIDE",
    ),
  };
}

export function calculateEstimatedTradeCosts(entryPrice, grossResultPercent, config) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error("Entry price must be a positive finite number.");
  }
  if (!Number.isFinite(grossResultPercent)) {
    throw new Error("Gross result must be a finite number.");
  }

  const slippageUsdPerOunce = config.slippageUsdPerOuncePerSide * 2;
  const commissionUsdPerOunce = config.commissionUsdPerOuncePerSide * 2;
  const totalUsdPerOunce =
    config.spreadUsdPerOunce + slippageUsdPerOunce + commissionUsdPerOunce;
  const grossUsdPerOunce = (entryPrice * grossResultPercent) / 100;
  const netUsdPerOunce = grossUsdPerOunce - totalUsdPerOunce;
  const netResultPercent = (netUsdPerOunce / entryPrice) * 100;

  return {
    spreadUsdPerOunce: config.spreadUsdPerOunce,
    slippageUsdPerOunce,
    commissionUsdPerOunce,
    totalUsdPerOunce,
    grossUsdPerOunce,
    netUsdPerOunce,
    netResultPercent,
  };
}

function readNonNegativeNumber(value, fallback, name) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a finite number greater than or equal to zero.`);
  }
  return parsed;
}
