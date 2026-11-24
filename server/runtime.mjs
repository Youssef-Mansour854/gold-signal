/**
 * Runtime engine for the gold-signal bot.
 *
 * This is the single source of truth for live bot state. It replaces the old
 * file-based SQLite database with one atomic MongoDB document so the exact same
 * code can run in a long-lived local process and in stateless Vercel functions.
 *
 * The pure strategy modules are reused unchanged; only persistence differs.
 */
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import {
  calculateManagedLevels,
  calculatePartialResultPercent,
  calculateResultPercent,
  calculateSignal,
  calculateVirtualPnl,
  calculateVirtualPosition,
  getCloseOutcome,
  resolveSignalTransition,
  REQUIRED_SAMPLES,
  STOP_PERCENT,
  STRATEGY_VERSION,
  TARGET_R_MULTIPLIERS,
  TRADE_MANAGEMENT_VERSION,
  VIRTUAL_ACCOUNT_START_USD,
  VIRTUAL_ACCOUNT_LOT_STEP_USD,
  VIRTUAL_ACCOUNT_LOT_STEP_SIZE,
  VIRTUAL_ACCOUNT_OUNCES_PER_LOT,
} from "./strategy.mjs";
import { advanceManagedTrade, expireManagedTrade } from "./trade-management.mjs";
import { calculateEstimatedTradeCosts, getCostEstimateConfig } from "./trade-costs.mjs";
import {
  getNewYorkDate,
  isHighImpactReleaseDay,
  normalizeFredRelease,
} from "./economic-calendar.mjs";
import {
  COMPARISON_STARTING_EQUITY_USD,
  COMPARISON_STRATEGIES,
  COMPARISON_SIZING_MODES,
  COMPARISON_STOP_PERCENT,
  advanceComparisonTrade,
  calculateComparisonPosition,
  clampComparisonTradeToEquity,
  getStrategySignal,
  isStaleComparisonQuote,
} from "./strategy-comparison.mjs";

const STATE_KEY = "runtime";
const STATE_COLLECTION = "runtime_state";
const LEGACY_COLLECTIONS = {
  pricePoints: "price_points",
  recommendations: "recommendations",
  calendarEvents: "economic_calendar_events",
  observations: "trade_price_observations",
  gaps: "trade_data_gaps",
  comparisonAccounts: "strategy_comparison_accounts",
  comparisonTrades: "strategy_comparison_trades",
};

const PORT = Number(process.env.PORT ?? 3001);
const SAMPLE_INTERVAL_MS = 30_000;
const MAX_RETURNED_POINTS = 60;
const MAX_RETURNED_RECOMMENDATIONS = 100;
const SOURCE_URL = "https://api.gold-api.com/price/XAU";
const FRED_URL = "https://api.stlouisfed.org/fred/releases/dates";
const CALENDAR_REFRESH_MS = 6 * 60 * 60 * 1000;
const CALENDAR_RETRY_MS = 5 * 60 * 1000;
const CALENDAR_LOOKAHEAD_DAYS = 14;
const CALENDAR_RETENTION_DAYS = 3;
const MAX_CALENDAR_PAGES = 20;
const MAX_TRADE_DURATION_MS = 120 * 60 * 1000;
const MAX_PRICE_GAP_MS = 2 * 60 * 1000;
const POST_CLOSE_OBSERVATION_MS = 30 * 60 * 1000;
const COST_ESTIMATE_CONFIG = getCostEstimateConfig();
const ESTIMATED_TOTAL_COST_USD_PER_OUNCE =
  COST_ESTIMATE_CONFIG.spreadUsdPerOunce +
  (COST_ESTIMATE_CONFIG.slippageUsdPerOuncePerSide +
    COST_ESTIMATE_CONFIG.commissionUsdPerOuncePerSide) * 2;

let clientPromise;

export function getFredApiKey() {
  return process.env.FRED_API_KEY?.trim() ?? "";
}

async function getDb() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error("MONGODB_URI is required by the runtime data layer.");
  const database = process.env.MONGODB_DATABASE?.trim() || "gold_signal";
  if (!clientPromise) {
    clientPromise = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 }).connect();
  }
  const client = await clientPromise;
  return client.db(database);
}

export function emptyState() {
  return {
    key: STATE_KEY,
    schema_version: 1,
    nextIds: {},
    pricePoints: [],
    recommendations: [],
    appState: {},
    calendarEvents: [],
    observations: [],
    gaps: [],
    comparisonAccounts: [],
    comparisonTrades: [],
    calendarState: {
      status: getFredApiKey() ? "loading" : "not_configured",
      checkedAt: null,
      lastSuccessAt: null,
      error: "",
    },
    sourceError: "",
    flags: {},
  };
}

export async function loadState() {
  const db = await getDb();
  const document = await db.collection(STATE_COLLECTION).findOne({ key: STATE_KEY });
  if (!document) return emptyState();
  const base = emptyState();
  return {
    ...base,
    ...document.state,
    key: STATE_KEY,
    calendarState: { ...base.calendarState, ...(document.state?.calendarState ?? {}) },
  };
}

export async function saveState(state) {
  const db = await getDb();
  await db.collection(STATE_COLLECTION).replaceOne(
    { key: STATE_KEY },
    { key: STATE_KEY, state: { ...state, key: STATE_KEY } },
    { upsert: true },
  );
}

export async function closeRuntime() {
  if (!clientPromise) return;
  const client = await clientPromise;
  clientPromise = undefined;
  await client.close();
}

/**
 * A short-lived lock in MongoDB prevents two serverless invocations (or a
 * local timer racing the scheduler) from loading, mutating and saving the same
 * state document concurrently, which would lose one of the updates.
 */
const LOCK_ID = "runtime";
const LOCK_TTL_MS = 45_000;

async function acquireLock(db, owner) {
  const locks = db.collection("runtime_locks");
  await locks.updateOne(
    { _id: LOCK_ID },
    { $setOnInsert: { owner: "", expiresAt: new Date(0) } },
    { upsert: true },
  );
  const result = await locks.updateOne(
    { _id: LOCK_ID, $or: [{ expiresAt: { $lte: new Date() } }, { owner }] },
    { $set: { owner, expiresAt: new Date(Date.now() + LOCK_TTL_MS) } },
  );
  return result.matchedCount === 1;
}

async function releaseLock(db, owner) {
  await db.collection("runtime_locks").updateOne(
    { _id: LOCK_ID, owner },
    { $set: { owner: "", expiresAt: new Date(0) } },
  );
}

