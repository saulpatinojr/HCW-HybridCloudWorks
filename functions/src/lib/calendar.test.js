/**
 * The calendar aggregate (ADR 0033 §4). What must hold: every source is one
 * collector over a fake store, a collector that fails costs its own items and
 * adds a warning, an unprovisioned Ambassador container is silence rather
 * than a warning, and the route validates its window before reading.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  collectAmbassadorDeadlines,
  collectCalendar,
  collectCertifications,
  collectContentSchedules,
  collectListenAndLearnReleases,
  collectNewsletterIssues,
  collectSocialPosts,
  collectSpeakingEvents,
  createCalendarHandlers,
  dayBounds,
  toInstant,
} from './calendar.js';

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-11-01T00:00:00.000Z');
const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A store whose queryDocs answers by container; `rows` maps container → rows or Error. */
const storeOf = (rows) => ({
  queryDocs: vi.fn(async (container) => {
    const value = rows[container];
    if (value instanceof Error) throw value;
    return value ?? [];
  }),
});

/** A newsletter issue as the collector reads it: its id, status, subject and the instants that place it. */
const issueRow = (id, status, subject, when) => ({ id, status, subject, ...when });

describe('toInstant', () => {
  it('reads a calendar date as an all-day UTC midnight and an ISO instant as timed', () => {
    expect(toInstant('2026-10-05')).toEqual({
      iso: '2026-10-05T00:00:00.000Z',
      allDay: true,
    });
    expect(toInstant('2026-10-05T09:30:00.000Z')).toEqual({
      iso: '2026-10-05T09:30:00.000Z',
      allDay: false,
    });
    expect(toInstant({ seconds: 1780000000 })).toEqual({
      iso: new Date(1780000000000).toISOString(),
      allDay: false,
    });
    expect(toInstant('not a date')).toBeNull();
    expect(toInstant(null)).toBeNull();
  });

  it('day bounds take the day after `to` so a bare date on the last day is included', () => {
    expect(dayBounds(FROM, new Date('2026-10-31T12:00:00.000Z'))).toEqual({
      fromDay: '2026-10-01',
      toDay: '2026-11-01',
    });
  });
});

