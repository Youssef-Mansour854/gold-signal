import type {
  Bar,
  Direction,
  EvaluateInput,
  EvaluatorEvent,
  EvaluatorOutcome,
  ResolvedBy,
  Tick,
} from "./types.ts";

export const EVALUATOR_VERSION = "v1.0.0";
const OUNCES_PER_0_01_LOT = 1; // 100 oz per lot in this project's contract model.

function signOf(direction: Direction): number {
  return direction === "BUY" ? 1 : -1;
}

function midOf(bar: Bar): number {
  if (bar.bid !== undefined && bar.ask !== undefined) return (bar.bid + bar.ask) / 2;
  return (bar.o + bar.h + bar.l + bar.c) / 4;
}

/** Executable price on the requested side of the book for an OHLC field. */
function executable(bar: Bar, field: "o" | "h" | "l" | "c", useAsk: boolean, spread: number): number {
  const mid = midOf(bar);
  if (bar.bid !== undefined && bar.ask !== undefined) {
    const offset = useAsk ? bar.ask - mid : bar.bid - mid;
    return bar[field] + offset;
  }
  return bar[field] + (useAsk ? spread / 2 : -spread / 2);
}

function tickPrice(tick: Tick, useAsk: boolean, spread: number): number | null {
  if (useAsk) {
    if (tick.ask !== undefined) return tick.ask;
    return tick.price === undefined ? null : tick.price + spread / 2;
  }
  if (tick.bid !== undefined) return tick.bid;
  return tick.price === undefined ? null : tick.price - spread / 2;
}

function noFill(input: EvaluateInput, reason: string): { outcome: EvaluatorOutcome; events: EvaluatorEvent[] } {
  const { signal, bars, costModel } = input;
  const from = bars[0]?.ts_open ?? signal.bar_ts;
  const to = bars.at(-1)?.ts_open ?? signal.bar_ts;
  return {
    outcome: {
      strategy_id: signal.strategy_id,
      evaluator_version: input.evaluatorVersion ?? EVALUATOR_VERSION,
      entry_rule_version: input.entryRule.version,
      cost_model_version: costModel.version,
      entry_time: new Date(signal.published_at),
      entry_price: signal.entry_ref,
      exit_time: new Date(signal.published_at),
      exit_price: signal.entry_ref,
      exit_type: "NOT_FILLED",
      exit_reason_code: reason,
      reason_codes: [reason],
      ambiguous: false,
      resolved_by: "assumed",
      gross: 0,
      slippage_cost: 0,
      commission_cost: 0,
      net: 0,
      r_planned: signal.planned_risk_usd_per_001lot,
      r_realized: 0,
      mfe: 0,
      mae: 0,
      duration_s: 0,
      evaluation_window: { from, to },
      data_range_ref: {
        source: input.source ?? "unknown",
        symbol: input.symbol ?? "XAU/USD",
        tf: input.tf ?? "tick",
        from,
        to,
      },
    },
    events: [],
  };
}

/**
 * Pure evaluator. It never reads a clock, a database or a random source.
 * Every decision is derived from the supplied signal, bars, ticks and versions.
 */
