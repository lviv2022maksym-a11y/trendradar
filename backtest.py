"""Перевірка стратегії на історії: чи заробили б сигнали купівлі в минулому
і чи справді оцінка ВИГІДНО/НЕВИГІДНО щось означала.

  python backtest.py                  усі активи з config.json
  python backtest.py --symbol BTC-USD один актив
  python backtest.py --tf 1d          денні свічки (довша історія, ~10 років)
  python backtest.py --no-filter      без фільтра денного тренду (для порівняння)
  python backtest.py --demo           штучні дані, без інтернету
  python backtest.py --telegram       надіслати підсумок у Telegram

Симуляція: вхід на відкритті наступної свічки після сигналу, вихід по стопу або цілі.
Якщо в одній свічці зачеплено і стоп, і ціль — рахуємо стоп (песимістично). Комісія з обох боків.
"""
from __future__ import annotations

import argparse
import html
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

import settings
import telegram
from data import get_series
from i18n import asset_name, set_language, t, th
from indicators import add_indicators
from market import attach_daily_trend
from render import V_EMOJI
from strategy import BUY_TYPES, MIN_BARS, signals_at
from verdict import assess

HISTORY = {"1h": "720d", "4h": "720d", "1d": "10y"}
FWD_BARS = {"1h": 120, "4h": 30, "1d": 5}  # ≈ 5 днів уперед


def load(asset: dict, tf: str, demo: bool) -> pd.DataFrame:
    main = add_indicators(get_series(asset["symbol"], tf, HISTORY[tf], demo))
    if tf == "1d":
        return main.assign(d_trend=main["trend"])
    try:
        daily = add_indicators(get_series(asset["symbol"], "1d", "10y", demo))
    except Exception:  # noqa: BLE001
        daily = None
    return attach_daily_trend(main, daily, tf)


def run(df: pd.DataFrame, asset: dict, cfg: dict) -> list[dict]:
    trades, i, n = [], MIN_BARS, len(df)
    fee = cfg["fees_pct"] / 100
    while i < n - 1:
        if not any(s["type"] in BUY_TYPES for s in signals_at(df, i, asset, cfg)):
            i += 1
            continue
        a = float(df["atr"].iloc[i])
        entry = float(df["open"].iloc[i + 1])
        stop, target = entry - cfg["atr_stop_mult"] * a, entry + cfg["atr_target_mult"] * a
        exit_px, reason, j = None, "open", i + 1
        while j < n:
            if df["low"].iloc[j] <= stop:
                exit_px, reason = min(stop, float(df["open"].iloc[j])), "stop"
                break
            if df["high"].iloc[j] >= target:
                exit_px, reason = max(target, float(df["open"].iloc[j])), "target"
                break
            j += 1
        if exit_px is None:
            exit_px, j = float(df["close"].iloc[-1]), n - 1
        ret = exit_px * (1 - fee) / (entry * (1 + fee)) - 1
        trades.append({"ret_pct": ret * 100, "reason": reason, "stop_pct": (stop / entry - 1) * 100})
        i = j + 1
    return trades


def trade_stats(trades: list[dict], df: pd.DataFrame, cfg: dict) -> dict:
    closed = [x for x in trades if x["reason"] != "open"]
    wins = [x["ret_pct"] for x in closed if x["ret_pct"] > 0]
    losses = [x["ret_pct"] for x in closed if x["ret_pct"] <= 0]
    equity = peak = 1.0
    max_dd, risk = 0.0, cfg["risk_per_trade_pct"] / 100
    for x in trades:  # розмір позиції за стопом: -1R ≈ втрата risk% депозиту
        equity *= 1 + risk * (x["ret_pct"] / abs(x["stop_pct"]) if x["stop_pct"] else 0.0)
        peak = max(peak, equity)
        max_dd = max(max_dd, 1 - equity / peak)
    n = len(closed)
    return {"n": len(trades), "closed": n, "wr": len(wins) / n * 100 if n else 0.0,
            "w": sum(wins) / len(wins) if wins else 0.0, "l": sum(losses) / len(losses) if losses else 0.0,
            "e": (sum(wins) + sum(losses)) / n if n else 0.0, "r": (equity - 1) * 100, "dd": max_dd * 100,
            "bh": (df["close"].iloc[-1] / df["close"].iloc[MIN_BARS] - 1) * 100,
            "period": f"{df.index[MIN_BARS]:%d.%m.%Y} — {df.index[-1]:%d.%m.%Y}"}


