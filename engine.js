/* TrendRadar engine: індикатори, сигнали, оцінка ВИГІДНО/ЧЕКАТИ/НЕВИГІДНО, перевірка на історії.
   Логіка повторює Python-бота (strategy.py, verdict.py, indicators.py), тому результати збігаються. */
(function (root) {
  "use strict";

  const TF_MS = { "1m": 6e4, "5m": 3e5, "15m": 9e5, "1h": 36e5, "4h": 1.44e7, "1d": 8.64e7, "1w": 6.048e8, "1M": 2.592e9 };
  const HTF = { "15m": "4h", "1h": "1d", "4h": "1d", "1d": "1w", "1w": "1M" };   // старший графік
  const LTF = { "15m": "5m", "1h": "15m", "4h": "1h", "1d": "4h", "1w": "1d" };  // молодший графік
  const MIN_BARS = 210;
  const MAX_SCORE = 5;
  const BUY_AT = 70, AVOID_AT = 40;
  const BUY_TYPES = new Set(["BUY_PULLBACK", "BUY_BREAKOUT"]);

  function ema(a, n) {
    const k = 2 / (n + 1), out = new Array(a.length);
    let prev = a[0];
    out[0] = prev;
    for (let i = 1; i < a.length; i++) { prev = a[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }

  function wilder(a, n, start) {
    const al = 1 / n, out = new Array(a.length).fill(NaN);
    let prev = null;
    for (let i = start; i < a.length; i++) { prev = prev === null ? a[i] : al * a[i] + (1 - al) * prev; out[i] = prev; }
    return out;
  }

  /** bars: [{t,o,h,l,c,v}] → об'єкт масивів з індикаторами */
  function indicators(bars) {
    const n = bars.length;
    const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), o = bars.map(b => b.o), v = bars.map(b => b.v);
    const ema20 = ema(c, 20), ema50 = ema(c, 50), ema200 = ema(c, 200);
    const gain = new Array(n).fill(0), loss = new Array(n).fill(0);
    for (let i = 1; i < n; i++) { const d = c[i] - c[i - 1]; gain[i] = Math.max(d, 0); loss[i] = Math.max(-d, 0); }
    const g = wilder(gain, 14, 1), ls = wilder(loss, 14, 1);
    const rsi = new Array(n).fill(100);
    for (let i = 1; i < n; i++) rsi[i] = ls[i] === 0 ? 100 : 100 - 100 / (1 + g[i] / ls[i]);
    const tr = new Array(n);
    for (let i = 0; i < n; i++) {
      tr[i] = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    }
    const atr = wilder(tr, 14, 0);
    const e12 = ema(c, 12), e26 = ema(c, 26);
    const macd = c.map((_, i) => e12[i] - e26[i]);
    const sig = ema(macd, 9);
    const macdHist = macd.map((m, i) => m - sig[i]);
    const volRatio = new Array(n).fill(1), high20prev = new Array(n).fill(NaN), chg = new Array(n).fill(NaN);
    let vsum = 0;
    for (let i = 0; i < n; i++) {
      vsum += v[i];
      if (i >= 20) vsum -= v[i - 20];
      if (i >= 19) { const avg = vsum / 20; volRatio[i] = avg > 0 ? v[i] / avg : 1; }
      if (i >= 20) { let m = -Infinity; for (let j = i - 20; j < i; j++) m = Math.max(m, h[j]); high20prev[i] = m; }
      if (i >= 1) chg[i] = (c[i] / c[i - 1] - 1) * 100;
    }
    const dist = c.map((x, i) => atr[i] > 0 ? (x - ema50[i]) / atr[i] : NaN);
    const trend = c.map((x, i) => (x > ema200[i] && ema50[i] > ema200[i]) ? "up" : (x < ema200[i] && ema50[i] < ema200[i]) ? "down" : "flat");
    return { n, t: bars.map(b => b.t), o, h, l, c, v, ema20, ema50, ema200, rsi, atr, macdHist, volRatio, high20prev, chg, dist, trend };
  }

  /** Тренд старшого графіка станом на закриття кожної свічки основного (без підглядання в майбутнє). */
  function alignTrend(mainT, mainTf, htfT, htfTrend, htfTf) {
    const out = new Array(mainT.length).fill("flat");
    const htfClose = htfT.map((t, i) => (i + 1 < htfT.length ? htfT[i + 1] : t + TF_MS[htfTf]));
    let j = -1;
    for (let i = 0; i < mainT.length; i++) {
      const close = mainT[i] + TF_MS[mainTf];
      while (j + 1 < htfT.length && htfClose[j + 1] <= close) j++;
      if (j >= 0) out[i] = htfTrend[j];
    }
    return out;
  }

  function tradePlan(entry, atr, o) {
    const stop = entry - o.atrStop * atr, target = entry + o.atrTarget * atr;
    const riskUsd = o.deposit * o.risk / 100;
    const perUnit = Math.max(entry - stop, 1e-12);
    const size = riskUsd / perUnit * entry, cap = o.deposit * (o.maxPos ?? 100) / 100;
    return {
      entry, stop, target, stopPct: (stop / entry - 1) * 100, targetPct: (target / entry - 1) * 100,
      riskUsd, sizeUsd: Math.min(size, cap), capped: size > cap, rr: (target - entry) / perUnit,
    };
  }

  const DEFAULT_OPTS = { dailyFilter: true, sharpPct: 3, atrStop: 2, atrTarget: 3, deposit: 1000, risk: 1, maxPos: 100, fees: 0.1 };

  /** Сигнали на закритій свічці i. d — індикатори, htf — масив трендів старшого графіка. */
  function signalsAt(d, i, htf, opts) {
    const o = Object.assign({}, DEFAULT_OPTS, opts);
    if (i < MIN_BARS || i >= d.n) return [];
    const p = i - 1, dt = htf ? htf[i] : "flat";
    const buysAllowed = !(o.dailyFilter && dt === "down");
    const price = d.c[i], out = [];
    const extras = [];
    if (d.volRatio[i] >= 1.2) extras.push(["r_volume", { x: d.volRatio[i] }]);
    if (d.c[i] > d.o[i]) extras.push(["r_green", {}]);
    if (d.macdHist[i] > d.macdHist[p]) extras.push(["r_macd", {}]);
    if (d.c[i] > d.ema20[i]) extras.push(["r_ema20", {}]);
    if (dt === "up") extras.push(["r_htf_up", {}]);
    const score = extras.length;
    if (buysAllowed && d.trend[i] === "up" && d.rsi[p] < 40 && d.rsi[i] >= 40) {
      out.push({ type: "BUY_PULLBACK", i, price, score, reasons: [["r_trend_up", {}], ["r_rsi_bounce", { a: d.rsi[p], b: d.rsi[i] }], ...extras], plan: tradePlan(price, d.atr[i], o) });
    }
    if (buysAllowed && d.c[i] > d.ema200[i] && d.c[i] > d.high20prev[i] && d.c[p] <= d.high20prev[p] && d.volRatio[i] >= 1.5) {
      out.push({ type: "BUY_BREAKOUT", i, price, score, reasons: [["r_breakout", { lvl: d.high20prev[i] }], ["r_strong_volume", { x: d.volRatio[i] }], ["r_above_ema200", {}], ...extras.filter(e => e[0] !== "r_volume")], plan: tradePlan(price, d.atr[i], o) });
    }
    if (d.c[p] >= d.ema200[p] && d.ema200[i] > d.c[i]) out.push({ type: "EXIT_TREND", i, price, reasons: [["r_trend_break", {}], ["r_trend_break2", {}]] });
    if (d.rsi[p] < 75 && d.rsi[i] >= 75) out.push({ type: "TAKE_PROFIT", i, price, reasons: [["r_rsi_high", { v: d.rsi[i] }], ["r_rsi_high2", {}]] });
    if (Math.abs(d.chg[i]) >= o.sharpPct) out.push({ type: "SHARP_MOVE", i, price, chg: d.chg[i], reasons: [["r_sharp1", {}], ["r_sharp2", {}]] });
    return out;
  }

  /** Оцінка 0–100 і вердикт BUY / WAIT / AVOID. ctx: {htf, ltf, fng, hasBuy, isCrypto} */
  function verdictAt(d, i, ctx) {
    ctx = ctx || {};
    const f = [], add = (k, pts, kw) => f.push([k, kw || {}, pts]);
    const dt = ctx.htf || "flat", m = d.trend[i], s = ctx.ltf || "flat";
    if (dt === "up") add("f_htf_up", 25); else if (dt === "down") add("f_htf_down", -25);
    if (m === "up") add("f_main_up", 15); else if (m === "down") add("f_main_down", -15);
    if (s === "up") add("f_ltf_up", 5); else if (s === "down") add("f_ltf_down", -5);
    const r = d.rsi[i];
    if (r < 30) { if (m === "up" || dt === "up") add("f_rsi_oversold", 20, { v: r }); else add("f_rsi_knife", -5, { v: r }); }
    else if (r < 45 && m === "up") add("f_rsi_pullback", 10, { v: r });
    else if (r > 70) add("f_rsi_overbought", -15, { v: r });
    if (d.macdHist[i] > d.macdHist[i - 1]) add("f_macd_up", 10); else add("f_macd_down", -10);
    if (d.dist[i] > 4) add("f_overextended", -10);
    if (ctx.isCrypto && ctx.fng) {
      if (ctx.fng.value < 25) add("f_fng_fear", 5, { v: ctx.fng.value });
      else if (ctx.fng.value > 75) add("f_fng_greed", -5, { v: ctx.fng.value });
    }
    if (ctx.hasBuy) add("f_signal", 15);
    const raw = Math.max(-100, Math.min(100, f.reduce((s2, x) => s2 + x[2], 0)));
    const score = Math.round((raw + 100) / 2);
    const verdict = score >= BUY_AT ? "BUY" : score <= AVOID_AT ? "AVOID" : "WAIT";
    const top = f.slice().sort((a, b) => Math.abs(b[2]) - Math.abs(a[2])).slice(0, 4);
    return { verdict, score, factors: f, top };
  }

  /** Перевірка стратегії на завантаженій історії (як backtest.py). */
  function backtest(d, htf, opts) {
    const o = Object.assign({}, DEFAULT_OPTS, opts);
    const fee = o.fees / 100, trades = [];
    let i = MIN_BARS;
    while (i < d.n - 1) {
      if (!signalsAt(d, i, htf, o).some(s => BUY_TYPES.has(s.type))) { i++; continue; }
      const a = d.atr[i], entry = d.o[i + 1];
      const stop = entry - o.atrStop * a, target = entry + o.atrTarget * a;
      let exit = null, reason = "open", j = i + 1;
      for (; j < d.n; j++) {
        if (d.l[j] <= stop) { exit = Math.min(stop, d.o[j]); reason = "stop"; break; }
        if (d.h[j] >= target) { exit = Math.max(target, d.o[j]); reason = "target"; break; }
      }
      if (exit === null) { exit = d.c[d.n - 1]; j = d.n - 1; }
      trades.push({ i, j, ret: (exit * (1 - fee) / (entry * (1 + fee)) - 1) * 100, reason, stopPct: (stop / entry - 1) * 100 });
      i = j + 1;
    }
    const closed = trades.filter(x => x.reason !== "open");
    const wins = closed.filter(x => x.ret > 0);
    let eq = 1, peak = 1, dd = 0;
    for (const x of trades) { eq *= 1 + o.risk / 100 * (x.stopPct ? x.ret / Math.abs(x.stopPct) : 0); peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
    return {
      trades, n: trades.length, closed: closed.length, wr: closed.length ? wins.length / closed.length * 100 : 0,
      avg: closed.length ? closed.reduce((s, x) => s + x.ret, 0) / closed.length : 0,
      ret: (eq - 1) * 100, dd: dd * 100, bh: d.n > MIN_BARS ? (d.c[d.n - 1] / d.c[MIN_BARS] - 1) * 100 : 0,
    };
  }

  const api = { TF_MS, HTF, LTF, MIN_BARS, MAX_SCORE, BUY_TYPES, ema, indicators, alignTrend, tradePlan, signalsAt, verdictAt, backtest };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TREngine = api;
})(typeof window !== "undefined" ? window : globalThis);
