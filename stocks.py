"""Акції США: щоденний аналіз списку якісних компаній і фондів → дані для вкладки «Акції» в програмі.

  python stocks.py --out site_data --cache stock_cache   (так запускає GitHub)
  python stocks.py --out site_data --demo                (штучні дані, без інтернету)

Аналіз — на денних свічках (старший графік — тижневий), тими самими правилами, що й крипта.
Ціни — закриття торгового дня (Yahoo Finance). Дані оновлюються раз на день після закриття біржі,
тому повторні запуски протягом дня беруть збережену копію з --cache і не навантажують Yahoo.
"""
from __future__ import annotations

import argparse
import json
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

import settings
from data import fetch_yahoo, closed_only, resample
from indicators import add_indicators
from market import attach_htf_trend
from strategy import BUY_TYPES, signals_at
from verdict import assess

# Тільки великі, ліквідні, відомі компанії та фонди (без «копійчаних» і сумнівних акцій).
# (символ Yahoo, символ Alpaca, назва, сектор)
UNIVERSE = [
    ("AAPL", "AAPL", "Apple", "tech"), ("MSFT", "MSFT", "Microsoft", "tech"), ("NVDA", "NVDA", "NVIDIA", "tech"),
    ("AVGO", "AVGO", "Broadcom", "tech"), ("AMD", "AMD", "AMD", "tech"), ("ORCL", "ORCL", "Oracle", "tech"),
    ("ADBE", "ADBE", "Adobe", "tech"), ("CRM", "CRM", "Salesforce", "tech"), ("CSCO", "CSCO", "Cisco", "tech"),
    ("QCOM", "QCOM", "Qualcomm", "tech"), ("TXN", "TXN", "Texas Instruments", "tech"), ("IBM", "IBM", "IBM", "tech"),
    ("NOW", "NOW", "ServiceNow", "tech"), ("INTU", "INTU", "Intuit", "tech"),
    ("GOOGL", "GOOGL", "Alphabet (Google)", "comm"), ("META", "META", "Meta", "comm"), ("NFLX", "NFLX", "Netflix", "comm"),
    ("DIS", "DIS", "Disney", "comm"), ("VZ", "VZ", "Verizon", "comm"), ("TMUS", "TMUS", "T-Mobile US", "comm"),
    ("AMZN", "AMZN", "Amazon", "cons"), ("TSLA", "TSLA", "Tesla", "cons"), ("HD", "HD", "Home Depot", "cons"),
    ("MCD", "MCD", "McDonald's", "cons"), ("NKE", "NKE", "Nike", "cons"), ("SBUX", "SBUX", "Starbucks", "cons"),
    ("LOW", "LOW", "Lowe's", "cons"), ("BKNG", "BKNG", "Booking", "cons"),
    ("WMT", "WMT", "Walmart", "staples"), ("COST", "COST", "Costco", "staples"), ("PG", "PG", "Procter & Gamble", "staples"),
    ("KO", "KO", "Coca-Cola", "staples"), ("PEP", "PEP", "PepsiCo", "staples"), ("PM", "PM", "Philip Morris", "staples"),
    ("LLY", "LLY", "Eli Lilly", "health"), ("UNH", "UNH", "UnitedHealth", "health"), ("JNJ", "JNJ", "Johnson & Johnson", "health"),
    ("ABBV", "ABBV", "AbbVie", "health"), ("MRK", "MRK", "Merck", "health"), ("TMO", "TMO", "Thermo Fisher", "health"),
    ("ABT", "ABT", "Abbott", "health"), ("ISRG", "ISRG", "Intuitive Surgical", "health"),
    ("BRK-B", "BRK.B", "Berkshire Hathaway", "fin"), ("JPM", "JPM", "JPMorgan Chase", "fin"), ("V", "V", "Visa", "fin"),
    ("MA", "MA", "Mastercard", "fin"), ("BAC", "BAC", "Bank of America", "fin"), ("GS", "GS", "Goldman Sachs", "fin"),
    ("MS", "MS", "Morgan Stanley", "fin"), ("AXP", "AXP", "American Express", "fin"), ("BLK", "BLK", "BlackRock", "fin"),
    ("CAT", "CAT", "Caterpillar", "ind"), ("GE", "GE", "GE Aerospace", "ind"), ("HON", "HON", "Honeywell", "ind"),
    ("UNP", "UNP", "Union Pacific", "ind"), ("LMT", "LMT", "Lockheed Martin", "ind"), ("RTX", "RTX", "RTX", "ind"),
    ("DE", "DE", "Deere & Co.", "ind"),
    ("XOM", "XOM", "Exxon Mobil", "energy"), ("CVX", "CVX", "Chevron", "energy"), ("NEE", "NEE", "NextEra Energy", "energy"),
    ("SPY", "SPY", "S&P 500 (SPY)", "etf"), ("QQQ", "QQQ", "Nasdaq 100 (QQQ)", "etf"), ("DIA", "DIA", "Dow Jones (DIA)", "etf"),
    ("IWM", "IWM", "Russell 2000 (IWM)", "etf"), ("VTI", "VTI", "Total US Market (VTI)", "etf"), ("SCHD", "SCHD", "US Dividend (SCHD)", "etf"),
    ("GLD", "GLD", "Gold (GLD)", "etf"), ("SLV", "SLV", "Silver (SLV)", "etf"), ("TLT", "TLT", "US Treasury 20y+ (TLT)", "etf"),
    ("XLK", "XLK", "Tech Sector (XLK)", "etf"), ("XLE", "XLE", "Energy Sector (XLE)", "etf"),
]
SECTORS = ["tech", "comm", "cons", "staples", "health", "fin", "ind", "energy", "etf"]
HISTORY = "5y"          # ~1250 денних свічок: вистачає для EMA200 і тижневого тренду
SPARK = 40


