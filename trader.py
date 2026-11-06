"""TrendRadar Trader — торговий робот для вашого сервера: Alpaca (крипта й акції США) + керування з Telegram.

Гроші лежать на вашому рахунку Alpaca; робот лише надсилає ордери через API-ключ.
Режими:  confirm — пропонує угоду кнопками в Telegram (за замовчуванням)
         auto    — купує сам за сигналами
         off     — нових угод не відкриває (захист і /buy вручну працюють)
Захист:  стоп-лос стоїть на біржі одразу після покупки; ціль робот продає сам;
         денний ліміт збитку, ліміт угод на день, максимум відкритих угод, /panic.
Справжні гроші: лише якщо в config.json "paper": false І на сервері TRADER_LIVE=1. Інакше — тестовий рахунок.

  python trader.py            запуск (так працює служба на сервері)
  python trader.py --once     одна перевірка й вихід (для налагодження)
"""
from __future__ import annotations

import argparse
import html
import json
import os
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

import settings
from alpaca import AlpacaClient, AlpacaError, is_crypto, pos_symbol, round_price
from data import closed_only, resample
from i18n import set_language, t
from indicators import add_indicators
from market import attach_htf_trend
from strategy import BUY_TYPES, signals_at, trade_plan
from verdict import assess

DEFAULTS = {
    "mode": "confirm", "paper": True,
    "crypto": ["BTC/USD", "ETH/USD", "SOL/USD"],
    "stocks": ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
    "risk_per_trade_pct": 1.0, "max_position_pct": 20, "max_open_positions": 3,
    "daily_loss_limit_pct": 3.0, "max_trades_per_day": 4, "confirm_timeout_min": 60,
    "min_order_usd": 10, "check_every_sec": 30, "stop_limit_slippage_pct": 1.0,
}
FRESH_SEC = {"4h": 90 * 60, "1d": 20 * 3600}   # сигнал на свічці, що закрилась давніше, вже неактуальний


def money(x: float) -> str:
    a = abs(x)
    s = f"{x:,.2f}" if a >= 1 else f"{x:,.6f}".rstrip("0").rstrip(".")
    return s.replace(",", " ")


def pct(x: float) -> str:
    return f"{x:+.2f}%"


def qty_str(q: float) -> str:
    return f"{q:.8f}".rstrip("0").rstrip(".")


