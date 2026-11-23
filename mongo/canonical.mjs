import { createHash } from "node:crypto";
import { Decimal128, ObjectId, Binary, Long, Timestamp, Int32, Double } from "mongodb";
import { GENESIS_HASH } from "./config.mjs";

/**
 * Deterministic, lossless-enough canonical form for BSON documents.
 * Key order is sorted at every level; BSON wrapper types use their extended-JSON
 * tags so that a Date cannot accidentally compare equal to its ISO string.
 */
export function isDecimal128(value) {
  return Boolean(value) && value._bsontype === "Decimal128";
}

export function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (isDecimal128(value)) return { $numberDecimal: value.toString() };
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof Binary) {
    return { $binary: Buffer.from(value.buffer).toString("base64"), $subType: value.sub_type };
  }
  if (typeof Long === "function" && value instanceof Long) {
    return { $numberLong: value.toString() };
  }
  if (typeof Int32 === "function" && value instanceof Int32) {
    return { $numberInt: value.toString() };
  }
  if (typeof Double === "function" && value instanceof Double) {
    return { $numberDouble: value.toString() };
  }
  if (typeof Timestamp === "function" && value instanceof Timestamp) {
    return { $timestamp: { t: value.t, i: value.i } };
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite numbers cannot be canonicalised.");
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  throw new Error(`Unsupported canonical value: ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function documentHash(document) {
  return `sha256:${sha256Hex(canonicalJson(document))}`;
}

/** hash = SHA-256( canonical JSON of { doc_hash, prev_hash } ). */
export function chainHash(docHash, prevHash) {
  return `sha256:${sha256Hex(canonicalJson({ doc_hash: docHash, prev_hash: prevHash }))}`;
}

export function hashForDocument(document, prevHash = GENESIS_HASH) {
  const docHash = documentHash(document);
  return { doc_hash: docHash, hash: chainHash(docHash, prevHash) };
}

/** Deterministic ObjectId for imported legacy documents (idempotent re-imports). */
export function stableObjectId(key) {
  const bytes = createHash("md5").update(String(key)).digest().subarray(0, 12);
  return new ObjectId(bytes);
}

export function decimal(value) {
  if (value === null || value === undefined) return null;
  if (isDecimal128(value)) return value;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Money and prices must be finite.");
  }
  return Decimal128.fromString(String(value));
}

export function decimalString(value) {
  if (value === null || value === undefined) return null;
  return isDecimal128(value) ? value.toString() : String(value);
}

export function decimalNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(decimalString(value));
  if (!Number.isFinite(parsed)) throw new Error("Decimal value is not representable as a number.");
  return parsed;
}

/** Money/prices are stored as decimals but compared/aggregated with exact integer minor units. */
export function decimalAdd(...values) {
  return values.reduce((sum, value) => sum + decimalNumber(value), 0);
}
