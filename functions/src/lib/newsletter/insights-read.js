/**
 * insights-read.js — reading and checking what a Mailing List page request
 * carries (query values, path ids, bodies) before anything reaches Resend.
 * Each reader answers `{ error }` or the checked value (insights-handlers.js
 * holds the routes).
 */
import { DEFAULT_PAGE_LIMIT, ID_PATTERN, ISO_DATE_PATTERN, MAX_SEARCH_LENGTH, MAX_HOSTNAME_LENGTH, HOSTNAME_PATTERN, DOMAIN_REGIONS } from './insights-shared.js';

// ── Query and body validation ───────────────────────────────────────────────

export const queryValue = (request, name) => {
  const value = request.query?.get?.(name);
  return value === undefined || value === null ? null : String(value);
};

/** `{ value }` or `{ error }` for an optional 1-100 integer. */
export function readLimit(request, fallback = DEFAULT_PAGE_LIMIT) {
  const raw = queryValue(request, 'limit');
  if (raw === null || raw === '') return { value: fallback };
  if (!/^\d{1,3}$/.test(raw)) return { error: 'limit must be a whole number from 1 to 100' };
  const value = Number(raw);
  if (value < 1 || value > 100) return { error: 'limit must be a whole number from 1 to 100' };
  return { value };
}

/** `{ value }` or `{ error }` for an optional cursor. */
export function readCursor(request) {
  const raw = queryValue(request, 'after');
  if (raw === null || raw === '') return { value: undefined };
  if (!ID_PATTERN.test(raw)) return { error: 'after must be a cursor from a previous page' };
  return { value: raw };
}

export function readPage(request) {
  const limit = readLimit(request);
  if (limit.error) return limit;
  const after = readCursor(request);
  if (after.error) return after;
  return { value: { limit: limit.value, after: after.value } };
}

export function readPathId(request, name) {
  const raw = request.params?.[name];
  return typeof raw === 'string' && ID_PATTERN.test(raw) ? raw : null;
}

/** An ISO date or date-time that parses, or `{ error }`. */
export function readDate(request, name) {
  const raw = queryValue(request, name);
  if (raw === null || raw === '') return { value: undefined };
  if (!ISO_DATE_PATTERN.test(raw) || !Number.isFinite(Date.parse(raw))) {
    return {
      error: `${name} must be an ISO 8601 date (YYYY-MM-DD) or date-time`,
    };
  }
  return { value: raw };
}

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The next-page cursor: the last row's id, when Resend says there is more. */
export const nextCursor = (result, rows) => {
  if (!result?.data?.has_more || rows.length === 0) return null;
  const id = rows[rows.length - 1]?.id;
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : null;
};

// ── Request readers: `{ error }` or the checked value ───────────────────────

/** The audience page: `?limit&after` and an optional `search`, length-capped. */
export function readAudienceQuery(request) {
  const page = readPage(request);
  if (page.error) return page;
  const search = queryValue(request, 'search');
  if (search !== null && search.length > MAX_SEARCH_LENGTH) {
    return { error: `search must be at most ${MAX_SEARCH_LENGTH} characters` };
  }
  return { page: page.value, search };
}

/** A contact id from the path, in Resend's shape, or null. */
export function readContactId(request) {
  const contactId = String(request.params?.contactId ?? '');
  return ID_PATTERN.test(contactId) ? contactId : null;
}

/** `{ unsubscribed }` from a body that holds exactly that boolean. */
export function readUnsubscribedBody(body) {
  if (!isPlainObject(body)) return { error: 'Send a JSON body { unsubscribed: true | false }' };
  const unknown = Object.keys(body).filter((key) => key !== 'unsubscribed');
  if (unknown.length) return { error: `Unknown field(s): ${unknown.join(', ')}` };
  if (typeof body.unsubscribed !== 'boolean')
    return { error: 'unsubscribed must be true or false' };
  return { unsubscribed: body.unsubscribed };
}

/** `{ name, region }` from a body naming a sending domain and, optionally, its region. */
export function readDomainBody(body) {
  if (!isPlainObject(body)) return { error: 'Send a JSON body { name }' };
  const unknown = Object.keys(body).filter((key) => !['name', 'region'].includes(key));
  if (unknown.length) return { error: `Unknown field(s): ${unknown.join(', ')}` };
  const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  if (!name || name.length > MAX_HOSTNAME_LENGTH || !HOSTNAME_PATTERN.test(name)) {
    return { error: 'name must be a domain name such as news.example.com' };
  }
  if (body.region !== undefined && !DOMAIN_REGIONS.includes(body.region)) {
    return { error: `region must be one of ${DOMAIN_REGIONS.join(', ')}` };
  }
  return { name, region: body.region };
}

export const TRACKING_FIELDS = ['open_tracking', 'click_tracking'];

/** `{ openTracking, clickTracking }` from a body with at least one of the two booleans. */
export function readTrackingBody(body) {
  if (!isPlainObject(body)) {
    return { error: 'Send a JSON body { open_tracking, click_tracking }' };
  }
  const unknown = Object.keys(body).filter((key) => !TRACKING_FIELDS.includes(key));
  if (unknown.length) return { error: `Unknown field(s): ${unknown.join(', ')}` };
  const present = TRACKING_FIELDS.filter((key) => body[key] !== undefined);
  if (present.length === 0) return { error: 'Send open_tracking, click_tracking or both' };
  if (present.some((key) => typeof body[key] !== 'boolean')) {
    return { error: 'open_tracking and click_tracking must be true or false' };
  }
  return { openTracking: body.open_tracking, clickTracking: body.click_tracking };
}

