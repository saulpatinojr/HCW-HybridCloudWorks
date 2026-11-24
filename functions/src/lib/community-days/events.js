/**
 * community-days/events.js — one Community Days event, reduced to the fields
 * this site uses (#1823, ADR 0045). Pure functions; nothing here reads the
 * network or the store.
 *
 * EVERYTHING FROM THE API IS SOMEONE ELSE'S TEXT. An event's title, tagline,
 * page text and links are written by its organizers, not by this site. So:
 *
 *   - a link is kept only when it is a plain http or https address, so the
 *     page can never be handed a `javascript:` link to render;
 *   - the page text arrives as HTML and is turned into plain text here
 *     (`htmlToText`), cut to PAGE_TEXT_MAX characters, and the page renders
 *     it as text, never as HTML;
 *   - every string is cut to a fixed length, so one event cannot fill the
 *     cache document.
 *
 * DATES ARE CALENDAR DAYS. The API sends an event's dates in the event's own
 * local time with no zone on them (`2026-11-21T09:00`) and the zone's name
 * beside them. This site compares days, not instants: the day an event is
 * held is the day written in its own local time, wherever the reader is. So
 * only the leading `YYYY-MM-DD` is kept (`dayOf`), and no time zone
 * arithmetic is done.
 */

/** Characters of page text kept per event: enough for the estimate, small enough for 300 events in one document. */
export const PAGE_TEXT_MAX = 2500;
/** Events kept from one refresh. */
export const MAX_EVENTS = 300;
/** The public address of an event's page; its slug (start date and title) follows. */
export const EVENT_PAGE_BASE = 'https://www.communitydays.org/event/';

/** An event id this site will store under: letters, digits, dot, dash, underscore, at most 64. */
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isEventId = (value) => typeof value === 'string' && EVENT_ID.test(value);

const SLUG = /^\d{4}-\d{2}-\d{2}\/[a-z0-9][a-z0-9-]{0,120}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const COST_TIERS = Object.freeze(['Free', 'Low Cost', 'Paid']);

/** A trimmed string of at most `max` characters with control characters removed, or ''. */
export function text(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The value when it is an absolute http(s) address of a sane length, else null. */
export function httpUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > 500 || !/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** The leading `YYYY-MM-DD` of a date or local date-time, when it names a real day; else null. */
export function dayOf(value) {
  if (typeof value !== 'string') return null;
  const match = DAY.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  const real = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  return real ? match[0] : null;
}

const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

/**
 * HTML as plain text: tags removed, block ends turned into spaces, the few
 * common entities decoded once. The result is DATA for a prompt and text for
 * a page; it is never written back out as HTML, so this does not need to be
 * (and is not) an HTML sanitizer.
 *
 * @param {unknown} html
 * @param {number} [max]
 * @returns {string}
 */
export function htmlToText(html, max = PAGE_TEXT_MAX) {
  if (typeof html !== 'string') return '';
  // Cut first: no pattern below ever runs over more than this much text.
  const bounded = html.slice(0, max * 8);
  let out = '';
  let inTag = false;
  for (const char of bounded) {
    if (char === '<') {
      inTag = true;
      out += ' ';
    } else if (char === '>' && inTag) {
      inTag = false;
    } else if (!inTag) {
      out += char;
    }
  }
  const decoded = out.replace(/&(#\d{1,6}|#x[0-9a-f]{1,5}|[a-z]{2,6});/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (Object.hasOwn(ENTITIES, key)) return ENTITIES[key];
    if (key.startsWith('#')) {
      const code = key[1] === 'x' ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      // A decoded angle bracket stays text: nothing downstream reads this as HTML.
      return Number.isInteger(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return whole;
  });
  return text(decoded, max);
}

/**
 * One event as this site keeps it, or null when it has no usable id, title
 * or start day.
 *
 * @param {unknown} raw - one entry of the API's `events`
 * @returns {object|null}
 */
export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.RowKey === 'string' ? raw.RowKey.trim() : '';
  const title = text(raw.title, 160);
  const startDate = dayOf(raw.start_date);
  if (!isEventId(id) || !title || !startDate) return null;
  const endDay = dayOf(raw.end_date);
  const slug = typeof raw.slug === 'string' && SLUG.test(raw.slug.trim()) ? raw.slug.trim() : null;
  const tiers = Array.isArray(raw.cost_tiers) ? COST_TIERS.filter((tier) => raw.cost_tiers.includes(tier)) : [];
  return {
    id,
    title,
    tagline: text(raw.tagline, 200),
    // The event's page on Community Days, built here from its slug; never a link the API sent.
    url: slug ? `${EVENT_PAGE_BASE}${slug}` : null,
    website: httpUrl(raw.website),
    startDate,
    // An end before the start is treated as a one-day event.
    endDate: endDay && endDay >= startDate ? endDay : startDate,
    timezone: text(raw.timezone, 64),
    eventType: text(raw.event_type, 24),
    venue: text(raw.location, 120),
    city: text(raw.city, 80),
    region: text(raw.state_province, 80),
    country: text(raw.country, 2).toUpperCase(),
    costTiers: tiers,
    callUrl: httpUrl(raw.call_for_speakers_link),
    callOpens: dayOf(raw.speaker_call_start_date),
    callCloses: dayOf(raw.speaker_call_end_date),
    cancelled: raw.is_cancelled === true,
    postponed: raw.is_postponed === true,
    lastUpdate: typeof raw.last_update === 'string' && Number.isFinite(Date.parse(raw.last_update)) ? raw.last_update.slice(0, 30) : null,
    pageText: htmlToText(raw.home_content),
  };
}

/**
 * The API's events as this site keeps them: unusable ones dropped, one entry
 * per id, at most MAX_EVENTS, in the API's order (soonest first).
 *
 * @param {unknown[]} rawEvents
 * @returns {{ events: object[], skipped: number }}
 */
export function normalizeEvents(rawEvents) {
  const seen = new Set();
  const events = [];
  let skipped = 0;
  for (const raw of Array.isArray(rawEvents) ? rawEvents : []) {
    const event = normalizeEvent(raw);
    if (!event || seen.has(event.id)) {
      skipped += 1;
    } else if (events.length < MAX_EVENTS) {
      seen.add(event.id);
      events.push(event);
    } else {
      skipped += 1;
    }
  }
  return { events, skipped };
}

/** The titles of the owner's talks from GET /profile/talks, newest first, each once, at most 40. */
export function talkTitles(rawTalks) {
  const titles = [];
  for (const talk of Array.isArray(rawTalks) ? rawTalks : []) {
    const title = text(talk?.title, 160);
    if (title && !titles.some((kept) => kept.toLowerCase() === title.toLowerCase())) titles.push(title);
    if (titles.length >= 40) break;
  }
  return titles;
}

/** An event as the page is sent it: the page text shortened to an excerpt. */
export function presentEvent(event) {
  const { pageText, ...rest } = event;
  const excerpt = typeof pageText === 'string' ? pageText.slice(0, 320) : '';
  return { ...rest, excerpt, hasPageText: Boolean(pageText) };
}
