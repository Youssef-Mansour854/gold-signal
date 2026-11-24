# MongoDB data layer — design, mapping and open questions

Status: **migrations applied on Atlas; audit layer still disabled by policy**. This document describes
the append-only audit/evaluation layer under `mongo/`. It is separate from the bot's **runtime state**,
which now lives in a single atomic document in `runtime_state` (`server/runtime.mjs`) and is what both
`server/index.mjs` and the Vercel `api/` functions read and write.
Date: 2026-11-24.

## 0. Scope and non-negotiables

This audit layer is **additive**: it does not write to the bot's runtime state and it never rewrites the
legacy collections. A feature flag (`MONGO_DATA_LAYER_ENABLED`) controls any future mirroring of live
writes; it defaults to `false` and no current code path depends on it. The four migrations are applied
on Atlas (15 collections with strict validators, indexes, 6 views, dictionary and baseline seeds).
The managed Atlas tier rejects `createRole`/`dropRole`, so `deployment_gaps/custom_roles_unavailable`
is recorded and `doctor` reports `ok:false` for `custom_roles`; keep the flag `false`.

| Principle | How it is enforced |
|---|---|
| Raw data and published facts are append-only | MongoDB **roles** grant `find` + `insert` only to `app_writer`; no `update`/`remove` privilege. Validators + unique indexes are a second line of defence. |
| Corrections never overwrite | `corrections` documents only; re-evaluations are new `outcomes` with a new `evaluator_version`. |
| One evaluator, one report script | `mongo/evaluator/index.ts` is the only evaluation implementation; `mongo/report.mjs` is the only producer of aggregate numbers. |
| Reason codes and numbers, never prose | Stored fields are enums/codes/numbers. `report.mjs` renders sentences locally from those codes. |
| Everything versioned | `strategy_versions` (git hash + params hash), `evaluator_version`, `entry_rules.version`, `cost_models.version`. Reports always print all four. |
| Everything stored | Every generated signal is inserted before filtering; every rejection/expiry/no-fill gets a `signal_status_log` row. Denominators are honest. |

## 1. Step 0 — what exists today (inventory)

### 1.1 Runtime and languages
- Node 22.13+ (running here: Node 24.19), ES modules (`"type": "module"`).
- **Not a NestJS project.** It is a plain Node HTTP API (`server/index.mjs`) + React/Vite frontend (`src/`).
  The task description says "NestJS/TypeScript project"; that assumption does not match this repository.
  The new layer is therefore implemented as versioned TypeScript/ESM modules under `mongo/`, with no framework
  rewrite and no change to the existing server.
- Test runner: Node built-in `node --test`. Existing suite: `test/strategy.test.mjs`.

### 1.2 Signal generation (`server/strategy.mjs`, `server/strategy-comparison.mjs`)
- One shared core evaluator for SMA 5/12 (`calculateSignal`), plus four comparison strategies selected by
  `getStrategySignal(strategyId, prices)`:
  - `baseline-sma-5-12` — short MA 5 vs long MA 12 + direction of the 12-point window.
  - `sma-10-20` — short MA 10 vs long MA 20.
  - `donchian-20` — breakout of the 20-point high/low.
  - `rsi-14` — Wilder RSI, buy >= 55, sell <= 45.
  - `macd-12-26-9` — SMA-seeded EMA12/EMA26, EMA9 signal line; needs 35 points.
- Signals are computed from the **last N quotes held in memory**, not from closed M1 bars. There is no
  OHLC bar object, no bar-open timestamp, and no `bar_ts` in the current signal.
- The main signal produces at most one open recommendation; new signals are ignored while one is open.
- Comparison strategies run 15 independent simulated accounts (5 strategies × 3 sizing modes).

### 1.3 Price ingestion (`server/index.mjs`)
- `GET https://api.gold-api.com/price/XAU` polled every 30 s (`SAMPLE_INTERVAL_MS`).
- One **mid/last indicative price** per poll; no bid, no ask, no executable quote, no volume.
- Stored in SQLite `price_points(price, currency, symbol, source_updated_at, observed_at)`;
  duplicate `source_updated_at` snapshots are ignored.
