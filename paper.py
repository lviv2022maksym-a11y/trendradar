"""Віртуальний портфель: бот «торгує» уявними грошима за своїми сигналами,
щоб чесно перевірити стратегію на реальному ринку без ризику."""
from __future__ import annotations

import pandas as pd


def book(st: dict, cfg: dict) -> dict:
    return st.setdefault("paper", {"balance": float(cfg["deposit_usd"]), "start": float(cfg["deposit_usd"]),
                                   "open": {}, "closed": []})


def open_trade(st: dict, cfg: dict, symbol: str, sig: dict, bar_time: pd.Timestamp, atr: float) -> float | None:
    """Відкриває угоду, якщо по активу ще немає відкритої. Повертає розмір у $ або None."""
    from strategy import trade_plan
    b = book(st, cfg)
    if symbol in b["open"]:
        return None
    plan = trade_plan(sig["price"], atr, cfg, deposit=b["balance"])
    b["open"][symbol] = {"type": sig["type"], "entry": plan["entry"], "stop": plan["stop"], "target": plan["target"],
                         "size": round(plan["size_usd"], 2), "bar_time": bar_time.isoformat()}
    return b["open"][symbol]["size"]


def update(st: dict, cfg: dict, symbol: str, df: pd.DataFrame) -> list[dict]:
    """Перевіряє, чи відкрита угода дійшла до стопу або цілі на нових закритих свічках."""
    b = book(st, cfg)
    tr = b["open"].get(symbol)
    if not tr:
        return []
    for ts, bar in df[df.index > pd.Timestamp(tr["bar_time"])].iterrows():
        if bar["low"] <= tr["stop"]:          # песимістично: стоп перевіряємо першим
            exit_px, reason = min(tr["stop"], bar["open"]), "stop"
            break
        if bar["high"] >= tr["target"]:
            exit_px, reason = max(tr["target"], bar["open"]), "target"
            break
    else:
        return []
    fee = cfg["fees_pct"] / 100
    ret = exit_px * (1 - fee) / (tr["entry"] * (1 + fee)) - 1
    pnl = tr["size"] * ret
    b["balance"] = round(b["balance"] + pnl, 2)
    closed = {**tr, "symbol": symbol, "exit": float(exit_px), "pct": ret * 100, "pnl": pnl,
              "reason": reason, "closed": ts.isoformat()}
    b["closed"] = (b["closed"] + [closed])[-300:]
    del b["open"][symbol]
    return [closed]


def stats(st: dict, cfg: dict, since: pd.Timestamp | None = None) -> dict:
    b = book(st, cfg)
    rows = [c for c in b["closed"] if since is None or pd.Timestamp(c["closed"]) >= since]
    wins = sum(1 for c in rows if c["pnl"] > 0)
    return {"n": len(rows), "wr": wins / len(rows) * 100 if rows else 0.0, "pnl": sum(c["pnl"] for c in rows),
            "balance": b["balance"], "start": b["start"], "open": len(b["open"]),
            "pct": (b["balance"] / b["start"] - 1) * 100}
