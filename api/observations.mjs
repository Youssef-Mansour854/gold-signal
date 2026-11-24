import { ensureReady, sendJson } from "./_shared.mjs";
import { getObservationsCsv } from "../server/runtime.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }
  const raw = req.query?.id;
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(id) || id <= 0) {
    sendJson(res, 400, { error: "Invalid recommendation id." });
    return;
  }
  try {
    await ensureReady();
    const csv = await getObservationsCsv(id);
    if (csv === null) {
      sendJson(res, 404, { error: "التوصية غير موجودة." });
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="trade-${id}-price-history.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(csv);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}
