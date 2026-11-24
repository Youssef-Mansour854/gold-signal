/**
 * Thin local HTTP host for the MongoDB-backed runtime engine.
 *
 * The same engine is used by the Vercel functions under api/. This process is
 * only for local development / a permanent Node host: it serves the built Vite
 * app and runs the two poll timers. All state lives in MongoDB.
 */
import "./load-env.mjs";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeRuntime,
  getState,
  getObservationsCsv,
  initialize,
  pollEconomicCalendar,
  pollPrice,
  PORT,
  SAMPLE_INTERVAL_MS,
} from "./runtime.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST_DIR = resolve(ROOT, "dist");

let shuttingDown = false;
let pollTimer;
let calendarTimer;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function serveFrontend(request, response) {
  if (!existsSync(resolve(DIST_DIR, "index.html"))) {
    sendJson(response, 404, { error: "واجهة الإنتاج غير مبنية. شغّل npm run build أولًا." });
    return;
  }
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    sendJson(response, 400, { error: "مسار طلب غير صالح." });
    return;
  }
  const candidate = resolve(DIST_DIR, `.${requestedPath}`);
  const allowed = candidate === DIST_DIR || candidate.startsWith(`${DIST_DIR}${sep}`);
  const filePath = allowed && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : resolve(DIST_DIR, "index.html");
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
  });
  response.end(readFileSync(filePath));
}

function getRequestPathname(request) {
  try {
    return new URL(request.url, "http://localhost").pathname;
  } catch {
    return null;
  }
}

const server = createServer((request, response) => {
  const pathname = getRequestPathname(request);

  if (request.method === "GET" && pathname === "/api/state") {
    getState()
      .then((state) => sendJson(response, 200, state))
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return;
  }

  const observationMatch = request.method === "GET" && pathname
    ? /^\/api\/recommendations\/(\d+)\/observations\.csv$/.exec(pathname)
    : null;
  if (observationMatch) {
    getObservationsCsv(Number(observationMatch[1]))
      .then((csv) => {
        if (csv === null) {
          sendJson(response, 404, { error: "التوصية غير موجودة." });
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="trade-${observationMatch[1]}-price-history.csv"`,
          "Cache-Control": "no-store",
        });
        response.end(csv);
      })
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return;
  }

  if (request.method === "POST" && pathname === "/api/cron/poll") {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || request.headers["x-cron-secret"] !== secret) {
      sendJson(response, 401, { error: "Unauthorized cron call." });
      return;
    }
    pollPrice()
      .then((result) => sendJson(response, 200, { ok: true, ...result }))
      .catch((error) => sendJson(response, 500, { ok: false, error: error.message }));
    return;
  }

  if (request.method === "POST" && pathname === "/api/cron/calendar") {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || request.headers["x-cron-secret"] !== secret) {
      sendJson(response, 401, { error: "Unauthorized cron call." });
      return;
    }
    pollEconomicCalendar()
      .then((result) => sendJson(response, 200, { ok: true, ...result }))
      .catch((error) => sendJson(response, 500, { ok: false, error: error.message }));
    return;
  }

  if (pathname?.startsWith("/api/")) {
    sendJson(response, 404, { error: "مسار API غير معروف." });
    return;
  }
  if (request.method === "GET") {
    serveFrontend(request, response);
    return;
  }
  sendJson(response, 405, { error: "طريقة الطلب غير مدعومة." });
});

server.on("error", (error) => {
  console.error(`[server] ${error.message}`);
  process.exitCode = 1;
});

async function safePollPrice() {
  try {
    const result = await pollPrice();
    if (result.inserted) console.log(`[price-poller] stored $${result.price}`);
  } catch (error) {
    console.error(`[price-poller] ${error.message}`);
  } finally {
    if (!shuttingDown) pollTimer = setTimeout(safePollPrice, SAMPLE_INTERVAL_MS);
  }
}

async function safePollCalendar() {
  try {
    const result = await pollEconomicCalendar();
    if (!result.skipped) console.log(`[economic-calendar] synced ${result.count} events`);
  } catch (error) {
    console.error(`[economic-calendar] ${error.message}`);
  } finally {
    if (!shuttingDown) calendarTimer = setTimeout(safePollCalendar, 6 * 60 * 60 * 1000);
  }
}

await initialize();
server.listen(PORT, () => {
  console.log(`Gold signal server listening on http://localhost:${PORT} (MongoDB runtime)`);
  void safePollPrice();
  void safePollCalendar();
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(pollTimer);
  clearTimeout(calendarTimer);
  server.close(() => {
    void closeRuntime().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
