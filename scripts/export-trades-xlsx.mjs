/**
 * Export the live MongoDB runtime state to a real .xlsx workbook.
 * Uses only Node built-ins (no new dependency). Run with:
 *   node scripts/export-trades-xlsx.mjs
 */
import "../server/load-env.mjs";
import { deflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadState, closeRuntime } from "../server/runtime.mjs";

// --- minimal ZIP writer -----------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const source = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = deflateRawSync(source, { level: 6 });
    const crc = crc32(source);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuffer, packed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014B50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(source.length, 24);
    record.writeUInt16LE(nameBuffer.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuffer);

    offset += local.length + nameBuffer.length + packed.length;
  }

  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, ...central, end]);
}

// --- minimal XLSX writer ----------------------------------------------------
function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function cellXml(column, row, value) {
  const reference = `${columnName(column)}${row}`;
  if (value === null || value === undefined || value === "") return `<c r="${reference}"/>`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}"><v>${value}</v></c>`;
  }
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(headers, rows) {
  const headerRow = `<row r="1">${headers.map((header, index) => cellXml(index, 1, header)).join("")}</row>`;
  const dataRows = rows.map((row, rowIndex) => {
    const number = rowIndex + 2;
    return `<row r="${number}">${row.map((value, index) => cellXml(index, number, value)).join("")}</row>`;
  }).join("");
  const lastColumn = columnName(Math.max(0, headers.length - 1));
  const autoFilter = rows.length ? `<autoFilter ref="A1:${lastColumn}${rows.length + 1}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetData>${headerRow}${dataRows}</sheetData>${autoFilter}</worksheet>`;
}

