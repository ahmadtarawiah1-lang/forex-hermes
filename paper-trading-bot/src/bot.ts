import { fetchKlines } from "./market";
import { evaluateCrossover } from "./strategy";
import { evaluateRisk } from "./risk";
import { simulatePaperOrder } from "./execution";
import { RiskConfig, StrategyConfig } from "./types";

function log(label: string, message: string): void {
  console.log(`[${new Date().toISOString()}] ${label}: ${message}`);
}

/**
 * A single, stateless snapshot check: fetch recent real candles, compute
 * the strategy signal, risk-check it, and simulate a paper order if BUY or
 * SELL passes risk. This does not persist an open position across runs —
 * it reports what the bot would do right now.
 */
export async function scan(strategy: StrategyConfig, riskConfig: RiskConfig): Promise<void> {
  log("MARKET", `Fetching ${strategy.interval} candles for ${strategy.symbol} from Coinbase's public candles endpoint...`);

  const candles = await fetchKlines(strategy.symbol, strategy.interval, 50);
  const lastIndex = candles.length - 1;
  const lastCandle = candles[lastIndex];

  log(
    "MARKET",
    `Loaded ${candles.length} real candles. Latest close: ${lastCandle.close} at ${new Date(
      lastCandle.closeTime
    ).toISOString()}.`
  );

  const signal = evaluateCrossover(candles, lastIndex, strategy.fastPeriod, strategy.slowPeriod);
  if (!signal) {
    log("SIGNAL", "Not enough candles yet to compute both moving averages.");
    return;
  }

  log("SIGNAL", `${signal.action} — ${signal.reason}`);

  if (signal.action === "HOLD") {
    log("DECISION", "HOLD. No risk check needed — there is no fresh signal to size.");
    return;
  }

  const risk = evaluateRisk(signal.action, lastCandle.close, riskConfig, {
    equity: riskConfig.startingEquity,
    dayStartEquity: riskConfig.startingEquity,
    dayRealizedPnl: 0,
  });

  log("RISK", risk.reason);

  if (!risk.approved) {
    log("DECISION", `SKIP. ${risk.reason}`);
    return;
  }

  const decision = simulatePaperOrder(
    strategy.symbol,
    signal.action,
    lastCandle.close,
    risk.quantity,
    risk.reason,
    "raw"
  );

  log(
    "DECISION",
    `${decision.action} (paper only, no real order sent). Quantity ${decision.quantity.toFixed(6)} ` +
      `at $${decision.price.toFixed(2)}. Stop $${risk.stopPrice.toFixed(2)}, Target $${risk.takeProfitPrice.toFixed(2)}.`
  );
}
