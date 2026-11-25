/**
 * insights-project.js — what the Mailing List page is told: projections of
 * Resend's rows, the audience CSV, and the paging over the Newsletter
 * segment (insights-handlers.js holds the routes).
 */
import { METRICS, pick, csvCell, SUMMARY_PAGE_SIZE, rowsOf, EXPORT_MAX_PAGES, SUMMARY_MAX_PAGES } from './insights-shared.js';
import { isPlainObject, nextCursor } from './insights-read.js';
import { redactText, maskEmail, redactSensitive } from './insights-redact.js';

// ── Projections ─────────────────────────────────────────────────────────────

export const METRIC_ROW_FIELDS = ['period', 'broadcast_id', 'domain_id', 'domain_name', ...METRICS];
export const DOMAIN_SUMMARY_FIELDS = ['id', 'name', 'status', 'region', 'created_at'];
export const DOMAIN_DETAIL_FIELDS = [
  ...DOMAIN_SUMMARY_FIELDS,
  'open_tracking',
  'click_tracking',
  'tracking_subdomain',
];
export const DOMAIN_RECORD_FIELDS = ['record', 'name', 'type', 'ttl', 'status', 'value', 'priority'];
export const LOG_SUMMARY_FIELDS = ['id', 'created_at', 'method', 'response_status'];
export const TEMPLATE_SUMMARY_FIELDS = ['id', 'name', 'alias', 'status', 'published_at'];
export const TEMPLATE_VARIABLE_FIELDS = ['key', 'type', 'fallback_value'];

export const projectMetricRow = (row) => pick(row, METRIC_ROW_FIELDS);
export const projectTotals = (totals) => (isPlainObject(totals) ? pick(totals, METRICS) : {});
export const projectDomain = (row) => pick(row, DOMAIN_SUMMARY_FIELDS);
export const projectDomainDetail = (row) => ({
  ...pick(row, DOMAIN_DETAIL_FIELDS),
  records: Array.isArray(row?.records)
    ? row.records.map((record) => pick(record, DOMAIN_RECORD_FIELDS))
    : [],
});
export const projectLog = (row) => ({
  ...pick(row, LOG_SUMMARY_FIELDS),
  // A path such as /contacts/{email} names a person; the list never does.
  ...(typeof row?.endpoint === 'string' ? { endpoint: redactText(row.endpoint) } : {}),
});
export const projectTemplate = (row) => ({
  ...pick(row, TEMPLATE_SUMMARY_FIELDS),
  variables: Array.isArray(row?.variables)
    ? row.variables.map((variable) => pick(variable, TEMPLATE_VARIABLE_FIELDS))
    : [],
});
export const projectEmail = (row) => ({
  id: row?.id ?? null,
  to: (Array.isArray(row?.to) ? row.to : row?.to ? [row.to] : []).map(maskEmail),
  subject: typeof row?.subject === 'string' ? row.subject : null,
  created_at: row?.created_at ?? null,
  last_event: row?.last_event ?? null,
});
export const projectRecipient = (row) => ({
  email: row?.email ?? null,
  count: row?.count ?? null,
  bounce_type: row?.bounce_type ?? null,
  clicked_links: Array.isArray(row?.clicked_links)
    ? row.clicked_links.map((link) => pick(link, ['url', 'clicks']))
    : [],
});
export const projectClickedLink = (row) => pick(row, ['url', 'clicks', 'unique_clicks']);
export const projectContact = (row) => ({
  id: row?.id ?? null,
  email: row?.email ?? null,
  first_name: row?.first_name ?? null,
  last_name: row?.last_name ?? null,
  created_at: row?.created_at ?? null,
  unsubscribed: row?.unsubscribed === true,
});

export const AUDIENCE_CSV_HEADER = 'email,first_name,last_name,joined,status';

/** One contact as an audience CSV row: email, names, joined, subscribed or not. */
export const csvRowFor = (contact) =>
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
export async function eachSegmentPage(client, segmentId, maxPages, onRows) {
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
export async function collectAudienceCsv(client, segmentId) {
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
export async function searchWholeSegment(client, segmentId, matches) {
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
export async function countSegment(client, segmentId) {
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
export const csvAttachment = (filename, lines) => ({
  status: 200,
  headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  },
  body: `${lines.join('\r\n')}\r\n`,
});

// ── Detail projections ──────────────────────────────────────────────────────

/** A log with its bodies, redacted of credentials and addresses. */
export const projectLogDetail = (data) => ({
  ...projectLog(data),
  ...(typeof data?.user_agent === 'string' ? { user_agent: redactText(data.user_agent) } : {}),
  request_body: redactSensitive(data?.request_body ?? null),
  response_body: redactSensitive(data?.response_body ?? null),
});

export const projectTemplateDetail = (data) => ({
  ...projectTemplate(data),
  html: typeof data?.html === 'string' ? data.html : null,
});

