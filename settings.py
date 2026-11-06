"""Налаштування з config.json + значення за замовчуванням (старі конфіги теж працюють)."""
import json
from pathlib import Path

DEFAULTS = {
    "language": "uk",
    "deposit_usd": 1000,
    "risk_per_trade_pct": 1.0,
    "max_position_pct": 100,
    "timeframe": "4h",
    "daily_trend_filter": True,
    "fees_pct": 0.1,
    "atr_stop_mult": 2.0,
    "atr_target_mult": 3.0,
    "send_charts": True,
    "paper_trading": True,
    "verdict_alerts": True,
    "daily_summary_hour_utc": 6,
    "weekly_report_weekday": 0,
    "assets": [],
}


def load(path: str | Path | None = None) -> dict:
    p = Path(path) if path else Path(__file__).with_name("config.json")
    cfg = {**DEFAULTS, **json.loads(p.read_text(encoding="utf-8"))}
    cfg["assets"] = [a for a in cfg["assets"] if a.get("enabled", True)]
    if cfg["timeframe"] not in ("1h", "4h", "1d"):
        raise ValueError("timeframe має бути '1h', '4h' або '1d'")
    return cfg