async function withLock(operation) {
  const db = await getDb();
  const owner = randomUUID();
  if (!(await acquireLock(db, owner))) return { skipped: true, reason: "another writer holds the runtime lock" };
  try {
    return await operation();
  } finally {
    await releaseLock(db, owner);
  }
}

function nextId(state, kind) {
  state.nextIds[kind] = (state.nextIds[kind] ?? 0) + 1;
  return state.nextIds[kind];
}

function maxId(documents) {
  return documents.reduce((max, document) => Math.max(max, Number(document.id) || 0), 0);
}

/** One-time, read-only import of the legacy collections created by the SQLite migration. */
async function importLegacyState(db, state) {
  if (state.flags.legacyImported) return;
  for (const [target, collection] of Object.entries(LEGACY_COLLECTIONS)) {
    const documents = await db.collection(collection).find({}).sort({ id: 1 }).toArray();
    if (documents.length === 0) continue;
    state[target] = documents.map(({ _id, ...document }) => document);
    state.nextIds[target] = maxId(state[target]);
  }
  for (const recommendation of state.recommendations) {
    recommendation.events ??= [];
  }
  const events = await db.collection("recommendation_events").find({}).sort({ id: 1 }).toArray();
  for (const event of events) {
    const { _id, ...stored } = event;
    const recommendation = state.recommendations.find((item) => item.id === stored.recommendation_id);
    if (recommendation) recommendation.events.push(stored);
  }
  state.nextIds.events = maxId(events);
  state.nextIds.recommendations = maxId(state.recommendations);
  state.flags.legacyImported = true;
}

function getDateOffset(date, offsetDays) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function getOpenRecommendation(state) {
  const open = state.recommendations.filter((item) => item.status === "open");
  return open.length ? open[open.length - 1] : null;
}

function getRecentPrices(state, limit = REQUIRED_SAMPLES) {
  return state.pricePoints.slice(-limit).map((point) => ({
    price: point.price,
    source_updated_at: point.source_updated_at,
    observed_at: point.observed_at,
  }));
}

function getVirtualAccountEquity(state) {
  const realizedNet = state.recommendations
    .filter((item) => item.status === "success" || item.status === "failed")
    .reduce((sum, item) => sum + Number(item.realized_net_usd ?? 0), 0);
  return VIRTUAL_ACCOUNT_START_USD + realizedNet;
}

function getEconomicCalendarGuard(state) {
  const today = getNewYorkDate();
  const horizon = getDateOffset(today, CALENDAR_LOOKAHEAD_DAYS);
  const upcomingEvents = state.calendarEvents
    .filter((event) => event.event_date >= today && event.event_date <= horizon && event.impact === "high")
    .sort((a, b) => a.event_date.localeCompare(b.event_date) || a.event_name.localeCompare(b.event_name))
    .map((event) => ({
      id: event.event_id,
      releaseId: event.release_id,
      name: event.event_name,
      date: event.event_date,
      impact: event.impact,
      source: event.source,
    }));
  const todayEvents = upcomingEvents.filter((event) => event.date === today);
  const lastSuccess = state.calendarState.lastSuccessAt;
  const isStale = lastSuccess !== null && Date.now() - Date.parse(lastSuccess) > 24 * 60 * 60 * 1000;
  const status = isStale ? "stale" : state.calendarState.status;
  const blocked = status !== "ready" || isHighImpactReleaseDay(todayEvents, today);

  let message = "تقويم FRED محدث؛ لا توجد إصدارات أمريكية عالية التأثير اليوم.";
  if (status === "not_configured") {
    message = "فلتر الأخبار غير مهيأ. أضف FRED_API_KEY لتفعيل التقويم؛ لن تُفتح توصيات جديدة.";
  } else if (status === "loading") {
    message = "جارٍ تحميل التقويم الاقتصادي؛ فتح التوصيات الجديدة متوقف مؤقتًا.";
  } else if (status === "error" || status === "stale") {
    message = "تعذّر التحقق من تقويم الأخبار أو أن بياناته قديمة؛ فتح التوصيات الجديدة متوقف.";
  } else if (todayEvents.length > 0) {
    message = "يوجد إصدار اقتصادي أمريكي مصنف عالي التأثير اليوم؛ التوصيات الجديدة متوقفة طوال اليوم بتوقيت نيويورك.";
  }

  return {
    provider: "FRED",
    status,
    blocked,
    today,
    timezone: "America/New_York",
    todayEvents,
    upcomingEvents: upcomingEvents.filter((event) => event.date !== today).slice(0, 10),
    checkedAt: state.calendarState.checkedAt,
    message,
    details: state.calendarState.error,
    timePrecision: "date-only",
  };
}

function getEstimatedNetResult(recommendation, grossResultPercent) {
  if (
    !recommendation.cost_estimate_model ||
    !Number.isFinite(recommendation.estimated_total_cost_usd_per_oz)
  ) return null;
  return calculateEstimatedTradeCosts(
    recommendation.entry_price,
    grossResultPercent,
    {
      spreadUsdPerOunce: recommendation.estimated_spread_usd_per_oz,
      slippageUsdPerOuncePerSide: recommendation.estimated_slippage_usd_per_oz / 2,
      commissionUsdPerOuncePerSide: recommendation.estimated_commission_usd_per_oz / 2,
    },
  ).netResultPercent;
}

