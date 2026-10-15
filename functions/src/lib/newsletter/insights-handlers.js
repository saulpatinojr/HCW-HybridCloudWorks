/**
 * insights-handlers.js — Resend metrics, audience, domains, logs and templates
 * for the Mailing List page (#504). The API half; the page follows.
 *
 *   GET    /api/cms/mailing-list/metrics                              editor
 *   GET    /api/cms/mailing-list/broadcasts/{broadcastId}/clicked-links editor
 *   GET    /api/cms/mailing-list/broadcasts/{broadcastId}/recipients  editor
 *   GET    /api/cms/mailing-list/audience                             editor
 *   GET    /api/cms/mailing-list/audience/summary                     editor
 *   PATCH  /api/cms/mailing-list/audience/{contactId}                 publisher
 *   DELETE /api/cms/mailing-list/audience/{contactId}                 publisher
 *
 * Contacts are addressed by Resend's opaque contact id, never by email: a path
 * is recorded in request telemetry, and an address there would put a
 * subscriber's email in the logs.
 *   GET    /api/cms/mailing-list/domains                              editor
 *   POST   /api/cms/mailing-list/domains                              publisher
 *   GET    /api/cms/mailing-list/domains/{domainId}                   editor
 *   PATCH  /api/cms/mailing-list/domains/{domainId}                   publisher
 *   POST   /api/cms/mailing-list/domains/{domainId}/verify            publisher
 *   GET    /api/cms/mailing-list/logs                                 editor
 *   GET    /api/cms/mailing-list/logs/{logId}                         publisher
 *   GET    /api/cms/mailing-list/emails                               editor
 *   GET    /api/cms/mailing-list/templates                            editor
 *   GET    /api/cms/mailing-list/templates/{templateId}               editor
 *
 * ## Nothing here sends email
 *
 * Every Resend call goes through a fixed method on resend-client.js, and none
 * of them is `/emails` POST or `/broadcasts` POST. The writes are to contacts
 * (unsubscribe, delete) and to domains (add, verify, tracking), and each is
 * publisher-only. Domain delete is deliberately absent: removing a sending
 * domain stops the newsletter, and that belongs in Resend's own dashboard.
 *
 * ## Nothing the caller sends becomes a URL
 *
 * Path ids (contacts included) and cursors must match ID_PATTERN,
 * dates must be ISO, enums are checked against their lists and limits are
 * 1-100 — all before a key is read into a request. The client then
 * percent-encodes each value into a fixed template.
 *
 * ## What is returned, and what is logged
 *
 * Every answer is a projection onto named fields, so a field Resend adds later
 * does not reach the page unreviewed. A Resend refusal reaches the page as
 * `{ ok: false, status, error }`, where `error` is Resend's name and message
 * trimmed to 200 characters; a 429 is passed on as 429 with
 * `retryAfterSeconds`. Log lines carry the route name, an HTTP status and the
 * invocation id — never an address, a contact id, or any message text, because
 * Resend's messages can echo what was sent.
 */
import { readKey } from '../ai/router.js';
import {
  NEWSLETTER_SEGMENT_NAME,
  ensureConfirmedContact,
  resolveSegmentId,
  sendConfirmationEmail,
} from './handlers.js';
import { parseAddContactBody } from './validate.js';
import { ISSUE_ID_PATTERN } from './issue.js';
import { createResendClient } from './resend-client.js';
import { resolveFromAddress } from './sender.js';

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
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
/**
 * A hostname: labels of letters, digits and inner hyphens, a letter-only TLD.
 * Applied after trimming and lower-casing; the 253 cap is checked separately.
 */
const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

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
const ERROR_TEXT_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const badRequest = (error) => json(400, { ok: false, error });

/** Only the listed fields, and only those present. */
const pick = (row, fields) =>
  Object.fromEntries(
    fields.filter((field) => row?.[field] !== undefined).map((field) => [field, row[field]])
  );

const rowsOf = (result) => (Array.isArray(result?.data?.data) ? result.data.data : []);

// ── Redaction ───────────────────────────────────────────────────────────────

