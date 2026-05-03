import { spawn } from 'child_process';
import path from 'path';

import { getAlojohState } from './alojoh-db.js';
import { logger } from './logger.js';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts', 'alojoh');
// Run at 8am and 8pm local time
const SCHEDULE_HOURS = [8, 20];
// Minimum hours between fetches (prevents double-run on restart)
const MIN_FETCH_INTERVAL_HOURS = 10;

function spawnFetch(script: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn(
      'npx',
      ['tsx', path.join(SCRIPTS_DIR, `${script}.ts`)],
      {
        cwd: process.cwd(),
        env: { ...process.env, NANOCLAW_ROOT: process.cwd() },
        stdio: 'pipe',
      },
    );

    proc.stdout.on('data', (d: Buffer) => {
      for (const line of d.toString().trim().split('\n')) {
        if (line) logger.info({ script }, line);
      }
    });
    proc.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString().trim().split('\n')) {
        if (line) logger.warn({ script }, line);
      }
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        logger.error({ script, code }, 'alojoh script exited with error');
      }
      resolve();
    });

    proc.on('error', (err) => {
      logger.error({ script, err }, 'Failed to spawn alojoh script');
      resolve();
    });
  });
}

async function runFetch(): Promise<void> {
  logger.info('alojoh: running timeline fetch');
  await spawnFetch('fetch-timeline');
  logger.info('alojoh: running price fetch');
  await spawnFetch('fetch-prices');
  logger.info('alojoh: fetch cycle complete');
}

function scheduleNext(): void {
  const now = new Date();
  const currentHour = now.getHours();

  const nextHour = SCHEDULE_HOURS.find((h) => h > currentHour);
  const hoursAhead = nextHour !== undefined ? 0 : 1;
  const targetHour = nextHour ?? SCHEDULE_HOURS[0];

  const next = new Date(now);
  next.setDate(next.getDate() + hoursAhead);
  next.setHours(targetHour, 0, 0, 0);

  const delay = next.getTime() - now.getTime();
  logger.info({ nextRun: next.toISOString() }, 'alojoh: next fetch scheduled');

  setTimeout(() => {
    void runFetch().then(() => scheduleNext());
  }, delay);
}

export function startAlojohScheduler(): void {
  const lastFetch = getAlojohState('last_timeline_fetch');
  let runNow = true;

  if (lastFetch) {
    const hoursSince =
      (Date.now() - new Date(lastFetch).getTime()) / (1000 * 60 * 60);
    runNow = hoursSince >= MIN_FETCH_INTERVAL_HOURS;
  }

  if (runNow) {
    void runFetch();
  } else {
    logger.info({ lastFetch }, 'alojoh: skipping immediate fetch (recent)');
  }

  scheduleNext();
}
