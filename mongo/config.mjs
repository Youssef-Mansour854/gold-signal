import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENV_FILE = resolve(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export const EVALUATOR_VERSION = "v1.0.0";
export const ENTRY_RULE_VERSION = "v1";
export const COST_MODEL_VERSION = "v1";
export const LEGACY_EVALUATOR_VERSION = "legacy-unverified";
export const LEGACY_VERSION = "legacy-unverified";
export const GENESIS_HASH = `sha256:${"0".repeat(64)}`;

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function getMongoConfig({ test = false } = {}) {
  const uriKey = test ? "TEST_MONGODB_URI" : "MONGODB_URI";
  const databaseKey = test ? "TEST_MONGODB_DATABASE" : "MONGODB_DATABASE";
  const uri = process.env[uriKey]?.trim();
  const database = process.env[databaseKey]?.trim()
    ?? (test ? "gold_signal_test" : undefined);
  if (!uri) throw new Error(`${uriKey} is not configured.`);
  if (!database || !/^[A-Za-z0-9_-]{1,63}$/.test(database)) {
    throw new Error(`${databaseKey} must be a valid MongoDB database name.`);
  }
  return { uri, database };
}

export function hasMongoConfig({ test = false } = {}) {
  try {
    getMongoConfig({ test });
    return true;
  } catch {
    return false;
  }
}

export const FEATURE_ENABLED = envFlag("MONGO_DATA_LAYER_ENABLED", false);
export const CODE_GIT_HASH = process.env.GIT_COMMIT?.trim() || "unknown";

export function maskUri(uri) {
  return uri.replace(/\/\/[^@/]+@/, "//[redacted]@");
}

export async function withMongo({ test = false } = {}, callback) {
  const config = getMongoConfig({ test });
  const client = new MongoClient(config.uri, {
    serverSelectionTimeoutMS: 15_000,
    retryWrites: true,
  });
  try {
    await client.connect();
    return await callback(client.db(config.database), client, config);
  } finally {
    await client.close();
  }
}