/** An address, with its at-sign literal or percent-encoded (`%40`), as a path built with encodeURIComponent carries it. */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gi;
const BEARER_IN_TEXT = /\bBearer\s+[^\s"',;]+/gi;
/** Resend keys start `re_`; anything that looks like one goes. */
const RESEND_KEY_IN_TEXT = /\bre_[A-Za-z0-9_-]{8,}/g;
const SENSITIVE_KEY = /authorization|api[-_]?key|secret|token|password|cookie|^key$/i;
export const REDACTED = '[redacted]';
export const REDACTED_EMAIL = '[redacted email]';
const MAX_REDACT_DEPTH = 20;

/** A string with bearer tokens, Resend keys and email addresses removed. */
export function redactText(text) {
  return String(text)
    .replace(BEARER_IN_TEXT, `Bearer ${REDACTED}`)
    .replace(RESEND_KEY_IN_TEXT, REDACTED)
    .replace(EMAIL_IN_TEXT, REDACTED_EMAIL);
}

/**
 * A deep copy of a log body with credentials and addresses removed: any value
 * under a key that names a credential is replaced whole, and every string (and
 * every key) has bearer tokens, Resend keys and email addresses taken out.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced with the REDACTED
 * marker rather than walked.
 */
export function redactSensitive(value, depth = 0) {
  if (depth > MAX_REDACT_DEPTH) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      const safeKey = redactText(key);
      out[safeKey] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/** `jane@example.com` → `j***@example.com`. Anything unrecognisable is fully masked. */
export function maskEmail(value) {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return '***';
  return `${value[0]}***@${value.slice(at + 1)}`;
}

// ── Query and body validation ───────────────────────────────────────────────

const queryValue = (request, name) => {
  const value = request.query?.get?.(name);
  return value === undefined || value === null ? null : String(value);
};

/** `{ value }` or `{ error }` for an optional 1-100 integer. */
function readLimit(request, fallback = DEFAULT_PAGE_LIMIT) {
  const raw = queryValue(request, 'limit');
  if (raw === null || raw === '') return { value: fallback };
  if (!/^\d{1,3}$/.test(raw)) return { error: 'limit must be a whole number from 1 to 100' };
  const value = Number(raw);
  if (value < 1 || value > 100) return { error: 'limit must be a whole number from 1 to 100' };
  return { value };
}

/** `{ value }` or `{ error }` for an optional cursor. */
function readCursor(request) {
  const raw = queryValue(request, 'after');
  if (raw === null || raw === '') return { value: undefined };
  if (!ID_PATTERN.test(raw)) return { error: 'after must be a cursor from a previous page' };
  return { value: raw };
}

function readPage(request) {
  const limit = readLimit(request);
  if (limit.error) return limit;
  const after = readCursor(request);
  if (after.error) return after;
  return { value: { limit: limit.value, after: after.value } };
}

function readPathId(request, name) {
  const raw = request.params?.[name];
  return typeof raw === 'string' && ID_PATTERN.test(raw) ? raw : null;
}

/** An ISO date or date-time that parses, or `{ error }`. */
function readDate(request, name) {
  const raw = queryValue(request, name);
  if (raw === null || raw === '') return { value: undefined };
  if (!ISO_DATE_PATTERN.test(raw) || !Number.isFinite(Date.parse(raw))) {
    return {
      error: `${name} must be an ISO 8601 date (YYYY-MM-DD) or date-time`,
    };
  }
  return { value: raw };
}

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The next-page cursor: the last row's id, when Resend says there is more. */
const nextCursor = (result, rows) => {
  if (!result?.data?.has_more || rows.length === 0) return null;
  const id = rows[rows.length - 1]?.id;
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : null;
};

// ── Projections ─────────────────────────────────────────────────────────────

const METRIC_ROW_FIELDS = ['period', 'broadcast_id', 'domain_id', 'domain_name', ...METRICS];
const DOMAIN_SUMMARY_FIELDS = ['id', 'name', 'status', 'region', 'created_at'];
const DOMAIN_DETAIL_FIELDS = [
  ...DOMAIN_SUMMARY_FIELDS,
  'open_tracking',
  'click_tracking',
  'tracking_subdomain',
];
const DOMAIN_RECORD_FIELDS = ['record', 'name', 'type', 'ttl', 'status', 'value', 'priority'];
const LOG_SUMMARY_FIELDS = ['id', 'created_at', 'method', 'response_status'];
const TEMPLATE_SUMMARY_FIELDS = ['id', 'name', 'alias', 'status', 'published_at'];
const TEMPLATE_VARIABLE_FIELDS = ['key', 'type', 'fallback_value'];

const projectMetricRow = (row) => pick(row, METRIC_ROW_FIELDS);
const projectTotals = (totals) => (isPlainObject(totals) ? pick(totals, METRICS) : {});
const projectDomain = (row) => pick(row, DOMAIN_SUMMARY_FIELDS);
const projectDomainDetail = (row) => ({
  ...pick(row, DOMAIN_DETAIL_FIELDS),
  records: Array.isArray(row?.records)
    ? row.records.map((record) => pick(record, DOMAIN_RECORD_FIELDS))
    : [],
});
const projectLog = (row) => ({
  ...pick(row, LOG_SUMMARY_FIELDS),
  // A path such as /contacts/{email} names a person; the list never does.
  ...(typeof row?.endpoint === 'string' ? { endpoint: redactText(row.endpoint) } : {}),
});
const projectTemplate = (row) => ({
  ...pick(row, TEMPLATE_SUMMARY_FIELDS),
  variables: Array.isArray(row?.variables)
    ? row.variables.map((variable) => pick(variable, TEMPLATE_VARIABLE_FIELDS))
    : [],
});
const projectEmail = (row) => ({
  id: row?.id ?? null,
  to: (Array.isArray(row?.to) ? row.to : row?.to ? [row.to] : []).map(maskEmail),
  subject: typeof row?.subject === 'string' ? row.subject : null,
  created_at: row?.created_at ?? null,
  last_event: row?.last_event ?? null,
});
const projectRecipient = (row) => ({
  email: row?.email ?? null,
  count: row?.count ?? null,
  bounce_type: row?.bounce_type ?? null,
  clicked_links: Array.isArray(row?.clicked_links)
    ? row.clicked_links.map((link) => pick(link, ['url', 'clicks']))
    : [],
});
const projectClickedLink = (row) => pick(row, ['url', 'clicks', 'unique_clicks']);
const projectContact = (row) => ({
  id: row?.id ?? null,
  email: row?.email ?? null,
  first_name: row?.first_name ?? null,
  last_name: row?.last_name ?? null,
  created_at: row?.created_at ?? null,
  unsubscribed: row?.unsubscribed === true,
});

const AUDIENCE_CSV_HEADER = 'email,first_name,last_name,joined,status';

/** One contact as an audience CSV row: email, names, joined, subscribed or not. */
const csvRowFor = (contact) =>
  [
    contact.email,
    contact.first_name,
    contact.last_name,
    contact.created_at,
    contact.unsubscribed ? 'unsubscribed' : 'subscribed',
  ]
    .map(csvCell)
    .join(',');

/**
 * Every page of the segment, SUMMARY_PAGE_SIZE contacts at a time, handed to
 * `onRows` up to `maxPages`. `{ truncated }` says whether the cap stopped it
 * short of the end; a Resend refusal comes back as `{ refusal }` for the
 * route to pass on. No segment yet means no pages.
 */
async function eachSegmentPage(client, segmentId, maxPages, onRows) {
  if (!segmentId) return { truncated: false };
  let after;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const listed = await client.listSegmentContacts(segmentId, { limit: SUMMARY_PAGE_SIZE, after });
    if (!listed.ok) return { refusal: listed };
    const rows = rowsOf(listed);
    onRows(rows);
    after = nextCursor(listed, rows);
    if (!after) return { truncated: false };
  }
  return { truncated: true };
}

/**
 * Every contact of the segment as CSV lines, header first, paging to
 * EXPORT_MAX_PAGES and ending with a comment row when it stopped short. A
 * Resend refusal comes back as `{ refusal }` for the route to pass on.
 */
async function collectAudienceCsv(client, segmentId) {
  const lines = [AUDIENCE_CSV_HEADER];
  const paged = await eachSegmentPage(client, segmentId, EXPORT_MAX_PAGES, (rows) => {
    for (const row of rows) lines.push(csvRowFor(projectContact(row)));
  });
  if (paged.refusal) return { refusal: paged.refusal };
  if (paged.truncated) {
    lines.push(
      `# truncated: the list is longer than ${EXPORT_MAX_PAGES * SUMMARY_PAGE_SIZE} contacts`
    );
  }
  return { lines };
}

/**
 * Every matching contact of the whole segment (`scope=all`): Resend has no
 * contact search, so every page is read here, to EXPORT_MAX_PAGES (ADR 0033
 * Amplify slice). `{ value }` is the answer's body; `{ refusal }` a Resend
 * refusal.
 */
async function searchWholeSegment(client, segmentId, matches) {
  const contacts = [];
  const paged = await eachSegmentPage(client, segmentId, EXPORT_MAX_PAGES, (rows) => {
    contacts.push(...rows.map(projectContact).filter(matches));
  });
  if (paged.refusal) return paged;
  return {
    value: {
      ok: true,
      segmentFound: true,
      contacts,
      has_more: false,
      next_after: null,
      searchScope: 'all',
      truncated: paged.truncated,
    },
  };
}

/** Counts for the whole segment, to SUMMARY_MAX_PAGES. `{ value }` or `{ refusal }`. */
async function countSegment(client, segmentId) {
  let total = 0;
  let unsubscribed = 0;
  const paged = await eachSegmentPage(client, segmentId, SUMMARY_MAX_PAGES, (rows) => {
    total += rows.length;
    unsubscribed += rows.filter((row) => row?.unsubscribed === true).length;
  });
  if (paged.refusal) return paged;
  return {
    value: { total, subscribed: total - unsubscribed, unsubscribed, truncated: paged.truncated },
  };
}

/** A CSV download: CRLF line ends, a trailing newline, never cached. */
const csvAttachment = (filename, lines) => ({
  status: 200,
  headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  },
  body: `${lines.join('\r\n')}\r\n`,
});

