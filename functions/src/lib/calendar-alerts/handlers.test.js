/**
 * The Calendar Alerts routes: who may call them, what they refuse, what they
 * change, the starting alert, and what never reaches a log or an audit row.
 *
 * The store is an in-memory stand-in with Cosmos's conditional-write rules
 * (create is a 409 when the document exists; a replace is a 412 when the ETag
 * is not the stored one), so the retry loop is exercised, not assumed.
 */
import { describe, expect, it, vi } from 'vitest';

import { CALENDAR_ALERTS_DOC_ID } from './model.js';
import { createCalendarAlertHandlers, AUDIT_ACTIONS, CALENDAR_ALERTS_ROLE } from './handlers.js';
import { WRITE_ATTEMPTS } from './store.js';

const NOW = new Date('2026-10-26T09:00:00.000Z');
const SEED_ID = 'docker-dsos-application';
const SECRET_TITLE = 'PRIVATE-TITLE-7f3a';
const SECRET_NOTE = 'PRIVATE-NOTE-91bc';
const SECRET_LINK = 'https://example.com/PRIVATE-LINK-44de';

/** An in-memory `admin_config` with Cosmos's conditional writes. */
function memoryStore({ failWrites = false, beforeReplace } = {}) {
  const docs = new Map();
  const audits = [];
  let version = 0;
  const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  const conflict = (code) => Object.assign(new Error(`HTTP ${code}`), { code });
  const store = {
    docs,
    audits,
    readDoc: vi.fn(async (container, id, partitionKey) => {
      expect(container).toBe('admin_config');
      expect(partitionKey).toBe('admin_config');
      return clone(docs.get(id)) ?? null;
    }),
    createDoc: vi.fn(async (container, doc) => {
      if (failWrites) throw Object.assign(new Error('store down'), { code: 503 });
      if (docs.has(doc.id)) throw conflict(409);
      version += 1;
      docs.set(doc.id, { ...clone(doc), _etag: `"${version}"` });
      return clone(docs.get(doc.id));
    }),
    replaceDocIfMatch: vi.fn(async (container, doc, options) => {
      expect(options).toEqual({ partitionKey: 'admin_config' });
      if (failWrites) throw Object.assign(new Error('store down'), { code: 503 });
      beforeReplace?.(store);
      const stored = docs.get(doc.id);
      if (!stored) throw conflict(404);
      if (stored._etag !== doc._etag) throw conflict(412);
      version += 1;
      docs.set(doc.id, { ...clone(doc), _etag: `"${version}"` });
      return clone(docs.get(doc.id));
    }),
    upsertDoc: vi.fn(async (container, doc) => {
      expect(container).toBe('admin_audit_logs');
      audits.push(doc);
    }),
  };
  return store;
}

const USER = { oid: 'oid-owner', name: 'The Owner', email: 'owner@example.com' };
const allow = () => ({ requireRole: vi.fn(async () => ({ user: USER, role: 'editor' })) });
const deny = (status) => ({
  requireRole: vi.fn(async () => ({
    error: { status, headers: {}, body: JSON.stringify({ ok: false, error: 'no' }) },
  })),
});

