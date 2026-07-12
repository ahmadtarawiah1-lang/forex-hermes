export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export type SignalAction = "BUY" | "SELL" | "HOLD";
export type DecisionAction = "BUY" | "SELL" | "HOLD" | "SKIP";
export type Mode = "raw" | "memory";
export type Outcome = "WIN" | "LOSS" | "OPEN" | "NONE";

export interface StrategySignal {
  action: SignalAction;
  fastMA: number;
  slowMA: number;
  reason: string;
}

export interface RiskResult {
  approved: boolean;
  quantity: number;
  positionValue: number;
  stopPrice: number;
  takeProfitPrice: number;
  reason: string;
}

export interface Decision {
  timestamp: string;
  symbol: string;
  action: DecisionAction;
  price: number;
  quantity: number;
  reason: string;
  mode: Mode;
  outcome: Outcome;
  pnl: number;
}

export interface StrategyConfig {
  symbol: string;
  interval: string;
  fastPeriod: number;
  slowPeriod: number;
}

export interface RiskConfig {
  startingEquity: number;
  riskPctPerTrade: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxPositionPctOfEquity: number;
  maxDailyDrawdownPct: number;
}
