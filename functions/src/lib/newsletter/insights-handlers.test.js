/**
 * The Mailing List page's Resend reads and configuration. The properties that
 * matter most: nothing reaches Resend before the role, the key and every
 * caller-supplied value have been checked; nothing sends email; answers are
 * projections; and no address reaches a log line.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createNewsletterInsightsHandlers,
  maskEmail,
  redactSensitive,
  redactText,
  REDACTED,
  REDACTED_EMAIL,
  SUMMARY_CACHE_MS,
  SUMMARY_MAX_PAGES,
} from './insights-handlers.js';

const API_KEY = 'not-a-real-resend-key-EXAMPLE-VALUE-FOR-TESTS';
const NOW = new Date('2026-09-13T12:00:00Z');
const BROADCAST = 'b7f0c1d2-0000-4000-8000-000000000001';
const DOMAIN = 'd7f0c1d2-0000-4000-8000-000000000002';
const LOG = 'l7f0c1d2-0000-4000-8000-000000000003';
const TEMPLATE = 't7f0c1d2-0000-4000-8000-000000000004';
const SEGMENT = 's7f0c1d2-0000-4000-8000-000000000005';
const SUBSCRIBER = 'jane.doe@example.com';

const reply = (status, data, headers = {}) => ({
  ok: status < 300,
  status,
  headers: new Headers(headers),
  text: async () => (data === undefined ? '' : JSON.stringify(data)),
});

/**
 * A fake Resend. `routes` maps "METHOD /path" (no query) to a function of
 * (url, init) returning a reply; anything unrouted is a 404. Every call is
 * recorded so a test can assert that nothing was fetched.
 */
function makeResend(routes = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url: parsed,
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers,
    });
    const handler = routes[`${method} ${parsed.pathname}`];
    if (!handler) return reply(404, { name: 'not_found', message: 'unrouted in test' });
    return handler(parsed, init);
  });
  return { fetch, calls };
}

const segments = () =>
  reply(200, {
    object: 'list',
    has_more: false,
    data: [{ id: SEGMENT, name: 'Newsletter' }],
  });

const allow = (role) => ({
  requireRole: vi.fn(async (_req, required) => {
    const rank = { none: 0, editor: 1, publisher: 2 };
    return rank[role] >= rank[required]
      ? { user: { oid: 'owner-oid' }, error: null }
      : {
          error: {
            status: 403,
            headers: {},
            body: '{"ok":false,"error":"Forbidden"}',
          },
        };
  }),
});

const request = ({ params = {}, query = {}, body } = {}) => ({
  params,
  query: new URLSearchParams(query),
  json: async () => {
    if (body === undefined) throw new Error('no body');
    return body;
  },
});

const context = () => ({
  invocationId: 'inv-1',
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});
const bodyOf = (res) => JSON.parse(res.body);

/** Every line any logger received, joined, for "no address in the logs" checks. */
const loggedText = (ctx) =>
  [...ctx.log.mock.calls, ...ctx.warn.mock.calls, ...ctx.error.mock.calls]
    .map((args) => args.join(' '))
    .join('\n');

function build({
  role = 'publisher',
  resend = makeResend(),
  env = { RESEND_API_KEY: API_KEY },
  store,
  now,
} = {}) {
  let clock = now ?? NOW;
  const handlers = createNewsletterInsightsHandlers({
    guard: allow(role),
    store: store ?? { readDoc: vi.fn(async () => null) },
    env,
    fetch: resend.fetch,
    now: () => clock,
  });
  return { handlers, resend, setNow: (value) => (clock = value) };
}

/**
 * Every route: its handler name, the role it needs, and a request that passes
 * validation. The table drives the role gate and 503 tests, so a route added
 * without a row here is a visible gap.
 */
const ROUTES = [
  { name: 'metrics', role: 'editor', req: () => request() },
  {
    name: 'clickedLinks',
    role: 'editor',
    req: () => request({ params: { broadcastId: BROADCAST } }),
  },
  {
    name: 'recipients',
    role: 'editor',
    req: () =>
      request({
        params: { broadcastId: BROADCAST },
        query: { type: 'opened' },
      }),
  },
  { name: 'audience', role: 'editor', req: () => request() },
  { name: 'audienceSummary', role: 'editor', req: () => request() },
  // ADR 0033 Amplify slice. The row's request is a consent-recorded add, which
  // writes a contact and never sends; the invite path is tested on its own.
  {
    name: 'addContact',
    role: 'publisher',
    req: () =>
      request({
        body: {
          email: SUBSCRIBER,
          mode: 'confirmed',
          consentRecordedOn: '2026-09-01',
        },
      }),
  },
  { name: 'exportAudience', role: 'publisher', req: () => request() },
  {
    name: 'updateContact',
    role: 'publisher',
    req: () => request({ params: { contactId: 'c1' }, body: { unsubscribed: true } }),
  },
  {
    name: 'deleteContact',
    role: 'publisher',
    req: () => request({ params: { contactId: 'c1' } }),
  },
  { name: 'listDomains', role: 'editor', req: () => request() },
  {
    name: 'getDomain',
    role: 'editor',
    req: () => request({ params: { domainId: DOMAIN } }),
  },
  {
    name: 'createDomain',
    role: 'publisher',
    req: () => request({ body: { name: 'news.example.com' } }),
  },
  {
    name: 'verifyDomain',
    role: 'publisher',
    req: () => request({ params: { domainId: DOMAIN } }),
  },
  {
    name: 'updateDomain',
    role: 'publisher',
    req: () => request({ params: { domainId: DOMAIN }, body: { open_tracking: true } }),
  },
  { name: 'listLogs', role: 'editor', req: () => request() },
  {
    name: 'getLog',
    role: 'publisher',
    req: () => request({ params: { logId: LOG } }),
  },
  { name: 'listEmails', role: 'editor', req: () => request() },
  { name: 'listTemplates', role: 'editor', req: () => request() },
  {
    name: 'getTemplate',
    role: 'editor',
    req: () => request({ params: { templateId: TEMPLATE } }),
  },
];