- `trade_price_observations` records every quote seen while a recommendation is open and for 30 min after close.
- Gaps > 2 min stop TP/SL management; a stale quote is never used to close a trade. Data gaps are recorded in `trade_data_gaps`.
- In the comparison engine a quote is treated as stale when it repeats the previous price or arrives > 15 min
  later; stale quotes do not open trades and do not expire open trades (`isStaleComparisonQuote`).

### 1.4 Recommendation storage and outcomes (`server/index.mjs`, `server/trade-management.mjs`)
- SQLite `recommendations` holds direction, entry price/time, initial stop, three targets (1R/2R/3R),
  status, exit reason, gross percent, estimated cost per ounce and net percent.
- `recommendation_events` holds TP1/TP2/stop-move/stop/expiry events with observed price and time.
- Stop movement is **step-based**: initial stop -> entry after TP1 -> TP1 after TP2. It is not a trailing stop.
- 120-minute timeout. Partial thirds are realised at TP1/TP2.
- Historic cost estimate: 0.30 spread + 0.10 slippage/side + 0.035 commission/side = **0.57 USD/oz per round trip**,
  stored per recommendation. This is a different unit from the new cost model (per 0.01 lot per trade).
- Current evaluation judges targets **on touch** but a stop **when observed at a poll**, and a jump across
  several levels is recorded at one observed price. This is exactly the inconsistency the new evaluator must remove.

### 1.5 Publishing
- **No Telegram (or any other) publishing exists in the repository.** There is no bot token, no `sendMessage`,
  no channel/webhook code, no `message_id`, and no record of `published_at` or exact message text.
- The UI is the only current "publication" surface. This is a blocking gap for `publications` integrity check 4
  and must be resolved by the owner (see open questions).

### 1.6 Existing MongoDB artefact
- `scripts/migrate-sqlite-to-mongodb.mjs` copies the nine SQLite tables **verbatim** into same-named MongoDB
  collections using `replaceOne`/`upsert` and verifies counts. It is a data-copy tool only:
  no validators, no indexes, no roles, no ledger, and it is not used by the running app.
- `.env` / `.env.example` define `MONGODB_URI` and `MONGODB_DATABASE`. The live app does not read them.
- README explicitly warns that MongoDB is not yet the app's storage.

### 1.7 Config and tests
- Env vars in use: `FRED_API_KEY`, `MONGODB_URI`, `MONGODB_DATABASE`,
  `GOLD_ESTIMATED_SPREAD_USD_PER_OUNCE`, `GOLD_ESTIMATED_SLIPPAGE_USD_PER_OUNCE_PER_SIDE`,
  `GOLD_ESTIMATED_COMMISSION_USD_PER_OUNCE_PER_SIDE`.
- Tests cover signal generation, TP/SL lifecycle, costs, virtual accounts, comparison sizing,
  Wilder RSI, EMA seeding, signal transitions, fixed-sizing clamp and stale-quote handling. There are no
  MongoDB, evaluator, integrity or reporting tests yet.
- The workspace is **not a git repository**, so `code_git_hash` cannot be derived automatically; it must come
  from `GIT_COMMIT` (or an explicit "unknown" sentinel) until git is initialised.

## 2. Deployment capability check (must run before enabling)

MongoDB 6+ **replica set** is required for multi-document transactions. Before any migration is applied to a
deployment, run `mongo/doctor.mjs` and report the result:

| Capability | Why it matters | If missing |
|---|---|---|
| Replica set / transactions | ledger + core doc atomicity | **fail** — no silent degradation |
| `$jsonSchema` validators, `validationLevel: strict`, `validationAction: error` | DB-level enforcement | **fail** |
| `createRole` / `createUser` | append-only enforcement | **fail** |
| Views | per-strategy read-only tables | **fail** (or document explicit gap) |
| Compound unique indexes | bars/signals dedup | **fail** |
| Decimal128 | exact money | **fail** |

