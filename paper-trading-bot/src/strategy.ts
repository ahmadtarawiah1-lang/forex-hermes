import { Candle, StrategySignal } from "./types";

export function sma(candles: Candle[], period: number, endIndex: number): number | null {
  if (endIndex - period + 1 < 0) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    sum += candles[i].close;
  }
  return sum / period;
}

/**
 * Evaluates the 9/21 MA crossover strategy at `endIndex` (the most recent
 * closed candle under consideration). Only fires BUY/SELL on a *fresh*
 * crossover — i.e. the relationship flipped between the prior candle and
 * this one — not merely because fast is already above/below slow.
 */
export function evaluateCrossover(
  candles: Candle[],
  endIndex: number,
  fastPeriod: number,
  slowPeriod: number
): StrategySignal | null {
  if (endIndex < 1) return null;

  const fastMA = sma(candles, fastPeriod, endIndex);
  const slowMA = sma(candles, slowPeriod, endIndex);
  const prevFastMA = sma(candles, fastPeriod, endIndex - 1);
  const prevSlowMA = sma(candles, slowPeriod, endIndex - 1);

  if (fastMA === null || slowMA === null || prevFastMA === null || prevSlowMA === null) {
    return null;
  }

  const wasBelow = prevFastMA <= prevSlowMA;
  const isAbove = fastMA > slowMA;
  const wasAbove = prevFastMA >= prevSlowMA;
  const isBelow = fastMA < slowMA;

  if (wasBelow && isAbove) {
    return {
      action: "BUY",
      fastMA,
      slowMA,
      reason: `Fast MA(${fastPeriod})=${fastMA.toFixed(2)} crossed above Slow MA(${slowPeriod})=${slowMA.toFixed(2)} on this candle (fresh bullish crossover).`,
    };
  }

  if (wasAbove && isBelow) {
    return {
      action: "SELL",
      fastMA,
      slowMA,
      reason: `Fast MA(${fastPeriod})=${fastMA.toFixed(2)} crossed below Slow MA(${slowPeriod})=${slowMA.toFixed(2)} on this candle (fresh bearish crossover).`,
    };
  }

  return {
    action: "HOLD",
    fastMA,
    slowMA,
    reason: `No fresh crossover. Fast MA(${fastPeriod})=${fastMA.toFixed(2)}, Slow MA(${slowPeriod})=${slowMA.toFixed(2)}.`,
  };
}
