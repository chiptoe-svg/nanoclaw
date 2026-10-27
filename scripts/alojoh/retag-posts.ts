#!/usr/bin/env npx tsx
/**
 * Re-extract tickers from already-stored posts using the current watchlist.
 * Run after the watchlist or extractor changes.
 */

import { getAlojohDb } from '../../src/alojoh-db.js';
import { extractTickers } from './tickers.js';

const db = getAlojohDb();
const rows = db
  .prepare('SELECT id, text, tickers FROM x_posts')
  .all() as Array<{ id: string; text: string; tickers: string }>;

const update = db.prepare('UPDATE x_posts SET tickers = ? WHERE id = ?');
let changed = 0;
let withTickers = 0;

const tx = db.transaction(() => {
  for (const row of rows) {
    const next = JSON.stringify(extractTickers(row.text));
    if (next !== row.tickers) {
      update.run(next, row.id);
      changed++;
    }
    if (next !== '[]') withTickers++;
  }
});
tx();

console.log(`[retag] scanned ${rows.length} posts`);
console.log(`[retag] updated ${changed} rows`);
console.log(`[retag] posts with tickers: ${withTickers}`);