AWS DocumentDB gaps are common: incomplete `$jsonSchema` coverage, no `createRole` on some managed tiers,
partial view support, and different transaction semantics. If any check fails, the doctor script prints a
gap report and the migration refuses to continue. It never degrades silently.

No time-series collections: they cannot have compound unique indexes. `price_bars` is a regular collection.

## 3. New structure (additive)

```
docs/data-layer.md                 this document
mongo/
  config.mjs                       env, feature flag, connection, DB name
  doctor.mjs                       capability preflight (no writes)
  canonical.mjs                    deterministic JSON + SHA-256 + Decimal128 helpers
  schema/validators.mjs            $jsonSchema for all 15 collections
  schema/dictionary.mjs            data dictionary entries + CI assertion helper
  migrations/001_core.mjs          collections + validators (up/down)
  migrations/002_indexes_views.mjs indexes + per-strategy views (up/down)
  migrations/003_roles.mjs         roles (up/down)
  migrations/004_dictionary.mjs    data_dictionary seed (up/down)
  migrate.mjs                      versioned, reversible runner (up/down/status)
  ledger.mjs                       transaction insert + verify chain
  store.mjs                        append-only insert API + status derivation view
  evaluator/index.ts               pure TypeScript evaluator (EVALUATOR_VERSION)
  evaluator/types.ts
  integrity.mjs                    10 checks -> integrity_runs
  verify-ledger.mjs                CLI
  report.mjs                       only producer of aggregate numbers
  import-legacy.mjs                one-time legacy SQLite import (flagged)
  seed-fixtures.mjs                golden + deliberately corrupted fixtures
  reporting.mjs                    pure metrics (the only aggregate maths)
test/
  canonical.test.mjs
  schema.test.mjs
  evaluator.test.mjs
  reporting.test.mjs
  mongo-integration.test.mjs       skipped unless TEST_MONGODB_URI is set
```

### Commands (never require the live bot to be stopped)

```bash
npm run mongo:doctor          # read-only capability preflight
npm run mongo:migrate -- status
npm run mongo:migrate -- up   # refuses to run if capabilities have gaps
npm run mongo:migrate -- down 1
npm run mongo:verify-ledger
npm run mongo:report -- --strategy all --since 2026-01-01 --evaluator v1.0.0
npm run mongo:integrity -- --evaluator v1.0.0
npm run mongo:import-legacy            # always a dry run
node mongo/import-legacy.mjs --confirm-import   # explicit opt-in only

# Current Atlas state: all four migrations applied. The managed tier rejects
# createRole/dropRole, so 003 records deployment_gaps/custom_roles_unavailable
# and doctor reports ok:false for custom_roles. Keep the write layer disabled.
npm test                         # 57 pass; 66 when TEST_MONGODB_URI points to a test replica set
npm run build
```

For the integration suite, set `TEST_MONGODB_URI` (and optionally `TEST_MONGODB_DATABASE`) to a
disposable replica set with authorization enabled. The database name must contain `test`; the suite
resets only that database, creates its own `app_writer` user, seeds four signals, corrupts one
outcome, and verifies roles, indexes, validators, ledger tamper detection, the 50-writer hash chain,
transaction atomicity and integrity detection. It never uses `MONGODB_URI`. With authorization
disabled, role enforcement is not exercised, so the role test would be meaningless.

## 4. Mapping from existing structures to the new collections

Legacy rows are imported with `legacy_unverified: true` and `evaluator_version: "legacy-unverified"`.
Every legacy document carries `provenance: "sqlite-import"` and the original SQLite primary key in
`legacy_ref`. Reports exclude `legacy-unverified` unless `--include-legacy` is passed.

