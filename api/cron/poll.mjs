import { ensureReady, requireCron, sendJson } from "../_shared.mjs";
import { pollPrice } from "../../server/runtime.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  if (!requireCron(req, res)) return;
  try {
    await ensureReady();
    sendJson(res, 200, { ok: true, ...(await pollPrice()) });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}
