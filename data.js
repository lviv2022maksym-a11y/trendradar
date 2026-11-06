/* TrendRadar data: живі дані Binance (REST + WebSocket) або демо-генератор, якщо біржа недоступна. */
(function (root) {
  "use strict";
  const E = root.TREngine;

  // Binance.com недоступний із США — тоді беремо дзеркало даних, а далі Binance.US (той самий формат API)
  const REST = ["https://api.binance.com", "https://data-api.binance.vision", "https://api.binance.us"];
  const WSS = ["wss://stream.binance.com:9443", "wss://data-stream.binance.vision", "wss://stream.binance.us:9443"];
  const STABLE = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "USDE", "PYUSD", "XUSD", "USD1", "EURI", "BFUSD"]);

  function base(sym) { return sym.replace(/USDT$/, ""); }
  function tradable(sym) { return sym.endsWith("USDT") && !/(UP|DOWN|BULL|BEAR)USDT$/.test(sym) && !STABLE.has(base(sym)); }

  async function fetchJSON(url, ms) {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), ms || 9000);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(tm); }
  }

  /* ---------- Живі дані ---------- */
  function makeLive() {
    let restBase = null, wsIdx = 0;
    const WSTAT = { host: null, open: 0, fails: 0 };   // стан потоків — для вкладки «Підключення»
    async function api(path) {
      const order = restBase ? [restBase, ...REST.filter(b => b !== restBase)] : REST;
      let err;
      for (const b of order) {
        try { const j = await fetchJSON(b + path); restBase = b; return j; } catch (e) { err = e; }
      }
      throw err;
    }
    function stream(names, onData) {
      let ws = null, closed = false, tries = 0, timer = null;
      const open = () => {
        if (closed || !names.length) return;
        try { ws = new WebSocket(`${WSS[wsIdx % WSS.length]}/stream?streams=${names.join("/")}`); ws.addEventListener("open", () => { ws.__wasOpen = true; }); }
        catch (e) { retry(); return; }
        ws.onopen = () => { tries = 0; WSTAT.host = WSS[wsIdx % WSS.length]; WSTAT.open++; };
        ws.onmessage = ev => { try { const m = JSON.parse(ev.data); if (m && m.data) onData(m.stream, m.data); } catch (e) { /* пропускаємо биті повідомлення */ } };
        ws.onclose = ev => { if (ev && ev.target && ev.target.__wasOpen) WSTAT.open = Math.max(0, WSTAT.open - 1); if (!closed) { WSTAT.fails++; retry(); } };
        ws.onerror = () => { try { ws.close(); } catch (e) { /* */ } };
      };
      const retry = () => {
        tries++;
        if (tries % 3 === 0) wsIdx++;              // після кількох невдач пробуємо запасний сервер
        clearTimeout(timer);
        timer = setTimeout(open, Math.min(30000, 1000 * 2 ** Math.min(tries, 5)));
      };
      open();
      return { close() { closed = true; clearTimeout(timer); if (ws && ws.__wasOpen) WSTAT.open = Math.max(0, WSTAT.open - 1); if (ws) ws.__wasOpen = false; try { ws && ws.close(); } catch (e) { /* */ } } };
    }
    return {
      mode: "live",
      info() { return { rest: restBase, ws: WSTAT.host, wsOpen: WSTAT.open > 0 }; },
      async probe() { await api("/api/v3/ping"); return true; },
      async klines(sym, tf, limit) {
        const j = await api(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit || 500}`);
        return j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      },
      async tickers(syms) {
        if (!syms.length) return {};
        const j = await api(`/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`);
        return Object.fromEntries(j.map(x => [x.symbol, { price: +x.lastPrice, chg: +x.priceChangePercent, qv: +x.quoteVolume }]));
      },
      async allTickers() {
        const j = await api("/api/v3/ticker/24hr");
        return j.filter(x => tradable(x.symbol) && +x.quoteVolume > 0)
          .map(x => ({ symbol: x.symbol, price: +x.lastPrice, chg: +x.priceChangePercent, qv: +x.quoteVolume }));
      },
      async depth(sym) {
        const j = await api(`/api/v3/depth?symbol=${sym}&limit=500`);
        return { bids: j.bids.map(b => [+b[0], +b[1]]), asks: j.asks.map(a => [+a[0], +a[1]]) };
      },
      /** Ціни списку в реальному часі: onTick(sym, price, chgPct) */
      watchTickers(syms, onTick) {
        return stream(syms.map(s => s.toLowerCase() + "@miniTicker"), (_, d) => {
          const c = +d.c, o = +d.o;
          onTick(d.s, c, o ? (c / o - 1) * 100 : 0);
        });
      },
      /** Свічка графіка і угоди в реальному часі */
      watchChart(sym, tf, onKline, onTrade) {
        const s = sym.toLowerCase();
        return stream([`${s}@kline_${tf}`, `${s}@aggTrade`], (name, d) => {
          if (name.endsWith("@aggTrade")) onTrade({ p: +d.p, q: +d.q, usd: +d.p * +d.q, sell: !!d.m, t: d.T });
          else { const k = d.k; onKline({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, closed: !!k.x }); }
        });
      },
      async fng() {
        try { const j = await fetchJSON("https://api.alternative.me/fng/?limit=1", 6000); const d = j.data[0]; return { value: +d.value, class: d.value_classification }; }
        catch (e) { return null; }
      },
    };
  }

  /* ---------- Демо-дані (детерміновані, з «живим» тиканням) ---------- */
  function makeDemo() {
    const START = { BTC: 97250, ETH: 3610, SOL: 188, BNB: 672, XRP: 2.41, DOGE: 0.214, PAXG: 2655, TON: 5.3, ADA: 0.78, TRX: 0.25, AVAX: 38.5,
      LINK: 21.4, DOT: 7.9, LTC: 104, SHIB: 0.0000231, PEPE: 0.0000189, SUI: 4.1, NEAR: 6.2, APT: 11.8, ARB: 0.92, OP: 2.1, ATOM: 7.4, UNI: 13.2,
      BCH: 455, ETC: 27.5, FIL: 5.6, INJ: 27.1, WIF: 2.3, BONK: 0.000031, FLOKI: 0.00019, TIA: 6.4, SEI: 0.48, RENDER: 7.9, FET: 1.45, HBAR: 0.29,
      XLM: 0.43, ICP: 11.2, AAVE: 318, TAO: 520, ENA: 1.02, JUP: 1.08, TRUMP: 14.6,
      BOME: 0.0062, TURBO: 0.0058, NEIRO: 0.0011, PNUT: 0.31, PENGU: 0.021, MEME: 0.0035, PEOPLE: 0.021 };
    const VOL = { BTC: 0.006, ETH: 0.008, PAXG: 0.0025, DOGE: 0.014, SHIB: 0.016, PEPE: 0.02, BONK: 0.022, WIF: 0.024, FLOKI: 0.02, TRUMP: 0.02, BOME: 0.025, TURBO: 0.025, NEIRO: 0.028, PNUT: 0.028, PENGU: 0.024, MEME: 0.024, PEOPLE: 0.022 };
    const cache = new Map();          // key → {sym, tf, bars: відносні ціни (1.0 = якірна ціна)}
    const anchor = {}, price = {}, open24 = {}, subs = new Set();
    const hash = s => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
    const rng = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const gauss = r => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const p0 = b => START[b] ?? (1 + (hash(b) % 900) / 10);
    const vol1h = b => VOL[b] ?? 0.011;
    function ensure(sym, tf) {
      const key = sym + "|" + tf;
      if (anchor[sym] === undefined) { anchor[sym] = p0(base(sym)); price[sym] = anchor[sym]; }
      if (!cache.has(key)) {
        const r = rng(hash(key)), ms = E.TF_MS[tf], n = 1000;
        const sig = vol1h(base(sym)) * Math.sqrt(ms / 3.6e6);
        const rets = [];
        let drift = 0;
        for (let i = 0; i < n; i++) { if (i % 140 === 0) drift = gauss(r) * sig * 0.12; rets.push(drift + gauss(r) * sig * (r() < 0.04 ? 2.6 : 1)); }
        let lvl = 1;
        const rel = rets.map(x => (lvl *= Math.exp(x)));
        const last = rel[n - 1], cur = price[sym] / anchor[sym];
        const t0 = Math.floor(Date.now() / ms) * ms - (n - 1) * ms;
        const bars = [];
        let prevC = rel[0] / last * cur;
        for (let i = 0; i < n; i++) {
          const c = rel[i] / last * cur, o = prevC, w = Math.abs(gauss(r)) * sig * 0.5;
          bars.push({ t: t0 + i * ms, o, h: Math.max(o, c) * (1 + w), l: Math.min(o, c) * (1 - w), c, v: Math.exp(9 + gauss(r) * 0.35) * (1 + 25 * Math.abs(c / o - 1)) });
          prevC = c;
        }
        cache.set(key, { sym, tf, bars });
      }
      const entry = cache.get(key), ms = E.TF_MS[tf];
      let lastBar = entry.bars[entry.bars.length - 1];
      while (lastBar.t + ms <= Date.now()) {          // сторінка відкрита довго — додаємо нові свічки
        const c = lastBar.c;
        lastBar = { t: lastBar.t + ms, o: c, h: c, l: c, c, v: Math.exp(9) };
        entry.bars.push(lastBar);
      }
      return entry;
    }
    function series(sym, tf, limit) {
      const { bars } = ensure(sym, tf), a = anchor[sym];
      return bars.slice(-limit).map(b => ({ t: b.t, o: b.o * a, h: b.h * a, l: b.l * a, c: b.c * a, v: b.v }));
    }
    function chg24(sym) {
      if (open24[sym] === undefined) { const s = series(sym, "1h", 30); open24[sym] = s[s.length - 25].c; }
      return (price[sym] / open24[sym] - 1) * 100;
    }
    setInterval(() => {                                // «живе» тикання цін раз на 1,5 с
      for (const sym of Object.keys(price)) price[sym] *= Math.exp(gauss(Math.random) * vol1h(base(sym)) * 0.05);
      for (const entry of cache.values()) {            // оновлюємо останню свічку кожного графіка
        const last = entry.bars[entry.bars.length - 1], c = price[entry.sym] / anchor[entry.sym];
        last.c = c; last.h = Math.max(last.h, c); last.l = Math.min(last.l, c); last.v += Math.random() * 40;
      }
      subs.forEach(fn => fn());
    }, 1500);
    const ALL = Object.keys(START).map(b => b + "USDT");
    let imbalance = 0.52;
    return {
      mode: "demo",
      info() { return { rest: null, ws: null, wsOpen: false }; },
      async probe() { return true; },
      async klines(sym, tf, limit) { return series(sym, tf, limit || 500); },
      async tickers(syms) { return Object.fromEntries(syms.map(s => { ensure(s, "1h"); return [s, { price: price[s], chg: chg24(s), qv: 5e7 + (hash(s) % 1000) * 1e6 }]; })); },
      async allTickers() { return ALL.map(s => { ensure(s, "1h"); return { symbol: s, price: price[s], chg: chg24(s), qv: 5e7 + (hash(s) % 1000) * 1e6 }; }); },
      async depth(sym) {
        ensure(sym, "1h");
        const p = price[sym];
        imbalance = Math.min(0.8, Math.max(0.2, imbalance + (Math.random() - 0.5) * 0.06));
        const lv = k => Array.from({ length: 50 }, (_, i) => [p * (1 + k * (i + 1) * 0.0002), Math.random() * 3 * 50000 / p]);
        return { bids: lv(-1).map(x => [x[0], x[1] * imbalance * 2]), asks: lv(1).map(x => [x[0], x[1] * (1 - imbalance) * 2]) };
      },
      watchTickers(syms, onTick) {
        const fn = () => syms.forEach(s => { if (price[s] !== undefined) onTick(s, price[s], chg24(s)); });
        subs.add(fn);
        return { close() { subs.delete(fn); } };
      },
      watchChart(sym, tf, onKline, onTrade) {
        const fn = () => {
          const bars = series(sym, tf, 1), last = bars[0], p = price[sym];
          onKline({ t: last.t, o: last.o, h: last.h, l: last.l, c: p, v: last.v, closed: false });
          const n = Math.random() < 0.6 ? 1 + Math.floor(Math.random() * 4) : 0;
          for (let i = 0; i < n; i++) {
            const big = Math.random() < 0.3, usd = big ? 1.1e5 + Math.random() * 9e5 : 200 + Math.random() * 12000;
            onTrade({ p, q: usd / p, usd, sell: Math.random() > 0.5 + (imbalance - 0.5) * 0.6, t: Date.now() });
          }
        };
        subs.add(fn);
        return { close() { subs.delete(fn); } };
      },
      async fng() { return { value: 34, class: "Fear", demo: true }; },
    };
  }

  /* ---------- Демо-акції (для прев'ю, поки бот не опублікував справжні дані) ---------- */
  const STOCKS = [["AAPL","Apple","tech"],["MSFT","Microsoft","tech"],["NVDA","NVIDIA","tech"],["AVGO","Broadcom","tech"],["AMD","AMD","tech"],["ORCL","Oracle","tech"],
    ["ADBE","Adobe","tech"],["CRM","Salesforce","tech"],["CSCO","Cisco","tech"],["QCOM","Qualcomm","tech"],["TXN","Texas Instruments","tech"],["IBM","IBM","tech"],
    ["NOW","ServiceNow","tech"],["INTU","Intuit","tech"],["GOOGL","Alphabet (Google)","comm"],["META","Meta","comm"],["NFLX","Netflix","comm"],["DIS","Disney","comm"],
    ["VZ","Verizon","comm"],["TMUS","T-Mobile US","comm"],["AMZN","Amazon","cons"],["TSLA","Tesla","cons"],["HD","Home Depot","cons"],["MCD","McDonald's","cons"],
    ["NKE","Nike","cons"],["SBUX","Starbucks","cons"],["LOW","Lowe's","cons"],["BKNG","Booking","cons"],["WMT","Walmart","staples"],["COST","Costco","staples"],
    ["PG","Procter & Gamble","staples"],["KO","Coca-Cola","staples"],["PEP","PepsiCo","staples"],["PM","Philip Morris","staples"],["LLY","Eli Lilly","health"],
    ["UNH","UnitedHealth","health"],["JNJ","Johnson & Johnson","health"],["ABBV","AbbVie","health"],["MRK","Merck","health"],["TMO","Thermo Fisher","health"],
    ["ABT","Abbott","health"],["ISRG","Intuitive Surgical","health"],["BRK.B","Berkshire Hathaway","fin"],["JPM","JPMorgan Chase","fin"],["V","Visa","fin"],
    ["MA","Mastercard","fin"],["BAC","Bank of America","fin"],["GS","Goldman Sachs","fin"],["MS","Morgan Stanley","fin"],["AXP","American Express","fin"],
    ["BLK","BlackRock","fin"],["CAT","Caterpillar","ind"],["GE","GE Aerospace","ind"],["HON","Honeywell","ind"],["UNP","Union Pacific","ind"],
    ["LMT","Lockheed Martin","ind"],["RTX","RTX","ind"],["DE","Deere & Co.","ind"],["XOM","Exxon Mobil","energy"],["CVX","Chevron","energy"],
    ["NEE","NextEra Energy","energy"],["SPY","S&P 500 (SPY)","etf"],["QQQ","Nasdaq 100 (QQQ)","etf"],["DIA","Dow Jones (DIA)","etf"],["IWM","Russell 2000 (IWM)","etf"],
    ["VTI","Total US Market (VTI)","etf"],["SCHD","US Dividend (SCHD)","etf"],["GLD","Gold (GLD)","etf"],["SLV","Silver (SLV)","etf"],["TLT","US Treasury 20y+ (TLT)","etf"],
    ["XLK","Tech Sector (XLK)","etf"],["XLE","Energy Sector (XLE)","etf"]];
  const SECTORS = ["tech", "comm", "cons", "staples", "health", "fin", "ind", "energy", "etf"];
  const demoStockCache = new Map();
  function demoStockBars(sym) {
    if (demoStockCache.has(sym)) return demoStockCache.get(sym);
    let h = 2166136261; for (const ch of sym + "|stock") h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    let seed = h >>> 0;
    const r = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const g = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const day = 864e5, days = [];
    let d = Math.floor(Date.now() / day) * day - day;            // останній закритий день
    while (days.length < 1000) { const wd = new Date(d).getUTCDay(); if (wd !== 0 && wd !== 6) days.unshift(d); d -= day; }
    const p0 = 20 + (h >>> 0) % 580, sig = 0.012 + ((h >>> 8) % 10) / 1000;
    let lvl = p0 / Math.exp(0.0003 * 1000), drift = 0;
    const doc = { symbol: sym, demo: true, t: [], o: [], h: [], l: [], c: [], v: [] };
    for (let i = 0; i < days.length; i++) {
      if (i % 120 === 0) drift = 0.0004 + g() * 0.0012;
      const o = lvl; lvl *= Math.exp(drift + g() * sig);
      const c = lvl, w = Math.abs(g()) * sig * 0.6;
      doc.t.push(days[i]); doc.o.push(o); doc.c.push(c); doc.h.push(Math.max(o, c) * (1 + w)); doc.l.push(Math.min(o, c) * (1 - w));
      doc.v.push(Math.round(Math.exp(15 + g() * 0.3)));
    }
    doc.date = new Date(days[days.length - 1]).toISOString().slice(0, 10);
    demoStockCache.set(sym, doc);
    return doc;
  }
  function makeStockDemo() {
    const stocks = STOCKS.map(([sym, name, sector]) => {
      const doc = demoStockBars(sym);
      const bars = doc.t.map((t, i) => ({ t, o: doc.o[i], h: doc.h[i], l: doc.l[i], c: doc.c[i], v: doc.v[i] }));
      const d = E.indicators(bars), i = d.n - 1, htf = d.trend;
      const sigs = E.signalsAt(d, i, htf, {});
      const hasBuy = sigs.some(s => E.BUY_TYPES.has(s.type));
      const v = E.verdictAt(d, i, { htf: htf[i], ltf: "flat", hasBuy, isCrypto: false });
      return { symbol: sym, name, sector, price: d.c[i], chg: (d.c[i] / d.c[i - 1] - 1) * 100, date: doc.date, verdict: v.verdict, score: v.score,
        factors: v.factors, trends: { "1d": d.trend[i], "1w": htf[i] }, signal: hasBuy ? sigs.find(s => E.BUY_TYPES.has(s.type)).type : null, spark: d.c.slice(-40) };
    });
    return { demo: true, session: stocks[0] ? stocks[0].date : "", sectors: SECTORS, stocks };
  }

  async function loadSiteJSON(path) {
    try { return await fetchJSON(path, 6000); } catch (e) { return null; }
  }

  root.TRData = { makeLive, makeDemo, loadSiteJSON, base, tradable, makeStockDemo, demoStockBars, STOCK_SECTORS: SECTORS };
})(typeof window !== "undefined" ? window : globalThis);
