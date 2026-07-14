import { archiveState, Goal, listHistory, loadGoal, loadState, saveState, StrategyState } from "./config";
import { appendLearning, LedgerRow, readLedger } from "./memory";
import { reflect, ReflectionResult } from "./reflect";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

interface ProposedAdjustment {
  changed: boolean;
  stopLossPct?: number;
  takeProfitPct?: number;
  cooldownHours?: number;
  fastPeriod?: number;
  slowPeriod?: number;
  rationale: string;
}

const TOOL_SCHEMA = {
  name: "propose_adjustment",
  description:
    "Propose a bounded adjustment to the paper-trading bot's strategy, risk, and memory-cooldown " +
    "settings based on patterns in its own real recent trade outcomes, or propose leaving everything " +
    "unchanged. Every numeric field is optional and independently clamped to a safe range by the " +
    "caller afterward, so do not worry about exact precision — reason about direction and magnitude.",
  input_schema: {
    type: "object",
    properties: {
      changed: {
        type: "boolean",
        description: "true if you are proposing at least one parameter change, false if current settings should stay as-is",
      },
      stopLossPct: {
        type: "number",
        description: "New stop-loss fraction of entry price, e.g. 0.018 for 1.8%. Clamped to [0.005, 0.05]. Omit if unchanged.",
      },
      takeProfitPct: {
        type: "number",
        description: "New take-profit fraction of entry price. Clamped relative to the new stop-loss. Omit if unchanged.",
      },
      cooldownHours: {
        type: "number",
        description: "New memory cooldown in hours after a same-symbol/direction real loss. Clamped to [4, 72]. Omit if unchanged.",
      },
      fastPeriod: {
        type: "integer",
        description: "New fast moving-average period in candles. Clamped to [5, 15]. Omit if unchanged.",
      },
      slowPeriod: {
        type: "integer",
        description: "New slow moving-average period in candles. Clamped to [16, 40], and must stay above fastPeriod. Omit if unchanged.",
      },
      rationale: {
        type: "string",
        description: "2-4 sentence plain-English explanation, grounded in the specific trades you were shown, of what pattern led to this decision (or why no change is warranted).",
      },
    },
    required: ["changed", "rationale"],
  },
};

function categorizeExit(reason: string): string {
  if (reason.includes("stop-loss hit")) return "stop-loss";
  if (reason.includes("take-profit hit")) return "take-profit";
  if (reason.includes("crossover exit signal")) return "crossover-exit";
  if (reason.includes("timeout after")) return "timeout";
  return "other";
}

function summarizeExitTypes(recent: LedgerRow[]): string {
  const byType = new Map<string, { wins: number; losses: number }>();
  for (const row of recent) {
    if (row.outcome !== "WIN" && row.outcome !== "LOSS") continue;
    const type = categorizeExit(row.reason);
    const bucket = byType.get(type) ?? { wins: 0, losses: 0 };
    if (row.outcome === "WIN") bucket.wins++;
    else bucket.losses++;
    byType.set(type, bucket);
  }
  if (byType.size === 0) return "No exit-type data in this window.";
  return Array.from(byType.entries())
    .map(([type, { wins, losses }]) => {
      const total = wins + losses;
      const winRate = ((wins / total) * 100).toFixed(0);
      return `${type}: ${total} trades, ${winRate}% win rate (${wins}W/${losses}L)`;
    })
    .join("; ");
}

function summarizeMemoryPerformance(ledger: LedgerRow[]): string {
  const memoryRows = ledger.filter((row) => row.mode === "memory");
  const taken = memoryRows.filter((row) => row.action === "BUY");
  const skipped = memoryRows.filter((row) => row.action === "SKIP");
  if (taken.length === 0) {
    return `The current ${skipped.length > 0 ? "cooldown has blocked every setup it's seen so far" : "memory path has no data yet"}.`;
  }
  const wins = taken.filter((row) => row.outcome === "WIN").length;
  const winRate = ((wins / taken.length) * 100).toFixed(0);
  return (
    `Memory mode (current cooldown applied) has taken ${taken.length} of ${taken.length + skipped.length} ` +
    `setups it saw (${winRate}% win rate on the ones it took), skipping the rest under the active cooldown.`
  );
}

