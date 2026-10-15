/**
 * Reviewing and approving weekly issues. The properties that matter most: an
 * issue is broadcast at most once, only as the approver saw it, and never over
 * a reject that landed while it was being sent.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createNewsletterAdminHandlers,
  NEWSLETTER_AI_BUDGET_MS,
  parseIssuePatch,
} from './admin-handlers.js';
import { NEWSLETTER_FROM } from './handlers.js';
import { AiFeatureDisabledError } from '../ai/router.js';
import { INTRO_INSTRUCTION, introInstruction } from './issue.js';
import { createTemplateCache } from './template-source.js';
import { fakeResend as makeResend } from './fake-resend.test-helper.js';

const API_KEY = 'not-a-real-resend-key-EXAMPLE-VALUE-FOR-TESTS';

const NOW = new Date('2026-09-14T12:00:00Z'); // Monday 07:00 Central
const ID = 'issue-2026-09-14';

const fail = (code) => Object.assign(new Error(`fake Cosmos ${code}`), { code });

const draftIssue = (over = {}) => ({
  id: ID,
  kind: 'weekly_issue',
  status: 'draft',
  subject: 'Landing zones',
  intro: 'We covered a lot.',
  customNote: '',
  periodStart: '2026-09-07T12:00:00Z',
  periodEnd: NOW.toISOString(),
  sections: [
    {
      id: 'articles',
      title: 'New',
      items: [{ title: 'A', url: 'https://hybridcloudworks.com/a' }],
    },
  ],
  itemCount: 1,
  _etag: 'e1',
  ...over,
});

const completeSettings = {
  id: 'newsletter_settings',
  postalAddress: 'PO Box 1, Austin, TX',
  replyTo: 'owner@example.com',
  sendDay: 'tuesday',
  sendTime: '09:00',
  timeZone: 'America/Chicago',
};

/** Cosmos with real ETag semantics on the newsletters container. */
function makeStore({ issue = draftIssue(), settings = completeSettings } = {}) {
  const docs = new Map();
  if (issue) docs.set(`newsletters/${issue.id}`, issue);
  if (settings) docs.set('admin_config/newsletter_settings', settings);
  let etag = 1;
  return {
    docs,
    readDoc: vi.fn(async (container, id) => {
      const doc = docs.get(`${container}/${id}`);
      return doc ? { ...doc } : null;
    }),
    queryDocs: vi.fn(async (_container, sql) => {
      // The list must project, not read whole issues.
      expect(sql).not.toMatch(/SELECT TOP \d+ \* /);
      return [...docs.values()].filter((d) => d.kind === 'weekly_issue');
    }),
    upsertDoc: vi.fn(async (container, doc) => {
      etag += 1;
      docs.set(`${container}/${doc.id}`, { ...doc, _etag: `e${etag}` });
      return doc;
    }),
    replaceDocIfMatch: vi.fn(async (container, doc) => {
      const current = docs.get(`${container}/${doc.id}`);
      if (!current || current._etag !== doc._etag) throw fail(412);
      etag += 1;
      const stored = { ...doc, _etag: `e${etag}` };
      docs.set(`${container}/${doc.id}`, stored);
      // What Cosmos returns: the document as written, with its new etag.
      return { ...stored };
    }),
  };
}

const allow = (role = 'publisher') => ({
  requireRole: vi.fn(async (_req, required) => {
    const rank = { editor: 1, publisher: 2 };
    return rank[role] >= rank[required]
      ? { user: { oid: 'owner-oid' }, error: null }
      : { error: { status: 403, body: '{"error":"Forbidden"}' } };
  }),
});

const request = ({ id = ID, body, query = {} } = {}) => ({
  params: { id },
  query: new URLSearchParams(query),
  json: async () => body,
});
const context = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
const bodyOf = (res) => JSON.parse(res.body);

function build({
  store = makeStore(),
  resend = makeResend(),
  role = 'editor',
  env = { RESEND_API_KEY: API_KEY, NEWSLETTER_SENDING_ENABLED: 'true' },
  now = NOW,
  drafter = null,
  // Fresh per build, so no test sees another's cached template.
  templateCache = createTemplateCache(),
} = {}) {
  return {
    handlers: createNewsletterAdminHandlers({
      guard: allow(role),
      store,
      env,
      fetch: resend.fetch,
      now: () => now,
      drafter,
      templateCache,
    }),
    store,
    resend,
  };
}

const approveBody = { body: { etag: 'e1' } };

describe('get', () => {
  it('renders the email as it would send, and says what is missing before it can', async () => {
    const { handlers } = build({ store: makeStore({ settings: null }) });
    const res = await handlers.get(request(), context());
    const body = bodyOf(res);
    expect(res.status).toBe(200);
    expect(body.preview.html).toContain('Postal address not set');
    expect(body.readyToSend).toBe(false);
    expect(body.missingSettings).toEqual(['postal address', 'reply-to address']);
    expect(body.sendPlan).toEqual({ sendNow: false, scheduledAt: '2026-09-15T14:00:00.000Z' });
  });

  it('refuses an id that is not an issue id before reading Cosmos', async () => {
    const { handlers, store } = build();
    const res = await handlers.get(request({ id: '../admin_config/x' }), context());
    expect(res.status).toBe(404);
    expect(store.readDoc).not.toHaveBeenCalledWith(
      'newsletters',
      '../admin_config/x',
      expect.anything()
    );
  });
});

describe('update', () => {
  it('saves the note on a draft', async () => {
    const { handlers, store } = build();
    const res = await handlers.update(
      request({ body: { customNote: '  Hello readers  ', etag: 'e1' } }),
      context()
    );
    expect(res.status).toBe(200);
    expect(store.docs.get(`newsletters/${ID}`).customNote).toBe('Hello readers');
  });

  it('refuses unknown fields and edits to anything but a draft', async () => {
    const { handlers } = build();
    expect(
      (await handlers.update(request({ body: { status: 'sent', etag: 'e1' } }), context())).status
    ).toBe(400);
    const scheduled = build({ store: makeStore({ issue: draftIssue({ status: 'scheduled' }) }) });
    expect(
      (
        await scheduled.handlers.update(
          request({ body: { customNote: 'x', etag: 'e1' } }),
          context()
        )
      ).status
    ).toBe(409);
  });
});

