"""Free public price data adapter (Yahoo Finance) for forex pairs."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

SCHEMA_VERSION = 1
_YAHOO_SUFFIX = "=X"


class SchemaError(Exception):
    """Raised when adapter output doesn't match the expected schema."""


def _to_yahoo_symbol(pair: str) -> str:
    base, quote = pair.upper().split("/")
    return f"{base}{quote}{_YAHOO_SUFFIX}"


def _download(pair: str, period: str, interval: str) -> pd.DataFrame:
    symbol = _to_yahoo_symbol(pair)
    df = yf.download(symbol, period=period, interval=interval, progress=False, auto_adjust=True)
    if df.empty:
        raise SchemaError(f"no data returned for {symbol}")
    return df


async def fetch(pair: str = "EUR/USD", period: str = "5d", interval: str = "15m") -> dict:
    """Fetch recent OHLC candles for a forex pair. The blocking yfinance call
    runs in a thread so the async loop is never blocked."""
    df = await asyncio.to_thread(_download, pair, period, interval)

    closes = df["Close"].tolist()
    if not closes:
        raise SchemaError("empty close series")

    payload = {
        "schema_version": SCHEMA_VERSION,
        "pair": pair,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "interval": interval,
        "closes": [float(c) for c in closes],
        "last_price": float(closes[-1]),
    }
    if payload["schema_version"] != SCHEMA_VERSION:
        raise SchemaError("schema mismatch")
    return payload
