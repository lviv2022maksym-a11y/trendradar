/* TrendRadar app: ринки (крипта, мемкоїни, акції), графік, новини, P2P, школа, налаштування, підключення. */
(function () {
  "use strict";
  const E = window.TREngine, I = window.TRI18n, D = window.TRData;
  const t = (k, kw) => I.t(k, kw);
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const VIEWS = ["market", "memes", "stocks", "chart", "news", "p2p", "learn", "prefs", "connect", "more"];
  const MARKETS = ["market", "memes", "stocks"];
  const NAV_TOP = ["market", "chart", "news", "p2p", "learn", "prefs"];
  const NAV_BOTTOM = ["market", "chart", "news", "learn", "more"];
  const MORE = ["p2p", "prefs", "connect"];
  const TFS = ["15m", "1h", "4h", "1d", "1w"];
  const DEFAULT_WATCH = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "PAXGUSDT"];
  const MEMES = ["DOGEUSDT", "SHIBUSDT", "PEPEUSDT", "BONKUSDT", "WIFUSDT", "FLOKIUSDT", "TRUMPUSDT", "PENGUUSDT", "BOMEUSDT", "TURBOUSDT", "NEIROUSDT", "PNUTUSDT", "MEMEUSDT", "PEOPLEUSDT"];
  const DEFAULTS = {
    v: 2, lang: "uk", theme: "system", accent: "teal", density: "cozy", tf: "4h", watch: DEFAULT_WATCH,
    ind: { ema: true, volume: true, rsi: true, markers: true }, deposit: 1000, risk: 1, whale: 100000, data: "live",
    chartKind: "crypto", chartSym: "BTCUSDT", chartStock: "SPY", chartTf: "4h",
    filter: "all", sort: "score", memeFilter: "all", memeSort: "score", memeHidden: [],
    stockFilter: "all", stockSort: "score", stockSector: "all", stockHidden: [], newsAll: false,
    p2p: { buy: 41.5, sell: 42.1, amount: 10000, fee: 0.1, bank: 0 },
  };
  const KEY = "trendradar.v1";
  const HUES = { BTC: 33, ETH: 232, SOL: 268, BNB: 44, XRP: 205, DOGE: 46, PAXG: 40, TON: 199, ADA: 222, TRX: 355, AVAX: 2, LINK: 225, DOT: 330, LTC: 215, SHIB: 18, PEPE: 110, SUI: 200, BONK: 28, WIF: 300, FLOKI: 38, TRUMP: 8 };
  const LOCALE = { uk: "uk-UA", en: "en-US", ru: "ru-RU" };

  let S = loadState();
  const A = {
    P: null, mode: "demo", offline: false, an: new Map(), tickers: {}, fng: null, fngAt: 0, updated: 0, view: "market",
    tickWS: null, tickSyms: "", chartWS: null, c: null, ca: null, chartToken: 0, chartBuilt: false, lastPx: null, sigHist: [],
    pulse: { trades: [], whales: [], book: null }, depthTimer: null, pulseTimer: null, reloadTimer: null, refreshTimer: null,
    edit: false, anim: true, all: null, allAt: 0, news: null, stocksDoc: null, stockBars: new Map(), installEvt: null, resetArmed: false,
    flashAt: {}, addMode: "market", bannerHidden: false, memesSeen: false, stockQ: "", qTimer: null,
  };
  try { A.bannerHidden = sessionStorage.getItem("trendradar.banner") === "hidden"; } catch (e) { /* */ }

  /* ---------- Стан ---------- */
  function loadState() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { saved = null; }
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    if (saved && typeof saved === "object") {
      for (const k of Object.keys(s)) {
        if (saved[k] === undefined) continue;
        s[k] = (s[k] && typeof s[k] === "object" && !Array.isArray(s[k])) ? Object.assign(s[k], saved[k]) : saved[k];
      }
    }
    const okSym = x => typeof x === "string" && /^[A-Z0-9]{2,20}USDT$/.test(x);
    s.watch = Array.isArray(s.watch) ? s.watch.filter(okSym) : DEFAULT_WATCH.slice();
    s.memeHidden = Array.isArray(s.memeHidden) ? s.memeHidden.filter(okSym) : [];
    s.stockHidden = Array.isArray(s.stockHidden) ? s.stockHidden.filter(x => typeof x === "string" && /^[A-Z.]{1,8}$/.test(x)) : [];
    if (!TFS.includes(s.tf)) s.tf = "4h";
    if (!TFS.includes(s.chartTf)) s.chartTf = s.tf;
    if (!["crypto", "stock"].includes(s.chartKind)) s.chartKind = "crypto";
    if (!I.T[s.lang]) s.lang = "uk";
    return s;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* приватний режим: працюємо без збереження */ } }

  /* ---------- Форматування ---------- */
  const loc = () => LOCALE[I.getLang()] || "uk-UA";
  function decimals(p) { const a = Math.abs(p); return a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : a >= 0.0001 ? 6 : 8; }
  function fmtPx(p) {
    if (!isFinite(p)) return "—";
    const d = decimals(p);
    return new Intl.NumberFormat(loc(), { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d }).format(p);
  }
  function fmtNum(x, d) { return isFinite(x) ? new Intl.NumberFormat(loc(), { maximumFractionDigits: d ?? 2, minimumFractionDigits: d ?? 0 }).format(x) : "—"; }
  function fmtPct(x) { return isFinite(x) ? (x >= 0 ? "+" : "−") + new Intl.NumberFormat(loc(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(x)) + "%" : "—"; }
  function fmtUsd(x) { return isFinite(x) ? new Intl.NumberFormat(loc(), { notation: "compact", maximumFractionDigits: 1 }).format(x) + " $" : "—"; }
  function fmtTime(ts) { return new Intl.DateTimeFormat(loc(), { hour: "2-digit", minute: "2-digit" }).format(new Date(ts)); }
  function fmtTimeS(ts) { return new Intl.DateTimeFormat(loc(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ts)); }
  function fmtDate(iso) { if (!iso) return ""; const d = new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso); return isNaN(d) ? iso : new Intl.DateTimeFormat(loc(), { day: "numeric", month: "short" }).format(d); }
  function ago(ts) {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    return m < 60 ? t("ago_min", { n: Math.max(1, m) }) : m < 1440 ? t("ago_h", { n: Math.round(m / 60) }) : t("ago_d", { n: Math.round(m / 1440) });
  }
  const tfl = tf => t("tf_" + tf);
  const nameOf = sym => I.coinName(D.base(sym));
  function hue(b) { if (HUES[b] !== undefined) return HUES[b]; let h = 0; for (const c of String(b)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  const icoTxt = (txt, key) => `<span class="coin" style="--h:${hue(key || txt)}" aria-hidden="true">${esc(String(txt).slice(0, 4))}</span>`;
  const coinIco = sym => icoTxt(D.base(sym));
  const vColor = v => ({ BUY: "good", WAIT: "warn", AVOID: "bad" }[v]);
  const ARROW = { up: "↗", down: "↘", flat: "→" };
  const TFK = new Set(["htf", "mtf", "ltf"]);
  const kwLabels = kw => Object.fromEntries(Object.entries(kw || {}).map(([k, v]) => [k, TFK.has(k) && typeof v === "string" && I.T.en["tf_" + v] ? tfl(v) : v]));

  /* ---------- Іконки ---------- */
  const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const IC = {
    market: svg('<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>'),
    chart: svg('<path d="M7 4v3M7 15v5M17 3v4M17 13v4"/><rect x="5" y="7" width="4" height="8" rx="1"/><rect x="15" y="7" width="4" height="6" rx="1"/>'),
    news: svg('<path d="M5 5h11v14H6a1 1 0 0 1-1-1z"/><path d="M16 9h3v8a2 2 0 0 1-2 2h-1"/><path d="M8 9h5M8 12h5M8 15h3"/>'),
    p2p: svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
    learn: svg('<path d="M3 7.5 12 4l9 3.5-9 3.5z"/><path d="M7 9.5V15c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V9.5"/>'),
    prefs: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
    connect: svg('<path d="M9 15 15 9"/><path d="M11 6.5 13 4.5a4 4 0 0 1 5.7 5.7l-2 2M13 17.5l-2 2a4 4 0 0 1-5.7-5.7l2-2"/>'),
    more: svg('<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
    moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
    auto: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    refresh: svg('<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>'),
    download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
    warn: svg('<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>'),
    arrow: svg('<path d="M9 6l6 6-6 6"/>'),
  };

  /* ---------- Тема ---------- */
  function applyTheme() {
    const r = document.documentElement;
    if (S.theme === "system") r.removeAttribute("data-theme"); else r.setAttribute("data-theme", S.theme);
    if (S.accent === "teal") r.removeAttribute("data-accent"); else r.setAttribute("data-accent", S.accent);
    const b = $("#theme-btn");
    if (b) { b.innerHTML = S.theme === "dark" ? IC.moon : S.theme === "light" ? IC.sun : IC.auto; b.setAttribute("aria-label", t("pref_theme") + ": " + t("theme_" + S.theme)); b.title = t("theme_" + S.theme); }
    if (A.c) requestAnimationFrame(() => { rebuildChart(); });
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.tm);
    toast.tm = setTimeout(() => el.classList.remove("show"), 2200);
  }

  /* ---------- Каркас ---------- */
  const navLabel = v => t(v === "market" ? "nav_markets" : "nav_" + v);
  function renderShell() {
    I.setLang(S.lang);
    $("#tabs").innerHTML = NAV_TOP.map(v => `<a href="#${v}" data-nav="${v}">${esc(navLabel(v))}</a>`).join("");
    $("#tabs").setAttribute("aria-label", "TrendRadar");
    $("#bnav").innerHTML = NAV_BOTTOM.map(v => `<a href="#${v}" data-nav="${v}">${IC[v]}<span>${esc(navLabel(v))}</span></a>`).join("");
    $("#install-top").innerHTML = IC.download + `<span>${esc(t("install_btn"))}</span>`;
    updateModeUI();
    applyTheme();
    markNav();
  }
  const navOwner = v => (MARKETS.includes(v) ? "market" : v);
  function markNav() {
    const top = navOwner(A.view), bottom = MORE.includes(A.view) || A.view === "more" ? "more" : navOwner(A.view);
    $$("#tabs [data-nav]").forEach(a => a.setAttribute("aria-current", a.dataset.nav === top ? "page" : "false"));
    $$("#bnav [data-nav]").forEach(a => a.setAttribute("aria-current", a.dataset.nav === bottom ? "page" : "false"));
  }
  function updateModeUI() {
    const m = $("#mode");
    m.classList.toggle("live", A.mode === "live");
    $("#mode-t").textContent = A.mode === "live" ? t("live") : t("demo");
    m.title = A.mode === "live" ? t("status_live") : t("status_demo");
    const b = $("#banner");
    if (A.mode === "demo" && !A.bannerHidden) {
      b.innerHTML = `<div class="banner" role="note"><span class="b-dot"></span><span class="b-txt">${esc(A.offline ? t("offline_banner") : t("demo_short"))}</span>
        ${A.offline ? `<button class="btn sm" type="button" data-act="retry">${IC.refresh}<span>${esc(t("retry"))}</span></button>` : ""}
        <button class="icon-btn sm" type="button" data-act="hide-banner" aria-label="${esc(t("dismiss"))}" title="${esc(t("dismiss"))}">${IC.x}</button></div>`;
    } else b.innerHTML = "";
  }

  /* ---------- Дані та аналіз ---------- */
  async function connect() {
    teardownStreams();
    A.an.clear(); A.tickers = {}; A.all = null; A.fng = null; A.fngAt = 0;
    if (S.data === "demo") { A.P = D.makeDemo(); A.mode = "demo"; A.offline = false; }
    else {
      const live = D.makeLive();
      try { await live.probe(); A.P = live; A.mode = "live"; A.offline = false; }
      catch (e) { A.P = D.makeDemo(); A.mode = "demo"; A.offline = !!window.TR_PWA; }   // у прев'ю біржа недоступна за задумом
    }
    updateModeUI();
    startTickerStream();
    await refreshList(currentListKind() || "market");
    if (A.view === "chart") loadChart();
    if (A.view === "news") renderNews();
    if (A.view === "connect") renderConnect();
    clearInterval(A.refreshTimer);
    A.refreshTimer = setInterval(() => refreshList(currentListKind() || "market"), 60000);
  }
  function teardownStreams() {
    if (A.tickWS) { A.tickWS.close(); A.tickWS = null; A.tickSyms = ""; }
    stopChartStream();
  }
  const closedOnly = (bars, tf) => { const now = Date.now(), ms = E.TF_MS[tf]; return bars.filter(b => b.t + ms <= now); };
  function engineOpts() { return { dailyFilter: true, sharpPct: 3, atrStop: 2, atrTarget: 3, deposit: Math.max(1, +S.deposit || 1000), risk: Math.min(100, Math.max(0.01, +S.risk || 1)), maxPos: 100, fees: 0.1 }; }

  async function analyze(sym, tf, limit) {
    const htfTf = E.HTF[tf], ltfTf = E.LTF[tf];
    const [mb, hb, lb] = await Promise.all([
      A.P.klines(sym, tf, limit || 500),
      A.P.klines(sym, htfTf, 300).catch(() => []),
      A.P.klines(sym, ltfTf, 300).catch(() => []),
    ]);
    const mc = closedOnly(mb, tf), hc = closedOnly(hb, htfTf), lc = closedOnly(lb, ltfTf);
    if (mc.length < 30) throw new Error("few bars");
    const d = E.indicators(mc);
    const dh = hc.length >= 2 ? E.indicators(hc) : null, dl = lc.length >= 2 ? E.indicators(lc) : null;
    const htf = dh ? E.alignTrend(d.t, tf, dh.t, dh.trend, htfTf) : new Array(d.n).fill("flat");
    const i = d.n - 1, opts = engineOpts();
    const sigs = E.signalsAt(d, i, htf, opts);
    const hasBuy = sigs.some(s => E.BUY_TYPES.has(s.type));
    const trends = { ltf: dl ? dl.trend[dl.n - 1] : "flat", main: d.trend[i], htf: htf[i] };
    const v = E.verdictAt(d, i, { htf: trends.htf, ltf: trends.ltf, fng: A.fng, hasBuy, isCrypto: D.base(sym) !== "PAXG" });
    return { kind: "crypto", sym, tf, bars: mb, d, htf, v, sigs, trends, at: Date.now() };
  }

  const memeList = () => MEMES.filter(s => !S.memeHidden.includes(s) && (!A.all || A.all.some(x => x.symbol === s)));
  const listSyms = kind => (kind === "memes" ? memeList() : S.watch.slice());
  const currentListKind = () => (A.view === "memes" ? "memes" : A.view === "market" ? "market" : null);

  async function refreshList(kind) {
    if (!A.P) return;
    const P = A.P, tf = S.tf;
    if (kind === "memes" && !A.all) { try { A.all = await P.allTickers(); A.allAt = Date.now(); } catch (e) { /* */ } }
    const syms = listSyms(kind);
    if (!A.fngAt || Date.now() - A.fngAt > 6e5) { A.fng = await P.fng(); A.fngAt = Date.now(); }
    try { Object.assign(A.tickers, await P.tickers(syms)); } catch (e) { /* ціни підтягне потік */ }
    await Promise.all(syms.map(async s => {
      try { A.an.set(s + "|" + tf, await analyze(s, tf)); }
      catch (e) { if (!A.an.has(s + "|" + tf)) A.an.set(s + "|" + tf, { sym: s, tf, error: true }); }
    }));
    if (P !== A.P) return;
    A.updated = Date.now();
    if (A.view === kind) renderCrypto(kind);
  }

  function startTickerStream() {
    if (!A.P) return;
    const syms = [...new Set([...S.watch, ...(A.memesSeen ? memeList() : []), S.chartSym])].sort();
    const key = syms.join(",");
    if (A.tickWS && key === A.tickSyms) return;
    if (A.tickWS) A.tickWS.close();
    A.tickSyms = key;
    A.tickWS = A.P.watchTickers(syms, onTick);
  }
  function onTick(sym, price, chg) {
    const prev = A.tickers[sym];
    A.tickers[sym] = Object.assign(prev || {}, { price, chg });
    const now = Date.now();
    if (A.flashAt[sym] && now - A.flashAt[sym] < 400) return;
    A.flashAt[sym] = now;
    const dir = prev && prev.price !== undefined ? (price > prev.price ? "flash-up" : price < prev.price ? "flash-down" : "") : "";
    $$(`[data-px="${sym}"]`).forEach(el => {
      el.textContent = fmtPx(price);
      if (dir) { el.classList.remove("flash-up", "flash-down"); void el.offsetWidth; el.classList.add(dir); }
    });
    $$(`[data-ch="${sym}"]`).forEach(el => { el.textContent = fmtPct(chg); el.classList.toggle("up", chg >= 0); el.classList.toggle("down", chg < 0); });
    if (S.chartKind === "crypto" && sym === S.chartSym) A.lastPx = price;
  }

  /* ---------- Спільні частини списків ---------- */
  function marketSwitch(active) {
    return `<nav class="mswitch" aria-label="${esc(t("nav_markets"))}">${[["market", "nav_crypto"], ["memes", "nav_memes"], ["stocks", "nav_stocks"]].map(([v, k]) =>
      `<a href="#${v}" aria-current="${v === active ? "page" : "false"}">${esc(t(k))}</a>`).join("")}</nav>`;
  }
  function tfSeg(id, cur) {
    return `<div class="seg mono" id="${id}" role="group" aria-label="${esc(t("candles_for"))}">${TFS.map(x => `<button type="button" data-tf="${x}" aria-pressed="${x === cur}">${esc(tfl(x))}</button>`).join("")}</div>`;
  }
  function spark(vals) {
    if (!vals || vals.length < 2) return '<svg class="spark" aria-hidden="true"></svg>';
    const w = 240, h = 44, mn = Math.min(...vals), mx = Math.max(...vals), r = mx - mn || 1;
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 3 - ((v - mn) / r) * (h - 8)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
    const col = vals[vals.length - 1] >= vals[0] ? "var(--good)" : "var(--bad)";
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${line}L${w} ${h}L0 ${h}Z" fill="${col}" opacity=".10"/><path class="spark-line" d="${line}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke" pathLength="1"/></svg>`;
  }
  const trendSpan = (tf, tr) => `<span title="${esc(tfl(tf))}">${esc(tfl(tf))} <b class="tr-${tr}">${ARROW[tr] || "→"}</b></span>`;
  const meter = v => `<div class="meter-row"><div class="meter" style="--w:${v.score}%;--c:var(--${vColor(v.verdict)})"><i></i></div><span class="num">${v.score}/100</span></div>`;
  const pill = v => `<span class="pill ${v}">${esc(t("v_" + v))}</span>`;
  function summaryStrip(counts, extra) {
    const stat = k => `<div class="stat"><span class="k"><i class="dot ${k}"></i>${esc(t("count_" + k))}</span><span class="v num">${counts[k]}</span></div>`;
    return `<div class="summary">${stat("BUY")}${stat("WAIT")}${stat("AVOID")}${extra}</div>`;
  }
  function fngStat() {
    const f = A.fng;
    return f ? `<div class="stat fng"><span class="k">${esc(t("fng"))}${f.demo ? ` · ${esc(t("demo"))}` : ""}</span><span class="v num">${f.value}<small>${esc(t("fng_" + f.class))}</small></span><div class="fng-bar"><i style="left:${f.value}%"></i></div></div>`
      : `<div class="stat"><span class="k">${esc(t("fng"))}</span><span class="v num">—</span></div>`;
  }
  const verdictChips = (cur, attr) => `<div class="chips" role="group">${[["all", t("filter_all")], ["BUY", t("count_BUY")], ["WAIT", t("count_WAIT")], ["AVOID", t("count_AVOID")]].map(([k, l]) =>
    `<button class="chip" type="button" data-${attr}="${k}" aria-pressed="${cur === k}">${k !== "all" ? `<i class="dot ${k}"></i>` : ""}${esc(l)}</button>`).join("")}</div>`;
  const sortSelect = (id, cur, opts) => `<label class="sr" for="${id}">${esc(t("sort_label"))}</label><select id="${id}" class="select">${opts.map(k => `<option value="${k}" ${cur === k ? "selected" : ""}>${esc(t("sort_" + k))}</option>`).join("")}</select>`;
  function takeAnim() { const a = A.anim; A.anim = false; return a ? "anim" : ""; }
  const stagger = (html, i) => html.replace("<article ", `<article style="--i:${Math.min(i, 14)}" `);

  /* ---------- Крипта і мемкоїни ---------- */
  function cryptoCard(s, kind) {
    const a = A.an.get(s + "|" + S.tf), tk = A.tickers[s], b = D.base(s);
    const head = v => `<button class="rm" type="button" data-rm="${s}" data-kind="${kind}" aria-label="${esc(t("remove"))} ${esc(b)}">×</button>
      <div class="card-h">${coinIco(s)}<div class="coin-n"><b>${esc(nameOf(s))}</b><small>${esc(b)}/USDT</small></div>${v ? pill(v.verdict) : ""}</div>`;
    if (!a) return `<article class="card" aria-busy="true">${head(null)}<div class="card-p"><span class="px skeleton">00 000,00</span></div><div class="spark skeleton"></div><div class="meter skeleton"></div></article>`;
    const price = tk && isFinite(tk.price) ? tk.price : a.bars ? a.bars[a.bars.length - 1].c : NaN;
    const chg = tk ? tk.chg : NaN;
    if (a.error) return `<article class="card" data-open="${s}" tabindex="0" role="button">${head(null)}<div class="card-p"><span class="px" data-px="${s}">${fmtPx(price)}</span></div><p class="note" style="margin:0">—</p></article>`;
    const v = a.v;
    const memeRow = kind === "memes" ? `<div class="meme-row"><span class="tag risk">${esc(t("risk_very_high"))}</span><span class="vol">${esc(t("volume_24h"))}: <b class="mono">${tk && isFinite(tk.qv) ? fmtUsd(tk.qv) : "—"}</b></span></div>` : "";
    return `<article class="card" data-open="${s}" tabindex="0" role="button" aria-label="${esc(nameOf(s))}: ${esc(t("v_" + v.verdict))}, ${v.score}/100">
      ${head(v)}
      <div class="card-p"><span class="px" data-px="${s}">${fmtPx(price)}</span><span class="ch ${chg >= 0 ? "up" : "down"}" data-ch="${s}">${fmtPct(chg)}</span><span class="eyebrow">${esc(t("day"))}</span></div>
      ${spark(a.bars.slice(-48).map(x => x.c))}
      ${meter(v)}${memeRow}
      <div class="trends">${trendSpan(E.LTF[a.tf], a.trends.ltf)}${trendSpan(a.tf, a.trends.main)}${trendSpan(E.HTF[a.tf], a.trends.htf)}</div>
    </article>`;
  }
  function renderCrypto(kind) {
    const el = $("#v-" + kind), tf = S.tf, memes = kind === "memes";
    const fKey = memes ? "memeFilter" : "filter", sKey = memes ? "memeSort" : "sort";
    const rows = listSyms(kind).map(s => ({ s, a: A.an.get(s + "|" + tf), tk: A.tickers[s] }));
    const counts = { BUY: 0, WAIT: 0, AVOID: 0 };
    rows.forEach(x => { if (x.a && x.a.v) counts[x.a.v.verdict]++; });
    const list = rows.filter(x => S[fKey] === "all" || (x.a && x.a.v && x.a.v.verdict === S[fKey]));
    const score = x => (x.a && x.a.v ? x.a.v.score : -1);
    if (S[sKey] === "score") list.sort((p, q) => score(q) - score(p));
    else if (S[sKey] === "change") list.sort((p, q) => ((q.tk && q.tk.chg) ?? -1e9) - ((p.tk && p.tk.chg) ?? -1e9));
    else if (S[sKey] === "volume") list.sort((p, q) => ((q.tk && q.tk.qv) ?? -1) - ((p.tk && p.tk.qv) ?? -1));
    else if (S[sKey] === "name") list.sort((p, q) => nameOf(p.s).localeCompare(nameOf(q.s), loc()));
    const hidden = memes ? S.memeHidden.length : 0;
    el.innerHTML = `
      ${marketSwitch(kind)}
      <div class="view-h">
        <div><div class="eyebrow">${esc(A.mode === "live" ? "Binance · " + t("live") : t("demo"))}</div><h1>${esc(t(memes ? "memes_title" : "market_title"))}</h1>
          <p>${A.updated ? esc(t("updated", { t: fmtTime(A.updated) })) : esc(t("loading"))}</p></div>
        <div class="row"><span class="eyebrow">${esc(t("candles_for"))}</span>${tfSeg("m-tf", S.tf)}
          <button class="icon-btn" type="button" data-act="refresh" aria-label="${esc(t("retry"))}" title="${esc(t("retry"))}">${IC.refresh}</button></div>
      </div>
      ${memes ? `<div class="risk-note" role="note">${IC.warn}<div><b>${esc(t("memes_warn_t"))}</b><p>${esc(t("memes_warn"))}</p></div></div>` : ""}
      ${summaryStrip(counts, fngStat())}
      <div class="toolbar">
        ${verdictChips(S[fKey], memes ? "mfilter" : "filter")}
        <span class="spacer"></span>
        ${sortSelect(memes ? "mm-sort" : "m-sort", S[sKey], memes ? ["score", "change", "volume", "name"] : ["score", "change", "name"])}
        <button class="btn" type="button" data-act="edit">${esc(A.edit ? t("done") : t("edit"))}</button>
        ${memes ? (hidden ? `<button class="btn primary" type="button" data-act="add" data-kind="memes">${esc(t("show_hidden"))}</button>` : "")
          : `<button class="btn primary" type="button" data-act="add" data-kind="market">${IC.plus.replace("<svg", '<svg width="16" height="16"')}<span>${esc(t("add"))}</span></button>`}
      </div>
      ${rows.length ? "" : `<div class="empty" style="margin-bottom:12px">${esc(t("empty_watchlist"))}</div>`}
      <div class="grid ${A.edit ? "editing" : ""} ${S.density === "compact" ? "compact" : ""} ${takeAnim()}">
        ${list.map((x, i) => stagger(cryptoCard(x.s, kind), i)).join("")}
        ${memes ? "" : `<button class="card add" type="button" data-act="add" data-kind="market">${IC.plus}<span>${esc(t("add"))}</span></button>`}
      </div>
      ${memes && hidden ? `<p class="note">${esc(t("hidden_n", { n: hidden }))}</p>` : ""}
      <p class="note">${esc(t("disclaimer"))}</p>`;
  }

  /* ---------- Акції ---------- */
  async function ensureStocks() {
    if (A.stocksDoc) return A.stocksDoc;
    if (!ensureStocks.p) ensureStocks.p = D.loadSiteJSON("data/stocks.json").then(doc => {
      A.stocksDoc = doc && Array.isArray(doc.stocks) && doc.stocks.length ? doc : D.makeStockDemo();
      return A.stocksDoc;
    });
    return ensureStocks.p;
  }
  const stockList = () => (A.stocksDoc ? A.stocksDoc.stocks.filter(x => !S.stockHidden.includes(x.symbol)) : []);
  const stockBy = sym => (A.stocksDoc ? A.stocksDoc.stocks.find(x => x.symbol === sym) : null);
  const sName = x => I.stockName(x);
  const METALS = ["GLD", "SLV", "SPY", "QQQ", "DIA", "IWM", "VTI", "TLT"];
  function stockCard(x) {
    const tk = x.symbol.replace(".", "");
    return `<article class="card" data-stock="${esc(x.symbol)}" tabindex="0" role="button" aria-label="${esc(sName(x))}: ${esc(t("v_" + x.verdict))}, ${x.score}/100">
      <button class="rm" type="button" data-rm="${esc(x.symbol)}" data-kind="stocks" aria-label="${esc(t("remove"))} ${esc(x.symbol)}">×</button>
      <div class="card-h">${icoTxt(tk, tk)}<div class="coin-n"><b>${esc(sName(x))}</b><small>${esc(x.symbol)} · ${esc(t("sec_" + x.sector))}</small></div>${pill(x.verdict)}</div>
      <div class="card-p"><span class="px">${fmtPx(+x.price)}</span><span class="ch ${x.chg >= 0 ? "up" : "down"}">${fmtPct(+x.chg)}</span><span class="eyebrow">${esc(t("day_change"))}</span></div>
      ${spark(x.spark)}
      ${meter(x)}
      <div class="trends">${trendSpan("1d", (x.trends || {})["1d"] || "flat")}${trendSpan("1w", (x.trends || {})["1w"] || "flat")}<span class="date">${esc(t("close_on", { d: fmtDate(x.date) }))}</span></div>
    </article>`;
  }
  async function renderStocks() {
    const el = $("#v-stocks");
    if (!A.stocksDoc) el.innerHTML = marketSwitch("stocks") + `<div class="grid">${Array.from({ length: 6 }, () => '<article class="card" aria-busy="true"><div class="card-p"><span class="px skeleton">000,00</span></div><div class="spark skeleton"></div></article>').join("")}</div>`;
    await ensureStocks();
    if (A.view !== "stocks") return;
    const doc = A.stocksDoc, rows = stockList();
    const counts = { BUY: 0, WAIT: 0, AVOID: 0 };
    rows.forEach(x => { if (counts[x.verdict] !== undefined) counts[x.verdict]++; });
    const q = (A.stockQ || "").trim().toLowerCase();
    const list = rows.filter(x => (S.stockFilter === "all" || x.verdict === S.stockFilter) && (S.stockSector === "all" || x.sector === S.stockSector)
      && (!q || x.symbol.toLowerCase().includes(q) || x.name.toLowerCase().includes(q) || sName(x).toLowerCase().includes(q)));
    if (S.stockSort === "score") list.sort((p, r) => r.score - p.score);
    else if (S.stockSort === "change") list.sort((p, r) => r.chg - p.chg);
    else list.sort((p, r) => sName(p).localeCompare(sName(r), loc()));
    const sectors = doc.sectors || D.STOCK_SECTORS, hidden = S.stockHidden.length;
    el.innerHTML = `
      ${marketSwitch("stocks")}
      <div class="view-h">
        <div><div class="eyebrow">${esc(doc.demo ? t("demo") : "Yahoo Finance · " + fmtDate(doc.session || ""))}</div><h1>${esc(t("stocks_title"))}</h1><p>${esc(t("stocks_sub"))}</p></div>
      </div>
      ${doc.demo ? `<div class="banner soft" role="note"><span class="b-dot"></span><span class="b-txt">${esc(t("stocks_demo_note"))}</span></div>` : ""}
      ${summaryStrip(counts, `<div class="stat"><span class="k">${esc(t("nav_stocks"))}</span><span class="v num">${rows.length}</span></div>`)}
      <div class="toolbar">
        ${verdictChips(S.stockFilter, "sfilter")}
        <span class="spacer"></span>
        <label class="sr" for="s-q">${esc(t("search_stocks"))}</label><input id="s-q" class="input" type="search" placeholder="${esc(t("search_stocks"))}" value="${esc(A.stockQ || "")}" autocomplete="off">
        <label class="sr" for="s-sector">${esc(t("sector_all"))}</label><select id="s-sector" class="select"><option value="all">${esc(t("sector_all"))}</option>${sectors.map(k => `<option value="${k}" ${S.stockSector === k ? "selected" : ""}>${esc(t("sec_" + k))}</option>`).join("")}</select>
        ${sortSelect("s-sort", S.stockSort, ["score", "change", "name"])}
        <button class="btn" type="button" data-act="edit">${esc(A.edit ? t("done") : t("edit"))}</button>
        ${hidden ? `<button class="btn primary" type="button" data-act="add" data-kind="stocks">${esc(t("show_hidden"))}</button>` : ""}
      </div>
      <div class="grid ${A.edit ? "editing" : ""} ${S.density === "compact" ? "compact" : ""} ${takeAnim()}" id="s-grid">
        ${list.map((x, i) => stagger(stockCard(x), i)).join("") || `<div class="empty">${esc(t("no_results"))}</div>`}
      </div>
      ${hidden ? `<p class="note">${esc(t("hidden_n", { n: hidden }))}</p>` : ""}
      <p class="note">${esc(t("disclaimer"))}</p>`;
  }

  /* ---------- Графік ---------- */
  function buildChartView() {
    $("#v-chart").innerHTML = `
      <div class="chart-bar">
        <label class="sr" for="c-sym">${esc(t("nav_chart"))}</label><select id="c-sym" class="select"></select>
        <button class="btn" type="button" data-act="find">${svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>').replace("<svg", '<svg width="16" height="16"')}<span>${esc(t("find_asset"))}</span></button>
        ${tfSeg("c-tf", S.chartTf)}<span class="tag" id="c-daily" hidden>${esc(t("daily_only"))}</span>
        <span class="spacer"></span>
        <div class="chips" role="group" aria-label="${esc(t("indicators"))}">${["ema", "volume", "rsi", "markers"].map(k => `<button class="chip" type="button" data-ind="${k}" aria-pressed="${!!S.ind[k]}">${esc(t("ind_" + k))}</button>`).join("")}</div>
      </div>
      <div class="chart-head" id="c-head"></div>
      <div class="chart-grid">
        <div class="chart-box"><div id="tv-main"></div><div id="tv-rsi"></div>
          <div class="chart-legend"><span><i style="background:var(--ema20)"></i>EMA20</span><span><i style="background:var(--ema50)"></i>EMA50</span><span><i style="background:var(--ema200)"></i>EMA200</span><span style="color:var(--good)">▲ ${esc(t("sig_BUY_PULLBACK").split("·")[0].trim())}</span><span style="color:var(--bad)">▼ ${esc(t("sig_EXIT_TREND"))}</span><span style="color:var(--warn)">● ${esc(t("sig_TAKE_PROFIT"))}</span></div>
        </div>
        <aside class="side">
          <section class="panel" id="p-verdict" aria-live="polite"></section>
          <section class="panel" id="p-pulse"></section>
          <section class="panel" id="p-plan"></section>
          <section class="panel" id="p-signals"></section>
          <section class="panel" id="p-bt"></section>
        </aside>
      </div>`;
    A.chartBuilt = true;
    fillSymSelect();
  }
  function fillSymSelect() {
    const sel = $("#c-sym");
    if (!sel) return;
    const cur = S.chartKind === "stock" ? "s:" + S.chartStock : "c:" + S.chartSym;
    const seen = new Set();
    const copt = s => { seen.add("c:" + s); return `<option value="c:${s}" ${"c:" + s === cur ? "selected" : ""}>${esc(nameOf(s))} · ${esc(D.base(s))}</option>`; };
    const sopt = s => { seen.add("s:" + s); const x = stockBy(s); return `<option value="s:${esc(s)}" ${"s:" + s === cur ? "selected" : ""}>${esc(x ? sName(x) : s)} · ${esc(s)}</option>`; };
    const grp = (label, opts) => (opts.length ? `<optgroup label="${esc(label)}">${opts.join("")}</optgroup>` : "");
    const watch = [...new Set([...S.watch, ...(S.chartKind === "crypto" && !S.watch.includes(S.chartSym) ? [S.chartSym] : [])])];
    const memes = memeList().filter(s => !watch.includes(s));
    const popular = (A.all || []).slice().sort((p, q) => q.qv - p.qv).map(x => x.symbol).filter(s => !watch.includes(s) && !memes.includes(s)).slice(0, 40);
    const stocks = A.stocksDoc ? stockList().map(x => x.symbol) : [];
    if (S.chartKind === "stock" && !stocks.includes(S.chartStock)) stocks.unshift(S.chartStock);
    const metals = METALS.filter(s => stocks.includes(s));
    sel.innerHTML = grp(t("grp_watch"), watch.map(copt)) + grp(t("nav_memes"), memes.map(copt)) + grp(t("grp_popular"), popular.map(copt))
      + grp(t("grp_metals"), metals.map(sopt)) + grp(t("nav_stocks"), stocks.filter(s => !metals.includes(s)).map(sopt));
    const isStock = S.chartKind === "stock";
    $("#c-tf").hidden = isStock;
    $("#c-daily").hidden = !isStock;
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  const ct = ms => Math.floor(ms / 1000);   // час графіка в UTC; підписи — за місцевим часом, без збоїв при переході на літній/зимовий час
  function timeFmt(sec, type) {
    const d = new Date(sec * 1000), o = { 0: { year: "numeric" }, 1: { month: "short" }, 2: { day: "numeric", month: "short" }, 3: { hour: "2-digit", minute: "2-digit" }, 4: { hour: "2-digit", minute: "2-digit", second: "2-digit" } };
    return new Intl.DateTimeFormat(loc(), type === undefined ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : o[type] || o[3]).format(d);
  }
  function initChart() {
    destroyChart();
    const LC = window.LightweightCharts, box = $("#tv-main");
    if (!box) return;
    if (!LC) { box.innerHTML = `<div class="chart-fail">${esc(t("chart_fail"))}</div>`; $("#tv-rsi").hidden = true; return; }
    box.innerHTML = ""; $("#tv-rsi").innerHTML = "";
    const th = { bg: cssVar("--surface"), fg: cssVar("--muted"), line: cssVar("--line"), up: cssVar("--chart-up"), down: cssVar("--chart-down"),
      e20: cssVar("--ema20"), e50: cssVar("--ema50"), e200: cssVar("--ema200"), good: cssVar("--good"), bad: cssVar("--bad"), warn: cssVar("--warn"), fgStrong: cssVar("--fg") };
    const base = {
      autoSize: true,
      layout: { background: { type: "solid", color: th.bg }, textColor: th.fg, fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 11 },
      grid: { vertLines: { color: th.line }, horzLines: { color: th.line } },
      rightPriceScale: { borderColor: th.line, minimumWidth: 92 },
      timeScale: { borderColor: th.line, timeVisible: true, secondsVisible: false, rightOffset: 4, tickMarkFormatter: (time, type) => timeFmt(time, type) },
      crosshair: { mode: LC.CrosshairMode.Normal },
      localization: { locale: loc(), priceFormatter: p => fmtPx(p), timeFormatter: time => timeFmt(time) },
    };
    const main = LC.createChart(box, base);
    const candles = main.addCandlestickSeries({ upColor: th.up, downColor: th.down, wickUpColor: th.up, wickDownColor: th.down, borderVisible: false });
    const line = c => main.addLineSeries({ color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const e20 = line(th.e20), e50 = line(th.e50), e200 = line(th.e200);
    const vol = main.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    main.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    main.priceScale("right").applyOptions({ scaleMargins: { top: 0.07, bottom: 0.2 } });
    const rsiChart = LC.createChart($("#tv-rsi"), Object.assign({}, base, { localization: { locale: loc(), priceFormatter: p => p.toFixed(0), timeFormatter: time => timeFmt(time) } }));
    const rsi = rsiChart.addLineSeries({ color: th.e200, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    [70, 30].forEach(p => rsi.createPriceLine({ price: p, color: th.fg, lineWidth: 1, lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false }));
    let syncing = false;
    const sync = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange(r => {
      if (syncing || !r) return;
      syncing = true;
      try { b.timeScale().setVisibleLogicalRange(r); } catch (e) { /* другий графік ще без даних */ }
      syncing = false;
    });
    sync(main, rsiChart); sync(rsiChart, main);
    A.c = { LC, th, main, rsiChart, candles, e20, e50, e200, vol, rsi, plines: [] };
    applyIndicatorVisibility();
  }
  function destroyChart() {
    if (!A.c) return;
    try { A.c.main.remove(); A.c.rsiChart.remove(); } catch (e) { /* */ }
    A.c = null;
  }
  function rebuildChart() {
    if (!A.chartBuilt || !$("#tv-main")) return;
    initChart();
    if (A.ca) { try { setChartData(A.ca, true); } catch (e) { /* */ } }
  }
  function applyIndicatorVisibility() {
    const c = A.c;
    if (!c) return;
    [c.e20, c.e50, c.e200].forEach(s => s.applyOptions({ visible: !!S.ind.ema }));
    c.vol.applyOptions({ visible: !!S.ind.volume });
    $("#tv-rsi").hidden = !S.ind.rsi;
    c.main.timeScale().applyOptions({ visible: !S.ind.rsi });
    if (A.ca) setMarkers(A.ca);
  }
  function setMarkers(a) {
    const c = A.c;
    if (!c) return;
    if (!S.ind.markers) { c.candles.setMarkers([]); return; }
    const mk = [];
    for (const s of A.sigHist) {
      const time = ct(a.d.t[s.i]);
      if (E.BUY_TYPES.has(s.type)) mk.push({ time, position: "belowBar", color: c.th.good, shape: "arrowUp" });
      else if (s.type === "EXIT_TREND") mk.push({ time, position: "aboveBar", color: c.th.bad, shape: "arrowDown" });
      else if (s.type === "TAKE_PROFIT") mk.push({ time, position: "aboveBar", color: c.th.warn, shape: "circle" });
    }
    mk.sort((p, q) => p.time - q.time);
    c.candles.setMarkers(mk.filter((m, i) => i === 0 || m.time !== mk[i - 1].time || m.shape !== mk[i - 1].shape));
  }
  function uniqBars(bars) {
    const out = [];
    for (const b of bars) { if (out.length && b.t <= out[out.length - 1].t) { if (b.t === out[out.length - 1].t) out[out.length - 1] = b; continue; } out.push(b); }
    return out;
  }
  function setChartData(a, keepRange) {
    const c = A.c;
    if (!c) return;
    a.bars = uniqBars(a.bars);
    const bars = a.bars, full = E.indicators(bars);
    const up = c.th.up, down = c.th.down, tfn = i => ct(bars[i].t);
    const range = keepRange ? c.main.timeScale().getVisibleLogicalRange() : null;
    const dec = decimals(bars[bars.length - 1].c);
    c.candles.applyOptions({ priceFormat: { type: "price", precision: dec, minMove: 1 / 10 ** dec } });
    c.candles.setData(bars.map(b => ({ time: ct(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    c.vol.setData(bars.map(b => ({ time: ct(b.t), value: b.v, color: (b.c >= b.o ? up : down) + "55" })));
    const ln = arr => arr.map((v, i) => ({ time: tfn(i), value: v })).slice(20);
    c.e20.setData(ln(full.ema20)); c.e50.setData(ln(full.ema50)); c.e200.setData(ln(full.ema200));
    c.rsi.setData(full.rsi.map((v, i) => ({ time: tfn(i), value: v })).slice(15));
    setMarkers(a);
    c.plines.forEach(p => { try { c.candles.removePriceLine(p); } catch (e) { /* */ } });
    c.plines = [];
    const recent = A.sigHist.filter(s => E.BUY_TYPES.has(s.type) && s.i >= a.d.n - 5).pop();
    if (recent) {
      const p = recent.plan, L = c.LC.LineStyle.Dashed;
      c.plines.push(c.candles.createPriceLine({ price: p.target, color: c.th.good, lineWidth: 1, lineStyle: L, title: t("target") }));
      c.plines.push(c.candles.createPriceLine({ price: p.entry, color: c.th.fgStrong, lineWidth: 1, lineStyle: L, title: t("entry") }));
      c.plines.push(c.candles.createPriceLine({ price: p.stop, color: c.th.bad, lineWidth: 1, lineStyle: L, title: t("stop") }));
    }
    if (range) c.main.timeScale().setVisibleLogicalRange(range);
    else c.main.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 160), to: bars.length + 3 });
  }
  function renderChartHead(a) {
    const el = $("#c-head");
    if (!el) return;
    if (S.chartKind === "stock") {
      const x = stockBy(S.chartStock), tk = S.chartStock.replace(".", "");
      const px = x ? +x.price : a ? a.bars[a.bars.length - 1].c : NaN, chg = x ? +x.chg : NaN;
      el.innerHTML = `${icoTxt(tk, tk)}<h1>${esc(x ? sName(x) : S.chartStock)}<small>${esc(S.chartStock)}${x ? " · " + esc(t("sec_" + x.sector)) : ""}</small></h1>
        <span class="px">${fmtPx(px)}</span><span class="ch ${chg >= 0 ? "up" : "down"}">${fmtPct(chg)}</span>
        ${a && a.v ? `<span class="pill ${a.v.verdict}">${esc(t("v_" + a.v.verdict))} · ${a.v.score}</span>` : ""}${x ? `<span class="eyebrow">${esc(t("close_on", { d: fmtDate(x.date) }))}</span>` : ""}`;
      return;
    }
    const s = S.chartSym, tk = A.tickers[s];
    const px = A.lastPx ?? (tk && tk.price) ?? (a ? a.bars[a.bars.length - 1].c : NaN);
    const chg = tk ? tk.chg : NaN;
    el.innerHTML = `${coinIco(s)}<h1>${esc(nameOf(s))}<small>${esc(D.base(s))}/USDT</small></h1>
      <span class="px" data-px="${s}">${fmtPx(px)}</span><span class="ch ${chg >= 0 ? "up" : "down"}" data-ch="${s}">${fmtPct(chg)}</span>
      ${a && a.v ? `<span class="pill ${a.v.verdict}">${esc(t("v_" + a.v.verdict))} · ${a.v.score}</span>` : ""}`;
  }
  async function loadStockBars(sym) {
    if (A.stockBars.has(sym)) return A.stockBars.get(sym);
    await ensureStocks();
    let doc = null;
    if (!A.stocksDoc.demo) doc = await D.loadSiteJSON("data/stocks/" + sym.replace(".", "-") + ".json");
    if (!doc || !Array.isArray(doc.t) || doc.t.length < 30) doc = D.demoStockBars(sym);
    A.stockBars.set(sym, doc);
    return doc;
  }
  async function analyzeStock(sym) {
    const doc = await loadStockBars(sym);
    const bars = doc.t.map((tt, i) => ({ t: tt, o: doc.o[i], h: doc.h[i], l: doc.l[i], c: doc.c[i], v: doc.v[i] }));
    const d = E.indicators(bars), i = d.n - 1;
    const htf = Array.isArray(doc.htf) && doc.htf.length === d.n ? doc.htf : d.trend.slice();
    const sigs = E.signalsAt(d, i, htf, engineOpts());
    const hasBuy = sigs.some(s => E.BUY_TYPES.has(s.type));
    let v = E.verdictAt(d, i, { htf: htf[i], ltf: "flat", hasBuy, isCrypto: false });
    const x = stockBy(sym);
    if (x && Array.isArray(x.factors) && !doc.demo) v = { verdict: x.verdict, score: x.score, factors: x.factors };   // та сама оцінка, що на картці (від бота)
    return { kind: "stock", sym, tf: "1d", bars, d, htf, v, sigs, trends: { ltf: "flat", main: d.trend[i], htf: htf[i] } };
  }
  async function loadChart() {
    if (!A.P) return;
    if (!A.chartBuilt) buildChartView();
    if (!A.c) initChart();
    const kind = S.chartKind, sym = kind === "stock" ? S.chartStock : S.chartSym, tf = kind === "stock" ? "1d" : S.chartTf, token = ++A.chartToken;
    fillSymSelect();
    renderChartHead(null);
    let a;
    try { a = kind === "stock" ? await analyzeStock(sym) : await analyze(sym, tf, 1000); }
    catch (e) {
      if (token !== A.chartToken) return;
      $("#p-verdict").innerHTML = `<p class="sub">${esc(t("no_signals"))}</p>`;
      return;
    }
    if (token !== A.chartToken) return;
    A.ca = a;
    A.lastPx = kind === "stock" ? a.d.c[a.d.n - 1] : ((A.tickers[sym] && A.tickers[sym].price) || a.bars[a.bars.length - 1].c);
    const o = engineOpts(), hist = [];
    for (let i = E.MIN_BARS; i < a.d.n; i++) hist.push(...E.signalsAt(a.d, i, a.htf, o));
    A.sigHist = hist;
    try { setChartData(a, false); } catch (e) { console.warn("chart", e); }
    renderChartHead(a);
    renderPanels(a);
    if (kind === "crypto") startChartStream(sym, tf); else { stopChartStream(); renderStockTradePanel(); }
  }
  function stopChartStream() {
    if (A.chartWS) { A.chartWS.close(); A.chartWS = null; }
    clearInterval(A.depthTimer); clearInterval(A.pulseTimer); clearTimeout(A.reloadTimer);
    A.depthTimer = A.pulseTimer = null;
  }
  function startChartStream(sym, tf) {
    stopChartStream();
    A.pulse = { trades: [], whales: [], book: null };
    const P = A.P;
    A.chartWS = P.watchChart(sym, tf, k => {
      if (S.chartKind !== "crypto" || sym !== S.chartSym || tf !== S.chartTf || !A.c || !A.ca) return;
      const bars = A.ca.bars, last = bars[bars.length - 1];
      if (k.t < last.t) return;
      const bar = { t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
      if (k.t === last.t) bars[bars.length - 1] = bar; else bars.push(bar);
      try {
        A.c.candles.update({ time: ct(k.t), open: k.o, high: k.h, low: k.l, close: k.c });
        A.c.vol.update({ time: ct(k.t), value: k.v, color: (k.c >= k.o ? A.c.th.up : A.c.th.down) + "55" });
      } catch (e) { /* */ }
      A.lastPx = k.c;
      if (k.closed) { clearTimeout(A.reloadTimer); A.reloadTimer = setTimeout(loadChart, 1500); }
    }, tr => {
      const p = A.pulse;
      p.trades.push(tr);
      if (tr.usd >= (+S.whale || 100000)) { p.whales.unshift(Object.assign({ fresh: true }, tr)); p.whales.length = Math.min(p.whales.length, 14); }
    });
    const pollDepth = async () => {
      try {
        const d = await P.depth(sym);
        const mid = (d.bids[0][0] + d.asks[0][0]) / 2, lo = mid * 0.995, hi = mid * 1.005;
        A.pulse.book = { bid: d.bids.filter(x => x[0] >= lo).reduce((s, x) => s + x[0] * x[1], 0), ask: d.asks.filter(x => x[0] <= hi).reduce((s, x) => s + x[0] * x[1], 0) };
      } catch (e) { /* наступна спроба через 3 с */ }
    };
    pollDepth();
    A.depthTimer = setInterval(pollDepth, 3000);
    A.pulseTimer = setInterval(() => { renderPulse(); updatePlanLive(); }, 1000);
    renderPulse();
  }
  function renderStockTradePanel() {
    const el = $("#p-pulse");
    if (el) el.innerHTML = `<h3>${esc(t("stock_trade_t"))}<small>Alpaca</small></h3><p class="sub" style="margin:0">${esc(t("stock_trade"))}</p>`;
  }
  function renderPanels(a) {
    const v = a.v, kw = { htf: tfl(E.HTF[a.tf]), mtf: tfl(a.tf), ltf: tfl(E.LTF[a.tf]) };
    const fl = v.factors.slice().sort((p, q) => Math.abs(q[2]) - Math.abs(p[2]));
    $("#p-verdict").innerHTML = `<h3>${esc(t("verdict_title"))}<small>${esc(tfl(a.tf))}</small></h3>
      <div class="verdict-big"><div class="gauge" style="--s:${v.score};--c:var(--${vColor(v.verdict)})"><b>${v.score}</b></div>
        <div><div class="vt" style="color:var(--${vColor(v.verdict)})">${esc(t("v_" + v.verdict))}</div><p>${esc(t("vh_" + v.verdict))}</p></div></div>
      <div class="eyebrow" style="margin:4px 0 8px">${esc(t("why"))}</div>
      <ul class="factors">${fl.map(([k, p, pts]) => `<li class="${pts > 0 ? "pos" : "neg"}"><span class="s">${pts > 0 ? "+" : "−"}${Math.abs(pts)}</span><span>${esc(t(k, Object.assign({}, kw, kwLabels(p))))}</span></li>`).join("")}</ul>`;
    updatePlanLive();
    const lastSigs = A.sigHist.slice(-6).reverse();
    $("#p-signals").innerHTML = `<h3>${esc(t("signals_title"))}</h3>${lastSigs.length ? `<ul class="siglist">${lastSigs.map(s => {
      const col = E.BUY_TYPES.has(s.type) ? "good" : s.type === "EXIT_TREND" ? "bad" : s.type === "TAKE_PROFIT" ? "warn" : "muted";
      const n = a.d.n - 1 - s.i;
      return `<li><i class="dot" style="background:var(--${col})"></i><span>${esc(t("sig_" + s.type))}</span><span class="m">${fmtPx(s.price)} · ${n === 0 ? esc(t("now")) : esc(t("bars_ago", { n }))}</span></li>`;
    }).join("")}</ul>` : `<p class="sub">${esc(t("no_signals"))}</p>`}`;
    const bt = E.backtest(a.d, a.htf, engineOpts());
    $("#p-bt").innerHTML = `<h3>${esc(t("bt_title"))}</h3><div class="bt">
      <div><span>${esc(t("bt_trades"))}</span><b>${bt.n}</b></div><div><span>${esc(t("bt_wr"))}</span><b>${bt.closed ? fmtNum(bt.wr, 0) + "%" : "—"}</b></div>
      <div><span>${esc(t("bt_ret"))}</span><b class="${bt.n ? (bt.ret >= 0 ? "up" : "down") : ""}">${bt.n ? fmtPct(bt.ret) : "—"}</b></div><div><span>${esc(t("bt_bh"))}</span><b class="${bt.bh >= 0 ? "up" : "down"}">${fmtPct(bt.bh)}</b></div></div>
      <p class="sub">${esc(t("bt_note", { n: a.d.n, tf: tfl(a.tf), risk: fmtNum(engineOpts().risk, 2) }))}</p>`;
  }
  function updatePlanLive() {
    const a = A.ca, el = $("#p-plan");
    if (!a || !el) return;
    const o = engineOpts(), price = A.lastPx || a.d.c[a.d.n - 1];
    const p = E.tradePlan(price, a.d.atr[a.d.n - 1], o);
    el.innerHTML = `<h3>${esc(t("plan_title"))}</h3>
      <dl class="kv">
        <dt>${esc(t("entry"))}</dt><dd>${fmtPx(p.entry)} $</dd><dd class="pct"></dd>
        <dt>${esc(t("stop"))}</dt><dd>${fmtPx(p.stop)} $</dd><dd class="pct down">${fmtPct(p.stopPct)}</dd>
        <dt>${esc(t("target"))}</dt><dd>${fmtPx(p.target)} $</dd><dd class="pct up">${fmtPct(p.targetPct)}</dd>
        <dt>${esc(t("size"))}</dt><dd><b>${fmtNum(p.sizeUsd, 2)} $</b></dd><dd class="pct"></dd>
      </dl>
      <p class="sub">${esc(t("risk_line", { risk: fmtNum(p.riskUsd, 2), pct: fmtNum(o.risk, 2) }))} · ${esc(t("rr", { rr: p.rr }))}<br>${esc(t("plan_note"))}</p>`;
  }
  function renderPulse() {
    const el = $("#p-pulse");
    if (!el || S.chartKind !== "crypto") return;
    const p = A.pulse, now = Date.now();
    p.trades = p.trades.filter(x => now - x.t < 60000);
    const buy = p.trades.filter(x => !x.sell).reduce((s, x) => s + x.usd, 0), sell = p.trades.filter(x => x.sell).reduce((s, x) => s + x.usd, 0);
    const bar = (b, s) => { const tot = b + s, pb = tot ? Math.round(b / tot * 100) : 50; return `<div class="pbar"><div class="b" style="flex-basis:${pb}%">${pb}%</div><div class="s" style="flex-basis:${100 - pb}%">${100 - pb}%</div></div>`; };
    const bk = p.book;
    el.innerHTML = `<h3>${esc(t("pulse_title"))}<small>${esc(A.mode === "live" ? t("live") : t("demo"))}</small></h3>
      <div class="pressure">
        <div class="plabel"><span>${esc(t("pulse_book"))}</span></div>
        ${bk ? bar(bk.bid, bk.ask) : `<div class="pbar skeleton"></div>`}
        <div class="plabel"><span>${esc(t("pulse_buyers"))} ${bk ? fmtUsd(bk.bid) : ""}</span><span>${esc(t("pulse_sellers"))} ${bk ? fmtUsd(bk.ask) : ""}</span></div>
        <div class="plabel" style="margin-top:6px"><span>${esc(t("pulse_flow"))}</span></div>
        ${bar(buy, sell)}
        <div class="plabel"><span>${esc(t("pulse_buyers"))} ${fmtUsd(buy)}</span><span>${esc(t("pulse_sellers"))} ${fmtUsd(sell)}</span></div>
      </div>
      <div class="eyebrow" style="margin-top:12px">${esc(t("whales_title", { x: fmtNum(+S.whale || 100000, 0) }))}</div>
      ${p.whales.length ? `<ul class="whales">${p.whales.map(w => { const li = `<li class="${w.fresh ? "new" : ""}"><time>${fmtTimeS(w.t)}</time><span class="${w.sell ? "side-s" : "side-b"}">${esc(w.sell ? t("whale_sell") : t("whale_buy"))} · ${fmtUsd(w.usd)}</span><span class="mono">${fmtPx(w.p)}</span></li>`; w.fresh = false; return li; }).join("")}</ul>` : `<p class="sub">${esc(t("no_whales"))}</p>`}
      <p class="sub">${esc(t("pulse_note"))}</p>`;
  }
  async function enterChart() {
    if (S.chartKind === "stock") await ensureStocks();
    if (A.P && !A.all) A.P.allTickers().then(x => { A.all = x; A.allAt = Date.now(); fillSymSelect(); }).catch(() => { /* */ });
    ensureStocks().then(fillSymSelect);
    if (!A.chartBuilt) buildChartView(); else fillSymSelect();
    if (!A.c) initChart();
    if (A.P) loadChart();
  }
  function leaveChart() { stopChartStream(); }

  /* ---------- Новини ---------- */
  async function renderNews() {
    const el = $("#v-news");
    const paint = () => {
      const liquid = (A.all || []).filter(x => x.qv >= (A.mode === "live" ? 5e6 : 0) && isFinite(x.chg));
      const sorted = liquid.slice().sort((p, q) => q.chg - p.chg);
      const gain = sorted.filter(x => x.chg > 0).slice(0, 6), lose = sorted.filter(x => x.chg < 0).slice(-6).reverse();
      const mrow = x => `<li data-open="${esc(x.symbol)}" tabindex="0" role="button">${coinIco(x.symbol)}<span class="nm">${esc(nameOf(x.symbol))} <small class="mono" style="color:var(--faint)">${esc(D.base(x.symbol))}</small></span><span class="px">${fmtPx(x.price)}</span><span class="ch ${x.chg >= 0 ? "up" : "down"}">${fmtPct(x.chg)}</span></li>`;
      const lang = I.getLang();
      const items = (A.news && Array.isArray(A.news.items) ? A.news.items : []).filter(n => S.newsAll || n.lang === lang).slice(0, 40);
      const safeUrl = u => (/^https?:\/\//i.test(u || "") ? u : "#");
      const memeMoves = (A.all || []).filter(x => MEMES.includes(x.symbol)).sort((p, q) => Math.abs(q.chg) - Math.abs(p.chg)).slice(0, 6);
      el.innerHTML = `
        <div class="view-h"><div><h1>${esc(t("news_title"))}</h1><p>${esc(t("news_x_note"))}</p></div></div>
        <div class="section-h" style="margin-top:0"><h2>${esc(t("movers_title"))}</h2><span class="eyebrow">${esc(A.mode === "live" ? "Binance" : t("demo"))}</span></div>
        <div class="movers">
          <div class="panel"><h3 style="color:var(--good)">▲ ${esc(t("gainers"))}</h3>${gain.length ? `<ul class="mlist">${gain.map(mrow).join("")}</ul>` : `<div class="ghost-lines"><div></div><div></div><div></div></div>`}</div>
          <div class="panel"><h3 style="color:var(--bad)">▼ ${esc(t("losers"))}</h3>${lose.length ? `<ul class="mlist">${lose.map(mrow).join("")}</ul>` : `<div class="ghost-lines"><div></div><div></div><div></div></div>`}</div>
        </div>
        ${memeMoves.length ? `<div class="section-h"><h2>${esc(t("memes_scanner"))}</h2><a class="eyebrow" href="#memes">${esc(t("nav_memes"))} →</a></div><div class="panel"><ul class="mlist meme-scan">${memeMoves.map(mrow).join("")}</ul></div>` : ""}
        <div class="section-h"><h2>${esc(t("news_feed"))}</h2><span class="spacer"></span>
          <div class="seg" role="group"><button type="button" data-news="mine" aria-pressed="${!S.newsAll}">${esc(t("news_lang_mine"))}</button><button type="button" data-news="all" aria-pressed="${S.newsAll}">${esc(t("news_lang_all"))}</button></div></div>
        ${items.length ? `<ul class="news ${takeAnim()}">${items.map((n, i) => `<li style="--i:${Math.min(i, 14)}">
            <div class="meta"><b>${esc(n.source)}</b><span>${esc(ago((+n.ts || 0) * 1000))}</span>${(n.coins || []).slice(0, 4).map(c => `<span class="tag">${esc(c)}</span>`).join("")}${n.dir === "up" ? '<span class="tag up">▲</span>' : n.dir === "down" ? '<span class="tag down">▼</span>' : ""}</div>
            <a class="title" href="${esc(safeUrl(n.link))}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>
            ${n.summary ? `<p>${esc(n.summary)}</p>` : ""}</li>`).join("")}</ul>`
          : `<div class="empty">${esc(t("news_empty"))}<div class="ghost-lines" aria-hidden="true"><div style="width:86%"></div><div style="width:64%"></div><div style="width:75%"></div></div></div>`}`;
    };
    paint();
    if (A.P && (!A.all || Date.now() - A.allAt > 120000)) {
      try { A.all = await A.P.allTickers(); A.allAt = Date.now(); } catch (e) { /* залишаємо як є */ }
      if (A.view === "news") paint();
    }
  }

  /* ---------- P2P ---------- */
  function renderP2P() {
    const p = S.p2p;
    const fld = (id, label, val, step) => `<label class="field" for="${id}">${esc(label)}<input id="${id}" type="number" inputmode="decimal" step="${step}" min="0" value="${esc(val)}" data-p2p="${id.slice(4)}"></label>`;
    $("#v-p2p").innerHTML = `
      <div class="view-h"><div><h1>${esc(t("p2p_title"))}</h1><p>${esc(t("p2p_intro"))}</p></div></div>
      <div class="p2p">
        <section class="panel">
          <div class="form">
            ${fld("p2p-buy", t("p2p_buy"), p.buy, "0.01")}${fld("p2p-sell", t("p2p_sell"), p.sell, "0.01")}
            ${fld("p2p-amount", t("p2p_amount"), p.amount, "100")}${fld("p2p-fee", t("p2p_fee"), p.fee, "0.01")}
            ${fld("p2p-bank", t("p2p_bank"), p.bank, "0.1")}
          </div>
          <div class="result" id="p2p-res" aria-live="polite"></div>
          <p class="sub">${esc(t("p2p_rates_note"))}</p>
        </section>
        <section class="panel">
          <h3>${esc(t("p2p_safety"))}</h3>
          <ul class="checks">${t("p2p_rules").map(r => `<li>${esc(r)}</li>`).join("")}</ul>
          <div class="eyebrow" style="margin-top:16px">${esc(t("p2p_links"))}</div>
          <div class="links"><a class="btn" href="https://p2p.binance.com/" target="_blank" rel="noopener noreferrer">Binance P2P</a><a class="btn" href="https://www.bybit.com/fiat/trade/otc/" target="_blank" rel="noopener noreferrer">Bybit P2P</a><a class="btn" href="https://www.okx.com/p2p-markets" target="_blank" rel="noopener noreferrer">OKX P2P</a></div>
        </section>
      </div>`;
    calcP2P();
  }
  function calcP2P() {
    const p = S.p2p, el = $("#p2p-res");
    if (!el) return;
    const buy = +p.buy, sell = +p.sell, amt = +p.amount, fee = (+p.fee || 0) / 100, bank = (+p.bank || 0) / 100;
    if (!(buy > 0 && sell > 0 && amt > 0)) { el.innerHTML = ""; return; }
    const usdt = amt / buy * (1 - fee);
    const out = usdt * sell * (1 - fee) * (1 - bank);
    const profit = out - amt, margin = profit / amt * 100;
    const be = buy / ((1 - fee) * (1 - fee) * (1 - bank));
    el.innerHTML = `<div><span>${esc(t("p2p_profit"))}</span><b class="${profit >= 0 ? "up" : "down"}">${profit >= 0 ? "+" : "−"}${fmtNum(Math.abs(profit), 2)} ₴</b></div>
      <div><span>${esc(t("p2p_margin"))}</span><b class="${margin >= 0 ? "up" : "down"}">${fmtPct(margin)}</b></div>
      <div><span>${esc(t("p2p_usdt"))}</span><b>${fmtNum(usdt, 2)}</b></div>
      <div><span>${esc(t("p2p_breakeven"))}</span><b>${fmtNum(be, 2)} ₴</b></div>`;
  }

  /* ---------- Школа ---------- */
  function renderLearn() {
    $("#v-learn").innerHTML = `<div class="view-h"><div><h1>${esc(t("learn_title"))}</h1><p>${esc(t("learn_intro"))}</p></div></div>
      <div class="learn ${takeAnim()}">${t("learn").map(([h, body], i) => `<details ${i === 0 ? "open" : ""} style="--i:${i}"><summary><span class="n">${String(i + 1).padStart(2, "0")}</span>${esc(h)}</summary><div class="body">${body}</div></details>`).join("")}</div>
      <p class="note">${esc(t("disclaimer"))}</p>`;
  }

  /* ---------- Підключення ---------- */
  async function renderConnect() {
    const el = $("#v-connect");
    await ensureStocks();
    if (A.view !== "connect") return;
    const info = A.P && A.P.info ? A.P.info() : {};
    const live = A.mode === "live", host = h => (info.rest || "").includes(h) || (info.ws || "").includes(h);
    const news = A.news && Array.isArray(A.news.items) ? A.news : null;
    const srcs = news ? [...new Set(news.items.map(n => n.source))] : ["Incrypted", "ForkLog", "Cointelegraph", "CoinDesk", "Decrypt"];
    const sd = A.stocksDoc;
    const rows = [
      ["Binance", "api.binance.com", "c_binance", live && host("binance.com") ? "on" : live ? "backup" : A.offline ? "off" : "demo"],
      ["Binance Data", "data-api.binance.vision", "c_binance_data", live && host("binance.vision") ? "on" : live ? "backup" : "demo"],
      ["Binance.US", "api.binance.us", "c_binance_us", live && host("binance.us") ? "on" : live ? "backup" : "demo"],
      ["alternative.me", "api.alternative.me", "c_fng", A.fng && !A.fng.demo ? "on" : A.fng ? "demo" : "off"],
      ["Yahoo Finance", "finance.yahoo.com", "c_yahoo", sd && !sd.demo ? "on" : "wait", sd && !sd.demo ? t("c_stocks_n", { n: sd.stocks.length, d: fmtDate(sd.session || "") }) : ""],
      [srcs.slice(0, 3).join(" · ") + (srcs.length > 3 ? " +" + (srcs.length - 3) : ""), "RSS", "c_news", news ? "on" : "wait", news ? t("c_items", { n: news.items.length }) + (news.updated ? " · " + t("c_updated", { t: ago(Date.parse(news.updated)) }) : "") : ""],
      ["Telegram", "api.telegram.org", "c_telegram", "bot"],
      ["Alpaca", "alpaca.markets", "c_alpaca", "soon"],
      ["TradingView", "tradingview.com", "c_tv", "link"],
      ["GitHub", "github.com", "c_github", window.TR_PWA ? "on" : "bot"],
    ];
    const ST = { on: "good", backup: "faint", off: "bad", demo: "warn", wait: "warn", bot: "accent", soon: "faint", link: "accent" };
    el.innerHTML = `<div class="view-h"><div><h1>${esc(t("connect_title"))}</h1><p>${esc(t("connect_sub"))}</p></div></div>
      <div class="conn ${takeAnim()}">${rows.map(([name, dom, desc, st, extra], i) => `<article class="conn-i" style="--i:${i}" data-st="${st}">
        ${icoTxt(name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "RS", name)}
        <div class="conn-t"><b>${esc(name)}</b><small class="mono">${esc(dom)}</small><p>${esc(t(desc))}${extra ? `<br><span class="mono">${esc(extra)}</span>` : ""}</p></div>
        <span class="st" style="--c:var(--${ST[st]})"><i></i>${esc(t("st_" + st))}</span></article>`).join("")}</div>
      <p class="note">${esc(t("c_x"))}</p>`;
  }

  /* ---------- Ще ---------- */
  function renderMore() {
    $("#v-more").innerHTML = `<div class="view-h"><div><h1>${esc(t("more_title"))}</h1></div></div>
      <div class="more ${takeAnim()}">${[["p2p", "more_p2p_d"], ["learn", "more_learn_d"], ["prefs", "more_prefs_d"], ["connect", "more_connect_d"]].map(([v, dsc], i) =>
        `<a class="more-i" href="#${v}" style="--i:${i}"><span class="more-ic">${IC[v]}</span><span class="more-t"><b>${esc(navLabel(v))}</b><small>${esc(t(dsc))}</small></span>${IC.arrow}</a>`).join("")}</div>`;
  }

  /* ---------- Налаштування ---------- */
  function renderPrefs() {
    const seg = (name, opts, cur) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${name}" data-val="${v}" aria-pressed="${String(cur) === String(v)}">${esc(l)}</button>`).join("")}</div>`;
    const ACC = { teal: "#14b8a6", blue: "#3b82f6", violet: "#8b5cf6", amber: "#f97316" };
    const assets = S.watch.map((s, i) => `<li>${coinIco(s)}<span class="nm">${esc(nameOf(s))}<small>${esc(D.base(s))}</small></span>
      <button class="mini" type="button" data-move="${i}" data-dir="-1" aria-label="${esc(t("up"))}" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="mini" type="button" data-move="${i}" data-dir="1" aria-label="${esc(t("down"))}" ${i === S.watch.length - 1 ? "disabled" : ""}>↓</button>
      <button class="mini del" type="button" data-rm="${s}" data-kind="market" aria-label="${esc(t("remove"))} ${esc(D.base(s))}">×</button></li>`).join("");
    const num = (id, key, step) => `<label class="field" for="${id}">${esc(t(id.replace("pf-", "pref_")))}<input id="${id}" type="number" min="0" step="${step}" value="${esc(S[key])}" data-num="${key}"></label>`;
    const hiddenCount = S.memeHidden.length + S.stockHidden.length;
    $("#v-prefs").innerHTML = `
      <div class="view-h"><div><h1>${esc(t("prefs_title"))}</h1></div></div>
      <div class="prefs">
        <section class="panel">
          <div class="pref"><span class="lbl">${esc(t("pref_lang"))}</span>${seg("lang", [["uk", "Українська"], ["en", "English"], ["ru", "Русский"]], S.lang)}</div>
          <div class="pref"><span class="lbl">${esc(t("pref_theme"))}</span>${seg("theme", [["system", t("theme_system")], ["dark", t("theme_dark")], ["light", t("theme_light")]], S.theme)}</div>
          <div class="pref"><span class="lbl">${esc(t("pref_accent"))}</span><div class="swatches">${Object.entries(ACC).map(([k, c]) => `<button class="swatch" type="button" data-set="accent" data-val="${k}" aria-pressed="${S.accent === k}" aria-label="${k}" style="background:${c}"></button>`).join("")}</div></div>
          <div class="pref"><span class="lbl">${esc(t("pref_density"))}</span>${seg("density", [["cozy", t("density_cozy")], ["compact", t("density_compact")]], S.density)}</div>
          <div class="pref"><span class="lbl">${esc(t("pref_tf"))}</span>${seg("tf", TFS.map(x => [x, tfl(x)]), S.tf)}</div>
          <div class="pref"><span class="lbl">${esc(t("pref_chart"))}</span><div class="toggles">${["ema", "volume", "rsi", "markers"].map(k => `<label class="toggle"><input type="checkbox" data-indset="${k}" ${S.ind[k] ? "checked" : ""}>${esc(t("ind_" + k))}</label>`).join("")}</div></div>
          <div class="pref"><span class="lbl">${esc(t("pref_money"))}</span><div class="form">${num("pf-deposit", "deposit", "100")}${num("pf-risk", "risk", "0.1")}${num("pf-whale", "whale", "10000")}</div></div>
        </section>
        <section class="panel">
          <div class="pref"><span class="lbl">${esc(t("pref_assets"))}</span><p class="hint">${esc(t("pref_assets_hint"))}</p>
            <ul class="assets">${assets || `<li>${esc(t("empty_watchlist"))}</li>`}</ul>
            <div class="row"><button class="btn primary" type="button" data-act="add" data-kind="market">${esc("+ " + t("add"))}</button><button class="btn ghost" type="button" data-act="reset-assets">${esc(t("reset_assets"))}</button>
              ${hiddenCount ? `<button class="btn ghost" type="button" data-act="unhide-all">${esc(t("show_hidden"))} (${hiddenCount})</button>` : ""}</div></div>
          <div class="pref"><span class="lbl">${esc(t("pref_data"))}</span>${seg("data", [["live", t("data_auto")], ["demo", t("data_demo")]], S.data)}
            <span class="status"><i class="dot" style="background:var(--${A.mode === "live" ? "good" : "warn"})"></i>${esc(A.mode === "live" ? t("status_live") : t("status_demo"))} · <a href="#connect">${esc(t("nav_connect"))} →</a></span></div>
          <div class="pref"><span class="lbl">${esc(t("pref_install"))}</span>
            <div class="row"><button class="btn primary" type="button" data-act="install" ${A.installEvt ? "" : "hidden"}>${esc(t("install_btn"))}</button></div><p class="hint">${esc(t("install_hint"))}</p></div>
          <div class="pref"><span class="lbl">${esc(t("pref_tg"))}</span><p class="hint">${esc(t("tg_text"))}</p></div>
          <div class="pref"><button class="btn danger" type="button" data-act="reset-all">${esc(A.resetArmed ? t("reset_confirm") : t("reset_all"))}</button>
            <p class="hint">TrendRadar 1.1 · ${esc(t("disclaimer"))}</p></div>
        </section>
      </div>`;
  }

  /* ---------- Додавання / приховування ---------- */
  async function openAdd(kind) {
    A.addMode = kind || "market";
    const m = $("#modal");
    m.hidden = false;
    $("#add-title").textContent = A.addMode === "chart" ? t("find_asset") : A.addMode === "market" ? t("add_title") : t("show_hidden");
    $("#add-close").setAttribute("aria-label", t("close"));
    const inp = $("#add-q");
    inp.placeholder = A.addMode === "chart" ? t("search_all") : A.addMode === "stocks" ? t("search_stocks") : t("search_ph");
    inp.value = "";
    paintAdd();
    setTimeout(() => inp.focus(), 30);
    if (A.addMode === "chart") ensureStocks().then(() => { if (!m.hidden) paintAdd(); });
    if ((A.addMode === "market" || A.addMode === "chart") && A.P && (!A.all || Date.now() - A.allAt > 120000)) {
      try { A.all = await A.P.allTickers(); A.allAt = Date.now(); } catch (e) { /* */ }
      if (!m.hidden) paintAdd();
    }
  }
  function paintAdd() {
    const q = ($("#add-q").value || "").trim().toUpperCase(), mode = A.addMode;
    let items = [];
    if (mode === "chart") {
      const cr = (A.all || []).slice().sort((p, r) => r.qv - p.qv).filter(x => !q || x.symbol.includes(q) || nameOf(x.symbol).toUpperCase().includes(q)).slice(0, q ? 25 : 15)
        .map(x => ({ sym: "c:" + x.symbol, ico: coinIco(x.symbol), name: nameOf(x.symbol), sub: D.base(x.symbol) + " · " + t("kind_crypto"), right: fmtPct(x.chg), up: x.chg >= 0 }));
      const st = (A.stocksDoc ? A.stocksDoc.stocks : []).filter(x => !q || x.symbol.includes(q) || x.name.toUpperCase().includes(q) || sName(x).toUpperCase().includes(q)).slice(0, q ? 25 : 15)
        .map(x => ({ sym: "s:" + x.symbol, ico: icoTxt(x.symbol.replace(".", ""), x.symbol.replace(".", "")), name: sName(x), sub: x.symbol + " · " + t(x.sector === "etf" ? "kind_etf" : "kind_stock"), right: fmtPct(+x.chg), up: x.chg >= 0 }));
      items = q ? [...cr, ...st].sort((p, r) => (r.name.toUpperCase().startsWith(q) || r.sub.startsWith(q)) - (p.name.toUpperCase().startsWith(q) || p.sub.startsWith(q))) : [...cr, ...st];
    } else if (mode === "market") {
      items = (A.all || []).slice().sort((p, r) => r.qv - p.qv).filter(x => !q || x.symbol.includes(q) || nameOf(x.symbol).toUpperCase().includes(q)).slice(0, 40)
        .map(x => ({ sym: x.symbol, ico: coinIco(x.symbol), name: nameOf(x.symbol), sub: D.base(x.symbol), right: S.watch.includes(x.symbol) ? "✓" : fmtPct(x.chg), up: x.chg >= 0 }));
    } else if (mode === "memes") {
      items = S.memeHidden.filter(s => !q || s.includes(q) || nameOf(s).toUpperCase().includes(q)).map(s => ({ sym: s, ico: coinIco(s), name: nameOf(s), sub: D.base(s), right: "+", up: true }));
    } else {
      items = S.stockHidden.map(stockBy).filter(Boolean).filter(x => !q || x.symbol.includes(q) || x.name.toUpperCase().includes(q))
        .map(x => ({ sym: x.symbol, ico: icoTxt(x.symbol.replace(".", ""), x.symbol.replace(".", "")), name: x.name, sub: x.symbol, right: "+", up: true }));
    }
    $("#add-res").innerHTML = items.length ? items.map(x => `<li><button type="button" data-addsym="${esc(x.sym)}">${x.ico}<span class="nm">${esc(x.name)}<small>${esc(x.sub)}</small></span><span class="ch ${x.up ? "up" : "down"}">${esc(x.right)}</span></button></li>`).join("")
      : `<li class="note" style="padding:12px">${esc((mode === "market" || mode === "chart") && !A.all ? t("loading") : t("no_results"))}</li>`;
  }
  function closeAdd() { $("#modal").hidden = true; }
  async function addSymbol(sym) {
    const mode = A.addMode;
    if (mode === "chart") { closeAdd(); if (sym.startsWith("s:")) openStock(sym.slice(2)); else openChart(sym.slice(2)); return; }
    if (mode === "memes") { S.memeHidden = S.memeHidden.filter(x => x !== sym); save(); toast(t("added", { s: D.base(sym) })); paintAdd(); refreshList("memes"); startTickerStream(); return; }
    if (mode === "stocks") { S.stockHidden = S.stockHidden.filter(x => x !== sym); save(); toast(t("added", { s: sym })); paintAdd(); if (A.view === "stocks") renderStocks(); return; }
    if (S.watch.includes(sym)) { toast(t("already", { s: D.base(sym) })); return; }
    S.watch.push(sym); save();
    toast(t("added", { s: D.base(sym) }));
    paintAdd();
    startTickerStream();
    if (A.view === "market") renderCrypto("market");
    if (A.view === "prefs") renderPrefs();
    try { A.an.set(sym + "|" + S.tf, await analyze(sym, S.tf)); } catch (e) { A.an.set(sym + "|" + S.tf, { sym, tf: S.tf, error: true }); }
    if (A.view === "market") renderCrypto("market");
  }
  function removeSymbol(sym, kind) {
    if (kind === "memes") { if (!S.memeHidden.includes(sym)) S.memeHidden.push(sym); }
    else if (kind === "stocks") { if (!S.stockHidden.includes(sym)) S.stockHidden.push(sym); }
    else S.watch = S.watch.filter(x => x !== sym);
    save();
    toast(t("removed", { s: kind === "stocks" ? sym : D.base(sym) }));
    startTickerStream();
    rerenderView();
  }

  /* ---------- Маршрути ---------- */
  function rerenderView() {
    const v = A.view;
    if (v === "market" || v === "memes") renderCrypto(v);
    else if (v === "stocks") renderStocks();
    else if (v === "prefs") renderPrefs();
  }
  function route() {
    let v = (location.hash || "").replace(/^#/, "");
    if (!VIEWS.includes(v)) v = "market";
    const changed = v !== A.view;
    if (A.view === "chart" && v !== "chart") leaveChart();
    if (changed) { A.edit = false; A.anim = true; }
    A.view = v;
    VIEWS.forEach(n => {
      const sec = $("#v-" + n);
      sec.hidden = n !== v;
      if (n === v && changed) { sec.classList.remove("enter"); void sec.offsetWidth; sec.classList.add("enter"); }
    });
    markNav();
    if (v === "market") { renderCrypto("market"); if (!A.an.size && A.P) refreshList("market"); }
    else if (v === "memes") {
      const first = !A.memesSeen;
      A.memesSeen = true;
      renderCrypto("memes");
      if (A.P && (first || !memeList().some(s => A.an.has(s + "|" + S.tf)))) refreshList("memes").then(startTickerStream);
    }
    else if (v === "stocks") renderStocks();
    else if (v === "chart") enterChart();
    else if (v === "news") renderNews();
    else if (v === "p2p") renderP2P();
    else if (v === "learn") renderLearn();
    else if (v === "prefs") renderPrefs();
    else if (v === "connect") renderConnect();
    else if (v === "more") renderMore();
    if (changed) window.scrollTo(0, 0);
  }
  function openChart(sym) {
    S.chartKind = "crypto"; S.chartSym = sym; S.chartTf = S.tf; save();
    if (A.chartBuilt) { fillSymSelect(); $$("#c-tf [data-tf]").forEach(b => b.setAttribute("aria-pressed", b.dataset.tf === S.chartTf)); }
    startTickerStream();
    if (location.hash === "#chart") enterChart(); else location.hash = "#chart";
  }
  function openStock(sym) {
    S.chartKind = "stock"; S.chartStock = sym; save();
    if (location.hash === "#chart") enterChart(); else location.hash = "#chart";
  }
  function rerenderAll() {
    renderShell();
    if (A.chartBuilt) { destroyChart(); A.chartBuilt = false; }
    A.view = "";
    route();
  }

  /* ---------- Події ---------- */
  function bind() {
    document.addEventListener("click", e => {
      const el = e.target.closest("button, [data-open], [data-stock], a[data-nav]");
      if (!el) return;
      const d = el.dataset;
      if (d.rm) { e.stopPropagation(); removeSymbol(d.rm, d.kind); return; }
      if (d.open && !A.edit) { openChart(d.open); return; }
      if (d.stock && !A.edit) { openStock(d.stock); return; }
      if (d.act === "add") { openAdd(d.kind || "market"); return; }
      if (d.act === "find") { openAdd("chart"); return; }
      if (d.act === "edit") { A.edit = !A.edit; rerenderView(); return; }
      if (d.act === "anim") return;
      if (d.act === "refresh") { refreshList(currentListKind() || "market"); toast(t("loading")); return; }
      if (d.act === "retry") { connect(); return; }
      if (d.act === "hide-banner") { A.bannerHidden = true; try { sessionStorage.setItem("trendradar.banner", "hidden"); } catch (x) { /* */ } updateModeUI(); return; }
      if (d.act === "install") { doInstall(); return; }
      if (d.act === "reset-assets") { S.watch = DEFAULT_WATCH.slice(); save(); startTickerStream(); refreshList("market"); renderPrefs(); toast(t("saved")); return; }
      if (d.act === "unhide-all") { S.memeHidden = []; S.stockHidden = []; save(); renderPrefs(); toast(t("saved")); return; }
      if (d.act === "reset-all") {
        if (!A.resetArmed) { A.resetArmed = true; renderPrefs(); setTimeout(() => { A.resetArmed = false; if (A.view === "prefs") renderPrefs(); }, 4000); return; }
        A.resetArmed = false; S = JSON.parse(JSON.stringify(DEFAULTS)); save(); rerenderAll(); connect(); toast(t("saved")); return;
      }
      if (d.filter) { S.filter = d.filter; save(); renderCrypto("market"); return; }
      if (d.mfilter) { S.memeFilter = d.mfilter; save(); renderCrypto("memes"); return; }
      if (d.sfilter) { S.stockFilter = d.sfilter; save(); renderStocks(); return; }
      if (d.tf && el.closest("#m-tf")) { S.tf = d.tf; save(); rerenderView(); refreshList(currentListKind() || "market"); return; }
      if (d.tf && el.closest("#c-tf")) { S.chartTf = d.tf; save(); $$("#c-tf [data-tf]").forEach(b => b.setAttribute("aria-pressed", b.dataset.tf === d.tf)); loadChart(); return; }
      if (d.ind) { S.ind[d.ind] = !S.ind[d.ind]; save(); el.setAttribute("aria-pressed", S.ind[d.ind]); applyIndicatorVisibility(); return; }
      if (d.news) { S.newsAll = d.news === "all"; save(); renderNews(); return; }
      if (d.addsym) { addSymbol(d.addsym); return; }
      if (d.move !== undefined) {
        const i = +d.move, j = i + +d.dir;
        if (j < 0 || j >= S.watch.length) return;
        [S.watch[i], S.watch[j]] = [S.watch[j], S.watch[i]]; save(); renderPrefs(); return;
      }
      if (d.set) {
        const k = d.set, v = d.val;
        S[k] = v; save();
        if (k === "lang") rerenderAll();
        else if (k === "theme" || k === "accent") { applyTheme(); renderPrefs(); }
        else if (k === "data") { renderPrefs(); connect().then(() => { if (A.view === "prefs") renderPrefs(); }); }
        else if (k === "tf") { renderPrefs(); refreshList("market"); }
        else renderPrefs();
        toast(t("saved"));
        return;
      }
      if (el.id === "theme-btn") { S.theme = { system: "dark", dark: "light", light: "system" }[S.theme] || "system"; save(); applyTheme(); if (A.view === "prefs") renderPrefs(); return; }
      if (el.id === "mode") { location.hash = "#connect"; return; }
      if (el.id === "install-top") { doInstall(); return; }
      if (el.id === "add-close") { closeAdd(); return; }
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !$("#modal").hidden) closeAdd();
      if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-open][tabindex], [data-stock][tabindex]")) {
        e.preventDefault();
        if (A.edit) return;
        if (e.target.dataset.open) openChart(e.target.dataset.open); else openStock(e.target.dataset.stock);
      }
    });
    $("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeAdd(); });
    $("#add-q").addEventListener("input", paintAdd);
    document.addEventListener("change", e => {
      const el = e.target;
      if (el.id === "m-sort") { S.sort = el.value; save(); renderCrypto("market"); }
      else if (el.id === "mm-sort") { S.memeSort = el.value; save(); renderCrypto("memes"); }
      else if (el.id === "s-sort") { S.stockSort = el.value; save(); renderStocks(); }
      else if (el.id === "s-sector") { S.stockSector = el.value; save(); renderStocks(); }
      else if (el.id === "c-sym") {
        const k = el.value.slice(0, 1), sym = el.value.slice(2);
        if (k === "s") { S.chartKind = "stock"; S.chartStock = sym; } else { S.chartKind = "crypto"; S.chartSym = sym; startTickerStream(); }
        save(); loadChart();
      }
      else if (el.dataset.indset) { S.ind[el.dataset.indset] = el.checked; save(); applyIndicatorVisibility(); toast(t("saved")); }
      else if (el.dataset.num) {
        const k = el.dataset.num, v = parseFloat(el.value);
        if (isFinite(v) && v > 0) { S[k] = k === "risk" ? Math.min(100, v) : v; save(); toast(t("saved")); }
      }
    });
    document.addEventListener("input", e => {
      const el = e.target;
      if (el.dataset.p2p) { S.p2p[el.dataset.p2p] = el.value; save(); calcP2P(); }
      if (el.id === "s-q") {
        A.stockQ = el.value;
        clearTimeout(A.qTimer);
        A.qTimer = setTimeout(() => {
          const pos = el.selectionStart;
          renderStocks().then(() => { const n = $("#s-q"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) { /* */ } } });
        }, 160);
      }
    });
    window.addEventListener("hashchange", () => {
      if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        try { document.startViewTransition(() => route()); } catch (e) { route(); }
      } else route();
    });
    const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    if (mq && mq.addEventListener) mq.addEventListener("change", () => { if (S.theme === "system" && A.c) rebuildChart(); });
    window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); A.installEvt = e; $("#install-top").hidden = false; if (A.view === "prefs") renderPrefs(); });
    window.addEventListener("appinstalled", () => { A.installEvt = null; $("#install-top").hidden = true; });
  }
  async function doInstall() {
    if (!A.installEvt) { toast(t("install_hint")); return; }
    A.installEvt.prompt();
    try { await A.installEvt.userChoice; } catch (e) { /* */ }
    A.installEvt = null;
    $("#install-top").hidden = true;
    if (A.view === "prefs") renderPrefs();
  }

  async function loadSiteData() {
    A.news = await D.loadSiteJSON("data/news.json");
    if (A.view === "news") renderNews();
    if (A.view === "connect") renderConnect();
  }

  function init() {
    bind();
    A.view = "";
    renderShell();
    route();
    connect();
    loadSiteData();
    ensureStocks();
    setInterval(loadSiteData, 10 * 60000);
    if (window.TR_PWA && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { /* без офлайн-режиму */ });
  }
  window.TRApp = { state: () => S, runtime: () => A };
  init();
})();