function buildWorkbook(sheets) {
  const entries = [];
  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  ];
  const sheetTags = [];
  const relationships = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  ];

  sheets.forEach((sheet, index) => {
    const number = index + 1;
    sheetTags.push(`<sheet name="${escapeXml(sheet.name)}" sheetId="${number}" r:id="rId${number}"/>`);
    relationships.push(
      `<Relationship Id="rId${number}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${number}.xml"/>`,
    );
    contentTypes.push(
      `<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    );
    entries.push({
      name: `xl/worksheets/sheet${number}.xml`,
      content: sheetXml(sheet.headers, sheet.rows),
    });
  });

  contentTypes.push("</Types>");
  relationships.push("</Relationships>");

  entries.unshift({
    name: "[Content_Types].xml",
    content: contentTypes.join(""),
  });
  entries.push(
    {
      name: "_rels/.rels",
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: "xl/workbook.xml",
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${sheetTags.join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: relationships.join(""),
    },
  );
  return zip(entries);
}

// --- data extraction --------------------------------------------------------
const state = await loadState();
const generatedAt = new Date().toISOString();

const recommendationHeaders = [
  "id", "status", "direction", "entry_price", "take_profit", "stop_loss",
  "initial_stop_loss", "take_profit_1", "take_profit_2", "take_profit_3",
  "next_target", "remaining_fraction", "realized_percent", "management_version",
  "target_percent", "stop_percent", "short_average", "long_average",
  "change_percent", "strategy_version", "provider_updated_at", "created_at",
  "closed_at", "exit_price", "result_percent", "close_reason",
  "cost_estimate_model", "estimated_spread_usd_per_oz", "estimated_slippage_usd_per_oz",
  "estimated_commission_usd_per_oz", "estimated_total_cost_usd_per_oz",
  "estimated_net_result_percent", "account_equity_at_entry", "risk_budget_usd",
  "virtual_quantity_ounces", "realized_gross_usd", "estimated_cost_usd",
  "realized_net_usd", "account_equity_after", "account_model", "price_source",
  "event_count", "observation_count", "data_gap_count",
];
const recommendations = state.recommendations.map((item) => [
  item.id, item.status, item.direction, item.entry_price, item.take_profit, item.stop_loss,
  item.initial_stop_loss, item.take_profit_1, item.take_profit_2, item.take_profit_3,
  item.next_target, item.remaining_fraction, item.realized_percent, item.management_version,
  item.target_percent, item.stop_percent, item.short_average, item.long_average,
  item.change_percent, item.strategy_version, item.provider_updated_at, item.created_at,
  item.closed_at, item.exit_price, item.result_percent, item.close_reason,
  item.cost_estimate_model, item.estimated_spread_usd_per_oz, item.estimated_slippage_usd_per_oz,
  item.estimated_commission_usd_per_oz, item.estimated_total_cost_usd_per_oz,
  item.estimated_net_result_percent, item.account_equity_at_entry, item.risk_budget_usd,
  item.virtual_quantity_ounces, item.realized_gross_usd, item.estimated_cost_usd,
  item.realized_net_usd, item.account_equity_after, item.account_model, item.price_source,
  (item.events ?? []).length,
  state.observations.filter((observation) => observation.recommendation_id === item.id).length,
  state.gaps.filter((gap) => gap.recommendation_id === item.id).length,
]);

const eventHeaders = [
  "id", "recommendation_id", "event_type", "target_number", "price",
  "quantity_fraction", "contribution_percent", "current_stop_loss", "occurred_at",
  "estimated_cost_usd_per_oz", "net_contribution_percent", "point_move",
  "gross_pnl_usd", "estimated_cost_usd", "net_pnl_usd", "account_equity_after",
];
const events = state.recommendations.flatMap((item) => (item.events ?? []).map((event) => [
  event.id, item.id, event.event_type, event.target_number, event.price,
  event.quantity_fraction, event.contribution_percent, event.current_stop_loss, event.occurred_at,
  event.estimated_cost_usd_per_oz, event.net_contribution_percent, event.point_move,
  event.gross_pnl_usd, event.estimated_cost_usd, event.net_pnl_usd, event.account_equity_after,
]));

const observationHeaders = [
  "id", "recommendation_id", "source", "phase", "price",
  "source_updated_at", "observed_at", "lag_ms",
];
const observations = state.observations.map((item) => [
  item.id, item.recommendation_id, item.source, item.phase, item.price,
  item.source_updated_at, item.observed_at,
  Date.parse(item.observed_at) - Date.parse(item.source_updated_at),
]);

const gapHeaders = [
  "id", "recommendation_id", "last_observed_at", "resumed_at",
  "duration_seconds", "resume_price",
];
const gaps = state.gaps.map((item) => [
  item.id, item.recommendation_id, item.last_observed_at, item.resumed_at,
  item.duration_seconds, item.resume_price,
]);

const accountHeaders = [
  "id", "strategy_id", "strategy_name", "sizing_mode_id", "sizing_mode_name",
  "equity_usd", "starting_equity_usd", "realized_gross_usd", "estimated_cost_usd",
  "realized_net_usd", "trade_count", "win_count", "loss_count", "open_trade_count", "updated_at",
];
const accounts = state.comparisonAccounts.map((item) => [
  item.id, item.strategy_id, item.strategy_name, item.sizing_mode_id, item.sizing_mode_name,
  item.equity_usd, item.starting_equity_usd, item.realized_gross_usd, item.estimated_cost_usd,
  item.realized_net_usd, item.trade_count, item.win_count, item.loss_count,
  item.open_trade_count, item.updated_at,
]);

const comparisonTradeHeaders = [
  "id", "account_id", "strategy_id", "strategy_name", "sizing_mode_id", "sizing_mode_name",
  "status", "direction", "entry_price", "stop_loss", "take_profit_1", "take_profit_2",
  "take_profit_3", "next_target", "remaining_fraction", "realized_gross_percent",
  "quantity_ounces", "lot_size", "gross_usd", "estimated_cost_usd", "net_usd",
  "close_reason", "opened_at", "closed_at", "exit_price",
];
const comparisonTrades = state.comparisonTrades.map((item) => [
  item.id, item.account_id, item.strategy_id, item.strategy_name, item.sizing_mode_id,
  item.sizing_mode_name, item.status, item.direction, item.entry_price, item.stop_loss,
  item.take_profit_1, item.take_profit_2, item.take_profit_3, item.next_target,
  item.remaining_fraction, item.realized_gross_percent, item.quantity_ounces, item.lot_size,
  item.gross_usd, item.estimated_cost_usd, item.net_usd, item.close_reason,
  item.opened_at, item.closed_at, item.exit_price,
]);

const priceHeaders = ["id", "price", "currency", "symbol", "source_updated_at", "observed_at"];
const prices = state.pricePoints.map((item) => [
  item.id, item.price, item.currency, item.symbol, item.source_updated_at, item.observed_at,
]);

const summary = [
  ["generated_at", generatedAt],
  ["source", "MongoDB runtime_state"],
  ["recommendations", recommendations.length],
  ["events", events.length],
  ["price_observations", observations.length],
  ["data_gaps", gaps.length],
  ["price_points", prices.length],
  ["strategy_accounts", accounts.length],
  ["strategy_comparison_trades", comparisonTrades.length],
  ["open_recommendations", state.recommendations.filter((item) => item.status === "open").length],
  ["note", "Prices are simulated from a public XAU/USD quote; costs are estimates, not executed fills."],
];

const sheets = [
  { name: "Summary", headers: ["field", "value"], rows: summary },
  { name: "Recommendations", headers: recommendationHeaders, rows: recommendations },
  { name: "Events", headers: eventHeaders, rows: events },
  { name: "Observations", headers: observationHeaders, rows: observations },
  { name: "Data Gaps", headers: gapHeaders, rows: gaps },
  { name: "Strategy Accounts", headers: accountHeaders, rows: accounts },
  { name: "Strategy Trades", headers: comparisonTradeHeaders, rows: comparisonTrades },
  { name: "Price Points", headers: priceHeaders, rows: prices },
];

const directory = resolve("exports");
mkdirSync(directory, { recursive: true });
const stamp = generatedAt.replaceAll(":", "-").slice(0, 16);
const filePath = resolve(directory, `gold-signal-trades-${stamp}.xlsx`);
writeFileSync(filePath, buildWorkbook(sheets));
console.log(JSON.stringify({ file: filePath, sheets: sheets.map((sheet) => `${sheet.name}=${sheet.rows.length}`) }, null, 2));
await closeRuntime();
