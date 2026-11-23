import { decimalNumber } from "./canonical.mjs";
import { EVALUATOR_VERSION } from "./config.mjs";

/** All aggregate numbers in the project come from this module, over rows read from MongoDB. */

export function num(value) {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : decimalNumber(value);
}

export function mulberry32(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleSd(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// Lanczos approximation for log Gamma, needed by the regularised beta below.
function logGamma(value) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * value)) - logGamma(1 - value);
  }
  const z = value - 1;
  let sum = 0.99999999999980993;
  for (let index = 0; index < coefficients.length; index += 1) {
    sum += coefficients[index] / (z + index + 1);
  }
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

// Regularised incomplete beta (Lentz continued fraction). Used for the exact
// two-sided Student t p-value; no hand-written significance labels are stored.
function betacf(a, b, x) {
  const MAX_ITERATIONS = 300;
  const EPSILON = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
}

export function betaInc(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for H0: mean R = 0. */
export function tTestP(values) {
  const n = values.length;
  if (n < 2) return null;
  const sd = sampleSd(values);
  if (sd === 0) return mean(values) === 0 ? 1 : 0;
  const tStat = (mean(values) / sd) * Math.sqrt(n);
  const df = n - 1;
  return Math.min(1, Math.max(0, betaInc(df / 2, 0.5, df / (df + tStat * tStat))));
}

function percentile(sorted, probability) {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function bootstrap(values, rng, iterations = 2000) {
  const lower = [];
  const upper = [];
  const n = values.length;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    for (let index = 0; index < n; index += 1) {
      sample.push(values[Math.floor(rng() * n)]);
    }
    const sorted = sample.sort((a, b) => a - b);
    lower.push(percentile(sorted, 0.025));
    upper.push(percentile(sorted, 0.975));
  }
  return [percentile(lower.sort((a, b) => a - b), 0.5), percentile(upper.sort((a, b) => a - b), 0.5)];
}

function clusteredBootstrap(groups, rng, iterations = 2000) {
  const keys = Object.keys(groups);
  if (keys.length === 0) return [0, 0];
  const lower = [];
  const upper = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[Math.floor(rng() * keys.length)];
      sample.push(...groups[key]);
    }
    const sorted = sample.sort((a, b) => a - b);
    lower.push(percentile(sorted, 0.025));
    upper.push(percentile(sorted, 0.975));
  }
  return [percentile(lower.sort((a, b) => a - b), 0.5), percentile(upper.sort((a, b) => a - b), 0.5)];
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

