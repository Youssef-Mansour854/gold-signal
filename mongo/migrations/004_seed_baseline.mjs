import { CODE_GIT_HASH } from "../config.mjs";
import { decimal, documentHash } from "../canonical.mjs";
import { dictionaryEntries } from "../schema/dictionary.mjs";
import { COMPARISON_STRATEGIES } from "../../server/strategy-comparison.mjs";

export const description = "Seed the data dictionary, default versions and strategy version records.";

const TIME_AND_RISK = {
  stopPercent: 0.5,
  targetsR: [1, 2, 3],
  timeoutMinutes: 120,
  ouncesPerLot: 100,
};

export const STRATEGY_PARAMS = {
  "baseline-sma-5-12": { ...TIME_AND_RISK, requiredSamples: 12, shortWindow: 5, longWindow: 12 },
  "sma-10-20": { ...TIME_AND_RISK, requiredSamples: 20, shortWindow: 10, longWindow: 20 },
  "donchian-20": { ...TIME_AND_RISK, lookback: 20, requiredSamples: 21 },
  "rsi-14": { ...TIME_AND_RISK, period: 14, buyAbove: 55, sellBelow: 45, smoothing: "wilder", requiredSamples: 15 },
  "macd-12-26-9": { ...TIME_AND_RISK, fast: 12, slow: 26, signal: 9, seed: "sma", requiredSamples: 35 },
};

export async function up(db) {
  const now = new Date();

  await db.collection("entry_rules").updateOne(
    { version: "v1" },
    {
      $setOnInsert: {
        version: "v1",
        definition: {
          entry_delay_seconds: 30,
          buy_price_field: "ask",
          sell_price_field: "bid",
          trigger: "first_executable",
          derivation: "cost_model_mid",
        },
        provenance: "migration",
      },
    },
    { upsert: true },
  );

  await db.collection("cost_models").updateOne(
    { version: "v1" },
    {
      $setOnInsert: {
        version: "v1",
        spread_usd: decimal("0.25"),
        slippage_usd: decimal("0.05"),
        commission_usd: decimal("0"),
        unit: "per_0.01_lot_per_trade",
        provenance: "migration",
      },
    },
    { upsert: true },
  );

  for (const strategy of COMPARISON_STRATEGIES) {
    const params = STRATEGY_PARAMS[strategy.id];
    if (!params) throw new Error(`No stored params for ${strategy.id}.`);
    const paramsHash = documentHash(params);
    await db.collection("strategy_versions").updateOne(
      { strategy_id: strategy.id, code_git_hash: CODE_GIT_HASH, params_hash: paramsHash },
      {
        $setOnInsert: {
          strategy_id: strategy.id,
          code_git_hash: CODE_GIT_HASH,
          params,
          params_hash: paramsHash,
          created_at: now,
          provenance: "migration",
        },
      },
      { upsert: true },
    );
  }

  for (const entry of dictionaryEntries()) {
    await db.collection("data_dictionary").updateOne(
      { collection: entry.collection, field: entry.field },
      { $setOnInsert: { ...entry, provenance: "migration" } },
      { upsert: true },
    );
  }
}

export async function down(db) {
  await db.collection("data_dictionary").deleteMany({ provenance: "migration" });
  await db.collection("entry_rules").deleteMany({ provenance: "migration" });
  await db.collection("cost_models").deleteMany({ provenance: "migration" });
  await db.collection("strategy_versions").deleteMany({ provenance: "migration" });
}
