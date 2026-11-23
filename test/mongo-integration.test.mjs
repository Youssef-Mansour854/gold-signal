import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MongoClient, ObjectId } from "mongodb";
import { getMongoConfig, hasMongoConfig } from "../mongo/config.mjs";
import { decimal } from "../mongo/canonical.mjs";
import { migrateUp } from "../mongo/migrate.mjs";
import { resetTestData, seedTestData } from "../mongo/seed-fixtures.mjs";
import { insertWithLedger, verifyLedger } from "../mongo/ledger.mjs";
import { runIntegrityChecks } from "../mongo/integrity.mjs";
import { ALL_COLLECTIONS } from "../mongo/schema/validators.mjs";

// Skipped by default: these tests write only to TEST_MONGODB_DATABASE on a
// disposable MongoDB replica set. They never touch MONGODB_URI or SQLite.
const enabled = hasMongoConfig({ test: true });
const CRASH_CHILD = fileURLToPath(new URL("../mongo/crash-child.mjs", import.meta.url));

async function counterValue(db) {
  const doc = await db.collection("ledger_seq").findOne({ _id: "ledger" });
  return Number(doc?.value ?? 0);
}

function runCrashChild(objectIdHex) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CRASH_CHILD], {
      env: { ...process.env, CRASH_OBJECT_ID: objectIdHex },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`crash child timed out: ${stderr}`));
    }, 30_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

