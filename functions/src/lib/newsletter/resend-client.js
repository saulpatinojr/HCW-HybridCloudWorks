/**
 * resend-client.js — the handful of Resend calls the newsletter needs (ADR 0030).
 *
 * A client and not `rest-proxy.js`, for the reason `connection-probe.js` gives:
 * nothing here takes a path from a caller. Every URL is built from a fixed
 * template. The caller-derived values are an email address, a Resend id, a
 * cursor or a validated query value, each percent-encoded into its own path
 * segment or query parameter; the handlers validate them first.
 *
 * Every method answers `{ ok, status, data }` and never throws for an HTTP
 * failure, so the caller decides what a 404 or a 422 means in its own flow.
 * A transport failure or a timeout is `{ ok: false, status: 0, data: { message } }`
 * for the same reason. Nothing here logs: the bodies carry subscriber addresses,
 * and whether to log anything about them is the handler's decision.
 *
 * Contract, read from Resend's API reference on 2026-09-13:
 *   POST   /emails                                   send one email
 *   GET    /segments?limit=100&after=               list segments
 *   POST   /segments                                 { name }
 *   POST   /contacts                                 { email, unsubscribed, segments: [{ id }] }
 *   GET    /contacts/{id|email}                      { unsubscribed, ... }
 *   PATCH  /contacts/{id|email}                      { unsubscribed }
 *   GET    /contacts/{id|email}/segments             { data: [{ id, name }] }
 *   POST   /contacts/{id|email}/segments/{segmentId}
 *   POST   /broadcasts                               { segment_id, from, reply_to, subject, html, text, name, send, scheduled_at }
 *   GET    /broadcasts/{id}                          { status: draft|scheduled|queued|sent|canceled, scheduled_at, sent_at }
 *   DELETE /broadcasts/{id}                          draft or scheduled only; deleting a scheduled one cancels it
 *
 * Read for the Mailing List page (insights-handlers.js), same date:
 *   GET    /emails/metrics?start_date&end_date&metrics&dimensions&granularity&broadcast_id
 *   GET    /broadcasts/{id}/clicked-links?limit&after
 *   GET    /broadcasts/{id}/recipients?type&limit&after
 *   GET    /segments/{id}/contacts?limit&after
 *   DELETE /contacts/{id|email}
 *   GET    /domains, GET /domains/{id}, POST /domains { name, region },
 *   POST   /domains/{id}/verify, PATCH /domains/{id} { open_tracking, click_tracking }
 *   GET    /logs?limit&after, GET /logs/{id}
 *   GET    /emails?limit&after
 *   GET    /templates?limit&after, GET /templates/{id}
 *
 * A 429 also carries `retryAfter`, Resend's `retry-after` header as sent.
 *
 * `segments` on create is an array of OBJECTS, `[{ id }]`, not of strings —
 * the documentation's wording suggests otherwise and `resend/resend-node#854`
 * records the confusion. Its behaviour for an email that already exists is not
 * documented, which is why the handler reads the contact back rather than
 * trusting any status here.
 */

import { errorCode } from '../http/error-response.js';

export const RESEND_API_BASE = 'https://api.resend.com';

/** Long enough for Resend, short enough that a hung call cannot hold a signup. */
export const RESEND_TIMEOUT_MS = 10_000;

/**
 * @param {object} options
 * @param {string} options.apiKey a Full access key
 * @param {typeof fetch} [options.fetch]
 */
