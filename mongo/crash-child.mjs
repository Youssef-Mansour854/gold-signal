import { MongoClient, ObjectId } from "mongodb";

/**
 * Deliberately dies after inserting a ledger-backed document inside an
 * uncommitted transaction. Used by the integration suite to prove that a
 * killed process can never leave a document without its ledger entry.
 * This file is a child-process fixture, not a test file.
 */
async function main() {
  const uri = process.env.TEST_MONGODB_URI;
  const database = process.env.TEST_MONGODB_DATABASE;
  const id = process.env.CRASH_OBJECT_ID;
  if (!uri || !database || !/^[0-9a-fA-F]{24}$/.test(id ?? "")) {
    throw new Error("crash-child requires TEST_MONGODB_URI, TEST_MONGODB_DATABASE and CRASH_OBJECT_ID.");
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
  try {
    await client.connect();
    const session = client.startSession();
    session.startTransaction();
    await client.db(database).collection("corrections").insertOne({
      _id: new ObjectId(id),
      collection: "signals",
      doc_id: id,
      field: "rule_fired",
      old_value: "ORIGINAL",
      new_value: "CRASHED_BEFORE_COMMIT",
      reason: "CRASH_TEST",
      ts: new Date(),
      author: "crash-child",
    }, { session });
    // No commit, no abort, no ledger insert: terminate the process here.
    try {
      process.kill(process.pid, "SIGKILL");
    } catch {
      process.exit(99);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`crash-child failed: ${error.message}`);
  process.exit(1);
});
