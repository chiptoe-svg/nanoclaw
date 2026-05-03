#!/usr/bin/env npx tsx
/**
 * Fetch @alojoh's X timeline and store to alojoh.db
 *
 * Usage:
 *   npx tsx scripts/alojoh/fetch-timeline.ts             # incremental (stops at known posts)
 *   npx tsx scripts/alojoh/fetch-timeline.ts --backfill  # deep scrape (2 years back)
 */

import { chromium } from 'playwright';

import { config, cleanupLockFiles } from '../../.claude/skills/x-integration/lib/browser.js';
import {
  getLatestPostId,
  postExists,
  setAlojohState,
  upsertPost,
} from '../../src/alojoh-db.js';

const ALOJOH_URL = 'https://x.com/alojoh';
const TWO_YEARS_AGO = new Date(
  Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000,
).toISOString();

const TICKER_RE = /\$([A-Z]{1,6})(?![a-z\d])/g;

function extractTickers(text: string): string[] {
  const matches = new Set<string>();
  TICKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TICKER_RE.exec(text)) !== null) {
    matches.add(m[1]);
  }
  return Array.from(matches);
}

async function fetchTimeline(opts: { backfill: boolean }): Promise<void> {
  const cutoffDate = opts.backfill ? TWO_YEARS_AGO : null;
  const latestKnownId = opts.backfill ? null : getLatestPostId();

  console.log(
    `[alojoh] ${opts.backfill ? 'backfill' : 'incremental'} fetch starting`,
  );
  if (latestKnownId)
    console.log(`[alojoh] stopping at known post ${latestKnownId}`);
  if (cutoffDate) console.log(`[alojoh] cutoff: ${cutoffDate}`);

  cleanupLockFiles();

  const context = await chromium.launchPersistentContext(config.browserDataDir, {
    executablePath: config.chromePath,
    headless: config.headless,
    viewport: config.viewport,
    args: config.chromeArgs,
    ignoreDefaultArgs: config.chromeIgnoreDefaultArgs,
  });

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(ALOJOH_URL, {
      timeout: 30000,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(3000);

    const isLoggedIn = await page
      .locator('[data-testid="SideNav_AccountSwitcher_Button"]')
      .isVisible()
      .catch(() => false);
    if (!isLoggedIn) {
      console.error('[alojoh] Not logged in. Run /x-integration to authenticate.');
      process.exit(1);
    }

    let postsCollected = 0;
    let shouldStop = false;
    const seenIds = new Set<string>();
    let noNewScrolls = 0;

    while (!shouldStop) {
      const articles = await page
        .locator('article[data-testid="tweet"]')
        .all();

      let newThisPass = 0;

      for (const article of articles) {
        try {
          const href = await article
            .locator('a[href*="/status/"]')
            .first()
            .getAttribute('href')
            .catch(() => null);
          if (!href) continue;

          const idMatch = href.match(/\/status\/(\d+)/);
          if (!idMatch) continue;
          const tweetId = idMatch[1];

          if (seenIds.has(tweetId)) continue;
          seenIds.add(tweetId);
          newThisPass++;

          // Incremental stop: hit a post we already have
          if (!opts.backfill && postExists(tweetId)) {
            shouldStop = true;
            break;
          }

          const datetime = await article
            .locator('time')
            .first()
            .getAttribute('datetime')
            .catch(() => null);
          if (!datetime) continue;

          // Backfill cutoff
          if (cutoffDate && datetime < cutoffDate) {
            shouldStop = true;
            break;
          }

          const text = await article
            .locator('[data-testid="tweetText"]')
            .first()
            .innerText()
            .catch(() => '');

          const isSubscriberOnly = await article
            .locator('[data-testid="socialContext"]')
            .getByText(/subscriber/i)
            .count()
            .then((c) => c > 0)
            .catch(() => false);

          upsertPost({
            id: tweetId,
            text,
            created_at: datetime,
            url: `https://x.com/alojoh/status/${tweetId}`,
            tickers: extractTickers(text),
            is_subscriber_only: isSubscriberOnly,
          });

          postsCollected++;
          if (postsCollected % 100 === 0) {
            console.log(`[alojoh] collected ${postsCollected} posts...`);
          }
        } catch {
          // skip malformed elements
        }
      }

      if (shouldStop) break;

      // Detect end-of-timeline: no new posts after 3 consecutive scrolls
      if (newThisPass === 0) {
        noNewScrolls++;
        if (noNewScrolls >= 3) break;
      } else {
        noNewScrolls = 0;
      }

      await page.evaluate(() => window.scrollBy(0, 2000));
      await page.waitForTimeout(2500);
    }

    console.log(`[alojoh] done, ${postsCollected} new posts stored`);
    setAlojohState('last_timeline_fetch', new Date().toISOString());
  } finally {
    await context.close();
  }
}

const args = process.argv.slice(2);
await fetchTimeline({ backfill: args.includes('--backfill') });
