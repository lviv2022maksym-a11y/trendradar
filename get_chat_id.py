"""Показує ваш TELEGRAM_CHAT_ID. Спершу напишіть своєму боту будь-яке повідомлення.

Запуск:  TELEGRAM_TOKEN=123:ABC python get_chat_id.py
"""
import os
import requests

token = os.getenv("TELEGRAM_TOKEN") or input("Вставте токен бота: ").strip()
r = requests.get(f"https://api.telegram.org/bot{token}/getUpdates", timeout=30).json()
chats = {u["message"]["chat"]["id"]: u["message"]["chat"].get("first_name", "") for u in r.get("result", []) if "message" in u}
if not chats:
    print("Порожньо. Напишіть боту в Telegram будь-що (наприклад «привіт») і запустіть ще раз.")
for cid, name in chats.items():
    print(f"TELEGRAM_CHAT_ID = {cid}  ({name})")
