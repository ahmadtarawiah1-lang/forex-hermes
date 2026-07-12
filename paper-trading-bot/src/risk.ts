import { RiskConfig, RiskResult, SignalAction } from "./types";

export interface RiskState {
  equity: number;
  dayStartEquity: number;
  dayRealizedPnl: number;
}

/**
 * Sizes a BUY/SELL signal against 2%-of-equity risk, caps it at
 * maxPositionPctOfEquity of notional, and blocks all new trades once the
 * day's realized loss reaches maxDailyDrawdownPct of the day's starting
 * equity. Every branch returns a plain-English reason.
 */
export function evaluateRisk(
  action: SignalAction,
  price: number,
  config: RiskConfig,
  state: RiskState
): RiskResult {
  const dailyLoss = Math.max(0, -state.dayRealizedPnl);
  const dailyDrawdownPct = state.dayStartEquity > 0 ? dailyLoss / state.dayStartEquity : 0;

  if (dailyDrawdownPct >= config.maxDailyDrawdownPct) {
    return {
      approved: false,
      quantity: 0,
      positionValue: 0,
      stopPrice: 0,
      takeProfitPrice: 0,
      reason:
        `Max daily drawdown of ${(config.maxDailyDrawdownPct * 100).toFixed(1)}% reached ` +
        `($${dailyLoss.toFixed(2)} lost on $${state.dayStartEquity.toFixed(2)} starting equity today). ` +
        `No new trades until the next trading day.`,
    };
  }

  const riskAmount = state.equity * config.riskPctPerTrade;
  const stopDistance = price * config.stopLossPct;
  const quantity = riskAmount / stopDistance;
  const positionValue = quantity * price;
  const maxPositionValue = state.equity * config.maxPositionPctOfEquity;

  if (positionValue > maxPositionValue) {
    return {
      approved: false,
      quantity,
      positionValue,
      stopPrice: 0,
      takeProfitPrice: 0,
      reason:
        `Computed position value $${positionValue.toFixed(2)} exceeds the max position cap of ` +
        `$${maxPositionValue.toFixed(2)} (${(config.maxPositionPctOfEquity * 100).toFixed(0)}% of equity). SKIP.`,
    };
  }

  const stopPrice = action === "BUY" ? price * (1 - config.stopLossPct) : price * (1 + config.stopLossPct);
  const takeProfitPrice =
    action === "BUY" ? price * (1 + config.takeProfitPct) : price * (1 - config.takeProfitPct);

  return {
    approved: true,
    quantity,
    positionValue,
    stopPrice,
    takeProfitPrice,
    reason:
      `Risk check passed: sizing to risk ${(config.riskPctPerTrade * 100).toFixed(1)}% of equity ` +
      `($${riskAmount.toFixed(2)}) at a ${(config.stopLossPct * 100).toFixed(1)}% stop → ` +
      `quantity ${quantity.toFixed(6)}, position value $${positionValue.toFixed(2)}.`,
  };
}
