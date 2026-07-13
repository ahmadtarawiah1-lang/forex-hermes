import { fetchKlines } from "./market";
import { evaluateCrossover } from "./strategy";
import { evaluateRisk } from "./risk";
import { checkMemory } from "./adaptiveFilter";
import { appendLedgerRow, appendLearning, ensureMemoryFiles, readLedger } from "./memory";
import { Candle, Decision, Mode, RiskConfig, StrategyConfig } from "./types";

export interface ReplayTrade {
  setupIndex: number;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  exitReason: string;
  quantity: number;
  pnl: number;
  outcome: "WIN" | "LOSS";
}

export interface ReplaySkip {
  setupIndex: number;
  time: string;
  reason: string;
}

export interface ReplaySummary {
  totalSetups: number;
  trades: ReplayTrade[];
  skips: ReplaySkip[];
  wins: number;
  losses: number;
  winRate: number;
  avgPnl: number;
  bestTrade: ReplayTrade | null;
  worstTrade: ReplayTrade | null;
  maxDrawdownPct: number;
  endingEquity: number;
}

const MAX_LOOKAHEAD_CANDLES = 20;

function simulateForwardExit(
  candles: Candle[],
  entryIndex: number,
  stopPrice: number,
  takeProfitPrice: number,
  fastPeriod: number,
  slowPeriod: number
): { exitIndex: number; exitPrice: number; exitReason: string } {
  const lastIndex = Math.min(candles.length - 1, entryIndex + MAX_LOOKAHEAD_CANDLES);

  for (let j = entryIndex + 1; j <= lastIndex; j++) {
    const candle = candles[j];
    if (candle.low <= stopPrice) {
      return { exitIndex: j, exitPrice: stopPrice, exitReason: "stop-loss hit" };
    }
    if (candle.high >= takeProfitPrice) {
      return { exitIndex: j, exitPrice: takeProfitPrice, exitReason: "take-profit hit" };
    }
    const signal = evaluateCrossover(candles, j, fastPeriod, slowPeriod);
    if (signal && signal.action === "SELL") {
      return { exitIndex: j, exitPrice: candle.close, exitReason: "bearish crossover exit signal" };
    }
  }

  return {
    exitIndex: lastIndex,
    exitPrice: candles[lastIndex].close,
    exitReason: `timeout after ${MAX_LOOKAHEAD_CANDLES} candles`,
  };
}

async function loadHistoricalCandles(strategy: StrategyConfig): Promise<Candle[]> {
  // market.ts pages this automatically past Coinbase's 300-candle-per-request cap.
  return fetchKlines(strategy.symbol, strategy.interval, 1000);
}

