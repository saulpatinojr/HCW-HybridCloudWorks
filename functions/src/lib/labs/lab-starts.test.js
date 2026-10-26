/**
 * The lab-start counter (lab-starts.js): the increment, the day rollover, the
 * windows the admin card reads, the editor-only read, and above all the shape
 * of what is stored. The privacy promise is that the counter keeps plain
 * per-lab per-day numbers and nothing that could identify a person, so the
 * stored documents are held to an exact list of keys: a test below fails the
 * day a field is added to them.
 *
 * The store is the shared in-memory Cosmos (test/memory-store.js), which
 * answers a stale ETag with a 412 and a create over an existing id with a 409,
 * as the real verbs do. No test here asserts an absolute time.
 */
import { describe, expect, it, vi } from 'vitest';

import { memoryStore } from '../../../test/memory-store.js';
import {
  LAB_STARTS_CONTAINER,
  LAB_STARTS_DAY_KEYS,
  LAB_STARTS_DAY_KIND,
  LAB_STARTS_META_ID,
  LAB_STARTS_META_KEYS,
  LAB_STARTS_META_KIND,
  MAX_WRITE_ATTEMPTS,
  addDays,
  applyLabStart,
  createLabStartsReadHandler,
  dayDocId,
  ensureSince,
  isDay,
  isLabId,
  readLabStarts,
  recordLabStart,
  summariseLabStarts,
} from './lab-starts.js';

const LAB_A = 'terraform-validate-walkthrough';
const LAB_B = 'landing-zone-builder-output';
const DAY_1 = '2026-10-26';
const NOON_1 = Date.parse(`${DAY_1}T12:00:00.000Z`);

/** The store answering the card's one query the way Cosmos would: every document of that kind. */
const newStore = (initial = {}) =>
  memoryStore(initial, {
    query: ({ docs, parameters }) => {
      const kind = parameters.find((p) => p.name === '@kind')?.value;
      return docs.filter((doc) => doc.kind === kind);
    },
  });

/** Cosmos adds these to everything it stores; they are not the counter's. */
const withoutSystemFields = (doc) =>
  Object.fromEntries(Object.entries(doc).filter(([key]) => !key.startsWith('_')));

/** Every document the counter has stored, system fields removed. */
const storedDocs = (store) =>
  [...store.docs.entries()]
    .filter(([path]) => path.startsWith(`${LAB_STARTS_CONTAINER}/`))
    .map(([, doc]) => withoutSystemFields(doc));

const dayDocs = (store) => storedDocs(store).filter((doc) => doc.kind === LAB_STARTS_DAY_KIND);

const conflict = (code) => Object.assign(new Error(`HTTP ${code}`), { code });

