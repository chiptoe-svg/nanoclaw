/**
 * alojoh module — twice-daily scrape of @alojoh's X timeline plus market
 * prices, then re-renders the text reports the agent reads.
 *
 * Host-side only: the fetch scripts drive a logged-in Chrome profile
 * (data/x-browser-profile) via Playwright. Data and reports land in
 * groups/telegram_main/alojoh/, which the agent sees at /workspace/agent/alojoh/.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ALOJOH_DIR, getAlojohState } from '../../alojoh-db.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';

const ROOT = process.cwd();
const SCRIPTS_DIR = path.join(ROOT, 'scripts', 'alojoh');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
// Run at 8am and 8pm local time
const SCHEDULE_HOURS = [8, 20];
// Minimum hours between fetches (prevents double-run on restart)
const MIN_FETCH_INTERVAL_HOURS = 10;

let timer: NodeJS.Timeout | undefined;

function runScript(script: string, outFile?: string): Promise<void> {
  return new Promise((resolve) => {
    const out = outFile ? fs.openSync(outFile, 'w') : 'pipe';
    const proc = spawn(TSX, [path.join(SCRIPTS_DIR, `${script}.ts`)], {
      cwd: ROOT,
      env: { ...process.env, NANOCLAW_ROOT: ROOT },
      stdio: ['ignore', out, 'pipe'],
    });
    proc.stdout?.on('data', (d: Buffer) => {
      for (const line of d.toString().trim().split('\n')) {
        if (line) log.info('alojoh', { script, line });
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString().trim().split('\n')) {
        if (line) log.warn('alojoh', { script, line });
      }
    });
    const done = (err?: Error, code?: number | null) => {
      if (typeof out === 'number') fs.closeSync(out);
      if (err) log.error('alojoh script failed to spawn', { script, err });
      else if (code !== 0) log.error('alojoh script exited with error', { script, code });
      resolve();
    };
    proc.on('close', (code) => done(undefined, code));
    proc.on('error', (err) => done(err));
  });
}

async function runFetch(): Promise<void> {
  log.info('alojoh: fetch cycle starting');
  await runScript('fetch-timeline');
  await runScript('fetch-prices');

  const reportsDir = path.join(ALOJOH_DIR, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  await runScript('summary', path.join(reportsDir, 'alojoh-summary.txt'));
  await runScript('report', path.join(reportsDir, 'alojoh-vs-market.txt'));
  log.info('alojoh: fetch cycle complete');
}

function scheduleNext(signal: AbortSignal): void {
  if (signal.aborted) return;
  const now = new Date();
  const nextHour = SCHEDULE_HOURS.find((h) => h > now.getHours());
  const next = new Date(now);
  if (nextHour === undefined) next.setDate(next.getDate() + 1);
  next.setHours(nextHour ?? SCHEDULE_HOURS[0], 0, 0, 0);

  log.info('alojoh: next fetch scheduled', { nextRun: next.toISOString() });
  timer = setTimeout(() => {
    void runFetch().then(() => scheduleNext(signal));
  }, next.getTime() - now.getTime());
}

onHostStart(({ signal }) => {
  const lastFetch = getAlojohState('last_timeline_fetch');
  const hoursSince = lastFetch ? (Date.now() - new Date(lastFetch).getTime()) / 3_600_000 : Infinity;

  if (hoursSince >= MIN_FETCH_INTERVAL_HOURS) void runFetch();
  else log.info('alojoh: skipping immediate fetch (recent)', { lastFetch });

  scheduleNext(signal);
});

onHostShutdown(() => {
  if (timer) clearTimeout(timer);
  timer = undefined;
});