/** Cairo is UTC+2 in this reporting layer; display conversion happens here only. */
export function cairoTime(date) {
  const shifted = new Date(date.getTime() + 2 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 10)} ${shifted.toISOString().slice(11, 16)}`;
}

function sessionOf(date) {
  const hour = date.getUTCHours();
  if (hour < 7) return "ASIA_UTC";
  if (hour < 12) return "LONDON_UTC";
  if (hour < 20) return "NEW_YORK_UTC";
  return "OTHER_UTC";
}

const SESSION_NAMES = ["ASIA_UTC", "LONDON_UTC", "NEW_YORK_UTC", "OTHER_UTC"];

function maxDrawdown(sequenced) {
  let peak = 0;
  let cumulative = 0;
  let worst = 0;
  for (const value of sequenced) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    worst = Math.min(worst, cumulative - peak);
  }
  return worst;
}

export function versionTuples(outcomes) {
  const tuples = new Set(outcomes.map((outcome) => JSON.stringify([
    outcome.evaluator_version,
    outcome.entry_rule_version,
    outcome.cost_model_version,
  ])));
  return [...tuples].map((tuple) => JSON.parse(tuple));
}

/**
 * Compute every reported metric from already-queryed rows. No number is
 * hand-written; nothing here reads a database or a clock.
 */
export function computeReport({
  strategyId = "all",
  evaluatorVersion = EVALUATOR_VERSION,
  signals = [],
  statuses = [],
  publications = [],
  outcomes = [],
  rng = mulberry32(42),
  bootstrapIterations = 2000,
  since = null,
} = {}) {
  const trades = outcomes.filter((outcome) => outcome.exit_type !== "NOT_FILLED");
  const notFilled = outcomes.filter((outcome) => outcome.exit_type === "NOT_FILLED");
  const nets = trades.map((outcome) => num(outcome.net));
  const rs = trades.map((outcome) => num(outcome.r_realized));
  const rGroups = {};
  for (const outcome of trades) {
    const day = utcDay(new Date(outcome.entry_time));
    (rGroups[day] ??= []).push(num(outcome.r_realized));
  }

  const grossProfit = trades.reduce((sum, outcome) => sum + Math.max(0, num(outcome.gross)), 0);
  const grossLoss = trades.reduce((sum, outcome) => sum + Math.min(0, num(outcome.gross)), 0);
  const costs = trades.reduce((sum, outcome) => sum + num(outcome.slippage_cost)
    + num(outcome.commission_cost), 0);
  const exitMix = {};
  for (const outcome of outcomes) {
    exitMix[outcome.exit_type] = (exitMix[outcome.exit_type] ?? 0) + 1;
  }

  const sessions = Object.fromEntries(SESSION_NAMES.map((name) => [name, {
    trades: 0,
    net_units: 0,
    mean_r: 0,
    first_utc: null,
    first_cairo: null,
  }]));
  for (const outcome of trades) {
    const key = sessionOf(new Date(outcome.entry_time));
    const session = sessions[key];
    session.trades += 1;
    session.net_units += num(outcome.net);
    session.mean_r = session.net_units / session.trades;
    const time = new Date(outcome.entry_time);
    if (!session.first_utc || time < session.first_utc) {
      session.first_utc = time.toISOString();
      session.first_cairo = cairoTime(time);
    }
  }

  const sortedByEntry = [...outcomes].sort((a, b) => new Date(a.entry_time) - new Date(b.entry_time));
  const tuples = versionTuples(outcomes);
  const flags = [];
  if (trades.length < 100) flags.push("LOW_SAMPLE");
  if (tuples.length > 1) flags.push("NOT_COMPARABLE");
  if (since && outcomes.some((outcome) => new Date(outcome.entry_time) < new Date(since))) {
    flags.push("PERIOD_FILTER_MISMATCH");
  }

  const publishedIds = new Set(publications.map((publication) => String(publication.signal_id)));
  const statusCounts = statuses.reduce((acc, status) => {
    acc[status.status] = (acc[status.status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    strategy_id: strategyId,
    evaluator_filter: evaluatorVersion,
    versions: tuples,
    period: { since: since ?? null, to: outcomes.at(-1)?.exit_time ?? null },
    counts: {
      signals: signals.length,
      published: publications.length,
      published_signal_ids: publishedIds.size,
      not_filled: notFilled.length,
      trades: trades.length,
      ambiguous: outcomes.filter((outcome) => outcome.ambiguous).length,
      status_counts: statusCounts,
    },
    win_rate: trades.length === 0 ? null : nets.filter((value) => value > 0).length / trades.length,
    exit_mix: exitMix,
    net_units: outcomes.reduce((sum, outcome) => sum + num(outcome.net), 0),
    mean_r: mean(rs),
    sd_r: sampleSd(rs),
    t_test_p: tTestP(rs),
    bootstrap_ci: {
      trade_level: bootstrap(rs, rng, bootstrapIterations),
      day_clustered: clusteredBootstrap(rGroups, rng, bootstrapIterations),
    },
    profit_factor: grossLoss === 0
      ? (grossProfit > 0 ? Infinity : null)
      : grossProfit / Math.abs(grossLoss),
    max_drawdown_units: maxDrawdown(sortedByEntry.map((outcome) => num(outcome.net))),
    cost_share_of_gross_profit: grossProfit === 0 ? null : costs / grossProfit,
    sessions,
    flags,
  };
}

export function formatReport(report) {
  const lines = [];
  lines.push(`strategy=${report.strategy_id} evaluator_filter=${report.evaluator_filter}`);
  for (const tuple of report.versions) {
    lines.push(`versions evaluator=${tuple[0]} entry_rule=${tuple[1]} cost_model=${tuple[2]}`);
  }
  if (report.versions.length === 0) lines.push("versions none");
  lines.push(`period since=${report.period.since ?? "all"} to=${report.period.to ?? "none"}`);
  const counts = report.counts;
  lines.push(`signals=${counts.signals} published=${counts.published} not_filled=${counts.not_filled} trades=${counts.trades} ambiguous=${counts.ambiguous}`);
  lines.push(`status_counts=${JSON.stringify(counts.status_counts)}`);
  lines.push(`win_rate=${report.win_rate ?? "n/a"} exit_mix=${JSON.stringify(report.exit_mix)}`);
  lines.push(`net_units=${report.net_units} mean_r=${report.mean_r} sd_r=${report.sd_r} t_test_p=${report.t_test_p ?? "n/a"}`);
  lines.push(`bootstrap_ci_trade_level=${JSON.stringify(report.bootstrap_ci.trade_level)}`);
  lines.push(`bootstrap_ci_day_clustered=${JSON.stringify(report.bootstrap_ci.day_clustered)}`);
  lines.push(`profit_factor=${report.profit_factor ?? "n/a"} max_drawdown_units=${report.max_drawdown_units} cost_share_of_gross_profit=${report.cost_share_of_gross_profit ?? "n/a"}`);
  lines.push("session utc_first cairo_first trades net_units mean_r");
  for (const [name, session] of Object.entries(report.sessions)) {
    lines.push(`${name} ${session.first_utc ?? "-"} ${session.first_cairo ?? "-"} ${session.trades} ${session.net_units} ${session.mean_r}`);
  }
  lines.push(`flags=${report.flags.length > 0 ? report.flags.join(",") : "NONE"}`);
  return lines.join("\n");
}