describe("MongoDB tamper and acceptance integration", { skip: enabled ? false : "TEST_MONGODB_URI is not configured" }, () => {
  let client;
  let db;
  let config;
  let seed;

  before(async () => {
    config = getMongoConfig({ test: true });
    if (!/test/i.test(config.database)) throw new Error("TEST_MONGODB_DATABASE must be a test database.");
    client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 15_000 });
    await client.connect();
    db = client.db(config.database);
    await migrateUp(db, client);
    await resetTestData(db);
    seed = await seedTestData(db, client);
  });

  after(async () => {
    await client?.close();
  });

  test("all migrations apply and the seed dataset is present", async () => {
    assert.equal(seed.expected_outcomes, 4);
    assert.equal(seed.signal_ids.length, 4);
    assert.equal(await db.collection("outcomes").countDocuments(), 4);
    assert.ok((await counterValue(db)) > 0);
  });

  test("app_writer update and delete attempts fail on every core collection", async () => {
    const username = process.env.TEST_MONGO_USER ?? "integration_app_writer";
    const password = process.env.TEST_MONGO_PASS ?? "integration-only-password";
    try {
      await db.command({ dropUser: username });
    } catch { /* user did not exist */ }
    await db.command({
      createUser: username,
      pwd: password,
      roles: [{ role: "app_writer", db: config.database }],
    });

    const uri = new URL(config.uri);
    uri.username = encodeURIComponent(username);
    uri.password = encodeURIComponent(password);
    uri.searchParams.set("authSource", config.database);
    const restricted = new MongoClient(uri.toString(), { serverSelectionTimeoutMS: 15_000 });
    try {
      await restricted.connect();
      const restrictedDb = restricted.db(config.database);
      for (const collection of ALL_COLLECTIONS) {
        await assert.rejects(
          restrictedDb.collection(collection).updateOne({}, { $set: { hacked: true } }),
          (error) => error.code === 13,
          `app_writer updated ${collection}`,
        );
        await assert.rejects(
          restrictedDb.collection(collection).deleteOne({}),
          (error) => error.code === 13,
          `app_writer deleted from ${collection}`,
        );
      }
      await assert.rejects(
        restrictedDb.collection("outcomes").insertOne({}),
        (error) => error.code === 13,
      );
    } finally {
      await restricted.close();
    }
  });

  test("invalid documents and duplicate signals or bars are rejected", async () => {
    const bar = await db.collection("price_bars").findOne({});
    const duplicate = { ...bar };
    delete duplicate._id;
    duplicate.payload_hash = `sha256:${"a".repeat(64)}`;
    await assert.rejects(db.collection("price_bars").insertOne(duplicate), (error) => error.code === 11000);

    const signal = await db.collection("signals").findOne({});
    const duplicateSignal = { ...signal };
    delete duplicateSignal._id;
    await assert.rejects(db.collection("signals").insertOne(duplicateSignal), (error) => error.code === 11000);

    await assert.rejects(db.collection("signals").insertOne({ strategy_id: "incomplete" }));
    await assert.rejects(db.collection("signals").insertOne({ ...duplicateSignal, direction: "HOLD" }));
    await assert.rejects(db.collection("outcomes").insertOne({ exit_type: "MAYBE" }));
    await assert.rejects(db.collection("price_bars").insertOne({ is_closed: false }));
  });

  test("admin tampering with a stored document is the first ledger mismatch", async () => {
    const signalFilter = { _id: new ObjectId(seed.tamper_signal_id) };
    const signalBefore = await db.collection("signals").findOne(signalFilter);
    const signalEntry = await db.collection("ledger").findOne({ doc_id: seed.tamper_signal_id });
    try {
      await db.collection("signals").updateOne(signalFilter, { $set: { features: { short_average: 12345 } } });
      const result = await verifyLedger(db);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "document_tampered");
      assert.equal(result.firstMismatch, signalEntry.seq);
      assert.equal(result.detail.collection, "signals");
    } finally {
      await db.collection("signals").updateOne(signalFilter, { $set: { features: signalBefore.features } });
    }
    assert.equal((await verifyLedger(db)).ok, true);

    const outcomeBefore = await db.collection("outcomes").findOne({});
    const outcomeFilter = { _id: outcomeBefore._id };
    const outcomeEntry = await db.collection("ledger").findOne({ doc_id: String(outcomeBefore._id) });
    try {
      await db.collection("outcomes").updateOne(outcomeFilter, { $set: { net: decimal("777") } });
      const result = await verifyLedger(db);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "document_tampered");
      assert.equal(result.firstMismatch, outcomeEntry.seq);
      assert.equal(result.detail.collection, "outcomes");
    } finally {
      await db.collection("outcomes").updateOne(outcomeFilter, { $set: { net: outcomeBefore.net } });
    }
    assert.equal((await verifyLedger(db)).ok, true);
  });

  test("deleting a ledger row identifies the first broken link, including the tail", async () => {
    const entries = await db.collection("ledger").find({}).sort({ seq: 1 }).toArray();
    const middle = entries[Math.floor(entries.length / 2)];
    await db.collection("ledger").deleteOne({ _id: middle._id });
    try {
      const result = await verifyLedger(db);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "sequence_gap");
      assert.equal(result.firstMismatch, middle.seq + 1);
      assert.equal(result.detail.expected, middle.seq);
    } finally {
      await db.collection("ledger").insertOne(middle);
    }
    assert.equal((await verifyLedger(db)).ok, true);

    const beforeTail = await db.collection("ledger").find({}).sort({ seq: -1 }).limit(1).next();
    await db.collection("ledger").deleteOne({ _id: beforeTail._id });
    try {
      const result = await verifyLedger(db);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "ledger_tail_missing");
      assert.equal(result.firstMismatch, beforeTail.seq);
      assert.equal(result.detail.expected_seq, beforeTail.seq);
    } finally {
      await db.collection("ledger").insertOne(beforeTail);
    }
    assert.equal((await verifyLedger(db)).ok, true);
  });

  test("50 parallel inserts keep a contiguous sequence and an intact hash chain", async () => {
    const beforeCount = await db.collection("ledger").countDocuments();
    const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const documents = Array.from({ length: 50 }, (_, index) => ({
      collection: "signals",
      doc_id: `parallel-${runId}-${index}`,
      field: "rule_fired",
      old_value: "ORIGINAL",
      new_value: "PARALLEL_TEST",
      reason: "PARALLEL_LEDGER_TEST",
      ts: new Date(),
      author: "integration",
    }));
    const results = await Promise.all(
      documents.map((document) => insertWithLedger(db, "corrections", document, client)),
    );
    const seqs = results.map((result) => result.entry.seq).sort((a, b) => a - b);
    assert.equal(new Set(seqs).size, 50);
    for (let index = 1; index < seqs.length; index += 1) {
      assert.equal(seqs[index], seqs[index - 1] + 1);
    }

    const all = await db.collection("ledger").find({}).sort({ seq: 1 }).toArray();
    assert.equal(all.length, beforeCount + 50);
    for (let index = 0; index < all.length; index += 1) {
      assert.equal(all[index].seq, index + 1);
    }
    assert.equal(await counterValue(db), all.length);
    assert.equal((await verifyLedger(db)).ok, true);
  });

  test("killing a process mid-transaction leaves no document without a ledger row", async () => {
    const crashOid = new ObjectId();
    const beforeCounter = await counterValue(db);
    const beforeLedgerCount = await db.collection("ledger").countDocuments();
    const exited = await runCrashChild(crashOid.toHexString());
    assert.ok(exited.signal === "SIGKILL" || exited.code !== 0,
      `crash child should not exit cleanly: ${JSON.stringify(exited)}`);

    assert.equal(await db.collection("corrections").countDocuments({ _id: crashOid }), 0);
    assert.equal(await db.collection("ledger").countDocuments({ doc_id: crashOid.toHexString() }), 0);
    assert.equal(await counterValue(db), beforeCounter);
    assert.equal(await db.collection("ledger").countDocuments(), beforeLedgerCount);
    assert.equal((await verifyLedger(db)).ok, true);
  });

  test("integrity job detects and stores the deliberately corrupted outcome", async () => {
    const report = await runIntegrityChecks(db, { persist: true });
    assert.equal(report.ok, false);
    assert.ok(report.failed.includes("outcome_recompute"));
    const recompute = report.checks.find((check) => check.check_name === "outcome_recompute");
    assert.ok(recompute.details.mismatches.some((mismatch) => seed.corrupted_signal_ids.includes(mismatch.signal_id)));
    const storedFailures = await db.collection("integrity_runs").find({
      check_name: "outcome_recompute", result: "fail",
    }).toArray();
    assert.ok(storedFailures.length > 0);
  });

  test("per-strategy views exist for all five strategies", async () => {
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name);
    for (const strategy of ["baseline-sma-5-12", "sma-10-20", "donchian-20", "rsi-14", "macd-12-26-9"]) {
      assert.ok(names.includes(`outcomes__${strategy}`));
    }
    assert.ok(names.includes("signal_current_status"));
  });
});
