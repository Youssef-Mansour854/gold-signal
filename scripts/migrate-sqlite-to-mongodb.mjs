import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENV_FILE = resolve(ROOT, ".env");
const DB_PATH = resolve(ROOT, "data", "gold-signal.sqlite");
const REQUIRED_TABLES = [
  "price_points",
  "recommendations",
  "recommendation_events",
  "app_state",
  "economic_calendar_events",
  "trade_price_observations",
  "trade_data_gaps",
  "strategy_comparison_accounts",
  "strategy_comparison_trades",
];
const BATCH_SIZE = 500;
const DRY_RUN = process.argv.includes("--dry-run");

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function getMongoConfig() {
  const uri = process.env.MONGODB_URI?.trim();
  const databaseName = process.env.MONGODB_DATABASE?.trim();
  if (!uri) throw new Error("MONGODB_URI is not configured in the local .env file.");
  if (!databaseName || !/^[A-Za-z0-9_-]{1,63}$/.test(databaseName)) {
    throw new Error("Set MONGODB_DATABASE to a valid database name in the local .env file.");
  }
  return { uri, databaseName };
}

function getPrimaryKey(db, table) {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
  const primaryKeys = columns.filter((column) => column.pk > 0);
  if (primaryKeys.length !== 1) {
    throw new Error(`Expected one primary key for SQLite table ${table}.`);
  }
  return primaryKeys[0].name;
}

function stableRecord(record) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "_id")
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function loadTable(db, table) {
  const primaryKey = getPrimaryKey(db, table);
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY "${primaryKey}"`).all();
  const documents = rows.map((row) => {
    if (row[primaryKey] === null || row[primaryKey] === undefined) {
      throw new Error(`Found a row without a primary key in ${table}.`);
    }
    return { ...row, _id: row[primaryKey] };
  });
  return { primaryKey, documents };
}

async function findExistingDocuments(collection, documents) {
  const existing = new Map();
  for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
    const batch = documents.slice(offset, offset + BATCH_SIZE);
    const found = await collection
      .find({ _id: { $in: batch.map((document) => document._id) } })
      .toArray();
    for (const document of found) existing.set(document._id, document);
  }
  return existing;
}

async function preflightCollection(collection, documents, table) {
  const destinationCount = await collection.countDocuments();
  const existing = await findExistingDocuments(collection, documents);

  for (const source of documents) {
    const destination = existing.get(source._id);
    if (destination && stableRecord(destination) !== stableRecord(source)) {
      throw new Error(
        `Atlas contains a conflicting record in ${table} (primary key ${source._id}).`,
      );
    }
  }

  if (existing.size !== destinationCount) {
    throw new Error(`Atlas collection ${table} contains records not present in SQLite.`);
  }
}

async function writeCollection(collection, documents) {
  for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
    const batch = documents.slice(offset, offset + BATCH_SIZE);
    if (batch.length === 0) continue;
    await collection.bulkWrite(
      batch.map((document) => ({
        replaceOne: {
          filter: { _id: document._id },
          replacement: document,
          upsert: true,
        },
      })),
      { ordered: true },
    );
  }
}

async function verifyCollection(collection, documents, table) {
  const destinationCount = await collection.countDocuments();
  if (destinationCount !== documents.length) {
    throw new Error(
      `Count verification failed for ${table}: SQLite=${documents.length}, Atlas=${destinationCount}.`,
    );
  }

  const existing = await findExistingDocuments(collection, documents);
  if (existing.size !== documents.length) {
    throw new Error(`Record verification failed for ${table}: one or more keys are missing.`);
  }
  for (const source of documents) {
    if (stableRecord(existing.get(source._id)) !== stableRecord(source)) {
      throw new Error(`Record verification failed for ${table}, key ${source._id}.`);
    }
  }
}

async function main() {
  if (!existsSync(DB_PATH)) {
    throw new Error("SQLite database was not found at data/gold-signal.sqlite.");
  }

  const { uri, databaseName } = getMongoConfig();
  const sqlite = new DatabaseSync(DB_PATH, { readOnly: true });
  const mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });

  try {
    const tableNames = new Set(
      sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all().map((table) => table.name),
    );
    const missingTables = REQUIRED_TABLES.filter((table) => !tableNames.has(table));
    if (missingTables.length > 0) {
      throw new Error(`SQLite database is missing required tables: ${missingTables.join(", ")}.`);
    }

    const sourceTables = REQUIRED_TABLES.map((table) => ({
      name: table,
      ...loadTable(sqlite, table),
    }));

    await mongo.connect();
    const database = mongo.db(databaseName);
    await database.command({ ping: 1 });

    for (const table of sourceTables) {
      await preflightCollection(database.collection(table.name), table.documents, table.name);
    }

    if (DRY_RUN) {
      console.log("Atlas connection and migration preflight succeeded. No data was written.");
      for (const table of sourceTables) {
        console.log(`${table.name}: ${table.documents.length} SQLite records`);
      }
      return;
    }

    for (const table of sourceTables) {
      const collection = database.collection(table.name);
      await writeCollection(collection, table.documents);
      await verifyCollection(collection, table.documents, table.name);
      console.log(`${table.name}: verified ${table.documents.length} records`);
    }
    console.log("Migration completed and all collection counts and records were verified.");
  } finally {
    sqlite.close();
    await mongo.close();
  }
}

main().catch((error) => {
  const uri = process.env.MONGODB_URI?.trim();
  const safeMessage = error instanceof Error ? error.message : "Unknown migration error.";
  const sanitizedMessage = uri ? safeMessage.replaceAll(uri, "[redacted MongoDB URI]") : safeMessage;
  console.error(`MongoDB migration failed: ${sanitizedMessage}`);
  process.exitCode = 1;
});
