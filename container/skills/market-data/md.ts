/**
 * Free market data for the agent: 15-minute-delayed quotes and full option
 * chains with IV and Greeks (Cboe), price history (Yahoo chart API), SEC
 * filings and XBRL financials (EDGAR), and a whole-portfolio valuation from
 * holdings.csv.
 *
 *   bun /app/skills/market-data/md.ts <command> [args]   (see usage below)
 *
 * Fetches go through curl so they use the container's proxy and CA setup.
 * Output is compact JSON or aligned text meant to be read by the agent.
 */
import fs from 'node:fs';

const UA_BROWSER = 'Mozilla/5.0 (compatible; NanoClaw market-data)';
const UA_SEC = 'NanoClaw personal research chiptoe@mac.com';
const HOLDINGS = '/workspace/agent/portfolio/holdings.csv';

function usage(): never {
  console.log(`market-data commands:
  quote SYM [SYM...]                 delayed quote (stocks, ETFs; ^VIX ^TNX ^GSPC via Yahoo)
  chain SYM [--expiry YYYY-MM-DD] [--type C|P] [--strikes N]
                                     option chain around spot with IV and Greeks
  option "NVDA 03/19/2027 300.00 C"  one contract (Schwab format or OCC symbol)
  history SYM [range] [interval]     daily closes + return, volatility, max drawdown (range 1mo..10y, default 1y)
  positions [holdings.csv] [--json]  value every holding, options included, with P/L and delta exposure
  filings SYM [--forms 10-K,10-Q,8-K,4] [--limit N]
  facts SYM                          key reported financials (revenue, net income, EPS, cash flow) by period`);
  process.exit(2);
}

async function fetchText(url: string, ua = UA_BROWSER): Promise<string> {
  const proc = Bun.spawn(['curl', '-sSL', '--max-time', '25', '-A', ua, url], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`fetch failed for ${url}: ${err.trim()}`);
  return out;
}

async function fetchJson<T>(url: string, ua = UA_BROWSER): Promise<T> {
  const text = await fetchText(url, ua);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`not JSON from ${url}: ${text.slice(0, 120)}`);
  }
}

// ── Cboe (delayed quotes + option chains) ──

interface CboeOption {
  option: string;
  bid: number;
  ask: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  open_interest: number;
  volume: number;
  last_trade_price: number;
}
interface CboeChain {
  timestamp: string;
  data: { current_price: number; iv30: number; options: CboeOption[] };
}
interface CboeQuote {
  timestamp: string;
  data: {
    current_price: number;
    prev_day_close: number;
    price_change_percent: number;
    iv30: number;
    last_trade_time: string;
  };
}

const cboeSym = (sym: string) => sym.replace(/^\^/, '_').toUpperCase();
const chainCache = new Map<string, CboeChain>();

async function cboeChain(sym: string): Promise<CboeChain> {
  const key = sym.toUpperCase();
  let chain = chainCache.get(key);
  if (!chain) {
    chain = await fetchJson<CboeChain>(`https://cdn.cboe.com/api/global/delayed_quotes/options/${cboeSym(key)}.json`);
    chainCache.set(key, chain);
  }
  return chain;
}

/** OCC symbol parts: NVDA270319C00300000 → NVDA, 2027-03-19, C, 300. */
function parseOcc(occ: string): { root: string; expiry: string; type: 'C' | 'P'; strike: number } | null {
  const m = occ.match(/^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] as 'C' | 'P', strike: Number(m[6]) / 1000 };
}

/** Schwab "NVDA 03/19/2027 300.00 C" (or an OCC symbol) → OCC symbol. */
function toOcc(contract: string): string | null {
  const s = contract.trim().toUpperCase();
  if (parseOcc(s)) return s;
  const m = s.match(/^([A-Z.]{1,6})\s+(\d{2})\/(\d{2})\/(\d{4})\s+([\d.]+)\s+([CP])$/);
  if (!m) return null;
  const strike = Math.round(Number(m[5]) * 1000)
    .toString()
    .padStart(8, '0');
  return `${m[1]}${m[4].slice(2)}${m[2]}${m[3]}${m[6]}${strike}`;
}

