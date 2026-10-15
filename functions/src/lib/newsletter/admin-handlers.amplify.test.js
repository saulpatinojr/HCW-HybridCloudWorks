/**
 * The Newsletter Hub's issue management added for ADR 0033 (Amplify slice):
 * a scheduled issue reaches `sent` by asking Resend, a scheduled broadcast
 * can be canceled and rescheduled from here with Resend's own refusal shown
 * when it refuses, a failed issue is retried as a fresh draft, an issue can
 * be duplicated, a save records a version, a per-issue send time wins over
 * the settings slot, manual blocks can be added, and the From address is a
 * setting with the code constant as its default.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  applySectionEdit,
  createNewsletterAdminHandlers,
  normalizeManualItem,
  planFor,
} from './admin-handlers.js';
import { DEFAULT_NEWSLETTER_FROM } from './sender.js';
import { createTemplateCache } from './template-source.js';
import { fakeResend as makeResend } from './fake-resend.test-helper.js';

const API_KEY = 'not-a-real-resend-key-EXAMPLE-VALUE-FOR-TESTS';
const NOW = new Date('2026-10-03T12:00:00Z'); // Saturday
const ID = 'issue-2026-09-29';
const fail = (code) => Object.assign(new Error(`fake Cosmos ${code}`), { code });

const settings = {
  id: 'newsletter_settings',
  postalAddress: 'PO Box 1, Austin, TX',
  replyTo: 'owner@example.com',
  sendDay: 'tuesday',
  sendTime: '09:00',
  timeZone: 'America/Chicago',
};

const issueOf = (over = {}) => ({
  id: ID,
  kind: 'weekly_issue',
  status: 'scheduled',
  subject: 'Landing zones',
  intro: 'We covered a lot.',
  customNote: '',
  preheader: 'Inbox line',
  periodStart: '2026-09-22T12:00:00Z',
  periodEnd: '2026-09-29T12:00:00Z',
  sections: [
    {
      id: 'articles',
      title: 'New',
      items: [{ title: 'A', url: 'https://hybridcloudworks.com/a' }],
    },
  ],
  itemCount: 1,
  broadcastId: 'bc-old',
  scheduledAt: '2026-09-29T14:00:00.000Z',
  approvedAt: '2026-09-28T12:00:00.000Z',
  savedAt: '2026-09-28T11:00:00.000Z',
  _etag: 'e1',
  ...over,
});

function makeStore({ issue = issueOf(), extra = [] } = {}) {
  const docs = new Map();
  if (issue) docs.set(`newsletters/${issue.id}`, issue);
  for (const doc of extra) docs.set(`newsletters/${doc.id}`, doc);
  docs.set('admin_config/newsletter_settings', settings);
  let etag = 1;
  return {
    docs,
    readDoc: vi.fn(async (container, id) => {
      const doc = docs.get(`${container}/${id}`);
      return doc ? { ...doc } : null;
    }),
    queryDocs: vi.fn(async () => [...docs.values()].filter((d) => d.kind === 'weekly_issue')),
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
      return { ...stored };
    }),
  };
}

const allow = (role = 'publisher') => ({
  requireRole: vi.fn(async (_req, required) => {
    const rank = { editor: 1, publisher: 2 };
    return rank[role] >= rank[required]
      ? { user: { oid: 'owner-oid' }, error: null }
      : { error: { status: 403, body: '{}' } };
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
  role = 'publisher',
  now = NOW,
  env = { RESEND_API_KEY: API_KEY, NEWSLETTER_SENDING_ENABLED: 'true' },
} = {}) {
  const handlers = createNewsletterAdminHandlers({
    guard: allow(role),
    store,
    env,
    fetch: resend.fetch,
    now: () => now,
    templateCache: createTemplateCache(),
  });
  return { handlers, store, resend };
}

describe('reconcile on read', () => {
  it('get moves a scheduled issue to sent when Resend says so, and says why when it cannot tell', async () => {
    const { handlers, store } = build({
      resend: makeResend({
        broadcast: { status: 'sent', sent_at: '2026-09-29T14:00:05.000Z' },
      }),
    });
    const res = await handlers.get(request(), context());
    expect(bodyOf(res).issue).toMatchObject({
      status: 'sent',
      sentAt: '2026-09-29T14:00:05.000Z',
    });
    expect(store.docs.get(`newsletters/${ID}`).status).toBe('sent');

    const dim = build({
      resend: makeResend({ broadcast: { status: 'draft' } }),
    });
    const unsure = await dim.handlers.get(request(), context());
    expect(bodyOf(unsure).reconcileWarning).toMatch(/status "draft"/);
    expect(dim.store.docs.get(`newsletters/${ID}`).status).toBe('scheduled');
  });

  it('a missing broadcast is a failed issue with the reason, and Retry makes it a draft again', async () => {
    const { handlers, store } = build({
      resend: makeResend({ broadcast: 404 }),
    });
    const res = await handlers.get(request(), context());
    expect(bodyOf(res).issue).toMatchObject({
      status: 'failed',
      lastError: expect.stringMatching(/no longer has broadcast bc-old/),
    });
    const etag = store.docs.get(`newsletters/${ID}`)._etag;
    const retried = await handlers.retry(request({ body: { etag } }), context());
    expect(bodyOf(retried).issue).toMatchObject({
      status: 'failed' === 'x' ? 'x' : 'draft',
      broadcastId: null,
      scheduledAt: null,
      savedAt: expect.any(String),
    });
    expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({
      status: 'draft',
      failedBroadcastId: 'bc-old',
    });
    expect(
      (
        await handlers.retry(
          request({
            body: { etag: store.docs.get(`newsletters/${ID}`)._etag },
          }),
          context()
        )
      ).status
    ).toBe(409);
  });

  it('the list reconciles overdue scheduled rows and leaves future ones alone', async () => {
    const future = issueOf({
      id: 'issue-2026-10-06',
      broadcastId: 'bc-future',
      scheduledAt: '2026-10-06T14:00:00.000Z',
    });
    const store = makeStore({ extra: [future] });
    const resend = makeResend({
      broadcast: { status: 'sent', sent_at: '2026-09-29T14:00:05.000Z' },
    });
    const { handlers } = build({ store, resend });
    const res = await handlers.list(request(), context());
    const rows = Object.fromEntries(bodyOf(res).issues.map((row) => [row.id, row.status]));
    expect(rows).toEqual({ [ID]: 'sent', 'issue-2026-10-06': 'scheduled' });
    expect(
      resend.calls.filter((c) => c.method === 'GET' && c.pathname.startsWith('/broadcasts/'))
    ).toHaveLength(1);
  });

  it('the reconcile route asks about every scheduled issue', async () => {
    const future = issueOf({
      id: 'issue-2026-10-06',
      broadcastId: 'bc-future',
      scheduledAt: '2026-10-06T14:00:00.000Z',
    });
    const { handlers } = build({
      store: makeStore({ extra: [future] }),
      resend: makeResend({ broadcast: { status: 'sent' } }),
    });
    const res = await handlers.reconcile(request(), context());
    expect(bodyOf(res)).toMatchObject({
      ok: true,
      reconciled: 2,
      changed: [ID, 'issue-2026-10-06'],
    });
  });
});

describe('cancel and reschedule', () => {
  it('cancel deletes the broadcast and returns the issue to Drafts, approvable again', async () => {
    const { handlers, store, resend } = build();
    const res = await handlers.cancel(request({ body: { etag: 'e1' } }), context());
    expect(res.status).toBe(200);
    expect(resend.calls).toContainEqual(
      expect.objectContaining({
        method: 'DELETE',
        pathname: '/broadcasts/bc-old',
      })
    );
    expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({
      status: 'draft',
      broadcastId: null,
      scheduledAt: null,
      canceledBroadcastId: 'bc-old',
      savedAt: '2026-09-28T11:00:00.000Z',
    });
  });

  it("cancel names Resend's status and error name, never its sentence, and writes nothing", async () => {
    const { handlers, store } = build({
      resend: makeResend({ refuseDelete: true }),
    });
    const res = await handlers.cancel(request({ body: { etag: 'e1' } }), context());
    expect(res.status).toBe(502);
    // A provider's own words stay out of the answer (#945).
    expect(bodyOf(res)).toMatchObject({
      code: 'CANCEL_REFUSED',
      error: 'Resend did not cancel the broadcast: HTTP 403 restricted_api_key',
    });
    expect(res.body).not.toMatch(/cannot be deleted on this plan/);
    expect(store.docs.get(`newsletters/${ID}`).status).toBe('scheduled');
  });

  it('cancel is publisher-only, needs the etag, and only a scheduled issue', async () => {
    expect(
      (
        await build({ role: 'editor' }).handlers.cancel(
          request({ body: { etag: 'e1' } }),
          context()
        )
      ).status
    ).toBe(403);
    expect((await build().handlers.cancel(request({ body: {} }), context())).status).toBe(400);
    expect(
      (await build().handlers.cancel(request({ body: { etag: 'stale' } }), context())).status
    ).toBe(409);
    const draft = build({
      store: makeStore({
        issue: issueOf({ status: 'draft', broadcastId: null }),
      }),
    });
    expect((await draft.handlers.cancel(request({ body: { etag: 'e1' } }), context())).status).toBe(
      409
    );
  });

  it('reschedule cancels the old broadcast and creates one at the new time', async () => {
    const { handlers, store, resend } = build();
    const res = await handlers.reschedule(
      request({ body: { etag: 'e1', scheduledAt: '2026-10-07T14:00:00Z' } }),
      context()
    );
    expect(res.status).toBe(200);
    const created = resend.calls.find((c) => c.method === 'POST' && c.pathname === '/broadcasts');
    expect(created.body).toMatchObject({
      scheduled_at: '2026-10-07T14:00:00.000Z',
      from: DEFAULT_NEWSLETTER_FROM,
      subject: 'Landing zones',
    });
    expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({
      status: 'scheduled',
      scheduledAt: '2026-10-07T14:00:00.000Z',
      sendAt: '2026-10-07T14:00:00.000Z',
      broadcastId: expect.stringMatching(/^bc-\d+$/),
    });
  });

  it('reschedule refuses the past, and when Resend refuses the new broadcast the issue says so as a draft', async () => {
    expect(
      (
        await build().handlers.reschedule(
          request({
            body: { etag: 'e1', scheduledAt: '2020-01-01T00:00:00Z' },
          }),
          context()
        )
      ).status
    ).toBe(400);
    const { handlers, store } = build({
      resend: makeResend({ failCreate: true }),
    });
    const res = await handlers.reschedule(
      request({ body: { etag: 'e1', scheduledAt: '2026-10-07T14:00:00Z' } }),
      context()
    );
    expect(res.status).toBe(502);
    expect(store.docs.get(`newsletters/${ID}`)).toMatchObject({
      status: 'draft',
      broadcastId: null,
      lastError: expect.stringMatching(/Resend refused the new one: HTTP 422 validation_error\./),
    });
    expect(store.docs.get(`newsletters/${ID}`).lastError).not.toMatch(/scheduled_at is in the past/);
  });
});

describe('drafts: send time, versions, manual blocks, duplicate', () => {
  const draft = () =>
    issueOf({
      status: 'draft',
      broadcastId: null,
      scheduledAt: null,
      approvedAt: null,
    });

  it('planFor prefers a future sendAt and reports an expired one', () => {
    expect(planFor({ sendAt: '2026-10-10T15:00:00.000Z' }, settings, NOW)).toEqual({
      sendNow: false,
      scheduledAt: '2026-10-10T15:00:00.000Z',
      override: true,
    });
    // Saturday noon: Tuesday 09:00 Central is more than 72 h away, so the slot rule says send now.
    expect(planFor({ sendAt: '2026-10-01T15:00:00.000Z' }, settings, NOW)).toEqual({
      sendNow: true,
      overrideExpired: true,
    });
    expect(planFor({}, settings, NOW)).toEqual({ sendNow: true });
  });

  it('saving records the replaced version (last ten) and accepts a future sendAt that approval then uses', async () => {
    const { handlers, store, resend } = build({
      store: makeStore({ issue: draft() }),
    });
    let res = await handlers.update(
      request({
        body: { etag: 'e1', subject: 'Second', sendAt: '2026-10-05T15:30:00Z' },
      }),
      context()
    );
    expect(res.status).toBe(200);
    expect(bodyOf(res).issue.versions).toEqual([
      expect.objectContaining({
        subject: 'Landing zones',
        preheader: 'Inbox line',
        itemCount: 1,
        by: 'owner-oid',
      }),
    ]);
    expect(bodyOf(res).sendPlan).toEqual({
      sendNow: false,
      scheduledAt: '2026-10-05T15:30:00.000Z',
      override: true,
    });
    expect(bodyOf(res).fromAddress).toBe(DEFAULT_NEWSLETTER_FROM);

    res = await handlers.approve(
      request({ body: { etag: store.docs.get(`newsletters/${ID}`)._etag } }),
      context()
    );
    expect(res.status).toBe(200);
    expect(resend.calls.find((c) => c.pathname === '/broadcasts').body.scheduled_at).toBe(
      '2026-10-05T15:30:00.000Z'
    );

    const past = build({ store: makeStore({ issue: draft() }) });
    expect(
      (
        await past.handlers.update(
          request({ body: { etag: 'e1', sendAt: '2020-01-01T00:00:00Z' } }),
          context()
        )
      ).status
    ).toBe(400);
  });

  it('a manual item may be added to a section, or to a manual section of its own; collected items still cannot be edited', () => {
    const stored = draft().sections;
    const manual = {
      manual: true,
      title: 'Our webinar',
      url: 'https://hybridcloudworks.com/webinar',
      summary: 'Join us',
      imageUrl: '/media/webinar.png',
    };
    const ok = applySectionEdit(stored, [
      { id: 'articles', items: [...stored[0].items, manual] },
      {
        id: 'manual-editor',
        title: 'From the editor',
        items: [{ manual: true, title: 'Note', url: 'https://example.com/x' }],
      },
    ]);
    expect(ok.error).toBeUndefined();
    expect(ok.itemCount).toBe(3);
    expect(ok.sections[0].items[1]).toEqual({
      manual: true,
      title: 'Our webinar',
      url: 'https://hybridcloudworks.com/webinar',
      summary: 'Join us',
      imageUrl: 'https://hybridcloudworks.com/media/webinar.png',
    });
    expect(ok.sections[1]).toMatchObject({
      id: 'manual-editor',
      title: 'From the editor',
      manual: true,
    });

    expect(applySectionEdit(stored, [{ id: 'random', title: 'x', items: [manual] }]).error).toMatch(
      /a section was added/
    );
    expect(applySectionEdit(stored, [{ id: 'manual', items: [manual] }]).error).toMatch(
      /needs a title/
    );
    expect(
      applySectionEdit(stored, [
        {
          id: 'articles',
          items: [{ title: 'Edited', url: 'https://hybridcloudworks.com/a' }],
        },
      ]).error
    ).toMatch(/cannot be edited/);
    expect(
      normalizeManualItem({
        manual: true,
        title: 'x',
        url: 'http://insecure.example.com',
      }).error
    ).toMatch(/https/);
    expect(
      normalizeManualItem({
        manual: true,
        title: 'x',
        url: 'https://ok.example.com',
        imageUrl: 'javascript:alert(1)',
      }).error
    ).toMatch(/image/);
  });

  it('manual items reach the stored issue and the rendered email through update', async () => {
    const { handlers, store } = build({ store: makeStore({ issue: draft() }) });
    const res = await handlers.update(
      request({
        body: {
          etag: 'e1',
          sections: [
            {
              id: 'articles',
              items: [
                ...draft().sections[0].items,
                {
                  manual: true,
                  title: 'Our webinar',
                  url: 'https://hybridcloudworks.com/webinar',
                  imageUrl: 'https://hybridcloudworks.com/media/w.png',
                },
              ],
            },
          ],
        },
      }),
      context()
    );
    expect(res.status).toBe(200);
    expect(store.docs.get(`newsletters/${ID}`).itemCount).toBe(2);
    expect(bodyOf(res).preview.html).toContain('https://hybridcloudworks.com/media/w.png');
    expect(bodyOf(res).preview.html).toContain('Our webinar');
  });

  it('duplicate makes a kept draft under today, suffixed when today is taken, with the source named', async () => {
    const today = issueOf({
      id: 'issue-2026-10-03',
      status: 'draft',
      broadcastId: null,
    });
    const { handlers, store } = build({
      store: makeStore({ extra: [today] }),
      role: 'editor',
    });
    const res = await handlers.duplicate(request(), context());
    expect(res.status).toBe(200);
    expect(bodyOf(res).issue).toMatchObject({
      id: 'issue-2026-10-03-2',
      status: 'draft',
      subject: 'Landing zones',
      duplicatedFrom: ID,
      savedAt: NOW.toISOString(),
    });
    expect(store.docs.get('newsletters/issue-2026-10-03-2').sections).toEqual(issueOf().sections);
    // The suffixed id is read back by the issue routes.
    expect((await handlers.get(request({ id: 'issue-2026-10-03-2' }), context())).status).toBe(200);
  });

  it('a failed issue can be deleted; a scheduled one still cannot', async () => {
    const failed = build({
      store: makeStore({ issue: issueOf({ status: 'failed' }) }),
      role: 'editor',
    });
    expect(
      (await failed.handlers.remove(request({ body: { etag: 'e1' } }), context())).status
    ).toBe(200);
    const scheduled = build({ role: 'editor' });
    expect(
      (await scheduled.handlers.remove(request({ body: { etag: 'e1' } }), context())).status
    ).toBe(409);
  });
});

describe('sender', () => {
  it('reads the default when nothing is stored, and the stored sender once set', async () => {
    const { handlers, store } = build();
    expect(bodyOf(await handlers.getSender(request(), context()))).toMatchObject({
      ok: true,
      from: DEFAULT_NEWSLETTER_FROM,
      isDefault: true,
    });
    const put = await handlers.putSender(
      request({
        body: { from: 'HCW Weekly <weekly@news.hybridcloudworks.com>' },
      }),
      context()
    );
    expect(bodyOf(put)).toMatchObject({
      ok: true,
      from: 'HCW Weekly <weekly@news.hybridcloudworks.com>',
      isDefault: false,
    });
    expect(store.docs.get('admin_config/newsletter_sender')).toMatchObject({
      configScope: 'admin_config',
      from: 'HCW Weekly <weekly@news.hybridcloudworks.com>',
    });
    // Every send now uses it.
    const sent = await handlers.test(
      request({ body: { etag: store.docs.get(`newsletters/${ID}`)._etag } }),
      context()
    );
    expect(sent.status).toBe(409); // scheduled, not a draft — but the From was resolved before refusing nothing here
    expect(bodyOf(await handlers.getSender(request(), context())).from).toBe(
      'HCW Weekly <weekly@news.hybridcloudworks.com>'
    );
    // Empty returns to the default.
    expect(
      bodyOf(await handlers.putSender(request({ body: { from: '' } }), context()))
    ).toMatchObject({ isDefault: true });
  });

  it('refuses an address that does not parse or sits on a domain Resend has not verified; accepts a verified one', async () => {
    const { handlers } = build({
      resend: makeResend({
        domains: [{ name: 'mail.example.com', status: 'verified' }],
      }),
    });
    expect((await handlers.putSender(request({ body: { from: 'nope' } }), context())).status).toBe(
      400
    );
    const unverified = await handlers.putSender(
      request({ body: { from: 'x@other.example.com' } }),
      context()
    );
    expect(unverified.status).toBe(400);
    expect(bodyOf(unverified)).toMatchObject({
      code: 'DOMAIN_NOT_SENDING',
      error: expect.stringMatching(/other\.example\.com is not a sending domain/),
    });
    expect(
      (await handlers.putSender(request({ body: { from: 'x@mail.example.com' } }), context()))
        .status
    ).toBe(200);
    expect(
      (
        await build({ role: 'editor' }).handlers.putSender(
          request({ body: { from: 'x@mail.example.com' } }),
          context()
        )
      ).status
    ).toBe(403);
  });
});