| SQLite / current concept | New collection(s) | Notes |
|---|---|---|
| `price_points` | `price_bars` | One quote becomes `tf: "tick"`, `o=h=l=c=price`. `ts_open=observed_at`, `fetched_at=observed_at`, `source="gold-api"`, `payload_hash` from canonical row. `is_closed=true` (the stored quote is final). Marked legacy because it is not an exchange bar. |
| `recommendations` (generated signal) | `signals` | `strategy_version_id` = legacy version; `bar_ts` = signal time (`created_at`); `direction` BUY/SELL; `rule_fired` from the SMA rule; `features` from stored averages when available, otherwise `{}`; `entry_ref` = entry price; `stop`, `target` = initial stop and TP1. `strategy_id` denormalised for views. **All** generated recommendations are stored, including ignored/expired ones. |
| `recommendations` (current status) | `signal_status_log` (view: `signal_current_status`) | One log row per state change derived from status/exit fields. Current status is derived by a view, never stored on the signal. |
| no data | `publications` | Cannot be populated from SQLite. Requires Telegram/channel integration (open question Q1). |
| implicit 30 s delay | `entry_rules` | Default v1: first executable price at/after `published_at + 30 s`, BUY at ask / SELL at bid. Legacy import uses `entry_rules.version: "legacy-unverified"`. |
| `strategy` version constants | `strategy_versions` | One doc per strategy × git hash × params hash. Legacy: `code_git_hash="legacy-unverified"`. |
| cost env vars / stored per-trade cost | `cost_models` | New default v1: spread 0.25, slippage 0.05, commission 0 **per 0.01 lot per trade**. Legacy 0.57 USD/oz is recorded in `legacy_ref`, not converted into v1. |
| `recommendations` + `recommendation_events` | `outcomes`, `outcome_events` | Legacy outcome uses `"legacy-unverified"`, `resolved_by: "tick"`, `ambiguous: true` where a jump crossed multiple levels. Event types mapped: `target_hit -> TOUCH_TARGET`, `stop_moved -> TRAIL_UPDATE`, `stopped_out -> EXIT`, `trade_closed -> TIMEOUT`. |
| `strategy_comparison_trades` | `signals` + `outcomes` | One synthetic legacy signal per comparison trade so the 5 strategies share the same schema. `legacy_unverified: true`, `evaluator_version: "legacy-unverified"`. |
| `user_fills` | not present | No real fills exist in SQLite. Collection is created for future comparison; no rows imported. |
| nothing | `hypotheses`, `integrity_runs`, `corrections`, `ledger`, `data_dictionary` | New. No legacy rows. |

## 5. Evaluator contract (single implementation)

`evaluate(input): { outcome, events }` — pure, deterministic, no DB and no clock access.
`EVALUATOR_VERSION = "v1.0.0"`; changing any rule requires a new version and a new `outcomes` document.

Rules (all enforced by unit tests in `test/evaluator.test.mjs`):
1. Entry is the **first executable price at or after** `published_at + entry_delay_seconds`. BUY uses ask,
   SELL uses bid; when only mid exists, derive `bid = mid - spread/2`, `ask = mid + spread/2`.
2. A limit/zone recommendation is active only when price trades through it; otherwise `NOT_FILLED` is stored.
3. Walk bars **strictly after** `entry_time`. Stop and target are both judged **on touch**, with the same
   executable side: longs use bid, shorts use ask.
4. If one bar touches both levels: use tick/M1 data when supplied and take the first touch. Otherwise
   **stop wins**, `ambiguous = true`, `resolved_by = "assumed_stop"`.
5. Gap rule: a bar opening beyond the stop fills at the open; beyond the target fills at the target.
6. Time stop comes from strategy params. Trailing updates take effect only from the next closed bar.
7. No look-ahead: the signal's `bar_ts` is a closed bar; stored `features` are exactly the ones used.
8. The spread is embedded in bid/ask and is **never charged twice**; slippage and commission are charged once
   per 0.01 lot. `net = gross - slippage_cost - commission_cost`, `r_planned = net / planned_risk_usd_per_001lot`.

Golden dataset: a fixed set of bars with expected `outcome` and `outcome_events`, checked byte-for-byte after
canonicalisation. It is also used by the integrity job's recomputation check.

## 6. Integrity, ledger and roles