describe('collectors', () => {
  it('content: scheduled items, failed when the time has passed, and published by publishedAt', async () => {
    const store = {
      queryDocs: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'a',
            Title: 'Future',
            contentStatus: 'approved',
            scheduledPublishDate: '2099-10-10T09:00:00.000Z',
          },
          {
            id: 'b',
            title: 'Overdue',
            contentStatus: 'approved',
            scheduledPublishDate: '2026-10-02T09:00:00.000Z',
          },
          {
            id: 'c',
            title: 'Rejected',
            contentStatus: 'rejected',
            scheduledPublishDate: '2026-10-03T09:00:00.000Z',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'd',
            Title: 'Went live',
            contentStatus: 'published',
            Live: true,
            publishedAt: '2026-10-04T10:00:00.000Z',
          },
        ]),
    };
    const items = await collectContentSchedules({
      store,
      from: FROM,
      to: new Date('2100-01-01T00:00:00.000Z'),
    });
    expect(items.map((i) => [i.id, i.status])).toEqual([
      ['content:a', 'scheduled'],
      ['content:b', 'failed'],
      ['content:d:published', 'published'],
    ]);
    expect(items[0].href).toBe('/admin/review-queue/a?source=content');
    expect(items[1].meta.error).toMatch(/not live/);
  });

  it('newsletter: scheduled by scheduledAt, sent by sentAt, drafts never', async () => {
    const store = storeOf({
      newsletters: [
        issueRow('issue-2026-10-06', 'scheduled', 'Next', {
          scheduledAt: '2026-10-06T14:00:00.000Z',
        }),
        issueRow('issue-2026-09-29', 'sent', 'Last', {
          sentAt: '2026-10-01T14:00:00.000Z',
          scheduledAt: '2026-09-29T14:00:00.000Z',
        }),
        issueRow('issue-2026-10-07', 'draft', 'Draft', { scheduledAt: '2026-10-07T14:00:00.000Z' }),
      ],
    });
    const items = await collectNewsletterIssues({ store, from: FROM, to: TO });
    expect(items.map((i) => [i.id, i.status, i.start])).toEqual([
      ['newsletter:issue-2026-10-06', 'scheduled', '2026-10-06T14:00:00.000Z'],
      ['newsletter:issue-2026-09-29', 'sent', '2026-10-01T14:00:00.000Z'],
    ]);
    expect(items[0].href).toContain('issue=issue-2026-10-06');
  });

  it('social: every status, sync failures read as failed, caption and platforms carried', async () => {
    const store = storeOf({
      social_posts: [
        {
          id: 's1',
          caption: 'Hello',
          status: 'scheduled',
          scheduledAt: '2026-10-10T15:00:00.000Z',
          platforms: ['linkedin'],
        },
        {
          id: 's2',
          caption: 'Broken',
          status: 'scheduled',
          syncStatus: 'failed',
          syncError: 'Publer 500',
          scheduledAt: '2026-10-11T15:00:00.000Z',
        },
      ],
    });
    const items = await collectSocialPosts({ store, from: FROM, to: TO });
    expect(items[0]).toMatchObject({
      kind: 'social',
      status: 'scheduled',
      meta: { platforms: ['linkedin'], caption: 'Hello' },
    });
    expect(items[1]).toMatchObject({
      status: 'failed',
      meta: { error: 'Publer 500' },
    });
  });

  it('speaking: the event date and a CFP deadline are two items, calendar dates all-day', async () => {
    const store = storeOf({
      speakerevents: [
        {
          id: 'e1',
          eventName: 'KubeCon',
          date: '2026-10-20',
          cfpDeadline: '2026-10-05',
          status: 'accepted',
        },
      ],
    });
    const items = await collectSpeakingEvents({ store, from: FROM, to: TO });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'speaking:e1',
      allDay: true,
      start: '2026-10-20T00:00:00.000Z',
      status: 'accepted',
    });
    expect(items[1]).toMatchObject({
      id: 'speaking:e1:cfp',
      title: 'CFP deadline: KubeCon',
      status: 'deadline',
    });
    const [, , params] = store.queryDocs.mock.calls[0];
    expect(params).toEqual([
      { name: '@fromDay', value: '2026-10-01' },
      { name: '@toDay', value: '2026-11-02' },
    ]);
  });

  it('certifications: expiration and renewal dates, each its own item', async () => {
    const store = storeOf({
      certifications: [
        {
          id: 'c1',
          name: 'AZ-104',
          expDate: '2026-10-15T00:00:00.000Z',
          renewalDate: '2026-10-01',
        },
      ],
    });
    const items = await collectCertifications({ store, from: FROM, to: TO });
    expect(items.map((i) => i.title)).toEqual(['Expires: AZ-104', 'Renew: AZ-104']);
    expect(items.every((i) => i.status === 'deadline')).toBe(true);
  });

  it('ambassador: an unprovisioned container is an empty answer, other failures throw', async () => {
    const missing = Object.assign(new Error('Resource Not Found'), {
      code: 404,
    });
    expect(
      await collectAmbassadorDeadlines({
        store: storeOf({ ambassador: missing }),
        from: FROM,
        to: TO,
      })
    ).toEqual([]);
    await expect(
      collectAmbassadorDeadlines({
        store: storeOf({ ambassador: new Error('throttled') }),
        from: FROM,
        to: TO,
      })
    ).rejects.toThrow('throttled');
    const items = await collectAmbassadorDeadlines({
      store: storeOf({
        ambassador: [
          {
            id: 'app1',
            programName: 'MVP',
            submissionDeadline: '2026-10-31',
            renewalDate: '2027-01-01',
          },
        ],
      }),
      from: FROM,
      to: TO,
    });
    expect(items).toEqual([
      expect.objectContaining({
        title: 'Submit: MVP',
        kind: 'ambassador',
        allDay: true,
      }),
    ]);
  });

  it('audio: episodes by approvedAt', async () => {
    const store = storeOf({
      listen_and_learn_episodes: [
        {
          id: 'ep1',
          title: 'Identity',
          status: 'published',
          approvedAt: '2026-10-03T08:00:00.000Z',
          provider: 'azure',
        },
      ],
    });
    const items = await collectListenAndLearnReleases({
      store,
      from: FROM,
      to: TO,
    });
    expect(items[0]).toMatchObject({
      kind: 'audio',
      status: 'published',
      meta: { provider: 'azure' },
    });
  });
});

