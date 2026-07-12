import { Candle } from "./types";

const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";

export class MarketDataError extends Error {}

/**
 * Fetches real candles from Binance's public klines endpoint.
 * No API key, no account, no order capability — market data only.
 */
export async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const url = `${BINANCE_KLINES_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new MarketDataError(
      `Could not reach Binance public market data endpoint (${url}). ` +
        `Underlying error: ${(err as Error).message}. ` +
        `No candle data was faked to work around this.`
    );
  }

  if (!response.ok) {
    throw new MarketDataError(
      `Binance klines request failed with HTTP ${response.status} ${response.statusText}. ` +
        `No candle data was faked to work around this.`
    );
  }

  const raw = (await response.json()) as unknown[][];

  return raw.map((row) => ({
    openTime: row[0] as number,
    open: parseFloat(row[1] as string),
    high: parseFloat(row[2] as string),
    low: parseFloat(row[3] as string),
    close: parseFloat(row[4] as string),
    volume: parseFloat(row[5] as string),
    closeTime: row[6] as number,
  }));
}