export function createResendClient({ apiKey, fetch: fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('createResendClient needs an API key');

  /**
   * One Resend request: `{ ok, status, data }`, never a throw. A request
   * with no answer is status 0 with the failure's code as `data.name`.
   *
   * @param {string} method - the HTTP method
   * @param {string} path - the API path
   * @param {object} [body] - the JSON body
   * @returns {Promise<{ ok: boolean, status: number, data: object|null }>}
   */
  async function call(method, path, body) {
    let response;
    let text = '';
    try {
      response = await fetchImpl(`${RESEND_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (error) {
      // No answer: status 0, and the failure's code as its name. The
      // transport's own sentence is not carried (#945); callers show and
      // log the name, never a message.
      return {
        ok: false,
        status: 0,
        data: { name: errorCode(error) },
      };
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 2000) };
    }
    const result = { ok: response.ok, status: response.status, data };
    if (response.status === 429) {
      // Resend's rate limit is per team; the header says how long to wait.
      const header = response.headers?.get?.('retry-after');
      result.retryAfter = typeof header === 'string' ? header : null;
    }
    return result;
  }

  const contactPath = (email) => `/contacts/${encodeURIComponent(email)}`;
  const seg = (value) => encodeURIComponent(String(value));

  /**
   * A query string from fixed keys. Values are validated by the caller; this
   * only drops the absent ones and percent-encodes the rest.
   */
  const qs = (params) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };
  const page = ({ limit, after } = {}) => ({ limit, after });

  return {
    sendEmail: (message) => call('POST', '/emails', message),
    listSegments: (after) =>
      call('GET', `/segments?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`),
    createSegment: (name) => call('POST', '/segments', { name }),
    createContact: ({ email, segmentId }) =>
      call('POST', '/contacts', {
        email,
        unsubscribed: false,
        segments: [{ id: segmentId }],
      }),
    getContact: (email) => call('GET', contactPath(email)),
    resubscribeContact: (email) => call('PATCH', contactPath(email), { unsubscribed: false }),
    listContactSegments: (email) => call('GET', `${contactPath(email)}/segments?limit=100`),
    addContactToSegment: (email, segmentId) =>
      call('POST', `${contactPath(email)}/segments/${encodeURIComponent(segmentId)}`),
    /**
     * `POST /broadcasts` with `send: true`: create and send (or schedule, when
     * `scheduledAt` is given) in one call, so there is no window in which a
     * created-but-unsent broadcast exists to be sent twice. Resend fills
     * `{{{RESEND_UNSUBSCRIBE_URL}}}` per recipient.
     */
    createBroadcast: ({ segmentId, from, replyTo, subject, html, text, name, scheduledAt }) =>
      call('POST', '/broadcasts', {
        segment_id: segmentId,
        from,
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        html,
        text,
        name,
        send: true,
        ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
      }),

    /** The broadcast as Resend holds it: the reconcile (reconcile.js) reads `status`. */
    getBroadcast: (broadcastId) => call('GET', `/broadcasts/${seg(broadcastId)}`),
    /**
     * Delete — which for a `scheduled` broadcast is the cancel: Resend
     * documents no other way to stop one. Refused for a sent broadcast.
     */
    deleteBroadcast: (broadcastId) => call('DELETE', `/broadcasts/${seg(broadcastId)}`),

    // ── Reads and configuration for the Mailing List page (insights-handlers.js).
    // None of these sends email. List-type metric parameters are sent
    // comma-separated, which Resend documents as equivalent to repeating them.
    getEmailMetrics: ({ startDate, endDate, metrics, dimensions, granularity, broadcastId }) =>
      call(
        'GET',
        `/emails/metrics${qs({
          start_date: startDate,
          end_date: endDate,
          metrics: metrics?.join(','),
          dimensions: dimensions?.join(','),
          granularity,
          broadcast_id: broadcastId,
        })}`
      ),
    listBroadcastClickedLinks: (broadcastId, options) =>
      call('GET', `/broadcasts/${seg(broadcastId)}/clicked-links${qs(page(options))}`),
    listBroadcastRecipients: (broadcastId, { type, limit, after } = {}) =>
      call('GET', `/broadcasts/${seg(broadcastId)}/recipients${qs({ type, limit, after })}`),
    listSegmentContacts: (segmentId, options) =>
      call('GET', `/segments/${seg(segmentId)}/contacts${qs(page(options))}`),
    // By Resend contact id: the admin routes never put an address in a path.
    setContactUnsubscribed: (contactId, unsubscribed) =>
      call('PATCH', `/contacts/${seg(contactId)}`, {
        unsubscribed: Boolean(unsubscribed),
      }),
    deleteContact: (contactId) => call('DELETE', `/contacts/${seg(contactId)}`),
    listDomains: () => call('GET', '/domains'),
    getDomain: (domainId) => call('GET', `/domains/${seg(domainId)}`),
    createDomain: ({ name, region }) =>
      call('POST', '/domains', { name, ...(region ? { region } : {}) }),
    verifyDomain: (domainId) => call('POST', `/domains/${seg(domainId)}/verify`),
    updateDomainTracking: (domainId, { openTracking, clickTracking }) =>
      call('PATCH', `/domains/${seg(domainId)}`, {
        ...(openTracking === undefined ? {} : { open_tracking: openTracking }),
        ...(clickTracking === undefined ? {} : { click_tracking: clickTracking }),
      }),
    listLogs: (options) => call('GET', `/logs${qs(page(options))}`),
    getLog: (logId) => call('GET', `/logs/${seg(logId)}`),
    listEmails: (options) => call('GET', `/emails${qs(page(options))}`),
    listTemplates: (options) => call('GET', `/templates${qs(page(options))}`),
    getTemplate: (templateId) => call('GET', `/templates/${seg(templateId)}`),
  };
}
