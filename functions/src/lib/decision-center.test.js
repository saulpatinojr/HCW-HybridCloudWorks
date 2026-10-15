/**
 * The Decision Center (#1013, #1014): every source's categorisation, the
 * newest-first order, the in_review fix, per-source failure isolation, the
 * role each source needs, and the bounded, ordered read every source makes.
 */
import { describe, it, expect, vi } from 'vitest';
import { SOURCES, collectDecisions, createDecisionCenterHandlers } from './decision-center.js';
import { byNewest, countByCategory, decisionItem } from './decision-center/items.js';
import { CANONICAL_TYPE_SQL } from './decision-center/content-sources.js';
import {
  ambassadorHref,
  chapterHref,
  contentHref,
  contentStage,
  newsletterIssueHref,
} from './decision-center/links.js';
// The dashboard's list of where each source's whole list lives. It imports
// nothing, so it loads here; the frontend cannot load this module in return
// (its CI job installs no Azure SDK), which is why this check lives here.
import { SOURCE_PAGES } from '../../../frontend/src/components/admin/dashboard/decisionCenterModel.js';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const now = () => NOW;
const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const request = { json: async () => ({}) };

const guardAs = (role) => ({
  requireRole: vi.fn(async () => ({ user: { oid: 'u1' }, role, error: null })),
});

const param = (params, name) => params?.find((p) => p.name === name)?.value;

/** The canonical type as CANONICAL_TYPE_SQL computes it in Cosmos. */
const canonicalOf = (row) =>
  String([row.type, row.contentType, row.publishTarget].find((v) => typeof v === 'string' && v !== '') ?? 'blog')
    .trim()
    .toLowerCase();

/** Content rows answered by which source's window asked: its statuses, its type, and the types it leaves out. */
function contentRows(params, content) {
  const statuses = param(params, '@statuses') || [];
  const type = param(params, '@type');
  const excluded = param(params, '@excludeTypes') || [];
  return content.filter(
    (row) =>
      statuses.includes(row.contentStatus) &&
      (!type || canonicalOf(row) === type) &&
      !excluded.includes(canonicalOf(row))
  );
}

/** A store that answers each container from `data`, recording every query. */
function fakeStore(data = {}) {
  const store = {
    queryDocs: vi.fn(async (container, query, params) => {
      const rows = data[container];
      if (rows instanceof Error) throw rows;
      if (container === 'content') return contentRows(params, rows || []);
      return rows || [];
    }),
    readDoc: vi.fn(async (container) => {
      const doc = data[`${container}:doc`];
      if (doc instanceof Error) throw doc;
      return doc || null;
    }),
  };
  return store;
}

