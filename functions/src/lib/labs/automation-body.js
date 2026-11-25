/**
 * labs/automation-body.js — the body the lab host's Coder automation sends
 * (coder-automation.js has the route and the header that explains it),
 * checked key by key: a renewed status token shaped like a Coder key, and a
 * report whose every field has a fixed shape and whose past events are not
 * in the future. No sentence it returns carries the token.
 * coder-automation.js re-exports what callers use.
 */
import { CODER_API_KEY_PATTERN } from './coder-status.js';

export const MAX_TEMPLATE_VERSION_LENGTH = 64;
export const MAX_LAST_ERROR_LENGTH = 300;

/** The body's keys. Anything else is refused. */
export const BODY_FIELDS = Object.freeze(['agentId', 'statusToken', 'report']);

/** The report's keys, by kind. Anything else is refused. */
export const REPORT_FIELDS = Object.freeze({
  checkedAt: 'date',
  statusTokenExpiresAt: 'date',
  statusTokenRotatedAt: 'date',
  rotationTokenExpiresAt: 'date',
  templatePushedAt: 'date',
  templateVersion: 'version',
  templateDigest: 'digest',
  templateSourceDigest: 'digest',
  lastError: 'error',
});

/**
 * The report's dates that say when something already happened, and so may
 * not be in the future by more than MAX_CLOCK_SKEW_MS (see the header). The
 * two expiries are rightly in the future and are not among them.
 */
export const PAST_EVENT_FIELDS = Object.freeze(['checkedAt', 'statusTokenRotatedAt', 'templatePushedAt']);

/** How far ahead of the site's clock the host's may run before a report is refused. */
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

/**
 * An ISO 8601 date-time: a calendar date, `T`, hours, minutes and seconds, an
 * optional fraction, and a zone (`Z` or an offset). `date -u
 * +%Y-%m-%dT%H:%M:%SZ`, Python's isoformat with a zone, and Coder's own
 * `expires_at` all match; a bare date, a local time with no zone, and an
 * epoch number do not.
 */
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)$/;

/** A Coder API key anywhere in a string, for redacting `lastError`. */
const EMBEDDED_KEY = /[A-Za-z0-9]{10}-[A-Za-z0-9]{22}/g;
export const REDACTED_KEY = '[a Coder API key, removed]';

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A key named in a refusal: quoted, and cut short, since it came from the caller. */
const quoteKey = (key) => JSON.stringify(String(key).slice(0, 40));

/**
 * The time an ISO date-time names, normalised to `toISOString`, or null.
 * The calendar date is checked too, because `Date.parse` rolls 30 February
 * over into March rather than refusing it.
 */
export function parseIsoDateTime(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return new Date(ms).toISOString();
}

function dateValue(key, raw) {
  const iso = parseIsoDateTime(raw);
  return iso
    ? { value: iso }
    : { error: `report.${key} must be an ISO 8601 date-time with a zone, such as 2026-10-08T04:30:00Z` };
}

/**
 * The template version, which the card shows. Refused when it carries
 * anything shaped like a Coder key (CodeRabbit review of #1030): the report is
 * token-free, and this field is stored and served back as it came, so a key
 * copied into it would reach the document and the editor read.
 */
function versionValue(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'report.templateVersion must be a non-empty string' };
  }
  if (raw.length > MAX_TEMPLATE_VERSION_LENGTH) {
    return { error: `report.templateVersion must be at most ${MAX_TEMPLATE_VERSION_LENGTH} characters` };
  }
  if (new RegExp(EMBEDDED_KEY.source).test(raw)) {
    return { error: 'report.templateVersion must not carry a Coder API key' };
  }
  return { value: raw.trim() };
}

/** lastError, with anything shaped like a Coder key replaced, not refused: an error line may quote one. */
function errorValue(raw) {
  if (typeof raw !== 'string') return { error: 'report.lastError must be a string' };
  if (raw.length > MAX_LAST_ERROR_LENGTH) {
    return { error: `report.lastError must be at most ${MAX_LAST_ERROR_LENGTH} characters` };
  }
  return { value: raw.replace(EMBEDDED_KEY, REDACTED_KEY).trim() };
}