function describeSettingsDiff(prev: StrategyState, next: StrategyState): string {
  const parts: string[] = [];
  if (prev.risk.stopLossPct !== next.risk.stopLossPct) {
    parts.push(`stopLossPct ${prev.risk.stopLossPct} → ${next.risk.stopLossPct}`);
  }
  if (prev.risk.takeProfitPct !== next.risk.takeProfitPct) {
    parts.push(`takeProfitPct ${prev.risk.takeProfitPct} → ${next.risk.takeProfitPct}`);
  }
  if (prev.memory.cooldownHours !== next.memory.cooldownHours) {
    parts.push(`cooldownHours ${prev.memory.cooldownHours} → ${next.memory.cooldownHours}`);
  }
  if (prev.strategy.fastPeriod !== next.strategy.fastPeriod || prev.strategy.slowPeriod !== next.strategy.slowPeriod) {
    parts.push(
      `MA periods ${prev.strategy.fastPeriod}/${prev.strategy.slowPeriod} → ${next.strategy.fastPeriod}/${next.strategy.slowPeriod}`
    );
  }
  return parts.length > 0 ? parts.join(", ") : "no measurable change";
}

/**
 * Reconstructs the bot's own decision history: every past settings version,
 * what changed to produce it, and — critically — the real win rate of the
 * trades that happened *after* that decision took effect, so the model can
 * see whether its own past reasoning actually panned out instead of judging
 * every reflection in isolation with no memory of what it already tried.
 */
function summarizeReflectionHistory(currentState: StrategyState, closed: LedgerRow[]): string {
  const history = listHistory();
  const epochs = [...history, currentState];
  if (epochs.length === 1) {
    return "No prior reflection changes yet — this would be the first one.";
  }

  const lines: string[] = [];
  for (let i = 0; i < epochs.length; i++) {
    const start = epochs[i].lastReflectedTradeCount;
    const end = i + 1 < epochs.length ? epochs[i + 1].lastReflectedTradeCount : closed.length;
    const segment = closed.slice(start, end).filter((row) => row.outcome === "WIN" || row.outcome === "LOSS");
    const wins = segment.filter((row) => row.outcome === "WIN").length;
    const winRateStr = segment.length > 0 ? `${((wins / segment.length) * 100).toFixed(0)}% win rate` : "no closed trades yet";
    const diff = i === 0 ? "initial settings" : describeSettingsDiff(epochs[i - 1], epochs[i]);
    lines.push(`v${epochs[i].version} (${diff}): governed ${segment.length} closed trades, ${winRateStr}`);
  }
  return lines.join("\n");
}