async function findOption(
  contract: string,
): Promise<{ occ: string; spot: number; asOf: string; o: CboeOption } | null> {
  const occ = toOcc(contract);
  if (!occ) throw new Error(`unrecognised option "${contract}"`);
  const parts = parseOcc(occ)!;
  const chain = await cboeChain(parts.root);
  const o = chain.data.options.find((x) => x.option === occ);
  return o ? { occ, spot: chain.data.current_price, asOf: chain.timestamp, o } : null;
}

const mid = (o: CboeOption) => (o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.last_trade_price);

// ── Yahoo chart (quotes for indices, history) ──

interface YahooChart {
  chart: {
    result?: Array<{
      meta: { regularMarketPrice: number; chartPreviousClose: number; regularMarketTime: number; longName?: string };
      timestamp?: number[];
      indicators: { quote: Array<{ close: Array<number | null> }> };
    }>;
    error?: { description: string } | null;
  };
}

async function yahooChart(sym: string, range: string, interval: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`;
  const res = await fetchJson<YahooChart>(url);
  const r = res.chart.result?.[0];
  if (!r) throw new Error(`no Yahoo data for ${sym}: ${res.chart.error?.description ?? 'empty'}`);
  return r;
}

// ── Commands ──

const fmt = (n: number, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '-';
const pct = (n: number) => `${n >= 0 ? '+' : ''}${fmt(n * 100, 1)}%`;

async function quote(syms: string[]): Promise<void> {
  for (const sym of syms) {
    try {
      if (sym.startsWith('^')) throw new Error('index');
      const q = await fetchJson<CboeQuote>(
        `https://cdn.cboe.com/api/global/delayed_quotes/quotes/${cboeSym(sym)}.json`,
      );
      const d = q.data;
      console.log(
        `${sym.toUpperCase()}  ${fmt(d.current_price)}  ${pct(d.price_change_percent / 100)} vs prev close ${fmt(d.prev_day_close)}  iv30 ${fmt(d.iv30, 1)}  (Cboe delayed, ${q.timestamp} UTC)`,
      );
    } catch {
      const r = await yahooChart(sym, '5d', '1d');
      const m = r.meta;
      const when = new Date(m.regularMarketTime * 1000).toISOString();
      console.log(
        `${sym.toUpperCase()}  ${fmt(m.regularMarketPrice)}  ${pct(m.regularMarketPrice / m.chartPreviousClose - 1)} vs ${fmt(m.chartPreviousClose)}  ${m.longName ?? ''} (Yahoo, ${when})`,
      );
    }
  }
}

async function chain(sym: string, opts: Record<string, string>): Promise<void> {
  const c = await cboeChain(sym);
  const spot = c.data.current_price;
  const all = c.data.options.map((o) => ({ o, p: parseOcc(o.option)! })).filter((x) => x.p);
  const expiries = [...new Set(all.map((x) => x.p.expiry))].sort();
  const expiry = opts.expiry ?? expiries.find((e) => e >= new Date().toISOString().slice(0, 10));
  if (!expiry || !expiries.includes(expiry)) {
    console.log(`expiries for ${sym.toUpperCase()}: ${expiries.join(' ')}`);
    return;
  }
  const n = Number(opts.strikes ?? 8);
  const rows = all.filter((x) => x.p.expiry === expiry && (!opts.type || x.p.type === opts.type.toUpperCase()));
  const strikes = [...new Set(rows.map((x) => x.p.strike))]
    .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
    .slice(0, n * 2);
  console.log(
    `${sym.toUpperCase()} spot ${fmt(spot)}  iv30 ${fmt(c.data.iv30, 1)}  expiry ${expiry}  (Cboe delayed, ${c.timestamp} UTC)`,
  );
  console.log('type  strike      bid      ask      mid     iv   delta   theta    vega      OI     vol');
  for (const x of rows
    .filter((r) => strikes.includes(r.p.strike))
    .sort((a, b) => a.p.type.localeCompare(b.p.type) || a.p.strike - b.p.strike)) {
    const o = x.o;
    console.log(
      `${x.p.type}  ${fmt(x.p.strike).padStart(10)} ${fmt(o.bid).padStart(8)} ${fmt(o.ask).padStart(8)} ${fmt(mid(o)).padStart(8)} ${fmt(o.iv * 100, 1).padStart(6)} ${fmt(o.delta, 3).padStart(7)} ${fmt(o.theta, 3).padStart(7)} ${fmt(o.vega, 3).padStart(7)} ${String(o.open_interest).padStart(7)} ${String(o.volume).padStart(7)}`,
    );
  }
  console.log(
    `other expiries: ${expiries
      .filter((e) => e !== expiry)
      .slice(0, 24)
      .join(' ')}`,
  );
}

