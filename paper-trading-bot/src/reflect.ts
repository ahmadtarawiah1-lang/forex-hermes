import { archiveState, loadGoal, loadState, saveState } from "./config";
import { appendLearning, LedgerRow, readLedger } from "./memory";

export interface ReflectionResult {
  changed: boolean;
  reason: string;
  newClosedTrades: number;
  winRate: number | null;
  drawdownPct: number | null;
  decidedBy?: "heuristic" | "llm";
}

function computeDrawdownPct(rows: LedgerRow[], startingEquity: number): number {
  let equity = startingEquity;
  let peak = startingEquity;
  let maxDrawdown = 0;
  for (const row of rows) {
    equity += row.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return maxDrawdown;
}

/**
 * Scores the last `lookbackTrades` real closed trades against goal.json and
 * changes at most one variable — tighten risk if drawdown breached the goal,
 * widen the memory cooldown if win rate is below target, or nothing if the
 * goal is already being met. Never both in the same reflection. If the
 * relevant lever is already at its floor/ceiling (a no-op), falls back to
 * the other lever instead of reporting a false "changed" no-op; if both are
 * maxed out, honestly reports that nothing could be adjusted.
 */
export function reflect(): ReflectionResult {
  const goal = loadGoal();
  const state = loadState();
  const ledger = readLedger();
  const closed = ledger.filter((row) => row.outcome === "WIN" || row.outcome === "LOSS");
  const newClosedTrades = closed.length - state.lastReflectedTradeCount;

  if (newClosedTrades < goal.reflectionEvery) {
    return {
      changed: false,
      reason:
        `Only ${Math.max(0, newClosedTrades)} new closed trade(s) since the last reflection; ` +
        `need ${goal.reflectionEvery} before reflecting again.`,
      newClosedTrades,
      winRate: null,
      drawdownPct: null,
      decidedBy: "heuristic",
    };
  }

  const recent = closed.slice(-goal.lookbackTrades);
  const wins = recent.filter((row) => row.outcome === "WIN").length;
  const winRate = recent.length > 0 ? wins / recent.length : 0;
  const drawdownPct = computeDrawdownPct(recent, state.risk.startingEquity);

  const prevVersion = JSON.parse(JSON.stringify(state));
  let reason: string;
  let changed = false;

  if (drawdownPct >= goal.maxAcceptableDrawdownPct) {
    const newStopLoss = Math.max(0.005, +(state.risk.stopLossPct - 0.005).toFixed(4));
    if (newStopLoss !== state.risk.stopLossPct) {
      reason =
        `Drawdown over the last ${recent.length} closed trades was ${(drawdownPct * 100).toFixed(1)}%, ` +
        `over the ${(goal.maxAcceptableDrawdownPct * 100).toFixed(1)}% goal limit. Tightening stop-loss/risk ` +
        `from ${(state.risk.stopLossPct * 100).toFixed(1)}% to ${(newStopLoss * 100).toFixed(1)}% (risk % per ` +
        `trade moves with it, keeping the no-leverage invariant) and scaling take-profit to match the 2:1 ratio.`;
      state.risk.stopLossPct = newStopLoss;
      state.risk.riskPctPerTrade = newStopLoss;
      state.risk.takeProfitPct = +(newStopLoss * 2).toFixed(4);
      changed = true;
    } else {
      reason =
        `Drawdown over the last ${recent.length} closed trades was ${(drawdownPct * 100).toFixed(1)}%, ` +
        `over the ${(goal.maxAcceptableDrawdownPct * 100).toFixed(1)}% goal limit, but stop-loss/risk is already ` +
        `at its ${(newStopLoss * 100).toFixed(1)}% floor and can't be tightened further. No lever left to pull ` +
        `automatically here — this needs a human look at the strategy itself.`;
    }
  } else if (winRate < goal.targetWinRate) {
    const newCooldown = Math.min(72, state.memory.cooldownHours + 12);
    if (newCooldown !== state.memory.cooldownHours) {
      reason =
        `Win rate over the last ${recent.length} closed trades was ${(winRate * 100).toFixed(1)}%, below the ` +
        `${(goal.targetWinRate * 100).toFixed(1)}% goal. Extending the memory cooldown from ` +
        `${state.memory.cooldownHours}h to ${newCooldown}h so a loss is avoided for longer before repeating.`;
      state.memory.cooldownHours = newCooldown;
      changed = true;
    } else {
      // Cooldown is already at its ceiling and can't be widened any further —
      // fall back to the other lever (risk) instead of silently reporting a
      // "changed" no-op (the v6/v7 bug: cooldownHours went 72h -> 72h but the
      // version and lastReflectedTradeCount still advanced as if it had).
      const newStopLoss = Math.max(0.005, +(state.risk.stopLossPct - 0.005).toFixed(4));
      if (newStopLoss !== state.risk.stopLossPct) {
        reason =
          `Win rate over the last ${recent.length} closed trades was ${(winRate * 100).toFixed(1)}%, below the ` +
          `${(goal.targetWinRate * 100).toFixed(1)}% goal, and the memory cooldown is already at its ${newCooldown}h ` +
          `ceiling and can't be widened further. Tightening stop-loss/risk from ` +
          `${(state.risk.stopLossPct * 100).toFixed(1)}% to ${(newStopLoss * 100).toFixed(1)}% instead (risk % per ` +
          `trade moves with it) and scaling take-profit to match the 2:1 ratio.`;
        state.risk.stopLossPct = newStopLoss;
        state.risk.riskPctPerTrade = newStopLoss;
        state.risk.takeProfitPct = +(newStopLoss * 2).toFixed(4);
        changed = true;
      } else {
        reason =
          `Win rate over the last ${recent.length} closed trades was ${(winRate * 100).toFixed(1)}%, below the ` +
          `${(goal.targetWinRate * 100).toFixed(1)}% goal, but both the memory cooldown (${newCooldown}h ceiling) ` +
          `and stop-loss/risk (${(state.risk.stopLossPct * 100).toFixed(1)}% floor) are already at their limits. ` +
          `No lever left to pull automatically here — this needs a human look at the strategy itself.`;
      }
    }
  } else {
    reason =
      `Win rate ${(winRate * 100).toFixed(1)}% meets the ${(goal.targetWinRate * 100).toFixed(1)}% goal and ` +
      `drawdown ${(drawdownPct * 100).toFixed(1)}% is within the ${(goal.maxAcceptableDrawdownPct * 100).toFixed(1)}% ` +
      `limit. No change.`;
  }

  if (changed) {
    archiveState(prevVersion);
    state.version += 1;
  }
  state.updatedAt = new Date().toISOString();
  state.lastReflectedTradeCount = closed.length;
  saveState(state);

  if (changed) {
    appendLearning(`Reflection v${state.version}: ${reason}`);
  }

  return { changed, reason, newClosedTrades, winRate, drawdownPct, decidedBy: "heuristic" };
}