function buildPrompt(
  state: StrategyState,
  goal: Goal,
  recent: LedgerRow[],
  fullLedger: LedgerRow[],
  closed: LedgerRow[]
): string {
  const tradeLines = recent
    .map((row, i) => {
      return (
        `${i + 1}. ${row.timestamp} | entry ${row.price.toFixed(2)} | pnl ${row.pnl >= 0 ? "+" : ""}${row.pnl.toFixed(2)} | ` +
        `${row.outcome} | mode=${row.mode} | ${row.reason}`
      );
    })
    .join("\n");

  return (
    `You are the periodic self-review step for a paper-trading bot (no real orders are ever placed; ` +
    `this is simulation only against real market data). It trades a 5-minute moving-average crossover ` +
    `strategy and re-evaluates its own settings every ${goal.reflectionEvery} newly closed trades.\n\n` +
    `Current configuration:\n` +
    `- symbol/interval: ${state.strategy.symbol} / ${state.strategy.interval}\n` +
    `- fast/slow MA period: ${state.strategy.fastPeriod} / ${state.strategy.slowPeriod}\n` +
    `- stopLossPct / riskPctPerTrade: ${state.risk.stopLossPct} (these two are always kept equal — no leveraged sizing)\n` +
    `- takeProfitPct: ${state.risk.takeProfitPct}\n` +
    `- memory cooldownHours: ${state.memory.cooldownHours}\n\n` +
    `Goal this bot is being steered toward:\n` +
    `- target win rate: ${(goal.targetWinRate * 100).toFixed(0)}%\n` +
    `- max acceptable drawdown: ${(goal.maxAcceptableDrawdownPct * 100).toFixed(0)}%\n\n` +
    `Your own decision history — what you (or the rule-based fallback) changed in the past, and how the ` +
    `real trades that followed each decision actually performed. Use this to judge whether your past ` +
    `reasoning was right before repeating or reversing it:\n` +
    `${summarizeReflectionHistory(state, closed)}\n\n` +
    `Win rate broken down by how the trade actually exited, over the trades shown below — a real pattern ` +
    `here (e.g. timeouts losing money while crossover-exits win) is more actionable than the aggregate ` +
    `win rate alone:\n` +
    `${summarizeExitTypes(recent)}\n\n` +
    `How the memory cooldown itself is performing: ${summarizeMemoryPerformance(fullLedger)}\n\n` +
    `The last ${recent.length} real closed trades (chronological, oldest first), each a genuine outcome ` +
    `from live Coinbase market data replayed through the strategy — nothing here is simulated or invented:\n` +
    `${tradeLines}\n\n` +
    `Look for real patterns (e.g. one exit type underperforming another, losses clustering around a ` +
    `time window, the crossover firing on noise, drawdown trending against the goal, a past decision that ` +
    `didn't actually help) and propose a small, bounded adjustment if one is genuinely justified by this ` +
    `data — or explicitly propose no change if the data doesn't support one. Do not overfit to a handful ` +
    `of trades; prefer no change when the sample is ambiguous, and be especially cautious about reversing ` +
    `a change you made only one checkpoint ago unless the evidence is clear. Call propose_adjustment with ` +
    `your decision.`
  );
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Applies the LLM's proposal on top of `state`, clamping every field to a
 * safe range regardless of what was proposed. The no-leverage invariant
 * (riskPctPerTrade === stopLossPct) and the daily-drawdown/position-size
 * caps are enforced here, never left to the model. Returns null if nothing
 * about the resulting state actually differs from `state`.
 */
function applyClamped(state: StrategyState, proposal: ProposedAdjustment): StrategyState | null {
  const next: StrategyState = JSON.parse(JSON.stringify(state));

  const newStopLoss = clampNumber(proposal.stopLossPct, 0.005, 0.05, state.risk.stopLossPct);
  next.risk.stopLossPct = +newStopLoss.toFixed(4);
  next.risk.riskPctPerTrade = next.risk.stopLossPct;

  const defaultTakeProfit = next.risk.stopLossPct * 2;
  const takeProfitMin = next.risk.stopLossPct * 1.2;
  const takeProfitMax = next.risk.stopLossPct * 5;
  next.risk.takeProfitPct = +clampNumber(proposal.takeProfitPct, takeProfitMin, takeProfitMax, defaultTakeProfit).toFixed(4);

  next.memory.cooldownHours = +clampNumber(proposal.cooldownHours, 4, 72, state.memory.cooldownHours).toFixed(1);

  // Clamping each bound independently can turn a nonsensical proposal (e.g.
  // fast=30, slow=10 — clearly swapped) into a technically-ordered but
  // degenerate pair (15/16, almost no separation). Require a minimum gap
  // on top of correct ordering, or reject the period change entirely.
  const proposedFast = Math.round(clampNumber(proposal.fastPeriod, 5, 15, state.strategy.fastPeriod));
  const proposedSlow = Math.round(clampNumber(proposal.slowPeriod, 16, 40, state.strategy.slowPeriod));
  if (proposedSlow - proposedFast >= 5) {
    next.strategy.fastPeriod = proposedFast;
    next.strategy.slowPeriod = proposedSlow;
  } // else: invalid or degenerate ordering proposed — leave existing periods untouched

  const nothingChanged =
    next.risk.stopLossPct === state.risk.stopLossPct &&
    next.risk.takeProfitPct === state.risk.takeProfitPct &&
    next.memory.cooldownHours === state.memory.cooldownHours &&
    next.strategy.fastPeriod === state.strategy.fastPeriod &&
    next.strategy.slowPeriod === state.strategy.slowPeriod;

  return nothingChanged ? null : next;
}

async function callAnthropic(apiKey: string, prompt: string): Promise<ProposedAdjustment> {
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        tools: [TOOL_SCHEMA],
        tool_choice: { type: "tool", name: "propose_adjustment" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error(`could not reach the Anthropic API: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API returned HTTP ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; input?: unknown }>;
  };
  const toolUse = data.content.find((block) => block.type === "tool_use");
  if (!toolUse || typeof toolUse.input !== "object" || toolUse.input === null) {
    throw new Error("response did not include a propose_adjustment tool call");
  }

  const input = toolUse.input as Record<string, unknown>;
  if (typeof input.changed !== "boolean" || typeof input.rationale !== "string") {
    throw new Error("propose_adjustment tool call was missing required fields");
  }

  return {
    changed: input.changed,
    stopLossPct: typeof input.stopLossPct === "number" ? input.stopLossPct : undefined,
    takeProfitPct: typeof input.takeProfitPct === "number" ? input.takeProfitPct : undefined,
    cooldownHours: typeof input.cooldownHours === "number" ? input.cooldownHours : undefined,
    fastPeriod: typeof input.fastPeriod === "number" ? input.fastPeriod : undefined,
    slowPeriod: typeof input.slowPeriod === "number" ? input.slowPeriod : undefined,
    rationale: input.rationale,
  };
}

/**
 * LLM-driven reflection: same trigger cadence as the rule-based `reflect()`,
 * but instead of a fixed two-lever heuristic, asks Claude to reason over the
 * actual recent trades and propose a change. Every proposed value is clamped
 * to a hard-coded safe range in `applyClamped` before ever touching
 * strategy_state.json — the model can influence direction and magnitude
 * within those bounds, never step outside them. Falls back to the
 * deterministic heuristic in `reflect()` whenever ANTHROPIC_API_KEY is
 * unset or the API call fails for any reason, so the hourly pipeline never
 * breaks on this.
 */
export async function reflectWithLLM(): Promise<ReflectionResult> {
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return reflect();
  }

  const recent = closed.slice(-goal.lookbackTrades);
  const wins = recent.filter((row) => row.outcome === "WIN").length;
  const winRate = recent.length > 0 ? wins / recent.length : 0;

  try {
    const proposal = await callAnthropic(apiKey, buildPrompt(state, goal, recent, ledger, closed));
    const prevVersion = JSON.parse(JSON.stringify(state)) as StrategyState;
    const next = proposal.changed ? applyClamped(state, proposal) : null;

    let result: StrategyState = state;
    let changed = false;
    let reason = proposal.rationale;

    if (next) {
      archiveState(prevVersion);
      next.version = state.version + 1;
      result = next;
      changed = true;
    } else if (proposal.changed) {
      reason = `${proposal.rationale} (Proposed values clamped back to current settings — treating as no change.)`;
    }

    result.updatedAt = new Date().toISOString();
    result.lastReflectedTradeCount = closed.length;
    saveState(result);

    appendLearning(
      `Reflection v${result.version} (LLM, ${MODEL})${changed ? "" : " — no change"}: ${reason}`
    );

    return { changed, reason, newClosedTrades, winRate, drawdownPct: null, decidedBy: "llm" };
  } catch (err) {
    appendLearning(
      `LLM reflection failed (${(err as Error).message}); falling back to rule-based reflection for this cycle.`
    );
    return reflect();
  }
}
