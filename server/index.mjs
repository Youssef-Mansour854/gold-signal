import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  calculateEstimatedTradeCosts,
  getCostEstimateConfig,
} from "./trade-costs.mjs";
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

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DATA_DIR = resolve(ROOT, "data");
const DB_PATH = resolve(DATA_DIR, "gold-signal.sqlite");
const DIST_DIR = resolve(ROOT, "dist");
const ENV_FILE = resolve(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const PORT = Number(process.env.PORT ?? 3001);
const SAMPLE_INTERVAL_MS = 30_000;
const MAX_RETURNED_POINTS = 60;
const MAX_RETURNED_RECOMMENDATIONS = 100;
const SOURCE_URL = "https://api.gold-api.com/price/XAU";
const FRED_API_KEY = process.env.FRED_API_KEY?.trim() ?? "";
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

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS price_points (
    id INTEGER PRIMARY KEY,
    price REAL NOT NULL,
    currency TEXT NOT NULL,
    symbol TEXT NOT NULL,
    source_updated_at TEXT NOT NULL UNIQUE,
    observed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS price_points_by_observed_at
    ON price_points(observed_at);
  CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('open', 'success', 'failed')),
    direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
    entry_price REAL NOT NULL,
    take_profit REAL NOT NULL,
    stop_loss REAL NOT NULL,
    initial_stop_loss REAL,
    take_profit_1 REAL,
    take_profit_2 REAL,
    take_profit_3 REAL,
    next_target INTEGER NOT NULL DEFAULT 1,
    remaining_fraction REAL NOT NULL DEFAULT 1,
    realized_percent REAL NOT NULL DEFAULT 0,
    management_version TEXT NOT NULL DEFAULT 'single-target-v1',
    target_percent REAL NOT NULL,
    stop_percent REAL NOT NULL,
    short_average REAL NOT NULL,
    long_average REAL NOT NULL,
    change_percent REAL NOT NULL,
    strategy_version TEXT NOT NULL,
    provider_updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    price_source TEXT NOT NULL DEFAULT 'Gold API',
    closed_at TEXT,
    exit_price REAL,
    result_percent REAL,
    close_reason TEXT,
    cost_estimate_model TEXT,
    estimated_spread_usd_per_oz REAL,
    estimated_slippage_usd_per_oz REAL,
    estimated_commission_usd_per_oz REAL,
    estimated_total_cost_usd_per_oz REAL,
    estimated_net_result_percent REAL,
    account_equity_at_entry REAL,
    risk_budget_usd REAL,
    virtual_quantity_ounces REAL,
    realized_gross_usd REAL NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    realized_net_usd REAL NOT NULL DEFAULT 0,
    account_equity_after REAL,
    account_model TEXT
  );
  CREATE INDEX IF NOT EXISTS recommendations_status_created
    ON recommendations(status, created_at DESC);
  CREATE TABLE IF NOT EXISTS recommendation_events (
    id INTEGER PRIMARY KEY,
    recommendation_id INTEGER NOT NULL REFERENCES recommendations(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('target_hit', 'stop_moved', 'stopped_out', 'trade_closed')),
    target_number INTEGER,
    price REAL NOT NULL,
    quantity_fraction REAL NOT NULL,
    contribution_percent REAL NOT NULL,
    current_stop_loss REAL NOT NULL,
    occurred_at TEXT NOT NULL,
    estimated_cost_usd_per_oz REAL,
    net_contribution_percent REAL,
    point_move REAL,
    gross_pnl_usd REAL,
    estimated_cost_usd REAL,
    net_pnl_usd REAL,
    account_equity_after REAL
  );
  CREATE INDEX IF NOT EXISTS recommendation_events_by_trade
    ON recommendation_events(recommendation_id, id);
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS economic_calendar_events (
    event_id TEXT PRIMARY KEY,
    release_id INTEGER NOT NULL,
    event_name TEXT NOT NULL,
    event_date TEXT NOT NULL,
    impact TEXT NOT NULL,
    source TEXT NOT NULL,
    synced_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS economic_calendar_by_date
    ON economic_calendar_events(event_date, impact);
  CREATE TABLE IF NOT EXISTS trade_price_observations (
    id INTEGER PRIMARY KEY,
    recommendation_id INTEGER NOT NULL REFERENCES recommendations(id),
    price REAL NOT NULL,
    source TEXT NOT NULL,
    source_updated_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('open', 'post_close')),
    UNIQUE(recommendation_id, source_updated_at)
  );
  CREATE INDEX IF NOT EXISTS trade_price_observations_by_trade
    ON trade_price_observations(recommendation_id, observed_at);
  CREATE TABLE IF NOT EXISTS trade_data_gaps (
    id INTEGER PRIMARY KEY,
    recommendation_id INTEGER NOT NULL REFERENCES recommendations(id),
    last_observed_at TEXT NOT NULL,
    resumed_at TEXT NOT NULL,
    duration_seconds REAL NOT NULL,
    resume_price REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS trade_data_gaps_by_trade
    ON trade_data_gaps(recommendation_id, resumed_at);
  CREATE TABLE IF NOT EXISTS strategy_comparison_accounts (
    id INTEGER PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    strategy_name TEXT NOT NULL,
    sizing_mode_id TEXT NOT NULL,
    sizing_mode_name TEXT NOT NULL,
    sizing_mode TEXT NOT NULL,
    equity_usd REAL NOT NULL,
    starting_equity_usd REAL NOT NULL,
    realized_gross_usd REAL NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    realized_net_usd REAL NOT NULL DEFAULT 0,
    trade_count INTEGER NOT NULL DEFAULT 0,
    win_count INTEGER NOT NULL DEFAULT 0,
    loss_count INTEGER NOT NULL DEFAULT 0,
    open_trade_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE(strategy_id, sizing_mode_id)
  );
  CREATE TABLE IF NOT EXISTS strategy_comparison_trades (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_name TEXT NOT NULL,
    sizing_mode_id TEXT NOT NULL,
    sizing_mode_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'success', 'failed')),
    direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
    entry_price REAL NOT NULL,
    stop_loss REAL NOT NULL,
    take_profit_1 REAL NOT NULL,
    take_profit_2 REAL NOT NULL,
    take_profit_3 REAL NOT NULL,
    next_target INTEGER NOT NULL DEFAULT 1,
    remaining_fraction REAL NOT NULL DEFAULT 1,
    realized_gross_percent REAL NOT NULL DEFAULT 0,
    quantity_ounces REAL NOT NULL,
    lot_size REAL NOT NULL,
    gross_usd REAL,
    estimated_cost_usd REAL,
    net_usd REAL,
    close_reason TEXT,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    exit_price REAL
  );
  CREATE INDEX IF NOT EXISTS strategy_comparison_trades_account
    ON strategy_comparison_trades(account_id, opened_at);
