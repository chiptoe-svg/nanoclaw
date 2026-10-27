#!/usr/bin/env npx tsx
/**
 * Compact per-ticker summary: post count, market return over our window,
 * and average forward returns at standard horizons after each @alojoh post.
 *
 * "Forward return" = how the stock did in the N days *after* alojoh posted
 * about it. It's a rough sentiment check, not a directional call.
 */

import { getPrices, queryPosts } from '../../src/alojoh-db.js';
import { WATCHLIST_TICKERS } from './tickers.js';

const HORIZONS = [
  { label: '1w', days: 7 },
  { label: '1m', days: 30 },
  { label: '3m', days: 90 },
  { label: '6m', days: 180 },
  { label: '1y', days: 365 },
];

function closeOnOrAfter(
  dates: string[],
  closes: number[],
  date: string,
): number | null {
  let lo = 0,
    hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < date) lo = mid + 1;
    else hi = mid;
  }
  return lo < dates.length ? closes[lo] : null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '   —  ';
  const s = (n * 100).toFixed(1);
  return (n >= 0 ? '+' : '') + s.padStart(5, ' ') + '%';
}

interface Row {
  ticker: string;
  posts: number;
  marketReturn: number | null;
  avgFwd: Array<{ avg: number | null; n: number }>;
}

const rows: Row[] = [];

for (const ticker of WATCHLIST_TICKERS) {
  const priceRows = getPrices(ticker);
  if (priceRows.length === 0) {
    rows.push({
      ticker,
      posts: 0,
      marketReturn: null,
      avgFwd: HORIZONS.map(() => ({ avg: null, n: 0 })),
    });
    continue;
  }
  const dates = priceRows.map((r) => r.date);
  const closes = priceRows.map((r) => r.adj_close ?? r.close);
  const marketReturn = (closes[closes.length - 1] - closes[0]) / closes[0];

  const posts = queryPosts({ ticker, limit: 100000 });
  const sums = HORIZONS.map(() => ({ sum: 0, n: 0 }));

  for (const p of posts) {
    const date = p.created_at.slice(0, 10);
    const entry = closeOnOrAfter(dates, closes, date);
    if (entry === null) continue;
    HORIZONS.forEach((h, i) => {
      const exit = closeOnOrAfter(dates, closes, addDays(date, h.days));
      if (exit === null) return;
      sums[i].sum += (exit - entry) / entry;
      sums[i].n += 1;
    });
  }

  rows.push({
    ticker,
    posts: posts.length,
    marketReturn,
    avgFwd: sums.map((s) => ({ avg: s.n > 0 ? s.sum / s.n : null, n: s.n })),
  });
}

const header = [
  'ticker'.padEnd(7),
  'posts'.padStart(6),
  'mkt 2y'.padStart(8),
  ...HORIZONS.map((h) => `avg ${h.label}`.padStart(11)),
].join('  ');

console.log('\n@alojoh × market — summary\n');
console.log(header);
console.log('-'.repeat(header.length));

for (const r of rows) {
  console.log(
    [
      r.ticker.padEnd(7),
      String(r.posts).padStart(6),
      pct(r.marketReturn).padStart(8),
      ...r.avgFwd.map((f) =>
        (f.n > 0 ? `${pct(f.avg)} (${String(f.n).padStart(3)})` : '       —   ').padStart(11),
      ),
    ].join('  '),
  );
}

console.log('\nNotes:');
console.log('  posts  = posts mentioning this ticker in our timeline (as currently scraped)');
console.log('  mkt 2y = market move from earliest to latest stored price');
console.log('  avg Nx = mean forward return at horizon N after each alojoh post');
console.log('  (n)    = number of posts that have a full horizon N of price history');
