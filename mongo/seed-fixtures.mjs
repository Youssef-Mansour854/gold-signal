import { withMongo, getMongoConfig, EVALUATOR_VERSION, ENTRY_RULE_VERSION, COST_MODEL_VERSION } from "./config.mjs";
import { decimal, documentHash, sha256Hex, canonicalJson } from "./canonical.mjs";
import { evaluate } from "./evaluator/index.ts";
import { insertPlain, insertSignal, insertOutcome, appendStatus } from "./store.mjs";
import { migrateUp } from "./migrate.mjs";

const STRATEGY_ID = "baseline-sma-5-12";
const PARAMS = { timeoutMinutes: 120, targetsR: [1, 2, 3], stopPercent: 0.5 };
const RESET = process.argv.includes("--reset");

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

const RESET_COLLECTIONS = [
  "price_bars", "signals", "signal_status_log", "publications", "outcomes",
  "outcome_events", "integrity_runs", "ledger", "hypotheses", "corrections",
];

/** Only ever call this on a disposable database whose name contains "test". */
export async function resetTestData(db) {
  for (const name of RESET_COLLECTIONS) {
    await db.collection(name).deleteMany({});
  }
  await db.collection("ledger_seq").updateOne(
    { _id: "ledger" },
    { $set: { value: 0 } },
    { upsert: true },
  );
}

/**
 * Seeds a deterministic dataset in TEST_MONGODB_DATABASE only.
 * One outcome is deliberately corrupted so the integrity job must fail.
 */
export async function seedTestData(db, client, { corrupt = true } = {}) {
  const now = new Date("2026-02-01T00:00:00.000Z");
  const paramsHash = documentHash(PARAMS);
  const existingVersion = await db.collection("strategy_versions").findOne({
    strategy_id: STRATEGY_ID, params_hash: paramsHash,
  });
  if (!existingVersion) {
    await insertPlain(db, "strategy_versions", {
      strategy_id: STRATEGY_ID,
      code_git_hash: "seed-hash",
      params: PARAMS,
      params_hash: paramsHash,
      created_at: new Date("2025-01-01T00:00:00.000Z"),
      provenance: "seed",
    });
  }

  const hypothesis = await insertPlain(db, "hypotheses", {
    text: "Seeded hypothesis for integration tests",
    registered_at: new Date("2025-01-01T00:00:00.000Z"),
    strategy_id: STRATEGY_ID,
    status: "registered",
    provenance: "seed",
  });

  const entryRule = {
    version: ENTRY_RULE_VERSION,
    definition: {
      entry_delay_seconds: 30,
      buy_price_field: "ask",
      sell_price_field: "bid",
      trigger: "first_executable",
      derivation: "cost_model_mid",
    },
  };
  const costModel = { version: COST_MODEL_VERSION, spread_usd: 0.25, slippage_usd: 0.05, commission_usd: 0 };
  const signalIds = [];
  const corruptedSignals = [];

  for (let index = 0; index < 4; index += 1) {
    const publishedAt = addMinutes(new Date("2026-01-01T01:00:00.000Z"), index * 10);
    const entryTs = addSeconds(publishedAt, 30);
    const exitTs = addSeconds(entryTs, 60);
    const bars = [
      { ts_open: entryTs, o: 100, h: 100.25, l: 100, c: 100.1 },
      { ts_open: exitTs, o: 100.25, h: 100.75, l: 100.25, c: 100.5 },
    ];
    for (const [barIndex, bar] of bars.entries()) {
      await insertPlain(db, "price_bars", {
        source: "seed",
        symbol: "XAU/USD",
        tf: "tick",
        ts_open: bar.ts_open,
        o: decimal(bar.o), h: decimal(bar.h), l: decimal(bar.l), c: decimal(bar.c),
        is_closed: true,
        fetched_at: bar.ts_open,
        payload_hash: `sha256:${sha256Hex(canonicalJson({ index, barIndex, bar }))}`,
        provenance: "seed",
      });
    }

    const signal = await insertSignal(db, client, {
      strategy_id: STRATEGY_ID,
      strategy_version_id: paramsHash,
      symbol: "XAU/USD",
      bar_ts: publishedAt,
      direction: "BUY",
      rule_fired: "SEED_RULE",
      features: { short_average: 100, long_average: 99.8, change_percent: 0.2 },
      entry_ref: 100,
      stop: 99.5,
      target: 100.5,
      planned_risk_usd_per_001lot: 0.5,
      generated_at: publishedAt,
      provenance: "seed",
    });

    await insertPlain(db, "publications", {
      signal_id: signal._id,
      channel: "seed-channel",
      message_id: `seed-message-${index}`,
      sent_at: publishedAt,
      text_exact: `SEED ${index}`,
      text_hash: `sha256:${sha256Hex(`SEED ${index}`)}`,
      provenance: "seed",
    });
    await appendStatus(db, signal._id, "published", "CHANNEL_ACCEPTED", publishedAt);

    const { outcome } = evaluate({
      signal: {
        strategy_id: STRATEGY_ID,
        direction: "BUY",
        bar_ts: publishedAt,
        published_at: publishedAt,
        entry_ref: 100,
        stop: 99.5,
        target: 100.5,
        planned_risk_usd_per_001lot: 0.5,
      },
      bars: bars.map((bar) => ({ ...bar, tf: "tick" })),
      entryRule,
      costModel,
      strategyParams: PARAMS,
      evaluatorVersion: EVALUATOR_VERSION,
      source: "seed",
      symbol: "XAU/USD",
      tf: "tick",
    });

    const isCorrupt = corrupt && index === 3;
    const stored = await insertOutcome(db, client, {
      ...outcome,
      signal_id: signal._id,
      strategy_id: STRATEGY_ID,
      net: isCorrupt ? 999 : outcome.net,
      r_realized: isCorrupt ? 999 : outcome.r_realized,
      provenance: "seed",
    });
    if (isCorrupt) corruptedSignals.push(String(stored.signal_id));
    signalIds.push(String(signal._id));
  }

  return {
    seeded_at: now.toISOString(),
    hypothesis_id: String(hypothesis._id),
    signal_ids: signalIds,
    tamper_signal_id: signalIds[0],
    corrupted_signal_ids: corruptedSignals,
    expected_outcomes: 4,
  };
}

async function main() {
  const config = getMongoConfig({ test: true });
  if (!/test/i.test(config.database)) {
    throw new Error("Refusing to seed: TEST_MONGODB_DATABASE must look like a test database.");
  }
  await withMongo({ test: true }, async (db, client) => {
    await migrateUp(db, client);
    if (RESET) await resetTestData(db);
    const seeded = await seedTestData(db, client);
    console.log(JSON.stringify(seeded, null, 2));
  });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/mongo/seed-fixtures.mjs")) {
  main().catch((error) => {
    console.error(`Seed failed: ${error.message}`);
    process.exitCode = 1;
  });
}
