# paper-trading-bot

A **paper-trading only** bot for BTC-USD on the 5-minute timeframe, built in
TypeScript/Node.js. It runs a 9/21 moving-average crossover strategy against
real Coinbase market data, sizes trades by risking 2% of equity per trade,
learns from its own real closed trades via a two-file memory system, and
periodically **reflects** — scoring its recent real performance against a
goal and adjusting exactly one risk/memory setting when it's off track.

Originally built against Binance's public klines endpoint (BTCUSDT). CI
(GitHub Actions) showed that endpoint returns HTTP 451 — Binance geo-blocks
the US-based infrastructure those runners use — so the data source was
switched to Coinbase's public Exchange candles endpoint, which isn't
geo-blocked for US infra. See `.github/workflows/paper-trading-bot-verify.yml`
for the CI run that caught this and confirmed the fix.

There is no live-trading path anywhere in this codebase — no broker/exchange
credentials are requested, stored, or required to run any command below.

See `trading_bot_instructions.md` for the full strategy/risk/memory spec
this bot was built from.

## What it does

- Fetches real BTC-USD candles from Coinbase's **public** Exchange candles
  endpoint (no API key, no account, no order capability at that endpoint).
- Evaluates a 9-period fast / 21-period slow moving-average crossover.
- Sizes any BUY/SELL signal to risk 2% of paper equity, with a stop-loss and
  take-profit derived from that same risk model (see Risk model, below).
- Simulates the trade as a **paper order only** — nothing is ever sent to a
  real venue.
- In the memory-enabled path, checks `data/ledger.csv` before opening a new
  trade and skips it if the same symbol/action lost within the last 24
  hours — a bounded cooldown, not a permanent ban (see Risk model below for
  why permanent was rejected).
- Every 10 new real closed trades, **reflects**: scores the last 20 against
  `data/goal.json` and changes exactly one thing in `data/strategy_state.json`
  — tighten risk/stop if drawdown breached the goal, widen the memory
  cooldown if win rate is below target, or nothing if the goal is met. Old
  versions are archived to `data/history/`. See "How it learns," below.

## Install

Requires Node.js 18+ (uses the built-in global `fetch`).

```bash
npm install
```

No `.env` file is required for the default setup — see `.env.example` for
what it's for if you ever add a verified paper broker adapter.

## Commands

```bash
npm run scan           # one real-time snapshot: fetch, signal, risk, decision
npm run replay:raw      # backtest the raw strategy against real history, no memory
npm run replay:memory   # same backtest, but skips setups memory has flagged
npm run reflect         # manually trigger a reflection check (also runs automatically after replay:raw/replay:memory)
npm run memory:reset    # wipes data/ledger.csv and data/learnings.md back to empty
```

Typical order for seeing memory actually change behavior:

```bash
npm run replay:raw       # records any real losses found into ledger.csv/learnings.md
npm run replay:memory    # re-scans the same history; setups matching a recorded loss get SKIPped
```

