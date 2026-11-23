import { ALL_COLLECTIONS, VALIDATORS } from "./validators.mjs";

const DESCRIPTIONS = {
  "price_bars.source": "Price feed identifier.",
  "price_bars.symbol": "Instrument symbol, e.g. XAU/USD.",
  "price_bars.tf": "Bar timeframe; tick bars come from individual provider quotes.",
  "price_bars.ts_open": "UTC instant at which the bar opened; also the signal's closed-bar reference.",
  "price_bars.o": "Open price, USD per troy ounce.",
  "price_bars.h": "High price, USD per troy ounce.",
  "price_bars.l": "Low price, USD per troy ounce.",
  "price_bars.c": "Close price, USD per troy ounce.",
  "price_bars.bid": "Executable bid used by long stops/targets; already includes the spread.",
  "price_bars.ask": "Executable ask used by short stops/targets; already includes the spread.",
  "price_bars.spread": "Ask minus bid, in USD per troy ounce.",
  "price_bars.is_closed": "Only closed bars may be stored as final; always true.",
  "price_bars.fetched_at": "UTC instant when this payload was fetched from the provider.",
  "price_bars.payload_hash": "SHA-256 of the canonical raw provider payload.",

  "strategy_versions.strategy_id": "Stable strategy identifier shared by all versions.",
  "strategy_versions.code_git_hash": "Git commit that produced this strategy implementation.",
  "strategy_versions.params": "Complete strategy parameters; never inherited implicitly.",
  "strategy_versions.params_hash": "SHA-256 of canonical params, part of the unique key.",
  "strategy_versions.created_at": "UTC registration time.",

  "signals.strategy_id": "Denormalised strategy id so per-strategy views have identical schemas.",
  "signals.strategy_version_id": "Reference to strategy_versions.",
  "signals.symbol": "Instrument symbol.",
  "signals.bar_ts": "Timestamp of the CLOSED bar that produced the signal.",
  "signals.direction": "Signal direction, BUY or SELL.",
  "signals.rule_fired": "Machine rule identifier that fired; never free text.",
  "signals.features": "Exact indicator values used by the rule, stored with the signal.",
  "signals.entry_ref": "Reference price for planning the entry, not an assumed fill.",
  "signals.stop": "Planned initial stop price.",
  "signals.target": "Planned first target price.",
  "signals.planned_risk_usd_per_001lot": "Planned risk per 0.01 lot, the denominator for R.",
  "signals.generated_at": "UTC time the signal was generated.",
  "signals.expires_at": "UTC time after which the signal may no longer be published.",
  "signals.order_type": "market, limit or zone; determines the entry trigger.",
  "signals.zone_low": "Lower bound when order_type is zone.",
  "signals.zone_high": "Upper bound when order_type is zone.",

  "signal_status_log.signal_id": "Signal this status transition belongs to.",
  "signal_status_log.ts": "UTC time of the transition.",
  "signal_status_log.status": "New status; the current status is derived by a view.",
  "signal_status_log.reason_code": "Machine reason code, never prose.",

  "publications.signal_id": "Published signal.",
  "publications.channel": "Channel identifier, e.g. telegram-private.",
  "publications.message_id": "Message id returned by the channel API.",
  "publications.sent_at": "UTC time returned by the channel API, not only the local clock.",
  "publications.text_exact": "Exact message text that was sent.",
  "publications.text_hash": "SHA-256 of text_exact.",

  "entry_rules.version": "Entry rule version.",
  "entry_rules.definition.entry_delay_seconds": "Delay after publication before a market entry is executable.",
  "entry_rules.definition.buy_price_field": "Price field used to buy; BUY pays the ask.",
  "entry_rules.definition.sell_price_field": "Price field used to sell; SELL receives the bid.",
  "entry_rules.definition.trigger": "first_executable or trade_through for limit/zone entries.",
  "entry_rules.definition.derivation": "Whether bid/ask come from the feed or from a mid-price cost model.",

  "cost_models.version": "Cost model version.",
  "cost_models.spread_usd": "Spread embedded in bid/ask; never charged a second time.",
  "cost_models.slippage_usd": "One-off slippage charge per 0.01 lot per trade.",
  "cost_models.commission_usd": "One-off commission charge per 0.01 lot per trade.",
  "cost_models.unit": "Unit shared by all three cost fields.",

  "outcomes.signal_id": "Evaluated signal.",
  "outcomes.strategy_id": "Denormalised strategy id; identical schema for strategy views.",
  "outcomes.evaluator_version": "Evaluator that produced this outcome.",
  "outcomes.entry_rule_version": "Entry rule used for this outcome.",
  "outcomes.cost_model_version": "Cost model used for this outcome.",
  "outcomes.entry_time": "UTC time of the simulated entry.",
  "outcomes.entry_price": "Executable entry price, already on the correct bid/ask side.",
  "outcomes.exit_time": "UTC time of the exit.",
  "outcomes.exit_price": "Executable exit price.",
  "outcomes.exit_type": "TARGET, STOP, TIMEOUT or NOT_FILLED.",
  "outcomes.exit_reason_code": "Machine reason for the exit.",
  "outcomes.reason_codes": "All reason codes recorded during evaluation.",
  "outcomes.ambiguous": "True when stop and target were touched in the same bar and unresolved.",
  "outcomes.resolved_by": "Data source used to resolve ambiguity, or assumed_stop.",
  "outcomes.gross": "Gross result in USD per 0.01 lot before slippage and commission.",
  "outcomes.slippage_cost": "Slippage charged once per trade.",
  "outcomes.commission_cost": "Commission charged once per trade.",
  "outcomes.net": "Gross minus slippage and commission; spread is already inside prices.",
  "outcomes.r_planned": "Planned risk denominator used for R.",
  "outcomes.r_realized": "net divided by r_planned.",
  "outcomes.mfe": "Maximum favourable excursion in USD per 0.01 lot.",
  "outcomes.mae": "Maximum adverse excursion in USD per 0.01 lot.",
  "outcomes.duration_s": "Entry-to-exit duration in seconds.",
  "outcomes.evaluation_window.from": "Start of the scanned price range.",
  "outcomes.evaluation_window.to": "End of the scanned price range.",
  "outcomes.data_range_ref.source": "Source of the bars used for evaluation.",
  "outcomes.data_range_ref.symbol": "Symbol of the bars used for evaluation.",
  "outcomes.data_range_ref.tf": "Timeframe of the bars used for evaluation.",
  "outcomes.data_range_ref.from": "First available bar time.",
  "outcomes.data_range_ref.to": "Last available bar time.",

  "outcome_events.signal_id": "Signal this event belongs to.",
  "outcome_events.evaluator_version": "Evaluator that emitted the event.",
  "outcome_events.ts": "UTC event time.",
  "outcome_events.type": "ENTRY, TOUCH_STOP, TOUCH_TARGET, TRAIL_UPDATE, TIMEOUT or EXIT.",
  "outcome_events.price": "Observed executable price at the event.",
  "outcome_events.reason_code": "Machine reason code.",

  "user_fills.signal_id": "Signal linked by id only, never by approximate time or price.",
  "user_fills.fill_time": "UTC fill time reported by the user or broker.",
  "user_fills.fill_price": "Reported fill price.",
  "user_fills.lot": "Filled lot size.",
  "user_fills.source": "Where the fill report came from.",

  "hypotheses.text": "Hypothesis registered before the data used to test it is analysed.",
  "hypotheses.registered_at": "UTC registration time.",
  "hypotheses.strategy_id": "Optional strategy the hypothesis concerns.",
  "hypotheses.status": "Lifecycle status.",
  "hypotheses.analysis_ref": "Reference to the analysis that tested it.",

  "integrity_runs.run_ts": "UTC time the check ran.",
  "integrity_runs.check_name": "Stable check identifier.",
  "integrity_runs.result": "pass or fail.",
  "integrity_runs.details": "Structured counts and codes; no prose.",
  "integrity_runs.evaluator_version": "Evaluator version the check was run against.",
  "integrity_runs.anchored_hash": "Optional external daily anchor.",

  "corrections.collection": "Collection containing the corrected document.",
  "corrections.doc_id": "String form of the document id.",
  "corrections.field": "Field path being corrected.",
  "corrections.old_value": "Previous value, retained for audit.",
  "corrections.new_value": "Intended value, retained for audit.",
  "corrections.reason": "Machine reason code.",
  "corrections.ts": "UTC time of the correction request.",
  "corrections.author": "Actor that requested the correction.",

  "ledger.seq": "Monotonic sequence, unique and gap-checked.",
  "ledger.collection": "Collection of the hashed document.",
  "ledger.doc_id": "String form of the document id.",
  "ledger.doc_hash": "SHA-256 of the canonical document.",
  "ledger.prev_hash": "Hash of the previous ledger entry.",
  "ledger.hash": "SHA-256 of canonical { doc_hash, prev_hash }.",
  "ledger.ts": "UTC time of the ledger write.",

  "data_dictionary.collection": "Collection name.",
  "data_dictionary.field": "Field path, including nested paths.",
  "data_dictionary.type": "BSON type or types.",
  "data_dictionary.unit": "Unit of measurement or n/a.",
  "data_dictionary.definition": "Meaning of the field.",
  "data_dictionary.allowed_values": "Allowed values when the validator restricts them.",
};