const makeContext = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), invocationId: 'inv-1' });
const makeRequest = ({ body, params = {} } = {}) => ({
  method: 'GET',
  params,
  query: new Map(),
  headers: { get: () => null },
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

function setup({ guard = allow(), store = memoryStore(), clock = NOW } = {}) {
  let n = 0;
  const handlers = createCalendarAlertHandlers({
    guard,
    store,
    now: () => clock,
    uuid: () => `id-${(n += 1)}`,
  });
  return { handlers, store, guard, context: makeContext() };
}

const parse = (response) => JSON.parse(response.body);
const stored = (store) => store.docs.get(CALENDAR_ALERTS_DOC_ID);
const loggedText = (context) =>
  [context.log, context.warn, context.error].flatMap((fn) => fn.mock.calls.flat()).join('\n');

describe('who may call the routes', () => {
  const calls = (handlers, context) => [
    () => handlers.list(makeRequest(), context),
    () => handlers.create(makeRequest({ body: { title: 'T', dueDate: '2026-11-01' } }), context),
    () => handlers.update(makeRequest({ body: { done: true }, params: { alertId: 'a1' } }), context),
    () => handlers.remove(makeRequest({ params: { alertId: 'a1' } }), context),
  ];

  it.each([401, 403])('answers %i from the guard before touching the store', async (status) => {
    const { handlers, store, guard, context } = setup({ guard: deny(status) });
    for (const call of calls(handlers, context)) {
      const response = await call();
      expect(response.status).toBe(status);
    }
    expect(guard.requireRole).toHaveBeenCalledTimes(4);
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('asks for the editor role on every route', async () => {
    const { handlers, guard, context } = setup();
    for (const call of calls(handlers, context)) await call();
    expect(CALENDAR_ALERTS_ROLE).toBe('editor');
    for (const [, role] of guard.requireRole.mock.calls) expect(role).toBe('editor');
  });
});

describe('GET: the list and the starting alert', () => {
  it('makes the Docker application alert on the first read and lists it', async () => {
    const { handlers, store, context } = setup();
    const response = await handlers.list(makeRequest(), context);
    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('private, no-store');
    const body = parse(response);
    expect(body).toMatchObject({ ok: true, today: '2026-10-26', total: 1 });
    expect(body.alerts[0]).toMatchObject({
      id: SEED_ID,
      title: 'Submit the Docker-Sponsored Open Source application',
      dueDate: '2026-10-30',
      dueTime: null,
      link: 'https://www.docker.com/community/open-source/application/',
      note: 'Text is ready to paste in the Doc Vault note: Docker DSOS application',
      status: 'open',
      state: 'open',
      daysUntilDue: 4,
    });
    expect(store.createDoc).toHaveBeenCalledTimes(1);
    expect(stored(store)).toMatchObject({
      id: CALENDAR_ALERTS_DOC_ID,
      configScope: 'admin_config',
      docType: 'calendar_alerts',
      seeded: [SEED_ID],
    });
  });

  it('changes nothing on a second read', async () => {
    const { handlers, store, context } = setup();
    await handlers.list(makeRequest(), context);
    const before = JSON.stringify(stored(store));
    const second = parse(await handlers.list(makeRequest(), context));
    expect(second.total).toBe(1);
    expect(store.createDoc).toHaveBeenCalledTimes(1);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(JSON.stringify(stored(store))).toBe(before);
  });

  it('makes one alert when two tabs read at the same moment', async () => {
    const { handlers, store, context } = setup();
    const [a, b] = await Promise.all([
      handlers.list(makeRequest(), context),
      handlers.list(makeRequest(), context),
    ]);
    expect(parse(a).total).toBe(1);
    expect(parse(b).total).toBe(1);
    expect(stored(store).alerts).toHaveLength(1);
  });

  it('does not make the alert again after the owner deleted it', async () => {
    const { handlers, store, context } = setup();
    await handlers.list(makeRequest(), context);
    const removed = await handlers.remove(makeRequest({ params: { alertId: SEED_ID } }), context);
    expect(removed.status).toBe(200);
    expect(stored(store)).toMatchObject({ alerts: [], seeded: [SEED_ID] });

    const again = parse(await handlers.list(makeRequest(), context));
    expect(again.alerts).toEqual([]);
    expect(stored(store).alerts).toEqual([]);
    expect(stored(store).seeded).toEqual([SEED_ID]);
  });

  it('does not make the alert again after it is deleted from a document that never recorded it', async () => {
    const store = memoryStore();
    store.docs.set(CALENDAR_ALERTS_DOC_ID, {
      id: CALENDAR_ALERTS_DOC_ID,
      alerts: [{ id: SEED_ID, title: 'Mine', dueDate: '2026-11-15', status: 'open' }],
      seeded: [],
      _etag: '"0"',
    });
    const { handlers, context } = setup({ store });
    const removed = await handlers.remove(makeRequest({ params: { alertId: SEED_ID } }), context);
    expect(removed.status).toBe(200);
    expect(stored(store)).toMatchObject({ alerts: [], seeded: [SEED_ID] });
    expect(parse(await handlers.list(makeRequest(), context)).alerts).toEqual([]);
  });

  it('does not bring the alert back, or change it, after the owner marked it done', async () => {
    const { handlers, store, context } = setup();
    await handlers.list(makeRequest(), context);
    await handlers.update(makeRequest({ params: { alertId: SEED_ID }, body: { done: true } }), context);
    const again = parse(await handlers.list(makeRequest(), context));
    expect(again.alerts).toHaveLength(1);
    expect(again.alerts[0]).toMatchObject({ id: SEED_ID, status: 'done', state: 'done' });
    expect(stored(store).alerts).toHaveLength(1);
  });

  it('does not make a second one when the owner typed the same id first', async () => {
    const store = memoryStore();
    store.docs.set(CALENDAR_ALERTS_DOC_ID, {
      id: CALENDAR_ALERTS_DOC_ID,
      alerts: [
        {
          id: SEED_ID,
          title: 'Mine',
          dueDate: '2026-11-15',
          status: 'open',
        },
      ],
      seeded: [],
      _etag: '"0"',
    });
    const { handlers, context } = setup({ store });
    const body = parse(await handlers.list(makeRequest(), context));
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].title).toBe('Mine');
    expect(stored(store).seeded).toEqual([SEED_ID]);
  });

  it('still answers the list, and logs only a code, when the starting alert cannot be written', async () => {
    const { handlers, context } = setup({ store: memoryStore({ failWrites: true }) });
    const response = await handlers.list(makeRequest(), context);
    expect(response.status).toBe(200);
    expect(parse(response)).toMatchObject({ ok: true, alerts: [], total: 0 });
    const logged = loggedText(context);
    expect(logged).toMatch(/starting alerts failed/);
    expect(logged).not.toMatch(/store down/);
  });

  it('answers 500 with a fixed sentence when the document cannot be read', async () => {
    const store = memoryStore();
    store.readDoc.mockRejectedValue(new Error('connection string leaked: AccountKey=abc'));
    const { handlers, context } = setup({ store });
    const response = await handlers.list(makeRequest(), context);
    expect(response.status).toBe(500);
    expect(parse(response)).toMatchObject({ ok: false, error: 'Failed to read the calendar alerts' });
    expect(response.body).not.toMatch(/AccountKey/);
    expect(loggedText(context)).not.toMatch(/AccountKey/);
  });

  it('sends on only what a typed alert could have held, whatever a hand-edited row says', async () => {
    const store = memoryStore();
    store.docs.set(CALENDAR_ALERTS_DOC_ID, {
      id: CALENDAR_ALERTS_DOC_ID,
      seeded: [SEED_ID],
      alerts: [
        {
          id: 'edited',
          title: 'Line' + String.fromCharCode(0x2028) + 'break',
          dueDate: '2026-10-28',
          dueTime: 'zz',
          link: 'https://x.example/a' + String.fromCharCode(13, 10) + 'ATTACH:http://evil.example',
          note: 'note' + String.fromCharCode(0x85) + 'end',
          status: 'snoozed',
          snoozedUntil: 'someday',
        },
      ],
      _etag: '"0"',
    });
    const { handlers, context } = setup({ store });
    const [row] = parse(await handlers.list(makeRequest(), context)).alerts;
    expect(row).toMatchObject({
      title: 'Line break',
      dueTime: null,
      link: '',
      note: 'note end',
      snoozedUntil: null,
      state: 'open',
    });
  });

  it('lists soonest first and leaves out a stored row it cannot read', async () => {
    const store = memoryStore();
    store.docs.set(CALENDAR_ALERTS_DOC_ID, {
      id: CALENDAR_ALERTS_DOC_ID,
      seeded: [SEED_ID],
      alerts: [
        { id: 'late', title: 'Late', dueDate: '2026-12-01', status: 'open' },
        { id: 'broken', title: '', dueDate: 'soon', status: 'open' },
        { id: 'early', title: 'Early', dueDate: '2026-10-27', status: 'open', _rid: 'internal' },
      ],
      _etag: '"0"',
    });
    const { handlers, context } = setup({ store });
    const body = parse(await handlers.list(makeRequest(), context));
    expect(body.alerts.map((row) => row.id)).toEqual(['early', 'late']);
    expect(JSON.stringify(body)).not.toMatch(/internal|_rid|_etag/);
  });

  it('reports a snoozed alert as snoozed until its day, then as open', async () => {
    const mk = (snoozedUntil) => ({
      id: 'sn',
      title: 'Snoozed',
      dueDate: '2026-10-27',
      status: 'snoozed',
      snoozedUntil,
    });
    for (const [snoozedUntil, state] of [
      ['2026-10-27', 'snoozed'],
      ['2026-10-26', 'open'],
    ]) {
      const store = memoryStore();
      store.docs.set(CALENDAR_ALERTS_DOC_ID, {
        id: CALENDAR_ALERTS_DOC_ID,
        seeded: [SEED_ID],
        alerts: [mk(snoozedUntil)],
        _etag: '"0"',
      });
      const { handlers, context } = setup({ store });
      const body = parse(await handlers.list(makeRequest(), context));
      expect(body.alerts[0]).toMatchObject({ state, status: 'snoozed' });
    }
  });
});

describe('POST: add an alert', () => {
  it('creates it open, with a new id, and answers 201', async () => {
    const { handlers, store, context } = setup();
    const response = await handlers.create(
      makeRequest({
        body: { title: SECRET_TITLE, dueDate: '2026-11-03', dueTime: '08:15', link: SECRET_LINK, note: SECRET_NOTE },
      }),
      context
    );
    expect(response.status).toBe(201);
    expect(response.headers['Cache-Control']).toBe('private, no-store');
    const { alert } = parse(response);
    expect(alert).toMatchObject({
      id: 'id-1',
      title: SECRET_TITLE,
      dueDate: '2026-11-03',
      dueTime: '08:15',
      link: SECRET_LINK,
      note: SECRET_NOTE,
      status: 'open',
      state: 'open',
      daysUntilDue: 8,
      createdAt: NOW.toISOString(),
    });
    expect(stored(store).alerts.map((row) => row.id)).toEqual(['id-1']);
  });

  it.each([
    ['no body at all', undefined],
    ['null', null],
    ['an array', []],
    ['no title', { dueDate: '2026-11-03' }],
    ['no date', { title: 'T' }],
    ['a bad date', { title: 'T', dueDate: '2026-02-30' }],
    ['a bad time', { title: 'T', dueDate: '2026-11-03', dueTime: '25:00' }],
    ['an http link', { title: 'T', dueDate: '2026-11-03', link: 'http://example.com' }],
    ['a javascript link', { title: 'T', dueDate: '2026-11-03', link: 'javascript:alert(1)' }],
    ['a key it does not know', { title: 'T', dueDate: '2026-11-03', status: 'done' }],
    ['a long note', { title: 'T', dueDate: '2026-11-03', note: 'x'.repeat(501) }],
  ])('refuses %s with a 400 and writes nothing', async (_name, body) => {
    const { handlers, store, context } = setup();
    const response = await handlers.create(makeRequest({ body }), context);
    expect(response.status).toBe(400);
    expect(parse(response)).toMatchObject({ ok: false });
    expect(typeof parse(response).error).toBe('string');
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('refuses a 301st alert, naming what to do', async () => {
    const store = memoryStore();
    store.docs.set(CALENDAR_ALERTS_DOC_ID, {
      id: CALENDAR_ALERTS_DOC_ID,
      seeded: [SEED_ID],
      alerts: Array.from({ length: 300 }, (_, i) => ({
        id: `a${i}`,
        title: `T${i}`,
        dueDate: '2026-12-01',
        status: 'done',
      })),
      _etag: '"0"',
    });
    const { handlers, context } = setup({ store });
    const response = await handlers.create(
      makeRequest({ body: { title: 'One more', dueDate: '2026-12-02' } }),
      context
    );
    expect(response.status).toBe(400);
    expect(parse(response).error).toMatch(/Delete some finished ones/);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });
});

describe('POST: size limits', () => {
  const heavyDoc = (status) => ({
    id: CALENDAR_ALERTS_DOC_ID,
    seeded: [SEED_ID],
    alerts: Array.from({ length: 200 }, (_, i) => ({
      id: 'h' + i,
      title: 'Heavy',
      dueDate: '2026-12-01',
      status,
      note: 'e'.repeat(6000),
    })),
    _etag: '"0"',
  });

  it('refuses a body past 10 000 characters as too large (413), before reading its fields', async () => {
    const { handlers, store, context } = setup();
    const response = await handlers.create(
      makeRequest({ body: { title: 'T', dueDate: '2026-11-03', note: 'x'.repeat(20_000) } }),
      context
    );
    expect(response.status).toBe(413);
    expect(parse(response).error).toMatch(/too large/);
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it('refuses a declared Content-Length past 40 000 bytes without parsing the body', async () => {
    const { handlers, store, context } = setup();
    const json = vi.fn(async () => ({ title: 'T', dueDate: '2026-11-03' }));
    const response = await handlers.create(
      {
        params: {},
        query: new Map(),
        headers: { get: (name) => (name === 'content-length' ? '41000' : null) },
        json,
      },
      context
    );
    expect(response.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it('refuses a new alert when the stored list is too heavy, and says what to do', async () => {
    const store = memoryStore();
    store.docs.set(CALENDAR_ALERTS_DOC_ID, heavyDoc('done'));
    const { handlers, context } = setup({ store });
    const response = await handlers.create(
      makeRequest({ body: { title: 'One more', dueDate: '2026-12-02' } }),
      context
    );
    expect(response.status).toBe(400);
    expect(parse(response).error).toMatch(/too large to save any more/);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('still lets a heavy list be marked done or shrink, but not grow by an edit', async () => {
    const store = memoryStore();
    store.docs.set(CALENDAR_ALERTS_DOC_ID, heavyDoc('open'));
    const { handlers, context } = setup({ store });
    const edit = await handlers.update(
      makeRequest({ params: { alertId: 'h1' }, body: { note: 'a longer note' } }),
      context
    );
    expect(edit.status).toBe(400);
    const done = await handlers.update(
      makeRequest({ params: { alertId: 'h1' }, body: { done: true } }),
      context
    );
    expect(done.status).toBe(200);
    const removed = await handlers.remove(makeRequest({ params: { alertId: 'h2' } }), context);
    expect(removed.status).toBe(200);
  });
});

describe('PATCH: edit, done, snooze', () => {
  async function withAlert() {
    const ctx = setup();
    const created = await ctx.handlers.create(
      makeRequest({ body: { title: SECRET_TITLE, dueDate: '2026-10-28', note: SECRET_NOTE } }),
      ctx.context
    );
    return { ...ctx, id: parse(created).alert.id };
  }
  const patch = (ctx, body, id = ctx.id) =>
    ctx.handlers.update(makeRequest({ body, params: { alertId: id } }), ctx.context);

  it('marks done and reopens', async () => {
    const ctx = await withAlert();
    const done = parse(await patch(ctx, { done: true })).alert;
    expect(done).toMatchObject({ status: 'done', state: 'done', doneAt: NOW.toISOString() });
    const reopened = parse(await patch(ctx, { done: false })).alert;
    expect(reopened).toMatchObject({ status: 'open', state: 'open', doneAt: null });
  });

  it.each([
    [1, '2026-10-27'],
    [3, '2026-10-29'],
    [7, '2026-11-02'],
  ])('snoozes %i day(s) until %s', async (days, until) => {
    const ctx = await withAlert();
    const { alert } = parse(await patch(ctx, { snoozeDays: days }));
    expect(alert).toMatchObject({ status: 'snoozed', state: 'snoozed', snoozedUntil: until });
    expect(stored(ctx.store).alerts.find((row) => row.id === ctx.id).snoozedUntil).toBe(until);
  });

  it('edits the words and the day', async () => {
    const ctx = await withAlert();
    const { alert } = parse(
      await patch(ctx, { title: 'Renamed', dueDate: '2026-11-09', dueTime: '10:00', link: '/admin/calendar', note: '' })
    );
    expect(alert).toMatchObject({
      title: 'Renamed',
      dueDate: '2026-11-09',
      dueTime: '10:00',
      link: '/admin/calendar',
      note: '',
    });
  });

  it('answers 404 for an alert that is not there, and 404 for an id that cannot be one', async () => {
    const ctx = await withAlert();
    expect((await patch(ctx, { done: true }, 'missing')).status).toBe(404);
    expect((await patch(ctx, { done: true }, '../x')).status).toBe(404);
    const noId = await ctx.handlers.update(makeRequest({ body: { done: true } }), ctx.context);
    expect(noId.status).toBe(404);
  });

  it.each([
    ['an empty body', {}],
    ['a key it does not know', { status: 'done' }],
    ['done and a snooze together', { done: true, snoozeDays: 3 }],
    ['a snooze of 31 days', { snoozeDays: 31 }],
    ['a blank title', { title: ' ' }],
  ])('refuses %s with a 400', async (_name, body) => {
    const ctx = await withAlert();
    const before = JSON.stringify(stored(ctx.store));
    const response = await patch(ctx, body);
    expect(response.status).toBe(400);
    expect(JSON.stringify(stored(ctx.store))).toBe(before);
  });

  it('refuses to snooze a finished alert', async () => {
    const ctx = await withAlert();
    await patch(ctx, { done: true });
    const response = await patch(ctx, { snoozeDays: 3 });
    expect(response.status).toBe(400);
    expect(parse(response).error).toMatch(/reopen/);
  });

  it('keeps two tabs\' changes to different alerts, by reading again after a lost race', async () => {
    const ctx = setup();
    const a = parse(await ctx.handlers.create(makeRequest({ body: { title: 'A', dueDate: '2026-11-01' } }), ctx.context)).alert;
    const b = parse(await ctx.handlers.create(makeRequest({ body: { title: 'B', dueDate: '2026-11-02' } }), ctx.context)).alert;

    let raced = false;
    ctx.store.replaceDocIfMatch.mockImplementationOnce(async (container, doc, options) => {
      // The other tab's snooze of B lands between this request's read and its write.
      raced = true;
      const current = ctx.store.docs.get(CALENDAR_ALERTS_DOC_ID);
      ctx.store.docs.set(CALENDAR_ALERTS_DOC_ID, {
        ...current,
        alerts: current.alerts.map((row) =>
          row.id === b.id ? { ...row, status: 'snoozed', snoozedUntil: '2026-10-29' } : row
        ),
        _etag: '"other-tab"',
      });
      const error = new Error('precondition');
      error.code = 412;
      throw error;
    });
    const response = await patch(ctx, { done: true }, a.id);
    expect(response.status).toBe(200);
    expect(raced).toBe(true);
    const rows = stored(ctx.store).alerts;
    expect(rows.find((row) => row.id === a.id).status).toBe('done');
    expect(rows.find((row) => row.id === b.id)).toMatchObject({ status: 'snoozed', snoozedUntil: '2026-10-29' });
  });

  it('gives up with a 409 after every attempt loses the race, having written nothing of its own', async () => {
    const ctx = await withAlert();
    ctx.store.replaceDocIfMatch.mockImplementation(async () => {
      throw Object.assign(new Error('precondition'), { code: 412 });
    });
    const response = await patch(ctx, { done: true });
    expect(response.status).toBe(409);
    expect(parse(response)).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(ctx.store.replaceDocIfMatch).toHaveBeenCalledTimes(WRITE_ATTEMPTS);
    expect(stored(ctx.store).alerts[0].status).toBe('open');
  });
});

describe('DELETE', () => {
  it('removes an alert, answers its id, and then answers 404', async () => {
    const ctx = setup();
    const { alert } = parse(
      await ctx.handlers.create(makeRequest({ body: { title: 'Gone', dueDate: '2026-11-01' } }), ctx.context)
    );
    const first = await ctx.handlers.remove(makeRequest({ params: { alertId: alert.id } }), ctx.context);
    expect(first.status).toBe(200);
    expect(parse(first)).toEqual({ ok: true, id: alert.id });
    expect(stored(ctx.store).alerts).toEqual([]);
    const second = await ctx.handlers.remove(makeRequest({ params: { alertId: alert.id } }), ctx.context);
    expect(second.status).toBe(404);
  });

  it('does not record an ordinary alert as a seed', async () => {
    const ctx = setup();
    const { alert } = parse(
      await ctx.handlers.create(makeRequest({ body: { title: 'Plain', dueDate: '2026-11-01' } }), ctx.context)
    );
    await ctx.handlers.remove(makeRequest({ params: { alertId: alert.id } }), ctx.context);
    expect(stored(ctx.store).seeded).toEqual([]);
  });

  it('answers 404 for an id that cannot be an id', async () => {
    const ctx = setup();
    expect((await ctx.handlers.remove(makeRequest({ params: { alertId: '../etc' } }), ctx.context)).status).toBe(404);
  });
});

describe('what is never logged or audited', () => {
  it('keeps the title, note and link out of every log line and every audit row', async () => {
    const ctx = setup();
    const created = parse(
      await ctx.handlers.create(
        makeRequest({ body: { title: SECRET_TITLE, dueDate: '2026-11-03', link: SECRET_LINK, note: SECRET_NOTE } }),
        ctx.context
      )
    ).alert;
    await ctx.handlers.update(
      makeRequest({ body: { title: `${SECRET_TITLE}-2`, note: SECRET_NOTE, snoozeDays: 1 }, params: { alertId: created.id } }),
      ctx.context
    );
    await ctx.handlers.update(makeRequest({ body: { title: ' ' }, params: { alertId: created.id } }), ctx.context);
    await ctx.handlers.remove(makeRequest({ params: { alertId: created.id } }), ctx.context);

    const audits = JSON.stringify(ctx.store.audits);
    const logs = loggedText(ctx.context);
    for (const secret of [SECRET_TITLE, SECRET_NOTE, 'PRIVATE-LINK']) {
      expect(audits).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  });

  it('records who did what to which alert, and nothing about its words', async () => {
    const ctx = setup();
    const created = parse(
      await ctx.handlers.create(makeRequest({ body: { title: SECRET_TITLE, dueDate: '2026-11-03' } }), ctx.context)
    ).alert;
    await ctx.handlers.update(makeRequest({ body: { done: true }, params: { alertId: created.id } }), ctx.context);
    await ctx.handlers.remove(makeRequest({ params: { alertId: created.id } }), ctx.context);

    expect(ctx.store.audits.map((row) => row.action)).toEqual([
      AUDIT_ACTIONS.created,
      AUDIT_ACTIONS.updated,
      AUDIT_ACTIONS.deleted,
    ]);
    expect(ctx.store.audits[1]).toMatchObject({
      userId: 'oid-owner',
      resource: `admin_config:calendar_alerts:${created.id}`,
      details: { alertId: created.id, status: 'done' },
      before: null,
      after: null,
    });
  });

  it('names the fields a change touched in the audit row, never their values', async () => {
    const ctx = setup();
    const created = parse(
      await ctx.handlers.create(
        makeRequest({ body: { title: SECRET_TITLE, dueDate: '2026-11-03' } }),
        ctx.context
      )
    ).alert;
    await ctx.handlers.update(
      makeRequest({
        params: { alertId: created.id },
        body: { link: SECRET_LINK, note: SECRET_NOTE, snoozeDays: 3 },
      }),
      ctx.context
    );
    await ctx.handlers.update(
      makeRequest({ params: { alertId: created.id }, body: { done: true } }),
      ctx.context
    );
    const [, snoozed, finished] = ctx.store.audits;
    expect(snoozed.details.fields).toEqual(['link', 'note', 'snooze']);
    expect(finished.details.fields).toEqual(['done']);
    expect(JSON.stringify(ctx.store.audits)).not.toContain('PRIVATE');
  });

  it('does not fail a saved change because the audit row could not be written', async () => {
    const ctx = setup();
    ctx.store.upsertDoc.mockRejectedValue(new Error('audit store down'));
    const response = await ctx.handlers.create(
      makeRequest({ body: { title: 'Saved anyway', dueDate: '2026-11-03' } }),
      ctx.context
    );
    expect(response.status).toBe(201);
    expect(stored(ctx.store).alerts).toHaveLength(1);
  });

  it('answers a store failure with a fixed sentence, not the store\'s words', async () => {
    const ctx = setup();
    ctx.store.readDoc.mockRejectedValue(new Error('AccountKey=secret-value'));
    const response = await ctx.handlers.create(
      makeRequest({ body: { title: 'T', dueDate: '2026-11-03' } }),
      ctx.context
    );
    expect(response.status).toBe(500);
    expect(parse(response).error).toBe('Failed to save the calendar alert');
    expect(response.body).not.toContain('secret-value');
    expect(loggedText(ctx.context)).not.toContain('secret-value');
  });
});
