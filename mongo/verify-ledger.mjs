import { withMongo } from "./config.mjs";
import { verifyLedger } from "./ledger.mjs";

async function main() {
  await withMongo({}, async (db) => {
    const result = await verifyLedger(db);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/mongo/verify-ledger.mjs")) {
  main().catch((error) => {
    console.error(`Ledger verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
