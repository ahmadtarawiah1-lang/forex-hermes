import { Candle } from "./types";

const COINBASE_CANDLES_URL = (productId: string) => `https://api.exchange.coinbase.com/products/${productId}/candles`;

// Coinbase Exchange's public candles endpoint takes granularity in seconds
// and caps a single request at 300 candles.
const GRANULARITY_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1d": 86400,
};
const MAX_CANDLES_PER_PAGE = 300;

export class MarketDataError extends Error {}

async function fetchCandlePage(
  productId: string,
  granularitySeconds: number,
  start?: Date,
  end?: Date
): Promise<Candle[]> {
  let url = `${COINBASE_CANDLES_URL(productId)}?granularity=${granularitySeconds}`;
  if (start && end) {
    url += `&start=${start.toISOString()}&end=${end.toISOString()}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new MarketDataError(
      `Could not reach Coinbase's public market data endpoint (${url}). ` +
        `Underlying error: ${(err as Error).message}. ` +
        `No candle data was faked to work around this.`
    );
  }

  if (!response.ok) {
    throw new MarketDataError(
      `Coinbase candles request failed with HTTP ${response.status} ${response.statusText}. ` +
        `No candle data was faked to work around this.`
    );
  }

  // Coinbase returns rows as [time, low, high, open, close, volume], newest
  // candle first, time in whole seconds.
  const raw = (await response.json()) as number[][];

  const candles: Candle[] = raw.map((row) => ({
    openTime: row[0] * 1000,
    low: row[1],
    high: row[2],
    open: row[3],
    close: row[4],
    volume: row[5],
    closeTime: row[0] * 1000 + granularitySeconds * 1000 - 1,
  }));

  return candles.reverse(); // chronological ascending, oldest first
}

/**
 * Fetches real candles from Coinbase Exchange's public candles endpoint.
 * No API key, no account, no order capability — market data only.
 * Automatically pages backwards in time for requests over 300 candles
 * (Coinbase's per-request cap).
 */
export async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const granularitySeconds = GRANULARITY_SECONDS[interval];
  if (!granularitySeconds) {
    throw new MarketDataError(`Unsupported interval "${interval}" for Coinbase candles.`);
  }

  if (limit <= MAX_CANDLES_PER_PAGE) {
    const candles = await fetchCandlePage(symbol, granularitySeconds);
    return candles.slice(-limit);
  }

  const pages: Candle[][] = [];
  let end = new Date();
  let remaining = limit;

  while (remaining > 0) {
    const pageSize = Math.min(MAX_CANDLES_PER_PAGE, remaining);
    const start = new Date(end.getTime() - pageSize * granularitySeconds * 1000);
    const page = await fetchCandlePage(symbol, granularitySeconds, start, end);
    if (page.length === 0) break;
    pages.unshift(page);
    remaining -= page.length;
    end = start;
  }

  // Consecutive pages are requested with adjacent `start`/`end` boundaries
  // (each page's `start` becomes the next page's `end`), and Coinbase's
  // candles endpoint has been observed to include the candle bucket at a
  // boundary timestamp in both the page ending there and the page starting
  // there. Left alone, that duplicate candle gets double-counted by the
  // moving averages at every page boundary (every 300 candles — roughly
  // once a day for 5m candles), which can shift a fresh-crossover detection
  // by one candle. De-duplicated by openTime, keeping the first (earliest
  // page's) occurrence, before merging.
  const merged: Candle[] = [];
  const seenOpenTimes = new Set<number>();
  for (const page of pages) {
    for (const candle of page) {
      if (seenOpenTimes.has(candle.openTime)) continue;
      seenOpenTimes.add(candle.openTime);
      merged.push(candle);
    }
  }

  return merged.slice(-limit);
}
