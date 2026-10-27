---
name: my-portfolio
description: Chip's own holdings, accounts, targets, and financial plan. Read this FIRST whenever Chip asks about his investments, portfolio, rebalancing, tax-loss harvesting, retirement or financial planning, or a stock he owns — before using portfolio-rebalance, tax-loss-harvesting, financial-plan, thesis-tracker, catalyst-calendar, earnings-preview, earnings-analysis, or morning-note.
---

# My Portfolio

The finance skills (portfolio-rebalance, tax-loss-harvesting, financial-plan, and the equity-research set) are written for advisors serving clients. Here, the "client" is Chip. This skill tells you where his data lives.

## Files

All under `/workspace/agent/portfolio/` (create the folder and files on first use):

| File | Contents |
|------|----------|
| `holdings.csv` | `account,account_type,ticker,shares,cost_basis_total,acquired_date` — one row per lot. `account_type` is taxable / IRA / Roth / 401k / HSA. |
| `targets.md` | Target allocation by asset class and the rebalancing band. |
| `plan.md` | Goals, ages, income, savings rate, retirement target, assumptions. Output of financial-plan lives here. |
| `theses/<TICKER>.md` | One per position, maintained by thesis-tracker. |
| `trades.md` | Append-only log of trades Chip reports, with date — needed for wash-sale windows. |

## Rules

- **Never invent holdings, cost basis, or balances.** If a file is missing or stale, ask Chip for the numbers (a CSV export from the brokerage or a screenshot is fine) and save them.
- Get current prices via web search; for tickers on the alojoh watchlist, `/app/skills/alojoh/alojoh-query price <TICKER>` has daily history.
- Before suggesting any sale, check `trades.md` for purchases of the same or substantially identical security within 30 days (wash sale).
- Show the math. State the date of the prices used.
- This is analysis for Chip to review, not professional tax or investment advice — say so once when recommending trades, not on every message.
