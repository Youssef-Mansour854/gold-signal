import { ensureReady, sendJson } from "./_shared.mjs";
import { getState } from "../server/runtime.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  try {
    await ensureReady();
    sendJson(res, 200, await getState());
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}
