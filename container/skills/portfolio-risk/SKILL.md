---
name: portfolio-risk
description: Concentration and stress test of Chip's actual holdings — delta-adjusted exposure by name, sector and sleeve against his caps, and what market, sector or single-name moves would do, with options repriced properly. Use for any "how exposed am I / what if X drops / is this too concentrated" question, before recommending trades, and in the weekly review.
---

# Portfolio risk

```bash
python3 /app/skills/portfolio-risk/risk.py --sector-cap semis=25          # standard report
python3 /app/skills/portfolio-risk/risk.py --shock NVDA=-25 --shock market=-5   # a specific what-if
python3 /app/skills/portfolio-risk/risk.py --shock sector:semis=-20
```

It values `portfolio/holdings.csv` with market-data, then reports:

- **Concentration, delta-adjusted** — per underlying, per sector, per sleeve, flagged against the single-name cap (default 10%, core index funds exempt) and any `--sector-cap`. Total exposure above 100% means the options add leverage.
- **Scenarios** — default: market −20% and +15% (each name moved by its 1-year beta to SPY), semis −30% with everything else flat, and the largest name −40%. Options are repriced with Black-Scholes at their current implied volatility, so a big move in far out-of-the-money calls is not underestimated the way delta alone would.

Sectors and sleeves come from `portfolio/classification.csv` (`ticker,sleeve,sector`). The report lists unclassified tickers; ask Chip or look the fund up, then add them. Use sleeves from `targets.md` (`core-us`, `core-intl`, `bonds`, `satellite`, `speculation`). For an ETF with a large hidden concentration (EWY is heavily Samsung and SK hynix), say so in the write-up; the script only knows the one sector you give it.

## Reading it for Chip

- Lead with the one or two numbers that matter (for example "semis are 82% of your exposure against a 25% cap; a 30% semis drawdown costs about $183k"), then the detail if asked.
- Compare with `targets.md` and say which caps are breached and by how much.
- Betas are backward-looking, from a single year; correlations rise in selloffs, so the market scenario is a floor, not a worst case.
- Caps from `targets.md`: single stock 10%, semis about 25% excluding index funds — check the file each time, Chip may change them. Ask whether SMH counts toward the semis cap if it matters for the conclusion.
- Prices are delayed; holdings are as of the file date printed on the first line. If holdings are stale, say so before drawing conclusions.
