import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';

let db: Database.Database | null = null;

export function getAlojohDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const dbPath = path.join(STORE_DIR, 'alojoh.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode=WAL');
    createSchema(db);
  }
  return db;
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS x_posts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      url TEXT NOT NULL,
      tickers TEXT NOT NULL DEFAULT '[]',
      is_subscriber_only INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_x_posts_created_at ON x_posts(created_at);

    CREATE TABLE IF NOT EXISTS market_prices (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      adj_close REAL,
      volume INTEGER,
      PRIMARY KEY (ticker, date)
    );

    CREATE TABLE IF NOT EXISTS alojoh_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export interface XPost {
  id: string;
  text: string;
  created_at: string;
  url: string;
  tickers: string[];
  is_subscriber_only: boolean;
  fetched_at: string;
}

export function upsertPost(post: Omit<XPost, 'fetched_at'>): void {
  const now = new Date().toISOString();
  getAlojohDb()
    .prepare(
      `INSERT INTO x_posts (id, text, created_at, url, tickers, is_subscriber_only, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      post.id,
      post.text,
      post.created_at,
      post.url,
      JSON.stringify(post.tickers),
      post.is_subscriber_only ? 1 : 0,
      now,
    );
}

export function postExists(id: string): boolean {
  return !!getAlojohDb()
    .prepare('SELECT 1 FROM x_posts WHERE id = ?')
    .get(id);
}

export function getLatestPostId(): string | null {
  const row = getAlojohDb()
    .prepare('SELECT id FROM x_posts ORDER BY created_at DESC LIMIT 1')
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function getEarliestPostDate(): string | null {
  const row = getAlojohDb()
    .prepare('SELECT created_at FROM x_posts ORDER BY created_at ASC LIMIT 1')
    .get() as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

export function getPostCount(): number {
  const row = getAlojohDb()
    .prepare('SELECT COUNT(*) as count FROM x_posts')
    .get() as { count: number };
  return row.count;
}

export function queryPosts(opts: {
  ticker?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
}): XPost[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.ticker) {
    conditions.push('tickers LIKE ?');
    params.push(`%"${opts.ticker.toUpperCase()}"%`);
  }
  if (opts.start_date) {
    conditions.push('created_at >= ?');
    params.push(opts.start_date);
  }
  if (opts.end_date) {
    conditions.push('created_at <= ?');
    params.push(opts.end_date);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const rows = getAlojohDb()
    .prepare(
      `SELECT * FROM x_posts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<{
    id: string;
    text: string;
    created_at: string;
    url: string;
    tickers: string;
    is_subscriber_only: number;
    fetched_at: string;
  }>;

  return rows.map((r) => ({
    ...r,
    tickers: JSON.parse(r.tickers) as string[],
    is_subscriber_only: r.is_subscriber_only === 1,
  }));
}

export function upsertPrice(entry: {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adj_close: number;
  volume: number;
}): void {
  getAlojohDb()
    .prepare(
      `INSERT INTO market_prices (ticker, date, open, high, low, close, adj_close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker, date) DO NOTHING`,
    )
    .run(
      entry.ticker,
      entry.date,
      entry.open,
      entry.high,
      entry.low,
      entry.close,
      entry.adj_close,
      entry.volume,
    );
}

export interface PriceRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adj_close: number;
  volume: number;
}

export function getPrices(
  ticker: string,
  startDate?: string,
  endDate?: string,
): PriceRow[] {
  const conditions = ['ticker = ?'];
  const params: unknown[] = [ticker.toUpperCase()];
  if (startDate) {
    conditions.push('date >= ?');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('date <= ?');
    params.push(endDate);
  }

  return getAlojohDb()
    .prepare(
      `SELECT date, open, high, low, close, adj_close, volume
       FROM market_prices WHERE ${conditions.join(' AND ')} ORDER BY date`,
    )
    .all(...params) as PriceRow[];
}

export function getLatestPriceDate(ticker: string): string | null {
  const row = getAlojohDb()
    .prepare(
      'SELECT MAX(date) as d FROM market_prices WHERE ticker = ?',
    )
    .get(ticker.toUpperCase()) as { d: string | null };
  return row.d;
}

export function getAllMentionedTickers(): string[] {
  const rows = getAlojohDb()
    .prepare("SELECT DISTINCT tickers FROM x_posts WHERE tickers != '[]'")
    .all() as Array<{ tickers: string }>;
  const tickerSet = new Set<string>();
  for (const row of rows) {
    for (const t of JSON.parse(row.tickers) as string[]) tickerSet.add(t);
  }
  return Array.from(tickerSet).sort();
}

export function getTopTickers(limit = 20): Array<{ ticker: string; count: number }> {
  const rows = getAlojohDb()
    .prepare("SELECT tickers FROM x_posts WHERE tickers != '[]'")
    .all() as Array<{ tickers: string }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const t of JSON.parse(row.tickers) as string[]) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ticker, count]) => ({ ticker, count }));
}

export function getAlojohState(key: string): string | null {
  const row = getAlojohDb()
    .prepare('SELECT value FROM alojoh_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAlojohState(key: string, value: string): void {
  getAlojohDb()
    .prepare('INSERT OR REPLACE INTO alojoh_state (key, value) VALUES (?, ?)')
    .run(key, value);
}

export function getDbStats(): {
  post_count: number;
  earliest_post: string | null;
  latest_post: string | null;
  ticker_count: number;
  price_record_count: number;
} {
  const db = getAlojohDb();

  const postCount = (
    db.prepare('SELECT COUNT(*) as n FROM x_posts').get() as { n: number }
  ).n;
  const earliest = (
    db
      .prepare('SELECT MIN(created_at) as d FROM x_posts')
      .get() as { d: string | null }
  ).d;
  const latest = (
    db
      .prepare('SELECT MAX(created_at) as d FROM x_posts')
      .get() as { d: string | null }
  ).d;
  const priceCount = (
    db
      .prepare('SELECT COUNT(*) as n FROM market_prices')
      .get() as { n: number }
  ).n;
  const tickers = getAllMentionedTickers();

  return {
    post_count: postCount,
    earliest_post: earliest,
    latest_post: latest,
    ticker_count: tickers.length,
    price_record_count: priceCount,
  };
}
