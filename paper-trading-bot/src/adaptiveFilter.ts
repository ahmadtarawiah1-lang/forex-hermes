import { LedgerRow, readLedger } from "./memory";

export interface MemoryCheckResult {
  blocked: boolean;
  reason: string;
  matchedLedgerRow: LedgerRow | null;
}

export const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours, used only if no state is loaded

/**
 * Before any future BUY or SELL: has this symbol lost on a similar setup
 * recently, is this signal repeating a known-bad trade? Only real ledger
 * entries can trigger a block — nothing here is seeded.
 *
 * This is a bounded cooldown, not a permanent ban: a loss blocks repeats of
 * that symbol/action for cooldownMs, then trading resumes. A permanent "one
 * loss ever = blocked forever" rule would be a dead end — once blocked, no
 * new trade can ever execute to prove the setup works again, so the block
 * could never lift. cooldownMs is configurable (see src/config.ts,
 * data/strategy_state.json) — reflection can widen it over time.
 */
export function checkMemory(
  symbol: string,
  action: "BUY" | "SELL",
  asOf: string,
  cooldownMs: number = DEFAULT_COOLDOWN_MS
): MemoryCheckResult {
  const ledger = readLedger();
  const asOfMs = new Date(asOf).getTime();
  const cooldownHours = cooldownMs / 3_600_000;

  const recentLoss = ledger
    .filter((row) => row.symbol === symbol && row.action === action && row.outcome === "LOSS")
    .filter((row) => {
      const rowMs = new Date(row.timestamp).getTime();
      return rowMs <= asOfMs && asOfMs - rowMs < cooldownMs;
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

  if (recentLoss) {
    const hoursAgo = ((asOfMs - new Date(recentLoss.timestamp).getTime()) / (60 * 60 * 1000)).toFixed(1);
    return {
      blocked: true,
      reason:
        `Blocked by memory: a real ${action} on ${symbol} at price ${recentLoss.price} closed as a ` +
        `LOSS ${hoursAgo}h ago (within the ${cooldownHours}h cooldown). SKIP.`,
      matchedLedgerRow: recentLoss,
    };
  }

  return {
    blocked: false,
    reason: `No ${symbol} ${action} loss within the last ${cooldownHours}h in ledger.csv.`,
    matchedLedgerRow: null,
  };
}
