#!/usr/bin/env npx tsx
/**
 * One-time deep scrape: @alojoh timeline for the past 2 years,
 * then fetch price history for all mentioned tickers.
 *
 * Usage: npx tsx scripts/alojoh/backfill.ts
 */

import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(script: string, args: string[] = []): void {
  console.log(`\n→ npx tsx ${script} ${args.join(' ')}`);
  execFileSync('npx', ['tsx', script, ...args], {
    stdio: 'inherit',
    cwd: process.env.NANOCLAW_ROOT ?? process.cwd(),
  });
}

run(path.join(__dirname, 'fetch-timeline.ts'), ['--backfill']);
run(path.join(__dirname, 'fetch-prices.ts'));
