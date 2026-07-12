import { Decision, DecisionAction, Mode } from "./types";

/**
 * Simulates a paper order. This never calls a real broker/exchange order
 * endpoint — there isn't one wired into this project at all.
 */
export function simulatePaperOrder(
  symbol: string,
  action: DecisionAction,
  price: number,
  quantity: number,
  reason: string,
  mode: Mode
): Decision {
  return {
    timestamp: new Date().toISOString(),
    symbol,
    action,
    price,
    quantity,
    reason,
    mode,
    outcome: action === "BUY" || action === "SELL" ? "OPEN" : "NONE",
    pnl: 0,
  };
}
