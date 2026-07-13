import * as fs from "fs";
import * as path from "path";
import { RiskConfig, StrategyConfig } from "./types";

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_PATH = path.join(DATA_DIR, "strategy_state.json");
const GOAL_PATH = path.join(DATA_DIR, "goal.json");
const HISTORY_DIR = path.join(DATA_DIR, "history");

export interface MemoryConfig {
  cooldownHours: number;
}

export interface StrategyState {
  version: number;
  updatedAt: string;
  strategy: StrategyConfig;
  risk: RiskConfig;
  memory: MemoryConfig;
  lastReflectedTradeCount: number;
}

export interface Goal {
  targetWinRate: number;
  maxAcceptableDrawdownPct: number;
  reflectionEvery: number;
  lookbackTrades: number;
}

const DEFAULT_STATE: StrategyState = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  strategy: { symbol: "BTC-USD", interval: "5m", fastPeriod: 9, slowPeriod: 21 },
  risk: {
    startingEquity: 10_000,
    riskPctPerTrade: 0.02,
    stopLossPct: 0.02,
    takeProfitPct: 0.04,
    maxPositionPctOfEquity: 1.05,
    maxDailyDrawdownPct: 0.05,
  },
  memory: { cooldownHours: 24 },
  lastReflectedTradeCount: 0,
};

const DEFAULT_GOAL: Goal = {
  targetWinRate: 0.55,
  maxAcceptableDrawdownPct: 0.08,
  reflectionEvery: 10,
  lookbackTrades: 20,
};

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadState(): StrategyState {
  ensureDataDir();
  if (!fs.existsSync(STATE_PATH)) {
    saveState(DEFAULT_STATE);
    return DEFAULT_STATE;
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as StrategyState;
}

export function saveState(state: StrategyState): void {
  ensureDataDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

export function archiveState(state: StrategyState): void {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.writeFileSync(path.join(HISTORY_DIR, `v${state.version}.json`), JSON.stringify(state, null, 2) + "\n");
}

export function loadGoal(): Goal {
  ensureDataDir();
  if (!fs.existsSync(GOAL_PATH)) {
    fs.writeFileSync(GOAL_PATH, JSON.stringify(DEFAULT_GOAL, null, 2) + "\n");
    return DEFAULT_GOAL;
  }
  return JSON.parse(fs.readFileSync(GOAL_PATH, "utf-8")) as Goal;
}
