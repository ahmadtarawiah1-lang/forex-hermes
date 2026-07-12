import { LedgerRow, readLedger, readLearnings } from "./memory";

export interface MemoryCheckResult {
  blocked: boolean;
  reason: string;
  matchedLedgerRow: LedgerRow | null;
  matchedLearningsWarning: boolean;
}

/**
 * Before any future BUY or SELL: has this symbol lost on a similar setup
 * before, does learnings.md warn about this setup, is this signal repeating
 * a known bad trade? Only real ledger/learnings entries can trigger a block
 * — nothing here is seeded.
 */
export function checkMemory(symbol: string, action: "BUY" | "SELL"): MemoryCheckResult {
  const ledger = readLedger();
  const priorLoss = ledger.find(
    (row) => row.symbol === symbol && row.action === action && row.outcome === "LOSS"
  );

  const learnings = readLearnings();
  const learningsWarns = learnings.includes(`${symbol}`) && learnings.toLowerCase().includes("loss");

  if (priorLoss) {
    return {
      blocked: true,
      reason:
        `Blocked by memory: a prior real ${action} on ${symbol} at price ${priorLoss.price} ` +
        `closed as a LOSS (logged ${priorLoss.timestamp}). Repeating a known bad setup — SKIP.`,
      matchedLedgerRow: priorLoss,
      matchedLearningsWarning: learningsWarns,
    };
  }

  if (learningsWarns) {
    return {
      blocked: true,
      reason: `Blocked by memory: learnings.md contains a warning about ${symbol} losses. SKIP.`,
      matchedLedgerRow: null,
      matchedLearningsWarning: true,
    };
  }

  return {
    blocked: false,
    reason: `No prior ${symbol} ${action} loss found in ledger.csv, and no matching warning in learnings.md.`,
    matchedLedgerRow: null,
    matchedLearningsWarning: false,
  };
}
