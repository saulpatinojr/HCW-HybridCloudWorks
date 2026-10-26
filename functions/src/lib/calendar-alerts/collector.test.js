/**
 * Calendar alerts on the Calendar: the collector that shows them on their due
 * days, and the guarantee that the Calendar read does nothing to them, and
 * they nothing to the publisher.
 */
import { describe, expect, it, vi } from 'vitest';

import { COLLECTORS, createCalendarHandlers } from '../calendar.js';
import { createScheduledPublisher } from '../scheduled-publish.js';
import { ALERTS_HREF, collectAlerts } from './collector.js';
import { CALENDAR_ALERTS_DOC_ID } from './model.js';

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-11-01T00:00:00.000Z');
const NOW = new Date('2026-10-26T09:00:00.000Z');
const SECRET = 'PRIVATE-NOTE-3c9';

const row = (over = {}) => ({
  id: 'a1',
  title: 'Renew the domain',
  dueDate: '2026-10-28',
  dueTime: null,
  link: '',
  note: '',
  status: 'open',
  snoozedUntil: null,
  doneAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const docOf = (alerts) => ({
  id: CALENDAR_ALERTS_DOC_ID,
  configScope: 'admin_config',
  docType: 'calendar_alerts',
  alerts,
  // The starting alert has been made (and may have been deleted): not added again.
  seeded: ['docker-dsos-application'],
  _etag: '"1"',
});

const storeOf = (alerts, content = []) => ({
  readDoc: vi.fn(async (container, id) =>
    container === 'admin_config' && id === CALENDAR_ALERTS_DOC_ID ? docOf(alerts) : null
  ),
  queryDocs: vi.fn(async (container) => (container === 'content' ? content : [])),
});

describe('collectAlerts', () => {
  it('shows an alert with no time as an all-day item on its UTC date', async () => {
    const items = await collectAlerts({ store: storeOf([row()]), from: FROM, to: TO, now: () => NOW });
    expect(items).toEqual([
      expect.objectContaining({
        id: 'alert:a1',
        kind: 'alert',
        title: 'Renew the domain',
        start: '2026-10-28T00:00:00.000Z',
        end: null,
        allDay: true,
        status: 'open',
        href: ALERTS_HREF,
        sourceId: 'a1',
        sourceCollection: 'admin_config',
      }),
    ]);
  });

  it('shows an alert with a time as a 30-minute item at that UTC time', async () => {
    const [timed] = await collectAlerts({
      store: storeOf([row({ dueTime: '14:30' })]),
      from: FROM,
      to: TO,
      now: () => NOW,
    });
    expect(timed).toMatchObject({
      start: '2026-10-28T14:30:00.000Z',
      end: '2026-10-28T15:00:00.000Z',
      allDay: false,
    });
  });

  it('carries the state today as its status, so a snooze that ended reads as open', async () => {
    const items = await collectAlerts({
      store: storeOf([
        row({ id: 'open' }),
        row({ id: 'done', status: 'done', doneAt: '2026-10-20T00:00:00.000Z' }),
        row({ id: 'snoozed', status: 'snoozed', snoozedUntil: '2026-10-29' }),
        row({ id: 'lapsed', status: 'snoozed', snoozedUntil: '2026-10-26' }),
      ]),
      from: FROM,
      to: TO,
      now: () => NOW,
    });
    expect(Object.fromEntries(items.map((entry) => [entry.sourceId, entry.status]))).toEqual({
      open: 'open',
      done: 'done',
      snoozed: 'snoozed',
      lapsed: 'open',
    });
  });

  it('carries the note, link and snooze day the preview shows', async () => {
    const [entry] = await collectAlerts({
      store: storeOf([row({ note: 'Ask for the code.', link: 'https://example.com/renew', status: 'snoozed', snoozedUntil: '2026-10-29' })]),
      from: FROM,
      to: TO,
      now: () => NOW,
    });
    expect(entry.meta).toEqual({
      note: 'Ask for the code.',
      link: 'https://example.com/renew',
      dueTime: null,
      snoozedUntil: '2026-10-29',
    });
  });

  it('leaves out alerts whose day is outside the window, and rows it cannot read', async () => {
    const items = await collectAlerts({
      store: storeOf([
        row({ id: 'before', dueDate: '2026-09-30' }),
        row({ id: 'inside', dueDate: '2026-10-01' }),
        row({ id: 'after', dueDate: '2026-11-01' }),
        { id: 'broken', title: '', dueDate: 'soon', status: 'open' },
      ]),
      from: FROM,
      to: TO,
      now: () => NOW,
    });
    expect(items.map((entry) => entry.sourceId)).toEqual(['inside']);
  });

  describe('the starting alert, before the alerts list has made it', () => {
    const SEED = 'docker-dsos-application';

    it('shows it from a missing document, so the grid agrees with the panel on the first visit', async () => {
      const store = { readDoc: vi.fn(async () => null) };
      const items = await collectAlerts({ store, from: FROM, to: TO, now: () => NOW });
      expect(items).toEqual([
        expect.objectContaining({
          id: 'alert:' + SEED,
          kind: 'alert',
          title: 'Submit the Docker-Sponsored Open Source application',
          start: '2026-10-30T00:00:00.000Z',
          allDay: true,
          status: 'open',
        }),
      ]);
    });

    it('writes nothing to show it', async () => {
      const store = {
        readDoc: vi.fn(async () => null),
        createDoc: vi.fn(),
        replaceDocIfMatch: vi.fn(),
        upsertDoc: vi.fn(),
      };
      await collectAlerts({ store, from: FROM, to: TO, now: () => NOW });
      expect(store.createDoc).not.toHaveBeenCalled();
      expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
      expect(store.upsertDoc).not.toHaveBeenCalled();
    });

    it('does not show it again once it is recorded as made, so a deleted one stays gone', async () => {
      const store = {
        readDoc: vi.fn(async () => ({ ...docOf([]), seeded: [SEED] })),
      };
      await expect(collectAlerts({ store, from: FROM, to: TO, now: () => NOW })).resolves.toEqual([]);
    });

    it('shows a finished one once, as done, and not a second copy', async () => {
      const store = {
        readDoc: vi.fn(async () => ({
          ...docOf([row({ id: SEED, title: 'Submit it', dueDate: '2026-10-30', status: 'done', doneAt: '2026-10-27T00:00:00.000Z' })]),
          seeded: [SEED],
        })),
      };
      const items = await collectAlerts({ store, from: FROM, to: TO, now: () => NOW });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ sourceId: SEED, status: 'done', title: 'Submit it' });
    });

    it('does not add a second copy when the row exists but the record was never written', async () => {
      const store = {
        readDoc: vi.fn(async () => ({ ...docOf([row({ id: SEED, title: 'Mine', dueDate: '2026-10-30' })]), seeded: [] })),
      };
      const items = await collectAlerts({ store, from: FROM, to: TO, now: () => NOW });
      expect(items.filter((entry) => entry.sourceId === SEED)).toHaveLength(1);
    });
  });

  it('reads one document and nothing else', async () => {
    const store = storeOf([row()]);
    await collectAlerts({ store, from: FROM, to: TO, now: () => NOW });
    expect(store.readDoc).toHaveBeenCalledTimes(1);
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', CALENDAR_ALERTS_DOC_ID, 'admin_config');
    expect(store.queryDocs).not.toHaveBeenCalled();
  });
});