def verdict_stats(df: pd.DataFrame, tf: str, crypto: bool) -> dict:
    """Середня зміна ціни через ~5 днів після кожної оцінки (без 1г-тренду і індексу страху — їх немає в історії)."""
    h = FWD_BARS[tf]
    buckets: dict[str, list[float]] = {"BUY": [], "WAIT": [], "AVOID": []}
    close = df["close"].to_numpy()
    for i in range(MIN_BARS, len(df) - h):
        v = assess(df.iloc[i], df.iloc[i - 1], tf, is_crypto=crypto)
        buckets[v["verdict"]].append((close[i + h] / close[i] - 1) * 100)
    return {k: {"n": len(x), "avg": sum(x) / len(x) if x else 0.0,
                "pos": sum(1 for y in x if y > 0) / len(x) * 100 if x else 0.0} for k, x in buckets.items()}


def report(asset: dict, s: dict, vs: dict) -> str:
    verdict = th("bt_few") if s["closed"] < 10 else th("bt_plus") if s["r"] > 0 else th("bt_minus")
    L = [f"<b>{html.escape(asset_name(asset))}</b>  <i>{s['period']}</i>",
         "• " + th("bt_trades", n=s["n"], wr=s["wr"]),
         "• " + th("bt_avg", w=s["w"], l=s["l"]),
         "• " + th("bt_exp", e=s["e"]),
         "• " + th("bt_ret", risk=f"{CFG['risk_per_trade_pct']:g}", r=s["r"], dd=s["dd"]),
         "• " + th("bt_bh", bh=s["bh"]),
         "• " + th("bt_verdict", v=verdict),
         th("bt_v_title")]
    for k in ("BUY", "WAIT", "AVOID"):
        if vs[k]["n"]:
            L.append(f"   {V_EMOJI[k]} " + th("bt_v_line", v=th("v_" + k), avg=vs[k]["avg"], pos=vs[k]["pos"], n=vs[k]["n"]))
    return "\n".join(L)


def analyze_one(asset: dict, cfg: dict, tf: str, demo: bool) -> str:
    try:
        df = load(asset, tf, demo)
        return report(asset, trade_stats(run(df, asset, cfg), df, cfg), verdict_stats(df, tf, asset.get("crypto", False)))
    except Exception as e:  # noqa: BLE001
        return f"<b>{html.escape(asset_name(asset))}</b>: ⚠️ {th('bt_error')} — {html.escape(str(e)[:200])}"


CFG = settings.load()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol")
    ap.add_argument("--tf", default=CFG["timeframe"], choices=["1h", "4h", "1d"])
    ap.add_argument("--no-filter", action="store_true")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--telegram", action="store_true")
    ap.add_argument("--lang", choices=["uk", "en", "ru"])
    args = ap.parse_args()
    set_language(args.lang or CFG["language"])
    cfg = {**CFG, "timeframe": args.tf, "daily_trend_filter": not args.no_filter and CFG["daily_trend_filter"]}
    assets = [a for a in cfg["assets"] if not args.symbol or a["symbol"] == args.symbol]

    with ThreadPoolExecutor(max_workers=min(8, len(assets) or 1)) as ex:
        parts = list(ex.map(lambda a: analyze_one(a, cfg, args.tf, args.demo), assets))
    head = [th("bt_title", tf=th("tf_" + args.tf), fee=f"{cfg['fees_pct']:g}"),
            th("bt_filter", state=th("on") if cfg["daily_trend_filter"] else th("off")), ""]
    text = "\n".join(head + [p + "\n" for p in parts] + [f"<i>{th('bt_note')}</i>"])
    if args.telegram:
        # Telegram обмежує повідомлення 4096 символами — ділимо по активах
        chunk = ""
        for block in text.split("\n\n"):
            if len(chunk) + len(block) > 3800:
                telegram.send(chunk)
                chunk = ""
            chunk += block + "\n\n"
        if chunk.strip():
            telegram.send(chunk)
    import re
    print(html.unescape(re.sub(r"</?[bi]>", "", text)))


if __name__ == "__main__":
    main()