export function evaluate(input: EvaluateInput): { outcome: EvaluatorOutcome; events: EvaluatorEvent[] } {
  const { signal, bars, ticks = [], entryRule, costModel, strategyParams } = input;
  const sign = signOf(signal.direction);
  // Entry pays the ask for BUY / receives the bid for SELL. Evaluation of an
  // open position is the opposite: longs are judged on bid, shorts on ask.
  const entryUseAsk = signal.direction === "BUY";
  const evalUseAsk = signal.direction === "SELL";
  const spread = costModel.spread_usd;
  const sortedBars = [...bars].sort((a, b) => a.ts_open.getTime() - b.ts_open.getTime());
  if (sortedBars.length === 0) return noFill(input, "NO_FILL_NO_DATA");

  const earliest = new Date(signal.published_at.getTime() + entryRule.definition.entry_delay_seconds * 1000);
  const candidates = sortedBars.filter(
    (bar) => bar.ts_open >= earliest && bar.ts_open >= signal.bar_ts,
  );
  if (candidates.length === 0) return noFill(input, "NO_FILL_NO_QUOTE_AFTER_DELAY");

  const isTriggered = signal.order_type === "limit" || signal.order_type === "zone";
  const triggerLevel = isTriggered ? signal.entry_ref : null;
  const entryBar = isTriggered
    ? candidates.find((bar) => bar.l <= (triggerLevel as number) && bar.h >= (triggerLevel as number))
    : candidates[0];
  if (!entryBar) return noFill(input, "NO_FILL_PRICE_NEVER_TRIGGERED");

  const entryTime = new Date(entryBar.ts_open);
  const entryPrice = isTriggered
    ? (triggerLevel as number)
    : executable(entryBar, "o", entryUseAsk, spread);
  const events: EvaluatorEvent[] = [{
    ts: entryTime,
    type: "ENTRY",
    price: entryPrice,
    reason_code: isTriggered ? "ENTRY_TRIGGERED" : "ENTRY_FIRST_EXECUTABLE",
  }];

  const risk = Math.abs(signal.entry_ref - signal.stop);
  const plannedRisk = signal.planned_risk_usd_per_001lot;
  const timeoutMs = strategyParams.timeoutMinutes * 60_000;
  const afterEntry = sortedBars.filter((bar) => bar.ts_open > entryBar.ts_open);

  let activeStop = signal.stop;
  let mfe = 0;
  let mae = 0;
  let exitType: EvaluatorOutcome["exit_type"] = "TIMEOUT";
  let exitReason = "TIMEOUT_END_OF_DATA";
  let exitPrice = entryPrice;
  let exitTime = new Date(entryTime);
  let ambiguous = false;
  let resolvedBy: ResolvedBy = "assumed_stop";
  const reasonCodes: string[] = [isTriggered ? "ENTRY_TRIGGERED" : "ENTRY_FIRST_EXECUTABLE"];

  for (let index = 0; index < afterEntry.length; index += 1) {
    const bar = afterEntry[index];
    const openPrice = executable(bar, "o", evalUseAsk, spread);
    const adverse = executable(bar, sign === 1 ? "l" : "h", evalUseAsk, spread);
    const favorable = executable(bar, sign === 1 ? "h" : "l", evalUseAsk, spread);

    mfe = Math.max(mfe, (favorable - entryPrice) * sign * OUNCES_PER_0_01_LOT);
    mae = Math.min(mae, (adverse - entryPrice) * sign * OUNCES_PER_0_01_LOT);

    const stopTouched = sign === 1 ? adverse <= activeStop : adverse >= activeStop;
    const targetTouched = sign === 1 ? favorable >= signal.target : favorable <= signal.target;
    const gapStop = sign === 1 ? openPrice <= activeStop : openPrice >= activeStop;
    const gapTarget = sign === 1 ? openPrice >= signal.target : openPrice <= signal.target;

    let decision: "STOP" | "TARGET" | null = null;
    let decisionPrice = 0;
    let decisionReason = "";

    if (gapStop) {
      decision = "STOP";
      decisionPrice = openPrice;
      decisionReason = "GAP_STOP_FILLED_AT_OPEN";
    } else if (gapTarget) {
      decision = "TARGET";
      decisionPrice = signal.target;
      decisionReason = "GAP_TARGET_FILLED_AT_TARGET";
    } else if (stopTouched && targetTouched) {
      const finer = ticks.filter((tick) => tick.ts > bar.ts_open
        && (index + 1 >= afterEntry.length || tick.ts < afterEntry[index + 1].ts_open));
      let first: { type: "STOP" | "TARGET"; price: number } | null = null;
      for (const tick of finer.sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
        const price = tickPrice(tick, evalUseAsk, spread);
        if (price === null) continue;
        const hitStop = sign === 1 ? price <= activeStop : price >= activeStop;
        const hitTarget = sign === 1 ? price >= signal.target : price <= signal.target;
        if (hitStop || hitTarget) {
          first = { type: hitStop ? "STOP" : "TARGET", price };
          break;
        }
      }
      if (first) {
        decision = first.type;
        decisionPrice = first.price;
        decisionReason = "RESOLVED_BY_FINER_DATA";
        resolvedBy = input.fine_source ?? "tick";
      } else {
        decision = "STOP";
        decisionPrice = activeStop;
        decisionReason = "AMBIGUOUS_ASSUMED_STOP";
        ambiguous = true;
        resolvedBy = "assumed_stop";
      }
    } else if (stopTouched) {
      decision = "STOP";
      decisionPrice = activeStop;
      decisionReason = "STOP_TOUCH";
    } else if (targetTouched) {
      decision = "TARGET";
      decisionPrice = signal.target;
      decisionReason = "TARGET_TOUCH";
    }

    if (decision) {
      exitType = decision;
      exitReason = decisionReason;
      exitPrice = decisionPrice;
      exitTime = new Date(bar.ts_open);
      reasonCodes.push(decisionReason);
      events.push({
        ts: exitTime,
        type: decision === "STOP" ? "TOUCH_STOP" : "TOUCH_TARGET",
        price: decisionPrice,
        reason_code: decisionReason,
      });
      break;
    }

    if (strategyParams.trailingAfterR !== undefined && risk > 0) {
      const favorableR = ((favorable - entryPrice) * sign) / risk;
      if (favorableR >= strategyParams.trailingAfterR) {
        const candidate = entryPrice + sign * strategyParams.trailingAfterR * risk;
        const improved = sign === 1 ? candidate > activeStop : candidate < activeStop;
        if (improved) {
          events.push({
            ts: new Date(bar.ts_open),
            type: "TRAIL_UPDATE",
            price: candidate,
            reason_code: "TRAIL_AFTER_R",
          });
          reasonCodes.push("TRAIL_AFTER_R");
          // Trailing updates only take effect from the next closed bar.
          activeStop = candidate;
        }
      }
    }

    if (bar.ts_open.getTime() - entryTime.getTime() >= timeoutMs) {
      exitType = "TIMEOUT";
      exitReason = "TIMEOUT_STRATEGY";
      exitPrice = executable(bar, "c", evalUseAsk, spread);
      exitTime = new Date(bar.ts_open);
      reasonCodes.push(exitReason);
      events.push({ ts: exitTime, type: "TIMEOUT", price: exitPrice, reason_code: exitReason });
      break;
    }
  }

  events.push({ ts: exitTime, type: "EXIT", price: exitPrice, reason_code: exitReason });

  const gross = (exitPrice - entryPrice) * sign * OUNCES_PER_0_01_LOT;
  const slippageCost = costModel.slippage_usd;
  const commissionCost = costModel.commission_usd;
  const net = gross - slippageCost - commissionCost;
  const from = sortedBars[0].ts_open;
  const to = sortedBars.at(-1)!.ts_open;

  return {
    outcome: {
      strategy_id: signal.strategy_id,
      evaluator_version: input.evaluatorVersion ?? EVALUATOR_VERSION,
      entry_rule_version: entryRule.version,
      cost_model_version: costModel.version,
      entry_time: entryTime,
      entry_price: entryPrice,
      exit_time: exitTime,
      exit_price: exitPrice,
      exit_type: exitType,
      exit_reason_code: exitReason,
      reason_codes: reasonCodes,
      ambiguous,
      resolved_by: resolvedBy,
      gross,
      slippage_cost: slippageCost,
      commission_cost: commissionCost,
      net,
      r_planned: plannedRisk,
      r_realized: plannedRisk > 0 ? net / plannedRisk : 0,
      mfe,
      mae,
      duration_s: Math.max(0, (exitTime.getTime() - entryTime.getTime()) / 1000),
      evaluation_window: { from, to },
      data_range_ref: {
        source: input.source ?? "unknown",
        symbol: input.symbol ?? "XAU/USD",
        tf: input.tf ?? "tick",
        from,
        to,
      },
    },
    events,
  };
}
