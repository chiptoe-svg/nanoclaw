"""Portfolio concentration and stress test for Chip's holdings.

    python3 /app/skills/portfolio-risk/risk.py [--single-cap 10] [--sector-cap semis=25]
                                               [--shock NVDA=-25] [--shock sector:semis=-20] [--shock market=-15]

Prices come from `md.ts positions --json` (delayed Cboe/Yahoo quotes, options
at mid). Concentration uses delta-adjusted exposure. Scenarios reprice every
option with Black-Scholes at its current implied volatility, so far
out-of-the-money calls are not linearised. Betas are 1-year daily betas to SPY,
cached for a day in portfolio/.beta-cache.json.
"""

import argparse
import csv
import json
import math
import os
import subprocess
import sys
import time
from datetime import date

import numpy as np
from scipy.stats import norm

MD = "/app/skills/market-data/md.ts"
PORTFOLIO = "/workspace/agent/portfolio"
CLASSIFICATION = os.path.join(PORTFOLIO, "classification.csv")
BETA_CACHE = os.path.join(PORTFOLIO, ".beta-cache.json")


def md(*args):
    out = subprocess.run(["bun", MD, *args], capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        sys.exit(f"market-data failed: {out.stderr.strip()}")
    return out.stdout


def closes(sym):
    rows = md("history", sym, "1y", "1d").splitlines()
    i = rows.index("date,close")
    return {d: float(c) for d, c in (r.split(",") for r in rows[i + 1 :])}


def betas(symbols):
    cache = {}
    if os.path.exists(BETA_CACHE):
        with open(BETA_CACHE) as f:
            cache = json.load(f)
        if time.time() - cache.get("_at", 0) > 86400:
            cache = {}
    missing = [s for s in symbols if s not in cache]
    if missing:
        spy = closes("SPY")
        for s in missing:
            try:
                px = closes(s)
                days = sorted(set(px) & set(spy))
                a = np.diff(np.log([px[d] for d in days]))
                m = np.diff(np.log([spy[d] for d in days]))
                cache[s] = float(np.cov(a, m)[0, 1] / np.var(m, ddof=1)) if len(days) > 60 else 1.0
            except SystemExit:
                cache[s] = 1.0
        cache["_at"] = time.time()
        with open(BETA_CACHE, "w") as f:
            json.dump(cache, f)
    return {s: cache[s] for s in symbols}


def bs(spot, strike, years, iv, rate, kind):
    if years <= 0 or iv <= 0:
        return max(0.0, spot - strike) if kind == "C" else max(0.0, strike - spot)
    d1 = (math.log(spot / strike) + (rate + iv * iv / 2) * years) / (iv * math.sqrt(years))
    d2 = d1 - iv * math.sqrt(years)
    if kind == "C":
        return spot * norm.cdf(d1) - strike * math.exp(-rate * years) * norm.cdf(d2)
    return strike * math.exp(-rate * years) * norm.cdf(-d2) - spot * norm.cdf(-d1)


def load_classification():
    table = {}
    if os.path.exists(CLASSIFICATION):
        with open(CLASSIFICATION) as f:
            for row in csv.DictReader(f):
                table[row["ticker"].strip().upper()] = {
                    "sleeve": row.get("sleeve", "").strip() or "unclassified",
                    "sector": row.get("sector", "").strip() or "unclassified",
                }
    return table


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--single-cap", type=float, default=10.0, help="max %% in one underlying (delta-adjusted)")
    ap.add_argument("--sector-cap", action="append", default=[], help="sector=pct, e.g. semis=25")
    ap.add_argument("--shock", action="append", default=[], help="TICKER=pct, sector:NAME=pct, or market=pct")
    args = ap.parse_args()

    data = json.loads(md("positions", "--json").strip().splitlines()[-1])
    total = data["total"]
    spots = data["spots"]
    positions = [p for p in data["positions"] if p["underlying"] != "CASH"]
    cash = sum(p["value"] for p in data["positions"] if p["underlying"] == "CASH")
    cls = load_classification()
    underlyings = sorted({p["underlying"] for p in positions})
    unclassified = [u for u in underlyings if u not in cls]
    sector = {u: cls.get(u, {}).get("sector", "unclassified") for u in underlyings}
    sleeve = {u: cls.get(u, {}).get("sleeve", "unclassified") for u in underlyings}

    tnx = 4.5
    try:
        tnx = float(md("quote", "^TNX").split()[1])
    except Exception:
        pass
    rate = tnx / 100

    print(f"Holdings file {data['holdingsDate']}, priced {data['pricedAt'][:16]}Z (delayed). Total {total:,.0f} incl. cash {cash:,.0f}.")
    if unclassified:
        print(f"Unclassified (add to portfolio/classification.csv): {', '.join(unclassified)}")

    # ── Concentration (delta-adjusted) ──
    delta_dollars = {}
    for p in positions:
        d = p["deltaShares"] * spots.get(p["underlying"], float("nan"))
        if math.isfinite(d):
            delta_dollars[p["underlying"]] = delta_dollars.get(p["underlying"], 0) + d
    caps = {k: float(v) for k, v in (c.split("=") for c in args.sector_cap)}

    gross = sum(delta_dollars.values())
    print(f"\nConcentration, delta-adjusted % of portfolio (total exposure {100 * gross / total:.0f}%; over 100% means option leverage):")
    for u, d in sorted(delta_dollars.items(), key=lambda x: -x[1]):
        flag = "  ← over single-name cap" if 100 * d / total > args.single_cap and not sleeve[u].startswith("core") else ""
        print(f"  {u:<8} {100 * d / total:6.1f}%   {sector[u]:<14} {sleeve[u]}{flag}")
    for label, key in (("sector", sector), ("sleeve", sleeve)):
        agg = {}
        for u, d in delta_dollars.items():
            agg[key[u]] = agg.get(key[u], 0) + d
        print(f"By {label}:")
        for k, d in sorted(agg.items(), key=lambda x: -x[1]):
            cap = caps.get(k) if label == "sector" else None
            flag = f"  ← over {cap:.0f}% cap" if cap is not None and 100 * d / total > cap else ""
            print(f"  {k:<16} {100 * d / total:6.1f}%{flag}")

    # ── Scenarios ──
    beta = betas(underlyings)
    scenarios = []
    if args.shock:
        moves = {}
        for s in args.shock:
            key, pct = s.split("=")
            pct = float(pct) / 100
            if key == "market":
                for u in underlyings:
                    moves[u] = moves.get(u, 0) + beta[u] * pct
            elif key.startswith("sector:"):
                for u in underlyings:
                    if sector[u] == key.split(":", 1)[1]:
                        moves[u] = moves.get(u, 0) + pct
            else:
                moves[key.upper()] = moves.get(key.upper(), 0) + pct
        scenarios.append(("custom: " + " ".join(args.shock), moves))
    else:
        scenarios += [
            ("Market -20% (beta-scaled)", {u: beta[u] * -0.20 for u in underlyings}),
            ("Semis -30%, rest flat", {u: -0.30 for u in underlyings if sector[u] == "semis"}),
            ("Largest name -40%, rest flat", {max(delta_dollars, key=delta_dollars.get): -0.40}),
            ("Market +15% (beta-scaled)", {u: beta[u] * 0.15 for u in underlyings}),
        ]

    today = date.today()
    print(f"\nScenarios (options repriced Black-Scholes at current IV, r={tnx:.2f}%):")
    for name, moves in scenarios:
        pnl_by = {}
        for p in positions:
            u = p["underlying"]
            move = moves.get(u, 0.0)
            spot = spots.get(u)
            if not spot or not math.isfinite(p["value"]):
                continue
            new_spot = spot * (1 + move)
            if p.get("option"):
                o = p["option"]
                years = (date.fromisoformat(o["expiry"]) - today).days / 365
                now = bs(spot, o["strike"], years, o["iv"], rate, o["type"])
                after = bs(new_spot, o["strike"], years, o["iv"], rate, o["type"])
                # Anchor to the market mid so model error doesn't show up as P/L.
                pnl = (after - now) * 100 * p["qty"]
            else:
                pnl = (new_spot - spot) * p["qty"]
            pnl_by[u] = pnl_by.get(u, 0) + pnl
        pnl = sum(pnl_by.values())
        top = ", ".join(f"{u} {v:+,.0f}" for u, v in sorted(pnl_by.items(), key=lambda x: -abs(x[1]))[:3])
        print(f"  {name:<34} {pnl:+12,.0f}  ({100 * pnl / total:+5.1f}%)   biggest: {top}")

    print("\nBetas (1y daily vs SPY; non-US listings like EWY trade on a different clock, so treat theirs loosely): " + ", ".join(f"{u} {beta[u]:.2f}" for u in underlyings))


if __name__ == "__main__":
    main()