describe('the Calendar read', () => {
  const allow = { requireRole: vi.fn(async () => ({ user: { oid: 'u' }, role: 'editor' })) };
  const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const request = (query) => ({ query: new Map(Object.entries(query)), headers: { get: () => null } });
  const window = { from: FROM.toISOString(), to: TO.toISOString() };

  const contentRow = {
    id: 'post-1',
    Title: 'A scheduled post',
    contentStatus: 'approved',
    scheduledPublishDate: '2026-10-28T12:00:00.000Z',
  };

  it('is registered as the alert kind, beside the others', () => {
    expect(Object.keys(COLLECTORS)).toContain('alert');
  });

  it('lists an alert beside scheduled content, each as its own kind', async () => {
    const store = storeOf([row({ note: SECRET })], [contentRow]);
    const handlers = createCalendarHandlers({ guard: allow, store });
    const response = await handlers.read(request(window), context);
    const body = JSON.parse(response.body);
    expect(response.status).toBe(200);
    expect(body.warnings).toEqual([]);
    expect(body.items.map((entry) => `${entry.kind}:${entry.sourceId}`).sort()).toEqual([
      'alert:a1',
      'content:post-1',
    ]);
    const alert = body.items.find((entry) => entry.kind === 'alert');
    expect(alert.sourceCollection).toBe('admin_config');
    expect(alert.id.startsWith('alert:')).toBe(true);
  });

  it('narrows to alerts, or leaves them out, by kind', async () => {
    const store = storeOf([row()], [contentRow]);
    const handlers = createCalendarHandlers({ guard: allow, store });
    const only = JSON.parse((await handlers.read(request({ ...window, kinds: 'alert' }), context)).body);
    expect(only.items.map((entry) => entry.kind)).toEqual(['alert']);
    expect(store.queryDocs).not.toHaveBeenCalled();

    const without = JSON.parse(
      (await handlers.read(request({ ...window, kinds: 'content,newsletter' }), context)).body
    );
    expect(without.items.map((entry) => entry.kind)).toEqual(['content']);
  });

  it('costs only the alerts, with a warning, when they cannot be read', async () => {
    const store = storeOf([row()], [contentRow]);
    store.readDoc.mockRejectedValue(new Error('store down'));
    const handlers = createCalendarHandlers({ guard: allow, store });
    const body = JSON.parse((await handlers.read(request(window), context)).body);
    expect(body.items.map((entry) => entry.kind)).toEqual(['content']);
    expect(body.warnings).toEqual(['alert: could not be read (Error)']);
    expect(JSON.stringify(body)).not.toContain('store down');
  });

  it('is refused below the editor role, like the rest of the Calendar', async () => {
    const deny = { requireRole: vi.fn(async () => ({ error: { status: 403, headers: {}, body: '{}' } })) };
    const store = storeOf([row()]);
    const response = await createCalendarHandlers({ guard: deny, store }).read(request(window), context);
    expect(response.status).toBe(403);
    expect(store.readDoc).not.toHaveBeenCalled();
  });

  it('never writes: reading the Calendar publishes, schedules and changes nothing', async () => {
    const store = {
      ...storeOf([row()], [contentRow]),
      createDoc: vi.fn(),
      replaceDocIfMatch: vi.fn(),
      upsertDoc: vi.fn(),
      patchDoc: vi.fn(),
      deleteDoc: vi.fn(),
    };
    const publish = { processPublishContent: vi.fn() };
    const handlers = createCalendarHandlers({ guard: allow, store });
    await handlers.read(request(window), context);
    await handlers.read(request({ ...window, kinds: 'alert' }), context);
    for (const write of ['createDoc', 'replaceDocIfMatch', 'upsertDoc', 'patchDoc', 'deleteDoc']) {
      expect(store[write], write).not.toHaveBeenCalled();
    }
    expect(publish.processPublishContent).not.toHaveBeenCalled();
  });
});

