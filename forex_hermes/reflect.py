"""Reflection cycle: after every N closed trades, propose and apply exactly
one strategy change.

Modes:
  --fallback   deterministic rule-based reflection (no API key needed)
  --llm        calls the Claude API to reason about the last 25 trades and
               propose a hypothesis (requires ANTHROPIC_API_KEY in .env)
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone

import httpx
import yaml

from forex_hermes.config import HISTORY_DIR, STATE_DIR, load_goal, load_strategy, load_trades, save_strategy
from forex_hermes.score import score as score_trades

HYPOTHESES_PATH = STATE_DIR / "hypotheses.jsonl"


def _append_hypothesis(entry: dict) -> None:
    HYPOTHESES_PATH.parent.mkdir(parents=True, exist_ok=True)
    with HYPOTHESES_PATH.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def _get_nested(d: dict, dotted_key: str):
    node = d
    for part in dotted_key.split("."):
        node = node[part]
    return node


def _set_nested(d: dict, dotted_key: str, value) -> None:
    parts = dotted_key.split(".")
    node = d
    for part in parts[:-1]:
        node = node[part]
    node[parts[-1]] = value


def _apply_change(strategy: dict, variable: str, new_value, reasoning: str, goal: dict, trades: list[dict]) -> dict:
    prior_version = strategy.get("version", "01")
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    (HISTORY_DIR / f"v{int(prior_version):04d}.yaml").write_text(yaml.safe_dump(strategy, sort_keys=False))

    old_value = _get_nested(strategy, variable)
    updated = dict(strategy)
    _set_nested(updated, variable, new_value)
    updated["version"] = f"{int(prior_version) + 1:02d}"

    _append_hypothesis({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "prior_version": prior_version,
        "new_version": updated["version"],
        "variable_changed": variable,
        "old_value": old_value,
        "new_value": new_value,
        "reasoning": reasoning,
        "score": score_trades(trades, goal),
    })

    save_strategy(updated)
    return updated


def fallback_reflect(goal: dict, strategy: dict, trades: list[dict]) -> dict:
    """Deterministic rule: exactly one variable changes per cycle."""
    returns = [t["pnl_pct"] for t in trades]
    realised_return = sum(returns)

    equity = [1.0]
    for r in returns:
        equity.append(equity[-1] * (1 + r))
    peak = equity[0]
    max_dd = 0.0
    for v in equity:
        peak = max(peak, v)
        max_dd = max(max_dd, (peak - v) / peak if peak else 0.0)

    if max_dd > goal["max_drawdown"]:
        old = strategy["stop_loss_pct"]
        new = round(max(0.1, old - 0.2), 2)
        reasoning = (
            f"Drawdown {max_dd:.2%} exceeded max_drawdown {goal['max_drawdown']:.2%}; "
            f"tightening stop_loss_pct from {old} to {new}."
        )
        return _apply_change(strategy, "stop_loss_pct", new, reasoning, goal, trades)

    if realised_return < goal["target_return_30d"]:
        old = strategy["entry"]["threshold"]
        new = old + 2
        reasoning = (
            f"Realised return {realised_return:.2%} below target {goal['target_return_30d']:.2%}; "
            f"loosening entry.threshold from {old} to {new}."
        )
        return _apply_change(strategy, "entry.threshold", new, reasoning, goal, trades)

    reasoning = "Goal met on both return and drawdown; no change needed this cycle."
    _append_hypothesis({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "prior_version": strategy.get("version", "01"),
        "new_version": strategy.get("version", "01"),
        "variable_changed": None,
        "reasoning": reasoning,
        "score": score_trades(trades, goal),
    })
    return strategy


def _build_prompt(goal: dict, strategy: dict, trades: list[dict]) -> str:
    return (
        "You are the reflection module of a paper-trading bot. Given the goal, "
        "current strategy, and the last closed trades, propose EXACTLY ONE "
        "variable in the strategy to change, and by how much, to improve the "
        "score. Reply with ONLY a JSON object: "
        '{"variable": "dotted.path", "new_value": <number>, "reasoning": "..."}.\n\n'
        f"Goal:\n{yaml.safe_dump(goal, sort_keys=False)}\n"
        f"Current strategy:\n{yaml.safe_dump(strategy, sort_keys=False)}\n"
        f"Last {len(trades)} trades:\n{json.dumps(trades[-25:], indent=2)}\n"
    )


def _parse_hypothesis(text: str) -> dict:
    start = text.index("{")
    end = text.rindex("}") + 1
    return json.loads(text[start:end])


def llm_reflect(goal: dict, strategy: dict, trades: list[dict]) -> dict:
    """Calls the Claude API to propose exactly one strategy change.

    Requires ANTHROPIC_API_KEY in the environment/.env. Falls back to the
    deterministic rule if the key is missing or the call fails, so the loop
    never stalls.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ANTHROPIC_API_KEY not set; falling back to deterministic reflection.")
        return fallback_reflect(goal, strategy, trades)

    prompt = _build_prompt(goal, strategy, trades)
    try:
        response = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-sonnet-5",
                "max_tokens": 512,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30.0,
        )
        response.raise_for_status()
        text = response.json()["content"][0]["text"]
        hypothesis = _parse_hypothesis(text)
    except Exception as exc:  # noqa: BLE001 - network/parsing errors, never stall the loop
        print(f"LLM reflection failed ({exc}); falling back to deterministic reflection.")
        return fallback_reflect(goal, strategy, trades)

    return _apply_change(
        strategy,
        hypothesis["variable"],
        hypothesis["new_value"],
        hypothesis["reasoning"],
        goal,
        trades,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one reflection cycle.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--fallback", action="store_true", help="deterministic rule-based reflection")
    mode.add_argument("--llm", action="store_true", help="Claude-powered reflection")
    args = parser.parse_args()

    goal = load_goal()
    strategy = load_strategy()
    trades = load_trades(limit=25)

    if not trades:
        print("No closed trades yet; nothing to reflect on.")
        return

    updated = fallback_reflect(goal, strategy, trades) if args.fallback else llm_reflect(goal, strategy, trades)
    print(f"Strategy now at version {updated.get('version')}.")


if __name__ == "__main__":
    main()
