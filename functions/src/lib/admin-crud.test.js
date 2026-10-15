/**
 * Admin CRUD (certifications + social posts) — semantics pinned to the pages
 * they replace: CertificationsPage.jsx (partial patchCert toggles, name-only
 * required field, client-side sorting) and SocialHubPage.jsx (status-filtered
 * newest-first list, createdAt stamp on create).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createAdminCrudHandlers,
  isCertImagePath,
  socialPostEditRefusal,
  validateCertification,
  validateSocialPostPatch,
} from './admin-crud.js';

const context = { log: vi.fn(), error: vi.fn() };

const allowGuard = {
  requireRole: vi.fn(async () => ({
    user: { oid: 'u1' },
    role: 'editor',
    error: null,
  })),
};
const denyGuard = {
  requireRole: vi.fn(async () => ({
    user: null,
    role: null,
    error: { status: 403, body: '{}' },
  })),
};

const makeRequest = ({ query = {}, params = {}, body } = {}) => ({
  query: { get: (k) => query[k] ?? null },
  params,
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

function makeStore(over = {}) {
  return {
    queryDocs: vi.fn(async () => []),
    readDoc: vi.fn(async () => ({ id: 'c1', name: 'AZ-104' })),
    upsertDoc: vi.fn(async (_c, d) => d),
    patchDoc: vi.fn(async (_c, _id, u) => ({ id: _id, ...u })),
    deleteDoc: vi.fn(async () => {}),
    ...over,
  };
}

const fixed = {
  now: () => new Date('2026-08-06T12:00:00.000Z'),
  uuid: () => 'fixed-uuid',
};

describe('auth', () => {
  it('every handler passes guard denials through and never touches the store', async () => {
    const store = makeStore();
    const h = createAdminCrudHandlers({ guard: denyGuard, store, ...fixed });
    const calls = [
      h.listCertifications(makeRequest(), context),
      h.createCertification(makeRequest({ body: { name: 'x' } }), context),
      h.patchCertification(
        makeRequest({ params: { id: 'c1' }, body: { featured: true } }),
        context
      ),
      h.deleteCertification(makeRequest({ params: { id: 'c1' } }), context),
      h.deleteCertificationImage(makeRequest({ body: { path: 'c1/images/x.png' } }), context),
      h.listSocialPosts(makeRequest(), context),
      h.createSocialPost(makeRequest({ body: { text: 'x' } }), context),
      h.deleteSocialPost(makeRequest({ params: { id: 's1' } }), context),
      h.patchSocialPost(makeRequest({ params: { id: 's1' }, body: { caption: 'x' } }), context),
    ];
    for (const call of calls) expect((await call).status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(store.deleteDoc).not.toHaveBeenCalled();
  });
});

describe('certifications', () => {
  it('create requires a name and stamps id + timestamps', async () => {
    const store = makeStore();
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });

    expect(
      (await h.createCertification(makeRequest({ body: { issuer: 'MS' } }), context)).status
    ).toBe(400);

    const res = await h.createCertification(
      makeRequest({ body: { name: 'AZ-104', id: 'client-chosen' } }),
      context
    );
    const body = JSON.parse(res.body);
    expect(body.id).toBe('fixed-uuid'); // client id never becomes the key
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc._createdAt).toBe('2026-08-06T12:00:00.000Z');
    expect(doc._updatedAt).toBe('2026-08-06T12:00:00.000Z');
  });

  it('patch is partial — a single-field toggle patches, never replaces', async () => {
    const store = makeStore();
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.patchCertification(
      makeRequest({ params: { id: 'c1' }, body: { featured: true } }),
      context
    );
    expect(res.status).toBe(200);
    // the load-bearing assertion: patch, not replace (never upserts to certifications)
    expect(store.upsertDoc.mock.calls.some(([c]) => c === 'certifications')).toBe(false);
    expect(store.upsertDoc.mock.calls.some(([c, d]) => c === 'admin_audit_logs' && d.action === 'certification_updated')).toBe(true);
    const [container, id, updates] = store.patchDoc.mock.calls[0];
    expect(container).toBe('certifications');
    expect(id).toBe('c1');
    expect(updates).toEqual({
      featured: true,
      _updatedAt: '2026-08-06T12:00:00.000Z',
    });
  });

  it('patch 404s a missing doc and strips a client-sent id from updates', async () => {
    const h404 = createAdminCrudHandlers({
      guard: allowGuard,
      store: makeStore({ readDoc: vi.fn(async () => null) }),
      ...fixed,
    });
    expect(
      (await h404.patchCertification(makeRequest({ params: { id: 'x' }, body: { a: 1 } }), context))
        .status
    ).toBe(404);

    const store = makeStore();
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });
    await h.patchCertification(
      makeRequest({ params: { id: 'c1' }, body: { id: 'evil', name: 'N' } }),
      context
    );
    expect(store.patchDoc.mock.calls[0][2]).not.toHaveProperty('id');
  });

  it('stores calendar days, refuses an expiry before the issue date and a bad URL, allows order 0', async () => {
    const store = makeStore();
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });
    const ok = await h.createCertification(
      makeRequest({
        body: {
          name: 'AZ-104',
          issueDate: '2026-01-02T00:00:00.000Z',
          expDate: '2027-01-02',
          renewalDate: '2026-11-01',
          display_order: 0,
          verifyUrl: 'https://www.credly.com/badges/x',
          evidence: [{ label: 'Transcript', url: 'https://t' }, { url: 'nope' }],
          relatedLearning: ['https://learn.microsoft.com/az-104'],
        },
      }),
      context
    );
    expect(ok.status).toBe(200);
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({
      issueDate: '2026-01-02',
      expDate: '2027-01-02',
      renewalDate: '2026-11-01',
      display_order: 0,
      evidence: [{ label: 'Transcript', url: 'https://t' }],
      relatedLearning: [
        {
          label: 'https://learn.microsoft.com/az-104',
          url: 'https://learn.microsoft.com/az-104',
        },
      ],
    });

    const before = await h.createCertification(
      makeRequest({
        body: { name: 'X', issueDate: '2026-05-01', expDate: '2026-04-30' },
      }),
      context
    );
    expect(before.status).toBe(400);
    expect(JSON.parse(before.body).error).toMatch(/expDate/);
    expect(
      (
        await h.createCertification(
          makeRequest({ body: { name: 'X', verifyUrl: 'javascript:1' } }),
          context
        )
      ).status
    ).toBe(400);
    expect(
      (
        await h.createCertification(
          makeRequest({ body: { name: 'X', display_order: -1 } }),
          context
        )
      ).status
    ).toBe(400);
    expect(
      (
        await h.createCertification(
          makeRequest({ body: { name: 'X', expDate: '2026-02-30' } }),
          context
        )
      ).status
    ).toBe(400);
  });

  it('a partial patch checks the new expiry against the stored issue date', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'c1',
        name: 'AZ-104',
        issueDate: '2026-06-01',
      })),
    });
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });
    expect(
      (
        await h.patchCertification(
          makeRequest({
            params: { id: 'c1' },
            body: { expDate: '2026-01-01' },
          }),
          context
        )
      ).status
    ).toBe(400);
    const ok = await h.patchCertification(
      makeRequest({
        params: { id: 'c1' },
        body: { expDate: '2027-01-01T05:00:00Z' },
      }),
      context
    );
    expect(ok.status).toBe(200);
    expect(store.patchDoc.mock.calls[0][2].expDate).toBe('2027-01-01');
    expect(
      validateCertification({
        imageUrl: '/api/public/media/certifications/c1/images/b.png',
      }).value.imageUrl
    ).toBe('/api/public/media/certifications/c1/images/b.png');

    expect(validateCertification({ _createdAt: '1999-01-01' }).error).toMatch(/Unknown field/);
    expect(validateCertification({ _updatedAt: '1999-01-01' }).error).toMatch(/Unknown field/);
  });

  it('deletes an abandoned upload only at a cert image path nothing references', async () => {
    const storage = { deleteBlob: vi.fn(async () => {}) };
    const store = makeStore({ queryDocs: vi.fn(async () => []) });
    const h = createAdminCrudHandlers({
      guard: allowGuard,
      store,
      storage,
      ...fixed,
    });
    expect(isCertImagePath('c1/images/badge-1.png')).toBe(true);
    expect(isCertImagePath('images/badge-1.png')).toBe(false);
    expect(isCertImagePath('../c1/images/x.png')).toBe(false);

    expect(
      (await h.deleteCertificationImage(makeRequest({ body: { path: 'exports/x.json' } }), context))
        .status
    ).toBe(400);
    const ok = await h.deleteCertificationImage(
      makeRequest({ body: { path: 'c1/images/badge-1.png' } }),
      context
    );
    expect(ok.status).toBe(200);
    expect(storage.deleteBlob).toHaveBeenCalledWith('certifications', 'c1/images/badge-1.png');

    store.queryDocs.mockResolvedValueOnce([{ id: 'c1' }]);
    expect(
      (
        await h.deleteCertificationImage(
          makeRequest({ body: { path: 'c1/images/badge-2.png' } }),
          context
        )
      ).status
    ).toBe(409);
    expect(storage.deleteBlob).toHaveBeenCalledTimes(1);

    const noStorage = createAdminCrudHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    });
    expect(
      (
        await noStorage.deleteCertificationImage(
          makeRequest({ body: { path: 'c1/images/b.png' } }),
          context
        )
      ).status
    ).toBe(503);
  });

  it('list and delete round-trip through the store', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async () => [{ id: 'a' }, { id: 'b' }]),
    });
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.listCertifications(makeRequest(), context);
    expect(JSON.parse(res.body).total).toBe(2);

    await h.deleteCertification(makeRequest({ params: { id: 'a' } }), context);
    expect(store.deleteDoc).toHaveBeenCalledWith('certifications', 'a');
  });
});

describe('social posts', () => {
  it('lists with the page default statuses, newest first, parameterized', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async () => [
        { id: 'old', status: 'published', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'new', status: 'scheduled', createdAt: '2026-06-01T00:00:00Z' },
      ]),
    });
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.listSocialPosts(makeRequest(), context);
    expect(JSON.parse(res.body).items.map((i) => i.id)).toEqual(['new', 'old']);

    const [container, query, params] = store.queryDocs.mock.calls[0];
    expect(container).toBe('social_posts');
    expect(query).toContain('ARRAY_CONTAINS(@statuses, c.status)');
    expect(params[0].value).toEqual(['scheduled', 'published']);
  });

  it('honors an explicit status filter and the limit clamp', async () => {
    const store = makeStore();
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });
    await h.listSocialPosts(
      makeRequest({ query: { status: 'draft,failed', limit: '5000' } }),
      context
    );
    expect(store.queryDocs.mock.calls[0][2][0].value).toEqual(['draft', 'failed']);
  });

  it('status=all lists without a status clause (CalendarPage)', async () => {
    const store = makeStore();
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });
    await h.listSocialPosts(makeRequest({ query: { status: 'all' } }), context);
    const [, query, params] = store.queryDocs.mock.calls[0];
    expect(query).not.toContain('WHERE');
    expect(params).toEqual([]);
  });

  it('create stamps createdAt and a fresh id; delete targets the container', async () => {
    const store = makeStore();
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });
    await h.createSocialPost(makeRequest({ body: { text: 'Post', status: 'scheduled' } }), context);
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc.id).toBe('fixed-uuid');
    expect(doc.createdAt).toBe('2026-08-06T12:00:00.000Z');

    await h.deleteSocialPost(makeRequest({ params: { id: 's1' } }), context);
    expect(store.deleteDoc).toHaveBeenCalledWith('social_posts', 's1');
  });

  it('rejects malformed bodies', async () => {
    const h = createAdminCrudHandlers({
      guard: allowGuard,
      store: makeStore(),
      ...fixed,
    });
    expect((await h.createSocialPost(makeRequest({ body: [1, 2] }), context)).status).toBe(400);
    expect((await h.createSocialPost(makeRequest(), context)).status).toBe(400);
  });
});

describe('social posts: patch (ADR 0033 Amplify slice)', () => {
  const scheduled = {
    id: 's1',
    status: 'scheduled',
    caption: 'old',
    scheduledAt: '2026-09-01T09:00:00.000Z',
    publerPostIds: ['p1'],
  };
  const patch = (store, body) =>
    createAdminCrudHandlers({
      guard: allowGuard,
      store,
      ...fixed,
    }).patchSocialPost(makeRequest({ params: { id: 's1' }, body }), context);

  it('reschedules into the future and marks the edit for the change feed to push', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => scheduled) });
    const res = await patch(store, {
      caption: 'new caption',
      scheduledAt: '2026-09-02T09:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(store.patchDoc.mock.calls[0][2]).toMatchObject({
      caption: 'new caption',
      scheduledAt: '2026-09-02T09:00:00.000Z',
      syncOrigin: 'calendar',
      syncStatus: 'pending',
    });
    expect(JSON.parse(res.body).publer).toEqual({
      push: 'change-feed',
      postIds: ['p1'],
    });
  });

  it('refuses the past, unknown fields, a cleared time, and edits to a published post', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => scheduled) });
    expect((await patch(store, { scheduledAt: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await patch(store, { status: 'published' })).status).toBe(400);
    expect((await patch(store, { scheduledAt: null })).status).toBe(400);
    expect(store.patchDoc).not.toHaveBeenCalled();
    const published = makeStore({
      readDoc: vi.fn(async () => ({ ...scheduled, status: 'published' })),
    });
    expect((await patch(published, { caption: 'x' })).status).toBe(409);
  });

  it('says the next sync will carry a post Publer has not reported ids for', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ ...scheduled, publerPostIds: [] })),
    });
    const res = JSON.parse((await patch(store, { caption: 'x' })).body);
    expect(res.publer.push).toBe('next-sync');
  });
});

describe('social posts: the patch validator and the edit refusal (ADR 0033 Amplify slice)', () => {
  const nowMs = Date.parse('2026-09-01T00:00:00.000Z');

  it('cleans each editable field and names the first bad one', () => {
    expect(
      validateSocialPostPatch(
        { caption: '  hi  ', url: null, scheduledAt: '2026-09-02T09:00:00Z' },
        nowMs
      )
    ).toEqual({
      updates: { caption: 'hi', url: null, scheduledAt: '2026-09-02T09:00:00.000Z' },
    });
    expect(validateSocialPostPatch({ caption: '' }, nowMs).error).toMatch(/caption must be 1 to/);
    expect(validateSocialPostPatch({ url: 'ftp://x' }, nowMs).error).toBe(
      'url must be absolute http(s)'
    );
    expect(validateSocialPostPatch({ scheduledAt: 'soon' }, nowMs).error).toBe(
      'scheduledAt must be an ISO instant'
    );
    expect(validateSocialPostPatch({ caption: 'x', status: 'y' }, nowMs).error).toBe(
      'Unknown field(s): status'
    );
  });

  it('refuses edits to a published post and reschedules only a scheduled one', () => {
    expect(socialPostEditRefusal({ status: 'published' }, { caption: 'x' })).toMatch(/published/);
    expect(socialPostEditRefusal({ status: 'draft' }, { scheduledAt: 'x' })).toMatch(
      /this one is draft/
    );
    expect(socialPostEditRefusal({ status: 'draft' }, { caption: 'x' })).toBeNull();
    expect(socialPostEditRefusal({ status: 'scheduled' }, { scheduledAt: 'x' })).toBeNull();
  });
});

describe('AP-B6: mass assignment allowlists on admin CRUD writes', () => {
  it('social post creation rejects unknown fields with 400 and does not persist them', async () => {
    const store = makeStore();
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.createSocialPost(
      makeRequest({ body: { caption: 'Safe post', maliciousField: true, adminBypass: 'yes' } }),
      context
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Unknown field\(s\): maliciousField, adminBypass/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('certification create and patch reject unknown fields with 400', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'c1', name: 'Existing Cert' })),
    });
    const h = createAdminCrudHandlers({ guard: allowGuard, store, ...fixed });

    const createRes = await h.createCertification(
      makeRequest({ body: { name: 'Valid Cert', injection: 'drop database' } }),
      context
    );
    expect(createRes.status).toBe(400);
    expect(JSON.parse(createRes.body).error).toMatch(/Unknown field\(s\) for certification: injection/);
    expect(store.upsertDoc).not.toHaveBeenCalled();

    const patchRes = await h.patchCertification(
      makeRequest({ params: { id: 'c1' }, body: { evilProp: 123 } }),
      context
    );
    expect(patchRes.status).toBe(400);
    expect(JSON.parse(patchRes.body).error).toMatch(/Unknown field\(s\) for certification: evilProp/);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});