describe('the lab id and day checks', () => {
  it('accepts a lab slug and refuses anything else', () => {
    expect(isLabId(LAB_A)).toBe(true);
    expect(isLabId('lab-1')).toBe(true);
    for (const bad of [
      '',
      'A',
      'Lab-A',
      '-lab',
      'lab a',
      'lab/a',
      '../etc',
      'lab?user=1',
      'lab@example.com',
      '203.0.113.9',
      'a'.repeat(65),
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isLabId(bad)).toBe(false);
    }
  });

  it('accepts only a real calendar day', () => {
    expect(isDay('2026-10-26')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-10-26T01:00:00Z')).toBe(false);
    expect(isDay('26-10-2026')).toBe(false);
    expect(isDay(null)).toBe(false);
  });

  it('steps days across a month and a year end', () => {
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addDays('2027-01-01', -29)).toBe('2026-12-03');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('applyLabStart', () => {
  it('starts a day at one for the lab', () => {
    expect(applyLabStart(null, { day: DAY_1, labId: LAB_A })).toEqual({
      id: `lab-starts:${DAY_1}`,
      kind: LAB_STARTS_DAY_KIND,
      day: DAY_1,
      total: 1,
      byLab: { [LAB_A]: 1 },
    });
  });

  it('adds one to the lab and keeps total equal to the sum of the labs', () => {
    const first = applyLabStart(null, { day: DAY_1, labId: LAB_A });
    const second = applyLabStart(first, { day: DAY_1, labId: LAB_A });
    const third = applyLabStart(second, { day: DAY_1, labId: LAB_B });
    expect(third.byLab).toEqual({ [LAB_A]: 2, [LAB_B]: 1 });
    expect(third.total).toBe(3);
  });

  it('does not change the document it was given', () => {
    const existing = Object.freeze({
      ...applyLabStart(null, { day: DAY_1, labId: LAB_A }),
      byLab: Object.freeze({ [LAB_A]: 1 }),
    });
    expect(() => applyLabStart(existing, { day: DAY_1, labId: LAB_A })).not.toThrow();
    expect(existing.byLab[LAB_A]).toBe(1);
  });

  it('rebuilds from the allow-list: a field that got in is dropped, not carried', () => {
    const dirty = {
      id: `lab-starts:${DAY_1}`,
      kind: LAB_STARTS_DAY_KIND,
      day: DAY_1,
      total: 99,
      byLab: {
        [LAB_A]: 2,
        'Not A Lab': 5,
        '203.0.113.9': 1,
        [LAB_B]: -3,
        'lab-fraction': 1.5,
        'lab-text': '4',
      },
      clientHash: 'abc123',
      ip: '203.0.113.9',
      sessionId: 'sess-1',
      userAgent: 'Mozilla/5.0',
      _etag: '"e1"',
      _rid: 'rid',
      _ts: 1,
    };
    const next = applyLabStart(dirty, { day: DAY_1, labId: LAB_A });
    expect(next).toEqual({
      id: `lab-starts:${DAY_1}`,
      kind: LAB_STARTS_DAY_KIND,
      day: DAY_1,
      total: 3,
      byLab: { [LAB_A]: 3 },
      _etag: '"e1"',
    });
  });

  it('counts a lab id that is also a name on every object as a plain integer', () => {
    // `constructor` is a valid slug and an inherited property of {}: read as an
    // own count it must be 0, never the function (which made "0function...1").
    const first = applyLabStart(null, { day: DAY_1, labId: 'constructor' });
    expect(first.byLab).toEqual({ constructor: 1 });
    expect(first.total).toBe(1);
    const second = applyLabStart(first, { day: DAY_1, labId: 'constructor' });
    expect(second.byLab.constructor).toBe(2);
    expect(second.total).toBe(2);
    const summary = summariseLabStarts([second], { since: DAY_1, today: DAY_1 });
    expect(summary.perLab).toEqual([
      { labId: 'constructor', today: 2, last7: 2, last30: 2, total: 2 },
    ]);
    // A lab that was never counted reads as 0 in the windows, not as inherited.
    const other = summariseLabStarts([applyLabStart(null, { day: DAY_1, labId: LAB_A })], {
      since: DAY_1,
      today: DAY_1,
    });
    expect(other.perLab.map((row) => row.total)).toEqual([1]);
  });

  it('refuses a bad day or lab id rather than writing it', () => {
    expect(() => applyLabStart(null, { day: 'today', labId: LAB_A })).toThrow();
    expect(() => applyLabStart(null, { day: DAY_1, labId: 'a b' })).toThrow();
  });

  it('never reads another kind of document as a day', () => {
    const marker = { id: LAB_STARTS_META_ID, kind: LAB_STARTS_META_KIND, since: DAY_1, byLab: { [LAB_B]: 9 } };
    expect(applyLabStart(marker, { day: DAY_1, labId: LAB_A }).byLab).toEqual({ [LAB_A]: 1 });
  });
});

describe('recordLabStart', () => {
  it('counts a start: one day document and the marker, nothing else', async () => {
    const store = newStore();
    const result = await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 });
    expect(result).toEqual({ counted: true, day: DAY_1 });
    expect(dayDocs(store)).toEqual([
      { id: `lab-starts:${DAY_1}`, kind: LAB_STARTS_DAY_KIND, day: DAY_1, total: 1, byLab: { [LAB_A]: 1 } },
    ]);
    expect(storedDocs(store)).toContainEqual({
      id: LAB_STARTS_META_ID,
      kind: LAB_STARTS_META_KIND,
      since: DAY_1,
    });
    expect(storedDocs(store)).toHaveLength(2);
  });

  it('adds to the same day and the same lab, and keeps labs apart', async () => {
    const store = newStore();
    await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 });
    await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 + 60_000 });
    await recordLabStart(store, { labId: LAB_B, nowMs: NOON_1 + 120_000 });
    const [day] = dayDocs(store);
    expect(day.byLab).toEqual({ [LAB_A]: 2, [LAB_B]: 1 });
    expect(day.total).toBe(3);
    expect(dayDocs(store)).toHaveLength(1);
  });

  it('rolls over at UTC midnight: the last millisecond of a day and the first of the next', async () => {
    const store = newStore();
    const lastMs = Date.parse('2026-10-26T23:59:59.999Z');
    await recordLabStart(store, { labId: LAB_A, nowMs: lastMs });
    await recordLabStart(store, { labId: LAB_A, nowMs: lastMs + 1 });
    const days = dayDocs(store).sort((a, b) => a.day.localeCompare(b.day));
    expect(days.map((d) => [d.day, d.total])).toEqual([
      ['2026-10-26', 1],
      ['2026-10-27', 1],
    ]);
  });

  it('keeps the marker on the first day when later days are counted', async () => {
    const store = newStore();
    await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 });
    await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 + 3 * 86_400_000 });
    expect(store.get(LAB_STARTS_CONTAINER, LAB_STARTS_META_ID).since).toBe(DAY_1);
  });

  it('writes nothing for a lab id outside the allow-list', async () => {
    const store = newStore();
    for (const bad of ['', 'Lab A', '203.0.113.9', 'lab?user=a@b.c', 'x'.repeat(65), null, undefined]) {
      expect(await recordLabStart(store, { labId: bad, nowMs: NOON_1 })).toEqual({
        counted: false,
        reason: 'invalid-lab-id',
      });
    }
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(storedDocs(store)).toEqual([]);
  });

  it('loses no count when starts overlap: each retries on the new ETag', async () => {
    const store = newStore();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 }))
    );
    expect(results.every((r) => r.counted)).toBe(true);
    expect(dayDocs(store)[0].total).toBe(4);
  });

  it('retries after another instance created the day first (409)', async () => {
    const store = newStore();
    store.fail(LAB_STARTS_CONTAINER, dayDocId(DAY_1), 'createDoc', conflict(409));
    const result = await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 });
    expect(result.counted).toBe(true);
    expect(dayDocs(store)[0].total).toBe(1);
  });

  it('gives up with "contention" after the attempt limit, writing nothing wrong', async () => {
    const store = newStore();
    await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 });
    store.fail(LAB_STARTS_CONTAINER, dayDocId(DAY_1), 'replaceDocIfMatch', conflict(412), MAX_WRITE_ATTEMPTS);
    const result = await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 });
    expect(result).toEqual({ counted: false, reason: 'contention', day: DAY_1 });
    expect(dayDocs(store)[0].total).toBe(1);
  });

  it('throws a store fault so the caller can log it, and does not swallow it as a conflict', async () => {
    const store = newStore();
    store.fail(LAB_STARTS_CONTAINER, dayDocId(DAY_1), 'createDoc', conflict(503));
    await expect(recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 })).rejects.toMatchObject({
      code: 503,
    });
  });
});

