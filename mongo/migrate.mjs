import { readdir } from "node:fs/promises";
import { withMongo } from "./config.mjs";
import { checkCapabilities } from "./doctor.mjs";

const MIGRATIONS_COLLECTION = "migrations";
const ALLOW_GAPS = ["1", "true", "yes"].includes(
  (process.env.ALLOW_DEPLOYMENT_GAPS ?? "").trim().toLowerCase(),
);

async function loadMigrations() {
  const dir = new URL("./migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".mjs")).sort();
  const migrations = [];
  for (const file of files) {
    const module = await import(new URL(file, dir).href);
    if (typeof module.up !== "function" || typeof module.down !== "function") {
      throw new Error(`Migration ${file} must export up() and down().`);
    }
    migrations.push({ name: file, ...module });
  }
  return migrations;
}

async function appliedNames(db) {
  const rows = await db.collection(MIGRATIONS_COLLECTION)
    .find({ name: { $exists: true } }, { projection: { name: 1 } }).toArray();
  return new Set(rows.map((row) => row.name));
}

export async function migrationStatus(db) {
  const migrations = await loadMigrations();
  const applied = await appliedNames(db);
  return migrations.map((migration) => ({
    name: migration.name,
    applied: applied.has(migration.name),
    description: migration.description ?? "",
  }));
}

export async function migrateUp(db, client, limit = Infinity) {
  const capabilities = await checkCapabilities(db, client);
  if (!capabilities.ok && !ALLOW_GAPS) {
    throw new Error(`Deployment capability gaps: ${capabilities.gaps.join("; ")}`);
  }
  const migrations = await loadMigrations();
  const applied = await appliedNames(db);
  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    if (count >= limit) break;
    await migration.up(db, client);
    await db.collection(MIGRATIONS_COLLECTION).insertOne({
      name: migration.name,
      description: migration.description ?? "",
      applied_at: new Date(),
    });
    count += 1;
    console.log(`applied ${migration.name}`);
  }
  if (count === 0) console.log("no pending migrations");
  return count;
}

export async function migrateDown(db, client, limit = 1) {
  const migrations = await loadMigrations();
  const applied = await appliedNames(db);
  let count = 0;
  for (const migration of [...migrations].reverse()) {
    if (!applied.has(migration.name)) continue;
    if (count >= limit) break;
    await migration.down(db, client);
    await db.collection(MIGRATIONS_COLLECTION).deleteOne({ name: migration.name });
    count += 1;
    console.log(`reverted ${migration.name}`);
  }
  if (count === 0) console.log("no applied migrations");
  return count;
}

async function main() {
  const [command = "status", amount] = process.argv.slice(2);
  let limit = Infinity;
  if (amount !== undefined) {
    limit = Number(amount);
    if (!Number.isInteger(limit) || limit < 0) throw new Error("Migration count must be a non-negative integer.");
  }
  await withMongo({}, async (db, client) => {
    if (command === "up") await migrateUp(db, client, limit);
    else if (command === "down") await migrateDown(db, client, limit);
    else if (command === "status") console.log(JSON.stringify(await migrationStatus(db), null, 2));
    else throw new Error(`Unknown migration command: ${command}`);
  });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/mongo/migrate.mjs")) {
  main().catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