// ── Route plumbing ──────────────────────────────────────────────────────────

const ref = (context) => `[invocation ${context?.invocationId ?? 'unknown'}]`;

/**
 * A Resend failure as an HTTP answer. Logs the route, the status and the
 * invocation only; Resend's name and message go to the caller, trimmed.
 */
function refused(route, result, context) {
  const status = result?.status ?? 0;
  context.warn?.(`${route} Resend HTTP ${status} ${ref(context)}`);
  // Resend's error name (a code such as `validation_error`) and the status;
  // Resend's own sentence is a provider's words and stays out (#945).
  const name = typeof result?.data?.name === 'string' ? result.data.name : '';
  const text = status
    ? `Resend refused the request (HTTP ${status}${name ? ` ${name}` : ''}).`
    : `No answer from Resend${name ? ` (${name})` : ''}.`;
  const error = text.slice(0, ERROR_TEXT_LIMIT);
  if (status === 429) {
    const seconds = Number.parseInt(String(result?.retryAfter ?? ''), 10);
    const retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 1;
    return json(
      429,
      { ok: false, status, retryAfterSeconds, error },
      { 'Retry-After': String(retryAfterSeconds) }
    );
  }
  return json(502, { ok: false, status, error });
}

/** An exception as a 500. The error's name is logged; nothing else of it is. */
function failed(route, error, context) {
  const name = typeof error?.name === 'string' ? error.name : 'Error';
  context.error?.(`${route} failed ${name} ${ref(context)}`);
  return json(500, {
    ok: false,
    error: 'The Newsletter Hub request failed.',
  });
}