describe('what is stored: no personal field, ever', () => {
  const FORBIDDEN = [
    'ip',
    'ipAddress',
    'clientHash',
    'clientIp',
    'userId',
    'user',
    'oid',
    'email',
    'sessionId',
    'sessionid',
    'token',
    'turnstileToken',
    'query',
    'userAgent',
    'accessUrl',
    'coderUsername',
    'workspaceId',
    'createdAt',
    'updatedAt',
    'ttl',
  ];

  it('holds every stored document to the exact list of keys', async () => {
    const store = newStore();
    // Several labs, several days, repeated starts: whatever the history, the
    // keys are the same. Adding a field to a stored document fails here.
    for (let day = 0; day < 3; day += 1) {
      for (const labId of [LAB_A, LAB_B, LAB_A]) {
        await recordLabStart(store, { labId, nowMs: NOON_1 + day * 86_400_000 });
      }
    }
    const docs = storedDocs(store);
    expect(docs).toHaveLength(4);
    for (const doc of docs) {
      const allowed = doc.kind === LAB_STARTS_DAY_KIND ? LAB_STARTS_DAY_KEYS : LAB_STARTS_META_KEYS;
      expect(Object.keys(doc).sort()).toEqual([...allowed].sort());
    }
    for (const doc of dayDocs(store)) {
      expect(Object.keys(doc.byLab).every(isLabId)).toBe(true);
      expect(Object.values(doc.byLab).every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    }
  });

  it('exports the same key lists the stored documents are checked against', () => {
    expect([...LAB_STARTS_DAY_KEYS].sort()).toEqual(['byLab', 'day', 'id', 'kind', 'total']);
    expect([...LAB_STARTS_META_KEYS].sort()).toEqual(['id', 'kind', 'since']);
  });

  it('holds no forbidden field name and no time of day anywhere in what it stores', async () => {
    const store = newStore();
    await recordLabStart(store, { labId: LAB_A, nowMs: Date.parse('2026-10-26T13:45:12.345Z') });
    const text = JSON.stringify(storedDocs(store));
    for (const name of FORBIDDEN) {
      expect(text.toLowerCase()).not.toContain(`"${name.toLowerCase()}"`);
    }
    expect(text).not.toMatch(/\d{2}:\d{2}/);
    expect(text).not.toContain('13:45');
  });

  it('writes the documents it is handed through the allow-list even when the store held a polluted one', async () => {
    const store = newStore({
      [`${LAB_STARTS_CONTAINER}/${dayDocId(DAY_1)}`]: {
        id: dayDocId(DAY_1),
        kind: LAB_STARTS_DAY_KIND,
        day: DAY_1,
        total: 1,
        byLab: { [LAB_A]: 1 },
        clientHash: 'abc',
        ip: '203.0.113.9',
      },
    });
    await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 });
    expect(Object.keys(dayDocs(store)[0]).sort()).toEqual([...LAB_STARTS_DAY_KEYS].sort());
  });
});