const FULL = {
  content: [
    { id: 'ingested-1', contentStatus: 'ingested', type: 'blog', Title: 'Feed item', fetchedAt: '2026-10-07T00:00:00Z' },
    {
      id: 'sent-1',
      contentStatus: 'in_review',
      type: 'blog',
      Title: 'Sent from Drafts',
      'Created At': '2026-09-01T00:00:00Z',
      sentToReviewAt: '2026-10-08T09:00:00Z',
    },
    { id: 'fw-1', contentStatus: 'inspected', type: 'framework', Title: 'A framework', fetchedAt: '2026-10-06T00:00:00Z' },
    { id: 'cc-1', contentStatus: 'draft', type: 'coder_corner', Title: 'A snippet', fetchedAt: '2026-10-05T00:00:00Z' },
    { id: 'rework-1', contentStatus: 'needs_rework', type: 'blog', Title: 'Fix me', updatedAt: '2026-10-04T00:00:00Z' },
    { id: 'forge-1', contentStatus: 'forge_ready', type: 'blog', Title: 'Forged', updatedAt: '2026-10-03T00:00:00Z' },
    { id: 'staged-1', contentStatus: 'published', Live: false, type: 'blog', Title: 'Staged', updatedAt: '2026-10-02T00:00:00Z' },
    { id: 'blocked', contentStatus: 'ingested', sourceUrl: 'https://stackfeed.io/x', fetchedAt: '2026-10-08T11:00:00Z' },
  ],
  podcast_transcripts: [{ id: 't1', title: 'Episode one', status: 'draft', generatedAt: '2026-10-01T00:00:00Z' }],
  listen_and_learn_episodes: [
    { id: 'ch1', setId: 'azure_az-104', provider: 'azure', examCode: 'AZ-104', title: 'Storage', status: 'failed', updatedAt: '2026-09-30T00:00:00Z' },
    { id: 'gone', setId: 'azure_az-104', provider: 'azure', examCode: 'AZ-104', status: 'draft', softDeletedAt: '2026-09-29T00:00:00Z' },
  ],
  newsletters: [
    { id: 'issue-2026-10-06', status: 'draft', savedAt: '2026-09-28T00:00:00Z', createdAt: '2026-09-27T00:00:00Z' },
    { id: 'issue-2026-10-13', status: 'draft', createdAt: '2026-09-26T00:00:00Z' },
  ],
  social_posts: [{ id: 's1', caption: 'Read this', status: 'draft', contentId: 'c9', createdAt: '2026-09-25T00:00:00Z' }],
  admin_config: [{ id: 'forge_queue_item:1', url: 'https://example.com/a', status: 'failed', error: 'timeout', updatedAt: '2026-09-24T00:00:00Z' }],
  workflow_alerts: [
    { id: 'a1', alertType: 'scheduled_publish_failures', severity: 'critical', firstSeenAt: '2026-09-23T00:00:00Z' },
    // Reopened after a resolve: open again, whatever `active` said before.
    { id: 'a3', alertType: 'reopened', status: 'open', active: false, firstSeenAt: '2026-09-21T00:00:00Z' },
    { id: 'a2', alertType: 'quiet', active: false, firstSeenAt: '2026-09-22T00:00:00Z' },
    { id: 'a4', alertType: 'seen', status: 'acknowledged', firstSeenAt: '2026-09-20T00:00:00Z' },
  ],
  'admin_config:doc': {
    reminders: [
      { id: 'r-over', title: 'Token expires', dueDate: '2026-10-01', leadDays: 7 },
      { id: 'r-today', title: 'Re-verify', dueDate: '2026-10-08', leadDays: 7 },
      { id: 'r-later', title: 'Later', dueDate: '2026-10-20', leadDays: 7 },
      { id: 'r-done', title: 'Done', dueDate: '2026-09-01', leadDays: 7, done: true },
    ],
  },
  ambassador: [
    { id: 'app1', programName: 'MVP', status: 'preparing', submissionDeadline: '2026-10-10' },
    { id: 'app2', programName: 'Hero', status: 'active', renewalDate: '2026-12-31' },
  ],
};

const ENV = { GOOD: 'value', ELEVENLABS_API_KEY: '@Microsoft.KeyVault(SecretUri=https://x)' };

async function collectAs(role, data = FULL, extra = {}) {
  return collectDecisions({ store: fakeStore(data), now, env: ENV, role, log: context, ...extra });
}

const ids = (items) => items.map((item) => item.id);

