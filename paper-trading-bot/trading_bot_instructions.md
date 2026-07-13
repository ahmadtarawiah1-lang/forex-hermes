# Trading Bot Instructions

## 1. Project Goal

Build a **paper-trading** bot for BTC-USD on the 5-minute timeframe. The bot
watches real Coinbase market data, evaluates a moving-average crossover
strategy, and simulates trades — it never places a real order. Paper/test
mode is the only mode this project supports; there is no live-execution path
to switch on.

**Venue note**: the original build used Binance's public klines endpoint for
BTCUSDT. Verifying it in CI (GitHub Actions) showed that endpoint returns
HTTP 451 — Binance geo-blocks the US-based infrastructure those runners use,
which is a structural limitation, not a policy or code bug. The data source
was switched to Coinbase's public Exchange candles endpoint (BTC-USD, no
API key, no geo-block for US infra) so the bot actually runs in CI. The
strategy/risk/memory rules below are unchanged — only the venue and symbol
naming changed.

## 2. Safety Rules

- Paper trading by default, always. No flag or config enables live trading.
- No API keys or secrets are required, requested, or stored — market data
  comes from Coinbase's public (unauthenticated) Exchange candles endpoint.
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

To validate manually: paste into Pine Editor, add to a BTCUSD 5m chart as a
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
  Coinbase's public market-data endpoint (`/products/{id}/candles`), which
  requires no API key and has no order-placing capability.
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
- Before every future BUY/SELL in the memory-enabled path, the ledger is
  checked for a same-symbol, same-action `LOSS` within the last **24
  hours**. If one exists, the action becomes `SKIP`.
- This is a bounded cooldown, not a permanent ban. A "one loss ever, blocked
  forever" rule was tried first and rejected: once blocked, no new trade
  can ever execute to prove the setup works again, so the block could never
  lift. A time-boxed cooldown lets the strategy resume once the window
  passes, which is what makes this an adaptive filter rather than a kill
  switch.

## 6a. Reflection Rules (getting smarter over time)

- `data/goal.json` defines "on track": target win rate (default 55%), max
  acceptable drawdown (default 8%), how many new closed trades trigger a
  reflection (default 10), and how many recent trades to score (default 20).
- `data/strategy_state.json` is the live, evolving strategy/risk/memory
  config plus a version number — this is what `src/index.ts` actually loads
  at startup, not a hardcoded constant.
- Every `reflectionEvery` new real closed trades, `src/reflect.ts` scores the
  last `lookbackTrades` against the goal and changes **exactly one** thing:
  drawdown breach → tighten stop-loss/risk (kept equal, preserving the
  no-leverage invariant) and rescale take-profit to match; else win rate
  below target → widen the memory cooldown; else → no change.
- The state version before any change is archived to `data/history/vN.json`
  and a plain-English line is appended to `data/learnings.md` explaining
  why. Nothing is ever seeded — only real closed trades feed this.
- Because GitHub Actions runners are ephemeral, this only works if
  `data/ledger.csv`, `data/learnings.md`, `data/strategy_state.json`, and
  `data/history/` are committed back to the repo after each run that
  accumulates real trades — see the two-workflow split in README.md.

## 7. Definition of Done

- `npm install`, `npm run scan`, `npm run replay:raw`, `npm run
  replay:memory`, `npm run reflect`, and `npm run memory:reset` all work.
- The bot uses real Coinbase market data, or fails with a clearly printed
  blocker if that data is unavailable (e.g. network policy blocks the
  request) — it never substitutes fake or generated candles.
- Terminal output for `scan` shows: market data fetch, signal, risk check,
  and final decision with reason.
- No real trade is ever placed; no broker credentials are ever requested.