describe('ensureSince', () => {
  it('creates the marker once and never moves it', async () => {
    const store = newStore();
    expect(await ensureSince(store, { day: DAY_1 })).toBe(DAY_1);
    expect(await ensureSince(store, { day: '2026-12-01' })).toBe(DAY_1);
    expect(store.createDoc).toHaveBeenCalledTimes(1);
  });

  it('reads the winner when two instances create it at once', async () => {
    const store = newStore();
    store.fail(LAB_STARTS_CONTAINER, LAB_STARTS_META_ID, 'createDoc', conflict(409));
    // The loser's create fails with 409; the winner's document appears.
    store.docs.set(`${LAB_STARTS_CONTAINER}/${LAB_STARTS_META_ID}`, {
      id: LAB_STARTS_META_ID,
      kind: LAB_STARTS_META_KIND,
      since: '2026-10-25',
      _etag: '"w"',
    });
    // readDoc finds it first in this arrangement, so force the create path:
    store.readDoc.mockResolvedValueOnce(null);
    expect(await ensureSince(store, { day: DAY_1 })).toBe('2026-10-25');
  });

  it('falls back to the caller’s day when the marker’s since is not a day', async () => {
    const store = newStore({
      [`${LAB_STARTS_CONTAINER}/${LAB_STARTS_META_ID}`]: {
        id: LAB_STARTS_META_ID,
        kind: LAB_STARTS_META_KIND,
        since: 'soon',
      },
    });
    // create hits 409 (it exists), the re-read is still not a day: fall back to the caller's day.
    expect(await ensureSince(store, { day: DAY_1 })).toBe(DAY_1);
  });
});

