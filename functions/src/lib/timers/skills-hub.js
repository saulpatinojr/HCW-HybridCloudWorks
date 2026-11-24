/**
 * skills-hub.js — `scrapeSkillsHubRss`, weekly: certification lifecycle
 * events (beta launches, retirements, GA, exam updates) from the Microsoft
 * Skills Hub blog feed into `certEvents`. Never creates articles.
 *
 * Ported from Site-Main index.js (088f458). Upstream ran at 09:00 UTC and so
 * does this: `0 0 9 * * 5` on a UTC app clock (#416). It was `0 0 4 * * 5`
 * while the clock was America/Chicago — the same instant in summer, an hour
 * late in winter. That DST drift is gone.
 */

import { errorFacts } from '../http/error-response.js';
import { feedErrorCode } from '../rss/feed-error-code.js';
export const MS_SKILLS_RSS =
  'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=skills-hub-blog';

export const CERT_EVENT_PATTERNS = [
  { regex: /beta\s+exam|new\s+beta|beta\s+launch/i, type: 'beta_launch' },
  { regex: /retir|expir|sunset/i, type: 'retirement' },
  { regex: /generally\s+available|now\s+live|ga\s+today|exits?\s+beta/i, type: 'ga_launch' },
  { regex: /exam\s+update|certification\s+update|new\s+cert/i, type: 'update' },
];

const DATE_MENTION_RE =
  /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2}/gi;

/** Exam codes like AZ-104, AI-103, AB-620. */
export function extractExamCodes(text) {
  const matches = String(text || '').match(/\b([A-Z]{2,3}-\d{3,4})\b/g);
  return matches ? [...new Set(matches)] : [];
}

export function certEventDocId(item) {
  const key = item.guid || item.link || item.title || '';
  return Buffer.from(String(key))
    .toString('base64')
    .replace(/[/+=]/g, (c) => ({ '/': '_', '+': '-', '=': '' })[c])
    .slice(0, 128);
}

/** The certEvents document for a feed item, or null when it is not a lifecycle event. */
export function buildCertEvent(item, now) {
  const fullText = `${item.title || ''} ${item.contentSnippet || ''} ${item.content || ''}`;
  const type = CERT_EVENT_PATTERNS.find((p) => p.regex.test(fullText))?.type;
  if (!type) return null;
  const pubDate = item.pubDate ? new Date(item.pubDate) : now;
  return {
    id: certEventDocId(item),
    type,
    certCodes: extractExamCodes(fullText),
    title: item.title || '',
    summary: String(item.contentSnippet || '').slice(0, 500),
    link: item.link || '',
    pubDate: (Number.isNaN(pubDate.getTime()) ? now : pubDate).toISOString(),
    mentionedDates: fullText.match(DATE_MENTION_RE) || [],
    createdAt: now.toISOString(),
    source: 'skills-hub-rss',
  };
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function }} deps.store
 * @param {{ parseURL: (url: string) => Promise<{items?: object[]}> }} deps.parser
 */
export function createSkillsHubScrape({ store, parser, now = () => new Date(), log = {} }) {
  async function run() {
    let feed;
    try {
      feed = await parser.parseURL(MS_SKILLS_RSS);
    } catch (err) {
      // A code read from the feed library's known message shapes
      // (feedErrorCode): `HTTP_404`, `TIMEOUT`, `PARSE`. Never the message.
      log.error?.(`[skillsHubRss] Failed to fetch RSS feed: ${feedErrorCode(err)} (${errorFacts(err)})`);
      return { written: 0, skipped: 0, error: feedErrorCode(err) };
    }
    let written = 0;
    let skipped = 0;
    for (const item of feed.items || []) {
      const event = buildCertEvent(item, now());
      if (!event) {
        skipped += 1;
        continue;
      }
      if (await store.readDoc('certEvents', event.id, event.id)) {
        skipped += 1;
        continue;
      }
      await store.upsertDoc('certEvents', event);
      written += 1;
    }
    log.log?.(`[skillsHubRss] Done — written: ${written}, skipped: ${skipped}`);
    return { written, skipped };
  }
  return { run };
}
