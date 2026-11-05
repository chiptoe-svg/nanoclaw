---
name: trade-decision
description: Pre-trade checklist, devil's-advocate review and decision journal for Chip's buy/sell/option decisions. Use whenever Chip is considering a trade or asks "should I buy/sell/trim/roll X", and when reviewing past decisions.
---

# Trade decisions

Good process beats good predictions. For any trade Chip is considering, run the checklist, write the journal entry, and later check the outcome. Keep it short in chat; the detail goes in the journal.

## 1. Pre-trade checklist

Work through these with real numbers (market-data, portfolio-risk, my-portfolio files). Report only the items that matter for this trade, plus any that fail.

1. **Thesis** — one or two sentences: why, why now, what would prove it wrong (`portfolio/theses/<TICKER>.md` if it exists; update it).
2. **Fit with the plan** — effect on `targets.md`: does it move toward or away from the target sleeves and caps? Run `risk.py` with the trade applied mentally, or state the before/after exposure.
3. **Size** — dollars, % of portfolio, delta-adjusted exposure after the trade. For options: max loss, breakeven, days to expiry, IV versus its usual level (`md.ts chain`), and whether the premium is mostly time value.
4. **Account and tax** — which account; taxable lots and short/long-term status (`holdings.csv` acquired dates); wash-sale check against `trades.md` (30 days either side); in IRAs taxes don't matter but losses can't be harvested.
5. **Liquidity and execution** — bid/ask spread, open interest for options; suggest a limit price, never a market order on options.
6. **Exit plan** — target, stop or review trigger, and a date to revisit.

## 2. Devil's advocate

For any trade above **2% of the portfolio**, any new options position, or anything that increases a breached cap: argue the other side in three bullets — the strongest case against, what the market may know that we don't, and what happens to the plan if the thesis is wrong. Then give a plain recommendation: do it, do a smaller version, wait for a stated trigger, or don't.

Be direct when the trade conflicts with Chip's own approved plan; that is the most useful thing you can say. It is his decision.

## 3. Decision journal

Append to `portfolio/decisions.md` (create it with a header if missing):

```markdown
## 2026-11-05 — Trim NVDA 200 sh (IRA)
- Decision: <what Chip decided, including "decided not to">
- Thesis / reason: <one or two sentences>
- Numbers at decision: price, size, % of portfolio, exposure before → after
- Risks named: <from the devil's advocate>
- Exit / review: <trigger or date>
- Outcome (fill in later): <date, price, what happened, what we learned>
```

Log a decision when Chip makes one, not when he is just exploring. When he reports an executed trade, also add it to `trades.md`.

## 4. Reviews

Monthly, or when asked: for journal entries whose review date has passed, fill in the outcome with current prices (`md.ts quote`) and note whether the reasoning held, separate from whether the price went up. If a lesson recurs, it belongs in a learned skill (see learned-skills).

This is analysis for Chip to decide on, not professional investment or tax advice; say so once when recommending a trade.