describe('collectDecisions — categories and order', () => {
  it('puts every source in its tab, newest first', async () => {
    const { items, counts, errors } = await collectAs('editor');
    expect(errors).toEqual([]);
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));

    expect(byId['content:ingested-1'].category).toBe('queues');
    expect(byId['content:sent-1'].category).toBe('queues');
    expect(byId['content:fw-1'].category).toBe('frameworks');
    expect(byId['content:cc-1'].category).toBe('other');
    expect(byId['content:rework-1']).toMatchObject({ category: 'queues', stage: 'editor', priority: 'high' });
    expect(byId['content:forge-1']).toMatchObject({ category: 'pipelines', stage: 'publish' });
    expect(byId['content:staged-1'].category).toBe('pipelines');
    expect(byId['transcript:t1'].category).toBe('pipelines');
    expect(byId['chapter:azure_az-104/ch1']).toMatchObject({ category: 'pipelines', stage: 'retry', priority: 'high' });
    expect(byId['newsletter:issue-2026-10-06']).toMatchObject({ stage: 'approval' });
    expect(byId['social:s1'].category).toBe('pipelines');
    expect(byId['forge-queue:forge_queue_item:1'].category).toBe('pipelines');
    expect(byId['alert:a1']).toMatchObject({ category: 'governance', priority: 'high' });
    expect(byId['secret:ELEVENLABS_API_KEY'].category).toBe('governance');
    expect(byId['reminder:r-over']).toMatchObject({ category: 'other', stage: 'overdue', priority: 'high' });
    expect(byId['reminder:r-today']).toMatchObject({ stage: 'due', priority: 'normal' });
    expect(byId['ambassador:app1:submissionDeadline']).toMatchObject({ category: 'other', priority: 'high' });

    // Newest first, untimed last: the item sent to review this morning leads.
    expect(items[0].id).toBe('content:sent-1');
    expect(items.at(-1).id).toBe('secret:ELEVENLABS_API_KEY');
    const timed = items.filter((item) => item.waitingSince).map((item) => Date.parse(item.waitingSince));
    expect(timed).toEqual([...timed].sort((a, b) => b - a));

    expect(counts).toEqual(countByCategory(items));
    expect(counts.all).toBe(items.length);
    expect(counts.frameworks).toBe(1);
  });

  it('dates an ambassador deadline from when it came inside the two-week window', async () => {
    const { items } = await collectAs('editor');
    const deadline = items.find((item) => item.id === 'ambassador:app1:submissionDeadline');
    expect(deadline).toMatchObject({
      waitingSince: '2026-09-26T00:00:00.000Z',
      detail: 'Due 2026-10-10',
      href: '/admin/ambassador?tab=applications&application=app1',
    });
  });

  it('leaves out what is not a decision: blocked sources, soft-deleted chapters, resolved or acknowledged alerts, later and done reminders, far deadlines', async () => {
    const found = ids((await collectAs('editor')).items);
    expect(found).not.toContain('content:blocked');
    expect(found).not.toContain('chapter:azure_az-104/gone');
    expect(found).not.toContain('alert:a2'); // no status, active false: resolved
    expect(found).not.toContain('alert:a4');
    expect(found).toContain('alert:a3');
    expect(found).not.toContain('reminder:r-later');
    expect(found).not.toContain('reminder:r-done');
    expect(found).not.toContain('ambassador:app2:renewalDate');
  });

  it('includes in_review in the review queue, linked to its review board (#1014)', async () => {
    const store = fakeStore(FULL);
    const { items } = await collectDecisions({ store, now, env: {}, role: 'viewer' });
    const sent = items.find((item) => item.id === 'content:sent-1');
    expect(sent).toMatchObject({
      category: 'queues',
      stage: 'review',
      status: 'in_review',
      waitingSince: '2026-10-08T09:00:00.000Z',
      href: '/admin/review-queue/sent-1?source=content',
    });
    const reviewWindow = store.queryDocs.mock.calls.find(
      ([container, , params]) => container === 'content' && !param(params, '@type') && param(params, '@statuses').includes('ingested')
    );
    expect(param(reviewWindow[2], '@statuses')).toEqual(['draft', 'ingested', 'inspected', 'in_review']);
  });

  it('leaves the frameworks and Coder Corner out of the review window in the query, so they cannot fill it (review of #1021)', async () => {
    const frameworks = Array.from({ length: 120 }, (_, i) => ({
      id: `fw-${i}`,
      contentStatus: 'inspected',
      type: 'Framework ',
      fetchedAt: '2026-10-08T10:00:00Z',
    }));
    const data = {
      ...FULL,
      content: [...frameworks, { id: 'blog-1', contentStatus: 'ingested', type: 'blog', fetchedAt: '2026-09-01T00:00:00Z' }],
    };
    const store = fakeStore(data);
    const { items } = await collectDecisions({ store, now, env: {}, role: 'viewer' });
    expect(ids(items)).toContain('content:blog-1');
    const reviewWindow = store.queryDocs.mock.calls.find(
      ([container, , params]) => container === 'content' && param(params, '@excludeTypes')
    );
    expect(param(reviewWindow[2], '@excludeTypes')).toEqual(['framework', 'coder_corner']);
    expect(reviewWindow[1]).toContain(`AND NOT ARRAY_CONTAINS(@excludeTypes, ${CANONICAL_TYPE_SQL})`);
    // The type sources still have their own windows.
    expect(items.filter((item) => item.category === 'frameworks').length).toBeGreaterThan(0);
  });

  it('reads the newsletter issues by their last write, so a keep or a reject of an old issue is in the window (review of #1021)', async () => {
    const store = fakeStore(FULL);
    await collectDecisions({ store, now, env: {}, role: 'super_admin' });
    const [, query] = store.queryDocs.mock.calls.find(([container]) => container === 'newsletters');
    expect(query).toMatch(/ ORDER BY c\._ts DESC$/);
  });

  it('reads every source with a bounded, ordered query — no unbounded scan', async () => {
    const store = fakeStore(FULL);
    await collectDecisions({ store, now, env: {}, role: 'super_admin' });
    expect(store.queryDocs).toHaveBeenCalled();
    for (const [container, query] of store.queryDocs.mock.calls) {
      expect(query, container).toMatch(/^SELECT TOP \d+ /);
      expect(query, container).toMatch(/ ORDER BY c\.\w+ DESC$/);
      expect(query, container).not.toContain('SELECT *');
    }
    const forgeQueue = store.queryDocs.mock.calls.find(([container]) => container === 'admin_config');
    expect(forgeQueue[3]).toEqual({ partitionKey: 'admin_config' });
  });
});

