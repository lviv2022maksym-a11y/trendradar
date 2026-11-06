"""Пам'ять бота між запусками, щоб не надсилати один сигнал двічі."""
import json
from pathlib import Path

PATH = Path(__file__).with_name("state.json")


def load() -> dict:
    try:
        return json.loads(PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save(state: dict) -> None:
    PATH.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
