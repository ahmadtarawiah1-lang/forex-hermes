# forex-hermes

A self-improving **paper-trading** bot for EUR/USD. It trades on a simple RSI
strategy, logs every closed trade, scores itself against a goal, and — every
5 closed trades — reflects on its own performance and changes **exactly one**
strategy variable at a time.

Paper trading only. There is no live-execution path in this codebase.

## How it works

```
forex_hermes/
├── run.py            entrypoint: python -m forex_hermes.run
├── loop.py           async loop — pulls prices, paper-trades, logs outcomes
├── reflect.py         reflection cycle (deterministic or Claude-powered)
├── score.py           scores trades against state/goal.yaml
└── adapters/
    └── price.py       free Yahoo Finance data for the forex pair

state/
├── goal.yaml           your success/failure definition (edit this)
├── strategy.yaml       current strategy — this file evolves over time
├── trades.jsonl        every closed paper trade (generated at runtime)
├── hypotheses.jsonl    every reflection's reasoning (generated at runtime)
└── history/            a snapshot of the strategy before each change
```

Every minute, the loop:
1. Fetches recent EUR/USD candles (Yahoo Finance, free, no API key).
2. Computes RSI and checks the current `strategy.yaml` entry rule.
3. Opens a paper position if the rule fires; closes it on stop-loss or take-profit.
4. Logs the closed trade to `state/trades.jsonl`.
5. Every `reflection_every` closed trades (default 5), reflects: scores the
   last 25 trades against `state/goal.yaml`, and applies **one** change to
   `strategy.yaml` — bumping its version and archiving the prior version to
   `state/history/`.

## Setup

Requires Python 3.11+.

```bash
python3 -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e .
cp .env.example .env
```

## Run it

```bash
python -m forex_hermes.run
# or override the pair:
python -m forex_hermes.run --asset EUR/USD
```

Leave it running (in a terminal, tmux session, or as a background service) —
it polls once a minute forever.

## Reflection modes

By default the loop uses the **deterministic** reflection rule after every
5 closed trades (no setup required):
- If drawdown exceeded `max_drawdown` → tighten `stop_loss_pct` by 0.2.
- Else if realised return is below `target_return_30d` → loosen
  `entry.threshold` by 2.
- Otherwise → no change (goal already met).

You can also trigger a reflection manually:

```bash
python -m forex_hermes.reflect --fallback   # deterministic rule
```

### Optional: Claude-powered reflection

If you'd rather the reflection reasoning be handled by an LLM instead of the
fixed rule above, set `ANTHROPIC_API_KEY` in `.env` (get one at
https://console.anthropic.com/) and run:

```bash
python -m forex_hermes.reflect --llm
```

This sends the goal, current strategy, and last 25 trades to Claude and asks
it to propose exactly one variable to change. If the key is missing or the
call fails, it automatically falls back to the deterministic rule so the bot
never stalls.

## Your strategy (`state/goal.yaml`)

```yaml
asset: "EUR/USD"
target_return_30d: 0.10   # success: +10% in 30 days
max_drawdown:      0.15   # failure: bail above 15% drawdown
min_sharpe:         1.0   # quality bar
reflection_every:   5     # reflect every 5 closed trades
```

Edit this file any time to change what "success" and "failure" mean — the
bot re-reads it on every tick.

## Checking in on it

```bash
cat state/strategy.yaml            # current strategy + version
tail -20 state/trades.jsonl        # recent paper trades
cat state/hypotheses.jsonl         # every reflection's reasoning
ls state/history/                  # every prior strategy version
```

## Deploying somewhere it runs 24/7

This repo runs anywhere Python 3.11 does. If you want it running continuously
without your laptop staying on, you can deploy it to any host you like
(a small VPS, Railway, Fly.io, etc.) — that's a manual step you drive
yourself since it involves creating accounts and paying for hosting. Ask if
you'd like help with the specific steps for a platform once you've decided.
