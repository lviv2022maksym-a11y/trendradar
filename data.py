"""Ринкові дані: свічки OHLCV (Yahoo Finance; запасне джерело для крипти — Kraken)
та індекс страху і жадібності для крипти (alternative.me)."""
from __future__ import annotations

import functools

import pandas as pd
import requests

UA = {"User-Agent": "Mozilla/5.0 (TrendRadar bot)"}
TIMEOUT = 20
COLS = ["open", "high", "low", "close", "volume"]
KRAKEN_PAIRS = {"BTC-USD": "XBTUSD", "ETH-USD": "ETHUSD", "SOL-USD": "SOLUSD"}
KRAKEN_MIN = {"1h": 60, "4h": 240, "1d": 1440}
TF_DELTA = {"1h": pd.Timedelta(hours=1), "4h": pd.Timedelta(hours=4), "1d": pd.Timedelta(days=1), "1w": pd.Timedelta(days=7)}
TF_RULE = {"1h": "1h", "4h": "4h", "1d": "1D", "1w": "W-MON"}   # тиждень — з понеділка, як на біржах
LIVE_HISTORY = {"1h": "1y", "4h": "1y", "1d": "5y"}


def _utc_index(seconds) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.to_datetime(list(seconds), unit="s", utc=True)).as_unit("ns")


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    df = df.astype(float)
    df["volume"] = df["volume"].fillna(0.0)
    df = df.dropna(subset=["open", "high", "low", "close"])
    return df[~df.index.duplicated(keep="last")].sort_index()


@functools.lru_cache(maxsize=64)
def fetch_yahoo(symbol: str, range_: str, interval: str) -> pd.DataFrame:
    url = "https://query1.finance.yahoo.com/v8/finance/chart/" + requests.utils.quote(symbol, safe="")
    r = requests.get(url, params={"range": range_, "interval": interval}, headers=UA, timeout=TIMEOUT)
    r.raise_for_status()
    chart = r.json()["chart"]
    if not chart.get("result"):
        raise RuntimeError(f"Yahoo: {chart.get('error')}")
    res = chart["result"][0]
    q = res["indicators"]["quote"][0]
    return _clean(pd.DataFrame({k: q.get(k) for k in COLS}, index=_utc_index(res["timestamp"])))


@functools.lru_cache(maxsize=64)
def fetch_kraken(symbol: str, tf: str) -> pd.DataFrame:
    r = requests.get("https://api.kraken.com/0/public/OHLC",
                     params={"pair": KRAKEN_PAIRS[symbol], "interval": KRAKEN_MIN[tf]},
                     headers=UA, timeout=TIMEOUT)
    r.raise_for_status()
    j = r.json()
    if j.get("error"):
        raise RuntimeError(f"Kraken: {j['error']}")
    rows = j["result"][next(k for k in j["result"] if k != "last")]
    df = pd.DataFrame(rows, columns=["t", "open", "high", "low", "close", "vwap", "volume", "count"])
    return _clean(df[COLS].set_index(_utc_index(df["t"].astype(int))))


def resample(df: pd.DataFrame, tf: str) -> pd.DataFrame:
    agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    kw = {} if tf in ("1d", "1w") else {"origin": "epoch"}  # години рахуємо від 00:00 UTC
    return df.resample(TF_RULE[tf], label="left", closed="left", **kw).agg(agg).dropna(subset=["close"])


def closed_only(df: pd.DataFrame, tf: str, now: pd.Timestamp) -> pd.DataFrame:
    """Лише свічки, що вже закрились — щоб не було хибних сигналів на незавершеній свічці."""
    return df[df.index + TF_DELTA[tf] <= now]


def get_series(symbol: str, tf: str, history: str | None = None, demo: bool = False,
               now: pd.Timestamp | None = None) -> pd.DataFrame:
    """Закриті свічки таймфрейму tf ('1h' | '4h' | '1d')."""
    now = now or pd.Timestamp.now(tz="UTC")
    src_tf = "1d" if tf == "1d" else "1h"
    if demo:
        from demo_data import synthetic_hourly
        raw, src_tf = synthetic_hourly(symbol), "1h"
    else:
        raw, errors = None, []
        try:
            raw = fetch_yahoo(symbol, history or LIVE_HISTORY[tf], src_tf)
        except Exception as e:  # noqa: BLE001
            errors.append(str(e)[:150])
        if (raw is None or raw.empty) and symbol in KRAKEN_PAIRS:
            try:
                return closed_only(fetch_kraken(symbol, tf), tf, now).copy()
            except Exception as e:  # noqa: BLE001
                errors.append(str(e)[:150])
        if raw is None or raw.empty:
            raise RuntimeError("; ".join(errors) or "порожня відповідь")
    raw = closed_only(raw, src_tf, now)
    out = raw if tf == src_tf else resample(raw, tf)
    return closed_only(out, tf, now).copy()


def fetch_fear_greed() -> dict | None:
    """{'value': 0..100, 'class': 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed'}"""
    try:
        r = requests.get("https://api.alternative.me/fng/", params={"limit": 1}, headers=UA, timeout=TIMEOUT)
        d = r.json()["data"][0]
        return {"value": int(d["value"]), "class": d["value_classification"]}
    except Exception:  # noqa: BLE001
        return None
