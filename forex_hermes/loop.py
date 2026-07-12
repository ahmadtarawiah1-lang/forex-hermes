"""Async loop: pulls price data every POLL_SECONDS, evaluates the current
strategy, paper-trades on entry/exit signals, and logs outcomes.

Reliability:
  - per-adapter retries: 3 attempts, exponential backoff (1s, 2s, 4s)
  - circuit breaker: raises CircuitOpen after 5 consecutive failed ticks
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import numpy as np

from forex_hermes import reflect as reflect_module
from forex_hermes.adapters import price as price_adapter
from forex_hermes.config import append_trade, load_goal, load_strategy, load_trades, write_heartbeat

POLL_SECONDS = 60
MAX_RETRIES = 3
CIRCUIT_BREAK_AFTER = 5


class CircuitOpen(Exception):
    """Raised when the adapter has failed too many times in a row."""


def _rsi(closes: list[float], period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50.0
    deltas = np.diff(closes)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_gain = gains[-period:].mean()
    avg_loss = losses[-period:].mean()
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


async def _fetch_with_retry(pair: str) -> dict:
    delay = 1.0
    last_exc: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            return await price_adapter.fetch(pair)
        except Exception as exc:  # noqa: BLE001 - adapter can raise many network errors
            last_exc = exc
            print(f"[adapter] attempt {attempt + 1}/{MAX_RETRIES} failed: {exc}")
            await asyncio.sleep(delay)
            delay *= 2
    raise last_exc  # type: ignore[misc]


class Position:
    def __init__(self, entry_price: float, size_r: float, stop_loss_pct: float, direction: str):
        self.entry_price = entry_price
        self.size_r = size_r
        self.stop_loss_pct = stop_loss_pct
        self.direction = direction
        self.opened_at = datetime.now(timezone.utc).isoformat()

    def unrealised_pnl_pct(self, price: float) -> float:
        raw = (price - self.entry_price) / self.entry_price
        return raw if self.direction == "long" else -raw

    def stop_hit(self, price: float) -> bool:
        return self.unrealised_pnl_pct(price) <= -(self.stop_loss_pct / 100)

    def take_profit_hit(self, price: float) -> bool:
        target = self.size_r * (self.stop_loss_pct / 100)
        return self.unrealised_pnl_pct(price) >= target


async def run(asset: str) -> None:
    goal = load_goal()
    consecutive_failures = 0
    position: Position | None = None
    trades_since_reflection = len(load_trades()) % goal["reflection_every"]

    print(f"Starting worker for {asset}. Polling every {POLL_SECONDS}s.")

    while True:
        try:
            data = await _fetch_with_retry(asset)
            consecutive_failures = 0
        except Exception as exc:  # noqa: BLE001
            consecutive_failures += 1
            print(f"[loop] fetch failed ({exc}); consecutive failures={consecutive_failures}")
            if consecutive_failures >= CIRCUIT_BREAK_AFTER:
                write_heartbeat({
                    "status": "circuit_open",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "reason": str(exc),
                })
                raise CircuitOpen(f"{CIRCUIT_BREAK_AFTER} consecutive adapter failures") from exc
            await asyncio.sleep(POLL_SECONDS)
            continue

        strategy = load_strategy()  # reloaded every tick so reflection edits apply live
        price = data["last_price"]
        rsi = _rsi(data["closes"])

        if position is None:
            entry = strategy["entry"]
            fires = (
                (entry["direction"] == "long" and rsi < entry["threshold"])
                or (entry["direction"] == "short" and rsi > (100 - entry["threshold"]))
            )
            if fires:
                position = Position(
                    entry_price=price,
                    size_r=strategy["position_size_r"],
                    stop_loss_pct=strategy["stop_loss_pct"],
                    direction=entry["direction"],
                )
                print(f"[trade] opened {entry['direction']} at {price:.5f} (rsi={rsi:.1f})")
        else:
            if position.stop_hit(price) or position.take_profit_hit(price):
                pnl_pct = position.unrealised_pnl_pct(price)
                closed_trade = {
                    "opened_at": position.opened_at,
                    "closed_at": datetime.now(timezone.utc).isoformat(),
                    "pair": asset,
                    "direction": position.direction,
                    "entry_price": position.entry_price,
                    "exit_price": price,
                    "pnl_pct": pnl_pct,
                    "strategy_version": strategy.get("version"),
                }
                append_trade(closed_trade)
                print(f"[trade] closed at {price:.5f} pnl={pnl_pct:.2%}")
                position = None
                trades_since_reflection += 1

                if trades_since_reflection >= goal["reflection_every"]:
                    trades = load_trades(limit=25)
                    reflect_module.fallback_reflect(goal, strategy, trades)
                    trades_since_reflection = 0

        write_heartbeat({
            "status": "running",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "last_price": price,
            "rsi": rsi,
            "position_open": position is not None,
        })

        await asyncio.sleep(POLL_SECONDS)
