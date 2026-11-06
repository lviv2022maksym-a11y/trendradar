"""TrendRadar — головний скрипт: аналізує ринок і надсилає сигнали в Telegram.

  python bot.py              звичайна перевірка (так запускає GitHub кожну годину)
  python bot.py --summary    одразу надіслати огляд ринку
  python bot.py --weekly     одразу надіслати тижневий звіт віртуального портфеля
  python bot.py --demo       перевірка на штучних даних, без інтернету
  python bot.py --lang en    мова повідомлень (uk / en / ru), інакше — з config.json
  python bot.py --site-data site_data   записати markets.json для сайту і взяти новини з site_data/news.json
"""
from __future__ import annotations

import argparse
import json
import time
import traceback
from pathlib import Path

import pandas as pd

import paper
import render
import settings
import state as state_mod
import telegram
from data import fetch_fear_greed
from i18n import ASSET_NAMES, asset_name, set_language, t
from news import headlines
from market import analyze_all
from strategy import BUY_TYPES, signals_at
from verdict import assess

VERDICT_ALERT_GAP = pd.Timedelta(hours=8)


def demo_fng() -> dict:
    return {"value": 22, "class": "Extreme Fear"}


def chart_png(cfg, asset, df, sig, verdict) -> bytes | None:
    if not cfg["send_charts"]:
        return None
    from chart import render_chart
    try:
        return render_chart(df, asset_name(asset), render.tf_label(cfg["timeframe"]),
                            plan=sig.get("plan"), verdict=verdict, verdict_label=t("v_" + verdict["verdict"]),
                            labels={"entry": t("entry"), "stop": t("stop"), "target": t("target")})
    except Exception:  # noqa: BLE001 — без картинки теж надішлемо
        traceback.print_exc()
        return None


def process_asset(cfg, st, asset, res, fng, now, demo) -> list[str] | None:
    """Обробляє один актив: віртуальні угоди, сигнали, зміна оцінки. Повертає блок для огляду."""
    sym, df, tf = asset["symbol"], res["df"], cfg["timeframe"]
    i = len(df) - 1
    bar_time = df.index[i]
    sent = st.setdefault("sent", {})
    btns = render.buttons(asset)

    # 1) Віртуальні угоди: чи спрацював стоп або ціль
    if cfg["paper_trading"]:
        for c in paper.update(st, cfg, sym, df):
            telegram.send(render.paper_close_message(asset, c, paper.book(st, cfg)["balance"]))

    # 2) Нові сигнали на останній закритій свічці
    sigs = signals_at(df, i, asset, cfg)
    has_buy = any(s["type"] in BUY_TYPES for s in sigs)
    v = assess(df.iloc[i], df.iloc[i - 1], tf, res["trends"], fng, has_buy, asset.get("crypto", False))
    signal_sent = False
    for sig in sigs:
        key = f"{sym}:{sig['type']}"
        if sent.get(key) == bar_time.isoformat():
            continue  # уже надсилали для цієї свічки
        note = None
        if sig["type"] in BUY_TYPES and cfg["paper_trading"]:
            size = paper.open_trade(st, cfg, sym, sig, bar_time, float(df["atr"].iloc[i]))
            note = t("paper_opened", size=render.money(size)) if size else t("paper_busy")
        text = render.signal_message(asset, sig, bar_time, res["trends"], v, cfg, note)
        png = chart_png(cfg, asset, df, sig, v)
        ok = telegram.send_photo(png, text, btns) if png else telegram.send(text, btns)
        if ok or demo:
            sent[key] = bar_time.isoformat()
            signal_sent = True

    # 3) Зміна загальної оцінки (не частіше разу на 8 годин на актив)
    if cfg["verdict_alerts"]:
        vs = st.setdefault("verdicts", {})
        prev = vs.get(sym)
        if prev is None or signal_sent:
            vs[sym] = {"v": v["verdict"], "t": now.isoformat()}
        elif prev["v"] != v["verdict"] and now - pd.Timestamp(prev["t"]) >= VERDICT_ALERT_GAP:
            if telegram.send(render.verdict_change_message(asset, prev["v"], v, res["price"]), btns) or demo:
                vs[sym] = {"v": v["verdict"], "t": now.isoformat()}

    return render.summary_block(asset, res, v), v


