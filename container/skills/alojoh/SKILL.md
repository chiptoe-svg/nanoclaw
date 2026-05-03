---
name: alojoh
description: Query @alojoh's stored X timeline and tracked stock prices (TSLA, AMZN, NVDA, MU, TSM, GOOGL, META, AVGO, ORCL, AMD, MSFT, PLTR, AAPL). Use whenever the user asks about what alojoh said about a ticker, recent posts, or how a stock performed around his commentary. Pre-rendered summaries are also available at /workspace/project/reports/.
allowed-tools: Bash(alojoh-query:*), Read
---

# alojoh

Read-only access to the @alojoh timeline + market price database.

## Pre-rendered reports

Two files are refreshed twice a day by the host scheduler. Read these first when the user asks for an overview — they're already formatted:

- `/workspace/project/reports/alojoh-summary.txt` — one-line-per-ticker summary table
- `/workspace/project/reports/alojoh-vs-market.txt` — every post with date, price, and forward returns

For specific lookups, use `alojoh-query` below.

## Commands

```bash
alojoh-query summary                       # Watchlist summary (post counts, market move)
alojoh-query posts TSLA                    # All posts mentioning TSLA, newest first
alojoh-query posts TSLA --since 7d         # Last 7 days
alojoh-query posts TSLA --limit 20         # First 20
alojoh-query latest                        # 20 most recent posts (any ticker)
alojoh-query latest 50                     # 50 most recent
alojoh-query price TSLA                    # Last 30 days of TSLA prices
alojoh-query price TSLA --since 90d        # Last 90 days
alojoh-query search "robotaxi"             # Full-text search across all posts
alojoh-query stats                         # DB stats (post count, date range)
```

`--since` accepts `Nd` (days), `Nm` (months — 30 days), `Ny` (years — 365 days).

## Watchlist tickers

TSLA, AMZN, NVDA, MU, TSM, GOOGL, META, AVGO, ORCL, AMD, MSFT, PLTR, AAPL.
Posts that don't mention any of these will have an empty ticker tag.

## Notes

- Database is read-only from the container; you cannot add new posts.
- Timeline coverage may not yet span 2 years — the scheduler runs incremental fetches twice daily, and a one-time backfill populates older history.
- Use `Read` to view the pre-rendered reports as plain text rather than re-querying the DB.