/** GET through `call`, projecting the successful body with `project`. */
async function relay(route, context, call, project) {
  const result = await call();
  if (!result.ok) return refused(route, result, context);
  return json(200, { ok: true, ...project(result) });
}

/**
 * A write through `call`, acknowledged with `{ ok: true, ...body }` and a
 * content-free log line. `onOk` runs first on success (cache invalidation).
 */
async function acknowledged(route, context, call, { body = {}, onOk } = {}) {
  const result = await call();
  if (!result.ok) return refused(route, result, context);
  onOk?.();
  context.log?.(`${route} ok ${ref(context)}`);
  return json(200, { ok: true, ...body });
}

/** One page of rows under `key`, with Resend's paging beside it. */
function pageOf(result, key, project) {
  const rows = rowsOf(result);
  return {
    [key]: rows.map(project),
    has_more: Boolean(result.data?.has_more),
    next_after: nextCursor(result, rows),
  };
}

/**
 * A route: the role, then the key (`ctx.open`), then `body` inside the
 * catch-all that turns an exception into a content-free 500. `body` gets
 * `{ client, auth, request, context, route }`.
 */
const handler = (ctx, route, role, body) => async (request, context) => {
  const opened = await ctx.open(request, role);
  if (opened.response) return opened.response;
  try {
    return await body({ ...opened, request, context, route });
  } catch (error) {
    return failed(route, error, context);
  }
};

/**
 * The Newsletter segment's id, found by name and never created: these are
 * reads, and creating a segment is confirm's job (handlers.js). `{ id }`
 * (null when there is no such segment yet) or `{ result }` for a refusal.
 */
async function findNewsletterSegment(client) {
  let after;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const listed = await client.listSegments(after);
    if (!listed.ok) return { result: listed };
    const rows = rowsOf(listed);
    const found = rows.find((row) => row?.name === NEWSLETTER_SEGMENT_NAME);
    if (found?.id) return { id: found.id };
    if (!listed.data?.has_more || rows.length === 0) break;
    after = rows[rows.length - 1].id;
  }
  return { id: null };
}

// ── Request readers: `{ error }` or the checked value ───────────────────────

/** `broadcast_id` or `issue_id`, at most one, each in its own shape. */
function readMetricsIds(request) {
  const broadcastRaw = queryValue(request, 'broadcast_id');
  const issueRaw = queryValue(request, 'issue_id');
  if (broadcastRaw && issueRaw) return { error: 'Send broadcast_id or issue_id, not both' };
  if (broadcastRaw && !ID_PATTERN.test(broadcastRaw)) {
    return { error: 'broadcast_id is not a Resend id' };
  }
  if (issueRaw && !ISSUE_ID_PATTERN.test(issueRaw)) {
    return { error: 'issue_id must be issue-YYYY-MM-DD' };
  }
  return { broadcastRaw, issueRaw };
}

/** `start_date` and `end_date`, defaulted to the last DEFAULT_METRICS_DAYS days, in order. */
function readMetricsWindow(request, now) {
  const start = readDate(request, 'start_date');
  if (start.error) return start;
  const end = readDate(request, 'end_date');
  if (end.error) return end;
  const endDate = end.value ?? now().toISOString();
  const startDate =
    start.value ?? new Date(Date.parse(endDate) - DEFAULT_METRICS_DAYS * DAY_MS).toISOString();
  if (Date.parse(startDate) > Date.parse(endDate)) {
    return { error: 'start_date must not be after end_date' };
  }
  return { startDate, endDate };
}

/** `granularity`, one of GRANULARITIES, daily when absent. */
function readGranularity(request) {
  const granularity = queryValue(request, 'granularity') || 'daily';
  if (!GRANULARITIES.includes(granularity)) {
    return { error: `granularity must be one of ${GRANULARITIES.join(', ')}` };
  }
  return { granularity };
}