describe('every route', () => {
  it('the table covers every handler', () => {
    const { handlers } = build();
    expect(Object.keys(handlers).sort()).toEqual(ROUTES.map((r) => r.name).sort());
  });

  it.each(ROUTES)(
    '$name refuses a caller below $role, before Resend',
    async ({ name, role, req }) => {
      const below = role === 'publisher' ? 'editor' : 'none';
      const { handlers, resend } = build({ role: below });
      const res = await handlers[name](req(), context());
      expect(res.status).toBe(403);
      expect(resend.fetch).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES)('$name answers 503 without RESEND_API_KEY', async ({ name, req }) => {
    const { handlers, resend } = build({ env: {} });
    const res = await handlers[name](req(), context());
    expect(res.status).toBe(503);
    expect(bodyOf(res).error).toMatch(/RESEND_API_KEY/);
    expect(resend.fetch).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('$name never calls a sending endpoint', async ({ name, req }) => {
    const resend = makeResend();
    const { handlers } = build({ resend });
    await handlers[name](req(), context());
    const sending = resend.calls.filter(
      (c) => c.method === 'POST' && ['/emails', '/broadcasts'].includes(c.url.pathname)
    );
    expect(sending).toEqual([]);
  });
});

describe('validation happens before any fetch', () => {
  const BAD = [
    ['metrics', request({ query: { broadcast_id: 'bad id!' } })],
    [
      'metrics',
      request({
        query: { broadcast_id: BROADCAST, issue_id: 'issue-2026-09-14' },
      }),
    ],
    ['metrics', request({ query: { issue_id: '../etc' } })],
    ['metrics', request({ query: { start_date: 'yesterday' } })],
    ['metrics', request({ query: { end_date: '2026-13-45' } })],
    ['metrics', request({ query: { start_date: '2026-09-10', end_date: '2026-09-01' } })],
    ['metrics', request({ query: { granularity: 'yearly' } })],
    ['clickedLinks', request({ params: { broadcastId: 'x/../../domains' } })],
    ['clickedLinks', request({ params: { broadcastId: BROADCAST }, query: { limit: '0' } })],
    ['recipients', request({ params: { broadcastId: BROADCAST } })],
    [
      'recipients',
      request({
        params: { broadcastId: BROADCAST },
        query: { type: 'everyone' },
      }),
    ],
    [
      'recipients',
      request({
        params: { broadcastId: BROADCAST },
        query: { type: 'sent', limit: '101' },
      }),
    ],
    [
      'recipients',
      request({
        params: { broadcastId: BROADCAST },
        query: { type: 'sent', after: 'a&b=c' },
      }),
    ],
    ['audience', request({ query: { search: 'x'.repeat(101) } })],
    ['audience', request({ query: { limit: '1.5' } })],
    ['addContact', request({ body: { email: 'not-an-address', mode: 'invite' } })],
    ['addContact', request({ body: { email: SUBSCRIBER, mode: 'later' } })],
    ['addContact', request({ body: { email: SUBSCRIBER, mode: 'confirmed' } })],
    [
      'addContact',
      request({
        body: {
          email: SUBSCRIBER,
          mode: 'confirmed',
          consentRecordedOn: '2999-01-01',
        },
      }),
    ],
    [
      'addContact',
      request({
        body: { email: SUBSCRIBER, mode: 'invite', unsubscribed: false },
      }),
    ],
    [
      'updateContact',
      request({
        params: { contactId: 'jane.doe@example.com' },
        body: { unsubscribed: true },
      }),
    ],
    ['updateContact', request({ params: { contactId: 'c1' }, body: { unsubscribed: 'yes' } })],
    [
      'updateContact',
      request({
        params: { contactId: 'c1' },
        body: { unsubscribed: true, email: 'x@y.z' },
      }),
    ],
    ['updateContact', request({ params: { contactId: 'c1' } })],
    ['deleteContact', request({ params: { contactId: 'jane.doe@example.com' } })],
    ['getDomain', request({ params: { domainId: '' } })],
    ['createDomain', request({ body: { name: 'https://evil.example.com/path' } })],
    ['createDomain', request({ body: { name: '-bad.example.com' } })],
    [
      'createDomain',
      request({
        body: {
          name: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`,
        },
      }),
    ],
    ['createDomain', request({ body: { name: 'news.example.com', region: 'mars-1' } })],
    ['createDomain', request({ body: { name: 'news.example.com', open_tracking: true } })],
    ['verifyDomain', request({ params: { domainId: 'a'.repeat(65) } })],
    ['updateDomain', request({ params: { domainId: DOMAIN }, body: {} })],
    ['updateDomain', request({ params: { domainId: DOMAIN }, body: { open_tracking: 'on' } })],
    [
      'updateDomain',
      request({
        params: { domainId: DOMAIN },
        body: { tracking_subdomain: 'links' },
      }),
    ],
    ['listLogs', request({ query: { limit: 'ten' } })],
    ['getLog', request({ params: { logId: 'id?x=1' } })],
    ['listEmails', request({ query: { after: 'x'.repeat(65) } })],
    ['listTemplates', request({ query: { limit: '-1' } })],
    ['getTemplate', request({ params: { templateId: 'a.b' } })],
  ];

  it.each(BAD.map(([name, req], i) => ({ name, req, i })))(
    '$name case $i is 400',
    async ({ name, req }) => {
      const { handlers, resend } = build();
      const res = await handlers[name](req, context());
      expect(res.status).toBe(400);
      expect(bodyOf(res).ok).toBe(false);
      expect(resend.fetch).not.toHaveBeenCalled();
    }
  );

  it('a lower-cased, trimmed domain name is what reaches Resend', async () => {
    const resend = makeResend({
      'POST /domains': () =>
        reply(200, {
          id: DOMAIN,
          name: 'news.example.com',
          status: 'not_started',
          records: [],
        }),
    });
    const { handlers } = build({ resend });
    const res = await handlers.createDomain(
      request({ body: { name: '  News.Example.COM ', region: 'eu-west-1' } }),
      context()
    );
    expect(res.status).toBe(201);
    expect(resend.calls[0].body).toEqual({
      name: 'news.example.com',
      region: 'eu-west-1',
    });
  });

  it('addresses a contact by its opaque id, so no email ever sits in a request path', async () => {
    const resend = makeResend({
      'PATCH /contacts/c1': () => reply(200, { id: 'c1' }),
    });
    const { handlers } = build({ resend });
    const res = await handlers.updateContact(
      request({ params: { contactId: 'c1' }, body: { unsubscribed: false } }),
      context()
    );
    expect(res.status).toBe(200);
    expect(bodyOf(res)).toEqual({ ok: true });
    expect(resend.calls[0].body).toEqual({ unsubscribed: false });
  });
});

describe('Resend refusals', () => {
  it("map to 502 with Resend's status and error name, never its sentence, and log status only", async () => {
    const long = `Domain ${SUBSCRIBER} is invalid ${'x'.repeat(400)}`;
    const resend = makeResend({
      'GET /domains': () => reply(422, { name: 'validation_error', message: long }),
    });
    const { handlers } = build({ resend });
    const ctx = context();
    const res = await handlers.listDomains(request(), ctx);
    expect(res.status).toBe(502);
    const body = bodyOf(res);
    expect(body.ok).toBe(false);
    expect(body.status).toBe(422);
    // A provider's own words stay out of the answer (#945).
    expect(body.error).toBe('Resend refused the request (HTTP 422 validation_error).');
    expect(res.body).not.toContain(SUBSCRIBER);
    const logged = loggedText(ctx);
    expect(logged).toContain('mailingListDomains');
    expect(logged).toContain('422');
    expect(logged).toContain('inv-1');
    expect(logged).not.toContain('example.com');
    expect(logged).not.toContain('validation_error');
  });

  it('no answer at all is 502 with status 0', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    });
    const { handlers } = build({ resend: { fetch } });
    const res = await handlers.listLogs(request(), context());
    expect(res.status).toBe(502);
    expect(bodyOf(res).status).toBe(0);
  });

  it('a 429 is passed on with retryAfterSeconds and Retry-After', async () => {
    const resend = makeResend({
      'GET /templates': () =>
        reply(
          429,
          { name: 'rate_limit_exceeded', message: 'Too many requests' },
          { 'retry-after': '7' }
        ),
    });
    const { handlers } = build({ resend });
    const res = await handlers.listTemplates(request(), context());
    expect(res.status).toBe(429);
    expect(bodyOf(res)).toMatchObject({
      ok: false,
      status: 429,
      retryAfterSeconds: 7,
    });
    expect(res.headers['Retry-After']).toBe('7');
  });

  it('a 429 without a usable header still says to wait a second', async () => {
    const resend = makeResend({
      'GET /emails': () => reply(429, { name: 'rate_limit_exceeded' }),
    });
    const { handlers } = build({ resend });
    const res = await handlers.listEmails(request(), context());
    expect(res.status).toBe(429);
    expect(bodyOf(res).retryAfterSeconds).toBe(1);
  });
});

describe('metrics', () => {
  const metricsReply = () =>
    reply(200, {
      object: 'metrics',
      start_date: '2026-08-14T12:00:00.000Z',
      end_date: '2026-09-13T12:00:00.000Z',
      granularity: 'daily',
      totals: { sent: 10, delivered: 9, open_rate: 0.5, secret_internal: 1 },
      data: [{ broadcast_id: BROADCAST, sent: 10, email: SUBSCRIBER, extra: 'x' }],
    });

  it('sends a fixed metrics list, the last 30 days and period dimensions by default', async () => {
    const resend = makeResend({ 'GET /emails/metrics': metricsReply });
    const { handlers } = build({ resend, role: 'editor' });
    const res = await handlers.metrics(request(), context());
    expect(res.status).toBe(200);
    const query = resend.calls[0].url.searchParams;
    expect(query.get('metrics')).toBe(
      'sent,delivered,opened,unique_opened,clicked,unique_clicked,bounced,complained,unsubscribed,delivery_rate,open_rate,click_rate,bounce_rate,complaint_rate,unsubscribe_rate'
    );
    expect(query.get('end_date')).toBe(NOW.toISOString());
    expect(query.get('start_date')).toBe('2026-08-14T12:00:00.000Z');
    expect(query.get('granularity')).toBe('daily');
    expect(query.get('dimensions')).toBe('period');
    expect(query.has('broadcast_id')).toBe(false);
    expect([...query.keys()].sort()).toEqual([
      'dimensions',
      'end_date',
      'granularity',
      'metrics',
      'start_date',
    ]);
  });

  it('with broadcast_id asks for broadcast dimensions, and projects totals and rows', async () => {
    const resend = makeResend({ 'GET /emails/metrics': metricsReply });
    const { handlers } = build({ resend, role: 'editor' });
    const res = await handlers.metrics(
      request({
        query: {
          broadcast_id: BROADCAST,
          start_date: '2026-09-01',
          end_date: '2026-09-13',
          granularity: 'weekly',
        },
      }),
      context()
    );
    const query = resend.calls[0].url.searchParams;
    expect(query.get('broadcast_id')).toBe(BROADCAST);
    expect(query.get('dimensions')).toBe('broadcast');
    expect(query.get('granularity')).toBe('weekly');
    expect(query.get('start_date')).toBe('2026-09-01');
    const body = bodyOf(res);
    expect(body.totals).toEqual({ sent: 10, delivered: 9, open_rate: 0.5 });
    expect(body.data).toEqual([{ broadcast_id: BROADCAST, sent: 10 }]);
    expect(body.broadcast_id).toBe(BROADCAST);
  });

  it('issue_id reads the issue and uses its broadcastId', async () => {
    const store = {
      readDoc: vi.fn(async () => ({
        id: 'issue-2026-09-14',
        kind: 'weekly_issue',
        status: 'sent',
        broadcastId: BROADCAST,
      })),
    };
    const resend = makeResend({ 'GET /emails/metrics': metricsReply });
    const { handlers } = build({ resend, store, role: 'editor' });
    const res = await handlers.metrics(
      request({ query: { issue_id: 'issue-2026-09-14' } }),
      context()
    );
    expect(res.status).toBe(200);
    expect(store.readDoc).toHaveBeenCalledWith(
      'newsletters',
      'issue-2026-09-14',
      'issue-2026-09-14'
    );
    expect(resend.calls[0].url.searchParams.get('broadcast_id')).toBe(BROADCAST);
  });

  it('an issue with no broadcast is 404 NO_BROADCAST, and nothing is fetched', async () => {
    const store = {
      readDoc: vi.fn(async () => ({
        id: 'issue-2026-09-14',
        kind: 'weekly_issue',
        status: 'draft',
      })),
    };
    const { handlers, resend } = build({ store });
    const res = await handlers.metrics(
      request({ query: { issue_id: 'issue-2026-09-14' } }),
      context()
    );
    expect(res.status).toBe(404);
    expect(bodyOf(res).code).toBe('NO_BROADCAST');
    expect(resend.fetch).not.toHaveBeenCalled();
  });

  it('a missing or deleted issue is 404', async () => {
    for (const doc of [
      null,
      {
        id: 'issue-2026-09-14',
        kind: 'weekly_issue',
        status: 'deleted',
        broadcastId: BROADCAST,
      },
    ]) {
      const { handlers, resend } = build({
        store: { readDoc: vi.fn(async () => doc) },
      });
      const res = await handlers.metrics(
        request({ query: { issue_id: 'issue-2026-09-14' } }),
        context()
      );
      expect(res.status).toBe(404);
      expect(bodyOf(res).code).toBeUndefined();
      expect(resend.fetch).not.toHaveBeenCalled();
    }
  });

  it('a store failure is 500 and logs the error name only', async () => {
    const store = {
      readDoc: vi.fn(async () => {
        throw Object.assign(new Error(`read ${SUBSCRIBER} failed`), {
          name: 'RestError',
        });
      }),
    };
    const { handlers } = build({ store });
    const ctx = context();
    const res = await handlers.metrics(request({ query: { issue_id: 'issue-2026-09-14' } }), ctx);
    expect(res.status).toBe(500);
    expect(loggedText(ctx)).toContain('RestError');
    expect(loggedText(ctx)).not.toContain(SUBSCRIBER);
  });
});

describe('broadcast reads', () => {
  it('clicked links are projected and carry the next cursor', async () => {
    const resend = makeResend({
      [`GET /broadcasts/${BROADCAST}/clicked-links`]: () =>
        reply(200, {
          has_more: true,
          data: [
            {
              id: 'cur-1',
              url: 'https://hybridcloudworks.com/a',
              clicks: 3,
              unique_clicks: 2,
              x: 1,
            },
          ],
        }),
    });
    const { handlers } = build({ resend });
    const res = await handlers.clickedLinks(
      request({ params: { broadcastId: BROADCAST }, query: { limit: '50' } }),
      context()
    );
    expect(bodyOf(res)).toEqual({
      ok: true,
      links: [{ url: 'https://hybridcloudworks.com/a', clicks: 3, unique_clicks: 2 }],
      has_more: true,
      next_after: 'cur-1',
    });
    expect(resend.calls[0].url.searchParams.get('limit')).toBe('50');
  });

  it('recipients are projected to email, count, bounce_type and clicked_links', async () => {
    const resend = makeResend({
      [`GET /broadcasts/${BROADCAST}/recipients`]: () =>
        reply(200, {
          has_more: false,
          data: [
            {
              id: 'r1',
              contact_id: 'c-secret',
              email: SUBSCRIBER,
              count: 2,
              bounce_type: null,
              clicked_links: [{ url: 'https://a', clicks: 2, id: 'z' }],
            },
          ],
        }),
    });
    const { handlers } = build({ resend, role: 'editor' });
    const res = await handlers.recipients(
      request({
        params: { broadcastId: BROADCAST },
        query: { type: 'clicked', after: 'r0' },
      }),
      context()
    );
    expect(resend.calls[0].url.searchParams.get('type')).toBe('clicked');
    expect(resend.calls[0].url.searchParams.get('after')).toBe('r0');
    expect(bodyOf(res)).toEqual({
      ok: true,
      type: 'clicked',
      recipients: [
        {
          email: SUBSCRIBER,
          count: 2,
          bounce_type: null,
          clicked_links: [{ url: 'https://a', clicks: 2 }],
        },
      ],
      has_more: false,
      next_after: null,
    });
  });
});

describe('audience', () => {
  const contacts = (rows, hasMore = false) =>
    reply(200, { object: 'list', has_more: hasMore, data: rows });

  it('lists the Newsletter segment, projected, filtered on the page by search', async () => {
    const resend = makeResend({
      'GET /segments': segments,
      [`GET /segments/${SEGMENT}/contacts`]: () =>
        contacts(
          [
            {
              id: 'c1',
              email: 'Jane.Doe@Example.com',
              first_name: 'Jane',
              last_name: 'Doe',
              created_at: 't',
              unsubscribed: false,
              secret: 1,
            },
            {
              id: 'c2',
              email: 'bob@other.test',
              first_name: null,
              last_name: null,
              created_at: 't',
              unsubscribed: true,
            },
          ],
          true
        ),
    });
    const { handlers } = build({ resend, role: 'editor' });
    const ctx = context();
    const res = await handlers.audience(request({ query: { search: 'example', limit: '2' } }), ctx);
    expect(bodyOf(res)).toEqual({
      ok: true,
      segmentFound: true,
      contacts: [
        {
          id: 'c1',
          email: 'Jane.Doe@Example.com',
          first_name: 'Jane',
          last_name: 'Doe',
          created_at: 't',
          unsubscribed: false,
        },
      ],
      has_more: true,
      next_after: 'c2',
      searchScope: 'page',
    });
    expect(loggedText(ctx)).not.toMatch(/@/);
  });

  it('never creates the segment: none yet is an empty answer', async () => {
    const resend = makeResend({
      'GET /segments': () => reply(200, { has_more: false, data: [] }),
    });
    const { handlers } = build({ resend });
    const res = await handlers.audience(request(), context());
    expect(bodyOf(res)).toEqual({
      ok: true,
      segmentFound: false,
      contacts: [],
      has_more: false,
      next_after: null,
      searchScope: 'page',
    });
    expect(resend.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('caches the segment id across requests', async () => {
    const resend = makeResend({
      'GET /segments': segments,
      [`GET /segments/${SEGMENT}/contacts`]: () => contacts([]),
    });
    const { handlers } = build({ resend });
    await handlers.audience(request(), context());
    await handlers.audience(request(), context());
    expect(resend.calls.filter((c) => c.url.pathname === '/segments')).toHaveLength(1);
  });

  it('summary pages through the segment and counts', async () => {
    let n = 0;
    const resend = makeResend({
      'GET /segments': segments,
      [`GET /segments/${SEGMENT}/contacts`]: () => {
        n += 1;
        return n === 1
          ? contacts(
              [
                { id: 'c1', unsubscribed: false },
                { id: 'c2', unsubscribed: true },
              ],
              true
            )
          : contacts([{ id: 'c3', unsubscribed: false }], false);
      },
    });
    const { handlers } = build({ resend });
    const res = await handlers.audienceSummary(request(), context());
    expect(bodyOf(res)).toMatchObject({
      ok: true,
      total: 3,
      subscribed: 2,
      unsubscribed: 1,
      truncated: false,
    });
    const pages = resend.calls.filter((c) => c.url.pathname.endsWith('/contacts'));
    expect(pages[0].url.searchParams.get('limit')).toBe('100');
    expect(pages[1].url.searchParams.get('after')).toBe('c2');
  });

  it('summary stops at the page cap and reports truncated', async () => {
    let n = 0;
    const resend = makeResend({
      'GET /segments': segments,
      [`GET /segments/${SEGMENT}/contacts`]: () => {
        n += 1;
        return contacts([{ id: `c${n}`, unsubscribed: false }], true);
      },
    });
    const { handlers } = build({ resend });
    const res = await handlers.audienceSummary(request(), context());
    expect(bodyOf(res)).toMatchObject({
      total: SUMMARY_MAX_PAGES,
      truncated: true,
    });
    expect(n).toBe(SUMMARY_MAX_PAGES);
  });

  it('summary is cached for ten minutes, then read again', async () => {
    const resend = makeResend({
      'GET /segments': segments,
      [`GET /segments/${SEGMENT}/contacts`]: () => contacts([{ id: 'c1' }]),
    });
    const { handlers, setNow } = build({ resend });
    await handlers.audienceSummary(request(), context());
    setNow(new Date(NOW.getTime() + SUMMARY_CACHE_MS - 1000));
    const cached = await handlers.audienceSummary(request(), context());
    expect(bodyOf(cached).total).toBe(1);
    expect(resend.calls.filter((c) => c.url.pathname.endsWith('/contacts'))).toHaveLength(1);
    setNow(new Date(NOW.getTime() + SUMMARY_CACHE_MS + 1000));
    await handlers.audienceSummary(request(), context());
    expect(resend.calls.filter((c) => c.url.pathname.endsWith('/contacts'))).toHaveLength(2);
  });

  it('a failed summary is not cached', async () => {
    let fail = true;
    const resend = makeResend({
      'GET /segments': segments,
      [`GET /segments/${SEGMENT}/contacts`]: () =>
        fail ? reply(500, { name: 'internal_server_error' }) : contacts([]),
    });
    const { handlers } = build({ resend });
    expect((await handlers.audienceSummary(request(), context())).status).toBe(502);
    fail = false;
    expect((await handlers.audienceSummary(request(), context())).status).toBe(200);
  });

  it('delete removes the contact by id, logs no id or address, and clears the summary cache', async () => {
    const resend = makeResend({
      'GET /segments': segments,
      [`GET /segments/${SEGMENT}/contacts`]: () => contacts([]),
      'DELETE /contacts/c1': () => reply(200, { deleted: true }),
    });
    const { handlers } = build({ resend });
    await handlers.audienceSummary(request(), context());
    const ctx = context();
    const res = await handlers.deleteContact(request({ params: { contactId: 'c1' } }), ctx);
    expect(bodyOf(res)).toEqual({ ok: true });
    expect(loggedText(ctx)).not.toContain('jane');
    await handlers.audienceSummary(request(), context());
    expect(resend.calls.filter((c) => c.url.pathname.endsWith('/contacts'))).toHaveLength(2);
  });
});

describe('domains', () => {
  it('list and detail are projections', async () => {
    const domain = {
      object: 'domain',
      id: DOMAIN,
      name: 'news.hybridcloudworks.com',
      status: 'verified',
      region: 'us-east-1',
      created_at: 't',
      open_tracking: false,
      click_tracking: true,
      tracking_subdomain: 'links',
      capabilities: { sending: 'enabled' },
      records: [
        {
          record: 'SPF',
          name: 'send',
          type: 'MX',
          ttl: 'Auto',
          status: 'verified',
          value: 'feedback-smtp',
          priority: 10,
          internal: 'x',
        },
      ],
    };
    const resend = makeResend({
      'GET /domains': () => reply(200, { data: [domain] }),
      [`GET /domains/${DOMAIN}`]: () => reply(200, domain),
    });
    const { handlers } = build({ resend, role: 'editor' });
    expect(bodyOf(await handlers.listDomains(request(), context()))).toEqual({
      ok: true,
      domains: [
        {
          id: DOMAIN,
          name: 'news.hybridcloudworks.com',
          status: 'verified',
          region: 'us-east-1',
          created_at: 't',
        },
      ],
    });
    const detail = bodyOf(
      await handlers.getDomain(request({ params: { domainId: DOMAIN } }), context())
    ).domain;
    expect(Object.keys(detail).sort()).toEqual(
      [
        'click_tracking',
        'created_at',
        'id',
        'name',
        'open_tracking',
        'records',
        'region',
        'status',
        'tracking_subdomain',
      ].sort()
    );
    expect(detail.records).toEqual([
      {
        record: 'SPF',
        name: 'send',
        type: 'MX',
        ttl: 'Auto',
        status: 'verified',
        value: 'feedback-smtp',
        priority: 10,
      },
    ]);
  });

  it('verify and tracking send only what they should', async () => {
    const resend = makeResend({
      [`POST /domains/${DOMAIN}/verify`]: () => reply(200, { object: 'domain', id: DOMAIN }),
      [`PATCH /domains/${DOMAIN}`]: () => reply(200, { object: 'domain', id: DOMAIN }),
    });
    const { handlers } = build({ resend });
    expect(
      bodyOf(await handlers.verifyDomain(request({ params: { domainId: DOMAIN } }), context()))
    ).toEqual({ ok: true, id: DOMAIN });
    const res = await handlers.updateDomain(
      request({
        params: { domainId: DOMAIN },
        body: { click_tracking: false },
      }),
      context()
    );
    expect(bodyOf(res)).toEqual({ ok: true, id: DOMAIN });
    expect(resend.calls[0].body).toBeUndefined();
    expect(resend.calls[1].body).toEqual({ click_tracking: false });
  });
});

describe('logs, emails and templates', () => {
  it('the log list carries no bodies and no addresses', async () => {
    const resend = makeResend({
      'GET /logs': () =>
        reply(200, {
          has_more: false,
          data: [
            {
              id: LOG,
              created_at: 't',
              endpoint: `/contacts/${SUBSCRIBER}`,
              method: 'PATCH',
              response_status: 200,
              user_agent: 'ua',
              request_body: { a: 1 },
            },
          ],
        }),
    });
    const { handlers } = build({ resend, role: 'editor' });
    const body = bodyOf(await handlers.listLogs(request(), context()));
    expect(body.logs).toEqual([
      {
        id: LOG,
        created_at: 't',
        method: 'PATCH',
        response_status: 200,
        endpoint: `/contacts/${REDACTED_EMAIL}`,
      },
    ]);
  });

  it('log detail redacts credentials and email addresses from both bodies', async () => {
    const resend = makeResend({
      [`GET /logs/${LOG}`]: () =>
        reply(200, {
          object: 'log',
          id: LOG,
          created_at: 't',
          endpoint: '/emails',
          method: 'POST',
          response_status: 422,
          user_agent: 'resend-node',
          request_body: {
            from: 'HybridCloudWorks <newsletter@news.hybridcloudworks.com>',
            to: [SUBSCRIBER],
            headers: {
              Authorization: 'Bearer re_live_abcdefghijkl',
              'X-Api-Key': 'abc',
            },
            html: `<p>Hello ${SUBSCRIBER}, token re_abcdefghijklmnop</p>`,
          },
          response_body: {
            message: `Bearer re_abcdefghijklmnop rejected for ${SUBSCRIBER}`,
          },
        }),
    });
    const { handlers } = build({ resend });
    const res = await handlers.getLog(request({ params: { logId: LOG } }), context());
    const text = res.body;
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('news.hybridcloudworks.com');
    expect(text).not.toContain('re_live');
    expect(text).not.toContain('re_abcdefghijklmnop');
    const { log } = bodyOf(res);
    expect(log.request_body.headers.Authorization).toBe(REDACTED);
    expect(log.request_body.headers['X-Api-Key']).toBe(REDACTED);
    expect(log.request_body.to).toEqual([REDACTED_EMAIL]);
    expect(log.response_body.message).toBe(`Bearer ${REDACTED} rejected for ${REDACTED_EMAIL}`);
  });

  it('emails are projected with masked recipients', async () => {
    const resend = makeResend({
      'GET /emails': () =>
        reply(200, {
          has_more: false,
          data: [
            {
              id: 'e1',
              to: [SUBSCRIBER, 'bob@other.test'],
              from: 'x@y.z',
              subject: 'Hi',
              created_at: 't',
              last_event: 'delivered',
              bcc: null,
            },
          ],
        }),
    });
    const { handlers } = build({ resend, role: 'editor' });
    const ctx = context();
    const body = bodyOf(await handlers.listEmails(request({ query: { limit: '5' } }), ctx));
    expect(body.emails).toEqual([
      {
        id: 'e1',
        to: ['j***@example.com', 'b***@other.test'],
        subject: 'Hi',
        created_at: 't',
        last_event: 'delivered',
      },
    ]);
    expect(loggedText(ctx)).not.toMatch(/@/);
  });

  it('templates list and detail are projections; only detail carries html', async () => {
    const template = {
      id: TEMPLATE,
      name: 'Weekly',
      alias: 'weekly',
      status: 'published',
      published_at: 't',
      created_at: 't',
      from: 'x@y.z',
      html: '<p>{{{name}}}</p>',
      variables: [{ id: 'v1', key: 'name', type: 'string', fallback_value: 'friend' }],
    };
    const resend = makeResend({
      'GET /templates': () =>
        reply(200, {
          has_more: false,
          data: [{ ...template, html: undefined, variables: undefined }],
        }),
      [`GET /templates/${TEMPLATE}`]: () => reply(200, template),
    });
    const { handlers } = build({ resend, role: 'editor' });
    expect(bodyOf(await handlers.listTemplates(request(), context())).templates).toEqual([
      {
        id: TEMPLATE,
        name: 'Weekly',
        alias: 'weekly',
        status: 'published',
        published_at: 't',
        variables: [],
      },
    ]);
    expect(
      bodyOf(await handlers.getTemplate(request({ params: { templateId: TEMPLATE } }), context()))
        .template
    ).toEqual({
      id: TEMPLATE,
      name: 'Weekly',
      alias: 'weekly',
      status: 'published',
      published_at: 't',
      variables: [{ key: 'name', type: 'string', fallback_value: 'friend' }],
      html: '<p>{{{name}}}</p>',
    });
  });
});

describe('redaction helpers', () => {
  it('maskEmail keeps the first character and the domain', () => {
    expect(maskEmail('jane@example.com')).toBe('j***@example.com');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail('nobody')).toBe('***');
    expect(maskEmail(null)).toBeNull();
  });

  it('redactText removes bearer tokens, Resend keys and addresses', () => {
    expect(redactText('Authorization: Bearer abc.def-ghi')).toBe(
      `Authorization: Bearer ${REDACTED}`
    );
    expect(redactText('key re_1234567890abcdef here')).toBe(`key ${REDACTED} here`);
    expect(redactText("o'brien+x@mail.example.org")).toBe(REDACTED_EMAIL);
    // Our own client percent-encodes addresses into paths.
    expect(redactText('/contacts/jane.doe%40example.com')).toBe(`/contacts/${REDACTED_EMAIL}`);
    expect(redactText('/contacts/JANE%40Example.COM/segments')).toBe(
      `/contacts/${REDACTED_EMAIL}/segments`
    );
  });

  it('redactSensitive walks arrays, redacts keys and bounds depth', () => {
    const deep = {};
    let cursor = deep;
    for (let i = 0; i < 30; i += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    cursor.email = SUBSCRIBER;
    const out = redactSensitive({
      [SUBSCRIBER]: 1,
      list: [{ password: 'p' }, 'x@y.io'],
      api_key: 'k',
      count: 3,
      deep,
    });
    expect(out[REDACTED_EMAIL]).toBe(1);
    expect(out.list).toEqual([{ password: REDACTED }, REDACTED_EMAIL]);
    expect(out.api_key).toBe(REDACTED);
    expect(out.count).toBe(3);
    expect(JSON.stringify(out)).not.toContain(SUBSCRIBER);
    expect(redactSensitive(null)).toBeNull();
  });
});

describe('audience: export, add, whole-list search (ADR 0033 Amplify slice)', () => {
  const contacts = (rows, hasMore = false) =>
    reply(200, { object: 'list', has_more: hasMore, data: rows });
  const pages = [
    [
      {
        id: 'c1',
        email: 'jane.doe@example.com',
        first_name: 'Jane',
        last_name: 'Doe, Jr',
        created_at: '2026-01-01',
        unsubscribed: false,
      },
    ],
    [
      {
        id: 'c2',
        email: '=cmd@evil.test',
        first_name: null,
        last_name: null,
        created_at: '2026-02-01',
        unsubscribed: true,
      },
    ],
  ];
  const paged = () => {
    let n = 0;
    return () => {
      const rows = pages[n] ?? [];
      n += 1;
      return contacts(rows, n < pages.length);
    };
  };

  it('exports every page as CSV with quoting and formula-safe cells, publisher only', async () => {
    const resend = makeResend({
      'GET /segments': segments,
      [`GET /segments/${SEGMENT}/contacts`]: paged(),
    });
    const { handlers } = build({ resend });
    const ctx = context();
    const res = await handlers.exportAudience(request(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/csv/);
    expect(res.headers['Content-Disposition']).toMatch(/newsletter-audience-2026-09-13\.csv/);
    expect(res.body.split('\r\n')).toEqual([
      'email,first_name,last_name,joined,status',
      'jane.doe@example.com,Jane,"Doe, Jr",2026-01-01,subscribed',
      "'=cmd@evil.test,,,2026-02-01,unsubscribed",
      '',
    ]);
    expect(loggedText(ctx)).not.toMatch(/@/);
    expect(
      (await build({ role: 'editor', resend }).handlers.exportAudience(request(), context())).status
    ).toBe(403);
  });

  it('scope=all with a search pages the whole segment and answers every match', async () => {
    const resend = makeResend({
      'GET /segments': segments,
      [`GET /segments/${SEGMENT}/contacts`]: paged(),
    });
    const { handlers } = build({ resend, role: 'editor' });
    const res = await handlers.audience(
      request({ query: { search: 'evil', scope: 'all' } }),
      context()
    );
    expect(bodyOf(res)).toMatchObject({
      searchScope: 'all',
      truncated: false,
      has_more: false,
      contacts: [expect.objectContaining({ id: 'c2' })],
    });
    expect(
      resend.calls.filter((c) => c.url.pathname === `/segments/${SEGMENT}/contacts`)
    ).toHaveLength(2);
  });

  it('invite sends one confirmation link from the configured sender and writes nothing to the list', async () => {
    const resend = makeResend({
      'POST /emails': () => reply(200, { id: 'em-1' }),
    });
    const store = {
      readDoc: vi.fn(async (container, id) =>
        id === 'newsletter_sender' ? { from: 'Weekly <w@news.hybridcloudworks.com>' } : null
      ),
      upsertDoc: vi.fn(),
    };
    const { handlers } = build({ resend, store });
    const ctx = context();
    const res = await handlers.addContact(
      request({ body: { email: SUBSCRIBER, mode: 'invite' } }),
      ctx
    );
    expect(res.status).toBe(202);
    const email = resend.calls.find((c) => c.url.pathname === '/emails');
    expect(email.body).toMatchObject({
      from: 'Weekly <w@news.hybridcloudworks.com>',
      to: [SUBSCRIBER],
    });
    expect(email.body.html).toMatch(/newsletter\/confirm#t=/);
    expect(resend.calls.some((c) => c.url.pathname === '/contacts')).toBe(false);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(loggedText(ctx)).not.toMatch(/@/);
  });

  it('a consent-recorded add writes the contact, reads it back, and records the consent date', async () => {
    const resend = makeResend({
      'GET /segments': segments,
      'POST /contacts': () => reply(200, { id: 'c9' }),
      [`GET /contacts/${encodeURIComponent(SUBSCRIBER)}/segments`]: () =>
        reply(200, { data: [{ id: SEGMENT }] }),
      [`GET /contacts/${encodeURIComponent(SUBSCRIBER)}`]: () =>
        reply(200, { id: 'c9', unsubscribed: false }),
    });
    const store = {
      readDoc: vi.fn(async () => null),
      upsertDoc: vi.fn(async (_c, doc) => doc),
    };
    const { handlers } = build({ resend, store });
    const res = await handlers.addContact(
      request({
        body: {
          email: SUBSCRIBER,
          mode: 'confirmed',
          consentRecordedOn: '2026-09-01',
        },
      }),
      context()
    );
    expect(res.status).toBe(200);
    expect(bodyOf(res)).toMatchObject({
      ok: true,
      mode: 'confirmed',
      consentRecordedOn: '2026-09-01T00:00:00.000Z',
    });
    expect(store.upsertDoc.mock.calls[0][0]).toBe('admin_audit_logs');
    expect(store.upsertDoc.mock.calls[0][1].details).toMatchObject({
      consentRecordedOn: '2026-09-01T00:00:00.000Z',
      mode: 'confirmed',
    });
    expect(JSON.stringify(store.upsertDoc.mock.calls[0][1])).not.toContain(SUBSCRIBER);
  });
});
