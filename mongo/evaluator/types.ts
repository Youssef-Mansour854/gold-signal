export type Direction = "BUY" | "SELL";
export type ExitType = "TARGET" | "STOP" | "TIMEOUT" | "NOT_FILLED";
export type ResolvedBy = "tick" | "m1" | "assumed_stop" | "assumed" | "legacy";
export type OrderType = "market" | "limit" | "zone";

export interface Bar {
  ts_open: Date;
  o: number;
  h: number;
  l: number;
  c: number;
  bid?: number;
  ask?: number;
  spread?: number;
  tf?: string;
}

export interface Tick {
  ts: Date;
  bid?: number;
  ask?: number;
  price?: number;
}

export interface SignalInput {
  strategy_id: string;
  direction: Direction;
  bar_ts: Date;
  published_at: Date;
  entry_ref: number;
  stop: number;
  target: number;
  planned_risk_usd_per_001lot: number;
  order_type?: OrderType;
  zone_low?: number;
  zone_high?: number;
  expires_at?: Date;
}

export interface EntryRuleDefinition {
  entry_delay_seconds: number;
  buy_price_field: "ask" | "bid" | "mid" | "last";
  sell_price_field: "ask" | "bid" | "mid" | "last";
  trigger: "first_executable" | "trade_through";
  derivation: "feed_bid_ask" | "cost_model_mid";
}

export interface EntryRule {
  version: string;
  definition: EntryRuleDefinition;
}

export interface CostModel {
  version: string;
  spread_usd: number;
  slippage_usd: number;
  commission_usd: number;
}

export interface StrategyParams {
  timeoutMinutes: number;
  targetsR: number[];
  stopPercent: number;
  ouncesPer0_01Lot?: number;
  trailingAfterR?: number;
}

export interface EvaluateInput {
  signal: SignalInput;
  bars: Bar[];
  ticks?: Tick[];
  entryRule: EntryRule;
  costModel: CostModel;
  strategyParams: StrategyParams;
  evaluatorVersion?: string;
  source?: string;
  symbol?: string;
  tf?: string;
  fine_source?: "tick" | "m1";
}

export interface EvaluatorEvent {
  ts: Date;
  type: "ENTRY" | "TOUCH_STOP" | "TOUCH_TARGET" | "TRAIL_UPDATE" | "TIMEOUT" | "EXIT";
  price: number;
  reason_code: string;
}

export interface EvaluatorOutcome {
  signal_id?: string;
  strategy_id: string;
  evaluator_version: string;
  entry_rule_version: string;
  cost_model_version: string;
  entry_time: Date;
  entry_price: number;
  exit_time: Date;
  exit_price: number;
  exit_type: ExitType;
  exit_reason_code: string;
  reason_codes: string[];
  ambiguous: boolean;
  resolved_by: ResolvedBy;
  gross: number;
  slippage_cost: number;
  commission_cost: number;
  net: number;
  r_planned: number;
  r_realized: number;
  mfe: number;
  mae: number;
  duration_s: number;
  evaluation_window: { from: Date; to: Date };
  data_range_ref: { source: string; symbol: string; tf: string; from: Date; to: Date };
}