class Trader:
    def __init__(self, cfg: dict, tcfg: dict, api, tg, state_path: Path, now=time.time, live: bool = False):
        self.cfg, self.tc, self.api, self.tg, self.path, self.now, self.live = cfg, tcfg, api, tg, Path(state_path), now, live
        self.lock = threading.RLock()
        self.st = self._load()
        self.st.setdefault("mode", tcfg["mode"])
        for k, v in (("paused", False), ("trades", {}), ("pending", {}), ("queued", {}), ("last_bar", {}), ("history", []),
                     ("daily", {}), ("tg_offset", 0)):
            self.st.setdefault(k, v)
        self.cache: dict[str, dict] = {}
        self.assets: dict[str, dict] = {}
        self.last_err = 0.0

    # ---------- стан ----------
    def _load(self) -> dict:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.st, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    def name(self, sym: str) -> str:
        return html.escape(sym.replace("/USD", ""))

    def mode_label(self) -> str:
        return t("tr_mode_" + self.st["mode"])

    def acct_label(self) -> str:
        return t("tr_live") if self.live else t("tr_paper")

    # ---------- аналіз ----------
    def analyze(self, sym: str) -> dict | None:
        """Сигнали й оцінка на останній закритій свічці (крипта — 4г зі старшим 1д, акції — 1д зі старшим 1т)."""
        now = pd.Timestamp(self.now(), unit="s", tz="UTC")
        if is_crypto(sym):
            h1 = closed_only(self.api.bars(sym, "1h", 400), "1h", now)
            main = add_indicators(closed_only(resample(h1, "4h"), "4h", now))
            daily = add_indicators(closed_only(resample(h1, "1d"), "1d", now))
            df, tf = attach_htf_trend(main, daily, "4h", "1d"), "4h"
            trends = {"1h": add_indicators(h1)["trend"].iloc[-1]} if len(h1) > 30 else {}
        else:
            d1 = self.api.bars(sym, "1d", 1900)
            d1.index = d1.index.floor("D")
            d1 = add_indicators(closed_only(d1[~d1.index.duplicated(keep="last")], "1d", now))
            weekly = add_indicators(resample(d1[["open", "high", "low", "close", "volume"]], "1w"))
            df, tf, trends = attach_htf_trend(d1, weekly, "1d", "1w"), "1d", {}
        if len(df) < 220:
            return None
        i = len(df) - 1
        scfg = {**self.cfg, "timeframe": tf, "risk_per_trade_pct": self.tc["risk_per_trade_pct"], "max_position_pct": self.tc["max_position_pct"]}
        sigs = signals_at(df, i, {"symbol": sym, "sharp_move_pct": 3.0}, scfg)
        buy = next((s for s in sigs if s["type"] in BUY_TYPES), None)
        v = assess(df.iloc[i], df.iloc[i - 1], tf, trends, None, buy is not None, is_crypto(sym))
        bar_end = df.index[i] + (pd.Timedelta(hours=4) if tf == "4h" else pd.Timedelta(days=1))
        res = {"sym": sym, "tf": tf, "bar": df.index[i].isoformat(), "bar_end": bar_end.timestamp(), "buy": buy, "verdict": v,
               "atr": float(df["atr"].iloc[i]), "close": float(df["close"].iloc[i])}
        self.cache[sym] = res
        return res

    # ---------- допоміжне ----------
    def asset(self, sym: str) -> dict:
        if sym not in self.assets:
            try:
                self.assets[sym] = self.api.asset(sym) or {}
            except AlpacaError:
                self.assets[sym] = {}
        return self.assets[sym]

    def rp(self, p: float, sym: str) -> float:
        inc = self.asset(sym).get("price_increment")
        return round_price(p, sym, float(inc) if inc else None)

    def account(self) -> dict:
        a = self.api.account()
        return {"equity": float(a.get("equity", 0)), "cash": float(a.get("cash", 0)), "bp": float(a.get("non_marginable_buying_power") or a.get("buying_power") or a.get("cash", 0)),
                "last_equity": float(a.get("last_equity") or a.get("equity", 0))}

    def market_open(self) -> tuple[bool, str]:
        try:
            c = self.api.clock()
            return bool(c.get("is_open")), str(c.get("next_open", ""))[:16].replace("T", " ")
        except AlpacaError:
            return False, ""

    def resolve(self, raw: str) -> str | None:
        s = raw.strip().upper().replace("-", "/")
        if "/" in s:
            return s if s.endswith("/USD") else None
        cryptos = {c.split("/")[0]: c for c in self.tc["crypto"]}
        if s in cryptos:
            return cryptos[s]
        if s in ("BTC", "ETH", "SOL", "DOGE", "XRP", "AVAX", "LINK", "LTC", "BCH", "SHIB", "PEPE", "UNI", "AAVE", "DOT", "BONK", "WIF", "TRUMP"):
            return s + "/USD"
        return s if s.replace(".", "").isalpha() and 1 <= len(s) <= 6 else None

    def allowed(self, sym: str, manual: bool = False) -> tuple[bool, str]:
        if not manual and self.st["mode"] == "off":
            return False, t("tr_why_off")
        if not manual and (self.st["paused"] or self.st["daily"].get("halted") == self.today()):
            return False, t("tr_why_paused")
        if sym in self.st["trades"]:
            return False, t("tr_why_has_pos")
        if len(self.st["trades"]) >= self.tc["max_open_positions"]:
            return False, t("tr_why_max_pos", n=self.tc["max_open_positions"])
        if self.st["daily"].get("trades", 0) >= self.tc["max_trades_per_day"] and not manual:
            return False, t("tr_why_trades_day", n=self.tc["max_trades_per_day"])
        return True, ""

    def today(self) -> str:
        return datetime.fromtimestamp(self.now(), timezone.utc).strftime("%Y-%m-%d")

    def size_for(self, plan: dict, acct: dict) -> float:
        cap = acct["equity"] * self.tc["max_position_pct"] / 100
        risk_size = acct["equity"] * self.tc["risk_per_trade_pct"] / 100 / max(plan["entry"] - plan["stop"], 1e-12) * plan["entry"]
        return max(0.0, min(risk_size, cap, acct["bp"] * 0.98))

    def plan(self, sym: str, price: float, acct: dict) -> dict:
        an = self.cache.get(sym) or self.analyze(sym)
        if not an:
            raise AlpacaError(0, f"немає даних для {sym}")
        p = trade_plan(price, an["atr"], {**self.cfg, "risk_per_trade_pct": self.tc["risk_per_trade_pct"], "max_position_pct": self.tc["max_position_pct"]}, deposit=acct["equity"])
        p["size_usd"] = self.size_for(p, acct)
        p["atr"] = an["atr"]
        return p

    # ---------- угоди ----------
    def buy(self, sym: str, size_usd: float, source: str) -> None:
        with self.lock:
            ok, why = self.allowed(sym, manual=(source == "manual"))
            if not ok:
                self.tg.send(t("tr_refused", why=why))
                return
            if size_usd < self.tc["min_order_usd"]:
                self.tg.send(t("tr_refused", why=t("tr_why_small", m=self.tc["min_order_usd"])))
                return
            if not is_crypto(sym):
                is_open, nxt = self.market_open()
                if not is_open:
                    qid = uuid.uuid4().hex[:8]
                    self.st["queued"][qid] = {"sym": sym, "size": size_usd, "source": source}
                    self.save()
                    self.tg.send(t("tr_queued", name=self.name(sym), size=money(size_usd), when=nxt))
                    return
            acct = self.account()
            if size_usd > acct["bp"]:
                self.tg.send(t("tr_refused", why=t("tr_why_funds")))
                return
            o = self.api.submit_order(sym, "buy", notional=round(size_usd, 2), client_order_id=f"tr-b-{uuid.uuid4().hex[:10]}")
            o = self.api.wait_filled(o["id"])
            if o.get("status") != "filled":
                self.tg.send(t("tr_error", e=f"{sym}: {o.get('status')}"))
                return
            fill = float(o["filled_avg_price"])
            pos = self.api.position(sym) or {}
            qty = float(pos.get("qty_available") or pos.get("qty") or o.get("filled_qty") or 0)
            an = self.cache.get(sym) or self.analyze(sym) or {"atr": fill * 0.02}
            stop = self.rp(fill - self.cfg["atr_stop_mult"] * an["atr"], sym)
            target = self.rp(fill + self.cfg["atr_target_mult"] * an["atr"], sym)
            tr = {"sym": sym, "qty": qty, "entry": fill, "stop": stop, "target": target, "size": size_usd, "stop_id": None,
                  "opened": self.now(), "source": source}
            self.st["trades"][sym] = tr
            d = self.st["daily"]
            d["trades"] = d.get("trades", 0) + 1 if d.get("date") == self.today() else 1
            d["date"] = self.today()
            self.protect(sym)
            self.save()
            self.tg.send(t("tr_bought", name=self.name(sym), qty=qty_str(qty), px=money(fill), notional=money(fill * qty), stop=money(stop), target=money(target)))

    def protect(self, sym: str) -> None:
        """Стоп-лос на біржі: крипта — stop_limit (gtc); акції — stop (gtc для цілих акцій, day для дробових у години торгів)."""
        tr = self.st["trades"].get(sym)
        if not tr or tr.get("stop_id"):
            return
        qty = qty_str(tr["qty"])
        try:
            if is_crypto(sym):
                lim = self.rp(tr["stop"] * (1 - self.tc["stop_limit_slippage_pct"] / 100), sym)
                o = self.api.submit_order(sym, "sell", qty=qty, type="stop_limit", stop_price=tr["stop"], limit_price=lim,
                                          time_in_force="gtc", client_order_id=f"tr-s-{uuid.uuid4().hex[:10]}")
            else:
                whole = float(tr["qty"]).is_integer()
                if not whole and not self.market_open()[0]:
                    return                       # дробові акції: стоп ставимо в години торгів
                o = self.api.submit_order(sym, "sell", qty=qty, type="stop", stop_price=tr["stop"], time_in_force="gtc" if whole else "day",
                                          client_order_id=f"tr-s-{uuid.uuid4().hex[:10]}")
            tr["stop_id"] = o["id"]
        except AlpacaError as e:
            self.tg.send(t("tr_error", e=f"{sym} stop: {e.message}"))

    def sell(self, sym: str, reason: str, price_hint: float | None = None) -> None:
        with self.lock:
            tr = self.st["trades"].get(sym)
            if tr and tr.get("stop_id"):
                self.api.cancel_order(tr["stop_id"])
            o = self.api.close_position(sym)
            if o is None and not tr:
                self.tg.send(t("tr_no_pos", name=self.name(sym)))
                return
            exit_px = price_hint or 0.0
            if o and o.get("id"):
                o = self.api.wait_filled(o["id"])
                if o.get("filled_avg_price"):
                    exit_px = float(o["filled_avg_price"])
            if tr:
                self.close_trade(sym, exit_px or tr["entry"], reason)
            self.save()

    def close_trade(self, sym: str, exit_px: float, reason: str) -> None:
        tr = self.st["trades"].pop(sym, None)
        if not tr:
            return
        pnl = (exit_px - tr["entry"]) * tr["qty"]
        p = (exit_px / tr["entry"] - 1) * 100 if tr["entry"] else 0.0
        self.st["history"] = (self.st["history"] + [{**tr, "exit": exit_px, "pnl": pnl, "pct": p, "reason": reason, "closed": self.now()}])[-300:]
        key = {"target": "tr_target_hit", "stop": "tr_stop_hit", "manual": "tr_sold", "outside": "tr_closed_manual"}[reason]
        self.tg.send(t(key, name=self.name(sym), px=money(exit_px), pnl=money(pnl), pct=pct(p)))

    # ---------- цикл ----------
    def reconcile(self) -> None:
        """Звіряємо позиції з біржею: спрацював стоп, позицію закрили вручну, стоп-ордер зник — відновлюємо."""
        if not self.st["trades"]:
            return
        positions = {p["symbol"]: p for p in self.api.positions()}
        open_ids = {o["id"] for o in self.api.open_orders()}
        for sym, tr in list(self.st["trades"].items()):
            if pos_symbol(sym) not in positions:
                exit_px, reason = tr["stop"], "outside"
                if tr.get("stop_id"):
                    try:
                        o = self.api.order(tr["stop_id"])
                        if o.get("status") == "filled":
                            exit_px, reason = float(o.get("filled_avg_price") or tr["stop"]), "stop"
                    except AlpacaError:
                        pass
                self.close_trade(sym, exit_px, reason)
                continue
            tr["qty"] = float(positions[pos_symbol(sym)].get("qty_available") or positions[pos_symbol(sym)].get("qty") or tr["qty"])
            if tr.get("stop_id") and tr["stop_id"] not in open_ids:
                try:
                    o = self.api.order(tr["stop_id"])
                    if o.get("status") in ("filled", "partially_filled"):
                        continue          # дозаповниться — наступна звірка закриє угоду
                except AlpacaError:
                    pass
                tr["stop_id"] = None      # стоп скасовано/прострочено — поставимо знову
            if not tr.get("stop_id"):
                self.protect(sym)

    def check_targets(self) -> None:
        if not self.st["trades"]:
            return
        prices = self.api.latest_prices(list(self.st["trades"]))
        stock_open = None
        for sym, tr in list(self.st["trades"].items()):
            px = prices.get(sym)
            if px is None:
                continue
            if not is_crypto(sym):
                if stock_open is None:
                    stock_open = self.market_open()[0]
                if not stock_open:
                    continue
            if px >= tr["target"]:
                self.sell(sym, "target", px)
            elif px <= tr["stop"] and not tr.get("stop_id"):
                self.sell(sym, "stop", px)    # стоп-ордера немає (напр. дробові акції) — виходимо самі

    def check_daily(self) -> None:
        d = self.st["daily"]
        if d.get("date") != self.today():
            d.clear()
            d["date"] = self.today()
        if d.get("halted") == self.today():
            return
        a = self.account()
        base = a["last_equity"] or a["equity"]
        if base and (a["equity"] - base) / base * 100 <= -self.tc["daily_loss_limit_pct"]:
            d["halted"] = self.today()
            self.tg.send(t("tr_daily_limit", pct=f"{self.tc['daily_loss_limit_pct']:g}"))

    def check_signals(self) -> None:
        for sym in self.tc["crypto"] + self.tc["stocks"]:
            try:
                an = self.analyze(sym)
            except AlpacaError as e:
                print(f"[{sym}] {e}")
                continue
            if not an or self.st["last_bar"].get(sym) == an["bar"]:
                continue
            self.st["last_bar"][sym] = an["bar"]
            if not an["buy"] or self.now() - an["bar_end"] > FRESH_SEC[an["tf"]]:
                continue
            ok, _ = self.allowed(sym)
            if not ok:
                continue
            acct = self.account()
            p = self.plan(sym, an["close"], acct)
            if p["size_usd"] < self.tc["min_order_usd"]:
                continue
            if self.st["mode"] == "auto":
                self.buy(sym, p["size_usd"], "auto")
            elif self.st["mode"] == "confirm":
                self.propose(sym, an, p)

    def propose(self, sym: str, an: dict, p: dict) -> None:
        pid = uuid.uuid4().hex[:8]
        why = "\n".join("✓ " + html.escape(t(k, **{kk: (t("tf_" + vv) if kk in ("htf", "mtf", "ltf") else vv) for kk, vv in kw.items()}))
                        for k, kw in an["buy"]["reasons"][:4])
        text = t("tr_proposal", name=self.name(sym), why=why, entry=money(p["entry"]), stop=money(p["stop"]), sp=pct(p["stop_pct"]),
                 target=money(p["target"]), tp=pct(p["target_pct"]), size=money(p["size_usd"]), risk=money(p["risk_usd"]), mins=self.tc["confirm_timeout_min"])
        mid = self.tg.send(text, [[(t("tr_btn_buy", size=money(p["size_usd"])), f"ok:{pid}"), (t("tr_btn_skip"), f"no:{pid}")]])
        self.st["pending"][pid] = {"action": "buy", "sym": sym, "size": p["size_usd"], "msg": mid, "text": text, "created": self.now()}
        self.save()

    def expire_pending(self) -> None:
        ttl = self.tc["confirm_timeout_min"] * 60
        for pid, pd_ in list(self.st["pending"].items()):
            if self.now() - pd_["created"] > ttl:
                self.st["pending"].pop(pid)
                self.tg.edit(pd_.get("msg"), pd_.get("text", "") + "\n\n" + t("tr_expired"))

    def run_queued(self) -> None:
        if not self.st["queued"] or not self.market_open()[0]:
            return
        for qid, q in list(self.st["queued"].items()):
            self.st["queued"].pop(qid)
            self.buy(q["sym"], q["size"], q["source"])

    def tick(self) -> None:
        with self.lock:
            self.check_daily()
            self.reconcile()
            self.check_targets()
            self.expire_pending()
            self.run_queued()
            self.check_signals()
            self.save()

    # ---------- Telegram ----------
    def handle_update(self, u: dict) -> None:
        if "callback_query" in u:
            cq = u["callback_query"]
            chat = str(((cq.get("message") or {}).get("chat") or {}).get("id"))
            if chat != self.tg.chat_id:
                return
            self.tg.answer(cq["id"])
            self.on_button(cq.get("data", ""), (cq.get("message") or {}).get("message_id"))
            return
        msg = u.get("message") or {}
        if str((msg.get("chat") or {}).get("id")) != self.tg.chat_id:
            return                                   # команди приймаються лише з вашого чату
        text = (msg.get("text") or "").strip()
        if text.startswith("/"):
            self.on_command(text)

    def status_text(self) -> str:
        a = self.account()
        day = a["equity"] - a["last_equity"]
        dp = day / a["last_equity"] * 100 if a["last_equity"] else 0.0
        paused = t("tr_paused_tag") if self.st["paused"] or self.st["daily"].get("halted") == self.today() else ""
        return t("tr_status", acct=self.acct_label(), eq=money(a["equity"]), cash=money(a["cash"]), day=money(day), dpct=pct(dp),
                 n=len(self.st["trades"]), mode=self.mode_label(), paused=paused)

    def positions_text(self):
        pos = self.api.positions()
        if not pos:
            return t("tr_positions_none"), None
        lines, btns = [], []
        for p in pos:
            sym = p["symbol"]
            sym = next((s for s in self.st["trades"] if pos_symbol(s) == sym), sym if p.get("asset_class") != "crypto" else sym[:-3] + "/USD")
            tr = self.st["trades"].get(sym, {})
            lines.append(t("tr_pos_line", name=self.name(sym), qty=qty_str(float(p["qty"])), entry=money(float(p["avg_entry_price"])),
                           px=money(float(p["current_price"])), pl=money(float(p["unrealized_pl"])), plp=pct(float(p["unrealized_plpc"]) * 100),
                           stop=money(tr.get("stop", 0)) if tr else "—", target=money(tr.get("target", 0)) if tr else "—"))
            btns.append([(t("tr_btn_sell", sym=sym.replace("/USD", "")), f"sell:{sym}")])
        return "\n".join(lines), btns

    def on_command(self, text: str) -> None:
        parts = text.split()
        cmd = parts[0].split("@")[0].lower()
        try:
            if cmd in ("/start", "/help"):
                self.tg.send(t("tr_help"))
            elif cmd in ("/status", "/balance"):
                self.tg.send(self.status_text())
            elif cmd == "/positions":
                txt, btns = self.positions_text()
                self.tg.send(txt, btns)
            elif cmd == "/buy":
                if len(parts) < 3:
                    self.tg.send(t("tr_err_amount"))
                    return
                sym = self.resolve(parts[1])
                try:
                    amount = float(parts[2].replace(",", ".").replace("$", ""))
                except ValueError:
                    self.tg.send(t("tr_err_amount"))
                    return
                if not sym:
                    self.tg.send(t("tr_err_symbol", sym=html.escape(parts[1])))
                    return
                acct = self.account()
                price = self.api.latest_prices([sym]).get(sym)
                if not price:
                    self.tg.send(t("tr_err_symbol", sym=html.escape(parts[1])))
                    return
                p = self.plan(sym, price, acct)
                pid = uuid.uuid4().hex[:8]
                txt = t("tr_confirm_buy", name=self.name(sym), size=money(amount), stop=money(p["stop"]), target=money(p["target"]))
                mid = self.tg.send(txt, [[(t("tr_btn_buy", size=money(amount)), f"ok:{pid}"), (t("tr_btn_cancel"), f"no:{pid}")]])
                self.st["pending"][pid] = {"action": "buy", "sym": sym, "size": amount, "msg": mid, "text": txt, "created": self.now(), "manual": True}
            elif cmd == "/sell":
                sym = self.resolve(parts[1]) if len(parts) > 1 else None
                if not sym:
                    self.tg.send(t("tr_err_symbol", sym=html.escape(parts[1] if len(parts) > 1 else "")))
                    return
                self.ask(t("tr_confirm_sell", name=self.name(sym)), {"action": "sell", "sym": sym})
            elif cmd == "/mode":
                if len(parts) > 1 and parts[1] in ("auto", "confirm", "off"):
                    self.st["mode"] = parts[1]
                    self.tg.send(t("tr_mode_set", mode=self.mode_label()))
                else:
                    self.tg.send(t("tr_mode_pick"), [[(t("tr_mode_confirm"), "mode:confirm")], [(t("tr_mode_auto"), "mode:auto")], [(t("tr_mode_off"), "mode:off")]])
            elif cmd == "/pause":
                self.st["paused"] = True
                self.tg.send(t("tr_paused"))
            elif cmd == "/resume":
                self.st["paused"] = False
                self.tg.send(t("tr_resumed"))
            elif cmd == "/panic":
                self.ask(t("tr_confirm_panic"), {"action": "panic"}, yes=t("tr_btn_panic"))
            else:
                self.tg.send(t("tr_help"))
        except AlpacaError as e:
            self.tg.send(t("tr_error", e=html.escape(e.message)))
        finally:
            self.save()

    def ask(self, text: str, action: dict, yes: str | None = None) -> None:
        pid = uuid.uuid4().hex[:8]
        mid = self.tg.send(text, [[(yes or t("tr_btn_yes"), f"ok:{pid}"), (t("tr_btn_cancel"), f"no:{pid}")]])
        self.st["pending"][pid] = {**action, "msg": mid, "text": text, "created": self.now()}

    def on_button(self, data: str, msg_id) -> None:
        try:
            kind, _, arg = data.partition(":")
            if kind == "mode" and arg in ("auto", "confirm", "off"):
                self.st["mode"] = arg
                self.tg.edit(msg_id, t("tr_mode_set", mode=self.mode_label()))
            elif kind == "sell":
                self.ask(t("tr_confirm_sell", name=self.name(arg)), {"action": "sell", "sym": arg})
            elif kind in ("ok", "no"):
                pd_ = self.st["pending"].pop(arg, None)
                if not pd_:
                    self.tg.edit(msg_id, t("tr_expired"))
                    return
                if kind == "no":
                    self.tg.edit(msg_id, pd_.get("text", "") + "\n\n" + (t("tr_skipped") if pd_["action"] == "buy" and not pd_.get("manual") else t("tr_cancelled")))
                    return
                self.tg.edit(msg_id, pd_.get("text", ""))
                if pd_["action"] == "buy":
                    self.buy(pd_["sym"], pd_["size"], "manual" if pd_.get("manual") else "confirm")
                elif pd_["action"] == "sell":
                    self.sell(pd_["sym"], "manual")
                elif pd_["action"] == "panic":
                    self.api.close_all()
                    for sym in list(self.st["trades"]):
                        self.st["trades"].pop(sym)
                    self.st["paused"] = True
                    self.tg.send(t("tr_panic_done"))
        except AlpacaError as e:
            self.tg.send(t("tr_error", e=html.escape(e.message)))
        finally:
            self.save()

    def poll_telegram(self) -> None:
        while True:
            try:
                ups = self.tg.updates(self.st.get("tg_offset", 0))
                for u in ups:
                    self.st["tg_offset"] = u["update_id"] + 1
                    with self.lock:
                        self.handle_update(u)
                if ups:
                    with self.lock:
                        self.save()
            except Exception:  # noqa: BLE001 — збій Telegram не повинен зупиняти робота
                traceback.print_exc()
                time.sleep(5)

    def run(self) -> None:
        self.tg.set_commands([("status", "рахунок / account"), ("positions", "позиції / positions"), ("buy", "/buy BTC 50"),
                              ("sell", "/sell BTC"), ("mode", "режим / mode"), ("pause", "пауза / pause"), ("resume", "продовжити / resume"),
                              ("panic", "закрити все / close all"), ("help", "допомога / help")])
        self.tg.send(t("tr_start", acct=self.acct_label(), mode=self.mode_label(), crypto=", ".join(self.tc["crypto"]) or "—",
                       stocks=", ".join(self.tc["stocks"]) or "—"))
        threading.Thread(target=self.poll_telegram, daemon=True).start()
        while True:
            try:
                self.tick()
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                if time.time() - self.last_err > 1800:
                    self.last_err = time.time()
                    self.tg.send(t("tr_error", e=html.escape(str(e)[:300])))
            time.sleep(self.tc["check_every_sec"])