describe('summariseLabStarts: the windows', () => {
  const TODAY = '2026-11-30';
  const dayDoc = (day, byLab) => ({ kind: LAB_STARTS_DAY_KIND, day, byLab });

  it('counts today, the last 7 days (today and six before) and the last 30 (today and 29 before)', () => {
    const docs = [
      dayDoc('2026-11-30', { [LAB_A]: 1 }), // today
      dayDoc('2026-11-24', { [LAB_A]: 2 }), // six days back: in last7
      dayDoc('2026-11-23', { [LAB_A]: 4 }), // seven days back: out of last7, in last30
      dayDoc('2026-11-01', { [LAB_A]: 8 }), // 29 days back: in last30
      dayDoc('2026-10-31', { [LAB_A]: 16 }), // 30 days back: only in total
    ];
    const summary = summariseLabStarts(docs, { since: '2026-10-26', today: TODAY });
    expect(summary.counts).toEqual({ today: 1, last7: 3, last30: 15, total: 31 });
    expect(summary.perLab).toEqual([{ labId: LAB_A, today: 1, last7: 3, last30: 15, total: 31 }]);
    expect(summary.since).toBe('2026-10-26');
    expect(summary.today).toBe(TODAY);
  });

  it('ignores a day in the future of the window rather than counting it as today', () => {
    const summary = summariseLabStarts([dayDoc('2026-12-02', { [LAB_A]: 5 })], {
      since: '2026-10-26',
      today: TODAY,
    });
    expect(summary.counts).toEqual({ today: 0, last7: 0, last30: 0, total: 5 });
  });

  it('breaks the figures down per lab, most started first, ties by id', () => {
    const docs = [
      dayDoc('2026-11-30', { [LAB_A]: 1, [LAB_B]: 3, 'ansible-syntax-check-walkthrough': 3 }),
      dayDoc('2026-11-29', { [LAB_B]: 1 }),
    ];
    const { perLab } = summariseLabStarts(docs, { since: '2026-10-26', today: TODAY });
    expect(perLab.map((row) => [row.labId, row.total])).toEqual([
      [LAB_B, 4],
      ['ansible-syntax-check-walkthrough', 3],
      [LAB_A, 1],
    ]);
    expect(perLab[0]).toEqual({ labId: LAB_B, today: 3, last7: 4, last30: 4, total: 4 });
  });

  it('is all zeros with no lab rows before any start', () => {
    expect(summariseLabStarts([], { since: TODAY, today: TODAY })).toEqual({
      since: TODAY,
      today: TODAY,
      counts: { today: 0, last7: 0, last30: 0, total: 0 },
      perLab: [],
    });
  });

  it('skips documents and counts that fail the allow-list instead of trusting them', () => {
    const docs = [
      dayDoc('not-a-day', { [LAB_A]: 100 }),
      { kind: 'something-else', day: TODAY, byLab: { [LAB_A]: 100 } },
      dayDoc(TODAY, { [LAB_A]: 2, 'Bad Id': 50, [LAB_B]: -1, 'lab-nan': Number.NaN, 'lab-str': '7' }),
      null,
      'text',
    ];
    const summary = summariseLabStarts(docs, { since: TODAY, today: TODAY });
    expect(summary.counts).toEqual({ today: 2, last7: 2, last30: 2, total: 2 });
    expect(summary.perLab.map((row) => row.labId)).toEqual([LAB_A]);
  });

  it('answers with only the figures: no stored identifier can reach the answer', () => {
    const summary = summariseLabStarts(
      [{ ...dayDoc(TODAY, { [LAB_A]: 1 }), clientHash: 'abc', ip: '203.0.113.9', id: 'lab-starts:x' }],
      { since: TODAY, today: TODAY }
    );
    expect(Object.keys(summary).sort()).toEqual(['counts', 'perLab', 'since', 'today']);
    expect(JSON.stringify(summary)).not.toContain('203.0.113.9');
    expect(JSON.stringify(summary)).not.toContain('abc');
  });
});

