"""Технічні індикатори."""
import numpy as np
import pandas as pd


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    gain = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    loss = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(100)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    prev = df["close"].shift()
    tr = pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    c = df["close"]
    df["ema20"], df["ema50"], df["ema200"] = ema(c, 20), ema(c, 50), ema(c, 200)
    df["rsi"] = rsi(c)
    df["atr"] = atr(df)
    macd = ema(c, 12) - ema(c, 26)
    df["macd_hist"] = macd - ema(macd, 9)
    vol_avg = df["volume"].rolling(20).mean()
    df["vol_ratio"] = (df["volume"] / vol_avg.replace(0, np.nan)).fillna(1.0)
    df["high20_prev"] = df["high"].rolling(20).max().shift()
    df["chg_pct"] = c.pct_change() * 100
    df["dist_ema50_atr"] = (c - df["ema50"]) / df["atr"].replace(0, np.nan)
    up = (c > df["ema200"]) & (df["ema50"] > df["ema200"])
    down = (c < df["ema200"]) & (df["ema50"] < df["ema200"])
    df["trend"] = np.select([up, down], ["up", "down"], default="flat")
    return df