If `data/ledger.csv` is still empty when you run `replay:memory`, it prints
a note telling you to run `replay:raw` first, then proceeds identically to
`replay:raw` (there's nothing to skip yet) rather than silently doing
nothing.

### A note on where this was verified

The sandbox this bot was originally built in blocks every public
market-data host by network egress policy (confirmed via the proxy's status
endpoint against six different providers) — commands there fail with that
blocker printed honestly rather than falling back to fake data. Real
verification happens in CI (`.github/workflows/paper-trading-bot-verify.yml`),
which runs on GitHub-hosted runners with normal internet access. That CI run
is also what caught Binance's geo-block (HTTP 451) and confirmed the
Coinbase switch actually works end to end.

## How it learns

This bot runs across two separate GitHub Actions workflows, because
GitHub-hosted runners are ephemeral — nothing survives between runs unless
it's committed back to the repo.

- **`paper-trading-bot-verify.yml`** — runs on every push/PR that touches
  this project. It uses `memory:reset` deliberately, so it always proves the
  code works from a clean slate. It never commits anything back.
- **`paper-trading-bot-live.yml`** — runs hourly on its own (`schedule:
  cron`), *never* resets memory, and commits `data/ledger.csv`,
  `data/learnings.md`, `data/strategy_state.json`, and `data/history/` back
  to `main` after each run (`[skip ci]` so it doesn't re-trigger verify).
  This is what actually accumulates real trade history and lets reflection
  act on it over time.

Because the same rolling window of historical candles gets re-fetched every
hour, most setups are the same ones seen in the previous run. `replay.ts`
de-duplicates before writing to the ledger (by mode + symbol + entry time),
so the persisted ledger only grows when a *genuinely new* setup appears —
without that, the hourly job would re-log near-duplicate rows for the same
handful of real trades every hour and corrupt the "10 new closed trades"
count reflection depends on.

**Reflection** (`src/reflect.ts`) is deliberately blunt and auditable, not a
model: every `reflectionEvery` (default 10) new real closed trades, it looks
at the last `lookbackTrades` (default 20), and:

1. If realized drawdown over that window breached `maxAcceptableDrawdownPct`
   (default 8%) → tighten `stopLossPct`/`riskPctPerTrade` together (keeping
   them equal preserves the no-leverage invariant — see Risk model) and
   rescale `takeProfitPct` to keep the 2:1 ratio.
2. Else if win rate over that window is below `targetWinRate` (default 55%)
   → widen the memory cooldown (`+12h`, capped at 72h).
3. Else → no change; the goal is being met.

Only ever **one** change per reflection. The version before the change is
archived to `data/history/vN.json`, the live state's version number bumps,
and a plain-English line gets appended to `data/learnings.md` explaining
why. Edit `data/goal.json` any time to change what "on track" means.

## Where things live

- `src/market.ts` — Coinbase public candles fetch (auto-paginates past the
  300-candle-per-request cap).
- `src/strategy.ts` — moving-average crossover signal.
- `src/risk.ts` — position sizing, stop/target, max-position and
  max-daily-drawdown checks.
- `src/execution.ts` — simulates a paper order (no real order path exists).
- `src/replay.ts` — the raw and memory-enabled backtest engine, with
  ledger de-duplication so scheduled re-runs don't double-log real trades.
- `src/memory.ts` / `src/adaptiveFilter.ts` — ledger/learnings I/O and the
  "have we lost on this before" check.
- `src/config.ts` — loads/saves `data/strategy_state.json` and
  `data/goal.json`; archives a version snapshot before any reflection change.
- `src/reflect.ts` — the reflection loop described above.
- `src/bot.ts` / `src/index.ts` — the `scan` command and CLI entrypoint.
- `data/goal.json` — what "on track" means (target win rate, max acceptable
  drawdown, how often to reflect). Tracked in git; edit any time.
- `data/strategy_state.json` — the live, evolving symbol/strategy/risk/memory
  settings plus a version number. Tracked in git — this **is** the bot's
  persisted "brain" across ephemeral CI runs.
- `data/history/vN.json` — an archived snapshot of `strategy_state.json`
  before each reflection change. Tracked in git — the audit trail.
- `data/ledger.csv` — every completed paper/replay trade and every skipped
  decision. Tracked in git so it survives between hourly runs; `memory:reset`
  wipes it locally when you want a clean slate.
- `data/learnings.md` — plain-English lessons distilled from real closed
  losing trades, plus one line per reflection change. Also tracked in git.

## Risk model

- Starting paper equity: $10,000.
- Risk per trade: 2% of current equity.
- Stop-loss: 2% adverse move from entry. Take-profit: 4% favorable move
  (2:1 reward:risk).
- Position sizing: `quantity = (equity * 0.02) / (entryPrice * 0.02)`, which
  simplifies to `equity / entryPrice`. Because the risk % and stop-loss %
  are equal, this never implies leverage — worst case it uses ~100% of
  paper equity, never borrowed money. A max-position cap of 105% of equity
  exists as a guardrail (SKIP) in case these two settings are ever changed
  independently.
- Max daily drawdown: 5%. Once the day's realized paper losses reach 5% of
  that day's starting equity, new trades SKIP for the rest of the day. (This
  gate only applies to `scan`'s live-instant check; `replay` backtests don't
  track calendar days, so it isn't exercised there — noted here rather than
  silently glossed over.)
- Memory cooldown: a same-symbol, same-action `LOSS` blocks repeats for 24
  hours, then trading resumes automatically — see `src/adaptiveFilter.ts`.
  An earlier version of this rule blocked a symbol forever after any single
  loss; that was a dead end (nothing could ever execute again to lift the
  block) and was replaced with this bounded cooldown.

All of the above lives in `data/strategy_state.json`, loaded at startup by
`src/index.ts` — that's the one place to change symbol, timeframe, MA
periods, equity, risk %, stop/target %, position cap, and drawdown limit.
Reflection edits this same file automatically over time; editing it by hand
is also fine (bump the version yourself if you do).

## Experimenting with a new strategy or symbol

1. Edit `data/strategy_state.json` directly (symbol, interval, MA periods,
   equity, risk %, stop/target %, caps, memory cooldown).
2. Run `npm run memory:reset` so old memory doesn't leak into the new
   experiment.
3. Run `npm run replay:raw`, then `npm run replay:memory`, and compare.
4. To try an entirely different strategy, add a new function alongside
   `evaluateCrossover` in `src/strategy.ts` that returns a `StrategySignal`,
   and swap it into `src/bot.ts` / `src/replay.ts`.
5. To change what "on track" means for reflection, edit `data/goal.json`
   (target win rate, max acceptable drawdown, how often to reflect, and how
   many recent trades to score against).

## Guardrails against accidental live orders

- There is no broker/exchange order-placing code anywhere in this project —
  `execution.ts` only constructs an in-memory `Decision` record.
- The only network call this project makes is a `GET` to Coinbase's public,
  unauthenticated candles endpoint.
- No API keys are read, requested, or required by any command.
- `.env` is gitignored; `.env.example` documents that any future broker
  integration must stay paper/test-mode and must never be committed.

## Safety rules and limitations

- Paper trading only. There is no flag, env var, or code path that enables
  live trading.
- No secrets in source, no secrets in logs, no frontend (so no frontend
  credential exposure either).
- Market data or nothing: if Coinbase's public endpoint is unreachable, the
  bot fails with a clear, honest error — it never substitutes generated or
  fixture candles.
- Memory only ever learns from real replay/paper outcomes; nothing is
  seeded.
