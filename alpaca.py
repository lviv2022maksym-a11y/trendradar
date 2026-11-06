"""Мінімальний клієнт Alpaca (торгівля + ринкові дані) для торгового робота.

Документація: https://docs.alpaca.markets — Trading API v2, Market Data (крипта v1beta3, акції v2).
Тестовий рахунок (paper) і справжній мають однаковий API — відрізняється лише адреса і ключі.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import pandas as pd
import requests

PAPER = "https://paper-api.alpaca.markets"
LIVE = "https://api.alpaca.markets"
DATA = "https://data.alpaca.markets"
TF_ALPACA = {"1h": "1Hour", "1d": "1Day"}


class AlpacaError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"Alpaca {status}: {message}")
        self.status = status
        self.message = message


def is_crypto(symbol: str) -> bool:
    return "/" in symbol


def pos_symbol(symbol: str) -> str:
    """У позиціях Alpaca крипта записується без «/»: BTC/USD → BTCUSD."""
    return symbol.replace("/", "")


class AlpacaClient:
    def __init__(self, key_id: str, secret: str, paper: bool = True, timeout: int = 20):
        self.base = PAPER if paper else LIVE
        self.paper = paper
        self.timeout = timeout
        self.s = requests.Session()
        self.s.headers.update({"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret, "Accept": "application/json"})

    # ---------- службове ----------
    def _req(self, method: str, url: str, **kw):
        for attempt in range(4):
            try:
                r = self.s.request(method, url, timeout=self.timeout, **kw)
            except requests.RequestException as e:
                if attempt == 3:
                    raise AlpacaError(0, f"мережа: {e}") from e
                time.sleep(1.5 * (attempt + 1))
                continue
            if r.status_code == 429 or r.status_code >= 500:   # ліміт запитів або збій на їхньому боці — пробуємо ще
                if attempt < 3:
                    time.sleep(2 * (attempt + 1))
                    continue
            if r.status_code >= 400:
                try:
                    msg = r.json().get("message", r.text)
                except ValueError:
                    msg = r.text
                raise AlpacaError(r.status_code, str(msg)[:300])
            if r.status_code == 204 or not r.content:
                return None
            return r.json()
        raise AlpacaError(0, "не вдалося виконати запит")

    def _t(self, method: str, path: str, **kw):
        return self._req(method, self.base + path, **kw)

    def _d(self, path: str, params: dict):
        return self._req("GET", DATA + path, params=params)

    # ---------- рахунок ----------
    def account(self) -> dict:
        return self._t("GET", "/v2/account")

    def clock(self) -> dict:
        return self._t("GET", "/v2/clock")

    def asset(self, symbol: str) -> dict:
        return self._t("GET", "/v2/assets/" + quote(symbol, safe=""))

    def positions(self) -> list[dict]:
        return self._t("GET", "/v2/positions") or []

    def position(self, symbol: str) -> dict | None:
        try:
            return self._t("GET", "/v2/positions/" + quote(pos_symbol(symbol), safe=""))
        except AlpacaError as e:
            if e.status == 404:
                return None
            raise

    def open_orders(self) -> list[dict]:
        return self._t("GET", "/v2/orders", params={"status": "open", "limit": 500}) or []

    def order(self, order_id: str) -> dict:
        return self._t("GET", "/v2/orders/" + order_id)

    # ---------- ордери ----------
    def submit_order(self, symbol: str, side: str, *, notional: float | None = None, qty: str | float | None = None,
                     type: str = "market", time_in_force: str | None = None, stop_price: float | None = None,
                     limit_price: float | None = None, client_order_id: str | None = None) -> dict:
        tif = time_in_force or ("gtc" if is_crypto(symbol) else "day")
        body = {"symbol": symbol, "side": side, "type": type, "time_in_force": tif}
        if notional is not None:
            body["notional"] = f"{notional:.2f}"
        if qty is not None:
            body["qty"] = str(qty)
        if stop_price is not None:
            body["stop_price"] = fmt_num(stop_price)
        if limit_price is not None:
            body["limit_price"] = fmt_num(limit_price)
        if client_order_id:
            body["client_order_id"] = client_order_id
        return self._t("POST", "/v2/orders", json=body)

    def cancel_order(self, order_id: str) -> None:
        try:
            self._t("DELETE", "/v2/orders/" + order_id)
        except AlpacaError as e:
            if e.status not in (404, 422):   # уже виконаний або скасований — це нормально
                raise

    def close_position(self, symbol: str) -> dict | None:
        try:
            return self._t("DELETE", "/v2/positions/" + quote(pos_symbol(symbol), safe=""))
        except AlpacaError as e:
            if e.status == 404:
                return None
            raise

    def close_all(self) -> None:
        self._t("DELETE", "/v2/positions", params={"cancel_orders": "true"})

    def wait_filled(self, order_id: str, timeout: float = 30.0) -> dict:
        end = time.time() + timeout
        o = self.order(order_id)
        while o.get("status") not in ("filled", "canceled", "expired", "rejected") and time.time() < end:
            time.sleep(1)
            o = self.order(order_id)
        return o

    # ---------- ринкові дані ----------
    def bars(self, symbol: str, tf: str, days: int) -> pd.DataFrame:
        """Свічки OHLCV (індекс — час відкриття UTC). Крипта — v1beta3, акції — v2 (безкоштовна стрічка IEX)."""
        start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        params = {"symbols": symbol, "timeframe": TF_ALPACA[tf], "start": start, "limit": 10000}
        if is_crypto(symbol):
            path = "/v1beta3/crypto/us/bars"
        else:
            path = "/v2/stocks/bars"
            params.update({"feed": "iex", "adjustment": "all"})
        rows, token = [], None
        for _ in range(20):
            if token:
                params["page_token"] = token
            j = self._d(path, params) or {}
            rows += (j.get("bars") or {}).get(symbol, [])
            token = j.get("next_page_token")
            if not token:
                break
        if not rows:
            raise AlpacaError(404, f"немає свічок для {symbol}")
        df = pd.DataFrame(rows)
        df.index = pd.DatetimeIndex(pd.to_datetime(df["t"], utc=True)).as_unit("ns")
        df = df.rename(columns={"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"})
        return df[["open", "high", "low", "close", "volume"]].astype(float).sort_index()

    def latest_prices(self, symbols: list[str]) -> dict[str, float]:
        out: dict[str, float] = {}
        crypto = [s for s in symbols if is_crypto(s)]
        stocks = [s for s in symbols if not is_crypto(s)]
        if crypto:
            j = self._d("/v1beta3/crypto/us/latest/trades", {"symbols": ",".join(crypto)}) or {}
            out.update({s: float(v["p"]) for s, v in (j.get("trades") or {}).items()})
        if stocks:
            j = self._d("/v2/stocks/trades/latest", {"symbols": ",".join(stocks), "feed": "iex"}) or {}
            out.update({s: float(v["p"]) for s, v in (j.get("trades") or {}).items()})
        return out


def fmt_num(x: float) -> str:
    """Число без зайвих нулів (ціни округлює робот під крок ціни активу)."""
    return f"{x:.9f}".rstrip("0").rstrip(".")


def round_price(p: float, symbol: str, increment: float | None = None) -> float:
    """Округлення ціни під правила: акції ≥ $1 — до центів, < $1 — 4 знаки; крипта — за кроком ціни активу."""
    if increment and increment > 0:
        return round(round(p / increment) * increment, 9)
    if not is_crypto(symbol):
        return round(p, 2 if p >= 1 else 4)
    return round(p, 2 if p >= 100 else 4 if p >= 1 else 8)