describe('concurrency through the etag', () => {
  it('hands out the stored etag, and returns the new one after an edit', async () => {
    const { handlers } = build();
    const read = bodyOf(await handlers.get(request(), context()));
    expect(read.issue.etag).toBe('e1');
    const saved = bodyOf(
      await handlers.update(
        request({ body: { customNote: 'Hello', etag: read.issue.etag } }),
        context()
      )
    );
    expect(saved.issue.etag).toBeTruthy();
    expect(saved.issue.etag).not.toBe('e1');
  });

  it('refuses an edit or a reject that sends no etag or no body, with one error shape, and writes nothing', async () => {
    const { handlers, store } = build();
    for (const res of [
      await handlers.update(request({ body: { customNote: 'No version' } }), context()),
      await handlers.update(request({ body: { customNote: 'Empty', etag: '' } }), context()),
      await handlers.update(request(), context()),
      await handlers.update(request({ body: ['not', 'an', 'object'] }), context()),
      await handlers.reject(request({ body: {} }), context()),
      await handlers.reject(request(), context()),
    ]) {
      expect(res.status).toBe(400);
      expect(bodyOf(res).code).toBe('ETAG_REQUIRED');
    }
    expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({ status: 'draft', customNote: '' });
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('refuses an edit made from a stale view, and writes nothing', async () => {
    const { handlers, store } = build();
    const first = bodyOf(await handlers.get(request(), context()));
    await handlers.update(
      request({ body: { customNote: 'Theirs', etag: first.issue.etag } }),
      context()
    );
    const res = await handlers.update(
      request({ body: { customNote: 'Mine', etag: first.issue.etag } }),
      context()
    );
    expect(res.status).toBe(409);
    expect(bodyOf(res).code).toBe('ISSUE_CHANGED');
    expect(store.docs.get(`newsletters/${ID}`).customNote).toBe('Theirs');
  });

  it('refuses a reject made from a stale view', async () => {
    const { handlers, store } = build();
    const first = bodyOf(await handlers.get(request(), context()));
    await handlers.update(
      request({ body: { subject: 'Changed', etag: first.issue.etag } }),
      context()
    );
    const res = await handlers.reject(request({ body: { etag: first.issue.etag } }), context());
    expect(res.status).toBe(409);
    expect(store.docs.get(`newsletters/${ID}`).status).toBe('draft');
  });
});

describe('approve', () => {
  it('schedules one broadcast to the Newsletter segment at the configured slot', async () => {
    const { handlers, store, resend } = build({ role: 'publisher' });
    const res = await handlers.approve(request(approveBody), context());

    expect(res.status).toBe(200);
    expect(resend.broadcasts).toHaveLength(1);
    expect(resend.broadcasts[0]).toMatchObject({
      segment_id: 'seg-news',
      from: NEWSLETTER_FROM,
      reply_to: 'owner@example.com',
      subject: 'Landing zones',
      send: true,
      scheduled_at: '2026-09-15T14:00:00.000Z',
    });
    expect(resend.broadcasts[0].html).toContain('{{{RESEND_UNSUBSCRIBE_URL}}}');
    expect(resend.broadcasts[0].html).toContain('PO Box 1, Austin, TX');
    expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({
      status: 'scheduled',
      broadcastId: 'bc-1',
      scheduledAt: '2026-09-15T14:00:00.000Z',
      approvedBy: 'owner-oid',
    });
    expect(bodyOf(res).issue.etag).toBe(store.docs.get(`newsletters/${ID}`)._etag);
  });

  it('sends now, without scheduled_at, when the slot is most of a week away', async () => {
    const { handlers, store, resend } = build({
      role: 'publisher',
      now: new Date('2026-09-16T15:00:00Z'),
    });
    await handlers.approve(request(approveBody), context());
    expect(resend.broadcasts[0]).not.toHaveProperty('scheduled_at');
    expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({
      status: 'sent',
      sentAt: '2026-09-16T15:00:00.000Z',
    });
  });

  it('broadcasts ONCE when approved twice at the same moment', async () => {
    const { handlers, resend } = build({ role: 'publisher' });
    const [a, b] = await Promise.all([
      handlers.approve(request(approveBody), context()),
      handlers.approve(request(approveBody), context()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(resend.broadcasts).toHaveLength(1);
  });

  it('will not send an issue edited after the approver opened it', async () => {
    const { handlers, store, resend } = build({ role: 'publisher' });
    await handlers.update(
      request({ body: { subject: 'Edited by someone else', etag: 'e1' } }),
      context()
    );
    const res = await handlers.approve(request(approveBody), context());
    expect(res.status).toBe(409);
    expect(bodyOf(res).code).toBe('ISSUE_CHANGED');
    expect(resend.fetch).not.toHaveBeenCalled();
    expect(store.docs.get(`newsletters/${ID}`).status).toBe('draft');
  });

  it('requires the etag, before anything is read or sent', async () => {
    const { handlers, resend } = build({ role: 'publisher' });
    for (const res of [
      await handlers.approve(request(), context()),
      await handlers.approve(request({ body: {} }), context()),
    ]) {
      expect(res.status).toBe(400);
      expect(bodyOf(res).code).toBe('ETAG_REQUIRED');
    }
    expect(resend.fetch).not.toHaveBeenCalled();
  });

  it('does not overwrite a reject that lands while Resend is being asked, and names the broadcast', async () => {
    const store = makeStore();
    const resend = makeResend({
      onBroadcast: async () => {
        // The owner clears the stuck send from another tab mid-request.
        const current = store.docs.get(`newsletters/${ID}`);
        const res = await createNewsletterAdminHandlers({
          guard: allow('editor'),
          store,
          now: () => NOW,
        }).reject(request({ body: { etag: current._etag } }), context());
        expect(res.status).toBe(200);
      },
    });
    const { handlers } = build({ role: 'publisher', store, resend });
    const res = await handlers.approve(request(approveBody), context());

    expect(res.status).toBe(409);
    expect(bodyOf(res)).toMatchObject({ code: 'CHANGED_DURING_SEND', broadcastId: 'bc-1' });
    expect(bodyOf(res).error).toContain("cancel it in Resend's Broadcasts page");
    expect(store.docs.get(`newsletters/${ID}`).status).toBe('rejected');
  });

  it('refuses to send without the postal address and reply-to, and changes nothing', async () => {
    const { handlers, store, resend } = build({
      role: 'publisher',
      store: makeStore({ settings: { ...completeSettings, postalAddress: '' } }),
    });
    const res = await handlers.approve(request(approveBody), context());
    expect(res.status).toBe(409);
    expect(bodyOf(res)).toMatchObject({
      code: 'SETTINGS_INCOMPLETE',
      missingSettings: ['postal address'],
    });
    expect(resend.fetch).not.toHaveBeenCalled();
    expect(store.docs.get(`newsletters/${ID}`).status).toBe('draft');
  });

  it("returns the issue to draft with Resend's status and error name, and clears the approval, when the broadcast is refused", async () => {
    const { handlers, store } = build({
      role: 'publisher',
      resend: makeResend({ failBroadcast: true }),
    });
    const ctx = context();
    const res = await handlers.approve(request(approveBody), ctx);
    expect(res.status).toBe(502);
    // The owner and the log get the status and error name; Resend's own
    // sentence (which can echo the broadcast) reaches neither (#945).
    const logged = ctx.error.mock.calls.flat().join('\n');
    expect(logged).toContain('HTTP 422 validation_error');
    expect(logged).not.toContain('PO Box');
    expect(logged).not.toContain('Landing zones');
    expect(bodyOf(res).error).toBe('Resend did not accept the newsletter: HTTP 422 validation_error');
    expect(res.body).not.toContain('from domain not verified');
    expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({
      status: 'draft',
      lastError: expect.stringContaining('validation_error'),
      approvedAt: null,
      approvedBy: null,
    });
  });

  it('refuses, without claiming, when the send slot cannot be worked out', async () => {
    // Stored settings are normalised on read, so the reachable failure is the
    // slot calculation itself; an unusable clock makes it throw.
    const { handlers, store, resend } = build({ role: 'publisher', now: new Date(Number.NaN) });
    const res = await handlers.approve(request(approveBody), context());
    expect(res.status).toBe(409);
    expect(bodyOf(res).code).toBe('SETTINGS_INVALID');
    expect(resend.fetch).not.toHaveBeenCalled();
    const stored = store.docs.get(`newsletters/${ID}`);
    expect(stored.status).toBe('draft');
    expect(stored.approvedAt).toBeUndefined();
  });

  it('keeps the issue in sending, not draft, when Resend gives no answer', async () => {
    const { handlers, store, resend } = build({
      role: 'publisher',
      resend: makeResend({ noAnswer: true }),
    });
    const res = await handlers.approve(request(approveBody), context());
    expect(res.status).toBe(502);
    expect(bodyOf(res).code).toBe('SEND_OUTCOME_UNKNOWN');
    expect(resend.fetch).toHaveBeenCalled();
    // A second approval must not be possible: a broadcast may exist.
    const stored = store.docs.get(`newsletters/${ID}`);
    expect(stored).toMatchObject({ status: 'sending', approvedBy: 'owner-oid' });
    const again = await handlers.approve(request({ body: { etag: stored._etag } }), context());
    expect(again.status).toBe(409);
  });

  it('answers a sent-but-unrecorded broadcast with the usual payload plus a warning', async () => {
    const store = makeStore();
    const replace = store.replaceDocIfMatch;
    let calls = 0;
    // The claim saves; recording the outcome does not.
    store.replaceDocIfMatch = vi.fn(async (...args) => {
      calls += 1;
      if (calls > 1) throw Object.assign(new Error('Service unavailable'), { code: 503 });
      return replace(...args);
    });
    const { handlers, resend } = build({ role: 'publisher', store });
    const res = await handlers.approve(request(approveBody), context());

    expect(res.status).toBe(200);
    expect(resend.broadcasts).toHaveLength(1);
    const body = bodyOf(res);
    expect(body.warning).toContain('Do not approve again');
    expect(body).toMatchObject({
      ok: true,
      issue: { id: ID, status: 'sending' },
      sendingEnabled: true,
    });
    expect(body.preview).toBeTruthy();
    expect(body.issue.etag).toBe(store.docs.get(`newsletters/${ID}`)._etag);
  });

  it('logs only the name and code of a store error, never its message', async () => {
    const store = makeStore();
    const cosmosError = Object.assign(
      new Error(`Entity with the specified id ${ID} does not exist`),
      { code: 503 }
    );
    store.replaceDocIfMatch = vi.fn(async () => {
      throw cosmosError;
    });
    const { handlers } = build({ role: 'publisher', store });
    const ctx = { ...context(), invocationId: 'inv-9' };
    expect((await handlers.approve(request(approveBody), ctx)).status).toBe(500);
    const logged = ctx.error.mock.calls.flat().join('\n');
    expect(logged).toContain('claim failed [invocation inv-9]: Error code 503');
    expect(logged).not.toContain(ID);
  });

  it('logs the invocation, never the issue or broadcast id', async () => {
    const { handlers } = build({ role: 'publisher' });
    const ctx = { ...context(), invocationId: 'inv-123' };
    expect((await handlers.approve(request(approveBody), ctx)).status).toBe(200);
    const logged = [...ctx.log.mock.calls, ...ctx.error.mock.calls].flat().join('\n');
    expect(logged).toContain('inv-123');
    expect(logged).not.toContain(ID);
    expect(logged).not.toContain('bc-1');
  });

  it('is a publisher decision, not an editor one', async () => {
    const { handlers, resend } = build({ role: 'editor' });
    const res = await handlers.approve(request(approveBody), context());
    expect(res.status).toBe(403);
    expect(resend.fetch).not.toHaveBeenCalled();
  });

  it('refuses an issue that is not a draft, including one stuck mid-send', async () => {
    for (const status of ['sending', 'scheduled', 'sent', 'rejected']) {
      const { handlers, resend } = build({
        role: 'publisher',
        store: makeStore({ issue: draftIssue({ status }) }),
      });
      expect((await handlers.approve(request(approveBody), context())).status, status).toBe(409);
      expect(resend.fetch, status).not.toHaveBeenCalled();
    }
  });

  it('refuses before reading, claiming or sending while the Terraform switch is off', async () => {
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      const store = makeStore();
      const readDoc = vi.spyOn(store, 'readDoc');
      const { handlers, resend } = build({
        role: 'publisher',
        store,
        env: { RESEND_API_KEY: API_KEY, NEWSLETTER_SENDING_ENABLED: value },
      });
      const res = await handlers.approve(request(approveBody), context());
      expect(res.status, String(value)).toBe(503);
      expect(bodyOf(res).code).toBe('NEWSLETTER_SENDING_DISABLED');
      expect(readDoc).not.toHaveBeenCalled();
      expect(resend.fetch).not.toHaveBeenCalled();
      expect(store.docs.get(`newsletters/${ID}`).status).toBe('draft');
    }
  });

  it('tells the page the Terraform send switch, off unless it is exactly "true"', async () => {
    for (const [value, expected] of [
      ['true', true],
      [undefined, false],
      ['false', false],
      ['TRUE', false],
      ['1', false],
    ]) {
      const { handlers } = build({
        env: { RESEND_API_KEY: API_KEY, NEWSLETTER_SENDING_ENABLED: value },
      });
      expect(bodyOf(await handlers.get(request(), context())).sendingEnabled, String(value)).toBe(
        expected
      );
    }
  });

  it('says it is not configured without the Resend key', async () => {
    const { handlers } = build({ role: 'publisher', env: { NEWSLETTER_SENDING_ENABLED: 'true' } });
    expect((await handlers.approve(request(approveBody), context())).status).toBe(503);
  });
});

describe('reject', () => {
  it('sets aside a draft', async () => {
    const { handlers, store } = build();
    expect((await handlers.reject(request({ body: { etag: 'e1' } }), context())).status).toBe(200);
    expect(store.docs.get(`newsletters/${ID}`).status).toBe('rejected');
  });

  it('clears an issue stuck in sending', async () => {
    const { handlers, store } = build({
      store: makeStore({ issue: draftIssue({ status: 'sending' }) }),
    });
    expect((await handlers.reject(request({ body: { etag: 'e1' } }), context())).status).toBe(200);
    expect(store.docs.get(`newsletters/${ID}`).status).toBe('rejected');
  });

  it('will not reject an issue that was scheduled or sent, or reject twice', async () => {
    for (const status of ['scheduled', 'sent', 'rejected']) {
      const { handlers, store } = build({ store: makeStore({ issue: draftIssue({ status }) }) });
      const res = await handlers.reject(request({ body: { etag: 'e1' } }), context());
      expect(res.status, status).toBe(409);
      expect(store.docs.get(`newsletters/${ID}`).status, status).toBe(status);
    }
  });
});

describe('list', () => {
  it('returns summaries, not whole issues', async () => {
    const { handlers } = build();
    const body = bodyOf(await handlers.list(request(), context()));
    expect(body.issues).toEqual([
      expect.objectContaining({ id: ID, status: 'draft', subject: 'Landing zones', itemCount: 1 }),
    ]);
    expect(body.issues[0]).not.toHaveProperty('sections');
  });

  it("carries each row's etag and leaves deleted issues out", async () => {
    const { handlers, store } = build();
    const body = bodyOf(await handlers.list(request(), context()));
    expect(body.issues[0].etag).toBe('e1');
    const [sql] = store.queryDocs.mock.calls[0].slice(1);
    expect(sql).toContain("c.status != 'deleted'");
  });

  it('lists a month of published issues, padded a day each side for local dates', async () => {
    const { handlers, store } = build();
    const res = await handlers.list(request({ query: { month: '2026-09' } }), context());
    expect(res.status).toBe(200);
    const [, sql, params] = store.queryDocs.mock.calls[0];
    expect(sql).toContain("c.status = 'sent'");
    expect(sql).toContain("c.status = 'scheduled'");
    expect(params).toEqual([
      { name: '@from', value: '2026-08-31T00:00:00.000Z' },
      { name: '@to', value: '2026-10-02T00:00:00.000Z' },
    ]);
  });

  it('refuses a malformed month before querying', async () => {
    const { handlers, store } = build();
    for (const month of ['2026-9', '2026-13', 'september', '2026-09-01']) {
      expect((await handlers.list(request({ query: { month } }), context())).status, month).toBe(
        400
      );
    }
    expect(store.queryDocs).not.toHaveBeenCalled();
  });
});

describe('save', () => {
  it('moves a draft to Drafts and returns the new etag', async () => {
    const { handlers, store } = build();
    const res = await handlers.save(request({ body: { etag: 'e1' } }), context());
    expect(res.status).toBe(200);
    const stored = store.docs.get(`newsletters/${ID}`);
    expect(stored).toMatchObject({
      status: 'draft',
      savedAt: NOW.toISOString(),
      savedBy: 'owner-oid',
    });
    expect(bodyOf(res).issue).toMatchObject({ savedAt: NOW.toISOString(), etag: stored._etag });
  });

  it('does not write again for a draft that is already saved', async () => {
    const { handlers, store } = build({
      store: makeStore({ issue: draftIssue({ savedAt: '2026-09-13T10:00:00Z' }) }),
    });
    expect((await handlers.save(request({ body: { etag: 'e1' } }), context())).status).toBe(200);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('requires the etag and refuses a stale one or a non-draft', async () => {
    const { handlers } = build();
    expect(bodyOf(await handlers.save(request({ body: {} }), context())).code).toBe(
      'ETAG_REQUIRED'
    );
    expect(bodyOf(await handlers.save(request({ body: { etag: 'old' } }), context())).code).toBe(
      'ISSUE_CHANGED'
    );
    for (const status of ['sending', 'scheduled', 'sent', 'rejected']) {
      const other = build({ store: makeStore({ issue: draftIssue({ status }) }) });
      expect(
        (await other.handlers.save(request({ body: { etag: 'e1' } }), context())).status,
        status
      ).toBe(409);
    }
  });
});

describe('remove', () => {
  it('deletes a draft or rejected issue, which then reads as not found', async () => {
    for (const status of ['draft', 'rejected']) {
      const { handlers, store } = build({ store: makeStore({ issue: draftIssue({ status }) }) });
      const res = await handlers.remove(request({ body: { etag: 'e1' } }), context());
      expect(res.status, status).toBe(200);
      expect(bodyOf(res)).toEqual({ ok: true, id: ID });
      expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({
        status: 'deleted',
        deletedBy: 'owner-oid',
      });
      expect((await handlers.get(request(), context())).status, status).toBe(404);
    }
  });

  it('never deletes an issue that was approved', async () => {
    for (const status of ['sending', 'scheduled', 'sent']) {
      const { handlers, store } = build({ store: makeStore({ issue: draftIssue({ status }) }) });
      expect(
        (await handlers.remove(request({ body: { etag: 'e1' } }), context())).status,
        status
      ).toBe(409);
      expect(store.docs.get(`newsletters/${ID}`).status, status).toBe(status);
    }
  });

  it('loses to an approval that claimed the issue first', async () => {
    const { handlers, store } = build();
    // The approval's claim lands between the page's read and the delete.
    store.docs.set(`newsletters/${ID}`, {
      ...store.docs.get(`newsletters/${ID}`),
      status: 'draft',
      _etag: 'e9',
    });
    const res = await handlers.remove(request({ body: { etag: 'e1' } }), context());
    expect(bodyOf(res).code).toBe('ISSUE_CHANGED');
    expect(store.docs.get(`newsletters/${ID}`).status).toBe('draft');
  });

  it('requires the etag, and is at least an editor decision', async () => {
    const { handlers } = build();
    expect(bodyOf(await handlers.remove(request(), context())).code).toBe('ETAG_REQUIRED');
    const denied = createNewsletterAdminHandlers({
      guard: { requireRole: vi.fn(async () => ({ error: { status: 401, body: '{}' } })) },
      store: makeStore(),
    });
    expect((await denied.remove(request({ body: { etag: 'e1' } }), context())).status).toBe(401);
  });
});

const itemA = { title: 'A', url: 'https://hybridcloudworks.com/a', summary: 'sa' };
const itemB = { title: 'B', url: 'https://hybridcloudworks.com/b' };
const itemC = { title: 'C', url: 'https://learn.microsoft.com/c', label: 'Retiring' };
const twoSections = () =>
  draftIssue({
    sections: [
      { id: 'articles', title: 'New', items: [itemA, itemB] },
      { id: 'certifications', title: 'Certification news', items: [itemC] },
    ],
    itemCount: 3,
  });
const patch = (fields) => request({ body: { etag: 'e1', ...fields } });

describe('update: preheader', () => {
  it('stores trimmed preview text, returns it, and renders it hidden at the top of the email', async () => {
    const { handlers, store } = build();
    const res = await handlers.update(
      patch({ preheader: '  Five things   from <this> week  ' }),
      context()
    );
    expect(res.status).toBe(200);
    expect(store.docs.get(`newsletters/${ID}`).preheader).toBe('Five things from <this> week');
    const body = bodyOf(res);
    expect(body.issue.preheader).toBe('Five things from <this> week');
    expect(body.preview.html).toContain('Five things from &lt;this&gt; week');
  });

  it('refuses preview text over 150 characters or not a string, and writes nothing', async () => {
    const { handlers, store } = build();
    expect((await handlers.update(patch({ preheader: 'x'.repeat(151) }), context())).status).toBe(
      400
    );
    expect((await handlers.update(patch({ preheader: 42 }), context())).status).toBe(400);
    expect((await handlers.update(patch({ preheader: 'x'.repeat(150) }), context())).status).toBe(
      200
    );
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
  });

  it('reads as empty when never set', async () => {
    const { handlers } = build();
    expect(bodyOf(await handlers.get(request(), context())).issue.preheader).toBe('');
  });

  it('is sent by approve, because approve renders the stored issue', async () => {
    const { handlers, resend } = build({
      role: 'publisher',
      store: makeStore({ issue: draftIssue({ preheader: 'Inbox preview' }) }),
    });
    expect((await handlers.approve(request(approveBody), context())).status).toBe(200);
    expect(resend.broadcasts[0].html).toContain('Inbox preview');
  });

  it('still refuses unknown fields alongside the new ones', async () => {
    const { handlers, store } = build();
    const res = await handlers.update(patch({ preheader: 'ok', itemCount: 99 }), context());
    expect(res.status).toBe(400);
    expect(bodyOf(res).error).toContain('itemCount');
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });
});

describe('update: sections', () => {
  const edit = async (sections) => {
    const built = build({ store: makeStore({ issue: twoSections() }) });
    const res = await built.handlers.update(patch({ sections }), context());
    return { res, stored: built.store.docs.get(`newsletters/${ID}`), store: built.store };
  };

  it('reorders sections and items, and recomputes itemCount', async () => {
    const { res, stored } = await edit([
      { id: 'certifications', items: [{ url: itemC.url }] },
      { id: 'articles', items: [{ url: itemB.url }, { url: itemA.url }] },
    ]);
    expect(res.status).toBe(200);
    expect(stored.sections.map((s) => s.id)).toEqual(['certifications', 'articles']);
    expect(stored.sections[1].items).toEqual([itemB, itemA]);
    expect(stored.itemCount).toBe(3);
    expect(bodyOf(res).issue.itemCount).toBe(3);
  });

  it('removes items and whole sections, writing the stored items back', async () => {
    const { res, stored } = await edit([{ id: 'articles', title: 'New', items: [{ ...itemA }] }]);
    expect(res.status).toBe(200);
    expect(stored.sections).toEqual([{ id: 'articles', title: 'New', items: [itemA] }]);
    expect(stored.itemCount).toBe(1);
  });

  it('treats a section left with no items as removed', async () => {
    const { res, stored } = await edit([
      { id: 'articles', items: [] },
      { id: 'certifications', items: [{ url: itemC.url }] },
    ]);
    expect(res.status).toBe(200);
    expect(stored.sections.map((s) => s.id)).toEqual(['certifications']);
    expect(stored.itemCount).toBe(1);
  });

  it('refuses an added item, an edited field, a moved item, an added section and duplicates, writing nothing', async () => {
    const refused = {
      'added item': [
        {
          id: 'articles',
          items: [{ url: itemA.url }, { title: 'New', url: 'https://hybridcloudworks.com/new' }],
        },
      ],
      'edited title': [{ id: 'articles', items: [{ ...itemA, title: 'Better title' }] }],
      'edited url': [{ id: 'articles', items: [{ url: 'javascript:alert(1)' }] }],
      'added field': [{ id: 'articles', items: [{ url: itemA.url, summary: 'rewritten' }] }],
      'moved item': [{ id: 'certifications', items: [{ url: itemA.url }] }],
      'added section': [{ id: 'podcasts', title: 'Podcasts', items: [{ url: itemA.url }] }],
      'renamed section': [{ id: 'articles', title: 'Renamed', items: [{ url: itemA.url }] }],
      'duplicate item': [{ id: 'articles', items: [{ url: itemA.url }, { url: itemA.url }] }],
      'duplicate section': [
        { id: 'articles', items: [{ url: itemA.url }] },
        { id: 'articles', items: [{ url: itemB.url }] },
      ],
      'nothing left': [],
      'not an array': { id: 'articles' },
      'item not an object': [{ id: 'articles', items: [itemA.url] }],
      'no items array': [{ id: 'articles' }],
    };
    for (const [name, sections] of Object.entries(refused)) {
      const { res, stored, store } = await edit(sections);
      expect(res.status, name).toBe(400);
      expect(stored, name).toEqual(twoSections());
      expect(store.replaceDocIfMatch, name).not.toHaveBeenCalled();
    }
  });

  it('checks the sections of a draft only, against the version the etag names', async () => {
    const sections = [{ id: 'articles', items: [{ url: itemA.url }] }];
    const sent = build({ store: makeStore({ issue: { ...twoSections(), status: 'sent' } }) });
    expect((await sent.handlers.update(patch({ sections }), context())).status).toBe(409);
    const stale = build({ store: makeStore({ issue: twoSections() }) });
    const res = await stale.handlers.update(
      request({ body: { sections, etag: 'old' } }),
      context()
    );
    expect(bodyOf(res).code).toBe('ISSUE_CHANGED');
    const missing = build({ store: makeStore({ issue: twoSections() }) });
    expect(
      bodyOf(await missing.handlers.update(request({ body: { sections } }), context())).code
    ).toBe('ETAG_REQUIRED');
  });
});

const makeDrafter = (
  result = { title: 'Zones', postContent: '**This week** we looked at [zones](https://x).' }
) => ({
  generateDraft: vi.fn(async () => (result instanceof Error ? Promise.reject(result) : result)),
});

describe('intro', () => {
  it("regenerates a draft's intro with the builder's instruction, clears introError and keeps the subject", async () => {
    const drafter = makeDrafter();
    const { handlers, store } = build({
      drafter,
      store: makeStore({ issue: draftIssue({ introError: 'AI was off' }) }),
    });
    const res = await handlers.intro(request({ body: { etag: 'e1' } }), context());
    expect(res.status).toBe(200);
    const stored = store.docs.get(`newsletters/${ID}`);
    expect(stored).toMatchObject({
      intro: 'This week we looked at zones.',
      introError: null,
      subject: 'Landing zones',
    });
    expect(bodyOf(res).issue).toMatchObject({
      intro: 'This week we looked at zones.',
      etag: stored._etag,
    });
    const [call] = drafter.generateDraft.mock.calls[0];
    expect(call.customInstructionPrompt).toBe(introInstruction('professional'));
    expect(call.customInstructionPrompt.startsWith(INTRO_INSTRUCTION)).toBe(true);
    expect(call.markdown).toContain('- A');
  });

  it('writes the regenerated intro in the tone saved in Newsletter settings', async () => {
    const drafter = makeDrafter();
    const { handlers } = build({
      drafter,
      store: makeStore({ settings: { ...completeSettings, introTone: 'enthusiastic' } }),
    });
    const res = await handlers.intro(request({ body: { etag: 'e1' } }), context());
    expect(res.status).toBe(200);
    const [call] = drafter.generateDraft.mock.calls[0];
    expect(call.customInstructionPrompt).toBe(introInstruction('enthusiastic'));
    expect(call.customInstructionPrompt).toMatch(/Tone: upbeat and enthusiastic/);
  });

  it('stores nothing and answers 502 with a readable error when the AI fails', async () => {
    // The router's own refusal is authored and read whole; a provider's
    // sentence is not (#945).
    const drafter = makeDrafter(new AiFeatureDisabledError('newsletterIntro'));
    const { handlers, store } = build({ drafter });
    const ctx = { ...context(), invocationId: 'inv-7' };
    const res = await handlers.intro(request({ body: { etag: 'e1' } }), ctx);
    expect(res.status).toBe(502);
    expect(bodyOf(res)).toMatchObject({
      code: 'AI_FAILED',
      error: "The intro was not regenerated: The 'newsletterIntro' AI feature is turned off in the admin portal.",
    });
    const raw = await build({ drafter: makeDrafter(new Error('429 quota for org-abc')) }).handlers.intro(
      request({ body: { etag: 'e1' } }),
      ctx
    );
    expect(bodyOf(raw).error).toBe('The intro was not regenerated: the AI call failed (Error)');
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(store.docs.get(`newsletters/${ID}`).intro).toBe('We covered a lot.');
    const logged = ctx.error.mock.calls.flat().join('\n');
    expect(logged).toContain('inv-7');
    expect(logged).not.toContain('disabled');
    expect(logged).not.toContain(ID);
  });

  it('stores nothing when the AI returns an empty intro', async () => {
    const { handlers, store } = build({ drafter: makeDrafter({ title: 'x', postContent: '' }) });
    expect((await handlers.intro(request({ body: { etag: 'e1' } }), context())).status).toBe(502);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('requires the etag, refuses a stale one or a non-draft before calling the AI', async () => {
    const drafter = makeDrafter();
    const { handlers } = build({ drafter });
    expect(bodyOf(await handlers.intro(request({ body: {} }), context())).code).toBe(
      'ETAG_REQUIRED'
    );
    expect(bodyOf(await handlers.intro(request({ body: { etag: 'old' } }), context())).code).toBe(
      'ISSUE_CHANGED'
    );
    const sent = build({ drafter, store: makeStore({ issue: draftIssue({ status: 'sent' }) }) });
    expect((await sent.handlers.intro(request({ body: { etag: 'e1' } }), context())).status).toBe(
      409
    );
    expect(drafter.generateDraft).not.toHaveBeenCalled();
  });

  it('does not overwrite an edit that lands while the AI is writing', async () => {
    const store = makeStore();
    const drafter = {
      generateDraft: vi.fn(async () => {
        store.docs.set(`newsletters/${ID}`, {
          ...store.docs.get(`newsletters/${ID}`),
          customNote: 'Theirs',
          _etag: 'e9',
        });
        return { title: 't', postContent: 'New intro.' };
      }),
    };
    const { handlers } = build({ store, drafter });
    const res = await handlers.intro(request({ body: { etag: 'e1' } }), context());
    expect(bodyOf(res).code).toBe('ISSUE_CHANGED');
    expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({
      customNote: 'Theirs',
      intro: 'We covered a lot.',
    });
  });

  it('is at least an editor decision, and 503 without a drafter', async () => {
    const denied = createNewsletterAdminHandlers({
      guard: { requireRole: vi.fn(async () => ({ error: { status: 403, body: '{}' } })) },
      store: makeStore(),
      drafter: makeDrafter(),
    });
    expect((await denied.intro(request({ body: { etag: 'e1' } }), context())).status).toBe(403);
    expect(
      (await build().handlers.intro(request({ body: { etag: 'e1' } }), context())).status
    ).toBe(503);
  });
});

describe('subjects', () => {
  it('returns up to five cleaned, deduplicated suggestions of at most 120 characters, and writes nothing', async () => {
    const drafter = makeDrafter({
      title: 'Landing zones, again',
      keyTopics: [
        'landing zones, AGAIN',
        '"**Quoted** idea"',
        'y'.repeat(200),
        'Fourth',
        'Fifth',
        'Sixth',
        7,
        '',
      ],
    });
    const { handlers, store } = build({ drafter });
    const res = await handlers.subjects(request(), context());
    expect(res.status).toBe(200);
    const { subjects } = bodyOf(res);
    expect(subjects).toHaveLength(5);
    expect(subjects[0]).toBe('Landing zones, again');
    expect(subjects[1]).toBe('Quoted idea');
    expect(subjects[2].length).toBeLessThanOrEqual(120);
    expect(new Set(subjects.map((s) => s.toLowerCase())).size).toBe(5);
    for (const s of subjects) expect(s.length).toBeLessThanOrEqual(120);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('answers 502 when the AI fails or offers fewer than three usable lines', async () => {
    for (const drafter of [
      makeDrafter(new Error('No AI provider configured')),
      makeDrafter({ title: 'One', keyTopics: ['one', 'ONE'] }),
    ]) {
      const res = await build({ drafter }).handlers.subjects(request(), context());
      expect(res.status).toBe(502);
      expect(bodyOf(res).code).toBe('AI_FAILED');
    }
  });

  it('is at least an editor decision, and 404 for a missing issue', async () => {
    const denied = createNewsletterAdminHandlers({
      guard: { requireRole: vi.fn(async () => ({ error: { status: 401, body: '{}' } })) },
      store: makeStore(),
      drafter: makeDrafter(),
    });
    expect((await denied.subjects(request(), context())).status).toBe(401);
    expect(
      (
        await build({ drafter: makeDrafter() }).handlers.subjects(
          request({ id: 'issue-2020-01-01' }),
          context()
        )
      ).status
    ).toBe(404);
  });
});

describe('intro and subjects: the AI time budget', () => {
  it('both hand the drafter what is left of NEWSLETTER_AI_BUDGET_MS, counted from the handler start', async () => {
    // The page waits on these under the client's 20 s default, so a slow
    // first provider has to fail over inside it (router.js header).
    for (const route of ['intro', 'subjects']) {
      const drafter = makeDrafter({
        title: 'One',
        postContent: 'New intro.',
        keyTopics: ['Two', 'Three'],
      });
      const res = await build({ drafter }).handlers[route](
        request({ body: { etag: 'e1' } }),
        context()
      );
      expect(res.status, route).toBe(200);
      const { budgetMs } = drafter.generateDraft.mock.calls[0][0];
      expect(budgetMs, route).toBeLessThanOrEqual(NEWSLETTER_AI_BUDGET_MS);
      expect(budgetMs, route).toBeGreaterThan(NEWSLETTER_AI_BUDGET_MS - 1_000);
    }
  });
});

describe('test send', () => {
  const testBody = (over = {}) => request({ body: { etag: 'e1', ...over } });

  it('emails one [TEST] copy to the reply-to address only, even when the body names another', async () => {
    const { handlers, store, resend } = build({ role: 'publisher' });
    const res = await handlers.test(
      testBody({
        to: 'attacker@example.net',
        replyTo: 'attacker@example.net',
        sentTo: 'attacker@example.net',
      }),
      context()
    );
    expect(res.status).toBe(200);
    const stored = store.docs.get(`newsletters/${ID}`);
    expect(bodyOf(res)).toEqual({ ok: true, sentTo: 'owner@example.com', etag: stored._etag });
    expect(resend.emails).toHaveLength(1);
    expect(resend.emails[0]).toMatchObject({
      from: NEWSLETTER_FROM,
      to: ['owner@example.com'],
      subject: '[TEST] Landing zones',
    });
    expect(JSON.stringify(resend.emails[0])).not.toContain('attacker');
    expect(resend.broadcasts).toHaveLength(0);
    expect(resend.fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/emails']);
    expect(stored).toMatchObject({ status: 'draft', lastTestAt: NOW.toISOString() });
  });

  it('replaces the unsubscribe placeholder, which a single email cannot fill, and says so', async () => {
    const { handlers, resend } = build({ role: 'publisher' });
    await handlers.test(testBody(), context());
    const [email] = resend.emails;
    expect(email.html).not.toContain('RESEND_UNSUBSCRIBE_URL');
    expect(email.text).not.toContain('RESEND_UNSUBSCRIBE_URL');
    expect(email.html).toContain('href="#"');
    expect(email.html).toContain('unsubscribe link is inactive');
    expect(email.text).toContain('unsubscribe link is inactive');
  });

  it('works while sending is switched off, because it cannot reach subscribers', async () => {
    for (const value of [undefined, 'false']) {
      const { handlers, resend } = build({
        role: 'publisher',
        env: { RESEND_API_KEY: API_KEY, NEWSLETTER_SENDING_ENABLED: value },
      });
      expect((await handlers.test(testBody(), context())).status, String(value)).toBe(200);
      expect(resend.emails, String(value)).toHaveLength(1);
    }
  });

  it('sends at most one test per issue per minute', async () => {
    const store = makeStore();
    const resend = makeResend();
    const first = build({ role: 'publisher', store, resend });
    const sent = bodyOf(await first.handlers.test(testBody(), context()));
    const again = await first.handlers.test(testBody({ etag: sent.etag }), context());
    expect(again.status).toBe(429);
    expect(bodyOf(again)).toMatchObject({ code: 'TEST_RATE_LIMITED', retryAfterSeconds: 60 });
    // Even with the old etag, a second press inside the minute is "too soon".
    expect((await first.handlers.test(testBody(), context())).status).toBe(429);
    expect(resend.emails).toHaveLength(1);
    const later = build({
      role: 'publisher',
      store,
      resend,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect((await later.handlers.test(testBody({ etag: sent.etag }), context())).status).toBe(200);
    expect(resend.emails).toHaveLength(2);
  });

  it('sends once when pressed twice at the same moment', async () => {
    const { handlers, resend } = build({ role: 'publisher' });
    const [a, b] = await Promise.all([
      handlers.test(testBody(), context()),
      handlers.test(testBody(), context()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    expect(resend.emails).toHaveLength(1);
  });

  it('is a publisher decision', async () => {
    const { handlers, resend } = build({ role: 'editor' });
    expect((await handlers.test(testBody(), context())).status).toBe(403);
    expect(resend.fetch).not.toHaveBeenCalled();
  });

  it('refuses without the settings, the Resend key, the etag, a draft or a fresh view, and sends nothing', async () => {
    const cases = [
      [
        build({
          role: 'publisher',
          store: makeStore({ settings: { ...completeSettings, replyTo: '' } }),
        }),
        testBody(),
        409,
        'SETTINGS_INCOMPLETE',
      ],
      [
        build({
          role: 'publisher',
          store: makeStore({ settings: { ...completeSettings, postalAddress: '' } }),
        }),
        testBody(),
        409,
        'SETTINGS_INCOMPLETE',
      ],
      [build({ role: 'publisher', env: {} }), testBody(), 503, undefined],
      [build({ role: 'publisher' }), request({ body: {} }), 400, 'ETAG_REQUIRED'],
      [build({ role: 'publisher' }), testBody({ etag: 'old' }), 409, 'ISSUE_CHANGED'],
      [
        build({
          role: 'publisher',
          store: makeStore({ issue: draftIssue({ status: 'scheduled' }) }),
        }),
        testBody(),
        409,
        undefined,
      ],
    ];
    for (const [{ handlers, resend, store }, req, status, code] of cases) {
      const res = await handlers.test(req, context());
      expect(res.status, code).toBe(status);
      expect(bodyOf(res).code, String(status)).toBe(code);
      expect(resend.fetch).not.toHaveBeenCalled();
      expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    }
  });

  it("answers 502 with Resend's status and error name on a refusal, and logs only those", async () => {
    const { handlers } = build({ role: 'publisher', resend: makeResend({ failEmail: true }) });
    const ctx = { ...context(), invocationId: 'inv-5' };
    const res = await handlers.test(testBody(), ctx);
    expect(res.status).toBe(502);
    // Resend's own sentence stays out of the answer too (#945).
    expect(bodyOf(res).error).toBe('Resend did not accept the test email: HTTP 403 validation_error');
    expect(res.body).not.toContain('not verified');
    const logged = [...ctx.log.mock.calls, ...ctx.error.mock.calls].flat().join('\n');
    expect(logged).toContain('HTTP 403 validation_error');
    expect(logged).toContain('inv-5');
    for (const secret of ['owner@example.com', ID, 'not verified', 'Landing zones', 'PO Box']) {
      expect(logged, secret).not.toContain(secret);
    }
  });

  it('logs the invocation on success, never the address or issue id', async () => {
    const { handlers } = build({ role: 'publisher' });
    const ctx = { ...context(), invocationId: 'inv-6' };
    expect((await handlers.test(testBody(), ctx)).status).toBe(200);
    const logged = [...ctx.log.mock.calls, ...ctx.error.mock.calls].flat().join('\n');
    expect(logged).toContain('inv-6');
    expect(logged).not.toContain('owner@example.com');
    expect(logged).not.toContain(ID);
  });
});

describe('Resend template as the design (#557)', () => {
  const TEMPLATE_ID = 'tpl-weekly-1';
  const withTemplate = { ...completeSettings, templateId: TEMPLATE_ID };
  const BRAND = '<header class="brand">HCW brand header</header>';
  const templateHtml = (inner = '{{{NEWSLETTER_BODY}}}') =>
    `<!doctype html><html><body>${BRAND}<h1>{{{NEWSLETTER_SUBJECT}}}</h1>${inner}<footer><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></footer></body></html>`;
  const published = (html = templateHtml()) => [
    200,
    { object: 'template', id: TEMPLATE_ID, name: 'Weekly', status: 'published', html },
  ];
  const templatePaths = (resend) =>
    resend.fetch.mock.calls
      .map(([url]) => new URL(url).pathname)
      .filter((path) => path.startsWith('/templates/'));
  const allLogs = (ctx) =>
    [...ctx.log.mock.calls, ...ctx.warn.mock.calls, ...ctx.error.mock.calls].flat().join('\n');

  describe('preview', () => {
    it('renders the issue inside the chosen template', async () => {
      const resend = makeResend({ templates: { [TEMPLATE_ID]: published() } });
      const { handlers } = build({ store: makeStore({ settings: withTemplate }), resend });
      const body = bodyOf(await handlers.get(request(), context()));
      expect(body.templateProblem).toBeNull();
      expect(body.preview.html).toContain(BRAND);
      expect(body.preview.html).toContain('<h1>Landing zones</h1>');
      expect(body.preview.html).toContain('https://hybridcloudworks.com/a');
      expect(body.preview.html).toContain('PO Box 1, Austin, TX');
      expect(body.preview.html).not.toContain('HybridCloudWorks Weekly ·');
    });

    it('shows the built-in design with templateProblem when the template cannot be fetched, and logs only the code', async () => {
      const resend = makeResend({
        templates: {
          [TEMPLATE_ID]: [
            500,
            { name: 'internal_server_error', message: 'Template tpl-weekly-1 exploded' },
          ],
        },
      });
      const { handlers } = build({ store: makeStore({ settings: withTemplate }), resend });
      const ctx = { ...context(), invocationId: 'inv-t1' };
      const res = await handlers.get(request(), ctx);
      expect(res.status).toBe(200);
      const body = bodyOf(res);
      expect(body.templateProblem).toMatchObject({ code: 'TEMPLATE_FETCH_FAILED' });
      expect(body.templateProblem.message).not.toContain('exploded');
      expect(body.readyToSend).toBe(false);
      expect(body.preview.html).toContain('HybridCloudWorks Weekly ·');
      const logged = allLogs(ctx);
      expect(logged).toContain('TEMPLATE_FETCH_FAILED');
      expect(logged).toContain('inv-t1');
      for (const secret of [TEMPLATE_ID, ID, 'exploded', 'Landing zones', 'PO Box']) {
        expect(logged, secret).not.toContain(secret);
      }
    });

    it('names each fallback: not published, not found, unusable, no Resend key', async () => {
      const cases = [
        [
          { [TEMPLATE_ID]: [200, { id: TEMPLATE_ID, status: 'draft', html: templateHtml() }] },
          undefined,
          'TEMPLATE_NOT_PUBLISHED',
        ],
        [{}, undefined, 'TEMPLATE_NOT_FOUND'],
        [
          { [TEMPLATE_ID]: published('<html><body>no marker</body></html>') },
          undefined,
          'TEMPLATE_MARKER_MISSING',
        ],
        [{ [TEMPLATE_ID]: published() }, {}, 'RESEND_NOT_CONFIGURED'],
      ];
      for (const [templates, env, code] of cases) {
        const resend = makeResend({ templates });
        const { handlers } = build({
          store: makeStore({ settings: withTemplate }),
          resend,
          ...(env ? { env } : {}),
        });
        const body = bodyOf(await handlers.get(request(), context()));
        expect(body.templateProblem?.code, code).toBe(code);
        expect(body.preview.html, code).toContain('HybridCloudWorks Weekly ·');
      }
    });

    it('does not ask Resend at all with the built-in design chosen', async () => {
      const { handlers, resend } = build();
      const body = bodyOf(await handlers.get(request(), context()));
      expect(body.templateProblem).toBeNull();
      expect(resend.fetch).not.toHaveBeenCalled();
    });

    it('fetches a template once within five minutes, again after, and again when the chosen design changes', async () => {
      let clock = 0;
      const templateCache = createTemplateCache({ now: () => clock });
      const resend = makeResend({
        templates: { [TEMPLATE_ID]: published(), 'tpl-other': published() },
      });
      const store = makeStore({ settings: withTemplate });
      const { handlers } = build({ store, resend, templateCache });

      await handlers.get(request(), context());
      await handlers.get(request(), context());
      expect(templatePaths(resend)).toEqual([`/templates/${TEMPLATE_ID}`]);

      clock += 5 * 60 * 1000;
      await handlers.get(request(), context());
      expect(templatePaths(resend)).toHaveLength(2);

      // Settings saved with another template, then the built-in design, then
      // back: each change refetches.
      store.docs.set('admin_config/newsletter_settings', {
        ...withTemplate,
        templateId: 'tpl-other',
      });
      await handlers.get(request(), context());
      store.docs.set('admin_config/newsletter_settings', { ...withTemplate, templateId: '' });
      await handlers.get(request(), context());
      store.docs.set('admin_config/newsletter_settings', withTemplate);
      await handlers.get(request(), context());
      expect(templatePaths(resend)).toEqual([
        `/templates/${TEMPLATE_ID}`,
        `/templates/${TEMPLATE_ID}`,
        '/templates/tpl-other',
        `/templates/${TEMPLATE_ID}`,
      ]);
    });

    it('never caches a failure, so publishing the template is picked up on the next read', async () => {
      let answer = [200, { id: TEMPLATE_ID, status: 'draft', html: templateHtml() }];
      const resend = makeResend({ templates: () => answer });
      const { handlers } = build({ store: makeStore({ settings: withTemplate }), resend });
      expect(bodyOf(await handlers.get(request(), context())).templateProblem.code).toBe(
        'TEMPLATE_NOT_PUBLISHED'
      );
      answer = published();
      expect(bodyOf(await handlers.get(request(), context())).templateProblem).toBeNull();
    });
  });

  describe('test send', () => {
    it('sends the test in the template, with the unsubscribe link inert', async () => {
      const resend = makeResend({ templates: { [TEMPLATE_ID]: published() } });
      const { handlers } = build({
        role: 'publisher',
        store: makeStore({ settings: withTemplate }),
        resend,
      });
      const res = await handlers.test(request({ body: { etag: 'e1' } }), context());
      expect(res.status).toBe(200);
      expect(bodyOf(res).templateProblem).toBeUndefined();
      const [email] = resend.emails;
      expect(email.html).toContain(BRAND);
      expect(email.html).not.toContain('RESEND_UNSUBSCRIBE_URL');
      expect(email.html).toContain('<a href="#">Unsubscribe</a>');
      expect(email.html).toContain('unsubscribe link is inactive');
      expect(email.text).toContain('unsubscribe link is inactive');
    });

    it('sends the built-in design when the template is unusable, and says so', async () => {
      const resend = makeResend({
        templates: {
          [TEMPLATE_ID]: published(templateHtml('{{{NEWSLETTER_BODY}}}{{{NEWSLETTER_BODY}}}')),
        },
      });
      const { handlers } = build({
        role: 'publisher',
        store: makeStore({ settings: withTemplate }),
        resend,
      });
      const res = await handlers.test(request({ body: { etag: 'e1' } }), context());
      expect(res.status).toBe(200);
      expect(bodyOf(res).templateProblem).toMatchObject({ code: 'TEMPLATE_MARKER_REPEATED' });
      expect(resend.emails[0].html).toContain('HybridCloudWorks Weekly ·');
      expect(resend.emails[0].html).not.toContain(BRAND);
    });
  });

  describe('approve', () => {
    it('refuses with 409 TEMPLATE_UNUSABLE before any claim or broadcast when the template is unusable', async () => {
      const cases = [
        makeResend({
          templates: { [TEMPLATE_ID]: published('<html><body>no marker</body></html>') },
        }),
        makeResend({ templates: { [TEMPLATE_ID]: [503, { name: 'service_unavailable' }] } }),
        makeResend({ templates: { [TEMPLATE_ID]: new Error('socket hang up') } }),
        makeResend({ templates: {} }),
      ];
      for (const resend of cases) {
        const store = makeStore({ settings: withTemplate });
        const { handlers } = build({ role: 'publisher', store, resend });
        const ctx = { ...context(), invocationId: 'inv-t2' };
        const res = await handlers.approve(request(approveBody), ctx);
        expect(res.status).toBe(409);
        const body = bodyOf(res);
        expect(body.code).toBe('TEMPLATE_UNUSABLE');
        expect(body.templateProblem.code).toMatch(/^TEMPLATE_/);
        expect(body.error).toContain('cannot be used');
        expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
        expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({ status: 'draft', _etag: 'e1' });
        expect(resend.broadcasts).toHaveLength(0);
        const paths = resend.fetch.mock.calls.map(([url]) => new URL(url).pathname);
        expect(paths).not.toContain('/broadcasts');
        expect(paths).not.toContain('/segments');
        const logged = allLogs(ctx);
        expect(logged).toContain('inv-t2');
        for (const secret of [TEMPLATE_ID, ID, 'Landing zones', 'PO Box', 'socket hang up']) {
          expect(logged, secret).not.toContain(secret);
        }
      }
    });

    it('still refuses without a Resend key before looking for a template', async () => {
      const resend = makeResend({ templates: { [TEMPLATE_ID]: published() } });
      const { handlers } = build({
        role: 'publisher',
        store: makeStore({ settings: withTemplate }),
        resend,
        env: { NEWSLETTER_SENDING_ENABLED: 'true' },
      });
      expect((await handlers.approve(request(approveBody), context())).status).toBe(503);
      expect(resend.fetch).not.toHaveBeenCalled();
    });

    it('broadcasts the merged html, which carries the postal address and the unsubscribe placeholder', async () => {
      const resend = makeResend({ templates: { [TEMPLATE_ID]: published() } });
      const store = makeStore({ settings: withTemplate });
      const { handlers } = build({ role: 'publisher', store, resend });
      const res = await handlers.approve(request(approveBody), context());
      expect(res.status).toBe(200);
      expect(resend.broadcasts).toHaveLength(1);
      const [broadcast] = resend.broadcasts;
      expect(broadcast.html).toContain(BRAND);
      expect(broadcast.html).toContain('PO Box 1, Austin, TX');
      expect(broadcast.html).toContain('{{{RESEND_UNSUBSCRIBE_URL}}}');
      expect(broadcast.html).toContain('https://hybridcloudworks.com/a');
      expect(broadcast.html).not.toContain('{{{NEWSLETTER_BODY}}}');
      expect(broadcast.text).toContain('Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}');
      expect(store.docs.get(`newsletters/${ID}`).status).toBe('scheduled');
      // The answer's preview is the same design, from the cached copy.
      expect(bodyOf(res).preview.html).toBe(broadcast.html);
      expect(templatePaths(resend)).toHaveLength(1);
    });
  });
});

describe('parseIssuePatch', () => {
  const now = () => new Date('2026-10-03T12:00:00.000Z');

  it('normalises each scalar field and leaves out the ones not sent', () => {
    const parsed = parseIssuePatch(
      { customNote: 'line one\r\nline two  ', subject: '  Weekly   news ', etag: 'x' },
      now
    );
    expect(parsed).toEqual({ patch: { customNote: 'line one\nline two', subject: 'Weekly news' } });
  });

  it('collapses whitespace in the preheader and clears sendAt on null or an empty string', () => {
    expect(parseIssuePatch({ preheader: ' a   b ', sendAt: null }, now)).toEqual({
      patch: { preheader: 'a b', sendAt: null },
    });
    expect(parseIssuePatch({ sendAt: '' }, now)).toEqual({ patch: { sendAt: null } });
  });

  it('writes a future sendAt as an ISO instant and refuses a past or unparsable one', () => {
    expect(parseIssuePatch({ sendAt: '2026-10-04T09:00:00Z' }, now)).toEqual({
      patch: { sendAt: '2026-10-04T09:00:00.000Z' },
    });
    expect(parseIssuePatch({ sendAt: '2026-10-03T11:00:00Z' }, now)).toEqual({
      error: 'sendAt must be in the future',
    });
    expect(parseIssuePatch({ sendAt: 'tomorrow' }, now)).toEqual({
      error: 'sendAt must be an ISO instant or null',
    });
  });

  it('reports the first unacceptable field, in body order: customNote, subject, preheader, sendAt', () => {
    expect(parseIssuePatch({ customNote: 7, subject: '' }, now)).toEqual({
      error: 'customNote must be a string',
    });
    expect(parseIssuePatch({ subject: '', preheader: 3 }, now)).toEqual({
      error: 'subject must be 1 to 120 characters',
    });
    expect(parseIssuePatch({ preheader: 3 }, now)).toEqual({ error: 'preheader must be a string' });
    expect(parseIssuePatch({ customNote: 'x'.repeat(2001) }, now)).toEqual({
      error: 'customNote must be at most 2000 characters',
    });
    expect(parseIssuePatch({ preheader: 'x'.repeat(151) }, now)).toEqual({
      error: 'preheader must be at most 150 characters',
    });
  });
});