describe('readLabStarts', () => {
  it('adds up what recordLabStart stored', async () => {
    const store = newStore();
    await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 });
    await recordLabStart(store, { labId: LAB_B, nowMs: NOON_1 + 86_400_000 });
    await recordLabStart(store, { labId: LAB_B, nowMs: NOON_1 + 86_400_000 });
    const summary = await readLabStarts(store, { nowMs: NOON_1 + 86_400_000 + 1000 });
    expect(summary.since).toBe(DAY_1);
    expect(summary.today).toBe('2026-10-27');
    expect(summary.counts).toEqual({ today: 2, last7: 3, last30: 3, total: 3 });
  });

  it('asks for the day documents by kind only, with the kind as a parameter', async () => {
    const store = newStore();
    await readLabStarts(store, { nowMs: NOON_1 });
    const [container, sql, parameters] = store.queryDocs.mock.calls[0];
    expect(container).toBe(LAB_STARTS_CONTAINER);
    expect(sql).toContain('WHERE c.kind = @kind');
    expect(sql).not.toContain(LAB_STARTS_DAY_KIND);
    expect(parameters).toEqual([{ name: '@kind', value: LAB_STARTS_DAY_KIND }]);
  });

  it('names today as the day counting began when nothing has been counted yet, and keeps it', async () => {
    const store = newStore();
    const first = await readLabStarts(store, { nowMs: NOON_1 });
    expect(first.since).toBe(DAY_1);
    expect(first.counts.total).toBe(0);
    const later = await readLabStarts(store, { nowMs: NOON_1 + 5 * 86_400_000 });
    expect(later.since).toBe(DAY_1);
    expect(storedDocs(store)).toEqual([{ id: LAB_STARTS_META_ID, kind: LAB_STARTS_META_KIND, since: DAY_1 }]);
  });
});

describe('the admin read handler', () => {
  const allowGuard = () => ({
    requireRole: vi.fn(async () => ({ user: { oid: 'o' }, role: 'editor', error: null })),
  });
  const denyGuard = (status = 403) => ({
    requireRole: vi.fn(async () => ({
      user: null,
      role: null,
      error: { status, body: JSON.stringify({ error: 'no' }) },
    })),
  });
  const request = { method: 'GET', headers: new Headers() };

  it('refuses a caller the guard refuses, with the guard’s own answer, and reads nothing', async () => {
    for (const status of [401, 403]) {
      const store = newStore();
      const guard = denyGuard(status);
      const res = await createLabStartsReadHandler({ guard, store })(request, {});
      expect(res.status).toBe(status);
      expect(guard.requireRole).toHaveBeenCalledWith(request, 'editor');
      expect(store.readDoc).not.toHaveBeenCalled();
      expect(store.queryDocs).not.toHaveBeenCalled();
      expect(store.createDoc).not.toHaveBeenCalled();
    }
  });

  it('refuses a viewer: the role it asks for is editor, not viewer', async () => {
    const guard = allowGuard();
    await createLabStartsReadHandler({ guard, store: newStore() })(request, {});
    expect(guard.requireRole.mock.calls[0][1]).toBe('editor');
  });

  it('answers an editor with the figures, uncached', async () => {
    const store = newStore();
    await recordLabStart(store, { labId: LAB_A, nowMs: NOON_1 });
    const res = await createLabStartsReadHandler({ guard: allowGuard(), store, now: () => NOON_1 })(
      request,
      {}
    );
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(JSON.parse(res.body)).toEqual({
      since: DAY_1,
      today: DAY_1,
      counts: { today: 1, last7: 1, last30: 1, total: 1 },
      perLab: [{ labId: LAB_A, today: 1, last7: 1, last30: 1, total: 1 }],
    });
  });

  it('answers 500 with a fixed sentence and logs only the error code when the store fails', async () => {
    const store = newStore();
    store.fail(LAB_STARTS_CONTAINER, '*', 'queryDocs', Object.assign(new Error('secret detail 203.0.113.9'), { code: 503 }));
    const context = { error: vi.fn() };
    const res = await createLabStartsReadHandler({ guard: allowGuard(), store, now: () => NOON_1 })(
      request,
      context
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to read the lab start counts' });
    expect(context.error).toHaveBeenCalledWith('cmsLabsStarts failed (503)');
    expect(res.body).not.toContain('203.0.113.9');
  });
});