function insertRecommendationEvent(state, recommendation, event) {
  const stored = state.recommendations.find((item) => item.id === recommendation.id) ?? recommendation;
  const quantityFraction = event.quantityFraction;
  let estimatedCostUsdPerOunce = null;
  let netContributionPercent = null;
  let pointMove = null;
  let grossPnlUsd = null;
  let estimatedCostUsd = null;
  let netPnlUsd = null;
  let accountEquityAfter = null;

  if (
    recommendation.cost_estimate_model &&
    Number.isFinite(recommendation.estimated_total_cost_usd_per_oz)
  ) {
    estimatedCostUsdPerOunce = recommendation.estimated_total_cost_usd_per_oz * quantityFraction;
    netContributionPercent = event.contributionPercent -
      (estimatedCostUsdPerOunce / recommendation.entry_price) * 100;

    if (
      Number.isFinite(stored.virtual_quantity_ounces) &&
      stored.virtual_quantity_ounces > 0 && quantityFraction > 0
    ) {
      const closedQuantity = stored.virtual_quantity_ounces * quantityFraction;
      const virtualPnl = calculateVirtualPnl(
        stored.direction, stored.entry_price, event.price, closedQuantity,
      );
      pointMove = virtualPnl.pointMove;
      grossPnlUsd = virtualPnl.grossUsd;
      estimatedCostUsd = stored.estimated_total_cost_usd_per_oz * closedQuantity;
      netPnlUsd = grossPnlUsd - estimatedCostUsd;
      accountEquityAfter = stored.account_equity_at_entry +
        Number(stored.realized_net_usd ?? 0) + netPnlUsd;
    }
  }

  state.recommendations
    .find((item) => item.id === recommendation.id)
    ?.events.push({
      id: nextId(state, "events"),
      recommendation_id: recommendation.id,
      event_type: event.eventType,
      target_number: event.targetNumber,
      price: event.price,
      quantity_fraction: quantityFraction,
      contribution_percent: event.contributionPercent,
      current_stop_loss: event.currentStopLoss,
      occurred_at: event.occurredAt,
      estimated_cost_usd_per_oz: estimatedCostUsdPerOunce,
      net_contribution_percent: netContributionPercent,
      point_move: pointMove,
      gross_pnl_usd: grossPnlUsd,
      estimated_cost_usd: estimatedCostUsd,
      net_pnl_usd: netPnlUsd,
      account_equity_after: accountEquityAfter,
    });

  if (netPnlUsd !== null && quantityFraction > 0) {
    const target = state.recommendations.find((item) => item.id === recommendation.id);
    if (target) {
      target.realized_gross_usd = Number(target.realized_gross_usd ?? 0) + grossPnlUsd;
      target.estimated_cost_usd = Number(target.estimated_cost_usd ?? 0) + estimatedCostUsd;
      target.realized_net_usd = Number(target.realized_net_usd ?? 0) + netPnlUsd;
      target.account_equity_after = accountEquityAfter;
    }
  }
}

function updateOpenRecommendation(state, price, observedAt) {
  const recommendation = getOpenRecommendation(state);
  if (!recommendation) return;

  if (recommendation.management_version !== TRADE_MANAGEMENT_VERSION) {
    const outcome = getCloseOutcome(recommendation, price);
    const timeExpired =
      Date.parse(observedAt) - Date.parse(recommendation.created_at) >= MAX_TRADE_DURATION_MS;
    if (!outcome && !timeExpired) return;
    const resultPercent = calculateResultPercent(recommendation, price);
    const closeReason = outcome
      ? outcome === "success" ? "take_profit" : "stop_loss"
      : "time_limit";
    Object.assign(recommendation, {
      status: outcome ?? (resultPercent > 0 ? "success" : "failed"),
      closed_at: observedAt,
      exit_price: price,
      result_percent: resultPercent,
      close_reason: closeReason,
      estimated_net_result_percent: getEstimatedNetResult(recommendation, resultPercent),
    });
    if (timeExpired && !outcome) {
      insertRecommendationEvent(state, recommendation, {
        eventType: "trade_closed",
        targetNumber: null,
        price,
        quantityFraction: 1,
        contributionPercent: resultPercent,
        currentStopLoss: recommendation.stop_loss,
        occurredAt: observedAt,
      });
    }
    return;
  }

  let tradeState = advanceManagedTrade(recommendation, price);
  if (
    tradeState.recommendation.status === "open" &&
    Date.parse(observedAt) - Date.parse(recommendation.created_at) >= MAX_TRADE_DURATION_MS
  ) {
    const expiry = expireManagedTrade(tradeState.recommendation, price);
    tradeState = {
      recommendation: expiry.recommendation,
      events: [...tradeState.events, ...expiry.events],
    };
  }
  const { recommendation: updated, events } = tradeState;
  if (events.length === 0) return;
  const estimatedNetResult = updated.status === "open"
    ? null
    : getEstimatedNetResult(recommendation, updated.result_percent);
  const status = estimatedNetResult === null
    ? updated.status
    : estimatedNetResult > 0 ? "success" : "failed";
  Object.assign(recommendation, {
    status,
    stop_loss: updated.stop_loss,
    next_target: updated.next_target,
    remaining_fraction: updated.remaining_fraction,
    realized_percent: updated.realized_percent,
    closed_at: status === "open" ? null : observedAt,
    exit_price: updated.exit_price ?? null,
    result_percent: updated.result_percent ?? null,
    close_reason: updated.close_reason ?? null,
    estimated_net_result_percent: estimatedNetResult,
  });
  for (const event of events) {
    insertRecommendationEvent(state, recommendation, {
      eventType: event.eventType,
      targetNumber: event.targetNumber,
      price: event.price,
      quantityFraction: event.quantityFraction,
      contributionPercent: event.contributionPercent,
      currentStopLoss: event.currentStopLoss,
      occurredAt: observedAt,
    });
  }
}

function saveRecommendation(state, signal, price, providerUpdatedAt, observedAt) {
  const initialStopLoss = signal.direction === "buy"
    ? price * (1 - STOP_PERCENT / 100)
    : price * (1 + STOP_PERCENT / 100);
  const { takeProfits } = calculateManagedLevels(signal.direction, price, initialStopLoss);
  const accountEquity = getVirtualAccountEquity(state);
  if (!Number.isFinite(accountEquity) || accountEquity <= 0) {
    console.warn("[virtual-account] equity exhausted; skipping new recommendation.");
    return;
  }
  const virtualPosition = calculateVirtualPosition(price, initialStopLoss, accountEquity);
  state.recommendations.push({
    id: nextId(state, "recommendations"),
    status: "open",
    direction: signal.direction,
    entry_price: price,
    take_profit: takeProfits[2],
    stop_loss: initialStopLoss,
    initial_stop_loss: initialStopLoss,
    take_profit_1: takeProfits[0],
    take_profit_2: takeProfits[1],
    take_profit_3: takeProfits[2],
    next_target: 1,
    remaining_fraction: 1,
    realized_percent: 0,
    management_version: TRADE_MANAGEMENT_VERSION,
    target_percent: STOP_PERCENT * TARGET_R_MULTIPLIERS.at(-1),
    stop_percent: STOP_PERCENT,
    short_average: signal.shortAverage,
    long_average: signal.longAverage,
    change_percent: signal.changePercent,
    strategy_version: STRATEGY_VERSION,
    provider_updated_at: providerUpdatedAt,
    created_at: observedAt,
    price_source: "Gold API",
    closed_at: null,
    exit_price: null,
    result_percent: null,
    close_reason: null,
    cost_estimate_model: COST_ESTIMATE_CONFIG.model.id,
    estimated_spread_usd_per_oz: COST_ESTIMATE_CONFIG.spreadUsdPerOunce,
    estimated_slippage_usd_per_oz: COST_ESTIMATE_CONFIG.slippageUsdPerOuncePerSide * 2,
    estimated_commission_usd_per_oz: COST_ESTIMATE_CONFIG.commissionUsdPerOuncePerSide * 2,
    estimated_total_cost_usd_per_oz: ESTIMATED_TOTAL_COST_USD_PER_OUNCE,
    estimated_net_result_percent: null,
    account_equity_at_entry: virtualPosition.accountEquityUsd,
    risk_budget_usd: virtualPosition.riskBudgetUsd,
    virtual_quantity_ounces: virtualPosition.quantityOunces,
    realized_gross_usd: 0,
    estimated_cost_usd: 0,
    realized_net_usd: 0,
    account_equity_after: null,
    account_model: `virtual-${VIRTUAL_ACCOUNT_LOT_STEP_SIZE.toFixed(2)}lot-per-${VIRTUAL_ACCOUNT_LOT_STEP_USD}-usd-v1`,
    events: [],
  });
}