/** The whole metrics query, checked. */
function readMetricsQuery(request, now) {
  const ids = readMetricsIds(request);
  if (ids.error) return ids;
  const window = readMetricsWindow(request, now);
  if (window.error) return window;
  const granularity = readGranularity(request);
  if (granularity.error) return granularity;
  return { ...ids, ...window, ...granularity };
}

/**
 * The broadcast the metrics are for: the `broadcast_id` as sent, or the
 * issue's recorded broadcast. `{ response }` when the issue is missing or
 * was never sent.
 */
async function broadcastForQuery(store, { broadcastRaw, issueRaw }) {
  if (!issueRaw) return { broadcastId: broadcastRaw || undefined };
  const issue = await store.readDoc('newsletters', issueRaw, issueRaw);
  if (!issue || issue.kind !== 'weekly_issue' || issue.status === 'deleted') {
    return { response: json(404, { ok: false, error: 'Issue not found' }) };
  }
  if (typeof issue.broadcastId !== 'string' || !ID_PATTERN.test(issue.broadcastId)) {
    return {
      response: json(404, {
        ok: false,
        code: 'NO_BROADCAST',
        error: 'This issue has not been sent to Resend, so it has no metrics yet.',
      }),
    };
  }
  return { broadcastId: issue.broadcastId };
}

/** The audience page: `?limit&after` and an optional `search`, length-capped. */
function readAudienceQuery(request) {
  const page = readPage(request);
  if (page.error) return page;
  const search = queryValue(request, 'search');
  if (search !== null && search.length > MAX_SEARCH_LENGTH) {
    return { error: `search must be at most ${MAX_SEARCH_LENGTH} characters` };
  }
  return { page: page.value, search };
}

/** A contact id from the path, in Resend's shape, or null. */
function readContactId(request) {
  const contactId = String(request.params?.contactId ?? '');
  return ID_PATTERN.test(contactId) ? contactId : null;
}

/** `{ unsubscribed }` from a body that holds exactly that boolean. */
function readUnsubscribedBody(body) {
  if (!isPlainObject(body)) return { error: 'Send a JSON body { unsubscribed: true | false }' };
  const unknown = Object.keys(body).filter((key) => key !== 'unsubscribed');
  if (unknown.length) return { error: `Unknown field(s): ${unknown.join(', ')}` };
  if (typeof body.unsubscribed !== 'boolean')
    return { error: 'unsubscribed must be true or false' };
  return { unsubscribed: body.unsubscribed };
}

