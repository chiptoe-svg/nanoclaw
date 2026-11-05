---
name: market-data
description: Free delayed market data — stock/ETF/index quotes, option chains with IV and Greeks, price history with volatility and drawdown, SEC filings and reported financials, and live valuation of Chip's whole portfolio. Use for any price, option, or fundamentals question instead of web search.
---

# Market data

One command-line tool, `bun /app/skills/market-data/md.ts`, with free sources:

| Command | What you get | Source |
|---|---|---|
| `quote NVDA SMH ^VIX ^TNX` | last price, change vs previous close, 30-day IV | Cboe (15-min delayed); indices via Yahoo |
| `chain TSLA --expiry 2027-01-15 --strikes 6 [--type C]` | strikes around spot: bid/ask/mid, IV, delta, theta, vega, open interest, volume; lists other expiries | Cboe delayed |
| `option "NVDA 03/19/2027 300.00 C"` | one contract (Schwab format or OCC symbol) as JSON with Greeks and days to expiry | Cboe delayed |
| `history MU 1y [1d]` | return, annualised volatility, max drawdown, high/low, then date,close rows | Yahoo |
| `positions` | every row of `portfolio/holdings.csv` valued at delayed prices (options at mid), P/L vs cost, and exposure by underlying both at market value and **delta-adjusted** | Cboe + Yahoo |
| `filings NVDA [--forms 10-K,10-Q,8-K,4] [--limit 10]` | recent SEC filings with links (Form 4 = insider trades) | SEC EDGAR |
| `facts NVDA` | reported revenue, net income, diluted EPS, cash flow, capex, cash, share count by period | SEC XBRL |

## Rules

- **Use this, not web search, for prices, option quotes and reported financials.** Web search excerpts are often stale or from the wrong date. Use web search for news, guidance, analyst views and anything qualitative.
- **Say how fresh the number is.** Quotes are 15 minutes delayed during market hours and show the last close outside them; every output carries its timestamp. For a trade decision, tell Chip to check the live quote in his brokerage before placing an order.
- **Options are valued at mid.** Wide bid/ask spreads mean mid can be far from what a market order would get; quote bid and ask when it matters.
- **Delta-adjusted exposure is the honest concentration number.** Out-of-the-money calls can carry far more underlying exposure than their market value suggests; use the delta-adjusted figure for concentration and sector caps.
- `positions` is only as current as `holdings.csv` (its date is printed first). If it is more than a week old or Chip mentions trades since, ask for a fresh export (see my-portfolio).
- `facts` is what companies filed, by calendar period; fiscal years that don't match the calendar are approximate. Analyst estimates are not included — use web search for consensus and say where it came from.
- ETFs and foreign issuers have no SEC financials; `filings`/`facts` will say so.
- No API keys are involved. If a source starts failing, say so and fall back to web search with the date stated.
