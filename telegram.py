"""Надсилання в Telegram (текст, картинки, кнопки). Без токена — друк у консоль і збереження картинок у preview/."""
from __future__ import annotations

import html
import json
import os
import re
import time
from pathlib import Path

import requests

PREVIEW = Path(__file__).with_name("preview")
_counter = 0


def _creds():
    return os.getenv("TELEGRAM_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")


def visible_len(text: str) -> int:
    return len(html.unescape(re.sub(r"<[^>]+>", "", text)))


def _call(method: str, data: dict, files: dict | None = None) -> bool:
    token, _ = _creds()
    url = f"https://api.telegram.org/bot{token}/{method}"
    for attempt in range(3):
        try:
            r = requests.post(url, data=data, files=files, timeout=30)
        except requests.RequestException as e:
            print(f"Telegram: мережа ({e}); спроба {attempt + 1}")
            time.sleep(2 * (attempt + 1))
            continue
        if r.status_code == 429:  # забагато повідомлень — чекаємо, скільки просить Telegram
            time.sleep(int(r.json().get("parameters", {}).get("retry_after", 3)) + 1)
            continue
        if not r.ok:
            print(f"Telegram {method} {r.status_code}: {r.text[:300]}")
        return r.ok
    return False


def _markup(buttons):
    return json.dumps({"inline_keyboard": buttons}) if buttons else None


def _preview(text: str, png: bytes | None = None) -> bool:
    global _counter
    from i18n import t
    print(t("tg_not_set") + "\n" + text + "\n")
    if png:
        PREVIEW.mkdir(exist_ok=True)
        _counter += 1
        path = PREVIEW / f"chart_{_counter}.png"
        path.write_bytes(png)
        print(f"[картинка збережена: {path}]\n")
    return False


def send(text: str, buttons=None) -> bool:
    token, chat = _creds()
    if not token or not chat:
        return _preview(text)
    data = {"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}
    if buttons:
        data["reply_markup"] = _markup(buttons)
    return _call("sendMessage", data)


def send_photo(png: bytes, caption: str, buttons=None) -> bool:
    token, chat = _creds()
    if not token or not chat:
        return _preview(caption, png)
    files = {"photo": ("chart.png", png, "image/png")}
    if visible_len(caption) <= 1024:   # ліміт підпису до фото в Telegram
        data = {"chat_id": chat, "caption": caption, "parse_mode": "HTML"}
        if buttons:
            data["reply_markup"] = _markup(buttons)
        return _call("sendPhoto", data, files)
    ok = _call("sendPhoto", {"chat_id": chat}, files)
    return send(caption, buttons) and ok


def bot_api(method: str, **params) -> bool:
    """Будь-який метод Bot API (для setup_bot.py)."""
    token, _ = _creds()
    if not token:
        print(f"[{method}] {params}")
        return False
    return _call(method, {k: v for k, v in params.items() if v is not None})
