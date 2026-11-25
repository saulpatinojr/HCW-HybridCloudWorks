/**
 * insights-shared.js — the fixed lists, limits and small helpers the Mailing
 * List page's routes share (insights-handlers.js says what the routes do,
 * and exports the limits again).
 */

/** Audience export and whole-list search page at most this far (ADR 0033 Amplify slice). */
export const EXPORT_MAX_PAGES = 50;
/** One CSV cell, RFC 4180: quoted when it holds a comma, quote or newline. */
export const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  // A cell starting with a formula character is prefixed so a spreadsheet
  // opens it as text, never as a formula (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Resend ids (UUIDs) and the opaque cursors it pages with. */
export const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** A date, or a date-time in UTC or with an offset. */
export const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
/**
 * A hostname: labels of letters, digits and inner hyphens, a letter-only TLD.
 * Applied after trimming and lower-casing; the 253 cap is checked separately.
 */
export const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const METRICS = Object.freeze([
  'sent',
  'delivered',
  'opened',
  'unique_opened',
  'clicked',
  'unique_clicked',
  'bounced',
  'complained',
  'unsubscribed',
  'delivery_rate',
  'open_rate',
  'click_rate',
  'bounce_rate',
  'complaint_rate',
  'unsubscribe_rate',
]);
export const GRANULARITIES = Object.freeze(['hourly', 'daily', 'weekly', 'monthly']);
export const RECIPIENT_TYPES = Object.freeze([
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'complained',
  'unsubscribed',
  'suppressed',
]);
export const DOMAIN_REGIONS = Object.freeze([
  'us-east-1',
  'eu-west-1',
  'sa-east-1',
  'ap-northeast-1',
]);

export const DEFAULT_METRICS_DAYS = 30;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_SEARCH_LENGTH = 100;
export const MAX_HOSTNAME_LENGTH = 253;
/** Audience summary: at most this many pages of 100 before it says `truncated`. */
export const SUMMARY_MAX_PAGES = 20;
export const SUMMARY_PAGE_SIZE = 100;
export const SUMMARY_CACHE_MS = 10 * 60 * 1000;
export const ERROR_TEXT_LIMIT = 200;

export const DAY_MS = 24 * 60 * 60 * 1000;

export const json = (status, body, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export const badRequest = (error) => json(400, { ok: false, error });

/** Only the listed fields, and only those present. */
export const pick = (row, fields) =>
  Object.fromEntries(
    fields.filter((field) => row?.[field] !== undefined).map((field) => [field, row[field]])
  );

export const rowsOf = (result) => (Array.isArray(result?.data?.data) ? result.data.data : []);