function recordTradePriceObservations(state, data, observedAt) {
  const firstPostCloseObservation = new Date(
    Date.parse(observedAt) - POST_CLOSE_OBSERVATION_MS,
  ).toISOString();
  const relevant = state.recommendations.filter((recommendation) =>
    recommendation.status === "open" ||
    (recommendation.closed_at && recommendation.closed_at >= firstPostCloseObservation));
  for (const recommendation of relevant) {
    const duplicate = state.observations.some((item) =>
      item.recommendation_id === recommendation.id && item.source_updated_at === data.updatedAt);
    if (duplicate) continue;
    state.observations.push({
      id: nextId(state, "observations"),
      recommendation_id: recommendation.id,
      price: data.price,
      source: "Gold API",
      source_updated_at: data.updatedAt,
      observed_at: observedAt,
      phase: recommendation.closed_at === null || recommendation.closed_at === observedAt
        ? "open" : "post_close",
    });
  }
}

function recordQuoteGap(state, previousPrice, data, observedAt) {
  if (!previousPrice) return;
  const gapMilliseconds = Date.parse(observedAt) - Date.parse(previousPrice.observed_at);
  if (gapMilliseconds < MAX_PRICE_GAP_MS) return;

  const gapStart = previousPrice.observed_at;
  const cutoff = new Date(Date.parse(gapStart) - POST_CLOSE_OBSERVATION_MS).toISOString();
  const relevant = state.recommendations.filter((recommendation) =>
    recommendation.status === "open" ||
    (recommendation.closed_at && recommendation.closed_at >= cutoff));
  for (const recommendation of relevant) {
    state.gaps.push({
      id: nextId(state, "gaps"),
      recommendation_id: recommendation.id,
      last_observed_at: gapStart,
      resumed_at: observedAt,
      duration_seconds: gapMilliseconds / 1000,
      resume_price: data.price,
    });
  }
}

function ensureStrategyComparisonAccounts(state) {
  const valid = COMPARISON_STRATEGIES.map((strategy) => strategy.id);
  state.comparisonTrades = state.comparisonTrades.filter((trade) => valid.includes(trade.strategy_id));
  state.comparisonAccounts = state.comparisonAccounts.filter((account) => valid.includes(account.strategy_id));
  const now = new Date().toISOString();
  for (const strategy of COMPARISON_STRATEGIES) {
    for (const mode of COMPARISON_SIZING_MODES) {
      const existing = state.comparisonAccounts.find((account) =>
        account.strategy_id === strategy.id && account.sizing_mode_id === mode.id);
      if (existing) {
        Object.assign(existing, {
          strategy_name: strategy.name,
          sizing_mode_name: mode.name,
          sizing_mode: mode.sizing,
          updated_at: now,
        });
      } else {
        state.comparisonAccounts.push({
          id: nextId(state, "comparisonAccounts"),
          strategy_id: strategy.id,
          strategy_name: strategy.name,
          sizing_mode_id: mode.id,
          sizing_mode_name: mode.name,
          sizing_mode: mode.sizing,
          equity_usd: COMPARISON_STARTING_EQUITY_USD,
          starting_equity_usd: COMPARISON_STARTING_EQUITY_USD,
          realized_gross_usd: 0,
          estimated_cost_usd: 0,
          realized_net_usd: 0,
          trade_count: 0,
          win_count: 0,
          loss_count: 0,
          open_trade_count: 0,
          updated_at: now,
        });
      }
    }
  }
}