/** The host's template_digest (hcw-coder-automation.py): SHA-256, 64 lower-case hex characters. */
const TEMPLATE_DIGEST = /^[0-9a-f]{64}$/;

function digestValue(key, raw) {
  return typeof raw === 'string' && TEMPLATE_DIGEST.test(raw)
    ? { value: raw }
    : { error: `report.${key} must be a SHA-256 digest: 64 lower-case hex characters` };
}

/** One report field, checked and normalised: `{ value }` or `{ error }`. */
function reportValue(key, kind, raw) {
  if (kind === 'date') return dateValue(key, raw);
  if (kind === 'version') return versionValue(raw);
  if (kind === 'digest') return digestValue(key, raw);
  return errorValue(raw);
}

/** The first past-event date that is ahead of the site's clock by more than the skew, as a refusal; or null. */
function clockRefusal(report, nowMs) {
  const ahead = PAST_EVENT_FIELDS.find(
    (key) => report[key] !== undefined && Date.parse(report[key]) - nowMs > MAX_CLOCK_SKEW_MS
  );
  if (!ahead) return null;
  return `report.${ahead} is more than ${MAX_CLOCK_SKEW_MS / 60_000} minutes ahead of the site's clock; check the lab host's clock`;
}

/** The report, checked key by key: `{ report }` or `{ error }`. */
function parseReport(raw, nowMs) {
  if (!isPlainObject(raw)) return { error: 'report must be a JSON object' };
  const unknown = Object.keys(raw).find((key) => !Object.hasOwn(REPORT_FIELDS, key));
  if (unknown !== undefined) {
    return {
      error: `report.${quoteKey(unknown)} is not a field a report carries: ${Object.keys(REPORT_FIELDS).join(', ')}`,
    };
  }
  if (raw.checkedAt === undefined) return { error: 'report.checkedAt is required' };
  const report = {};
  for (const [key, kind] of Object.entries(REPORT_FIELDS)) {
    if (raw[key] === undefined) continue;
    const checked = reportValue(key, kind, raw[key]);
    if (checked.error) return { error: checked.error };
    report[key] = checked.value;
  }
  const ahead = clockRefusal(report, nowMs);
  return ahead ? { error: ahead } : { report };
}

/**
 * The body, checked: `{ value: { statusToken, report } }` or `{ error }`, the
 * error a sentence for the 400. Pure given `nowMs` (the site's clock, for the
 * past-event dates), and the token never appears in a sentence it returns.
 */
export function parseAutomationBody(body, nowMs = Date.now()) {
  const shape = bodyFieldsRefusal(body);
  if (shape) return { error: shape };
  const token = statusTokenOf(body.statusToken);
  if (token.error) return token;
  const parsed = body.report === undefined ? { error: 'report is required' } : parseReport(body.report, nowMs);
  if (parsed.error) return { error: parsed.error };
  return { value: { statusToken: token.statusToken, report: parsed.report } };
}

/** Why the body is not an object of this route's fields, or null. */
function bodyFieldsRefusal(body) {
  if (!isPlainObject(body)) return 'The body must be a JSON object';
  const unknown = Object.keys(body).find((key) => !BODY_FIELDS.includes(key));
  if (unknown === undefined) return null;
  return `${quoteKey(unknown)} is not a field this route reads: the body carries ${BODY_FIELDS.join(', ')} only`;
}

/** The renewed token, when one was sent: `{ statusToken }` (null when none), or `{ error }` for one not shaped like a Coder key. */
function statusTokenOf(value) {
  if (value === undefined) return { statusToken: null };
  if (typeof value !== 'string' || !CODER_API_KEY_PATTERN.test(value)) {
    return {
      error:
        'statusToken is not a Coder API key: a 10-character id, a dash and a 22-character secret, letters and digits only',
    };
  }
  return { statusToken: value };
}
