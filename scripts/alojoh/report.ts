#!/usr/bin/env npx tsx
/**
 * Per-ticker report: every @alojoh post mentioning the ticker, with the
 * close price on the post date and forward returns at 1w / 1m / 3m / 6m / 1y,
 * plus an overall summary.
 *
 * Usage:
 *   npx tsx scripts/alojoh/report.ts                 # all watchlist tickers
 *   npx tsx scripts/alojoh/report.ts TSLA NVDA       # specific tickers
 */

import { getPrices, queryPosts } from '../../src/alojoh-db.js';
import { WATCHLIST_TICKERS } from './tickers.js';

interface PriceLookup {
  dates: string[];
  closes: number[];
}

function buildLookup(ticker: string): PriceLookup {
  const rows = getPrices(ticker);
  return {
    dates: rows.map((r) => r.date),
    closes: rows.map((r) => r.adj_close ?? r.close),
  };
}

/** Returns the close on `date` or the next trading day after it. */
function closeOnOrAfter(lookup: PriceLookup, date: string): number | null {
  let lo = 0;
  let hi = lookup.dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lookup.dates[mid] < date) lo = mid + 1;
    else hi = mid;
  }
  return lo < lookup.dates.length ? lookup.closes[lo] : null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtPct(p: number | null): string {
  if (p === null) return '   —  ';
  const s = (p * 100).toFixed(1);
  return (p >= 0 ? '+' : '') + s + '%';
}

function fmtPrice(p: number | null): string {
  return p === null ? '   —  ' : '$' + p.toFixed(2);
}

const HORIZONS: Array<{ label: string; days: number }> = [
  { label: '1w', days: 7 },
  { label: '1m', days: 30 },
  { label: '3m', days: 90 },
  { label: '6m', days: 180 },
  { label: '1y', days: 365 },
];

function reportTicker(ticker: string): void {
  const lookup = buildLookup(ticker);
  if (lookup.dates.length === 0) {
    console.log(`\n## ${ticker}\n  no price data\n`);
    return;
  }

  const posts = queryPosts({ ticker, limit: 10000 }).sort((a, b) =>
    a.created_at < b.created_at ? -1 : 1,
  );

  if (posts.length === 0) {
    console.log(`\n## ${ticker}\n  no posts mention this ticker\n`);
    return;
  }

  const firstDate = lookup.dates[0];
  const lastDate = lookup.dates[lookup.dates.length - 1];
  const firstClose = lookup.closes[0];
  const lastClose = lookup.closes[lookup.closes.length - 1];
  const periodReturn = (lastClose - firstClose) / firstClose;

  console.log(
    `\n## ${ticker}  —  ${posts.length} posts, ${firstDate} → ${lastDate}, market: ${fmtPrice(firstClose)} → ${fmtPrice(lastClose)} (${fmtPct(periodReturn)})`,
  );

  const head = ['date', 'price', ...HORIZONS.map((h) => h.label), 'snippet'];
  console.log('  ' + head.join('\t'));

  // Aggregate forward-return averages
  const sums: Record<string, { sum: number; n: number }> = {};
  for (const h of HORIZONS) sums[h.label] = { sum: 0, n: 0 };

  for (const post of posts) {
    const date = post.created_at.slice(0, 10);
    const entryPrice = closeOnOrAfter(lookup, date);
    if (entryPrice === null) continue;

    const fwd = HORIZONS.map((h) => {
      const target = addDays(date, h.days);
      const exitPrice = closeOnOrAfter(lookup, target);
      if (exitPrice === null) return null;
      const r = (exitPrice - entryPrice) / entryPrice;
      sums[h.label].sum += r;
      sums[h.label].n += 1;
      return r;
    });

    const snippet = post.text
      .replace(/\s+/g, ' ')
      .slice(0, 70)
      .padEnd(70, ' ');
    console.log(
      '  ' +
        [
          date,
          fmtPrice(entryPrice),
          ...fwd.map(fmtPct),
          snippet + (post.text.length > 70 ? '…' : ''),
        ].join('\t'),
    );
  }

  const avg = HORIZONS.map((h) => {
    const s = sums[h.label];
    return s.n > 0 ? fmtPct(s.sum / s.n) + ` (n=${s.n})` : '—';
  });
  console.log(`  avg fwd return:\t\t\t${avg.join('\t')}`);
}

const argv = process.argv.slice(2).map((t) => t.toUpperCase());
const tickers = argv.length > 0 ? argv : WATCHLIST_TICKERS;

console.log(`# @alojoh × market — ${tickers.length} ticker(s)\n`);

for (const t of tickers) {
  reportTicker(t);
}
