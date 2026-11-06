"""Загальна оцінка активу: ВИГІДНО / ЧЕКАТИ / НЕВИГІДНО (бал 0–100).

Це зважена сума простих факторів (тренди на різних графіках, RSI, імпульс, перегрів,
настрій ринку). Не прогноз і не гарантія — лише стисла картина «за правилами».
"""
from __future__ import annotations

import pandas as pd

BUY_AT, AVOID_AT = 70, 40  # пороги балу 0–100


HTF = {"1h": "1d", "4h": "1d", "1d": "1w"}
LTF = {"1h": None, "4h": "1h", "1d": None}


def assess(row: pd.Series, prev: pd.Series, tf: str, trends: dict | None = None,
           fng: dict | None = None, has_buy: bool = False, is_crypto: bool = False) -> dict:
    """tf — код основного таймфрейму ('4h', '1d'); trends — тренди за кодами таймфреймів (для молодшого графіка).
    У параметрах факторів — коди таймфреймів (htf/mtf/ltf), їх перекладає render.py."""
    trends = trends or {}
    f: list[tuple[str, dict, int]] = []
    htf, ltf = HTF.get(tf, "1d"), LTF.get(tf)

    def add(key: str, pts: int, **kw) -> None:
        f.append((key, kw, pts))

    d, m = row.get("d_trend", "flat"), row["trend"]
    s = trends.get(ltf, "flat") if ltf else "flat"
    if d == "up":
        add("f_htf_up", 25, htf=htf)
    elif d == "down":
        add("f_htf_down", -25, htf=htf)
    if m == "up":
        add("f_main_up", 15, mtf=tf)
    elif m == "down":
        add("f_main_down", -15, mtf=tf)
    if s == "up":
        add("f_ltf_up", 5, ltf=ltf)
    elif s == "down":
        add("f_ltf_down", -5, ltf=ltf)

    rsi = float(row["rsi"])
    if rsi < 30:
        if m == "up" or d == "up":
            add("f_rsi_oversold", 20, v=rsi)
        else:
            add("f_rsi_knife", -5, v=rsi)
    elif rsi < 45 and m == "up":
        add("f_rsi_pullback", 10, v=rsi)
    elif rsi > 70:
        add("f_rsi_overbought", -15, v=rsi)

    if row["macd_hist"] > prev["macd_hist"]:
        add("f_macd_up", 10)
    else:
        add("f_macd_down", -10)
    if row["dist_ema50_atr"] > 4:
        add("f_overextended", -10)
    if is_crypto and fng:
        if fng["value"] < 25:
            add("f_fng_fear", 5, v=fng["value"])
        elif fng["value"] > 75:
            add("f_fng_greed", -5, v=fng["value"])
    if has_buy:
        add("f_signal", 15)

    raw = max(-100, min(100, sum(p for *_, p in f)))
    score = int((raw + 100) / 2 + 0.5)  # округлення 62.5 → 63 (як у JavaScript-версії)
    verdict = "BUY" if score >= BUY_AT else "AVOID" if score <= AVOID_AT else "WAIT"
    top = sorted(f, key=lambda x: -abs(x[2]))[:4]
    return {"verdict": verdict, "score": score, "factors": f, "top": top}
