import { EVALUATOR_VERSION } from "./config.mjs";
import { decimal } from "./canonical.mjs";
import { insertWithLedger } from "./ledger.mjs";

const OUTCOME_DECIMALS = [
  "entry_price", "exit_price", "gross", "slippage_cost", "commission_cost",
  "net", "r_planned", "r_realized", "mfe", "mae",
];

function decimalizeOutcome(outcome) {
  const stored = { ...outcome };
  for (const field of OUTCOME_DECIMALS) {
    if (stored[field] !== undefined) stored[field] = decimal(stored[field]);
  }
  return stored;
}

export function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

export async function insertPlain(db, collectionName, document, session = null) {
  const result = await db.collection(collectionName).insertOne(document, { session });
  return { ...document, _id: result.insertedId };
}

export async function appendStatus(db, signalId, status, reasonCode, ts, session = null) {
  return insertPlain(db, "signal_status_log", {
    signal_id: signalId,
    ts: toDate(ts),
    status,
    reason_code: reasonCode,
  }, session);
}

/** Every generated signal is stored before any filter is applied. */
export async function insertSignal(db, client, signal, reasonCode = "GENERATED") {
  const session = client.startSession();
  session.startTransaction();
  try {
    const priced = { ...signal };
    for (const field of ["entry_ref", "stop", "target", "zone_low", "zone_high", "planned_risk_usd_per_001lot"]) {
      if (priced[field] !== undefined) priced[field] = decimal(priced[field]);
    }
    const document = {
      ...priced,
      generated_at: toDate(signal.generated_at),
      bar_ts: toDate(signal.bar_ts),
      features: signal.features ?? {},
    };
    const { stored } = await insertWithLedger(db, "signals", document, client, session);
    await appendStatus(db, stored._id, "generated", reasonCode, document.generated_at, session);
    await session.commitTransaction();
    return stored;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function insertPublication(db, client, publication) {
  const session = client.startSession();
  session.startTransaction();
  try {
    const document = {
      ...publication,
      sent_at: toDate(publication.sent_at),
    };
    const { stored } = await insertWithLedger(db, "publications", document, client, session);
    await appendStatus(db, stored.signal_id, "published", "CHANNEL_ACCEPTED", document.sent_at, session);
    await session.commitTransaction();
    return stored;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function insertOutcome(db, client, outcome, events = []) {
  const session = client.startSession();
  session.startTransaction();
  try {
    const document = {
      ...decimalizeOutcome(outcome),
      evaluator_version: outcome.evaluator_version ?? EVALUATOR_VERSION,
      entry_time: toDate(outcome.entry_time),
      exit_time: toDate(outcome.exit_time),
    };
    const { stored } = await insertWithLedger(db, "outcomes", document, client, session);
    for (const event of events) {
      await insertWithLedger(db, "outcome_events", {
        ...event,
        signal_id: stored.signal_id,
        evaluator_version: document.evaluator_version,
        price: decimal(event.price),
        ts: toDate(event.ts),
      }, client, session);
    }
    await session.commitTransaction();
    return stored;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function insertCorrection(db, client, correction) {
  const { stored } = await insertWithLedger(db, "corrections", {
    ...correction,
    ts: toDate(correction.ts ?? new Date()),
  }, client);
  return stored;
}

export async function currentStatus(db, signalId) {
  return db.collection("signal_current_status").findOne({ signal_id: signalId });
}