`);

const recommendationColumns = new Set(
  db.prepare("PRAGMA table_info(recommendations)").all().map((column) => column.name),
);
const recommendationMigrations = {
  initial_stop_loss: "REAL",
  take_profit_1: "REAL",
  take_profit_2: "REAL",
  take_profit_3: "REAL",
  next_target: "INTEGER NOT NULL DEFAULT 1",
  remaining_fraction: "REAL NOT NULL DEFAULT 1",
  realized_percent: "REAL NOT NULL DEFAULT 0",
  management_version: "TEXT NOT NULL DEFAULT 'single-target-v1'",
  cost_estimate_model: "TEXT",
  price_source: "TEXT NOT NULL DEFAULT 'Gold API'",
  estimated_spread_usd_per_oz: "REAL",
  estimated_slippage_usd_per_oz: "REAL",
  estimated_commission_usd_per_oz: "REAL",
  estimated_total_cost_usd_per_oz: "REAL",
  estimated_net_result_percent: "REAL",
  account_equity_at_entry: "REAL",
  risk_budget_usd: "REAL",
  virtual_quantity_ounces: "REAL",
  realized_gross_usd: "REAL NOT NULL DEFAULT 0",
  estimated_cost_usd: "REAL NOT NULL DEFAULT 0",
  realized_net_usd: "REAL NOT NULL DEFAULT 0",
  account_equity_after: "REAL",
  account_model: "TEXT",
};
for (const [column, definition] of Object.entries(recommendationMigrations)) {
  if (!recommendationColumns.has(column)) {
    db.exec(`ALTER TABLE recommendations ADD COLUMN ${column} ${definition}`);
  }
  const eventColumns = new Set(
    db.prepare("PRAGMA table_info(recommendation_events)").all().map((column) => column.name),
  );
  const eventMigrations = {
    estimated_cost_usd_per_oz: "REAL",
    net_contribution_percent: "REAL",
    point_move: "REAL",
    gross_pnl_usd: "REAL",
    estimated_cost_usd: "REAL",
    net_pnl_usd: "REAL",
    account_equity_after: "REAL",
  };
  for (const [column, definition] of Object.entries(eventMigrations)) {
    if (!eventColumns.has(column)) {
      db.exec(`ALTER TABLE recommendation_events ADD COLUMN ${column} ${definition}`);
    }
  }
  const observationColumns = new Set(
    db.prepare("PRAGMA table_info(trade_price_observations)").all().map((column) => column.name),
  );
  if (!observationColumns.has("source")) {
    db.exec("ALTER TABLE trade_price_observations ADD COLUMN source TEXT NOT NULL DEFAULT 'Gold API'");
  }
  db.exec(`
    UPDATE trade_price_observations
    SET phase = 'open'
    WHERE phase = 'post_close'
      AND EXISTS (
        SELECT 1 FROM recommendations r
        WHERE r.id = trade_price_observations.recommendation_id
          AND r.closed_at = trade_price_observations.observed_at
      )
  `);
}
db.exec("UPDATE recommendations SET initial_stop_loss = stop_loss WHERE initial_stop_loss IS NULL");

const legacyOpenRecommendations = db.prepare(`
  SELECT id, direction, entry_price, initial_stop_loss
  FROM recommendations
  WHERE status = 'open' AND management_version = 'single-target-v1'
`).all();
const migrateOpenRecommendation = db.prepare(`
  UPDATE recommendations
  SET take_profit = ?, stop_loss = ?, initial_stop_loss = ?,
    take_profit_1 = ?, take_profit_2 = ?, take_profit_3 = ?,
    target_percent = ?, management_version = ?, next_target = 1,
    remaining_fraction = 1, realized_percent = 0
  WHERE id = ? AND status = 'open' AND management_version = 'single-target-v1'
`);
for (const recommendation of legacyOpenRecommendations) {
  const initialStopLoss = recommendation.initial_stop_loss;
  const { takeProfits } = calculateManagedLevels(
    recommendation.direction,
    recommendation.entry_price,
    initialStopLoss,
  );
  migrateOpenRecommendation.run(
    takeProfits[2],
    initialStopLoss,
    initialStopLoss,
    takeProfits[0],
    takeProfits[1],
    takeProfits[2],
    STOP_PERCENT * TARGET_R_MULTIPLIERS.at(-1),
    TRADE_MANAGEMENT_VERSION,
    recommendation.id,
  );
}
db.prepare(`
  UPDATE recommendations SET
    cost_estimate_model = ?,
    estimated_spread_usd_per_oz = ?,
    estimated_slippage_usd_per_oz = ?,
    estimated_commission_usd_per_oz = ?,
    estimated_total_cost_usd_per_oz = ?
  WHERE status = 'open' AND cost_estimate_model IS NULL