def _round(x: float) -> float:
    return round(float(x), 2 if abs(x) >= 10 else 4)


def daily_bars(yahoo_sym: str, demo: bool) -> pd.DataFrame:
    """Закриті денні свічки з датою 00:00 UTC (день торгів)."""
    if demo:
        from demo_data import synthetic_hourly
        df = resample(synthetic_hourly(yahoo_sym, n=24 * 1300), "1d")
    else:
        for attempt in range(4):           # Yahoo іноді відповідає «забагато запитів» — чекаємо і пробуємо ще
            try:
                df = fetch_yahoo(yahoo_sym, HISTORY, "1d")
                break
            except Exception:  # noqa: BLE001
                if attempt == 3:
                    raise
                time.sleep(2 * 2 ** attempt)
        df = df.copy()
        df.index = df.index.floor("D")
        df = df[~df.index.duplicated(keep="last")]
    return closed_only(df, "1d", pd.Timestamp.now(tz="UTC"))


def analyze_stock(entry: tuple, cfg: dict, demo: bool) -> tuple[dict, dict]:
    ysym, asym, name, sector = entry
    daily = add_indicators(daily_bars(ysym, demo))
    weekly = add_indicators(resample(daily[["open", "high", "low", "close", "volume"]], "1w"))
    df = attach_htf_trend(daily, weekly, "1d", "1w")
    i = len(df) - 1
    scfg = {**cfg, "timeframe": "1d"}
    sigs = signals_at(df, i, {"symbol": ysym, "sharp_move_pct": 4.0}, scfg)
    has_buy = any(s["type"] in BUY_TYPES for s in sigs)
    v = assess(df.iloc[i], df.iloc[i - 1], "1d", {}, None, has_buy, False)
    close = df["close"]
    summary = {
        "symbol": asym, "yahoo": ysym, "name": name, "sector": sector,
        "price": _round(close.iloc[-1]), "chg": round((close.iloc[-1] / close.iloc[-2] - 1) * 100, 3),
        "date": df.index[-1].strftime("%Y-%m-%d"), "verdict": v["verdict"], "score": v["score"],
        "factors": [[k, kw, p] for k, kw, p in v["factors"]],
        "trends": {"1d": df["trend"].iloc[-1], "1w": df["d_trend"].iloc[-1]},
        "signal": next((s["type"] for s in sigs if s["type"] in BUY_TYPES), None),
        "spark": [_round(x) for x in close.iloc[-SPARK:]],
    }
    bars = {
        "symbol": asym, "name": name, "date": summary["date"],
        "t": [int(ts.value // 10**6) for ts in df.index],
        "o": [_round(x) for x in df["open"]], "h": [_round(x) for x in df["high"]],
        "l": [_round(x) for x in df["low"]], "c": [_round(x) for x in df["close"]],
        "v": [int(x) for x in df["volume"]],
        "htf": df["d_trend"].tolist(),       # тижневий тренд на кожну свічку — програма рахує ту саму оцінку
    }
    return summary, bars


def expected_session(now: datetime) -> str:
    """Останній торговий день, дані якого вже мають бути (після закриття о 16:00 за Нью-Йорком + запас)."""
    d = now - timedelta(hours=21, minutes=30)       # до 21:30 UTC беремо попередній день
    while d.weekday() >= 5:                          # субота/неділя → п'ятниця
        d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")


def build(out: Path, cfg: dict, demo: bool) -> dict:
    (out / "stocks").mkdir(parents=True, exist_ok=True)
    results, errors = [], []

    def job(entry):
        try:
            return analyze_stock(entry, cfg, demo)
        except Exception as e:  # noqa: BLE001 — одна акція не повинна зупиняти інші
            errors.append(f"{entry[0]}: {str(e)[:100]}")
            return None

    with ThreadPoolExecutor(max_workers=6) as ex:
        for r in ex.map(job, UNIVERSE):
            if r:
                summary, bars = r
                results.append(summary)
                (out / "stocks" / f"{summary['symbol'].replace('.', '-')}.json").write_text(
                    json.dumps(bars, separators=(",", ":")), encoding="utf-8")
    session = max((s["date"] for s in results), default="")
    doc = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "session": session,
           "sectors": SECTORS, "stocks": results, "errors": errors, "demo": demo}
    (out / "stocks.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return doc


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site_data")
    ap.add_argument("--cache", help="папка зі збереженою копією (щоб не завантажувати повторно протягом дня)")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--force", action="store_true", help="оновити, навіть якщо копія свіжа")
    args = ap.parse_args()
    cfg = settings.load()
    out = Path(args.out)
    cache = Path(args.cache) if args.cache else None
    need = expected_session(datetime.now(timezone.utc))
    if cache and not args.force and (cache / "stocks.json").exists():
        try:
            old = json.loads((cache / "stocks.json").read_text(encoding="utf-8"))
            if old.get("session", "") >= need and len(old.get("stocks", [])) >= len(UNIVERSE) * 0.8:
                shutil.copytree(cache, out, dirs_exist_ok=True)
                print(f"Акції: збережена копія за {old['session']} ще актуальна ({len(old['stocks'])} шт.)")
                return
        except (OSError, ValueError):
            pass
    t0 = time.perf_counter()
    doc = build(out, cfg, args.demo)
    print(f"Акції: {len(doc['stocks'])}/{len(UNIVERSE)} за {doc['session']}, помилок {len(doc['errors'])}, "
          f"{time.perf_counter() - t0:.1f} с")
    for e in doc["errors"][:10]:
        print("  ⚠️", e)
    if cache and len(doc["stocks"]) >= len(UNIVERSE) * 0.8:
        shutil.copytree(out, cache, dirs_exist_ok=True, ignore=shutil.ignore_patterns("news.json", "markets.json"))


if __name__ == "__main__":
    main()
