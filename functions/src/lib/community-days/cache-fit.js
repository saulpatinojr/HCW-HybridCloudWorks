/**
 * community-days/cache-fit.js — fitting the events into the one stored copy
 * (a database document has a size limit). Split out of cache.js, which
 * re-exports it.
 */
import { cutToBytes, PAGE_TEXT_MAX_BYTES } from './events.js';

/**
 * The most bytes the stored events may take together. The database's limit
 * for one document is 2 MB; this leaves room for the talks, the other fields
 * and the fields the database adds.
 */
export const CACHE_EVENTS_MAX_BYTES = 1_500_000;

const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * The events that fit in `maxBytes` once stored. Page texts are shortened
 * first (halved until the list fits, down to nothing); if the list is still
 * too large, events are dropped from the end, which keeps the soonest.
 *
 * @param {object[]} events - as events.js reduces them, soonest first
 * @param {number} [maxBytes]
 * @returns {{ events: object[], dropped: number }}
 */
export function fitEvents(events, maxBytes = CACHE_EVENTS_MAX_BYTES) {
  let kept = events;
  let cap = PAGE_TEXT_MAX_BYTES;
  while (bytesOf(kept) > maxBytes && cap > 0) {
    cap = cap > 150 ? Math.floor(cap / 2) : 0;
    const limit = cap;
    kept = kept.map((event) => ({ ...event, pageText: cutToBytes(event.pageText ?? '', limit) }));
  }
  if (bytesOf(kept) <= maxBytes) return { events: kept, dropped: 0 };
  // Still too large with no page text at all: count each event once and keep
  // the ones from the front that fit (2 bytes for the list's brackets, 1 per comma).
  const fitting = [];
  let used = 2;
  for (const event of kept) {
    const size = bytesOf(event) + 1;
    if (used + size > maxBytes) break;
    used += size;
    fitting.push(event);
  }
  return { events: fitting, dropped: kept.length - fitting.length };
}