function backfillStrategyComparisons(state) {
  ensureStrategyComparisonAccounts(state);
  const key = "strategy-comparison-backfill-v6";
  if (state.appState[key]) return;
  state.comparisonTrades = [];
  const points = state.pricePoints.map((point) => ({
    price: point.price,
    observedAt: point.observed_at,
  }));

  for (const strategy of COMPARISON_STRATEGIES) {
    for (const mode of COMPARISON_SIZING_MODES) {
      const account = state.comparisonAccounts.find((item) =>
        item.strategy_id === strategy.id && item.sizing_mode_id === mode.id);
      let equity = COMPARISON_STARTING_EQUITY_USD;
      let openTrade = null;
      let tradeCount = 0;
      let winCount = 0;
      let lossCount = 0;
      const prices = [];

      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const stale = isStaleComparisonQuote(point, points[index - 1]);
        prices.push(point.price);
        if (openTrade) {
          openTrade = advanceComparisonTrade(openTrade, point.price, point.observedAt, { deferExpiry: stale });
          if (openTrade.status !== "open") {
            openTrade = clampComparisonTradeToEquity(openTrade, equity, mode);
            state.comparisonTrades.push({
              id: nextId(state, "comparisonTrades"),
              account_id: account.id,
              strategy_id: strategy.id,
              strategy_name: strategy.name,
              sizing_mode_id: mode.id,
              sizing_mode_name: mode.name,
              status: openTrade.status,
              direction: openTrade.direction,
              entry_price: openTrade.entryPrice,
              stop_loss: openTrade.stopLoss,
              take_profit_1: openTrade.takeProfit1,
              take_profit_2: openTrade.takeProfit2,
              take_profit_3: openTrade.takeProfit3,
              next_target: openTrade.nextTarget,
              remaining_fraction: openTrade.remainingFraction,
              realized_gross_percent: openTrade.realizedGrossPercent,
              quantity_ounces: openTrade.quantityOunces,
              lot_size: openTrade.lotSize,
              gross_usd: openTrade.grossUsd,
              estimated_cost_usd: openTrade.estimatedCostUsd,
              net_usd: openTrade.netUsd,
              close_reason: openTrade.closeReason,
              opened_at: openTrade.openedAt,
              closed_at: openTrade.closedAt,
              exit_price: openTrade.exitPrice,
            });
            equity += openTrade.netUsd;
            tradeCount += 1;
            if (openTrade.status === "success") winCount += 1;
            else lossCount += 1;
            openTrade = null;
          }
          continue;
        }

        if (stale) continue;
        const direction = getStrategySignal(strategy.id, prices);
        if (direction === "wait" || equity <= 0) continue;
        const stopLoss = direction === "buy"
          ? point.price * (1 - COMPARISON_STOP_PERCENT / 100)
          : point.price * (1 + COMPARISON_STOP_PERCENT / 100);
        const risk = Math.abs(point.price - stopLoss);
        const sign = direction === "buy" ? 1 : -1;
        const position = calculateComparisonPosition(mode, equity, point.price, stopLoss);
        openTrade = {
          status: "open",
          direction,
          entryPrice: point.price,
          stopLoss,
          takeProfit1: point.price + sign * risk,
          takeProfit2: point.price + sign * risk * 2,
          takeProfit3: point.price + sign * risk * 3,
          nextTarget: 1,
          remainingFraction: 1,
          realizedGrossPercent: 0,
          quantityOunces: position.quantityOunces,
          lotSize: position.lotSize,
          openedAt: point.observedAt,
        };
      }

      if (openTrade) {
        state.comparisonTrades.push({
          id: nextId(state, "comparisonTrades"),
          account_id: account.id,
          strategy_id: strategy.id,
          strategy_name: strategy.name,
          sizing_mode_id: mode.id,
          sizing_mode_name: mode.name,
          status: "open",
          direction: openTrade.direction,
          entry_price: openTrade.entryPrice,
          stop_loss: openTrade.stopLoss,
          take_profit_1: openTrade.takeProfit1,
          take_profit_2: openTrade.takeProfit2,
          take_profit_3: openTrade.takeProfit3,
          next_target: 1,
          remaining_fraction: 1,
          realized_gross_percent: 0,
          quantity_ounces: openTrade.quantityOunces,
          lot_size: openTrade.lotSize,
          gross_usd: null,
          estimated_cost_usd: null,
          net_usd: null,
          close_reason: null,
          opened_at: openTrade.openedAt,
          closed_at: null,
          exit_price: null,
        });
      }

      const trades = state.comparisonTrades.filter((trade) => trade.account_id === account.id);
      Object.assign(account, {
        equity_usd: equity,
        realized_gross_usd: trades.reduce((sum, trade) => sum + Number(trade.gross_usd ?? 0), 0),
        estimated_cost_usd: trades.reduce((sum, trade) => sum + Number(trade.estimated_cost_usd ?? 0), 0),
        realized_net_usd: equity - COMPARISON_STARTING_EQUITY_USD,
        trade_count: tradeCount,
        win_count: winCount,
        loss_count: lossCount,
        open_trade_count: openTrade ? 1 : 0,
        updated_at: new Date().toISOString(),
      });
    }
  }
  state.appState[key] = new Date().toISOString();
}

function advanceStrategyComparisons(state, point) {
  ensureStrategyComparisonAccounts(state);
  const prices = state.pricePoints.map((item) => item.price);
  const previousQuote = state.pricePoints.length >= 2
    ? state.pricePoints[state.pricePoints.length - 2]
    : null;
  const stale = isStaleComparisonQuote(point, previousQuote
    ? { price: previousQuote.price, observedAt: previousQuote.observed_at }
    : null);
  const now = new Date().toISOString();

  for (const account of state.comparisonAccounts) {
    const sizingMode = COMPARISON_SIZING_MODES.find((mode) => mode.id === account.sizing_mode_id);
    if (!sizingMode) continue;
    let equityUsd = account.equity_usd;
    const accountTrades = state.comparisonTrades.filter((trade) => trade.account_id === account.id);
    let openTrade = accountTrades.filter((trade) => trade.status === "open").at(-1) ?? null;

    if (openTrade) {
      const current = {
        status: openTrade.status,
        direction: openTrade.direction,
        entryPrice: openTrade.entry_price,
        stopLoss: openTrade.stop_loss,
        takeProfit1: openTrade.take_profit_1,
        takeProfit2: openTrade.take_profit_2,
        takeProfit3: openTrade.take_profit_3,
        nextTarget: openTrade.next_target,
        remainingFraction: openTrade.remaining_fraction,
        realizedGrossPercent: openTrade.realized_gross_percent,
        quantityOunces: openTrade.quantity_ounces,
        lotSize: openTrade.lot_size,
        openedAt: openTrade.opened_at,
      };
      const advanced = advanceComparisonTrade(current, point.price, point.observedAt, { deferExpiry: stale });
      if (advanced.status === "open") {
        Object.assign(openTrade, {
          stop_loss: advanced.stopLoss,
          next_target: advanced.nextTarget,
          remaining_fraction: advanced.remainingFraction,
          realized_gross_percent: advanced.realizedGrossPercent,
        });
      } else {
        const closed = clampComparisonTradeToEquity(advanced, equityUsd, sizingMode);
        Object.assign(openTrade, {
          status: closed.status,
          stop_loss: closed.stopLoss,
          next_target: closed.nextTarget,
          remaining_fraction: closed.remainingFraction,
          realized_gross_percent: closed.realizedGrossPercent,
          gross_usd: closed.grossUsd,
          estimated_cost_usd: closed.estimatedCostUsd,
          net_usd: closed.netUsd,
          close_reason: closed.closeReason,
          closed_at: closed.closedAt,
          exit_price: closed.exitPrice,
        });
        equityUsd += closed.netUsd;
        openTrade = null;
      }
    }

    if (!openTrade && equityUsd > 0 && !stale) {
      const direction = getStrategySignal(account.strategy_id, prices);
      if (direction !== "wait") {
        const stopLoss = direction === "buy"
          ? point.price * (1 - COMPARISON_STOP_PERCENT / 100)
          : point.price * (1 + COMPARISON_STOP_PERCENT / 100);
        const position = calculateComparisonPosition(sizingMode, equityUsd, point.price, stopLoss);
        const sign = direction === "buy" ? 1 : -1;
        state.comparisonTrades.push({
          id: nextId(state, "comparisonTrades"),
          account_id: account.id,
          strategy_id: account.strategy_id,
          strategy_name: account.strategy_name,
          sizing_mode_id: account.sizing_mode_id,
          sizing_mode_name: account.sizing_mode_name,
          status: "open",
          direction,
          entry_price: point.price,
          stop_loss: stopLoss,
          take_profit_1: point.price + sign * Math.abs(point.price - stopLoss),
          take_profit_2: point.price + sign * Math.abs(point.price - stopLoss) * 2,
          take_profit_3: point.price + sign * Math.abs(point.price - stopLoss) * 3,
          next_target: 1,
          remaining_fraction: 1,
          realized_gross_percent: 0,
          quantity_ounces: position.quantityOunces,
          lot_size: position.lotSize,
          gross_usd: null,
          estimated_cost_usd: null,
          net_usd: null,
          close_reason: null,
          opened_at: point.observedAt,
          closed_at: null,
          exit_price: null,
        });
      }
    }

    const updatedTrades = state.comparisonTrades.filter((trade) => trade.account_id === account.id);
    const openCount = updatedTrades.filter((trade) => trade.status === "open").length;
    Object.assign(account, {
      equity_usd: equityUsd,
      realized_gross_usd: updatedTrades.reduce((sum, trade) => sum + Number(trade.gross_usd ?? 0), 0),
      estimated_cost_usd: updatedTrades.reduce((sum, trade) => sum + Number(trade.estimated_cost_usd ?? 0), 0),
      realized_net_usd: equityUsd - COMPARISON_STARTING_EQUITY_USD,
      trade_count: updatedTrades.length,
      win_count: updatedTrades.filter((trade) => trade.status === "success").length,
      loss_count: updatedTrades.filter((trade) => trade.status === "failed").length,
      open_trade_count: openCount,
      updated_at: now,
    });
  }
}

