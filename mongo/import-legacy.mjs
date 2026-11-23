import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decimal, documentHash, sha256Hex, stableObjectId, canonicalJson,
} from "./canonical.mjs";
import {
  LEGACY_EVALUATOR_VERSION, LEGACY_VERSION, withMongo,
} from "./config.mjs";
import { insertPlain } from "./store.mjs";
import { insertWithLedger } from "./ledger.mjs";
import { COMPARISON_STRATEGIES } from "../server/strategy-comparison.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DB_PATH = resolve(ROOT, "data", "gold-signal.sqlite");
const CONFIRM = process.argv.includes("--confirm-import");
const DRY_RUN = process.argv.includes("--dry-run") || !CONFIRM;

function dateOf(value, fallback = new Date(0)) {
  if (!value) return fallback;
  const parsed = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function legacyRef(table, id) {
  return `${table}:${id}`;
}

function rows(db, sql) {
  return db.prepare(sql).all();
}

function mapRecommendations(sqlite) {
  const pricePoints = rows(sqlite, "SELECT * FROM price_points ORDER BY id");
  const recommendations = rows(sqlite, "SELECT * FROM recommendations ORDER BY id");
  const events = rows(sqlite, "SELECT * FROM recommendation_events ORDER BY id");
  const observations = rows(sqlite, "SELECT * FROM trade_price_observations ORDER BY id");

  const bars = pricePoints.map((row) => ({
    _id: stableObjectId(legacyRef("price_points", row.id)),
    source: "gold-api",
    symbol: row.symbol || "XAU/USD",
    tf: "tick",
    ts_open: dateOf(row.observed_at),
    o: decimal(row.price), h: decimal(row.price), l: decimal(row.price), c: decimal(row.price),
    is_closed: true,
    fetched_at: dateOf(row.observed_at),
    payload_hash: `sha256:${sha256Hex(canonicalJson(row))}`,
    legacy_unverified: true,
    provenance: "sqlite-import",
    legacy_ref: legacyRef("price_points", row.id),
  }));

  const signals = [];
  const statuses = [];
  const outcomes = [];
  const outcomeEvents = [];
  for (const row of recommendations) {
    const ref = legacyRef("recommendations", row.id);
    const initialStop = number(row.initial_stop_loss ?? row.stop_loss);
    const entry = number(row.entry_price);
    const signalId = stableObjectId(ref);
    const generatedAt = dateOf(row.created_at);
    const relatedObservations = observations.filter((observation) => observation.recommendation_id === row.id);
    const observedPrices = relatedObservations.map((observation) => number(observation.price));
    const from = relatedObservations.length > 0
      ? dateOf(relatedObservations[0].observed_at) : generatedAt;
    const to = relatedObservations.length > 0
      ? dateOf(relatedObservations.at(-1).observed_at) : dateOf(row.closed_at, generatedAt);

    signals.push({
      _id: signalId,
      strategy_id: COMPARISON_STRATEGIES.some((strategy) => strategy.id === row.strategy_version)
        ? row.strategy_version : "baseline-sma-5-12",
      strategy_version_id: documentHash({}),
      symbol: "XAU/USD",
      bar_ts: generatedAt,
      direction: String(row.direction).toUpperCase() === "SELL" ? "SELL" : "BUY",
      rule_fired: "LEGACY_SMA_CROSS",
      features: {
        short_average: number(row.short_average),
        long_average: number(row.long_average),
        change_percent: number(row.change_percent),
      },
      entry_ref: decimal(entry),
      stop: decimal(initialStop),
      target: decimal(number(row.take_profit_1 ?? row.take_profit)),
      planned_risk_usd_per_001lot: decimal(Math.abs(entry - initialStop)),
      generated_at: generatedAt,
      legacy_unverified: true,
      provenance: "sqlite-import",
      legacy_ref: ref,
    });

    // Only the generated transition is asserted: the repository has no record
    // of a channel publication, so we must not invent one.
    statuses.push({
      signal_id: signalId,
      ts: generatedAt,
      status: "generated",
      reason_code: "LEGACY_IMPORT",
      legacy_unverified: true,
      provenance: "sqlite-import",
      legacy_ref: ref,
    });

    const exitType = /take_profit/.test(row.close_reason ?? "")
      ? "TARGET" : /stop/.test(row.close_reason ?? "") ? "STOP" : "TIMEOUT";
    const closedAt = dateOf(row.closed_at, generatedAt);
    const gross = number(row.realized_gross_usd);
    const cost = number(row.estimated_cost_usd);
    const net = number(row.realized_net_usd);
    const plannedRisk = Math.abs(entry - initialStop);
    outcomes.push({
      _id: stableObjectId(`${ref}|outcome`),
      signal_id: signalId,
      strategy_id: signals.at(-1).strategy_id,
      evaluator_version: LEGACY_EVALUATOR_VERSION,
      entry_rule_version: LEGACY_VERSION,
      cost_model_version: LEGACY_VERSION,
      entry_time: generatedAt,
      entry_price: decimal(entry),
      exit_time: closedAt,
      exit_price: decimal(number(row.exit_price, entry)),
      exit_type: exitType,
      exit_reason_code: String(row.close_reason ?? "UNKNOWN").toUpperCase(),
      reason_codes: ["LEGACY_IMPORT"],
      ambiguous: true,
      resolved_by: "legacy",
      gross: decimal(gross),
      slippage_cost: decimal(cost),
      commission_cost: decimal(0),
      net: decimal(net),
      r_planned: decimal(plannedRisk),
      r_realized: decimal(plannedRisk > 0 ? net / plannedRisk : 0),
      mfe: decimal(observedPrices.length > 0 ? Math.max(...observedPrices) - entry : 0),
      mae: decimal(observedPrices.length > 0 ? Math.min(...observedPrices) - entry : 0),
      duration_s: Math.max(0, (closedAt - generatedAt) / 1000),
      evaluation_window: { from, to },
      data_range_ref: { source: "gold-api", symbol: "XAU/USD", tf: "tick", from, to },
      legacy_unverified: true,
      provenance: "sqlite-import",
      legacy_ref: ref,
    });

    for (const event of events.filter((item) => item.recommendation_id === row.id)) {
      const type = event.event_type === "target_hit" ? "TOUCH_TARGET"
        : event.event_type === "stop_moved" ? "TRAIL_UPDATE"
          : event.event_type === "stopped_out" ? "EXIT" : "TIMEOUT";
      outcomeEvents.push({
        _id: stableObjectId(`${ref}|event|${event.id}`),
        signal_id: signalId,
        evaluator_version: LEGACY_EVALUATOR_VERSION,
        ts: dateOf(event.occurred_at),
        type,
        price: decimal(number(event.price)),
        reason_code: String(event.event_type).toUpperCase(),
        legacy_unverified: true,
        provenance: "sqlite-import",
        legacy_ref: legacyRef("recommendation_events", event.id),
      });
    }
  }
  return { bars, signals, statuses, outcomes, outcomeEvents };
}

function mapComparisonTrades(sqlite) {
  const trades = rows(sqlite, "SELECT * FROM strategy_comparison_trades ORDER BY id");
  const signals = [];
  const statuses = [];
  const outcomes = [];
  for (const row of trades) {
    const ref = legacyRef("strategy_comparison_trades", row.id);
    const entry = number(row.entry_price);
    const stop = number(row.stop_loss);
    const openedAt = dateOf(row.opened_at);
    const closedAt = dateOf(row.closed_at, openedAt);
    const signalId = stableObjectId(ref);
    const strategyId = COMPARISON_STRATEGIES.some((strategy) => strategy.id === row.strategy_id)
      ? row.strategy_id : "baseline-sma-5-12";
    signals.push({
      _id: signalId,
      strategy_id: strategyId,
      strategy_version_id: documentHash({}),
      symbol: "XAU/USD",
      bar_ts: openedAt,
      direction: String(row.direction).toUpperCase() === "SELL" ? "SELL" : "BUY",
      rule_fired: "LEGACY_COMPARISON",
      features: { sizing_mode_id: row.sizing_mode_id },
      entry_ref: decimal(entry),
      stop: decimal(stop),
      target: decimal(number(row.take_profit_1)),
      planned_risk_usd_per_001lot: decimal(Math.abs(entry - stop)),
      generated_at: openedAt,
      legacy_unverified: true,
      provenance: "sqlite-import",
      legacy_ref: ref,
    });
    statuses.push({
      signal_id: signalId,
      ts: openedAt,
      status: "generated",
      reason_code: "LEGACY_IMPORT",
      legacy_unverified: true,
      provenance: "sqlite-import",
      legacy_ref: ref,
    });
    const gross = number(row.gross_usd);
    const cost = number(row.estimated_cost_usd);
    const net = number(row.net_usd);
    const plannedRisk = Math.abs(entry - stop);
    outcomes.push({
      _id: stableObjectId(`${ref}|outcome`),
      signal_id: signalId,
      strategy_id: strategyId,
      evaluator_version: LEGACY_EVALUATOR_VERSION,
      entry_rule_version: LEGACY_VERSION,
      cost_model_version: LEGACY_VERSION,
      entry_time: openedAt,
      entry_price: decimal(entry),
      exit_time: closedAt,
      exit_price: decimal(number(row.exit_price, entry)),
      exit_type: /take_profit/.test(row.close_reason ?? "")
        ? "TARGET" : /stop/.test(row.close_reason ?? "") ? "STOP" : "TIMEOUT",
      exit_reason_code: String(row.close_reason ?? "UNKNOWN").toUpperCase(),
      reason_codes: ["LEGACY_IMPORT"],
      ambiguous: true,
      resolved_by: "legacy",
      gross: decimal(gross),
      slippage_cost: decimal(cost),
      commission_cost: decimal(0),
      net: decimal(net),
      r_planned: decimal(plannedRisk),
      r_realized: decimal(plannedRisk > 0 ? net / plannedRisk : 0),
      mfe: decimal(0),
      mae: decimal(0),
      duration_s: Math.max(0, (closedAt - openedAt) / 1000),
      evaluation_window: { from: openedAt, to: closedAt },
      data_range_ref: { source: "legacy-sqlite", symbol: "XAU/USD", tf: "tick", from: openedAt, to: closedAt },
      legacy_unverified: true,
      provenance: "sqlite-import",
      legacy_ref: ref,
    });
  }
  return { signals, statuses, outcomes };
}

async function importGroup(db, client, collectionName, documents, ledgerBacked, stats) {
  for (const document of documents) {
    const exists = await db.collection(collectionName).findOne({ _id: document._id }, { projection: { _id: 1 } });
    if (exists) {
      stats.skipped += 1;
      continue;
    }
    if (ledgerBacked) {
      await insertWithLedger(db, collectionName, document, client);
    } else {
      await insertPlain(db, collectionName, document);
    }
    stats.inserted += 1;
  }
}

async function main() {
  if (!existsSync(DB_PATH)) throw new Error("SQLite database not found; nothing was changed.");
  const sqlite = new DatabaseSync(DB_PATH, { readOnly: true });
  const recommendations = mapRecommendations(sqlite);
  const comparisons = mapComparisonTrades(sqlite);
  sqlite.close();

  const legacyStrategyVersions = COMPARISON_STRATEGIES.map((strategy) => ({
    _id: stableObjectId(`strategy:${strategy.id}`),
    strategy_id: strategy.id,
    code_git_hash: LEGACY_VERSION,
    params: {},
    params_hash: documentHash({}),
    created_at: new Date(0),
    legacy_unverified: true,
    provenance: "sqlite-import",
    legacy_ref: `strategy:${strategy.id}`,
  }));

  const groups = [
    ["strategy_versions", legacyStrategyVersions, false],
    ["price_bars", recommendations.bars, false],
    ["signals", [...recommendations.signals, ...comparisons.signals], true],
    ["signal_status_log", [...recommendations.statuses, ...comparisons.statuses], false],
    ["outcomes", [...recommendations.outcomes, ...comparisons.outcomes], true],
    ["outcome_events", recommendations.outcomeEvents, true],
  ];

  if (DRY_RUN) {
    console.log(JSON.stringify({
      dry_run: true,
      counts: Object.fromEntries(groups.map(([name, documents]) => [name, documents.length])),
      note: "No MongoDB writes performed. Pass --confirm-import to import.",
    }, null, 2));
    return;
  }

  await withMongo({}, async (db, client) => {
    const totals = { inserted: 0, skipped: 0 };
    for (const [collectionName, documents, ledgerBacked] of groups) {
      const stats = { inserted: 0, skipped: 0 };
      await importGroup(db, client, collectionName, documents, ledgerBacked, stats);
      totals.inserted += stats.inserted;
      totals.skipped += stats.skipped;
      console.log(`${collectionName} inserted=${stats.inserted} skipped=${stats.skipped}`);
    }
    console.log(JSON.stringify({ dry_run: false, totals }, null, 2));
  });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/mongo/import-legacy.mjs")) {
  main().catch((error) => {
    console.error(`Legacy import failed: ${error.message}`);
    process.exitCode = 1;
  });
}
