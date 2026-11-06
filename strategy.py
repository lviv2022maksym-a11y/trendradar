"""Правила сигналів. Сигнал — словник: тип, причини (ключі перекладу), бали впевненості, план угоди."""
from __future__ import annotations

import pandas as pd

MIN_BARS = 210          # потрібно для EMA200
MAX_SCORE = 5           # максимум додаткових підтверджень
BUY_TYPES = {"BUY_PULLBACK", "BUY_BREAKOUT"}


def confidence(score: int) -> str:
    return "high" if score >= 4 else "medium" if score >= 2 else "low"


def trade_plan(entry: float, atr: float, cfg: dict, deposit: float | None = None) -> dict:
    """Стоп/ціль за ATR і розмір позиції за правилом ризику: ризик$ ÷ відстань до стопу."""
    deposit = cfg["deposit_usd"] if deposit is None else deposit
    stop = entry - cfg["atr_stop_mult"] * atr
    target = entry + cfg["atr_target_mult"] * atr
    risk_usd = deposit * cfg["risk_per_trade_pct"] / 100
    per_unit = max(entry - stop, 1e-12)
    size = risk_usd / per_unit * entry
    cap = deposit * cfg["max_position_pct"] / 100
    return {
        "entry": entry, "stop": stop, "target": target,
        "stop_pct": (stop / entry - 1) * 100, "target_pct": (target / entry - 1) * 100,
        "risk_usd": risk_usd, "size_usd": min(size, cap), "capped": size > cap,
        "rr": (target - entry) / per_unit,
    }


def signals_at(df: pd.DataFrame, i: int, asset: dict, cfg: dict) -> list[dict]:
    """Сигнали на закритій свічці i (df з індикаторами і колонкою d_trend)."""
    if i < MIN_BARS or i >= len(df):
        return []
    r, p = df.iloc[i], df.iloc[i - 1]
    d_trend = r.get("d_trend", "flat")
    buys_allowed = not (cfg.get("daily_trend_filter", True) and d_trend == "down")
    price = float(r["close"])
    out: list[dict] = []

    extras = []
    if r["vol_ratio"] >= 1.2:
        extras.append(("r_volume", {"x": r["vol_ratio"]}))
    if r["close"] > r["open"]:
        extras.append(("r_green", {}))
    if r["macd_hist"] > p["macd_hist"]:
        extras.append(("r_macd", {}))
    if r["close"] > r["ema20"]:
        extras.append(("r_ema20", {}))
    if d_trend == "up":
        extras.append(("r_htf_up", {"htf": {"1h": "1d", "4h": "1d", "1d": "1w"}.get(cfg.get("timeframe", "4h"), "1d")}))
    score = len(extras)

    # 1) Відкат у висхідному тренді: RSI був нижче 40 і повернувся вгору
    if buys_allowed and r["trend"] == "up" and p["rsi"] < 40 <= r["rsi"]:
        out.append({"type": "BUY_PULLBACK", "price": price, "score": score,
                    "reasons": [("r_trend_up", {}), ("r_rsi_bounce", {"a": p["rsi"], "b": r["rsi"]}), *extras],
                    "plan": trade_plan(price, float(r["atr"]), cfg)})

    # 2) Пробій максимуму 20 свічок із сильним обсягом над EMA200
    if (buys_allowed and r["close"] > r["ema200"] and r["close"] > r["high20_prev"]
            and p["close"] <= p["high20_prev"] and r["vol_ratio"] >= 1.5):
        out.append({"type": "BUY_BREAKOUT", "price": price, "score": score,
                    "reasons": [("r_breakout", {"lvl": f"{r['high20_prev']:,.2f}".replace(",", " ")}),
                                ("r_strong_volume", {"x": r["vol_ratio"]}), ("r_above_ema200", {}),
                                *[e for e in extras if e[0] != "r_volume"]],
                    "plan": trade_plan(price, float(r["atr"]), cfg)})

    # 3) Злам тренду: закриття нижче EMA200
    if p["close"] >= p["ema200"] > r["close"]:
        out.append({"type": "EXIT_TREND", "price": price,
                    "reasons": [("r_trend_break", {}), ("r_trend_break2", {})]})

    # 4) Сильна перекупленість
    if p["rsi"] < 75 <= r["rsi"]:
        out.append({"type": "TAKE_PROFIT", "price": price,
                    "reasons": [("r_rsi_high", {"v": r["rsi"]}), ("r_rsi_high2", {})]})

    # 5) Різкий рух за одну свічку
    if abs(r["chg_pct"]) >= asset.get("sharp_move_pct", 3.0):
        out.append({"type": "SHARP_MOVE", "price": price, "chg": float(r["chg_pct"]),
                    "reasons": [("r_sharp1", {}), ("r_sharp2", {})]})
    return out