def main() -> None:
    ap = argparse.ArgumentParser(description="TrendRadar signal bot")
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--weekly", action="store_true")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--lang", choices=["uk", "en", "ru"])
    ap.add_argument("--site-data", help="папка даних сайту: сюди пишемо markets.json, звідси беремо news.json")
    args = ap.parse_args()

    started = time.perf_counter()
    cfg = settings.load()
    set_language(args.lang or cfg["language"])
    st = state_mod.load()
    now = pd.Timestamp.now(tz="UTC")
    want_crypto = any(a.get("crypto") for a in cfg["assets"])
    fng_fn = (demo_fng if args.demo else fetch_fear_greed) if want_crypto else None

    results, fng = analyze_all(cfg["assets"], cfg, args.demo, extra=fng_fn)

    today = now.date().isoformat()
    want_summary = args.summary or (now.hour >= cfg["daily_summary_hour_utc"] and st.get("summary_date") != today)
    blocks, errors, export = [], [], []
    for asset, res, err in results:
        if err is not None:
            print(f"[{asset['symbol']}] {err}")
            errors.append(f"{asset_name(asset)}: {str(err)[:200]}")
            blocks.append([f"⚪ <b>{render.name(asset)}</b> — {t('no_data')}"])
            continue
        try:
            block, v = process_asset(cfg, st, asset, res, fng, now, args.demo)
            blocks.append(block)
            if not asset.get("crypto"):   # крипта в програмі й так «жива»; сюди — акції та золото
                export.append({"symbol": asset["symbol"], "names": ASSET_NAMES.get(asset["symbol"], {"en": asset["symbol"]}),
                               "price": round(res["price"], 4), "chg24": round(res["chg24"], 3), "verdict": v["verdict"],
                               "score": v["score"], "trends": res["trends"]})
        except Exception as e:  # noqa: BLE001 — один актив не повинен зупиняти інші
            traceback.print_exc()
            errors.append(f"{asset_name(asset)}: {str(e)[:200]}")

    site = Path(args.site_data) if args.site_data else None
    news = None
    if site and (site / "news.json").exists():
        try:
            news = json.loads((site / "news.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            news = None
    if want_summary and blocks:
        pstats = paper.stats(st, cfg) if cfg["paper_trading"] else None
        top = headlines(news, args.lang or cfg["language"])
        best = []
        if site and (site / "stocks.json").exists():
            try:
                sdoc = json.loads((site / "stocks.json").read_text(encoding="utf-8"))
                best = sorted((x for x in sdoc.get("stocks", []) if x.get("verdict") == "BUY"), key=lambda x: -x["score"])[:6]
            except (OSError, ValueError, KeyError):
                best = []
        if telegram.send(render.summary_message(blocks, fng, pstats, now, top, best)) or args.demo:
            st["summary_date"] = today

    week_key = f"{now.isocalendar().year}-W{now.isocalendar().week}"
    want_weekly = cfg["paper_trading"] and (args.weekly or (
        now.weekday() == cfg["weekly_report_weekday"] and now.hour >= cfg["daily_summary_hour_utc"]
        and st.get("weekly_key") != week_key))
    if want_weekly:
        week = paper.stats(st, cfg, since=now - pd.Timedelta(days=7))
        if telegram.send(render.weekly_message(week, paper.stats(st, cfg))) or args.demo:
            st["weekly_key"] = week_key

    if errors:  # про збої даних — не частіше разу на 6 годин
        last = st.get("last_error_alert")
        if not last or now - pd.Timestamp(last) > pd.Timedelta(hours=6):
            telegram.send(render.errors_message(errors))
            st["last_error_alert"] = now.isoformat()

    if site:
        site.mkdir(parents=True, exist_ok=True)
        (site / "markets.json").write_text(json.dumps({"updated": now.isoformat(timespec="seconds"), "assets": export},
                                                      ensure_ascii=False, indent=1), encoding="utf-8")

    st["last_run"] = now.isoformat()
    state_mod.save(st)
    print(f"TrendRadar: {len(results)} активів, помилок {len(errors)}, {time.perf_counter() - started:.1f} с")


if __name__ == "__main__":
    main()