describe('the publisher never sees an alert', () => {
  it('queries only the content container for what is due, and publishes and schedules nothing for an alert due now', async () => {
    const queried = [];
    const store = {
      // Hand the alerts document to ANY read of admin_config, as the worst case.
      readDoc: vi.fn(async (container) => (container === 'admin_config' ? docOf([row({ dueDate: '2026-10-26' })]) : null)),
      queryDocs: vi.fn(async (container) => {
        queried.push(container);
        return container === 'admin_config' ? [docOf([row({ dueDate: '2026-10-26' })])] : [];
      }),
      patchDoc: vi.fn(async () => ({})),
      upsertDoc: vi.fn(async () => ({})),
      createDoc: vi.fn(async (_container, doc) => doc),
      replaceDocIfMatch: vi.fn(async (_container, doc) => doc),
    };
    const publish = { processPublishContent: vi.fn() };
    const summary = await createScheduledPublisher({ store, publish, now: () => NOW }).runScheduledPublish({
      log: vi.fn(),
      error: vi.fn(),
    });

    expect(queried).toEqual(['content']);
    expect(summary).toMatchObject({ due: 0, published: 0 });
    expect(publish.processPublishContent).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    // The only write is the run's own record on the day's digest.
    for (const [container] of [...store.createDoc.mock.calls, ...store.replaceDocIfMatch.mock.calls]) {
      expect(container).toBe('workflow_digests');
    }
  });
});