export async function runReplay(
  strategy: StrategyConfig,
  riskConfig: RiskConfig,
  mode: Mode,
  cooldownMs: number
): Promise<ReplaySummary> {
  ensureMemoryFiles();
  const candles = await loadHistoricalCandles(strategy);

  // The same rolling window of historical candles gets re-fetched on every
  // scheduled run, so most setups are the same ones seen last run. Without
  // this guard, an hourly job would re-log near-duplicate rows for the same
  // real trade every hour, flooding the ledger and corrupting the "N new
  // closed trades" count reflection relies on.
  const existingKeys = new Set(
    readLedger().map((row) => `${row.mode}|${row.symbol}|${row.timestamp}`)
  );
  function alreadyLogged(mode: Mode, symbol: string, timestamp: string): boolean {
    return existingKeys.has(`${mode}|${symbol}|${timestamp}`);
  }
  function markLogged(mode: Mode, symbol: string, timestamp: string): void {
    existingKeys.add(`${mode}|${symbol}|${timestamp}`);
  }

  const trades: ReplayTrade[] = [];
  const skips: ReplaySkip[] = [];
  let runningEquity = riskConfig.startingEquity;
  let peakEquity = runningEquity;
  let maxDrawdownPct = 0;
  let totalSetups = 0;
  let inTradeUntil = -1;
  let learnedLossThisRun = false;

  for (let i = 1; i < candles.length; i++) {
    if (i <= inTradeUntil) continue;

    const signal = evaluateCrossover(candles, i, strategy.fastPeriod, strategy.slowPeriod);
    if (!signal || signal.action !== "BUY") continue;

    totalSetups++;
    const entryPrice = candles[i].close;
    const entryTime = new Date(candles[i].closeTime).toISOString();

    if (mode === "memory") {
      const memCheck = checkMemory(strategy.symbol, "BUY", entryTime, cooldownMs);
      if (memCheck.blocked) {
        skips.push({ setupIndex: i, time: entryTime, reason: memCheck.reason });
        if (!alreadyLogged("memory", strategy.symbol, entryTime)) {
          const decision: Decision = {
            timestamp: entryTime,
            symbol: strategy.symbol,
            action: "SKIP",
            price: entryPrice,
            quantity: 0,
            reason: memCheck.reason,
            mode: "memory",
            outcome: "NONE",
            pnl: 0,
          };
          appendLedgerRow(decision);
          markLogged("memory", strategy.symbol, entryTime);
        }
        continue;
      }
    }

    const risk = evaluateRisk("BUY", entryPrice, riskConfig, {
      equity: runningEquity,
      dayStartEquity: runningEquity,
      dayRealizedPnl: 0,
    });

    if (!risk.approved) {
      skips.push({ setupIndex: i, time: entryTime, reason: risk.reason });
      if (!alreadyLogged(mode, strategy.symbol, entryTime)) {
        appendLedgerRow({
          timestamp: entryTime,
          symbol: strategy.symbol,
          action: "SKIP",
          price: entryPrice,
          quantity: 0,
          reason: risk.reason,
          mode,
          outcome: "NONE",
          pnl: 0,
        });
        markLogged(mode, strategy.symbol, entryTime);
      }
      continue;
    }

    const exit = simulateForwardExit(
      candles,
      i,
      risk.stopPrice,
      risk.takeProfitPrice,
      strategy.fastPeriod,
      strategy.slowPeriod
    );

    const pnl = (exit.exitPrice - entryPrice) * risk.quantity;
    const outcome: "WIN" | "LOSS" = pnl >= 0 ? "WIN" : "LOSS";
    runningEquity += pnl;
    peakEquity = Math.max(peakEquity, runningEquity);
    const drawdownPct = peakEquity > 0 ? (peakEquity - runningEquity) / peakEquity : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);

    const exitTime = new Date(candles[exit.exitIndex].closeTime).toISOString();

    const trade: ReplayTrade = {
      setupIndex: i,
      entryTime,
      entryPrice,
      exitTime,
      exitPrice: exit.exitPrice,
      exitReason: exit.exitReason,
      quantity: risk.quantity,
      pnl,
      outcome,
    };
    trades.push(trade);
    inTradeUntil = exit.exitIndex;

    if (!alreadyLogged(mode, strategy.symbol, entryTime)) {
      appendLedgerRow({
        timestamp: entryTime,
        symbol: strategy.symbol,
        action: "BUY",
        price: entryPrice,
        quantity: risk.quantity,
        reason: `${signal.reason} Exit: ${exit.exitReason} at ${exit.exitPrice.toFixed(2)}.`,
        mode,
        outcome,
        pnl,
      });
      markLogged(mode, strategy.symbol, entryTime);

      if (outcome === "LOSS" && !learnedLossThisRun) {
        appendLearning(
          `${strategy.symbol} BUY crossover entered at ${entryPrice.toFixed(2)} on ${entryTime} ` +
            `closed as a LOSS (${exit.exitReason} at ${exit.exitPrice.toFixed(2)}, pnl $${pnl.toFixed(2)}). ` +
            `Treat repeats of this setup with caution.`
        );
        learnedLossThisRun = true;
      } else if (outcome === "LOSS") {
        appendLearning(
          `${strategy.symbol} BUY crossover entered at ${entryPrice.toFixed(2)} on ${entryTime} ` +
            `closed as another LOSS (${exit.exitReason} at ${exit.exitPrice.toFixed(2)}, pnl $${pnl.toFixed(2)}).`
        );
      }
    }
  }

  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.filter((t) => t.outcome === "LOSS").length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const avgPnl = trades.length > 0 ? trades.reduce((s, t) => s + t.pnl, 0) / trades.length : 0;
  const bestTrade = trades.length > 0 ? trades.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const worstTrade = trades.length > 0 ? trades.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;

  return {
    totalSetups,
    trades,
    skips,
    wins,
    losses,
    winRate,
    avgPnl,
    bestTrade,
    worstTrade,
    maxDrawdownPct,
    endingEquity: runningEquity,
  };
}
