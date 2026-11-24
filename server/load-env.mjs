/**
 * Side-effect import that must come before any module reading process.env.
 * ESM evaluates dependencies in source order, so importing this first in
 * server/index.mjs and in every api/ function keeps local .env values visible
 * to the runtime engine. On Vercel the variables already exist in process.env
 * and this is a no-op.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = resolve(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
