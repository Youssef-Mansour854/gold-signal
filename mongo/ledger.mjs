import { ObjectId } from "mongodb";
import { GENESIS_HASH } from "./config.mjs";
import { chainHash, documentHash, hashForDocument } from "./canonical.mjs";
import { LEDGER_COLLECTIONS } from "./schema/validators.mjs";

export async function nextLedgerSeq(db, session) {
  const result = await db.collection("ledger_seq").findOneAndUpdate(
    { _id: "ledger" },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: "after", session },
  );
  return Number(result.value);
}

function idFromString(value) {
  return /^[0-9a-fA-F]{24}$/.test(value) ? new ObjectId(value) : value;
}

const MAX_TRANSACTION_ATTEMPTS = 80;

function isTransientTransactionError(error) {
  return Boolean(
    error?.hasErrorLabel?.("TransientTransactionError")
    || error?.errorLabels?.includes?.("TransientTransactionError")
    || error?.code === 112
    || error?.codeName === "WriteConflict",
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function insertAttempt(db, collectionName, document, client, session) {
  const ownsSession = !session;
  const active = session ?? client.startSession();
  if (ownsSession) active.startTransaction();
  try {
    const result = await db.collection(collectionName).insertOne(document, { session: active });
    const stored = { ...document, _id: result.insertedId };
    // Reserve the sequence number before reading the chain tip. A write
    // conflict on the counter forces a fresh transaction, so the tip we read
    // afterwards is guaranteed to be seq-1 once this transaction commits.
    const seq = await nextLedgerSeq(db, active);
    const previous = await db.collection("ledger")
      .find({}, { session: active })
      .sort({ seq: -1 })
      .limit(1)
      .next();
    const prevHash = previous?.hash ?? GENESIS_HASH;
    const { doc_hash: docHash, hash } = hashForDocument(stored, prevHash);
    const entry = {
      seq,
      collection: collectionName,
      doc_id: String(result.insertedId),
      doc_hash: docHash,
      prev_hash: prevHash,
      hash,
      ts: new Date(),
    };
    await db.collection("ledger").insertOne(entry, { session: active });
    if (ownsSession) await active.commitTransaction();
    return { stored, entry };
  } catch (error) {
    // When the caller owns the session it decides whether to abort; this
    // function must not double-abort a shared transaction.
    if (ownsSession) {
      try {
        await active.abortTransaction();
      } catch { /* transaction was already terminated */ }
    }
    throw error;
  } finally {
    if (ownsSession) await active.endSession();
  }
}

/**
 * Inserts a core document and its hash-chain entry in one transaction.
 * A caller-supplied session is reused so several inserts can be atomic together.
 * Standalone attempts retry write conflicts so 50 concurrent writers still
 * produce a gap-free sequence and an unbroken hash chain.
 */
export async function insertWithLedger(db, collectionName, document, client, session = null, attempt = 0) {
  if (!LEDGER_COLLECTIONS.includes(collectionName)) {
    throw new Error(`${collectionName} is not a ledger-backed collection.`);
  }
  if (session) return insertAttempt(db, collectionName, document, client, session);
  try {
    return await insertAttempt(db, collectionName, document, client, null);
  } catch (error) {
    if (attempt < MAX_TRANSACTION_ATTEMPTS && isTransientTransactionError(error)) {
      // Jittered backoff avoids 50 writers retrying in lockstep.
      const backoff = Math.min(100, 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 15);
      await sleep(backoff);
      return insertWithLedger(db, collectionName, document, client, null, attempt + 1);
    }
    throw error;
  }
}

export async function verifyLedger(db) {
  const entries = await db.collection("ledger").find({}).sort({ seq: 1 }).toArray();
  let previousHash = GENESIS_HASH;
  let previousSeq = 0;
  for (const entry of entries) {
    if (entry.seq !== previousSeq + 1) {
      return { ok: false, firstMismatch: entry.seq, reason: "sequence_gap", detail: {
        expected: previousSeq + 1, actual: entry.seq,
      }, checked: previousSeq };
    }
    if (entry.prev_hash !== previousHash) {
      return { ok: false, firstMismatch: entry.seq, reason: "prev_hash_mismatch", detail: {
        expected: previousHash, actual: entry.prev_hash,
      }, checked: previousSeq };
    }
    const expectedHash = chainHash(entry.doc_hash, entry.prev_hash);
    if (entry.hash !== expectedHash) {
      return { ok: false, firstMismatch: entry.seq, reason: "chain_hash_mismatch", detail: {
        expected: expectedHash, actual: entry.hash,
      }, checked: previousSeq };
    }
    const document = await db.collection(entry.collection)
      .findOne({ _id: idFromString(entry.doc_id) });
    if (!document) {
      return { ok: false, firstMismatch: entry.seq, reason: "document_missing", detail: {
        collection: entry.collection, doc_id: entry.doc_id,
      }, checked: previousSeq };
    }
    const expectedDocHash = documentHash(document);
    if (expectedDocHash !== entry.doc_hash) {
      return { ok: false, firstMismatch: entry.seq, reason: "document_tampered", detail: {
        collection: entry.collection,
        doc_id: entry.doc_id,
        expected: expectedDocHash,
        actual: entry.doc_hash,
      }, checked: previousSeq };
    }
    previousHash = entry.hash;
    previousSeq = entry.seq;
  }
  // A deleted tail entry would otherwise look like a valid shorter chain.
  // The counter is incremented in the same transaction as the ledger row, so
  // it is the authoritative expected length.
  const counter = await db.collection("ledger_seq").findOne({ _id: "ledger" });
  const expectedCount = counter ? Number(counter.value) : 0;
  if (expectedCount !== entries.length) {
    const tailMissing = expectedCount > entries.length;
    return {
      ok: false,
      firstMismatch: tailMissing ? entries.length + 1 : expectedCount + 1,
      reason: tailMissing ? "ledger_tail_missing" : "ledger_seq_mismatch",
      detail: { expected_seq: expectedCount, actual_entries: entries.length },
      checked: previousSeq,
    };
  }
  return { ok: true, checked: entries.length, lastHash: previousHash };
}
