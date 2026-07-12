"""Entrypoint: `python -m forex_hermes.run [--asset EUR/USD]`."""
from __future__ import annotations

import argparse
import asyncio

from forex_hermes.config import load_goal
from forex_hermes.loop import run


def main() -> None:
    goal = load_goal()
    parser = argparse.ArgumentParser(description="Run the forex-hermes paper-trading worker.")
    parser.add_argument("--asset", default=goal["asset"], help="pair, e.g. EUR/USD")
    args = parser.parse_args()

    asyncio.run(run(args.asset))


if __name__ == "__main__":
    main()
