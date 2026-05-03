/**
 * Watchlist of tickers @alojoh covers, with company-name aliases used to
 * tag posts that mention companies by name rather than $CASHTAG.
 *
 * Aliases are matched case-insensitively as whole words.
 */

export interface TickerEntry {
  ticker: string;
  aliases: string[];
}

export const WATCHLIST: TickerEntry[] = [
  { ticker: 'TSLA', aliases: ['tesla'] },
  { ticker: 'AMZN', aliases: ['amazon'] },
  { ticker: 'NVDA', aliases: ['nvidia'] },
  { ticker: 'MU', aliases: ['micron'] },
  { ticker: 'TSM', aliases: ['tsmc', 'taiwan semi', 'taiwan semiconductor'] },
  { ticker: 'GOOGL', aliases: ['alphabet', 'google'] },
  { ticker: 'META', aliases: ['meta', 'facebook'] },
  { ticker: 'AVGO', aliases: ['broadcom'] },
  { ticker: 'ORCL', aliases: ['oracle'] },
  { ticker: 'AMD', aliases: ['amd'] },
  { ticker: 'MSFT', aliases: ['microsoft'] },
  { ticker: 'PLTR', aliases: ['palantir'] },
  { ticker: 'AAPL', aliases: ['apple'] },
];

const CASHTAG_RE = /\$([A-Z]{1,6})(?![a-z\d])/g;

const ALIAS_PATTERNS: Array<{ ticker: string; re: RegExp }> = WATCHLIST.flatMap(
  ({ ticker, aliases }) => [
    { ticker, re: new RegExp(`\\b${ticker}\\b`, 'i') },
    ...aliases.map((a) => ({
      ticker,
      re: new RegExp(`\\b${a.replace(/\s+/g, '\\s+')}\\b`, 'i'),
    })),
  ],
);

export function extractTickers(text: string): string[] {
  const found = new Set<string>();

  CASHTAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CASHTAG_RE.exec(text)) !== null) {
    found.add(m[1].toUpperCase());
  }

  for (const { ticker, re } of ALIAS_PATTERNS) {
    if (re.test(text)) found.add(ticker);
  }

  return Array.from(found).sort();
}

export const WATCHLIST_TICKERS = WATCHLIST.map((e) => e.ticker);
