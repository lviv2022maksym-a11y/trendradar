"""Картинка графіка для Telegram: свічки, EMA, план угоди, RSI. Темна тема у стилі TradingView."""
from __future__ import annotations

import io

import numpy as np
import pandas as pd

BG, PANEL, GRID, TEXT, MUTED = "#0d1117", "#0d1117", "#1c2330", "#e6edf3", "#7d8590"
GREEN, RED = "#26a69a", "#ef5350"
EMA_COLORS = {"ema20": "#f2c94c", "ema50": "#56a8f5", "ema200": "#b67df2"}
VERDICT_COLORS = {"BUY": "#2ea043", "WAIT": "#d29922", "AVOID": "#f85149"}


def _esc(s: str) -> str:
    return s.replace("$", r"\$")  # щоб matplotlib не сприймав $ як формулу


def _money(x: float) -> str:
    dec = 2 if abs(x) >= 1 else 4 if abs(x) >= 0.01 else 8
    return f"{x:,.{dec}f}".replace(",", " ")


def render_chart(df: pd.DataFrame, title: str, tf_label: str, plan: dict | None = None,
                 verdict: dict | None = None, verdict_label: str = "", labels: dict | None = None,
                 bars: int = 120) -> bytes:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    labels = labels or {"entry": "Entry", "stop": "Stop", "target": "Target"}
    d = df.iloc[-bars:]
    n = len(d)
    x = np.arange(n)
    o, h, l, c = (d[k].to_numpy() for k in ("open", "high", "low", "close"))
    up = c >= o
    col = np.where(up, GREEN, RED)

    fig = plt.figure(figsize=(10, 6.2), dpi=144, facecolor=BG)
    gs = fig.add_gridspec(2, 1, height_ratios=[3.3, 1], hspace=0.05, left=0.02, right=0.9, top=0.88, bottom=0.07)
    ax = fig.add_subplot(gs[0])
    axr = fig.add_subplot(gs[1], sharex=ax)
    for a in (ax, axr):
        a.set_facecolor(PANEL)
        a.grid(color=GRID, linewidth=0.6)
        a.tick_params(colors=MUTED, labelsize=8, length=0)
        a.yaxis.tick_right()
        for sp in a.spines.values():
            sp.set_visible(False)

    lo_all, hi_all = float(np.min(l)), float(np.max(h))
    if plan:
        lo_all, hi_all = min(lo_all, plan["stop"]), max(hi_all, plan["target"])
    min_body = (hi_all - lo_all) * 0.0012
    ax.vlines(x, l, h, color=col, linewidth=0.8)
    ax.bar(x, np.maximum(np.abs(c - o), min_body), bottom=np.minimum(o, c), width=0.64, color=col, linewidth=0)
    for k, colr in EMA_COLORS.items():
        if k in d:
            ax.plot(x, d[k].to_numpy(), color=colr, linewidth=1.1, alpha=0.9, label=k.upper())

    right = n + 14
    if plan:
        for key, price, colr in (("target", plan["target"], GREEN), ("entry", plan["entry"], TEXT), ("stop", plan["stop"], RED)):
            ax.hlines(price, n - 1, right, colors=colr, linestyles="--", linewidth=1.0)
            ax.text(right - 0.3, price, f" {labels[key]}  {_money(price)} ", color=BG, fontsize=7.5, va="center",
                    ha="right", fontweight="bold", bbox=dict(boxstyle="round,pad=0.25", fc=colr, ec="none"))
        ax.fill_between([n - 1, right], plan["entry"], plan["target"], color=GREEN, alpha=0.10, linewidth=0)
        ax.fill_between([n - 1, right], plan["stop"], plan["entry"], color=RED, alpha=0.10, linewidth=0)
    ax.set_xlim(-1, right)
    pad = (hi_all - lo_all) * 0.06
    ax.set_ylim(lo_all - pad, hi_all + pad)
    # Поточна ціна
    ax.axhline(c[-1], color=GREEN if up[-1] else RED, linewidth=0.6, alpha=0.6)
    leg = ax.legend(loc="upper left", fontsize=7.5, frameon=False, labelcolor=MUTED, ncol=3)
    for line in leg.get_lines():
        line.set_linewidth(2)

    r = d["rsi"].to_numpy()
    axr.fill_between(x, 30, 70, color="#7c4dff", alpha=0.07, linewidth=0)
    axr.axhline(70, color=MUTED, linewidth=0.5, linestyle=":")
    axr.axhline(30, color=MUTED, linewidth=0.5, linestyle=":")
    axr.plot(x, r, color="#a371f7", linewidth=1.1)
    axr.set_ylim(0, 100)
    axr.set_yticks([30, 50, 70])
    axr.text(0.005, 0.85, f"RSI 14  {r[-1]:.0f}", transform=axr.transAxes, color=MUTED, fontsize=7.5)

    idx = d.index
    ticks = np.linspace(0, n - 1, 6).astype(int)
    axr.set_xticks(ticks)
    axr.set_xticklabels([idx[i].strftime("%d.%m") for i in ticks])
    plt.setp(ax.get_xticklabels(), visible=False)

    fig.text(0.02, 0.945, _esc(title), color=TEXT, fontsize=14, fontweight="bold", va="center")
    fig.text(0.02, 0.905, _esc(f"{tf_label}  ·  {_money(c[-1])} $"), color=MUTED, fontsize=9.5, va="center")
    if verdict:
        fig.text(0.9, 0.935, _esc(f"  {verdict_label}  {verdict['score']}/100  "), color="white", fontsize=10.5,
                 fontweight="bold", ha="right", va="center",
                 bbox=dict(boxstyle="round,pad=0.45", fc=VERDICT_COLORS[verdict["verdict"]], ec="none"))
    fig.text(0.9, 0.025, "TrendRadar", color="#30363d", fontsize=9, ha="right", fontweight="bold")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=BG)
    plt.close(fig)
    return buf.getvalue()