`).run(
  COST_ESTIMATE_CONFIG.model.id,
  COST_ESTIMATE_CONFIG.spreadUsdPerOunce,
  COST_ESTIMATE_CONFIG.slippageUsdPerOuncePerSide * 2,
  COST_ESTIMATE_CONFIG.commissionUsdPerOuncePerSide * 2,
  ESTIMATED_TOTAL_COST_USD_PER_OUNCE,
);
const observationBackfillKey = "trade_observation_backfill_v1";
const observationBackfillComplete = db.prepare(
  "SELECT value FROM app_state WHERE key = ?",
).get(observationBackfillKey);
if (!observationBackfillComplete) {
  db.exec(`
    INSERT OR IGNORE INTO trade_price_observations (
      recommendation_id, price, source, source_updated_at, observed_at, phase
    )
    SELECT r.id, p.price, 'Gold API', p.source_updated_at, p.observed_at,
      CASE WHEN r.closed_at IS NULL OR datetime(p.observed_at) <= datetime(r.closed_at)
        THEN 'open' ELSE 'post_close' END
    FROM recommendations r
    JOIN price_points p ON datetime(p.observed_at) >= datetime(r.created_at)
    WHERE r.closed_at IS NULL
      OR datetime(p.observed_at) <= datetime(r.closed_at, '+30 minutes')
  `);
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
  `).run(observationBackfillKey, new Date().toISOString());
}
const costEstimateBackfillKey = "trade_cost_estimate_backfill_v1";
const costEstimateBackfillComplete = db.prepare(
  "SELECT value FROM app_state WHERE key = ?",
).get(costEstimateBackfillKey);
if (!costEstimateBackfillComplete) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE recommendations SET
        cost_estimate_model = ?,
        estimated_spread_usd_per_oz = ?,
        estimated_slippage_usd_per_oz = ?,
        estimated_commission_usd_per_oz = ?,
        estimated_total_cost_usd_per_oz = ?,
        estimated_net_result_percent = CASE
          WHEN status <> 'open' AND result_percent IS NOT NULL
          THEN ((entry_price * result_percent / 100 - ?) / entry_price) * 100
          ELSE NULL
        END
      WHERE cost_estimate_model IS NULL
    `).run(
      COST_ESTIMATE_CONFIG.model.id,
      COST_ESTIMATE_CONFIG.spreadUsdPerOunce,
      COST_ESTIMATE_CONFIG.slippageUsdPerOuncePerSide * 2,
      COST_ESTIMATE_CONFIG.commissionUsdPerOuncePerSide * 2,
      ESTIMATED_TOTAL_COST_USD_PER_OUNCE,
      ESTIMATED_TOTAL_COST_USD_PER_OUNCE,
    );
    db.exec(`
      UPDATE recommendation_events
      SET estimated_cost_usd_per_oz = (
            SELECT r.estimated_total_cost_usd_per_oz * recommendation_events.quantity_fraction
            FROM recommendations r
            WHERE r.id = recommendation_events.recommendation_id
          ),
          net_contribution_percent = (
            SELECT recommendation_events.contribution_percent -
              (r.estimated_total_cost_usd_per_oz * recommendation_events.quantity_fraction /
                r.entry_price) * 100
            FROM recommendations r
            WHERE r.id = recommendation_events.recommendation_id
          )
      WHERE estimated_cost_usd_per_oz IS NULL
        AND EXISTS (
          SELECT 1 FROM recommendations r
          WHERE r.id = recommendation_events.recommendation_id
            AND r.cost_estimate_model IS NOT NULL
        )
    `);
    db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run(
      costEstimateBackfillKey,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const virtualAccountBackfillKey = "virtual-account-backfill-v1";
const virtualAccountBackfillComplete = db.prepare(
  "SELECT value FROM app_state WHERE key = ?",
).get(virtualAccountBackfillKey);
if (!virtualAccountBackfillComplete) {
  let accountEquity = VIRTUAL_ACCOUNT_START_USD;
  const trades = db.prepare(`
    SELECT id, status, direction, entry_price, initial_stop_loss,
      stop_loss, exit_price, result_percent, realized_percent,
      estimated_total_cost_usd_per_oz
    FROM recommendations
    ORDER BY id
  `).all();
  for (const trade of trades) {
    const initialStop =
      Number.isFinite(trade.initial_stop_loss) && trade.initial_stop_loss > 0
        ? trade.initial_stop_loss
        : trade.stop_loss;
    const virtualPosition = calculateVirtualPosition(
      trade.entry_price,
      initialStop,
      accountEquity,
    );
    let realizedGrossUsd = 0;
    let estimatedCostUsd = 0;
    let realizedNetUsd = 0;

    if (trade.status !== "open" && trade.exit_price !== null) {
      const pnl = calculateVirtualPnl(
        trade.direction,
        trade.entry_price,
        trade.exit_price,
        virtualPosition.quantityOunces,
      );
      realizedGrossUsd = pnl.grossUsd;
      estimatedCostUsd =
        Number(trade.estimated_total_cost_usd_per_oz ?? ESTIMATED_TOTAL_COST_USD_PER_OUNCE) *
        virtualPosition.quantityOunces;
      realizedNetUsd = realizedGrossUsd - estimatedCostUsd;
    }

    accountEquity += realizedNetUsd;
    db.prepare(`
      UPDATE recommendations SET
        account_equity_at_entry = ?,
        risk_budget_usd = ?,
        virtual_quantity_ounces = ?,
        account_model = ?,
        realized_gross_usd = ?,
        estimated_cost_usd = ?,
        realized_net_usd = ?,
        account_equity_after = ?
      WHERE id = ?
    `).run(
      virtualPosition.accountEquityUsd,
      virtualPosition.riskBudgetUsd,
      virtualPosition.quantityOunces,
      `virtual-${VIRTUAL_ACCOUNT_LOT_STEP_SIZE.toFixed(2)}lot-per-${VIRTUAL_ACCOUNT_LOT_STEP_USD}-usd-v1`,
      realizedGrossUsd,
      estimatedCostUsd,
      realizedNetUsd,
      trade.status === "open" ? null : accountEquity,
      trade.id,
    );

    db.prepare(`
      UPDATE recommendation_events
      SET point_move = CASE
            WHEN ? = 'buy' THEN price - ?
            ELSE ? - price
          END,
          gross_pnl_usd = (CASE
            WHEN ? = 'buy' THEN price - ?
            ELSE ? - price
          END) * ? * quantity_fraction,
          estimated_cost_usd = COALESCE((
            SELECT estimated_total_cost_usd_per_oz
            FROM recommendations
            WHERE id = recommendation_events.recommendation_id
          ), ?) * ? * quantity_fraction,
          net_pnl_usd = (
            (CASE
              WHEN ? = 'buy' THEN price - ?
              ELSE ? - price
            END) * ? * quantity_fraction
          ) - COALESCE((
            SELECT estimated_total_cost_usd_per_oz
            FROM recommendations
            WHERE id = recommendation_events.recommendation_id
          ), ?) * ? * quantity_fraction
      WHERE recommendation_id = ?
    `).run(
      trade.direction, trade.entry_price, trade.entry_price,
      trade.direction, trade.entry_price, trade.entry_price,
      virtualPosition.quantityOunces,
      ESTIMATED_TOTAL_COST_USD_PER_OUNCE,
      virtualPosition.quantityOunces,
      trade.direction, trade.entry_price, trade.entry_price,
      virtualPosition.quantityOunces,
      ESTIMATED_TOTAL_COST_USD_PER_OUNCE,
      virtualPosition.quantityOunces,
      trade.id,
    );
  }
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run(
    virtualAccountBackfillKey,
    new Date().toISOString(),
  );
}

const lotSizingBackfillKey = "virtual-lot-sizing-backfill-v2";
const lotSizingBackfillComplete = db.prepare(
  "SELECT value FROM app_state WHERE key = ?",
).get(lotSizingBackfillKey);
if (!lotSizingBackfillComplete) {
  let accountEquity = VIRTUAL_ACCOUNT_START_USD;
  const trades = db.prepare(`
    SELECT id, status, direction, entry_price, initial_stop_loss,
      stop_loss, exit_price, estimated_total_cost_usd_per_oz
    FROM recommendations
    ORDER BY id
  `).all();

  for (const trade of trades) {
    const initialStop =
      Number.isFinite(trade.initial_stop_loss) && trade.initial_stop_loss > 0
        ? trade.initial_stop_loss
        : trade.stop_loss;
    const position = calculateVirtualPosition(
      trade.entry_price,
      initialStop,
      accountEquity,
    );
    let grossUsd = 0;
    let costUsd = 0;
    let netUsd = 0;

    if (trade.status !== "open" && trade.exit_price !== null) {
      const pnl = calculateVirtualPnl(
        trade.direction,
        trade.entry_price,
        trade.exit_price,
        position.quantityOunces,
      );
      grossUsd = pnl.grossUsd;
      costUsd =
        Number(trade.estimated_total_cost_usd_per_oz ?? ESTIMATED_TOTAL_COST_USD_PER_OUNCE) *
        position.quantityOunces;
      netUsd = grossUsd - costUsd;
      accountEquity += netUsd;
    }

    db.prepare(`
      UPDATE recommendations SET
        account_equity_at_entry = ?,
        risk_budget_usd = ?,
        virtual_quantity_ounces = ?,
        account_model = ?,
        realized_gross_usd = ?,
        estimated_cost_usd = ?,
        realized_net_usd = ?,
        account_equity_after = ?
      WHERE id = ?
    `).run(
      position.accountEquityUsd,
      position.riskBudgetUsd,
      position.quantityOunces,
      `virtual-0.01lot-per-100-usd-v1`,
      grossUsd,
      costUsd,
      netUsd,
      trade.status === "open" ? null : accountEquity,
      trade.id,
    );

    db.prepare(`
      UPDATE recommendation_events
      SET point_move = CASE
            WHEN ? = 'buy' THEN price - ?
            ELSE ? - price
          END,
          gross_pnl_usd = (
            CASE WHEN ? = 'buy' THEN price - ? ELSE ? - price END
          ) * ? * quantity_fraction,
          estimated_cost_usd = COALESCE((
            SELECT estimated_total_cost_usd_per_oz
            FROM recommendations
            WHERE id = recommendation_events.recommendation_id
          ), ?) * ? * quantity_fraction,
          net_pnl_usd = (
            (CASE WHEN ? = 'buy' THEN price - ? ELSE ? - price END) * ? * quantity_fraction
          ) - COALESCE((
            SELECT estimated_total_cost_usd_per_oz
            FROM recommendations
            WHERE id = recommendation_events.recommendation_id
          ), ?) * ? * quantity_fraction
      WHERE recommendation_id = ?
    `).run(
      trade.direction, trade.entry_price, trade.entry_price,
      trade.direction, trade.entry_price, trade.entry_price,
      position.quantityOunces,
      ESTIMATED_TOTAL_COST_USD_PER_OUNCE,
      position.quantityOunces,
      trade.direction, trade.entry_price, trade.entry_price,
      position.quantityOunces,
      ESTIMATED_TOTAL_COST_USD_PER_OUNCE,
      position.quantityOunces,
      trade.id,
    );
  }
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run(
    lotSizingBackfillKey,
    new Date().toISOString(),
  );
}

let sourceError = "";
let pollTimer;
let calendarTimer;
let shuttingDown = false;
let calendarState = {
  status: FRED_API_KEY ? "loading" : "not_configured",
  checkedAt: null,
  lastSuccessAt: null,
  error: "",
};

function getDateOffset(date, offsetDays) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

async function fetchFredCalendar() {
  const releases = [];
  const pageSize = 1000;
  let totalCount = Infinity;

  for (let page = 0; page < MAX_CALENDAR_PAGES && releases.length < totalCount; page += 1) {
    const url = new URL(FRED_URL);
    url.searchParams.set("api_key", FRED_API_KEY);
    url.searchParams.set("file_type", "json");
    url.searchParams.set("include_release_dates_with_no_data", "true");
    url.searchParams.set("order_by", "release_date");
    url.searchParams.set("sort_order", "asc");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(page * pageSize));

    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      throw new Error(`FRED calendar returned HTTP ${response.status}`);
    }

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

async function pollEconomicCalendar() {
  if (shuttingDown || !FRED_API_KEY) return;

  try {
    const today = getNewYorkDate();
    const firstDate = getDateOffset(today, -CALENDAR_RETENTION_DAYS);
    const lastDate = getDateOffset(today, CALENDAR_LOOKAHEAD_DAYS);
    const releases = await fetchFredCalendar();
    const events = releases
      .map(normalizeFredRelease)
      .filter((event) => event && event.date >= firstDate && event.date <= lastDate);
    const syncedAt = new Date().toISOString();

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM economic_calendar_events WHERE source = 'FRED'").run();
      const upsert = db.prepare(`
        INSERT INTO economic_calendar_events (
          event_id, release_id, event_name, event_date, impact, source, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          event_name = excluded.event_name,
          event_date = excluded.event_date,
          impact = excluded.impact,
          synced_at = excluded.synced_at
      `);
      for (const event of events) {
        upsert.run(event.id, event.releaseId, event.name, event.date, event.impact, event.source, syncedAt);
      }
      db.prepare(`
        DELETE FROM economic_calendar_events
        WHERE source = 'FRED' AND event_date < ?
      `).run(firstDate);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    calendarState = {
      status: "ready",
      checkedAt: syncedAt,
      lastSuccessAt: syncedAt,
      error: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown FRED calendar error.";
    calendarState = {
      ...calendarState,
      status: "error",
      checkedAt: new Date().toISOString(),
      error: message,
    };
    console.error(`[economic-calendar] ${message}`);
  } finally {
    if (!shuttingDown) {
      const interval = calendarState.status === "ready" ? CALENDAR_REFRESH_MS : CALENDAR_RETRY_MS;
      calendarTimer = setTimeout(pollEconomicCalendar, interval);
    }
  }
}

function getEconomicCalendarGuard() {
  const today = getNewYorkDate();
  const horizon = getDateOffset(today, CALENDAR_LOOKAHEAD_DAYS);
  const upcomingEvents = db.prepare(`
    SELECT event_id AS id, release_id AS releaseId, event_name AS name,
      event_date AS date, impact, source
    FROM economic_calendar_events
    WHERE event_date >= ? AND event_date <= ? AND impact = 'high'
    ORDER BY event_date, event_name
  `).all(today, horizon);
  const todayEvents = upcomingEvents.filter((event) => event.date === today);
  const isStale = calendarState.lastSuccessAt !== null &&
    Date.now() - Date.parse(calendarState.lastSuccessAt) > 24 * 60 * 60 * 1000;
  const status = isStale ? "stale" : calendarState.status;
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
    checkedAt: calendarState.checkedAt,
    message,
    details: calendarState.error,
    timePrecision: "date-only",
  };
}

function getOpenRecommendation() {
  return db.prepare(
    "SELECT * FROM recommendations WHERE status = 'open' ORDER BY id DESC LIMIT 1",
  ).get() ?? null;
}

function getRecentPrices(limit = REQUIRED_SAMPLES) {
  return db.prepare(
    "SELECT price, source_updated_at, observed_at FROM price_points ORDER BY id DESC LIMIT ?",
  ).all(limit).reverse();
}

function getVirtualAccountEquity() {
  const row = db.prepare(`
    SELECT COALESCE(SUM(realized_net_usd), 0) AS realizedNet
    FROM recommendations
    WHERE status IN ('success', 'failed')
  `).get();
  return VIRTUAL_ACCOUNT_START_USD + Number(row.realizedNet);
}

function ensureStrategyComparisonAccounts() {
  db.exec(`
    DELETE FROM strategy_comparison_trades
    WHERE strategy_id NOT IN (
      'baseline-sma-5-12', 'sma-10-20', 'donchian-20', 'rsi-14', 'macd-12-26-9'
    );
    DELETE FROM strategy_comparison_accounts
    WHERE strategy_id NOT IN (
      'baseline-sma-5-12', 'sma-10-20', 'donchian-20', 'rsi-14', 'macd-12-26-9'
    );
  `);
  const insert = db.prepare(`
    INSERT INTO strategy_comparison_accounts (
      strategy_id, strategy_name, sizing_mode_id, sizing_mode_name,
      sizing_mode, equity_usd, starting_equity_usd, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_id, sizing_mode_id) DO UPDATE SET
      strategy_name = excluded.strategy_name,
      sizing_mode_name = excluded.sizing_mode_name,
      sizing_mode = excluded.sizing_mode,
      updated_at = excluded.updated_at
  `);
  const now = new Date().toISOString();
  for (const strategy of COMPARISON_STRATEGIES) {
    for (const mode of COMPARISON_SIZING_MODES) {
      insert.run(
        strategy.id,
        strategy.name,
        mode.id,
        mode.name,
        mode.sizing,
        COMPARISON_STARTING_EQUITY_USD,
        COMPARISON_STARTING_EQUITY_USD,
        now,
      );
    }
  }
}

function backfillStrategyComparisons(force = false) {
  ensureStrategyComparisonAccounts();
  const key = "strategy-comparison-backfill-v5";
  if (!force && db.prepare("SELECT value FROM app_state WHERE key = ?").get(key)) return;

  db.exec("DELETE FROM strategy_comparison_trades");
  const insertTrade = db.prepare(`
    INSERT INTO strategy_comparison_trades (
      account_id, strategy_id, strategy_name, sizing_mode_id, sizing_mode_name,
      status, direction, entry_price, stop_loss, take_profit_1, take_profit_2,
      take_profit_3, next_target, remaining_fraction, realized_gross_percent,
      quantity_ounces, lot_size, gross_usd, estimated_cost_usd, net_usd,
      close_reason, opened_at, closed_at, exit_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const points = db.prepare(`
    SELECT price, observed_at AS observedAt
    FROM price_points ORDER BY id
  `).all();

  for (const strategy of COMPARISON_STRATEGIES) {
    for (const mode of COMPARISON_SIZING_MODES) {
      const account = db.prepare(`
        SELECT * FROM strategy_comparison_accounts
        WHERE strategy_id = ? AND sizing_mode_id = ?
      `).get(strategy.id, mode.id);
      let equity = COMPARISON_STARTING_EQUITY_USD;
      let openTrade = null;
      let tradeCount = 0;
      let winCount = 0;
      let lossCount = 0;

      const prices = [];
      for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
        const point = points[pointIndex];
        const stale = isStaleComparisonQuote(point, points[pointIndex - 1]);
        prices.push(point.price);
        if (openTrade) {
          openTrade = advanceComparisonTrade(
            openTrade, point.price, point.observedAt, { deferExpiry: stale },
          );
          if (openTrade.status !== "open") {
              openTrade = clampComparisonTradeToEquity(openTrade, equity, mode);
            const insertResult = insertTrade.run(
              account.id,
              strategy.id,
              strategy.name,
              mode.id,
              mode.name,
              openTrade.status,
              openTrade.direction,
              openTrade.entryPrice,
              openTrade.stopLoss,
              openTrade.takeProfit1,
              openTrade.takeProfit2,
              openTrade.takeProfit3,
              openTrade.nextTarget,
              openTrade.remainingFraction,
              openTrade.realizedGrossPercent,
              openTrade.quantityOunces,
              openTrade.lotSize,
              openTrade.grossUsd,
              openTrade.estimatedCostUsd,
              openTrade.netUsd,
              openTrade.closeReason,
              openTrade.openedAt,
              openTrade.closedAt,
              openTrade.exitPrice,
            );
            equity += openTrade.netUsd;
            tradeCount += 1;
            if (openTrade.status === "success") winCount += 1;
            else lossCount += 1;
            openTrade = null;
            if (insertResult.changes !== 1) throw new Error("Failed to save comparison trade.");
          }
          continue;
        }

        if (stale) continue;
        const direction = getStrategySignal(strategy.id, prices);
        if (direction === "wait") continue;
        if (equity <= 0) continue;
        const stopLoss = direction === "buy"
          ? point.price * (1 - COMPARISON_STOP_PERCENT / 100)
          : point.price * (1 + COMPARISON_STOP_PERCENT / 100);
        const risk = Math.abs(point.price - stopLoss);
        const directionSign = direction === "buy" ? 1 : -1;
        const position = calculateComparisonPosition(mode, equity, point.price, stopLoss);
        openTrade = {
          status: "open",
          direction,
          entryPrice: point.price,
          stopLoss,
          takeProfit1: point.price + directionSign * risk,
          takeProfit2: point.price + directionSign * risk * 2,
          takeProfit3: point.price + directionSign * risk * 3,
          nextTarget: 1,
          remainingFraction: 1,
          realizedGrossPercent: 0,
          quantityOunces: position.quantityOunces,
          lotSize: position.lotSize,
          openedAt: point.observedAt,
        };
      }

      if (openTrade) {
        insertTrade.run(
          account.id,
          strategy.id,
          strategy.name,
          mode.id,
          mode.name,
          "open",
          openTrade.direction,
          openTrade.entryPrice,
          openTrade.stopLoss,
          openTrade.takeProfit1,
          openTrade.takeProfit2,
          openTrade.takeProfit3,
          openTrade.nextTarget,
          openTrade.remainingFraction,
          openTrade.realizedGrossPercent,
          openTrade.quantityOunces,
          openTrade.lotSize,
          null,
          null,
          null,
          null,
          openTrade.openedAt,
          null,
          null,
        );
      }

      db.prepare(`
        UPDATE strategy_comparison_accounts SET
          equity_usd = ?, realized_gross_usd = (
            SELECT COALESCE(SUM(gross_usd), 0)
            FROM strategy_comparison_trades
            WHERE account_id = ?
          ),
          estimated_cost_usd = (
            SELECT COALESCE(SUM(estimated_cost_usd), 0)
            FROM strategy_comparison_trades
            WHERE account_id = ?
          ),
          realized_net_usd = ?,
          trade_count = ?, win_count = ?, loss_count = ?,
          open_trade_count = ?, updated_at = ?
        WHERE id = ?
      `).run(
        equity,
        account.id,
        account.id,
        equity - COMPARISON_STARTING_EQUITY_USD,
        tradeCount,
        winCount,
        lossCount,
        openTrade ? 1 : 0,
        new Date().toISOString(),
        account.id,
      );
    }
  }

  db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(
    key,
    new Date().toISOString(),
  );
}

