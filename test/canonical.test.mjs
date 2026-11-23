import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  canonicalJson, canonicalize, documentHash, chainHash, hashForDocument,
  decimal, decimalString, stableObjectId, sha256Hex,
} from "../mongo/canonical.mjs";
import { GENESIS_HASH } from "../mongo/config.mjs";

test("canonical JSON sorts keys at every level", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}');
});

test("canonical JSON distinguishes BSON types from look-alike strings", () => {
  const date = new Date("2026-01-01T00:00:00.000Z");
  assert.notEqual(canonicalJson({ ts: date }), canonicalJson({ ts: date.toISOString() }));
  assert.equal(canonicalJson({ ts: date }), '{"ts":{"$date":"2026-01-01T00:00:00.000Z"}}');
  assert.equal(canonicalJson({ price: decimal("1.25") }), '{"price":{"$numberDecimal":"1.25"}}');
  assert.equal(canonicalJson({ id: new ObjectId("000000000000000000000001") }),
    '{"id":{"$oid":"000000000000000000000001"}}');
});

test("undefined fields are omitted and non-finite numbers are rejected", () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.throws(() => canonicalize({ x: Number.NaN }), /Non-finite/);
});

test("document hash is deterministic and sensitive to content", () => {
  const document = { a: 1, b: decimal("2.5"), ts: new Date(0) };
  assert.equal(documentHash(document), documentHash({ b: document.b, ts: document.ts, a: 1 }));
  assert.notEqual(documentHash(document), documentHash({ ...document, a: 2 }));
  assert.match(documentHash(document), /^sha256:[0-9a-f]{64}$/);
});

test("hash chain binds the document to its predecessor", () => {
  const first = hashForDocument({ seq: 1 }, GENESIS_HASH);
  assert.equal(first.hash, chainHash(first.doc_hash, GENESIS_HASH));
  const second = hashForDocument({ seq: 2 }, first.hash);
  assert.notEqual(second.hash, hashForDocument({ seq: 2 }, GENESIS_HASH).hash);
  assert.equal(second.hash, chainHash(second.doc_hash, first.hash));
});

test("decimals round-trip without float drift in string form", () => {
  assert.equal(decimalString(decimal("0.25")), "0.25");
  assert.equal(decimalString(decimal(0.25)), "0.25");
  assert.equal(decimal(null), null);
});

test("stable ObjectIds are deterministic for legacy imports", () => {
  const first = stableObjectId("price_points:1");
  const second = stableObjectId("price_points:1");
  assert.equal(first.toHexString(), second.toHexString());
  assert.match(first.toHexString(), /^[0-9a-f]{24}$/);
  assert.notEqual(first.toHexString(), stableObjectId("price_points:2").toHexString());
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
