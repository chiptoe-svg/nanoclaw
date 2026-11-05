/**
 * Rebuild portfolio/holdings.csv from Schwab CSV exports and show what changed.
 *
 *   bun /app/skills/my-portfolio/import-schwab.ts <export.csv ...>           preview only
 *   bun /app/skills/my-portfolio/import-schwab.ts --write <export.csv ...>   apply
 *
 * Accepts "Positions" exports (one per account) and "Lot Details" exports
 * (one per ticker per account; they replace that position's single row with
 * one row per lot, with acquisition dates). Accounts not covered by the files
 * keep their current rows. With --write: the old holdings.csv is kept under
 * portfolio/history/, the exports are copied to portfolio/statements/, and
 * quantity changes are appended to trades.md as inferred entries for Chip to
 * confirm.
 */
import fs from 'node:fs';
import path from 'node:path';

const PORTFOLIO = '/workspace/agent/portfolio';
const HOLDINGS = path.join(PORTFOLIO, 'holdings.csv');
const HEADER = 'account,account_type,ticker,shares,cost_basis_total,acquired_date';

interface Row {
  account: string;
  account_type: string;
  ticker: string;
  shares: number;
  cost: number;
  acquired: string;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const money = (s: string) => Number((s ?? '').replace(/[$,]/g, '')) || 0;

function accountType(account: string): string {
  if (/roth/i.test(account)) return 'Roth';
  if (/401/i.test(account)) return '401k';
  if (/hsa/i.test(account)) return 'HSA';
  if (/ira/i.test(account)) return 'IRA';
  return 'taxable';
}

/** MM/DD/YYYY → YYYY-MM-DD */
function isoDate(s: string): string {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : '';
}

function readHoldings(): Row[] {
  if (!fs.existsSync(HOLDINGS)) return [];
  return fs
    .readFileSync(HOLDINGS, 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map(parseCsvLine)
    .map(([account, account_type, ticker, shares, cost, acquired]) => ({
      account,
      account_type,
      ticker,
      shares: Number(shares),
      cost: Number(cost) || 0,
      acquired: acquired ?? '',
    }));
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const files = args.filter((a) => a !== '--write');
if (files.length === 0) {
  console.error('usage: import-schwab.ts [--write] <schwab export.csv ...>');
  process.exit(2);
}

const positions = new Map<string, Row[]>(); // account → rows
const lots: Array<{ suffix: string; ticker: string; rows: Array<{ shares: number; cost: number; acquired: string }> }> =
  [];
let asOf = '';

for (const file of files) {
  const lines = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const title = parseCsvLine(lines[0])[0];
  const pos = title.match(/^Positions for account (.+?) as of (.+)$/);
  const lot = title.match(/^(\S+) Lot Details for\s+(\S+) as of (.+)$/);
  if (pos) {
    const account = pos[1].trim();
    asOf ||= pos[2];
    const headerIdx = lines.findIndex((l) => l.startsWith('"Symbol"'));
    const header = parseCsvLine(lines[headerIdx]);
    const col = (prefix: string) => header.findIndex((h) => h.startsWith(prefix));
    const rows: Row[] = [];
    for (const line of lines.slice(headerIdx + 1)) {
      const c = parseCsvLine(line);
      const symbol = c[col('Symbol')];
      if (!symbol || symbol === 'Positions Total' || symbol === 'Account Total') continue;
      if (symbol.startsWith('Cash & Cash Investments')) {
        const v = money(c[col('Mkt Val')]);
        rows.push({ account, account_type: accountType(account), ticker: 'CASH', shares: v, cost: v, acquired: '' });
        continue;
      }
      rows.push({
        account,
        account_type: accountType(account),
        ticker: symbol,
        shares: money(c[col('Qty')]),
        cost: money(c[col('Cost Basis')]),
        acquired: '',
      });
    }
    positions.set(account, rows);
  } else if (lot) {
    const headerIdx = lines.findIndex((l) => l.startsWith('"Open Date"'));
    const rows = lines
      .slice(headerIdx + 1)
      .map(parseCsvLine)
      .filter((c) => isoDate(c[0]))
      .map((c) => ({ shares: money(c[1]), cost: money(c[5]), acquired: isoDate(c[0]) }));
    lots.push({ ticker: lot[1], suffix: lot[2], rows });
  } else {
    console.error(`skipping ${path.basename(file)}: not a Schwab Positions or Lot Details export`);
  }
}

// Lot detail replaces the matching single position row.
for (const l of lots) {
  const account = [...positions.keys()].find((a) => a.endsWith(l.suffix));
  if (!account) {
    console.error(`lot file for ${l.ticker} ${l.suffix} has no matching Positions export in this import; ignored`);
    continue;
  }
  const rows = positions.get(account)!;
  const i = rows.findIndex((r) => r.ticker === l.ticker);
  if (i < 0) continue;
  const lotRows = l.rows.map((x) => ({ ...rows[i], shares: x.shares, cost: x.cost, acquired: x.acquired }));
  rows.splice(i, 1, ...lotRows);
}

const old = readHoldings();
const next = [...old.filter((r) => !positions.has(r.account)), ...[...positions.values()].flat()];

// Diff by account + ticker (lots summed).
const sum = (rows: Row[]) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(`${r.account}|${r.ticker}`, (m.get(`${r.account}|${r.ticker}`) ?? 0) + r.shares);
  return m;
};
const before = sum(old);
const after = sum(next);
const changes: string[] = [];
for (const key of new Set([...before.keys(), ...after.keys()])) {
  const [account, ticker] = key.split('|');
  if (ticker === 'CASH') continue;
  const delta = +((after.get(key) ?? 0) - (before.get(key) ?? 0)).toFixed(4);
  if (delta !== 0) changes.push(`${account} | ${delta > 0 ? 'BUY' : 'SELL'} | ${ticker} | ${Math.abs(delta)}`);
}
const cash = (rows: Row[]) => rows.filter((r) => r.ticker === 'CASH').reduce((a, r) => a + r.shares, 0);

console.log(`Accounts in this import: ${[...positions.keys()].join(', ') || 'none'}${asOf ? ` (as of ${asOf})` : ''}`);
console.log(`Rows: ${old.length} → ${next.length}. Cash: ${cash(old).toFixed(2)} → ${cash(next).toFixed(2)}`);
console.log(
  changes.length
    ? `Quantity changes (likely trades since the last import):\n  ${changes.join('\n  ')}`
    : 'No quantity changes.',
);

if (!write) {
  console.log('\nPreview only. Re-run with --write to apply.');
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10);
fs.mkdirSync(path.join(PORTFOLIO, 'history'), { recursive: true });
fs.mkdirSync(path.join(PORTFOLIO, 'statements'), { recursive: true });
if (fs.existsSync(HOLDINGS))
  fs.copyFileSync(HOLDINGS, path.join(PORTFOLIO, 'history', `holdings-${stamp}-${Date.now()}.csv`));
const fmtRow = (r: Row) =>
  [r.account, r.account_type, r.ticker, r.shares, r.cost.toFixed(2), r.acquired]
    .map((v) => (String(v).includes(',') ? `"${v}"` : v))
    .join(',');
fs.writeFileSync(HOLDINGS, [HEADER, ...next.map(fmtRow)].join('\n') + '\n');
for (const f of files) fs.copyFileSync(f, path.join(PORTFOLIO, 'statements', path.basename(f)));
if (changes.length) {
  const trades = path.join(PORTFOLIO, 'trades.md');
  const lines = changes.map((c) => {
    const [account, action, ticker, qty] = c.split(' | ');
    return `| ${stamp} | ${account} | ${action} | ${ticker} | ${qty} | ? | inferred from statement import; confirm date and price |`;
  });
  fs.appendFileSync(trades, lines.join('\n') + '\n');
}
console.log(
  `\nWrote ${HOLDINGS}; previous version saved in portfolio/history/.${changes.length ? ' Inferred trades appended to trades.md.' : ''}`,
);