const LEGACY_DESCRIPTION = "Legacy provenance marker; never used to include data in new-evaluator reports.";
DESCRIPTIONS["price_bars.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["strategy_versions.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["signals.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["signal_status_log.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["publications.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["entry_rules.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["cost_models.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["outcomes.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["outcome_events.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["user_fills.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["hypotheses.legacy_unverified"] = LEGACY_DESCRIPTION;
DESCRIPTIONS["integrity_runs.legacy_unverified"] = LEGACY_DESCRIPTION;

const LEGACY_PROVENANCE_DESC = "Source of the document: sqlite-import, app, evaluator, seed or migration.";
for (const collection of ALL_COLLECTIONS) {
  DESCRIPTIONS[`${collection}.provenance`] = LEGACY_PROVENANCE_DESC;
  DESCRIPTIONS[`${collection}.legacy_ref`] = "Original SQLite table and primary key for imported documents.";
}

function unitFor(field, type) {
  if (field.endsWith("_at") || field.includes("time") || field.endsWith("_ts")) return "UTC instant";
  if (["from", "to", "ts_open", "entry_time", "exit_time", "fill_time", "run_ts"].includes(field)) return "UTC instant";
  if (/^(o|h|l|c|bid|ask|spread|entry_price|exit_price|entry_ref|stop|target|fill_price|price)$/.test(field)) {
    return "USD per troy ounce";
  }
  if (/_usd$/.test(field)) return "USD per 0.01 lot per trade";
  if (/^r_/.test(field)) return "R multiple";
  if (field === "duration_s" || field === "entry_delay_seconds") return "seconds";
  if (field === "lot") return "lots";
  if (type === "decimal") return "numeric";
  return "n/a";
}

export function validatorFieldPaths() {
  const paths = [];
  for (const collection of ALL_COLLECTIONS) {
    const root = VALIDATORS[collection].$jsonSchema;
    const walk = (properties, prefix) => {
      for (const [field, definition] of Object.entries(properties ?? {})) {
        const path = prefix ? `${prefix}.${field}` : field;
        paths.push({ collection, field: path, definition });
        if (definition?.properties) walk(definition.properties, path);
      }
    };
    walk(root.properties, "");
  }
  return paths;
}

export function dictionaryEntries() {
  return validatorFieldPaths().map(({ collection, field, definition }) => {
    const type = Array.isArray(definition.bsonType)
      ? definition.bsonType.join("|")
      : (definition.bsonType ?? "unknown");
    return {
      collection,
      field,
      type,
      unit: unitFor(field.split(".").at(-1), type),
      definition: DESCRIPTIONS[`${collection}.${field}`]
        ?? `Stored ${field} field of ${collection}.`,
      // The dictionary stores every allowed value as a string; some validator
      // enums are booleans (e.g. is_closed: [true]) and would fail the schema.
      allowed_values: (definition.enum ?? []).map(String),
    };
  });
}

export function assertDictionaryCoverage(entries = dictionaryEntries()) {
  const covered = new Set(entries.map((entry) => `${entry.collection}.${entry.field}`));
  const missing = validatorFieldPaths()
    .map(({ collection, field }) => ({ collection, field }))
    .filter(({ collection, field }) => !covered.has(`${collection}.${field}`));
  const empty = entries.filter((entry) => !entry.definition || !entry.type);
  if (missing.length > 0 || empty.length > 0) {
    throw new Error(`Data dictionary incomplete: ${missing.length} missing, ${empty.length} empty definitions.`);
  }
  return { fields: entries.length, missing: 0, empty: 0 };
}