// Full rebuilds are reserved for startup/schema changes. On a fresh price we
// only advance the open comparison trades and evaluate one new entry per
// account, so the work per tick no longer grows with the size of price history.
function advanceStrategyComparisons(point) {
  ensureStrategyComparisonAccounts();
  const prices = db.prepare("SELECT price FROM price_points ORDER BY id").all()
    .map((row) => row.price);
  const previousQuote = db.prepare(`
    SELECT price, observed_at AS observedAt FROM price_points ORDER BY id DESC LIMIT 1 OFFSET 1
  `).get() ?? null;
  const stale = isStaleComparisonQuote(point, previousQuote);
  const findOpenTrade = db.prepare(`
    SELECT id AS dbId, status, direction,
      entry_price AS entryPrice, stop_loss AS stopLoss,
      take_profit_1 AS takeProfit1, take_profit_2 AS takeProfit2,
      take_profit_3 AS takeProfit3, next_target AS nextTarget,
      remaining_fraction AS remainingFraction,
      realized_gross_percent AS realizedGrossPercent,
      quantity_ounces AS quantityOunces, lot_size AS lotSize,
      opened_at AS openedAt
    FROM strategy_comparison_trades
    WHERE account_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1
  `);
  const updateOpenTrade = db.prepare(`
    UPDATE strategy_comparison_trades SET
      stop_loss = ?, next_target = ?, remaining_fraction = ?, realized_gross_percent = ?
    WHERE id = ?
  `);
  const updateClosedTrade = db.prepare(`
    UPDATE strategy_comparison_trades SET
      status = ?, stop_loss = ?, next_target = ?, remaining_fraction = ?,
      realized_gross_percent = ?, gross_usd = ?, estimated_cost_usd = ?, net_usd = ?,
      close_reason = ?, closed_at = ?, exit_price = ?
    WHERE id = ?
  `);
  const insertTrade = db.prepare(`
    INSERT INTO strategy_comparison_trades (
      account_id, strategy_id, strategy_name, sizing_mode_id, sizing_mode_name,
      status, direction, entry_price, stop_loss, take_profit_1, take_profit_2,
      take_profit_3, next_target, remaining_fraction, realized_gross_percent,
      quantity_ounces, lot_size, gross_usd, estimated_cost_usd, net_usd,
      close_reason, opened_at, closed_at, exit_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const accountStats = db.prepare(`
    SELECT COUNT(*) AS tradeCount,
      COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS winCount,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS lossCount,
      COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS openCount,
      COALESCE(SUM(gross_usd), 0) AS grossUsd,
      COALESCE(SUM(estimated_cost_usd), 0) AS costUsd
    FROM strategy_comparison_trades WHERE account_id = ?
  `);
  const updateAccount = db.prepare(`
    UPDATE strategy_comparison_accounts SET
      equity_usd = ?, realized_gross_usd = ?, estimated_cost_usd = ?,
      realized_net_usd = ?, trade_count = ?, win_count = ?, loss_count = ?,
      open_trade_count = ?, updated_at = ?
    WHERE id = ?
  `);
  const now = new Date().toISOString();

  for (const account of db.prepare("SELECT * FROM strategy_comparison_accounts").all()) {
    const sizingMode = COMPARISON_SIZING_MODES.find((mode) => mode.id === account.sizing_mode_id);
    if (!sizingMode) continue;
    let equityUsd = account.equity_usd;
    let openTrade = findOpenTrade.get(account.id);

    if (openTrade) {
      const advanced = advanceComparisonTrade(
        openTrade, point.price, point.observedAt, { deferExpiry: stale },
      );
      if (advanced.status === "open") {
        updateOpenTrade.run(
          advanced.stopLoss, advanced.nextTarget, advanced.remainingFraction,
          advanced.realizedGrossPercent, openTrade.dbId,
        );
      } else {
        const closed = clampComparisonTradeToEquity(advanced, equityUsd, sizingMode);
        updateClosedTrade.run(
          closed.status, closed.stopLoss, closed.nextTarget, closed.remainingFraction,
          closed.realizedGrossPercent, closed.grossUsd, closed.estimatedCostUsd, closed.netUsd,
          closed.closeReason, closed.closedAt, closed.exitPrice, openTrade.dbId,
        );
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
        const position = calculateComparisonPosition(
          sizingMode, equityUsd, point.price, stopLoss,
        );
        const sign = direction === "buy" ? 1 : -1;
        insertTrade.run(
          account.id,
          account.strategy_id,
          account.strategy_name,
          account.sizing_mode_id,
          account.sizing_mode_name,
          "open",
          direction,
          point.price,
          stopLoss,
          point.price + sign * Math.abs(point.price - stopLoss),
          point.price + sign * Math.abs(point.price - stopLoss) * 2,
          point.price + sign * Math.abs(point.price - stopLoss) * 3,
          1,
          1,
          0,
          position.quantityOunces,
          position.lotSize,
          null,
          null,
          null,
          null,
          point.observedAt,
          null,
          null,
        );
      }
    }

    const stats = accountStats.get(account.id);
    updateAccount.run(
      equityUsd,
      stats.grossUsd,
      stats.costUsd,
      equityUsd - COMPARISON_STARTING_EQUITY_USD,
      stats.tradeCount,
      stats.winCount,
      stats.lossCount,
      stats.openCount,
      now,
      account.id,
    );
  }
}

function updateOpenRecommendation(price, observedAt) {
  const recommendation = getOpenRecommendation();
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

    db.prepare(`
      UPDATE recommendations
      SET status = ?, closed_at = ?, exit_price = ?, result_percent = ?, close_reason = ?,
        estimated_net_result_percent = ?
      WHERE id = ? AND status = 'open'
    `).run(
      outcome ?? (resultPercent > 0 ? "success" : "failed"),
      observedAt,
      price,
      resultPercent,
      closeReason,
      getEstimatedNetResult(recommendation, resultPercent),
      recommendation.id,
    );
    if (timeExpired && !outcome) {
      insertRecommendationEvent(
        recommendation.id,
        "trade_closed",
        null,
        price,
        1,
        resultPercent,
        recommendation.stop_loss,
        observedAt,
        recommendation,
      );
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
  db.prepare(`
    UPDATE recommendations SET
      status = ?, stop_loss = ?, next_target = ?, remaining_fraction = ?,
      realized_percent = ?, closed_at = ?, exit_price = ?, result_percent = ?,
      close_reason = ?, estimated_net_result_percent = ?
    WHERE id = ? AND status = 'open'
  `).run(
    status,
    updated.stop_loss,
    updated.next_target,
    updated.remaining_fraction,
    updated.realized_percent,
    status === "open" ? null : observedAt,
    updated.exit_price ?? null,
    updated.result_percent ?? null,
    updated.close_reason ?? null,
    estimatedNetResult,
    recommendation.id,
  );
  for (const event of events) {
    insertRecommendationEvent(
      recommendation.id,
      event.eventType,
      event.targetNumber,
      event.price,
      event.quantityFraction,
      event.contributionPercent,
      event.currentStopLoss,
      observedAt,
      recommendation,
    );
  }
}

function getEstimatedNetResult(recommendation, grossResultPercent) {
  if (
    !recommendation.cost_estimate_model ||
    !Number.isFinite(recommendation.estimated_total_cost_usd_per_oz)
  ) {
    return null;
  }
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

function insertRecommendationEvent(
  recommendationId,
  eventType,
  targetNumber,
  price,
  quantityFraction,
  contributionPercent,
  currentStopLoss,
  occurredAt,
  recommendation,
) {
  const storedRecommendation = db.prepare(`
    SELECT account_equity_at_entry, realized_net_usd, virtual_quantity_ounces,
      estimated_total_cost_usd_per_oz, cost_estimate_model,
      direction, entry_price
    FROM recommendations WHERE id = ?
  `).get(recommendationId) ?? recommendation;
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
    estimatedCostUsdPerOunce =
      recommendation.estimated_total_cost_usd_per_oz * quantityFraction;
    netContributionPercent = contributionPercent -
      (estimatedCostUsdPerOunce / recommendation.entry_price) * 100;

    if (
      Number.isFinite(storedRecommendation.virtual_quantity_ounces) &&
      storedRecommendation.virtual_quantity_ounces > 0 &&
      quantityFraction > 0
    ) {
      const closedQuantity = storedRecommendation.virtual_quantity_ounces * quantityFraction;
      const virtualPnl = calculateVirtualPnl(
        storedRecommendation.direction,
        storedRecommendation.entry_price,
        price,
        closedQuantity,
      );
      pointMove = virtualPnl.pointMove;
      grossPnlUsd = virtualPnl.grossUsd;
      estimatedCostUsd = storedRecommendation.estimated_total_cost_usd_per_oz * closedQuantity;
      netPnlUsd = grossPnlUsd - estimatedCostUsd;
      const priorNet = Number(storedRecommendation.realized_net_usd ?? 0);
      accountEquityAfter = storedRecommendation.account_equity_at_entry + priorNet + netPnlUsd;
    }
  }
  db.prepare(`
    INSERT INTO recommendation_events (
      recommendation_id, event_type, target_number, price,
      quantity_fraction, contribution_percent, current_stop_loss, occurred_at,
      estimated_cost_usd_per_oz, net_contribution_percent,
      point_move, gross_pnl_usd, estimated_cost_usd, net_pnl_usd,
      account_equity_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recommendationId,
    eventType,
    targetNumber,
    price,
    quantityFraction,
    contributionPercent,
    currentStopLoss,
    occurredAt,
    estimatedCostUsdPerOunce,
    netContributionPercent,
    pointMove,
    grossPnlUsd,
    estimatedCostUsd,
    netPnlUsd,
    accountEquityAfter,
  );

  if (netPnlUsd !== null && quantityFraction > 0) {
    db.prepare(`
      UPDATE recommendations SET
        realized_gross_usd = realized_gross_usd + ?,
        estimated_cost_usd = estimated_cost_usd + ?,
        realized_net_usd = realized_net_usd + ?,
        account_equity_after = ?
      WHERE id = ?
    `).run(
      grossPnlUsd,
      estimatedCostUsd,
      netPnlUsd,
      accountEquityAfter,
      recommendationId,
    );
  }
}

function saveRecommendation(signal, price, providerUpdatedAt, observedAt) {
  const initialStopLoss = signal.direction === "buy"
    ? price * (1 - STOP_PERCENT / 100)
    : price * (1 + STOP_PERCENT / 100);
  const { takeProfits } = calculateManagedLevels(signal.direction, price, initialStopLoss);
  const furthestTargetPercent = STOP_PERCENT * TARGET_R_MULTIPLIERS.at(-1);
  const accountEquity = getVirtualAccountEquity();
  if (!Number.isFinite(accountEquity) || accountEquity <= 0) {
    console.warn("[virtual-account] equity exhausted; skipping new recommendation.");
    return;
  }
  const virtualPosition = calculateVirtualPosition(
    price,
    initialStopLoss,
    accountEquity,
  );

  db.prepare(`
    INSERT INTO recommendations (
      status, direction, entry_price, take_profit, stop_loss, initial_stop_loss,
      take_profit_1, take_profit_2, take_profit_3, management_version,
      next_target, remaining_fraction, realized_percent,
      target_percent, stop_percent, short_average, long_average,
      change_percent, strategy_version, provider_updated_at, created_at,
      cost_estimate_model, estimated_spread_usd_per_oz,
      estimated_slippage_usd_per_oz, estimated_commission_usd_per_oz,
      estimated_total_cost_usd_per_oz,
      account_equity_at_entry, risk_budget_usd, virtual_quantity_ounces,
      account_model
    ) VALUES ('open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signal.direction,
    price,
    takeProfits[2],
    initialStopLoss,
    initialStopLoss,
    takeProfits[0],
    takeProfits[1],
    takeProfits[2],
    TRADE_MANAGEMENT_VERSION,
    furthestTargetPercent,
    STOP_PERCENT,
    signal.shortAverage,
    signal.longAverage,
    signal.changePercent,
    STRATEGY_VERSION,
    providerUpdatedAt,
    observedAt,
    COST_ESTIMATE_CONFIG.model.id,
    COST_ESTIMATE_CONFIG.spreadUsdPerOunce,
    COST_ESTIMATE_CONFIG.slippageUsdPerOuncePerSide * 2,
    COST_ESTIMATE_CONFIG.commissionUsdPerOuncePerSide * 2,
    ESTIMATED_TOTAL_COST_USD_PER_OUNCE,
    virtualPosition.accountEquityUsd,
    virtualPosition.riskBudgetUsd,
    virtualPosition.quantityOunces,
    `virtual-${VIRTUAL_ACCOUNT_LOT_STEP_SIZE.toFixed(2)}lot-per-${VIRTUAL_ACCOUNT_LOT_STEP_USD}-usd-v1`,
  );
}

function recordTradePriceObservations(data, observedAt) {
  const firstPostCloseObservation = new Date(
    Date.parse(observedAt) - POST_CLOSE_OBSERVATION_MS,
  ).toISOString();
  const recommendations = db.prepare(`
    SELECT id, closed_at AS closedAt
    FROM recommendations
    WHERE status = 'open' OR (closed_at IS NOT NULL AND closed_at >= ?)
  `).all(firstPostCloseObservation);
  const insertObservation = db.prepare(`
    INSERT OR IGNORE INTO trade_price_observations (
      recommendation_id, price, source, source_updated_at, observed_at, phase
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const recommendation of recommendations) {
    insertObservation.run(
      recommendation.id,
      data.price,
      "Gold API",
      data.updatedAt,
      observedAt,
      recommendation.closedAt === null || recommendation.closedAt === observedAt
        ? "open"
        : "post_close",
    );
  }
}

function recordQuoteGap(previousPrice, data, observedAt) {
  if (!previousPrice) return;
  const gapMilliseconds = Date.parse(observedAt) - Date.parse(previousPrice.observed_at);
  if (gapMilliseconds < MAX_PRICE_GAP_MS) return;

  const gapStart = previousPrice.observed_at;
  const recommendations = db.prepare(`
    SELECT id FROM recommendations
    WHERE status = 'open' OR (closed_at IS NOT NULL AND closed_at >= ?)
  `).all(new Date(Date.parse(gapStart) - POST_CLOSE_OBSERVATION_MS).toISOString());
  const insertGap = db.prepare(`
    INSERT INTO trade_data_gaps (
      recommendation_id, last_observed_at, resumed_at, duration_seconds, resume_price
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const recommendation of recommendations) {
    insertGap.run(
      recommendation.id,
      gapStart,
      observedAt,
      gapMilliseconds / 1000,
      data.price,
    );
  }
}

function recordPrice(data) {
  const observedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const previousPrice = db.prepare(`
      SELECT observed_at FROM price_points ORDER BY id DESC LIMIT 1
    `).get() ?? null;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO price_points (price, currency, symbol, source_updated_at, observed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.price, data.currency, data.symbol, data.updatedAt, observedAt);

    if (insert.changes === 0) {
      db.exec("COMMIT");
      return;
    }

    recordQuoteGap(previousPrice, data, observedAt);
    updateOpenRecommendation(data.price, observedAt);

    const points = getRecentPrices();
    const signal = calculateSignal(points.map((point) => point.price));
    if (signal) {
      const previous = db.prepare(
        "SELECT value FROM app_state WHERE key = 'last_signal_direction'",
      ).get()?.value ?? "wait";
      const canOpen = !getOpenRecommendation() && !getEconomicCalendarGuard().blocked;
      const { shouldOpen, nextDirection } = resolveSignalTransition(
        signal.direction,
        previous,
        canOpen,
      );
      db.prepare(`
        INSERT INTO app_state (key, value) VALUES ('last_signal_direction', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(nextDirection);

      if (shouldOpen) {
        saveRecommendation(signal, data.price, data.updatedAt, observedAt);
      }
    }
    recordTradePriceObservations(data, observedAt);
    advanceStrategyComparisons({ price: data.price, observedAt });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function pollPrice() {
  if (shuttingDown) return;

  try {
    const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(10_000) });
    if (shuttingDown) return;
    if (!response.ok) throw new Error(`مصدر السعر أعاد HTTP ${response.status}`);
    const data = await response.json();
    if (shuttingDown) return;
    if (
      data.symbol !== "XAU" ||
      data.currency !== "USD" ||
      !Number.isFinite(data.price) ||
      data.price <= 0 ||
      !Number.isFinite(Date.parse(data.updatedAt))
    ) {
      throw new Error("استقبلنا بيانات سعر غير صالحة من Gold API.");
    }

    recordPrice(data);
    sourceError = "";
  } catch (error) {
    sourceError = error instanceof Error ? error.message : "خطأ غير معروف في مصدر السعر.";
    console.error(`[price-poller] ${sourceError}`);
  } finally {
    if (!shuttingDown) pollTimer = setTimeout(pollPrice, SAMPLE_INTERVAL_MS);
  }
}

function getState() {
  const latest = db.prepare(
    "SELECT price, currency, symbol, source_updated_at AS sourceUpdatedAt, observed_at AS observedAt FROM price_points ORDER BY id DESC LIMIT 1",
  ).get() ?? null;
  const priceAgeSeconds = latest
    ? Math.max(0, Math.floor((Date.now() - Date.parse(latest.observedAt)) / 1000))
    : null;
  const points = db.prepare(`
    SELECT price, source_updated_at AS sourceUpdatedAt, observed_at AS observedAt
    FROM price_points ORDER BY id DESC LIMIT ?
  `).all(MAX_RETURNED_POINTS).reverse();
  const recommendations = db.prepare(`
    SELECT id, status, direction, entry_price AS entryPrice,
      take_profit AS takeProfit, stop_loss AS stopLoss,
      initial_stop_loss AS initialStopLoss,
      take_profit_1 AS takeProfit1, take_profit_2 AS takeProfit2,
      take_profit_3 AS takeProfit3, next_target AS nextTarget,
      remaining_fraction AS remainingFraction, realized_percent AS realizedPercent,
      management_version AS managementVersion,
      target_percent AS targetPercent, stop_percent AS stopPercent,
      short_average AS shortAverage, long_average AS longAverage,
      change_percent AS changePercent, strategy_version AS strategyVersion,
      provider_updated_at AS providerUpdatedAt, created_at AS createdAt,
      price_source AS priceSource,
      closed_at AS closedAt, exit_price AS exitPrice,
      result_percent AS resultPercent, close_reason AS closeReason,
      cost_estimate_model AS costEstimateModel,
      estimated_spread_usd_per_oz AS estimatedSpreadUsdPerOunce,
      estimated_slippage_usd_per_oz AS estimatedSlippageUsdPerOunce,
      estimated_commission_usd_per_oz AS estimatedCommissionUsdPerOunce,
      estimated_total_cost_usd_per_oz AS estimatedTotalCostUsdPerOunce,
      estimated_net_result_percent AS estimatedNetResultPercent,
      account_equity_at_entry AS accountEquityAtEntry,
      risk_budget_usd AS riskBudgetUsd,
      virtual_quantity_ounces AS virtualQuantityOunces,
      realized_gross_usd AS realizedGrossUsd,
      estimated_cost_usd AS estimatedCostUsd,
      realized_net_usd AS realizedNetUsd,
      account_equity_after AS accountEquityAfter,
      account_model AS accountModel,
      (SELECT COUNT(*) FROM trade_price_observations o
        WHERE o.recommendation_id = recommendations.id) AS observationCount,
      (SELECT COUNT(*) FROM trade_price_observations o
        WHERE o.recommendation_id = recommendations.id AND o.phase = 'open') AS openObservationCount,
      (SELECT COUNT(*) FROM trade_price_observations o
        WHERE o.recommendation_id = recommendations.id AND o.phase = 'post_close') AS postCloseObservationCount,
      (SELECT MIN(price) FROM trade_price_observations o
        WHERE o.recommendation_id = recommendations.id AND o.phase = 'open') AS openObservedLow,
      (SELECT MAX(price) FROM trade_price_observations o
        WHERE o.recommendation_id = recommendations.id AND o.phase = 'open') AS openObservedHigh,
      (SELECT MIN(price) FROM trade_price_observations o
        WHERE o.recommendation_id = recommendations.id AND o.phase = 'post_close') AS postCloseObservedLow,
      (SELECT MAX(price) FROM trade_price_observations o
        WHERE o.recommendation_id = recommendations.id AND o.phase = 'post_close') AS postCloseObservedHigh,
      (SELECT MAX(observed_at) FROM trade_price_observations o
        WHERE o.recommendation_id = recommendations.id) AS lastObservationAt,
      (SELECT COUNT(*) FROM trade_data_gaps g
        WHERE g.recommendation_id = recommendations.id) AS dataGapCount
    FROM recommendations ORDER BY id DESC LIMIT ?
  `).all(MAX_RETURNED_RECOMMENDATIONS);
  const getEvents = db.prepare(`
    SELECT id, event_type AS eventType, target_number AS targetNumber,
      price, quantity_fraction AS quantityFraction,
      contribution_percent AS contributionPercent,
      current_stop_loss AS currentStopLoss, occurred_at AS occurredAt,
      estimated_cost_usd_per_oz AS estimatedCostUsdPerOunce,
      net_contribution_percent AS netContributionPercent,
      point_move AS pointMove,
      gross_pnl_usd AS grossPnlUsd,
      estimated_cost_usd AS estimatedCostUsd,
      net_pnl_usd AS netPnlUsd,
      account_equity_after AS accountEquityAfter
    FROM recommendation_events WHERE recommendation_id = ? ORDER BY id
  `);
  for (const recommendation of recommendations) {
    recommendation.events = getEvents.all(recommendation.id);
    const durationEnd = recommendation.closedAt ?? latest?.observedAt ?? recommendation.createdAt;
    recommendation.durationMinutes = Math.max(
      0,
      Math.floor((Date.parse(durationEnd) - Date.parse(recommendation.createdAt)) / 60_000),
    );
    if (
      recommendation.status === "open" &&
      latest &&
      priceAgeSeconds < MAX_PRICE_GAP_MS / 1000 &&
      recommendation.costEstimateModel
    ) {
      const grossIfClosed = recommendation.realizedPercent +
        calculatePartialResultPercent(
          recommendation.direction,
          recommendation.entryPrice,
          latest.price,
          recommendation.remainingFraction,
        );
      recommendation.estimatedNetIfClosedNow = getEstimatedNetResult(
        {
          entry_price: recommendation.entryPrice,
          cost_estimate_model: recommendation.costEstimateModel,
          estimated_spread_usd_per_oz: recommendation.estimatedSpreadUsdPerOunce,
          estimated_slippage_usd_per_oz: recommendation.estimatedSlippageUsdPerOunce,
          estimated_commission_usd_per_oz: recommendation.estimatedCommissionUsdPerOunce,
          estimated_total_cost_usd_per_oz: recommendation.estimatedTotalCostUsdPerOunce,
        },
        grossIfClosed,
      );
    } else {
      recommendation.estimatedNetIfClosedNow = null;
    }
  }
  const activeRecommendation = recommendations.find((item) => item.status === "open") ?? null;
  const signal = calculateSignal(getRecentPrices().map((point) => point.price));
  const realizedRow = db.prepare(`
    SELECT COALESCE(SUM(realized_net_usd), 0) AS realizedNet
    FROM recommendations
    WHERE status IN ('success', 'failed')
  `).get();
  const realizedNetUsd = Number(realizedRow.realizedNet);
  const virtualAccountEquity = VIRTUAL_ACCOUNT_START_USD + realizedNetUsd;
  const virtualAccount = {
    startingEquityUsd: VIRTUAL_ACCOUNT_START_USD,
    sizingRule: `0.01 lot لكل $100; حد أدنى 0.01 lot`,
    lotStepUsd: VIRTUAL_ACCOUNT_LOT_STEP_USD,
    lotStepSize: VIRTUAL_ACCOUNT_LOT_STEP_SIZE,
    ouncesPerLot: VIRTUAL_ACCOUNT_OUNCES_PER_LOT,
    realizedNetUsd,
    equityUsd: virtualAccountEquity,
    returnPercent: ((virtualAccountEquity - VIRTUAL_ACCOUNT_START_USD) /
      VIRTUAL_ACCOUNT_START_USD) * 100,
  };
  const strategyAccounts = db.prepare(`
    SELECT id, strategy_id AS strategyId, strategy_name AS strategyName,
      sizing_mode_id AS sizingModeId, sizing_mode_name AS sizingModeName,
      equity_usd AS equityUsd, starting_equity_usd AS startingEquityUsd,
      realized_gross_usd AS realizedGrossUsd,
      estimated_cost_usd AS estimatedCostUsd,
      realized_net_usd AS realizedNetUsd,
      trade_count AS tradeCount, win_count AS winCount,
      loss_count AS lossCount, open_trade_count AS openTradeCount,
      updated_at AS updatedAt
    FROM strategy_comparison_accounts
    ORDER BY strategy_name, sizing_mode_name
  `).all();
  const comparisonTradeRows = db.prepare(`
    SELECT id, account_id AS accountId, strategy_id AS strategyId,
      strategy_name AS strategyName, sizing_mode_id AS sizingModeId,
      sizing_mode_name AS sizingModeName, status, direction,
      entry_price AS entryPrice, stop_loss AS stopLoss,
      take_profit_1 AS takeProfit1, take_profit_2 AS takeProfit2,
      take_profit_3 AS takeProfit3, next_target AS nextTarget,
      remaining_fraction AS remainingFraction,
      realized_gross_percent AS realizedGrossPercent,
      quantity_ounces AS quantityOunces, lot_size AS lotSize,
      gross_usd AS grossUsd, estimated_cost_usd AS estimatedCostUsd,
      net_usd AS netUsd, close_reason AS closeReason,
      opened_at AS openedAt, closed_at AS closedAt, exit_price AS exitPrice
    FROM strategy_comparison_trades
    ORDER BY id DESC
  `).all();
  const comparisonTradesByAccount = new Map();
  for (const trade of comparisonTradeRows) {
    const existing = comparisonTradesByAccount.get(trade.accountId) ?? [];
    existing.push(trade);
    comparisonTradesByAccount.set(trade.accountId, existing);
  }
  for (const account of strategyAccounts) {
    account.trades = (comparisonTradesByAccount.get(account.id) ?? []).slice(0, 20);
  }
  const strategyComparison = {
    startingEquityUsd: COMPARISON_STARTING_EQUITY_USD,
    accounts: strategyAccounts,
  };

  return {
    latest,
    points,
    signal,
    activeRecommendation,
    recommendations,
    virtualAccount,
    strategyComparison,
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
    newsGuard: getEconomicCalendarGuard(),
    sourceError,
    strategy: {
      version: STRATEGY_VERSION,
      tradeManagementVersion: TRADE_MANAGEMENT_VERSION,
      requiredSamples: REQUIRED_SAMPLES,
      targetRMultipliers: TARGET_R_MULTIPLIERS,
      stopPercent: STOP_PERCENT,
    },
  };
}

function serveTradeObservations(response, recommendationId) {
  const recommendation = db.prepare(
    "SELECT id FROM recommendations WHERE id = ?",
  ).get(recommendationId);
  if (!recommendation) {
    sendJson(response, 404, { error: "التوصية غير موجودة." });
    return;
  }

  const observations = db.prepare(`
    SELECT source, phase, price, source_updated_at AS sourceUpdatedAt, observed_at AS observedAt
    FROM trade_price_observations
    WHERE recommendation_id = ?
    ORDER BY observed_at, id
  `).all(recommendationId);
  const csvEscape = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const rows = [
    ["trade_id", "source", "phase", "price_usd_per_ounce", "source_updated_at", "observed_at", "source_lag_ms"],
    ...observations.map((observation) => [
      recommendationId,
      observation.source,
      observation.phase,
      observation.price,
      observation.sourceUpdatedAt,
      observation.observedAt,
      Date.parse(observation.observedAt) - Date.parse(observation.sourceUpdatedAt),
    ]),
  ];
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="trade-${recommendationId}-price-history.csv"`,
    "Cache-Control": "no-store",
  });
  response.end(rows.map((row) => row.map(csvEscape).join(",")).join("\r\n"));
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveFrontend(request, response) {
  if (!existsSync(resolve(DIST_DIR, "index.html"))) {
    sendJson(response, 404, { error: "واجهة الإنتاج غير مبنية. شغّل npm run build أولًا." });
    return;
  }

  let requestedPath;
  try {
    requestedPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    sendJson(response, 400, { error: "مسار طلب غير صالح." });
    return;
  }

  const candidate = resolve(DIST_DIR, `.${requestedPath}`);
  const allowedPath = candidate === DIST_DIR || candidate.startsWith(`${DIST_DIR}${sep}`);
  const filePath = allowedPath && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : resolve(DIST_DIR, "index.html");
  const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";

  response.writeHead(200, { "Content-Type": contentType });
  response.end(readFileSync(filePath));
}

function getRequestPathname(request) {
  try {
    return new URL(request.url, "http://localhost").pathname;
  } catch {
    return null;
  }
}

const server = createServer((request, response) => {
  const pathname = getRequestPathname(request);
  if (request.method === "GET" && pathname === "/api/state") {
    sendJson(response, 200, getState());
    return;
  }

  const observationMatch = request.method === "GET" && pathname
    ? /^\/api\/recommendations\/(\d+)\/observations\.csv$/.exec(pathname)
    : null;
  if (observationMatch) {
    serveTradeObservations(response, Number(observationMatch[1]));
    return;
  }

  if (request.url?.startsWith("/api/")) {
    sendJson(response, 404, { error: "مسار API غير معروف." });
    return;
  }

  if (request.method === "GET") {
    serveFrontend(request, response);
    return;
  }

  sendJson(response, 405, { error: "طريقة الطلب غير مدعومة." });
});

server.on("error", (error) => {
  console.error(`[server] ${error.message}`);
  process.exitCode = 1;
});

backfillStrategyComparisons();

server.listen(PORT, () => {
  console.log(`Gold signal server listening on http://localhost:${PORT}`);
  void pollPrice();
  void pollEconomicCalendar();
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(pollTimer);
  clearTimeout(calendarTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
