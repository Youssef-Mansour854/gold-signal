import test from "node:test";
import assert from "node:assert/strict";
import { ALL_COLLECTIONS, VALIDATORS, LEDGER_COLLECTIONS } from "../mongo/schema/validators.mjs";
import {
  dictionaryEntries, validatorFieldPaths, assertDictionaryCoverage,
} from "../mongo/schema/dictionary.mjs";

/** Minimal simulation of the top-level $jsonSchema checks, used for unit tests. */
function rejects(collection, document) {
  const schema = VALIDATORS[collection].$jsonSchema;
  for (const field of schema.required) {
    if (!(field in document)) return true;
  }
  for (const [field, value] of Object.entries(document)) {
    const rule = schema.properties[field];
    if (!rule) return schema.additionalProperties === false;
    const allowed = Array.isArray(rule.bsonType) ? rule.bsonType : [rule.bsonType];
    const type = value === null ? "null" : value instanceof Date ? "date" : typeof value;
    if (!allowed.includes(type)) return true;
    if (rule.enum && !rule.enum.includes(value)) return true;
  }
  return false;
}

test("all 15 required collections have strict validators", () => {
  assert.equal(ALL_COLLECTIONS.length, 15);
  for (const collection of ALL_COLLECTIONS) {
    const validator = VALIDATORS[collection].$jsonSchema;
    assert.ok(validator.required.length > 0, `${collection} has no required fields`);
    assert.equal(validator.additionalProperties, false, `${collection} allows unknown fields`);
    assert.ok(validator.properties._id, `${collection} does not declare _id`);
  }
});

test("required collections include every ledger-backed collection", () => {
  for (const collection of LEDGER_COLLECTIONS) {
    assert.ok(ALL_COLLECTIONS.includes(collection));
  }
  for (const name of ["price_bars", "strategy_versions", "signals", "signal_status_log", "publications",
    "entry_rules", "cost_models", "outcomes", "outcome_events", "user_fills", "hypotheses",
    "integrity_runs", "corrections", "ledger", "data_dictionary"]) {
    assert.ok(ALL_COLLECTIONS.includes(name), `${name} missing`);
  }
});

test("critical fields are required and enums are constrained", () => {
  assert.ok(VALIDATORS.price_bars.$jsonSchema.required.includes("payload_hash"));
  assert.ok(VALIDATORS.price_bars.$jsonSchema.required.includes("is_closed"));
  assert.ok(VALIDATORS.signals.$jsonSchema.required.includes("bar_ts"));
  assert.ok(VALIDATORS.outcomes.$jsonSchema.required.includes("evaluator_version"));
  assert.ok(VALIDATORS.ledger.$jsonSchema.required.includes("prev_hash"));
  assert.deepEqual(VALIDATORS.signals.$jsonSchema.properties.direction.enum, ["BUY", "SELL"]);
  assert.deepEqual(VALIDATORS.outcomes.$jsonSchema.properties.exit_type.enum,
    ["TARGET", "STOP", "TIMEOUT", "NOT_FILLED"]);
  assert.deepEqual(VALIDATORS.signal_status_log.$jsonSchema.properties.status.enum,
    ["generated", "rejected", "published", "expired", "cancelled", "not_filled"]);
  assert.equal(VALIDATORS.price_bars.$jsonSchema.properties.is_closed.enum[0], true);
});

test("invalid documents are rejected by validator shape checks", () => {
  assert.equal(rejects("signals", {}), true);
  assert.equal(rejects("signals", { direction: "HOLD" }), true);
  assert.equal(rejects("signals", { surprise: 1 }), true);
  assert.equal(rejects("outcomes", { exit_type: "MAYBE" }), true);
  assert.equal(rejects("price_bars", { is_closed: false }), true);
  assert.equal(rejects("ledger", { seq: 1 }), true);
});

test("every validator field has a data dictionary entry", () => {
  const paths = validatorFieldPaths();
  const entries = dictionaryEntries();
  assert.equal(entries.length, paths.length);
  assert.equal(assertDictionaryCoverage(entries).missing, 0);
  assert.ok(entries.every((entry) => entry.definition.length > 0));
  const ledgerEntry = entries.find((entry) => entry.collection === "ledger" && entry.field === "hash");
  assert.match(ledgerEntry.type, /string/);
});