/** `{ name, region }` from a body naming a sending domain and, optionally, its region. */
function readDomainBody(body) {
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

const TRACKING_FIELDS = ['open_tracking', 'click_tracking'];

/** `{ openTracking, clickTracking }` from a body with at least one of the two booleans. */
function readTrackingBody(body) {
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

// ── Detail projections ──────────────────────────────────────────────────────

/** A log with its bodies, redacted of credentials and addresses. */
const projectLogDetail = (data) => ({
  ...projectLog(data),
  ...(typeof data?.user_agent === 'string' ? { user_agent: redactText(data.user_agent) } : {}),
  request_body: redactSensitive(data?.request_body ?? null),
  response_body: redactSensitive(data?.response_body ?? null),
});

const projectTemplateDetail = (data) => ({
  ...projectTemplate(data),
  html: typeof data?.html === 'string' ? data.html : null,
});

// ── Routes ──────────────────────────────────────────────────────────────────
//
// Each takes the factory's `ctx` and the opened call: `{ client, auth,
// request, context, route }`. The role check, the key and the catch-all are
// `handler`'s, so a body only validates, calls Resend and projects.

async function metrics(ctx, { client, request, context, route }) {
  const query = readMetricsQuery(request, ctx.now);
  if (query.error) return badRequest(query.error);
  const target = await broadcastForQuery(ctx.store, query);
  if (target.response) return target.response;
  const { broadcastId } = target;
  const { startDate, endDate, granularity } = query;
  return relay(
    route,
    context,
    () =>
      client.getEmailMetrics({
        startDate,
        endDate,
        metrics: METRICS,
        // One row per broadcast when asking about one; a time series otherwise.
        dimensions: broadcastId ? ['broadcast'] : ['period'],
        granularity,
        broadcastId,
      }),
    ({ data }) => ({
      start_date: data?.start_date ?? startDate,
      end_date: data?.end_date ?? endDate,
      granularity: data?.granularity ?? granularity,
      broadcast_id: broadcastId ?? null,
      totals: projectTotals(data?.totals),
      data: Array.isArray(data?.data) ? data.data.map(projectMetricRow) : [],
    })
  );
}

async function clickedLinks(ctx, { client, request, context, route }) {
  const broadcastId = readPathId(request, 'broadcastId');
  if (!broadcastId) return badRequest('broadcastId is not a Resend id');
  const page = readPage(request);
  if (page.error) return badRequest(page.error);
  return relay(
    route,
    context,
    () => client.listBroadcastClickedLinks(broadcastId, page.value),
    (result) => pageOf(result, 'links', projectClickedLink)
  );
}

async function recipients(ctx, { client, request, context, route }) {
  const broadcastId = readPathId(request, 'broadcastId');
  if (!broadcastId) return badRequest('broadcastId is not a Resend id');
  const type = queryValue(request, 'type');
  if (!type || !RECIPIENT_TYPES.includes(type)) {
    return badRequest(`type must be one of ${RECIPIENT_TYPES.join(', ')}`);
  }
  const page = readPage(request);
  if (page.error) return badRequest(page.error);
  return relay(
    route,
    context,
    () => client.listBroadcastRecipients(broadcastId, { type, ...page.value }),
    (result) => ({ type, ...pageOf(result, 'recipients', projectRecipient) })
  );
}

/**
 * One page of the Newsletter segment. `search` filters THAT PAGE by a
 * case-insensitive email substring; it does not search the whole list, so
 * `has_more` and `next_after` still describe Resend's paging. With
 * `scope=all` and a search, every page is read and every match answered
 * (searchWholeSegment).
 */
async function audience(ctx, { client, request, context, route }) {
  const query = readAudienceQuery(request);
  if (query.error) return badRequest(query.error);
  const segment = await ctx.segmentId(client);
  if (segment.result) return refused(route, segment.result, context);
  if (!segment.id) {
    return json(200, {
      ok: true,
      segmentFound: false,
      contacts: [],
      has_more: false,
      next_after: null,
      searchScope: 'page',
    });
  }
  const needle = query.search ? query.search.trim().toLowerCase() : '';
  const matches = (contact) =>
    !needle ||
    String(contact.email ?? '')
      .toLowerCase()
      .includes(needle);
  if (needle && queryValue(request, 'scope') === 'all') {
    const found = await searchWholeSegment(client, segment.id, matches);
    return found.refusal ? refused(route, found.refusal, context) : json(200, found.value);
  }
  return relay(
    route,
    context,
    () => client.listSegmentContacts(segment.id, query.page),
    (result) => {
      const rows = rowsOf(result);
      return {
        segmentFound: true,
        contacts: rows.map(projectContact).filter(matches),
        has_more: Boolean(result.data?.has_more),
        next_after: nextCursor(result, rows),
        searchScope: 'page',
      };
    }
  );
}

/**
 * Counts for the whole segment, paging 100 at a time up to
 * SUMMARY_MAX_PAGES; `truncated` says the cap was hit. Cached per process
 * for SUMMARY_CACHE_MS, successes only.
 */
async function audienceSummary(ctx, { client, context, route }) {
  const at = ctx.now().getTime();
  const cached = ctx.readSummary();
  if (cached && at - cached.at < SUMMARY_CACHE_MS) {
    return json(200, {
      ok: true,
      ...cached.value,
      cachedAt: new Date(cached.at).toISOString(),
    });
  }
  const segment = await ctx.segmentId(client);
  if (segment.result) return refused(route, segment.result, context);
  const counted = await countSegment(client, segment.id);
  if (counted.refusal) return refused(route, counted.refusal, context);
  ctx.writeSummary({ at, value: counted.value });
  return json(200, {
    ok: true,
    ...counted.value,
    cachedAt: new Date(at).toISOString(),
  });
}

/**
 * PUBLISHER. The whole Newsletter segment as CSV (ADR 0033 Amplify slice):
 * email, first name, last name, joined, status. Publisher because it is
 * every subscriber's address in one file. Pages to EXPORT_MAX_PAGES and
 * says so in a trailing comment row when it stopped short.
 */
async function exportAudience(ctx, { client, context, route }) {
  const segment = await ctx.segmentId(client);
  if (segment.result) return refused(route, segment.result, context);
  const collected = await collectAudienceCsv(client, segment.id);
  if (collected.refusal) return refused(route, collected.refusal, context);
  context.log?.(`${route} ${collected.lines.length - 1} row(s) ${ref(context)}`);
  const day = ctx.now().toISOString().slice(0, 10);
  return csvAttachment(`newsletter-audience-${day}.csv`, collected.lines);
}

/**
 * Invite mode of addContact (ADR 0033 Amplify slice): double opt-in
 * respected. The address gets the same signed confirmation link the signup
 * form sends, and nothing is written to the list until it is opened.
 */
async function inviteContact(ctx, { client, context, route }, email) {
  const sent = await sendConfirmationEmail({
    client,
    apiKey: readKey(ctx.env, 'RESEND_API_KEY'),
    email,
    source: 'website',
    now: () => ctx.now().getTime(),
    from: await resolveFromAddress(ctx.store, context),
  });
  if (!sent.ok) return refused(route, sent, context);
  context.log?.(`${route} invited ${ref(context)}`);
  return json(202, {
    ok: true,
    mode: 'invite',
    message: 'A confirmation link was emailed. The address joins the list when it is opened.',
  });
}

/**
 * Confirmed mode of addContact: consent was recorded elsewhere, so the
 * contact is added subscribed with the same read-back the public confirm
 * does, and the consent date is written beside the audit trail — never in a
 * log line. The cached audience summary is dropped.
 */
async function addConfirmedContact(
  ctx,
  { client, auth, context, route },
  { email, mode, consentRecordedOn }
) {
  const segment = await resolveSegmentId(client);
  const ensured = await ensureConfirmedContact({ client, email, segmentId: segment });
  if (!ensured.ok) {
    context.warn?.(`${route} not confirmed: ${ensured.why} ${ref(context)}`);
    return json(502, {
      ok: false,
      error: `Resend did not confirm the contact: ${ensured.why}`,
    });
  }
  ctx.invalidateSummary();
  await ctx.store.upsertDoc?.('admin_audit_logs', {
    id: `newsletter-consent-${ctx.now().getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    action: 'newsletter_subscriber_added',
    userId: auth?.user?.oid ?? null,
    timestamp: ctx.now().toISOString(),
    details: { consentRecordedOn, mode, emailMasked: maskEmail(email) },
    compliance: {
      schemaVersion: 1,
      detailsSanitized: true,
      identityVerified: true,
    },
  });
  context.log?.(`${route} confirmed ${ref(context)}`);
  return json(200, {
    ok: true,
    mode,
    consentRecordedOn,
    message: 'Added as a confirmed subscriber.',
  });
}

/**
 * PUBLISHER. Add a subscriber from the admin (ADR 0033 Amplify slice).
 * Body `{ email, mode, consentRecordedOn? }`:
 *
 *   mode: 'invite'     double opt-in respected — the address gets the same
 *                      signed confirmation link the signup form sends, and
 *                      nothing is written to the list until it is opened.
 *   mode: 'confirmed'  consent was recorded elsewhere (a conference form,
 *                      a written request); `consentRecordedOn` is required,
 *                      a date, and the contact is added subscribed with
 *                      the same read-back the public confirm does.
 */
async function addContact(ctx, call) {
  const body = await call.request.json().catch(() => null);
  const parsed = parseAddContactBody(body, ctx.now().getTime());
  if (parsed.error) return badRequest(parsed.error);
  return parsed.mode === 'invite'
    ? inviteContact(ctx, call, parsed.email)
    : addConfirmedContact(ctx, call, parsed);
}

/** PUBLISHER. Body `{ unsubscribed: boolean }` only. */
async function updateContact(ctx, { client, request, context, route }) {
  const contactId = readContactId(request);
  if (!contactId) return badRequest('The path must carry a Resend contact id');
  const parsed = readUnsubscribedBody(await request.json().catch(() => null));
  if (parsed.error) return badRequest(parsed.error);
  return acknowledged(
    route,
    context,
    () => client.setContactUnsubscribed(contactId, parsed.unsubscribed),
    { onOk: ctx.invalidateSummary }
  );
}

/** PUBLISHER. Removes the contact from Resend altogether, not just the segment. */
async function deleteContact(ctx, { client, request, context, route }) {
  const contactId = readContactId(request);
  if (!contactId) return badRequest('The path must carry a Resend contact id');
  return acknowledged(route, context, () => client.deleteContact(contactId), {
    onOk: ctx.invalidateSummary,
  });
}

async function listDomains(ctx, { client, context, route }) {
  return relay(
    route,
    context,
    () => client.listDomains(),
    (result) => ({ domains: rowsOf(result).map(projectDomain) })
  );
}

async function getDomain(ctx, { client, request, context, route }) {
  const domainId = readPathId(request, 'domainId');
  if (!domainId) return badRequest('domainId is not a Resend id');
  return relay(
    route,
    context,
    () => client.getDomain(domainId),
    (result) => ({ domain: projectDomainDetail(result.data) })
  );
}

/** PUBLISHER. Body `{ name, region? }`. */
async function createDomain(ctx, { client, request, context, route }) {
  const parsed = readDomainBody(await request.json().catch(() => null));
  if (parsed.error) return badRequest(parsed.error);
  const result = await client.createDomain({ name: parsed.name, region: parsed.region });
  if (!result.ok) return refused(route, result, context);
  context.log?.(`${route} ok ${ref(context)}`);
  return json(201, { ok: true, domain: projectDomainDetail(result.data) });
}

/** PUBLISHER. Asks Resend to check the DNS records again. */
async function verifyDomain(ctx, { client, request, context, route }) {
  const domainId = readPathId(request, 'domainId');
  if (!domainId) return badRequest('domainId is not a Resend id');
  return acknowledged(route, context, () => client.verifyDomain(domainId), {
    body: { id: domainId },
  });
}

/** PUBLISHER. Body `{ open_tracking?, click_tracking? }`, booleans, at least one. */
async function updateDomain(ctx, { client, request, context, route }) {
  const domainId = readPathId(request, 'domainId');
  if (!domainId) return badRequest('domainId is not a Resend id');
  const parsed = readTrackingBody(await request.json().catch(() => null));
  if (parsed.error) return badRequest(parsed.error);
  return acknowledged(
    route,
    context,
    () =>
      client.updateDomainTracking(domainId, {
        openTracking: parsed.openTracking,
        clickTracking: parsed.clickTracking,
      }),
    { body: { id: domainId } }
  );
}

/** PUBLISHER: request and response bodies, redacted of credentials and addresses. */
async function getLog(ctx, { client, request, context, route }) {
  const logId = readPathId(request, 'logId');
  if (!logId) return badRequest('logId is not a Resend id');
  return relay(
    route,
    context,
    () => client.getLog(logId),
    ({ data }) => ({ log: projectLogDetail(data) })
  );
}

async function getTemplate(ctx, { client, request, context, route }) {
  const templateId = readPathId(request, 'templateId');
  if (!templateId) return badRequest('templateId is not a Resend id');
  return relay(
    route,
    context,
    () => client.getTemplate(templateId),
    ({ data }) => ({ template: projectTemplateDetail(data) })
  );
}

/** A paged list: `?limit&after` relayed to the client's `method`, rows projected under `key`. */
const pagedList = (method, key, project) =>
  async function list(ctx, { client, request, context, route }) {
    const page = readPage(request);
    if (page.error) return badRequest(page.error);
    return relay(
      route,
      context,
      () => client[method](page.value),
      (result) => pageOf(result, key, project)
    );
  };

/** Every route: the name its log lines carry, the role it requires, its body. */
const ROUTES = Object.freeze({
  metrics: ['mailingListMetrics', 'editor', metrics],
  clickedLinks: ['mailingListClickedLinks', 'editor', clickedLinks],
  recipients: ['mailingListRecipients', 'editor', recipients],
  audience: ['mailingListAudience', 'editor', audience],
  audienceSummary: ['mailingListAudienceSummary', 'editor', audienceSummary],
  exportAudience: ['mailingListAudienceExport', 'publisher', exportAudience],
  addContact: ['mailingListContactAdd', 'publisher', addContact],
  updateContact: ['mailingListContactUpdate', 'publisher', updateContact],
  deleteContact: ['mailingListContactDelete', 'publisher', deleteContact],
  listDomains: ['mailingListDomains', 'editor', listDomains],
  getDomain: ['mailingListDomain', 'editor', getDomain],
  createDomain: ['mailingListDomainCreate', 'publisher', createDomain],
  verifyDomain: ['mailingListDomainVerify', 'publisher', verifyDomain],
  updateDomain: ['mailingListDomainUpdate', 'publisher', updateDomain],
  listLogs: ['mailingListLogs', 'editor', pagedList('listLogs', 'logs', projectLog)],
  getLog: ['mailingListLog', 'publisher', getLog],
  listEmails: ['mailingListEmails', 'editor', pagedList('listEmails', 'emails', projectEmail)],
  listTemplates: [
    'mailingListTemplates',
    'editor',
    pagedList('listTemplates', 'templates', projectTemplate),
  ],
  getTemplate: ['mailingListTemplate', 'editor', getTemplate],
});

// ── The factory's shared opening and caches ─────────────────────────────────

const notConfigured = () =>
  json(503, {
    ok: false,
    error: 'Resend is not configured: RESEND_API_KEY is not set',
  });

/** A Resend client on the key, or null without one. */
function resendClientOrNull(env, fetchImpl) {
  const apiKey = readKey(env, 'RESEND_API_KEY');
  return apiKey ? createResendClient({ apiKey, fetch: fetchImpl }) : null;
}

/**
 * The route's common opening: role, then the key. `{ client, auth }` or
 * `{ response }`. Role first, so an under-privileged caller learns nothing
 * about configuration.
 */
async function openRoute({ guard, env, fetchImpl }, request, role) {
  const auth = await guard.requireRole(request, role);
  if (auth?.error) return { response: auth.error };
  const client = resendClientOrNull(env, fetchImpl);
  if (!client) return { response: notConfigured() };
  return { client, auth };
}

/**
 * The Newsletter segment's id, found once per process: it does not change.
 * Only a found id is cached; a refusal or a not-yet-created segment is asked
 * again next time.
 */
function segmentIdCache() {
  let promise = null;
  return (client) => {
    if (!promise) {
      promise = findNewsletterSegment(client).then((found) => {
        if (!found.id) promise = null;
        return found;
      });
    }
    return promise;
  };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function }} deps.store
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetch]
 * @param {() => Date} [deps.now]
 */
export function createNewsletterInsightsHandlers({
  guard,
  store,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  /** Per process: `{ at, value }` of the last audience summary. */
  let summaryCache = null;

  /** What the routes need from this factory. The summary cache is state, so it is read and written through functions. */
  const ctx = {
    env,
    store,
    now,
    open: (request, role) => openRoute({ guard, env, fetchImpl }, request, role),
    segmentId: segmentIdCache(),
    readSummary: () => summaryCache,
    writeSummary: (entry) => {
      summaryCache = entry;
    },
    invalidateSummary: () => {
      summaryCache = null;
    },
  };

  return Object.fromEntries(
    Object.entries(ROUTES).map(([name, [route, role, body]]) => [
      name,
      handler(ctx, route, role, (call) => body(ctx, call)),
    ])
  );
}
