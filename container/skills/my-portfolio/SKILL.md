---
name: my-portfolio
description: Chip's own holdings, accounts, targets, and financial plan, and how to keep them current. Read this FIRST whenever Chip asks about his investments, portfolio, rebalancing, tax-loss harvesting, retirement or financial planning, or a stock he owns — before using portfolio-risk, trade-decision, portfolio-rebalance, tax-loss-harvesting, financial-plan, thesis-tracker, catalyst-calendar, earnings-preview, earnings-analysis, or morning-note.
---

# My Portfolio

The finance skills (portfolio-rebalance, tax-loss-harvesting, financial-plan, and the equity-research set) are written for advisors serving clients. Here, the "client" is Chip. This skill tells you where his data lives and which tools to use.

## Files

All under `/workspace/agent/portfolio/`:

| File | Contents |
|------|----------|
| `holdings.csv` | `account,account_type,ticker,shares,cost_basis_total,acquired_date` — one row per lot. Options use Schwab's format (`NVDA 03/19/2027 300.00 C`), negative shares for short. `account_type` is taxable / IRA / Roth / 401k / HSA. |
| `classification.csv` | `ticker,sleeve,sector` for portfolio-risk. |
| `targets.md` | Target allocation by sleeve, rebalancing band, single-name and sector caps. |
| `plan.md` | Goals, ages, income, savings rate, retirement target, assumptions (financial-plan output). |
| `theses/<TICKER>.md` | One per position, maintained by thesis-tracker. |
| `trades.md` | Append-only log of trades, with date — needed for wash-sale windows. |
| `decisions.md` | Decision journal (trade-decision). |
| `statements/`, `history/` | Raw Schwab exports and previous versions of holdings.csv. |

## Tools

- **Prices, option quotes, fundamentals:** market-data (`bun /app/skills/market-data/md.ts …`). Not web search.
- **Current value of everything:** `bun /app/skills/market-data/md.ts positions`.
- **Exposure and what-ifs:** portfolio-risk (`python3 /app/skills/portfolio-risk/risk.py`).
- **Any trade decision:** trade-decision (checklist, devil's advocate, journal).
- **Calculations:** Python 3 with pandas, numpy and scipy is installed — use it for projections, Monte Carlo, tax-lot math, anything beyond simple arithmetic. Show the inputs.

## Keeping holdings current

Schwab CSV exports are the source of truth. When Chip sends exports (Positions for each account, and Lot Details for taxable positions with several lots), they arrive under `/workspace/inbox/…`:

1. Preview: `bun /app/skills/my-portfolio/import-schwab.ts <files…>` — shows accounts covered, cash, and quantity changes since the last import.
2. Tell Chip what changed in a line or two (the changes are probably trades), then apply with `--write`. That saves the old file under `history/`, copies the exports to `statements/`, and appends inferred trades to `trades.md` with "?" for price.
3. Ask for the date and price of each inferred trade, fill them in, and log any decision in `decisions.md`.

If `holdings.csv` is more than a week old and the question depends on it (rebalancing, tax lots, exposure), say so and ask for fresh exports: in Schwab, Accounts → Positions → export (the arrow icon) for each account, plus Lot Details for any taxable position with several lots.

## Rules

- **Never invent holdings, cost basis, or balances.** If a file is missing or stale, say so and ask.
- Before suggesting any sale, check `trades.md` for purchases of the same or substantially identical security within 30 days (wash sale).
- Show the math. State the date of the prices used and that they are delayed.
- This is analysis for Chip to review, not professional tax or investment advice — say so once when recommending trades, not on every message.
