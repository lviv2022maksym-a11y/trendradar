"""Аналіз активу на трьох графіках (молодший / основний / старший) і паралельне завантаження всіх активів.

Для 4г: молодший 1г, старший 1д. Для 1д: старший 1т (тиждень). Колонка d_trend = тренд СТАРШОГО графіка."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from data import TF_DELTA, get_series, resample
from indicators import add_indicators

TFS = ("1h", "4h", "1d")
HTF = {"1h": "1d", "4h": "1d", "1d": "1w"}      # старший графік
LTF = {"1h": None, "4h": "1h", "1d": None}      # молодший графік


def attach_htf_trend(df: pd.DataFrame, htf: pd.DataFrame | None, tf: str, htf_tf: str) -> pd.DataFrame:
    """Додає колонку d_trend — тренд старшого графіка станом на закриття кожної свічки (без підглядання в майбутнє)."""
    out = df.copy()
    if htf is None or htf.empty:
        out["d_trend"] = "flat"
        return out
    right = pd.DataFrame({"t": (htf.index + TF_DELTA[htf_tf]).as_unit("ns"), "d_trend": htf["trend"].to_numpy()})
    left = pd.DataFrame({"t": (df.index + TF_DELTA[tf]).as_unit("ns")})
    merged = pd.merge_asof(left, right, on="t", direction="backward")
    out["d_trend"] = merged["d_trend"].fillna("flat").to_numpy()
    return out


def attach_daily_trend(df: pd.DataFrame, daily: pd.DataFrame | None, tf: str) -> pd.DataFrame:
    return attach_htf_trend(df, daily, tf, "1d")


def analyze(asset: dict, cfg: dict, demo: bool = False) -> dict:
    tf = cfg["timeframe"]
    sym = asset["symbol"]
    frames = {t: add_indicators(get_series(sym, t, demo=demo)) for t in sorted({"1h", tf})}
    try:
        frames["1d"] = add_indicators(get_series(sym, "1d", demo=demo))
    except Exception:  # noqa: BLE001 — без денного графіка теж працюємо
        frames["1d"] = None
    if tf == "1d":   # старший графік для денних свічок — тижневий
        weekly = add_indicators(resample(get_series(sym, "1d", history="5y", demo=demo), "1w"))
        main = attach_htf_trend(frames["1d"], weekly, "1d", "1w")
    else:
        main = attach_htf_trend(frames[tf], frames["1d"], tf, "1d")
    trends = {t: (frames[t]["trend"].iloc[-1] if frames.get(t) is not None and len(frames[t]) else "flat") for t in TFS}

    h1 = frames["1h"]
    price = float(h1["close"].iloc[-1])
    ago = h1["close"].loc[: h1.index[-1] - pd.Timedelta(hours=24)]
    chg24 = (price / float(ago.iloc[-1]) - 1) * 100 if len(ago) else 0.0
    return {"asset": asset, "df": main, "trends": trends, "price": price, "chg24": chg24}


def analyze_all(assets: list[dict], cfg: dict, demo: bool = False, extra=None):
    """Паралельно аналізує всі активи. extra — функція, яку теж запустити паралельно (напр. індекс страху).
    Повертає ([(asset, result | None, error | None)], extra_result)."""
    with ThreadPoolExecutor(max_workers=min(16, len(assets) + 1)) as ex:
        extra_f = ex.submit(extra) if extra else None
        futs = [ex.submit(analyze, a, cfg, demo) for a in assets]
        out = []
        for a, f in zip(assets, futs):
            try:
                out.append((a, f.result(), None))
            except Exception as e:  # noqa: BLE001
                out.append((a, None, e))
        return out, (extra_f.result() if extra_f else None)
