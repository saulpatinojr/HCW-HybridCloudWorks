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
import { ensureConfirmedContact, resolveSegmentId, sendConfirmationEmail } from './handlers.js';
import { parseAddContactBody } from './validate.js';
import { createResendClient } from './resend-client.js';
import { resolveFromAddress } from './sender.js';
import { readPathId, readPage, queryValue, readAudienceQuery, nextCursor, readContactId, readUnsubscribedBody, readDomainBody, readTrackingBody } from './insights-read.js';
import { broadcastForQuery, readMetricsQuery } from './insights-read-metrics.js';
import { badRequest, METRICS, RECIPIENT_TYPES, json, rowsOf, SUMMARY_CACHE_MS } from './insights-shared.js';
import { relay, pageOf, refused, ref, acknowledged, findNewsletterSegment, handler } from './insights-respond.js';
import { projectTotals, projectMetricRow, projectClickedLink, projectRecipient, searchWholeSegment, projectContact, countSegment, collectAudienceCsv, csvAttachment, projectDomain, projectDomainDetail, projectLogDetail, projectTemplateDetail, projectLog, projectEmail, projectTemplate } from './insights-project.js';
import { maskEmail } from './insights-redact.js';

// The shared limits, the redaction, the request readers, the projections and
// the route plumbing live in the insights-*.js files beside this one; the
// names callers use are exported again here so they keep importing from
// insights-handlers.js.
export {
  csvCell,
  DEFAULT_METRICS_DAYS,
  DEFAULT_PAGE_LIMIT,
  DOMAIN_REGIONS,
  EXPORT_MAX_PAGES,
  GRANULARITIES,
  ID_PATTERN,
  MAX_HOSTNAME_LENGTH,
  MAX_SEARCH_LENGTH,
  METRICS,
  RECIPIENT_TYPES,
  SUMMARY_CACHE_MS,
  SUMMARY_MAX_PAGES,
  SUMMARY_PAGE_SIZE,
} from './insights-shared.js';
export { maskEmail, REDACTED, REDACTED_EMAIL, redactSensitive, redactText } from './insights-redact.js';

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
