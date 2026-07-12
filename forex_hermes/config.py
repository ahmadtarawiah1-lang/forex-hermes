"""Paths and (de)serialisation helpers shared by the rest of the package."""
from __future__ import annotations

import json
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = PROJECT_ROOT / "state"
HISTORY_DIR = STATE_DIR / "history"

GOAL_PATH = STATE_DIR / "goal.yaml"
STRATEGY_PATH = STATE_DIR / "strategy.yaml"
TRADES_PATH = STATE_DIR / "trades.jsonl"
HEARTBEAT_PATH = STATE_DIR / "heartbeat.json"


def load_goal() -> dict:
    return yaml.safe_load(GOAL_PATH.read_text())


def load_strategy() -> dict:
    return yaml.safe_load(STRATEGY_PATH.read_text())


def save_strategy(strategy: dict) -> None:
    STRATEGY_PATH.write_text(yaml.safe_dump(strategy, sort_keys=False))


def load_trades(limit: int | None = None) -> list[dict]:
    if not TRADES_PATH.exists():
        return []
    lines = TRADES_PATH.read_text().splitlines()
    trades = [json.loads(line) for line in lines if line.strip()]
    return trades[-limit:] if limit else trades


def append_trade(trade: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with TRADES_PATH.open("a") as f:
        f.write(json.dumps(trade) + "\n")


def write_heartbeat(payload: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    HEARTBEAT_PATH.write_text(json.dumps(payload, indent=2))
