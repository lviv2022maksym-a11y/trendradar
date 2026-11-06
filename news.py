"""Збирає криптоновини з RSS-стрічок відкритих видань (українською, англійською, російською)
у news.json — для вкладки «Новини» в програмі та для ранкового огляду в Telegram.

  python news.py --out site_data      → site_data/news.json

Стрічки можна змінити в config.json → "news_feeds". Якщо якесь видання недоступне — його просто пропускаємо.
Twitter/X не підключено: його API платний.
"""
from __future__ import annotations

import argparse
import html
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from xml.etree import ElementTree as ET  # expat у сучасному Python захищений від «billion laughs»

import requests

import settings

DEFAULT_FEEDS = {
    "uk": [["Incrypted", "https://incrypted.com/feed/"], ["ForkLog UA", "https://forklog.com.ua/feed/"]],
    "en": [["Cointelegraph", "https://cointelegraph.com/rss"], ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"],
           ["Decrypt", "https://decrypt.co/feed"]],
    "ru": [["ForkLog", "https://forklog.com/feed"]],
}
UA = {"User-Agent": "Mozilla/5.0 (TrendRadar news bot)"}
MAX_BYTES = 3_000_000
PER_SOURCE, TOTAL = 25, 90
ATOM = "{http://www.w3.org/2005/Atom}"
DC = "{http://purl.org/dc/elements/1.1/}"

COINS = {
    "BTC": r"bitcoin|btc|біткоїн\w*|біткойн\w*|биткоин\w*|біткоін\w*",
    "ETH": r"ethereum|ether\b|eth|ефір\w*|ефіріум\w*|эфир\w*|эфириум\w*",
    "SOL": r"solana|sol\b|солан\w*",
    "XRP": r"xrp|ripple",
    "BNB": r"bnb|binance coin",
    "DOGE": r"dogecoin|doge|доджкоїн\w*|доджкоин\w*",
    "TON": r"toncoin|\bton\b|тонкоїн\w*",
    "ADA": r"cardano|\bada\b",
    "USDT": r"tether|usdt",
}
COIN_RE = {k: re.compile(r"(?<![\w])(?:" + v + r")(?![\w])", re.I) for k, v in COINS.items()}
UP_RE = re.compile(r"surg|soar|rall(y|ies)|jump|climb|gain|record high|all-time high|\bath\b|rebound|"
                   r"зріс|зросл|злет|зріст|ріст|рекорд|вирос|відскоч|вырос|рост|взлет|взлёт|отскоч", re.I)
DOWN_RE = re.compile(r"\bfall|falls|fell|drop|plung|slump|crash|tumbl|slid|sink|declin|sell-off|selloff|"
                     r"впав|впал|упал|упад|падін|падени|падає|падает|обвал|знизи|снизи|сниже|просіл|просел|подешев", re.I)


def _text(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def _clean(s: str, limit: int = 220) -> str:
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > limit:
        s = s[:limit].rsplit(" ", 1)[0].rstrip(",.;:—-") + "…"
    return s


def _ts(s: str) -> int | None:
    if not s:
        return None
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def tag(title: str, summary: str) -> tuple[list[str], str | None]:
    text = f"{title} {summary}"
    coins = [k for k, rx in COIN_RE.items() if rx.search(text)]
    up, down = bool(UP_RE.search(title)), bool(DOWN_RE.search(title))
    return coins, ("up" if up and not down else "down" if down and not up else None)


def parse(xml: bytes, source: str, lang: str) -> list[dict]:
    root = ET.fromstring(xml)
    out = []
    entries = list(root.iter("item")) or list(root.iter(ATOM + "entry"))
    for e in entries[:PER_SOURCE]:
        if e.tag == "item":
            title, link = _text(e.find("title")), _text(e.find("link"))
            date = _text(e.find("pubDate")) or _text(e.find(DC + "date"))
            summary = _text(e.find("description"))
        else:
            title = _text(e.find(ATOM + "title"))
            ln = e.find(ATOM + "link")
            link = ln.get("href", "") if ln is not None else ""
            date = _text(e.find(ATOM + "published")) or _text(e.find(ATOM + "updated"))
            summary = _text(e.find(ATOM + "summary")) or _text(e.find(ATOM + "content"))
        title = _clean(title, 200)
        if not title or not re.match(r"^https?://", link or ""):
            continue
        summary = _clean(summary)
        if summary.lower().startswith(title.lower()[:40]):
            summary = ""
        coins, direction = tag(title, summary)
        out.append({"title": title, "link": link, "source": source, "lang": lang, "ts": _ts(date) or 0,
                    "coins": coins, "dir": direction, "summary": summary})
    return out


def fetch(source: str, url: str, lang: str) -> list[dict]:
    try:
        r = requests.get(url, headers=UA, timeout=15, stream=True)
        r.raise_for_status()
        data = r.raw.read(MAX_BYTES + 1, decode_content=True)
        if len(data) > MAX_BYTES:
            raise ValueError("завеликий файл")
        items = parse(data, source, lang)
        print(f"  {source}: {len(items)}")
        return items
    except Exception as e:  # noqa: BLE001 — недоступне видання не зупиняє інші
        print(f"  {source}: пропущено ({str(e)[:120]})")
        return []


def collect(feeds: dict) -> dict:
    jobs = [(src, url, lang) for lang, lst in feeds.items() for src, url in lst]
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda j: fetch(*j), jobs))
    seen, items = set(), []
    for it in sorted((x for r in results for x in r), key=lambda x: -x["ts"]):
        key = (it["link"].split("?")[0], it["title"].lower()[:80])
        if key in seen:
            continue
        seen.add(key)
        items.append(it)
    return {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "items": items[:TOTAL]}


def headlines(news: dict | None, lang: str, n: int = 3, max_age_h: int = 24) -> list[dict]:
    """Свіжі заголовки потрібною мовою (для ранкового огляду)."""
    if not news:
        return []
    now = datetime.now(timezone.utc).timestamp()
    fresh = [x for x in news.get("items", []) if x.get("lang") == lang and now - x.get("ts", 0) <= max_age_h * 3600]
    return fresh[:n]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site_data")
    args = ap.parse_args()
    cfg = settings.load()
    feeds = cfg.get("news_feeds") or DEFAULT_FEEDS
    print("Новини:")
    news = collect(feeds)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "news.json").write_text(json.dumps(news, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Збережено {len(news['items'])} новин → {out / 'news.json'}")


if __name__ == "__main__":
    main()
