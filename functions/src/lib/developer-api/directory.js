/**
 * developer-api/directory.js — the two public reads of the Developer API
 * (ADR 0042): published events and speakers. Pure; the handlers read the
 * snapshot and pass it in.
 *
 * WHERE THE DATA COMES FROM. Both read the `speakerevents` snapshot (the
 * `_snapshots/speakerevents` document the admin's Publish button writes,
 * lib/snapshots-publish.js), which is already public at
 * `GET /api/public/snapshots/speakerevents`. Its sanitizer is the real
 * boundary: it drops unticked events and every field the public page does
 * not render. These functions only filter and narrow it further, so this API
 * makes nothing public that was not public already, and nothing here can
 * publish (ADR 0042 decision 6).
 *
 * In Phase 1 the speakers are the site owner's own speaker profile (the
 * snapshot's `meta.speakerProfile`, fed by Sessionize) with the talks from
 * their published events. Phase 2's organizer-owned events and accepted
 * speakers can extend this list; they are not public today.
 */
import { DeveloperApiInputError } from './keys.js';

export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_EVENT_LIMIT = 100;
export const MAX_QUERY_LENGTH = 100;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The `from`, `to`, `q` and `limit` query values, checked. */
export function readEventFilters(query) {
  const get = (name) => {
    const value = query?.get?.(name);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  const from = get('from');
  const to = get('to');
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value && (!DAY_RE.test(value) || Number.isNaN(Date.parse(value)))) {
      throw new DeveloperApiInputError(`${name} must be a date as YYYY-MM-DD.`);
    }
  }
  if (from && to && from > to) throw new DeveloperApiInputError('from must be on or before to.');
  const q = readSearch(query);
  const rawLimit = get('limit');
  let limit = DEFAULT_EVENT_LIMIT;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
      throw new DeveloperApiInputError(`limit must be a whole number from 1 to ${MAX_EVENT_LIMIT}.`);
    }
  }
  return { from, to, q, limit };
}

/** The `q` query value, lower-cased, or null. */
export function readSearch(query) {
  const value = query?.get?.('q');
  if (typeof value !== 'string' || !value.trim()) return null;
  const q = value.trim().toLowerCase();
  if (q.length > MAX_QUERY_LENGTH) {
    throw new DeveloperApiInputError(`q must be at most ${MAX_QUERY_LENGTH} characters.`);
  }
  return q;
}

const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const dayOf = (value) => {
  const s = str(value);
  return s && DAY_RE.test(s.slice(0, 10)) ? s.slice(0, 10) : null;
};
const httpUrl = (value) => {
  const s = str(value);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

/** The published rows of a snapshot: shown on the site, with a name. Tombstones are skipped. */
function publishedRows(snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  return items.filter((item) => item && typeof item === 'object' && item.display === true && str(item.name));
}

/** One published event, narrowed to what an organizer's code needs. */
export function presentEvent(item) {
  const sessions = Array.isArray(item.sessions)
    ? item.sessions
        .filter((s) => s && str(s.title))
        .map((s) => ({ title: str(s.title), slidesUrl: httpUrl(s.slidesUrl), videoUrl: httpUrl(s.videoUrl) }))
    : [];
  return {
    id: String(item.id),
    name: str(item.name),
    date: dayOf(item.date),
    location: str(item.location),
    description: str(item.description),
    eventUrl: httpUrl(item.eventUrl),
    status: str(item.status),
    sessionizeId: item.sessionizeId === undefined || item.sessionizeId === null ? null : String(item.sessionizeId),
    sessions,
  };
}

const matches = (q, values) => !q || values.some((v) => typeof v === 'string' && v.toLowerCase().includes(q));

/**
 * The published events matching the filters, soonest first (undated last).
 *
 * @returns {{ events: object[], total: number }}
 */
export function listPublishedEvents(snapshot, { from = null, to = null, q = null, limit = DEFAULT_EVENT_LIMIT } = {}) {
  const events = publishedRows(snapshot)
    .map(presentEvent)
    .filter((event) => (!from || (event.date && event.date >= from)) && (!to || (event.date && event.date <= to)))
    .filter((event) =>
      matches(q, [event.name, event.location, event.description, ...event.sessions.map((s) => s.title)]),
    )
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.name.localeCompare(b.name));
  return { events: events.slice(0, limit), total: events.length };
}

/**
 * The speakers matching `q`: in Phase 1, the site owner's profile, with each
 * talk from a published event.
 *
 * @returns {{ speakers: object[] }}
 */
export function listSpeakers(snapshot, { q = null } = {}) {
  const profile = snapshot?.meta?.speakerProfile;
  const name = str(profile?.name);
  if (!name) return { speakers: [] };
  const sessionizeId = str(snapshot?.meta?.speakerId);
  const talks = publishedRows(snapshot).flatMap((item) => {
    const event = presentEvent(item);
    return event.sessions.map((s) => ({ title: s.title, eventId: event.id, eventName: event.name, date: event.date }));
  });
  const speaker = {
    id: sessionizeId ? `sessionize:${sessionizeId}` : 'site-owner',
    name,
    bio: str(profile.bio),
    headshotUrl: httpUrl(profile.headshotUrl),
    links: Array.isArray(profile.links)
      ? profile.links
          .filter((l) => l && httpUrl(l.url))
          .map((l) => ({ label: str(l.label) || httpUrl(l.url), url: httpUrl(l.url) }))
      : [],
    sessionizeId,
    talks,
  };
  if (!matches(q, [speaker.name, speaker.bio, ...talks.map((t) => t.title)])) return { speakers: [] };
  return { speakers: [speaker] };
}
