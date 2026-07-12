"""Score realised trading performance against the strategy's goal."""
from __future__ import annotations

import math
from typing import Sequence


def _sharpe(returns: Sequence[float]) -> float:
    if len(returns) < 2:
        return 0.0
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    std = math.sqrt(variance)
    if std == 0:
        return 0.0
    return (mean / std) * math.sqrt(len(returns))


def _max_drawdown(equity_curve: Sequence[float]) -> float:
    peak = equity_curve[0]
    max_dd = 0.0
    for value in equity_curve:
        peak = max(peak, value)
        dd = (peak - value) / peak if peak else 0.0
        max_dd = max(max_dd, dd)
    return max_dd


def _clamp(value: float) -> float:
    return max(-1.0, min(1.0, value))


def score(trades: list[dict], goal: dict) -> float:
    """Composite score in [-1, +1]. Positive means the strategy is meeting
    the goal; negative means it is failing it.

    trades: list of closed trade dicts, each with a "pnl_pct" field
            (e.g. +0.012 for +1.2%).
    goal:   the parsed goal.yaml dict.
    """
    if not trades:
        return 0.0

    returns = [t["pnl_pct"] for t in trades]
    realised_return = sum(returns)

    equity = [1.0]
    for r in returns:
        equity.append(equity[-1] * (1 + r))

    drawdown = _max_drawdown(equity)
    sharpe = _sharpe(returns)

    target_return = goal["target_return_30d"]
    max_drawdown = goal["max_drawdown"]
    min_sharpe = goal["min_sharpe"]

    return_score = _clamp(realised_return / target_return) if target_return else 0.0
    drawdown_score = _clamp(1 - (drawdown / max_drawdown)) if max_drawdown else 0.0
    sharpe_score = _clamp(sharpe / min_sharpe) if min_sharpe else 0.0

    composite = _clamp((return_score + drawdown_score + sharpe_score) / 3)

    failure_below = goal.get("failure_below", -0.04)
    if composite < failure_below:
        composite = max(-1.0, composite * 2)  # steepen the penalty below the floor

    return composite
