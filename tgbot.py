"""Telegram для торгового робота: повідомлення з кнопками, редагування, отримання команд (long polling)."""
from __future__ import annotations

import json
import time

import requests


class Bot:
    def __init__(self, token: str | None, chat_id: str | None):
        self.token, self.chat_id = token, str(chat_id) if chat_id else None
        self.url = f"https://api.telegram.org/bot{token}/" if token else None

    def call(self, method: str, timeout: int = 30, **params):
        if not self.url:
            print(f"[telegram:{method}] {json.dumps(params, ensure_ascii=False)[:400]}")
            return None
        for attempt in range(3):
            try:
                r = requests.post(self.url + method, json=params, timeout=timeout + 10)
            except requests.RequestException:
                time.sleep(2 * (attempt + 1))
                continue
            if r.status_code == 429:
                time.sleep(int(r.json().get("parameters", {}).get("retry_after", 3)) + 1)
                continue
            j = r.json() if r.content else {}
            if not j.get("ok"):
                print(f"Telegram {method}: {r.status_code} {str(j)[:300]}")
                return None
            return j.get("result")
        return None

    @staticmethod
    def kb(rows):
        """rows: [[(текст, callback_data), ...], ...] → inline-клавіатура."""
        return {"inline_keyboard": [[{"text": t, "callback_data": d} for t, d in row] for row in rows]}

    def send(self, text: str, buttons=None) -> int | None:
        p = {"chat_id": self.chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
        if buttons:
            p["reply_markup"] = self.kb(buttons)
        res = self.call("sendMessage", **p)
        return res.get("message_id") if isinstance(res, dict) else None

    def edit(self, message_id: int | None, text: str, buttons=None) -> None:
        if not message_id:
            self.send(text, buttons)
            return
        p = {"chat_id": self.chat_id, "message_id": message_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
        p["reply_markup"] = self.kb(buttons) if buttons else {"inline_keyboard": []}
        self.call("editMessageText", **p)

    def answer(self, callback_id: str, text: str | None = None) -> None:
        self.call("answerCallbackQuery", callback_query_id=callback_id, **({"text": text} if text else {}))

    def updates(self, offset: int, timeout: int = 50) -> list:
        res = self.call("getUpdates", timeout=timeout, offset=offset, allowed_updates=["message", "callback_query"])
        return res or []

    def set_commands(self, commands: list[tuple[str, str]]) -> None:
        self.call("setMyCommands", commands=[{"command": c, "description": d} for c, d in commands])
