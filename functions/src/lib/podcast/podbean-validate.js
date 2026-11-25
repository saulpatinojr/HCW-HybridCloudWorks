/**
 * podbean-validate.js — the checks the Podbean client (podbean.js) makes
 * before it sends anything: a content type, a statistics date range and
 * period, an episode id, the analytic report's types, an upload's name and
 * size. Each returns the clean value or throws a VALIDATION PodbeanError,
 * so a bad value is refused here rather than as a 400 that names neither
 * the parameter nor the value. podbean.js exports the period lists again.
 */
import { PodbeanError } from './podbean-error.js';

/** `period` for the download, country, platform and source statistics: daily or monthly keys. */
export const STATS_PERIODS = Object.freeze(['d', 'm']);
/** `period` for user retention: monthly or weekly cohorts. */
export const RETENTION_PERIODS = Object.freeze(['m', 'w']);
/** The `types` the analytic report documents. */
export const ANALYTIC_REPORT_TYPES = Object.freeze([
  'followers',
  'likes',
  'comments',
  'total_episode_length',
]);

const refuse = (message) => new PodbeanError(message, { status: null, code: 'VALIDATION', retryable: false });

/**
 * A bare `type/subtype` media type, no parameters, per RFC 2045 token
 * characters. `audio/mpeg`, `audio/mp4` pass; `audio/mpeg; charset=x`, an
 * empty string and whitespace do not.
 */
const MIME_SHAPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

/**
 * The one rule for a content type, shared by the two calls that must agree on
 * it: `authorizeUpload` sends it as `content_type`, and `uploadMedia` sends it
 * as the PUT's `Content-Type`, which the presigned URL is signed for.
 * Trimmed, non-empty, `type/subtype`, or refused before any network call —
 * never defaulted, because a default applied in one place and not the other
 * is exactly the mismatch the storage host would reject.
 */
export function contentTypeOrRefuse(value, where) {
  const type = typeof value === 'string' ? value.trim() : '';
  if (!type || !MIME_SHAPE.test(type)) {
    throw refuse(`${where} needs a content type shaped like audio/mpeg; got ${JSON.stringify(value ?? null)}.`);
  }
  return type;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A statistics date, `YYYY-MM-DD` and a real calendar day, or refused before
 * any request. Podbean's own examples use this shape and nothing else; a
 * `Date`, an ISO timestamp or `2026-2-3` would reach it as a 400 whose text
 * names neither the parameter nor the value.
 */
function dateOrRefuse(value, name) {
  const text = typeof value === 'string' ? value.trim() : '';
  const real = DATE_SHAPE.test(text) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);
  if (!real) {
    throw refuse(`A statistics read needs ${name} as YYYY-MM-DD; got ${JSON.stringify(value ?? null)}.`);
  }
  return text;
}

/** A `period` from the set the endpoint documents, or refused before any request. */
export function periodOrRefuse(value, allowed) {
  if (!allowed.includes(value)) {
    throw refuse(`A statistics read needs period as one of ${allowed.join(', ')}; got ${JSON.stringify(value ?? null)}.`);
  }
  return value;
}

/** `{ start, end, period }` validated together, as the four range statistics take them. */
export function rangeOrRefuse({ start, end, period = 'd' } = {}) {
  const from = dateOrRefuse(start, 'start');
  const to = dateOrRefuse(end, 'end');
  if (from > to) {
    throw refuse(`A statistics read needs start (${from}) on or before end (${to}).`);
  }
  return { start: from, end: to, period: periodOrRefuse(period, STATS_PERIODS) };
}

/** An episode id as Podbean issues them: a non-empty string, trimmed. Refused before any request. */
export function episodeIdOrRefuse(value, where) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) {
    throw refuse(`${where} needs an episode id; got ${JSON.stringify(value ?? null)}.`);
  }
  return id;
}

/** The analytic report's types: a non-empty list, every one documented. */
export function analyticTypesOrRefuse(types) {
  const list = Array.isArray(types) ? types : [];
  const unknown = list.filter((type) => !ANALYTIC_REPORT_TYPES.includes(type));
  if (!list.length || unknown.length) {
    throw refuse(
      `An analytic report read needs types from ${ANALYTIC_REPORT_TYPES.join(', ')}; got ${JSON.stringify(types ?? null)}.`
    );
  }
  return list;
}

/** An upload's filename (trimmed, non-empty) and size (a positive whole number of bytes). */
export function uploadFileOrRefuse(filename, filesize) {
  const name = typeof filename === 'string' ? filename.trim() : '';
  if (!name) {
    throw new PodbeanError('An upload authorisation needs a filename.', {
      status: null,
      code: 'VALIDATION',
    });
  }
  if (!Number.isInteger(filesize) || filesize <= 0) {
    throw new PodbeanError(
      `An upload authorisation needs the file size in bytes; got ${JSON.stringify(filesize ?? null)}.`,
      { status: null, code: 'VALIDATION' }
    );
  }
  return name;
}