def decide_live(tcfg: dict, env: dict) -> bool:
    """Справжні гроші — лише коли ОБИДВА перемикачі ввімкнені: "paper": false у config.json і TRADER_LIVE=1 на сервері."""
    return (tcfg.get("paper") is False) and env.get("TRADER_LIVE") == "1"


def main() -> None:
    ap = argparse.ArgumentParser(description="TrendRadar Trader")
    ap.add_argument("--once", action="store_true", help="одна перевірка й вихід")
    args = ap.parse_args()
    cfg = settings.load()
    tcfg = {**DEFAULTS, **cfg.get("trader", {})}
    set_language(cfg["language"])
    key, secret = os.getenv("ALPACA_KEY_ID"), os.getenv("ALPACA_SECRET_KEY")
    if not key or not secret:
        raise SystemExit("Немає ALPACA_KEY_ID / ALPACA_SECRET_KEY (див. README_UA.md → «Торговий робот»).")
    live = decide_live(tcfg, dict(os.environ))
    if not tcfg["paper"] and not live:
        print("⚠️  Справжня торгівля не ввімкнена: потрібно ще TRADER_LIVE=1 на сервері. Працюю з тестовим рахунком.")
    import tgbot
    tr = Trader(cfg, tcfg, AlpacaClient(key, secret, paper=not live), tgbot.Bot(os.getenv("TELEGRAM_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")),
                Path(os.getenv("TRADER_STATE", Path(__file__).with_name("trader_state.json"))), live=live)
    if args.once:
        tr.tick()
        print(tr.status_text())
    else:
        tr.run()


if __name__ == "__main__":
    main()