describe('collectCalendar', () => {
  it('a failing collector costs its items and adds a warning; the rest still answer, sorted by start', async () => {
    const collectors = {
      content: async () => [{ id: 'content:1', start: '2026-10-09T00:00:00.000Z' }],
      social: async () => {
        throw new Error('Cosmos down');
      },
      audio: async () => [{ id: 'audio:1', start: '2026-10-02T00:00:00.000Z' }],
    };
    const log = { warn: vi.fn() };
    const { items, warnings } = await collectCalendar({
      store: {},
      from: FROM,
      to: TO,
      collectors,
      log,
    });
    expect(items.map((i) => i.id)).toEqual(['audio:1', 'content:1']);
    // The collector's code, never its sentence: warnings reach the page (#945).
    expect(warnings).toEqual(['social: could not be read (Error)']);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('kinds narrows which collectors run', async () => {
    const content = vi.fn(async () => []);
    const social = vi.fn(async () => []);
    await collectCalendar({
      store: {},
      from: FROM,
      to: TO,
      collectors: { content, social },
      kinds: ['social'],
    });
    expect(content).not.toHaveBeenCalled();
    expect(social).toHaveBeenCalledTimes(1);
  });
});

describe('route', () => {
  const request = (query) => ({ query: { get: (k) => query[k] ?? null } });
  const allow = {
    requireRole: vi.fn(async () => ({ user: { oid: 'u1' }, error: null })),
  };
  const deny = {
    requireRole: vi.fn(async () => ({ error: { status: 403, body: '{}' } })),
  };

  it('denies before reading anything', async () => {
    const store = storeOf({});
    const h = createCalendarHandlers({ guard: deny, store });
    const res = await h.read(request({ from: FROM.toISOString(), to: TO.toISOString() }), context);
    expect(res.status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('validates the window: both instants, ordered, at most 100 days', async () => {
    const h = createCalendarHandlers({ guard: allow, store: storeOf({}) });
    expect((await h.read(request({ from: 'x', to: TO.toISOString() }), context)).status).toBe(400);
    expect(
      (await h.read(request({ from: TO.toISOString(), to: FROM.toISOString() }), context)).status
    ).toBe(400);
    expect(
      (await h.read(request({ from: '2026-01-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }), context))
        .status
    ).toBe(400);
  });

  it('keeps the guard\'s refusal out of every cache, since this answer can carry private alerts', async () => {
    const refusal = {
      requireRole: vi.fn(async () => ({
        error: { status: 401, headers: { 'WWW-Authenticate': 'Bearer' }, body: '{"error":"no"}' },
      })),
    };
    const h = createCalendarHandlers({ guard: refusal, store: storeOf({}) });
    const res = await h.read(request({ from: FROM.toISOString(), to: TO.toISOString() }), context);
    expect(res.status).toBe(401);
    expect(res.body).toBe('{"error":"no"}');
    expect(res.headers).toEqual({ 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'private, no-store' });
  });

  it('answers items and warnings for a valid window', async () => {
    const collectors = {
      content: async () => [{ id: 'content:1', start: '2026-10-09T00:00:00.000Z' }],
      speaking: async () => {
        throw new Error('nope');
      },
    };
    const h = createCalendarHandlers({
      guard: allow,
      store: storeOf({}),
      collectors,
    });
    const res = await h.read(request({ from: FROM.toISOString(), to: TO.toISOString() }), context);
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    // The answer can carry the owner's private alerts, so no cache may keep it.
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(body.items).toHaveLength(1);
    expect(body.warnings).toEqual(['speaking: could not be read (Error)']);
    expect(body.total).toBe(1);
  });
});
