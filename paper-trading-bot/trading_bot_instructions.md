# Trading Bot Instructions

## 1. Project Goal

Build a **paper-trading** bot for BTCUSDT on the 5-minute timeframe. The bot
watches real Binance market data, evaluates a moving-average crossover
strategy, and simulates trades — it never places a real order. Paper/test
mode is the only mode this project supports; there is no live-execution path
to switch on.

## 2. Safety Rules

- Paper trading by default, always. No flag or config enables live trading.
- No API keys or secrets are required, requested, or stored — market data
  comes from Binance's public (unauthenticated) klines endpoint.
- No secrets are ever written to source, logs, or `data/` files.
- No credentials are exposed to any frontend — this project has no frontend.
- No action (BUY/SELL) is taken unless the risk check passes; failing risk
  always resolves to `SKIP`.

## 3. Strategy Rules

- Indicators: 9-period fast simple moving average (MA), 21-period slow MA,
  computed on candle close prices.
- Entry (BUY): fast MA crosses **above** slow MA on the most recent closed
  candle (a fresh crossover, not just fast > slow already in effect).
- Exit (SELL): fast MA crosses **below** slow MA on the most recent closed
  candle.
- Hold: no fresh crossover on the most recent candle.
- Backtest notes: no live TradingView MCP was available in this build
  session, so the strategy was not backtested live. A Pine Script v5 version
  of the same rule set is included below so it can be validated manually in
  TradingView before being trusted further.

### Pine Script v5 (for manual TradingView validation)

```pinescript
//@version=5
strategy("9/21 MA Crossover", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=2)

fastLen = input.int(9, "Fast MA Length")
slowLen = input.int(21, "Slow MA Length")

fastMA = ta.sma(close, fastLen)
slowMA = ta.sma(close, slowLen)

longCondition  = ta.crossover(fastMA, slowMA)
shortCondition = ta.crossunder(fastMA, slowMA)

if (longCondition)
    strategy.entry("Long", strategy.long)

if (shortCondition)
    strategy.close("Long")

plot(fastMA, color=color.blue, title="Fast MA")
plot(slowMA, color=color.orange, title="Slow MA")
```

To validate manually: paste into Pine Editor, add to a BTCUSDT 5m chart as a
**strategy** (not just an indicator), open Strategy Tester, and review net
profit, win rate, max drawdown, and profit factor before changing any rule
above.

## 4. Risk Rules

- Starting paper equity: **$10,000** (tracked in-memory/in-ledger, never
  real money).
- Risk per trade: **2% of current equity**.
- Stop loss: **2%** adverse move from entry price.
- Take profit: **4%** favorable move from entry price (2:1 reward:risk).
- Position sizing: `quantity = (equity * 0.02) / (entryPrice * 0.02)`, which
  simplifies to `equity / entryPrice` — sized so that if the stop-loss is
  hit, the loss equals exactly 2% of equity. Because risk % and stop-loss %
  are equal, this naturally caps notional exposure at ~100% of equity with
  no implied leverage (this is a spot paper simulation, not a margin
  account) — a tighter stop-loss than the risk % would otherwise imply
  leveraged position sizing, which this bot deliberately avoids.
- Max position value: capped at **105% of equity** notional (100% plus a
  small floating-point safety margin). If the computed position value would
  exceed this cap, the final action is `SKIP`. This exists to protect
  against configuration changes (e.g. a tighter stop-loss than risk %) that
  would otherwise imply borrowing money that doesn't exist.
- Max daily drawdown: **5%**. If realized losses for the current day reach
  5% of the day's starting equity, no new BUY/SELL is taken for the rest of
  that day — action becomes `SKIP`.
- Every decision (BUY, SELL, HOLD, SKIP) includes a plain-English reason.

## 5. Broker/MCP Rules

- No broker or exchange MCP server is connected. This build uses only
  Binance's public market-data endpoint (`/api/v3/klines`), which requires
  no API key and has no order-placing capability.
- There is no account, no balance, no open-position, and no open-order
  check against a real venue, because there is no real venue connection —
  by design, this removes any live-trading surface entirely.
- If a verified paper-trading broker/MCP connection is added later, it must
  be wired in as an adapter behind the existing `execution` module, and it
  must remain in paper/test mode.

## 6. Memory Rules

- `data/ledger.csv` logs every completed paper/replay trade and every
  skipped decision: timestamp, symbol, action, price, quantity, reason,
  mode, outcome, pnl.
- `data/learnings.md` stores plain-English lessons distilled from real
  closed trades only — nothing is seeded or invented.
- Both files are read before every future BUY/SELL decision in the
  memory-enabled path.
- A setup that matches a previously logged losing pattern for the same
  symbol becomes `SKIP`.

## 7. Definition of Done

- `npm install`, `npm run scan`, `npm run replay:raw`, `npm run
  replay:memory`, and `npm run memory:reset` all work.
- The bot uses real Binance market data, or fails with a clearly printed
  blocker if that data is unavailable (e.g. network policy blocks the
  request) — it never substitutes fake or generated candles.
- Terminal output for `scan` shows: market data fetch, signal, risk check,
  and final decision with reason.
- No real trade is ever placed; no broker credentials are ever requested.