function recordPrice(state, data) {
  const observedAt = new Date().toISOString();
  const duplicate = state.pricePoints.some((point) => point.source_updated_at === data.updatedAt);
  if (duplicate) return false;
  const previousPrice = state.pricePoints.at(-1) ?? null;
  state.pricePoints.push({
    id: nextId(state, "pricePoints"),
    price: data.price,
    currency: data.currency,
    symbol: data.symbol,
    source_updated_at: data.updatedAt,
    observed_at: observedAt,
  });
  recordQuoteGap(state, previousPrice, data, observedAt);
  updateOpenRecommendation(state, data.price, observedAt);

  const signal = calculateSignal(getRecentPrices(state).map((point) => point.price));
  if (signal) {
    const previous = state.appState.last_signal_direction ?? "wait";
    const canOpen = !getOpenRecommendation(state) && !getEconomicCalendarGuard(state).blocked;
    const { shouldOpen, nextDirection } = resolveSignalTransition(
      signal.direction, previous, canOpen,
    );
    state.appState.last_signal_direction = nextDirection;
    if (shouldOpen) saveRecommendation(state, signal, data.price, data.updatedAt, observedAt);
  }
  recordTradePriceObservations(state, data, observedAt);
  advanceStrategyComparisons(state, { price: data.price, observedAt });
  return true;
}

