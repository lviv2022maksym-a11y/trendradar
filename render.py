"""Оформлення повідомлень Telegram (HTML)."""
from __future__ import annotations

import html

import pandas as pd

from i18n import asset_name, t, th
from strategy import BUY_TYPES, MAX_SCORE, confidence

ARROW = {"up": "↗️", "down": "↘️", "flat": "➡️"}
V_EMOJI = {"BUY": "🟢", "WAIT": "🟡", "AVOID": "🔴"}
SIG_EMOJI = {"BUY_PULLBACK": "🟢", "BUY_BREAKOUT": "🟢", "EXIT_TREND": "🔴", "TAKE_PROFIT": "🟡", "SHARP_MOVE": "⚡"}
TV_URL = "https://www.tradingview.com/chart/?symbol={}"


def money(x: float) -> str:
    dec = 2 if abs(x) >= 1 else 4 if abs(x) >= 0.01 else 8
    return f"{x:,.{dec}f}".replace(",", " ")


def name(asset: dict, upper: bool = False) -> str:
    n = asset_name(asset)
    return html.escape(n.upper() if upper else n)


def tf_label(tf: str) -> str:
    return th("tf_" + tf)


def verdict_badge(v: dict) -> str:
    return f"{V_EMOJI[v['verdict']]} <b>{th('v_' + v['verdict'])}</b> · {v['score']}/100"


def trends_line(trends: dict) -> str:
    return "   ".join(f"{tf_label(tf)} {ARROW.get(trends.get(tf, 'flat'), '➡️')}" for tf in ("1h", "4h", "1d"))


def factor_lines(top) -> list[str]:
    return [f"{'✓' if pts > 0 else '✗'} {html.escape(th(k, **kw))}" for k, kw, pts in top]


def buttons(asset: dict) -> list | None:
    return [[{"text": th("btn_tv"), "url": TV_URL.format(asset["tv"])}]] if asset.get("tv") else None


def signal_message(asset: dict, sig: dict, bar_time: pd.Timestamp, trends: dict, verdict: dict,
                   cfg: dict, paper_note: str | None = None) -> str:
    typ = sig["type"]
    is_buy = typ in BUY_TYPES
    if is_buy:
        head, sub = th("h_BUY"), th("s_" + typ)
    elif typ == "SHARP_MOVE":
        head, sub = th("h_SHARP_UP" if sig["chg"] > 0 else "h_SHARP_DOWN"), th("s_SHARP", chg=sig["chg"])
    else:
        head, sub = th("h_" + typ), th("s_" + typ)

    L = [f"{SIG_EMOJI[typ]} <b>{name(asset, True)} · {html.escape(head.upper())}</b>", f"<i>{html.escape(sub)}</i>", "",
         f"💵 {th('price')}: <b>{money(sig['price'])} $</b>",
         f"🧭 {th('assessment')}: {verdict_badge(verdict)}",
         f"📊 {th('charts')}: {trends_line(trends)}"]
    if is_buy:
        L.append(f"🎯 {th('confidence')}: {'▰' * sig['score']}{'▱' * (MAX_SCORE - sig['score'])} {th('conf_' + confidence(sig['score']))}")
    L += ["", f"<b>{th('why')}</b>", *[f"✓ {html.escape(th(k, **kw))}" for k, kw in sig["reasons"]]]
    if is_buy:
        p = sig["plan"]
        lab = [th("entry"), th("stop"), th("target")]
        w = max(map(len, lab))
        rows = [f"{lab[0].ljust(w)}  {money(p['entry'])} $",
                f"{lab[1].ljust(w)}  {money(p['stop'])} $  {p['stop_pct']:+.1f}%",
                f"{lab[2].ljust(w)}  {money(p['target'])} $  {p['target_pct']:+.1f}%"]
        loss = p["size_usd"] * -p["stop_pct"] / 100
        L += ["", f"<b>{th('plan')}</b>", "<pre>" + html.escape("\n".join(rows)) + "</pre>" + th("rr", rr=p["rr"]),
              "", f"<b>{th('size')}</b>",
              th("size_line", size=money(p["size_usd"]), risk=money(p["risk_usd"]), pct=f"{cfg['risk_per_trade_pct']:g}")
              + (f" · {th('capped')}" if p["capped"] else ""),
              th("loss_line", loss=money(loss))]
    if paper_note:
        L += ["", paper_note]
    L += ["", f"<i>{th('candle', tf=tf_label(cfg['timeframe']), time=bar_time.strftime('%d.%m %H:%M'))}</i>",
          f"<i>{th('disclaimer')}</i>"]
    return "\n".join(L)