describe('collectDecisions — failure isolation', () => {
  it('a failing source costs only its own items, and says so without leaking the error', async () => {
    const data = { ...FULL, podcast_transcripts: new Error('Request rate is large. ActivityId: secret-123') };
    const { items, errors, sources } = await collectAs('editor', data);
    expect(ids(items)).not.toContain('transcript:t1');
    expect(ids(items)).toContain('content:ingested-1');
    expect(errors).toEqual([
      {
        source: 'podcast-transcripts',
        label: 'Podcast transcripts awaiting approval',
        category: 'pipelines',
        message: 'Podcast transcripts awaiting approval could not be read just now.',
      },
    ]);
    expect(JSON.stringify(errors)).not.toContain('secret-123');
    expect(sources.find((row) => row.id === 'podcast-transcripts')).toMatchObject({ count: 0, error: expect.any(String) });
    expect(context.warn).toHaveBeenCalledWith(expect.stringContaining('podcast-transcripts failed'));
  });

  it('reads a container that is not provisioned yet as nothing waiting, not as an error', async () => {
    const missing = Object.assign(new Error('Resource Not Found'), { code: 404 });
    const { errors, sources } = await collectAs('editor', { ...FULL, ambassador: missing });
    expect(errors).toEqual([]);
    expect(sources.find((row) => row.id === 'ambassador')).toMatchObject({ count: 0, error: null });
  });

  it('a reminders document that does not validate is that source failing, not the read', async () => {
    const data = { ...FULL, 'admin_config:doc': { reminders: [{ id: 'bad id!', title: '', dueDate: 'x' }] } };
    const { errors, items } = await collectAs('editor', data);
    expect(errors.map((error) => error.source)).toEqual(['reminders']);
    expect(items.length).toBeGreaterThan(0);
  });

  it('marks a source whose window was full as truncated', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, status: 'draft', generatedAt: NOW.toISOString() }));
    const { sources } = await collectAs('editor', { ...FULL, podcast_transcripts: many });
    expect(sources.find((row) => row.id === 'podcast-transcripts')).toMatchObject({ count: 50, truncated: true });
    expect(sources.find((row) => row.id === 'newsletters').truncated).toBe(false);
  });
});