async function fetchFredCalendar() {
  const releases = [];
  const pageSize = 1000;
  let totalCount = Infinity;
  const apiKey = getFredApiKey();

  for (let page = 0; page < MAX_CALENDAR_PAGES && releases.length < totalCount; page += 1) {
    const url = new URL(FRED_URL);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("file_type", "json");
    url.searchParams.set("include_release_dates_with_no_data", "true");
    url.searchParams.set("order_by", "release_date");
    url.searchParams.set("sort_order", "asc");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(page * pageSize));

    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`FRED calendar returned HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.release_dates)) {
      throw new Error(data.error_message || "FRED returned an invalid release calendar.");
    }
    totalCount = Number(data.count);
    releases.push(...data.release_dates);
    if (data.release_dates.length < pageSize || !Number.isFinite(totalCount)) break;
  }
  if (releases.length < totalCount) {
    throw new Error("FRED release calendar exceeded the configured pagination limit.");
  }
  return releases;
}

/** Polls one gold price tick. Exported for the external scheduler and local timer. */
export async function pollPrice() {
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`مصدر السعر أعاد HTTP ${response.status}`);
  const data = await response.json();
  if (
    data.symbol !== "XAU" ||
    data.currency !== "USD" ||
    !Number.isFinite(data.price) ||
    data.price <= 0 ||
    !Number.isFinite(Date.parse(data.updatedAt))
  ) throw new Error("استقبلنا بيانات سعر غير صالحة من Gold API.");

  return withLock(async () => {
    const state = await loadState();
    const inserted = recordPrice(state, data);
    state.sourceError = "";
    await saveState(state);
    return { inserted, price: data.price, observedAt: new Date().toISOString() };
  });
}

/** Refreshes the FRED economic calendar. Exported for the local timer/scheduler. */
export async function pollEconomicCalendar() {
  if (!getFredApiKey()) return { skipped: true };
  const today = getNewYorkDate();
  const firstDate = getDateOffset(today, -CALENDAR_RETENTION_DAYS);
  const lastDate = getDateOffset(today, CALENDAR_LOOKAHEAD_DAYS);
  const releases = await fetchFredCalendar();
  const events = releases
    .map(normalizeFredRelease)
    .filter((event) => event && event.date >= firstDate && event.date <= lastDate);
  const syncedAt = new Date().toISOString();

  return withLock(async () => {
    const state = await loadState();
    state.calendarEvents = events.map((event) => ({
      event_id: event.id,
      release_id: event.releaseId,
      event_name: event.name,
      event_date: event.date,
      impact: event.impact,
      source: event.source,
      synced_at: syncedAt,
    }));
    state.calendarState = {
      status: "ready",
      checkedAt: syncedAt,
      lastSuccessAt: syncedAt,
      error: "",
    };
    await saveState(state);
    return { syncedAt, count: events.length };
  });
}

/** Called once at process start / first serverless request. */
let initializePromise;

export async function initialize() {
  return withLock(async () => {
    const db = await getDb();
    const state = await loadState();
    const before = JSON.stringify(state.appState);
    if (!state.flags.legacyImported) await importLegacyState(db, state);
    backfillStrategyComparisons(state);
    if (JSON.stringify(state.appState) !== before || !state.flags.initialized) {
      state.flags.initialized = true;
      await saveState(state);
    }
    return state;
  });
}

/** One-time initialization shared by all stateless serverless invocations. */
export function ensureInitialized() {
  if (!initializePromise) initializePromise = initialize();
  return initializePromise;
}

function mapRecommendation(recommendation, state, latest, priceAgeSeconds) {
  const observations = state.observations.filter((item) => item.recommendation_id === recommendation.id);
  const gaps = state.gaps.filter((item) => item.recommendation_id === recommendation.id);
  const openObservations = observations.filter((item) => item.phase === "open");
  const postCloseObservations = observations.filter((item) => item.phase === "post_close");
  const min = (items) => items.length ? Math.min(...items.map((item) => item.price)) : null;
  const max = (items) => items.length ? Math.max(...items.map((item) => item.price)) : null;
  const mapped = {
    id: recommendation.id,
    status: recommendation.status,
    direction: recommendation.direction,
    entryPrice: recommendation.entry_price,
    takeProfit: recommendation.take_profit,
    stopLoss: recommendation.stop_loss,
    initialStopLoss: recommendation.initial_stop_loss,
    takeProfit1: recommendation.take_profit_1,
    takeProfit2: recommendation.take_profit_2,
    takeProfit3: recommendation.take_profit_3,
    nextTarget: recommendation.next_target,
    remainingFraction: recommendation.remaining_fraction,
    realizedPercent: recommendation.realized_percent,
    managementVersion: recommendation.management_version,
    targetPercent: recommendation.target_percent,
    stopPercent: recommendation.stop_percent,
    shortAverage: recommendation.short_average,
    longAverage: recommendation.long_average,
    changePercent: recommendation.change_percent,
    strategyVersion: recommendation.strategy_version,
    providerUpdatedAt: recommendation.provider_updated_at,
    createdAt: recommendation.created_at,
    priceSource: recommendation.price_source,
    closedAt: recommendation.closed_at,
    exitPrice: recommendation.exit_price,
    resultPercent: recommendation.result_percent,
    closeReason: recommendation.close_reason,
    costEstimateModel: recommendation.cost_estimate_model,
    estimatedSpreadUsdPerOunce: recommendation.estimated_spread_usd_per_oz,
    estimatedSlippageUsdPerOunce: recommendation.estimated_slippage_usd_per_oz,
    estimatedCommissionUsdPerOunce: recommendation.estimated_commission_usd_per_oz,
    estimatedTotalCostUsdPerOunce: recommendation.estimated_total_cost_usd_per_oz,
    estimatedNetResultPercent: recommendation.estimated_net_result_percent,
    accountEquityAtEntry: recommendation.account_equity_at_entry,
    riskBudgetUsd: recommendation.risk_budget_usd,
    virtualQuantityOunces: recommendation.virtual_quantity_ounces,
    realizedGrossUsd: recommendation.realized_gross_usd,
    estimatedCostUsd: recommendation.estimated_cost_usd,
    realizedNetUsd: recommendation.realized_net_usd,
    accountEquityAfter: recommendation.account_equity_after,
    accountModel: recommendation.account_model,
    observationCount: observations.length,
    openObservationCount: openObservations.length,
    postCloseObservationCount: postCloseObservations.length,
    openObservedLow: min(openObservations),
    openObservedHigh: max(openObservations),
    postCloseObservedLow: min(postCloseObservations),
    postCloseObservedHigh: max(postCloseObservations),
    lastObservationAt: observations.length
      ? observations.reduce((last, item) => item.observed_at > last ? item.observed_at : last, "")
      : null,
    dataGapCount: gaps.length,
    events: (recommendation.events ?? [])
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((event) => ({
        id: event.id,
        eventType: event.event_type,
        targetNumber: event.target_number,
        price: event.price,
        quantityFraction: event.quantity_fraction,
        contributionPercent: event.contribution_percent,
        currentStopLoss: event.current_stop_loss,
        occurredAt: event.occurred_at,
        estimatedCostUsdPerOunce: event.estimated_cost_usd_per_oz,
        netContributionPercent: event.net_contribution_percent,
        pointMove: event.point_move,
        grossPnlUsd: event.gross_pnl_usd,
        estimatedCostUsd: event.estimated_cost_usd,
        netPnlUsd: event.net_pnl_usd,
        accountEquityAfter: event.account_equity_after,
      })),
  };
  const durationEnd = recommendation.closed_at ?? latest?.observedAt ?? recommendation.created_at;
  mapped.durationMinutes = Math.max(
    0,
    Math.floor((Date.parse(durationEnd) - Date.parse(recommendation.created_at)) / 60_000),
  );
  if (
    recommendation.status === "open" && latest &&
    priceAgeSeconds < MAX_PRICE_GAP_MS / 1000 && recommendation.cost_estimate_model
  ) {
    const grossIfClosed = recommendation.realized_percent +
      calculatePartialResultPercent(
        recommendation.direction,
        recommendation.entry_price,
        latest.price,
        recommendation.remaining_fraction,
      );
    mapped.estimatedNetIfClosedNow = getEstimatedNetResult({
      entry_price: recommendation.entry_price,
      cost_estimate_model: recommendation.cost_estimate_model,
      estimated_spread_usd_per_oz: recommendation.estimated_spread_usd_per_oz,
      estimated_slippage_usd_per_oz: recommendation.estimated_slippage_usd_per_oz,
      estimated_commission_usd_per_oz: recommendation.estimated_commission_usd_per_oz,
      estimated_total_cost_usd_per_oz: recommendation.estimated_total_cost_usd_per_oz,
    }, grossIfClosed);
  } else {
    mapped.estimatedNetIfClosedNow = null;
  }
  return mapped;
}

export async function getState() {
  const state = await loadState();
  const lastPoint = state.pricePoints.at(-1) ?? null;
  const latest = lastPoint ? {
    price: lastPoint.price,
    currency: lastPoint.currency,
    symbol: lastPoint.symbol,
    sourceUpdatedAt: lastPoint.source_updated_at,
    observedAt: lastPoint.observed_at,
  } : null;
  const priceAgeSeconds = latest
    ? Math.max(0, Math.floor((Date.now() - Date.parse(latest.observedAt)) / 1000))
    : null;
  const points = state.pricePoints.slice(-MAX_RETURNED_POINTS).map((point) => ({
    price: point.price,
    sourceUpdatedAt: point.source_updated_at,
    observedAt: point.observed_at,
  }));
  const recommendations = state.recommendations
    .slice(-MAX_RETURNED_RECOMMENDATIONS)
    .reverse()
    .map((item) => mapRecommendation(item, state, latest, priceAgeSeconds));
  const activeRecommendation = recommendations.find((item) => item.status === "open") ?? null;
  const signal = calculateSignal(getRecentPrices(state).map((point) => point.price));
  const realizedNetUsd = state.recommendations
    .filter((item) => item.status === "success" || item.status === "failed")
    .reduce((sum, item) => sum + Number(item.realized_net_usd ?? 0), 0);
  const virtualAccountEquity = VIRTUAL_ACCOUNT_START_USD + realizedNetUsd;
  const virtualAccount = {
    startingEquityUsd: VIRTUAL_ACCOUNT_START_USD,
    sizingRule: `0.01 lot لكل $100; حد أدنى 0.01 lot`,
    lotStepUsd: VIRTUAL_ACCOUNT_LOT_STEP_USD,
    lotStepSize: VIRTUAL_ACCOUNT_LOT_STEP_SIZE,
    ouncesPerLot: VIRTUAL_ACCOUNT_OUNCES_PER_LOT,
    realizedNetUsd,
    equityUsd: virtualAccountEquity,
    returnPercent: ((virtualAccountEquity - VIRTUAL_ACCOUNT_START_USD) / VIRTUAL_ACCOUNT_START_USD) * 100,
  };
  const strategyAccounts = state.comparisonAccounts
    .slice()
    .sort((a, b) => a.strategy_name.localeCompare(b.strategy_name) ||
      a.sizing_mode_name.localeCompare(b.sizing_mode_name))
    .map((account) => ({
      id: account.id,
      strategyId: account.strategy_id,
      strategyName: account.strategy_name,
      sizingModeId: account.sizing_mode_id,
      sizingModeName: account.sizing_mode_name,
      equityUsd: account.equity_usd,
      startingEquityUsd: account.starting_equity_usd,
      realizedGrossUsd: account.realized_gross_usd,
      estimatedCostUsd: account.estimated_cost_usd,
      realizedNetUsd: account.realized_net_usd,
      tradeCount: account.trade_count,
      winCount: account.win_count,
      lossCount: account.loss_count,
      openTradeCount: account.open_trade_count,
      updatedAt: account.updated_at,
    }));
  const tradesByAccount = new Map();
  for (const trade of state.comparisonTrades) {
    const mapped = {
      id: trade.id,
      accountId: trade.account_id,
      strategyId: trade.strategy_id,
      strategyName: trade.strategy_name,
      sizingModeId: trade.sizing_mode_id,
      sizingModeName: trade.sizing_mode_name,
      status: trade.status,
      direction: trade.direction,
      entryPrice: trade.entry_price,
      stopLoss: trade.stop_loss,
      takeProfit1: trade.take_profit_1,
      takeProfit2: trade.take_profit_2,
      takeProfit3: trade.take_profit_3,
      nextTarget: trade.next_target,
      remainingFraction: trade.remaining_fraction,
      realizedGrossPercent: trade.realized_gross_percent,
      quantityOunces: trade.quantity_ounces,
      lotSize: trade.lot_size,
      grossUsd: trade.gross_usd,
      estimatedCostUsd: trade.estimated_cost_usd,
      netUsd: trade.net_usd,
      closeReason: trade.close_reason,
      openedAt: trade.opened_at,
      closedAt: trade.closed_at,
      exitPrice: trade.exit_price,
    };
    const list = tradesByAccount.get(trade.account_id) ?? [];
    list.push(mapped);
    tradesByAccount.set(trade.account_id, list);
  }
  for (const account of strategyAccounts) {
    account.trades = (tradesByAccount.get(account.id) ?? []).slice(0, 20);
  }

  return {
    latest,
    points,
    signal,
    activeRecommendation,
    recommendations,
    virtualAccount,
    strategyComparison: {
      startingEquityUsd: COMPARISON_STARTING_EQUITY_USD,
      accounts: strategyAccounts,
    },
    priceFreshness: {
      status: latest === null ? "unavailable" : priceAgeSeconds >= MAX_PRICE_GAP_MS / 1000 ? "stale" : "fresh",
      ageSeconds: priceAgeSeconds,
      staleAfterSeconds: MAX_PRICE_GAP_MS / 1000,
    },
    costEstimate: {
      model: COST_ESTIMATE_CONFIG.model.id,
      label: COST_ESTIMATE_CONFIG.model.label,
      spreadUsdPerOunce: COST_ESTIMATE_CONFIG.spreadUsdPerOunce,
      slippageUsdPerOunce: COST_ESTIMATE_CONFIG.slippageUsdPerOuncePerSide * 2,
      commissionUsdPerOunce: COST_ESTIMATE_CONFIG.commissionUsdPerOuncePerSide * 2,
      totalUsdPerOunce: ESTIMATED_TOTAL_COST_USD_PER_OUNCE,
    },
    newsGuard: getEconomicCalendarGuard(state),
    sourceError: state.sourceError,
    strategy: {
      version: STRATEGY_VERSION,
      tradeManagementVersion: TRADE_MANAGEMENT_VERSION,
      requiredSamples: REQUIRED_SAMPLES,
      targetRMultipliers: TARGET_R_MULTIPLIERS,
      stopPercent: STOP_PERCENT,
    },
  };
}

export async function getObservationsCsv(recommendationId) {
  const state = await loadState();
  const recommendation = state.recommendations.find((item) => item.id === recommendationId);
  if (!recommendation) return null;
  const observations = state.observations
    .filter((item) => item.recommendation_id === recommendationId)
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.id - b.id);
  const escape = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const rows = [
    ["trade_id", "source", "phase", "price_usd_per_ounce", "source_updated_at", "observed_at", "source_lag_ms"],
    ...observations.map((item) => [
      recommendationId,
      item.source,
      item.phase,
      item.price,
      item.source_updated_at,
      item.observed_at,
      Date.parse(item.observed_at) - Date.parse(item.source_updated_at),
    ]),
  ];
  return rows.map((row) => row.map(escape).join(",")).join("\r\n");
}

export { PORT, SAMPLE_INTERVAL_MS };
