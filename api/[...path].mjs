/**
 * Vercel serverless proxy for the dashboard's same-origin /api calls.
 * The real API is a long-running Node + SQLite process and cannot run on
 * Vercel's serverless runtime, so it must be hosted elsewhere and its public
 * base URL supplied through API_UPSTREAM_URL in the Vercel project settings.
 */
const HOP_BY_HOP = new Set([
  "connection", "content-encoding", "content-length", "transfer-encoding", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade", "host",
]);

export default async function handler(req, res) {
  const upstream = process.env.API_UPSTREAM_URL?.trim();
  if (!upstream) {
    res.status(503).json({
      error: "API_UPSTREAM_URL is not configured. Deploy the Node API separately and set this Vercel environment variable.",
    });
    return;
  }

  const segments = req.query?.path;
  const path = Array.isArray(segments) ? segments.join("/") : (segments ?? "");
  let target;
  try {
    target = new URL(`/api/${path}`, upstream);
  } catch {
    res.status(500).json({ error: "API_UPSTREAM_URL is not a valid absolute URL." });
    return;
  }
  const incoming = new URL(req.url ?? "/", "http://localhost");
  target.search = incoming.search;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  const init = { method: req.method, headers, redirect: "manual" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  }

  try {
    const response = await fetch(target, init);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
    });
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.status(502).json({ error: "Upstream API unavailable", detail: error.message });
  }
}