def verdict_change_message(asset: dict, old: str, v: dict, price: float) -> str:
    return "\n".join([
        t("verdict_change", name=name(asset)),
        f"{V_EMOJI[old]} {th('v_' + old)}  →  {verdict_badge(v)}",
        f"<i>{html.escape(th('vh_' + v['verdict']))}</i>", "",
        f"💵 {th('price')}: <b>{money(price)} $</b>", "", *factor_lines(v["top"]), "",
        f"<i>{th('disclaimer')}</i>"])


def summary_block(asset: dict, res: dict, v: dict) -> list[str]:
    chg = res["chg24"]
    return [f"{V_EMOJI[v['verdict']]} <b>{name(asset)}</b> — {th('v_' + v['verdict'])} · {v['score']}",
            f"    {money(res['price'])} $  ·  {'🔺' if chg >= 0 else '🔻'}{chg:+.1f}% / {th('day')}  ·  RSI {res['df']['rsi'].iloc[-1]:.0f}",
            f"    {trends_line(res['trends'])}"]


def fng_emoji(v: int) -> str:
    return "😱" if v < 25 else "😟" if v < 45 else "😐" if v < 55 else "🙂" if v < 75 else "🤑"


def summary_message(blocks: list[list[str]], fng: dict | None, paper_stats: dict | None, now: pd.Timestamp,
                    news: list[dict] | None = None, stocks: list[dict] | None = None) -> str:
    L = [f"📡 <b>TrendRadar · {th('summary_title')}</b>", f"<i>{now:%d.%m.%Y}</i>", ""]
    for b in blocks:
        L += b + [""]
    if fng:
        L.append(f"{fng_emoji(fng['value'])} {th('fng')}: <b>{fng['value']}</b>/100 — {th('fng_' + fng['class'])}")
    if paper_stats:
        L.append("💼 " + th("paper_line", bal=money(paper_stats["balance"]), pct=paper_stats["pct"], n=paper_stats["open"]))
    if stocks:
        L += ["", f"📈 <b>{th('stocks_head')}</b>",
              " · ".join(f"{html.escape(x['symbol'])} {x['score']}" for x in stocks)]
    if news:
        L += ["", f"📰 <b>{th('news_head')}</b>"]
        for n in news:
            link = n.get("link", "")
            title = html.escape(n.get("title", ""), quote=False)
            if link.startswith(("http://", "https://")):
                title = f'<a href="{html.escape(link, quote=True)}">{title}</a>'
            L.append(f"• {title} · <i>{html.escape(n.get('source', ''), quote=False)}</i>")
    L += ["", f"<i>{th('summary_note')}</i>"]
    return "\n".join(L)


def paper_close_message(asset: dict, c: dict, balance: float) -> str:
    key = "paper_close_target" if c["reason"] == "target" else "paper_close_stop"
    return "\n".join([t(key, name=name(asset)),
                      t("paper_result", entry=money(c["entry"]), exit=money(c["exit"]), pct=c["pct"], pnl=c["pnl"]),
                      th("paper_balance", bal=money(balance))])


def weekly_message(week: dict, total: dict) -> str:
    L = [f"<b>{th('weekly_title')}</b>", ""]
    if total["n"] == 0:
        L.append(th("weekly_none"))
    else:
        L += [th("weekly_week", n=week["n"], wr=week["wr"], pnl=week["pnl"]),
              th("weekly_total", n=total["n"], wr=total["wr"], bal=money(total["balance"]), pct=total["pct"])]
    L += ["", f"<i>{th('weekly_note')}</i>"]
    return "\n".join(L)


def errors_message(errors: list[str]) -> str:
    return th("err_title") + "\n" + "\n".join("• " + html.escape(e) for e in errors)