- `ledger.seq` uses a counter collection (the only document allowed to be updated). Each core insert and its
  ledger entry commit in **one transaction**. `doc_hash = SHA-256(canonicalJSON(doc))` and
  `hash = SHA-256(canonicalJSON({ doc_hash, prev_hash }))`.
- `verify-ledger` walks `seq` in order, recomputes both the chain hash and each document hash from the live
  document, and stops at the first mismatch. Optional daily external anchor is recorded in `integrity_runs`.
- Ten checks: outcome recomputation, no earlier touch / exit inside bar range, time ordering, publication/status
  presence, count reconciliation, bar duplicates/gaps, aggregate tie-out, ledger chain, data dictionary coverage,
  hypothesis registration order.
- Roles: `app_writer` (find+insert only, plus counter update), `evaluator_writer` (insert outcomes/events/
  integrity/ledger/corrections), `reader` (find only), `admin` (migrations only). Integration tests prove an
  `app_writer` user receives an authorization error on `updateOne` and `deleteOne`.

## 7. Reporting

`node mongo/report.mjs --strategy <id|all> --since <ISO date> --evaluator <version>` reads only MongoDB.
It prints: signals, published, not_filled, trades, win rate (net > 0), exit mix, ambiguous count, net units
(per 0.01 lot only), mean R, sd R, t-test p, bootstrap 95 % CI for mean R (trade-level and day-clustered),
profit factor, max drawdown (units), cost share of gross profit, per-UTC-session breakdown, and a Cairo
(UTC+2) time column. All versions are printed. `LOW_SAMPLE` under 100 trades; `NOT_COMPARABLE` if versions differ.
Totals are never hand-written: every number comes from a DB query or a pure function over queried rows.

## 8. Open questions (need owner decision)

- **Q1 — Publishing.** No Telegram code or message ids exist. Can we add a publishing adapter that records
  `publications` (channel, message_id from the API response, exact text, hash), or should publications remain
  empty until the bot is extended? Integrity check 4 currently cannot pass with real data.
- **Q2 — Bars.** The feed supplies one indicative price every 30 s, no OHLC and no bid/ask. Should `price_bars`
  be tick quotes (`tf: tick`) only, or should we aggregate M1 bars locally? Aggregation changes evaluation semantics.
- **Q3 — Evaluation window / delay.** What is the real alert delay? Default 30 s is a placeholder. The legacy
  `entry = signal candle close` rule is unreachable after an alert; v1 must use executable prices after publication.
- **Q4 — DocumentDB.** Is the target MongoDB replica set or AWS DocumentDB? Capability gaps must be reported,
  not silently worked around.
- **Q5 — Cost units.** The existing 0.57 USD/oz estimate and the requested 0.25/0.05/0 per 0.01 lot model use
  different units and are both assumptions. Confirm the broker contract (0.01 lot = 1 oz?) and which model is authoritative.
- **Q6 — Git hash.** Repository is not under git. Provide `GIT_COMMIT` in deployment, or accept `"unknown"` in
  `strategy_versions`.
- **Q7 — Legacy comparison accounts.** Importing 15 simulated accounts and the main recommendations creates
  many synthetic signals. Confirm they should be imported at all (recommended: yes, but always flagged and excluded).
- **Q8 — Time-stop/trailing parameters.** The 120-minute timeout and step stop are current main-strategy rules;
  per-strategy comparison parameters are currently identical. Confirm they should be stored per strategy version.
- **Q9 — Anchoring.** Is a daily external hash anchor (private channel / write-once object store) available? Optional.

## 9. Delivery order

1. This document.
2. Capability doctor + migration runner + validators + indexes/views/roles + dictionary.
3. Canonical JSON/ledger + append-only store.
4. Pure evaluator + unit tests + golden dataset.
5. Integrity job + legacy importer with flags + seed fixtures.
6. Reporting CLI + integration tests (roles, indexes, validators, tamper, corruption).
7. Final verification: existing `npm test` and `npm run build` still pass; bot untouched.
