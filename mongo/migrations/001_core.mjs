import { ALL_COLLECTIONS, VALIDATORS } from "../schema/validators.mjs";

export const description = "Create all core collections with strict $jsonSchema validators.";

export async function up(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray())
    .map((collection) => collection.name));

  for (const name of ALL_COLLECTIONS) {
    const options = {
      validator: VALIDATORS[name],
      validationLevel: "strict",
      validationAction: "error",
    };
    if (existing.has(name)) {
      await db.command({ collMod: name, ...options });
    } else {
      await db.createCollection(name, options);
    }
  }
  if (!existing.has("ledger_seq")) await db.createCollection("ledger_seq");
  // Seed the counter up front so concurrent first inserts never race an upsert.
  await db.collection("ledger_seq").updateOne(
    { _id: "ledger" },
    { $setOnInsert: { value: 0 } },
    { upsert: true },
  );
  if (!existing.has("migrations")) await db.createCollection("migrations");
}

export async function down(db) {
  for (const name of ALL_COLLECTIONS) {
    if ((await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0) {
      await db.collection(name).drop();
    }
  }
  if ((await db.listCollections({ name: "ledger_seq" }, { nameOnly: true }).toArray()).length > 0) {
    await db.collection("ledger_seq").drop();
  }
}