describe('collectDecisions — roles', () => {
  it('gives a viewer the sources a viewer may list, and names the ones left out', async () => {
    const { items, sources } = await collectAs('viewer');
    const kinds = new Set(items.map((item) => item.kind));
    expect(kinds.has('transcript')).toBe(false);
    expect(kinds.has('reminder')).toBe(false);
    expect(kinds.has('ambassador')).toBe(false);
    expect(kinds.has('alert')).toBe(true);
    expect(kinds.has('secret')).toBe(true);
    const restricted = sources.filter((row) => row.restricted).map((row) => row.id);
    expect(restricted).toEqual([
      'podcast-transcripts',
      'listen-and-learn',
      'newsletters',
      'social',
      'forge-queue',
      'reminders',
      'ambassador',
    ]);
  });

  it('reports one row per source in SOURCES order', async () => {
    const { sources } = await collectAs('super_admin');
    expect(sources.map((row) => row.id)).toEqual(SOURCES.map((source) => source.id));
    expect(sources.every((row) => !row.restricted)).toBe(true);
  });

  it('names every source once, with a category the dashboard has a tab for and a list page it links to', () => {
    const sourceIds = SOURCES.map((source) => source.id);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    for (const source of SOURCES) {
      expect(['frameworks', 'queues', 'pipelines', 'governance', 'other'], source.id).toContain(
        source.category
      );
      expect(['viewer', 'editor'], source.id).toContain(source.role);
      expect(SOURCE_PAGES, source.id).toHaveProperty(source.id);
    }
  });
});

describe('getDecisionCenter', () => {
  it('denies without reading anything', async () => {
    const store = fakeStore(FULL);
    const guard = {
      requireRole: vi.fn(async () => ({ user: null, role: null, error: { status: 403, body: '{}' } })),
    };
    const res = await createDecisionCenterHandlers({ guard, store, now }).getDecisionCenter(request, context);
    expect(res.status).toBe(403);
    expect(guard.requireRole).toHaveBeenCalledWith(request, 'viewer');
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('answers the items, counts, sources and errors for the caller’s role', async () => {
    const h = createDecisionCenterHandlers({ guard: guardAs('editor'), store: fakeStore(FULL), now, env: ENV });
    const res = await h.getDecisionCenter(request, context);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ success: true, generatedAt: NOW.toISOString(), errors: [] });
    expect(body.items.length).toBe(body.counts.all);
    expect(body.sources).toHaveLength(SOURCES.length);
  });
});

describe('links', () => {
  it('opens a content item at its stage', () => {
    expect(contentHref({ id: 'a', contentStatus: 'inspected' })).toBe('/admin/review-queue/a?source=content');
    expect(contentHref({ id: 'a', contentStatus: 'in_review' })).toBe('/admin/review-queue/a?source=content');
    expect(contentHref({ id: 'a', contentStatus: 'approved' })).toBe('/admin/editor/a');
    expect(contentHref({ id: 'a', contentStatus: 'needs_rework' })).toBe('/admin/editor/a');
    expect(contentHref({ id: 'a', contentStatus: 'drafting' })).toBe('/admin/drafts');
    expect(contentHref({ id: 'a b', contentStatus: 'forge_ready' })).toBe('/admin/review-queue/a%20b?source=content');
    expect(contentStage({ contentStatus: 'approved', Live: true })).toBe('live');
    expect(contentStage({ contentStatus: 'rejected', Live: true })).toBe('off');
    expect(contentStage({ contentStatus: 'approved_blog' })).toBe('editor');
    expect(contentStage({ contentStatus: 'constructor' })).toBe('review');
  });

  it('names the parameter each page focuses an item by', () => {
    expect(newsletterIssueHref('issue-1', 'drafts')).toBe('/admin/newsletter-hub?tab=drafts&issue=issue-1');
    expect(chapterHref({ provider: 'azure', examCode: 'AZ-104', id: 'storage' })).toBe(
      '/admin/listen-and-learn?tab=review&platform=azure&exam=AZ-104&chapter=storage'
    );
    expect(chapterHref({ id: 'orphan' })).toBe('/admin/listen-and-learn?tab=review');
    expect(ambassadorHref('app1')).toBe('/admin/ambassador?tab=applications&application=app1');
  });
});

describe('items', () => {
  it('normalises the shape and sorts untimed items last', () => {
    const a = decisionItem({ id: 'b', title: '  spaced\n title ', waitingSince: '2026-01-01', priority: 'urgent' });
    expect(a).toMatchObject({ title: 'spaced title', waitingSince: '2026-01-01T00:00:00.000Z', priority: 'normal' });
    const untimed = decisionItem({ id: 'a' });
    expect(untimed.title).toBe('Untitled');
    expect([untimed, a].sort(byNewest).map((item) => item.id)).toEqual(['b', 'a']);
  });
});
