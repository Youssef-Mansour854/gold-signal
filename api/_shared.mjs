import "../server/load-env.mjs";
import { ensureInitialized } from "../server/runtime.mjs";

export async function ensureReady() {
  await ensureInitialized();
}

export function sendJson(res, statusCode, value) {
  res.status(statusCode).json(value);
}

export function requireCron(req, res) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers["x-cron-secret"] !== secret) {
    sendJson(res, 401, { error: "Unauthorized cron call." });
    return false;
  }
  return true;
}
