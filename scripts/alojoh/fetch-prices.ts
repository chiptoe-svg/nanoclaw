#!/usr/bin/env npx tsx
/**
 * Fetch price history for all tickers mentioned in @alojoh posts
 * Uses Yahoo Finance v8 API (no auth required)
 *
 * Usage:
 *   npx tsx scripts/alojoh/fetch-prices.ts         # fetch all missing prices
 *   npx tsx scripts/alojoh/fetch-prices.ts AAPL TSLA  # specific tickers only
 */

import {
  getAllMentionedTickers,
  getLatestPriceDate,
  setAlojohState,
  upsertPrice,
} from '../../src/alojoh-db.js';

const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TWO_YEARS_AGO_UNIX = Math.floor(
  (Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000) / 1000,
);

interface YFResponse {
  chart?: {
    result?: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose: (number | null)[] }>;
      };
    }>;
    error?: { code: string; description: string };
  };
}

async function fetchTickerPrices(ticker: string): Promise<void> {
  const latestDate = getLatestPriceDate(ticker);

  let startUnix: number;
  if (latestDate) {
    const next = new Date(latestDate);
    next.setDate(next.getDate() + 1);
    startUnix = Math.floor(next.getTime() / 1000);
  } else {
    startUnix = TWO_YEARS_AGO_UNIX;
  }

  const endUnix = Math.floor(Date.now() / 1000);
  if (startUnix >= endUnix) {
    console.log(`[prices] ${ticker}: up to date`);
    return;
  }

  const url = `${YF_BASE}/${ticker}?interval=1d&period1=${startUnix}&period2=${endUnix}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    if (!res.ok) {
      console.warn(`[prices] ${ticker}: HTTP ${res.status}`);
      return;
    }

    const data = (await res.json()) as YFResponse;

    if (data.chart?.error) {
      console.warn(
        `[prices] ${ticker}: ${data.chart.error.code} - ${data.chart.error.description}`,
      );
      return;
    }

    const result = data.chart?.result?.[0];
    if (!result?.timestamp?.length) {
      console.warn(`[prices] ${ticker}: no data returned`);
      return;
    }

    const { timestamp } = result;
    const quote = result.indicators.quote[0];
    const adjcloseArr = result.indicators.adjclose?.[0]?.adjclose ?? [];

    let inserted = 0;
    for (let i = 0; i < timestamp.length; i++) {
      if (quote.close[i] == null) continue;
      const date = new Date(timestamp[i] * 1000).toISOString().split('T')[0];
      upsertPrice({
        ticker: ticker.toUpperCase(),
        date,
        open: quote.open[i] ?? 0,
        high: quote.high[i] ?? 0,
        low: quote.low[i] ?? 0,
        close: quote.close[i]!,
        adj_close: adjcloseArr[i] ?? quote.close[i]!,
        volume: quote.volume[i] ?? 0,
      });
      inserted++;
    }

    console.log(`[prices] ${ticker}: ${inserted} records stored`);
  } catch (err) {
    console.warn(`[prices] ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const cliTickers = process.argv.slice(2).map((t) => t.toUpperCase());
const tickers = cliTickers.length > 0 ? cliTickers : getAllMentionedTickers();

if (tickers.length === 0) {
  console.log('[prices] No tickers found. Run fetch-timeline first.');
  process.exit(0);
}

console.log(
  `[prices] Fetching prices for ${tickers.length} ticker(s): ${tickers.join(', ')}`,
);

for (const ticker of tickers) {
  await fetchTickerPrices(ticker);
  await new Promise((r) => setTimeout(r, 400));
}

setAlojohState('last_price_fetch', new Date().toISOString());
console.log('[prices] Done.');