async function option(contract: string): Promise<void> {
  const found = await findOption(contract);
  if (!found) {
    console.log(`no quote for ${contract} (expired, or not listed on Cboe's delayed feed)`);
    return;
  }
  const { occ, spot, asOf, o } = found;
  const p = parseOcc(occ)!;
  const days = Math.round((Date.parse(p.expiry) - Date.now()) / 86_400_000);
  console.log(
    JSON.stringify({
      contract: occ,
      underlying: p.root,
      spot,
      expiry: p.expiry,
      daysToExpiry: days,
      type: p.type,
      strike: p.strike,
      bid: o.bid,
      ask: o.ask,
      mid: +mid(o).toFixed(3),
      iv: o.iv,
      delta: o.delta,
      gamma: o.gamma,
      theta: o.theta,
      vega: o.vega,
      openInterest: o.open_interest,
      volume: o.volume,
      asOf: `${asOf} UTC (Cboe delayed)`,
    }),
  );
}

async function history(sym: string, range = '1y', interval = '1d'): Promise<void> {
  const r = await yahooChart(sym, range, interval);
  const ts = r.timestamp ?? [];
  const closes = r.indicators.quote[0].close;
  const pts = ts.map((t, i) => [t, closes[i]] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) throw new Error(`not enough history for ${sym}`);
  const rets = pts.slice(1).map((p, i) => p[1] / pts[i][1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  const perYear = interval === '1wk' ? 52 : interval === '1mo' ? 12 : 252;
  let peak = pts[0][1];
  let maxDd = 0;
  for (const [, c] of pts) {
    peak = Math.max(peak, c);
    maxDd = Math.min(maxDd, c / peak - 1);
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  console.log(
    `${sym.toUpperCase()} ${range} ${interval}: ${day(first[0])} ${fmt(first[1])} → ${day(last[0])} ${fmt(last[1])}  return ${pct(last[1] / first[1] - 1)}  annualised vol ${fmt(sd * Math.sqrt(perYear) * 100, 1)}%  max drawdown ${pct(maxDd)}  high ${fmt(Math.max(...pts.map((p) => p[1])))}  low ${fmt(Math.min(...pts.map((p) => p[1])))}`,
  );
  console.log('date,close');
  for (const [t, c] of pts) console.log(`${day(t)},${c.toFixed(2)}`);
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

async function positions(file = HOLDINGS, json = false): Promise<void> {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const col = (name: string) => header.indexOf(name);
  const rows = lines.slice(1).map(parseCsvLine);
  const stamp = fs.statSync(file).mtime.toISOString().slice(0, 10);

  type Pos = {
    account: string;
    ticker: string;
    underlying: string;
    qty: number;
    cost: number;
    price: number;
    value: number;
    deltaShares: number;
    note: string;
    option?: { type: 'C' | 'P'; strike: number; expiry: string; iv: number };
  };
  const out: Pos[] = [];
  const quotes = new Map<string, number>();
  const spotOf = async (sym: string): Promise<number> => {
    if (!quotes.has(sym)) {
      try {
        const q = await fetchJson<CboeQuote>(
          `https://cdn.cboe.com/api/global/delayed_quotes/quotes/${cboeSym(sym)}.json`,
        );
        quotes.set(sym, q.data.current_price);
      } catch {
        quotes.set(sym, (await yahooChart(sym, '5d', '1d')).meta.regularMarketPrice);
      }
    }
    return quotes.get(sym)!;
  };

  for (const r of rows) {
    const account = r[col('account')];
    const ticker = r[col('ticker')];
    const qty = Number(r[col('shares')]);
    const cost = Number(r[col('cost_basis_total')]) || 0;
    if (ticker.toUpperCase() === 'CASH') {
      out.push({
        account,
        ticker: 'CASH',
        underlying: 'CASH',
        qty,
        cost: qty,
        price: 1,
        value: qty,
        deltaShares: 0,
        note: '',
      });
      continue;
    }
    const occ = toOcc(ticker);
    try {
      if (occ) {
        const found = await findOption(ticker);
        const p = parseOcc(occ)!;
        if (!found) {
          out.push({
            account,
            ticker,
            underlying: p.root,
            qty,
            cost,
            price: NaN,
            value: NaN,
            deltaShares: NaN,
            note: 'no quote',
          });
          continue;
        }
        const price = mid(found.o);
        out.push({
          account,
          ticker,
          underlying: p.root,
          qty,
          cost,
          price,
          value: price * 100 * qty,
          deltaShares: found.o.delta * 100 * qty,
          note: `delta ${found.o.delta.toFixed(3)} iv ${(found.o.iv * 100).toFixed(0)}%`,
          option: { type: p.type, strike: p.strike, expiry: p.expiry, iv: found.o.iv },
        });
      } else {
        const price = await spotOf(ticker);
        out.push({
          account,
          ticker,
          underlying: ticker,
          qty,
          cost,
          price,
          value: price * qty,
          deltaShares: qty,
          note: '',
        });
      }
    } catch (e) {
      out.push({
        account,
        ticker,
        underlying: ticker,
        qty,
        cost,
        price: NaN,
        value: NaN,
        deltaShares: NaN,
        note: `error: ${(e as Error).message.slice(0, 60)}`,
      });
    }
  }

  const total = out.reduce((a, p) => a + (Number.isFinite(p.value) ? p.value : 0), 0);
  if (json) {
    for (const p of out) if (p.underlying !== 'CASH') await spotOf(p.underlying).catch(() => NaN);
    console.log(
      JSON.stringify({
        holdingsDate: stamp,
        pricedAt: new Date().toISOString(),
        total,
        spots: Object.fromEntries(quotes),
        positions: out,
      }),
    );
    return;
  }
  console.log(
    `Holdings file dated ${stamp}. Prices: Cboe/Yahoo delayed, fetched ${new Date().toISOString()}. Options at bid/ask mid.`,
  );
  console.log(
    'account          ticker                         qty        price          value      cost basis        P/L    note',
  );
  for (const p of out) {
    const pl = p.value - p.cost;
    console.log(
      `${p.account.padEnd(16)} ${p.ticker.padEnd(26)} ${fmt(p.qty, 0).padStart(7)} ${fmt(p.price).padStart(12)} ${fmt(p.value).padStart(14)} ${fmt(p.cost).padStart(15)} ${fmt(pl).padStart(12)}    ${p.note}`,
    );
  }
  console.log(`TOTAL market value ${fmt(total)}`);

  // Exposure by underlying: stock plus option delta, in dollars at spot.
  const byUnderlying = new Map<string, { value: number; deltaDollars: number }>();
  for (const p of out) {
    if (p.underlying === 'CASH') continue;
    const spot = quotes.get(p.underlying) ?? (await spotOf(p.underlying).catch(() => NaN));
    const e = byUnderlying.get(p.underlying) ?? { value: 0, deltaDollars: 0 };
    e.value += Number.isFinite(p.value) ? p.value : 0;
    e.deltaDollars += Number.isFinite(p.deltaShares * spot) ? p.deltaShares * spot : 0;
    byUnderlying.set(p.underlying, e);
  }
  console.log('\nexposure by underlying (market value, and delta-adjusted $ exposure incl. options):');
  for (const [u, e] of [...byUnderlying].sort((a, b) => b[1].deltaDollars - a[1].deltaDollars)) {
    console.log(
      `  ${u.padEnd(8)} value ${fmt(e.value, 0).padStart(12)} (${fmt((e.value / total) * 100, 1)}%)   delta-adj ${fmt(e.deltaDollars, 0).padStart(12)} (${fmt((e.deltaDollars / total) * 100, 1)}%)`,
    );
  }
}

async function cikFor(sym: string): Promise<{ cik: string; name: string }> {
  const map = await fetchJson<Record<string, { cik_str: number; ticker: string; title: string }>>(
    'https://www.sec.gov/files/company_tickers.json',
    UA_SEC,
  );
  const hit = Object.values(map).find((x) => x.ticker.toUpperCase() === sym.toUpperCase());
  if (!hit) throw new Error(`no SEC registrant for ${sym} (ETFs and foreign issuers often have none)`);
  return { cik: String(hit.cik_str).padStart(10, '0'), name: hit.title };
}

async function filings(sym: string, opts: Record<string, string>): Promise<void> {
  const { cik, name } = await cikFor(sym);
  const sub = await fetchJson<{
    filings: {
      recent: {
        form: string[];
        filingDate: string[];
        accessionNumber: string[];
        primaryDocument: string[];
        primaryDocDescription: string[];
      };
    };
  }>(`https://data.sec.gov/submissions/CIK${cik}.json`, UA_SEC);
  const r = sub.filings.recent;
  const forms = (opts.forms ?? '10-K,10-Q,8-K,4').split(',');
  const limit = Number(opts.limit ?? 15);
  console.log(`${name} (CIK ${cik}) recent filings:`);
  let shown = 0;
  for (let i = 0; i < r.form.length && shown < limit; i++) {
    if (!forms.includes(r.form[i])) continue;
    const acc = r.accessionNumber[i].replace(/-/g, '');
    console.log(
      `${r.filingDate[i]}  ${r.form[i].padEnd(6)} ${r.primaryDocDescription[i] || ''}  https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${r.primaryDocument[i]}`,
    );
    shown++;
  }
}

async function facts(sym: string): Promise<void> {
  const { cik, name } = await cikFor(sym);
  type Unit = { end: string; val: number; fp: string; fy: number; form: string; frame?: string };
  const data = await fetchJson<{ facts: { 'us-gaap'?: Record<string, { units: Record<string, Unit[]> }> } }>(
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    UA_SEC,
  );
  const gaap = data.facts['us-gaap'] ?? {};
  const concepts: Array<[string, string[]]> = [
    ['Revenue', ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']],
    ['Net income', ['NetIncomeLoss']],
    ['Diluted EPS', ['EarningsPerShareDiluted']],
    ['Operating cash flow', ['NetCashProvidedByUsedInOperatingActivities']],
    ['Capex', ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets']],
    ['Cash', ['CashAndCashEquivalentsAtCarryingValue']],
    ['Diluted shares', ['WeightedAverageNumberOfDilutedSharesOutstanding']],
  ];
  console.log(
    `${name} (CIK ${cik}) — reported figures from SEC XBRL, by calendar period. Cash-flow items are filed year-to-date, so their quarterly values are sparse; use FY.`,
  );
  for (const [label, names] of concepts) {
    // Companies switch tags over time; use whichever candidate has the most recent data.
    const series = names
      .map((n) => (gaap[n] ? (Object.values(gaap[n].units)[0] ?? []) : []))
      .map((units) => [...units].sort((a, b) => a.end.localeCompare(b.end)))
      .filter((units) => units.length > 0)
      .sort((a, b) => b[b.length - 1].end.localeCompare(a[a.length - 1].end))[0];
    if (!series) continue;
    const quarters = series.filter((u) => u.frame && /^CY\d{4}Q\dI?$/.test(u.frame)).slice(-6);
    const annual = series.filter((u) => u.frame && /^CY\d{4}$/.test(u.frame)).slice(-3);
    const show = (list: Unit[]) =>
      list.map((u) => `${u.frame}: ${Math.abs(u.val) >= 1e6 ? fmt(u.val / 1e6, 0) + 'M' : fmt(u.val)}`).join('  ');
    console.log(`  ${label.padEnd(20)} Q: ${show(quarters) || '-'}`);
    if (annual.length) console.log(`  ${''.padEnd(20)} FY: ${show(annual)}`);
  }
}

// ── CLI ──

function flags(args: string[]): { pos: string[]; opts: Record<string, string> } {
  const pos: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i] ?? '';
    else pos.push(args[i]);
  }
  return { pos, opts };
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opts } = flags(rest);
try {
  switch (cmd) {
    case 'quote':
      if (!pos.length) usage();
      await quote(pos);
      break;
    case 'chain':
      if (!pos[0]) usage();
      await chain(pos[0], opts);
      break;
    case 'option':
      if (!pos.length) usage();
      await option(pos.join(' '));
      break;
    case 'history':
      if (!pos[0]) usage();
      await history(pos[0], pos[1], pos[2]);
      break;
    case 'positions':
      await positions(pos[0], 'json' in opts);
      break;
    case 'filings':
      if (!pos[0]) usage();
      await filings(pos[0], opts);
      break;
    case 'facts':
      if (!pos[0]) usage();
      await facts(pos[0]);
      break;
    default:
      usage();
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
