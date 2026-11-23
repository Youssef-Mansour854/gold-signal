import { COMPARISON_STRATEGIES } from "../../server/strategy-comparison.mjs";

export const description = "Create compound unique indexes and per-strategy read-only views.";

// [collection, [[keys, unique], ...]]
const INDEXES = [
  ["price_bars", [
    [{ source: 1, symbol: 1, tf: 1, ts_open: 1 }, true],
    [{ source: 1, symbol: 1, fetched_at: 1 }, false],
  ]],
  ["strategy_versions", [[{ strategy_id: 1, code_git_hash: 1, params_hash: 1 }, true]]],
  ["signals", [
    [{ strategy_version_id: 1, symbol: 1, bar_ts: 1, rule_fired: 1 }, true],
    [{ strategy_id: 1, generated_at: -1 }, false],
  ]],
  ["signal_status_log", [[{ signal_id: 1, ts: -1 }, false]]],
  ["publications", [[{ signal_id: 1, channel: 1 }, true]]],
  ["outcomes", [
    [{ signal_id: 1, evaluator_version: 1, entry_rule_version: 1, cost_model_version: 1 }, true],
    [{ strategy_id: 1, entry_time: -1 }, false],
    [{ evaluator_version: 1, strategy_id: 1 }, false],
  ]],
  ["outcome_events", [[{ signal_id: 1, evaluator_version: 1, ts: 1 }, false]]],
  ["user_fills", [[{ signal_id: 1 }, false]]],
  ["integrity_runs", [[{ check_name: 1, run_ts: -1 }, false]]],
  ["corrections", [[{ collection: 1, doc_id: 1, ts: -1 }, false]]],
  ["ledger", [[{ seq: 1 }, true]]],
  ["data_dictionary", [[{ collection: 1, field: 1 }, true]]],
];

function viewNames() {
  return [
    "signal_current_status",
    ...COMPARISON_STRATEGIES.map((strategy) => `outcomes__${strategy.id}`),
  ];
}

async function dropViews(db) {
  for (const name of viewNames()) {
    const info = (await db.listCollections({ name }, { nameOnly: true }).toArray())[0];
    if (info?.type === "view") await db.collection(name).drop();
  }
}

export async function up(db) {
  for (const [collection, specs] of INDEXES) {
    for (const [keys, unique] of specs) {
      const name = `${unique ? "ux" : "ix"}_${Object.keys(keys).join("_")}`;
      await db.collection(collection).createIndex(keys, { unique, name });
    }
  }

  await dropViews(db);
  // Driver v6 creates views through createCollection with viewOn/pipeline;
  // Db.createView was removed.
  await db.createCollection("signal_current_status", {
    viewOn: "signal_status_log",
    pipeline: [
      { $sort: { ts: -1 } },
      { $group: {
        _id: "$signal_id",
        status: { $first: "$status" },
        ts: { $first: "$ts" },
        reason_code: { $first: "$reason_code" },
      } },
      { $project: { _id: 0, signal_id: "$_id", status: 1, ts: 1, reason_code: 1 } },
    ],
  });

  for (const strategy of COMPARISON_STRATEGIES) {
    await db.createCollection(`outcomes__${strategy.id}`, {
      viewOn: "outcomes",
      pipeline: [{ $match: { strategy_id: strategy.id } }],
    });
  }
}

export async function down(db) {
  await dropViews(db);
  for (const [collection] of INDEXES) {
    const names = (await db.collection(collection).indexes())
      .map((index) => index.name)
      .filter((name) => /^(ux|ix)_/.test(name));
    for (const name of names) await db.collection(collection).dropIndex(name);
  }
}
