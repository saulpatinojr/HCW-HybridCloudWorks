/**
 * Ambassador (ADR 0033 §4): programs seed once, the application status
 * machine refuses a move it does not list and records the ones it allows,
 * evidence import is idempotent on (sourceModule, sourceId), readiness
 * explains its arithmetic and never promises acceptance, an absent container
 * is a 503 NOT_PROVISIONED and not a 500, and the role per verb holds.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { MAX_PATCH_OPERATIONS } from './cosmos-client.js';
import {
  APPLICATION_STATUSES,
  APPLICATION_TRANSITIONS,
  CSV_IMPORT_MAX_CHARS,
  DEFAULT_PROGRAMS,
  UNLOCKING_MEMBERSHIP,
  canTransition,
  computeReadiness,
  createAmbassadorHandlers,
  importedEvidenceId,
  isNotProvisioned,
  parsePeriod,
  programGate,
  seedBackfillFor,
  SUPERSEDED_SEED_VALUES,
  toCalendarDate,
  validateApplication,
  validateEvidence,
  validateProgram,
} from './ambassador.js';

const context = { log: vi.fn(), error: vi.fn() };
const NOW = new Date('2026-10-03T12:00:00.000Z');
let counter = 0;
const fixed = { now: () => NOW, uuid: () => `id-${++counter}`, log: { error: vi.fn() } };

/** A guard that answers the given role for every call. */
const guardAs = (role) => ({
  requireRole: vi.fn(async (_request, required) => {
    const level = { viewer: 1, editor: 2, publisher: 3, super_admin: 4 };
    if (level[role] >= level[required]) {
      return { user: { oid: 'u1', email: 'owner@example.test' }, role, error: null };
    }
    return { user: null, role: null, error: { status: 403, body: '{}' } };
  }),
});

const makeRequest = ({ query = {}, params = {}, body } = {}) => ({
  query: { get: (k) => query[k] ?? null },
  params,
  headers: { get: () => 'vitest' },
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

/** An in-memory `ambassador` container plus whatever other containers a test seeds. */
function memStore(seed = {}) {
  const data = new Map(
    Object.entries(seed).map(([name, rows]) => [name, new Map(rows.map((r) => [r.id, r]))])
  );
  const table = (name) => {
    if (!data.has(name)) data.set(name, new Map());
    return data.get(name);
  };
  return {
    data,
    queryDocs: vi.fn(async (name, query, params) => {
      const rows = [...table(name).values()];
      const docType = params?.find((p) => p.name === '@docType')?.value;
      return docType ? rows.filter((r) => r.docType === docType && !r.softDeletedAt) : rows;
    }),
    readDoc: vi.fn(async (name, id) => table(name).get(id) || null),
    // The atomic insert: a second create of the same id is Cosmos's 409.
    createDoc: vi.fn(async (name, doc) => {
      if (table(name).has(doc.id)) throw Object.assign(new Error('Conflict'), { code: 409 });
      table(name).set(doc.id, doc);
      return doc;
    }),
    upsertDoc: vi.fn(async (name, doc) => {
      table(name).set(doc.id, doc);
      return doc;
    }),
    patchDoc: vi.fn(async (name, id, updates) => {
      const next = { ...table(name).get(id), ...updates };
      table(name).set(id, next);
      return next;
    }),
  };
}

const parse = (res) => JSON.parse(res.body);

describe('calendar dates and periods', () => {
  it('keeps a plain day, takes the day of a timestamp, and refuses an impossible one', () => {
    expect(toCalendarDate('2026-02-28')).toBe('2026-02-28');
    expect(toCalendarDate('2026-02-28T23:30:00.000Z')).toBe('2026-02-28');
    expect(toCalendarDate('2026-02-30')).toBeNull();
    expect(toCalendarDate('')).toBeNull();
  });

  it('reads a year or a range as a period', () => {
    expect(parsePeriod('2026')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(parsePeriod('2026-07-01..2027-06-30')).toEqual({
      start: '2026-07-01',
      end: '2027-06-30',
    });
    expect(parsePeriod('')).toBeNull();
  });
});

describe('validation', () => {
  it('rejects unknown fields on every kind, so a stray key never reaches the store', () => {
    expect(validateProgram({ name: 'X', bogus: 1 }).error).toMatch(/Unknown program field/);
    expect(validateApplication({ programId: 'p', bogus: 1 }).error).toMatch(
      /Unknown application field/
    );
    expect(validateEvidence({ title: 'T', date: '2026-01-01', bogus: 1 }).error).toMatch(
      /Unknown evidence field/
    );
  });

  it('checks dates and URLs and cleans lists', () => {
    expect(validateApplication({ programId: 'p', submissionDeadline: 'soon' }).error).toMatch(
      /submissionDeadline/
    );
    expect(
      validateEvidence({ title: 'T', date: '2026-01-01', url: 'javascript:alert(1)' }).error
    ).toMatch(/http/);
    const ok = validateEvidence({
      title: ' Talk ',
      date: '2026-05-01T09:00:00Z',
      technology: ['Azure', '', 7],
      metrics: { attendees: '120', reach: '' },
    });
    expect(ok.value).toMatchObject({
      title: 'Talk',
      date: '2026-05-01',
      sourceModule: 'manual',
      technology: ['Azure'],
      metrics: { attendees: 120, reach: null, views: null },
    });
    expect(
      validateProgram({
        name: 'P',
        requirements: [
          { label: 'Talks', evidenceTypes: ['speaking', 'nope'], minCount: '3', weight: 2 },
        ],
      }).value.requirements
    ).toEqual([
      {
        id: 'req-1',
        label: 'Talks',
        description: '',
        evidenceTypes: ['speaking'],
        minCount: 3,
        weight: 2,
      },
    ]);
  });
});

describe('status machine', () => {
  it('lists every status and allows only the moves in the table', () => {
    expect(APPLICATION_STATUSES).toHaveLength(12);
    for (const status of APPLICATION_STATUSES)
      expect(APPLICATION_TRANSITIONS[status]).toBeDefined();
    expect(canTransition('interested', 'preparing')).toBe(true);
    expect(canTransition('interested', 'accepted')).toBe(false);
    expect(canTransition('submitted', 'under_review')).toBe(true);
    expect(canTransition('renewal_due', 'renewed')).toBe(true);
    expect(canTransition('denied', 'preparing')).toBe(true);
    expect(canTransition('nope', 'preparing')).toBe(false);
  });
});

describe('readiness', () => {
  const program = {
    id: 'p1',
    requirements: [
      { id: 'talks', label: 'Talks', evidenceTypes: ['speaking'], minCount: 2, weight: 3 },
      { id: 'posts', label: 'Posts', evidenceTypes: ['content'], minCount: 1, weight: 1 },
    ],
  };
  const evidence = [
    { id: 'e1', title: 'A', date: '2026-03-01', sourceModule: 'speaking', programIds: [] },
    { id: 'e2', title: 'B', date: '2026-04-01', sourceModule: 'speaking', programIds: ['p1'] },
    { id: 'e3', title: 'C', date: '2025-01-01', sourceModule: 'speaking', programIds: ['other'] },
    { id: 'e4', title: 'D', date: '2026-02-01', sourceModule: 'content', softDeletedAt: 'x' },
  ];

  it('counts relevant evidence per requirement, weights the score and explains it', () => {
    const r = computeReadiness(program, evidence, { today: '2026-10-03' });
    expect(r.requirements.map((row) => [row.id, row.count, row.met])).toEqual([
      ['talks', 2, true],
      ['posts', 0, false],
    ]);
    expect(r.score).toBe(75);
    expect(r.missing).toEqual([{ id: 'posts', label: 'Posts', shortfall: 1 }]);
    expect(r.explanation).toContain('(3) over the total weight (4)');
    expect(r.explanation).toMatch(/does not promise/);
  });

  it('bounds the count by the period and drops the rolling-window warning when one is given', () => {
    const r = computeReadiness(program, evidence, {
      period: { start: '2026-04-01', end: '2026-12-31' },
      today: '2026-10-03',
    });
    expect(r.requirements[0].count).toBe(1);
    expect(r.expiring).toEqual([]);
  });
});

describe('not provisioned', () => {
  it('turns a Cosmos 404 on the container into 503 NOT_PROVISIONED with the owner message', async () => {
    const error = Object.assign(new Error('Resource Not Found'), { code: 404 });
    expect(isNotProvisioned(error)).toBe(true);
    expect(isNotProvisioned(new Error('boom'))).toBe(false);
    const store = memStore();
    store.queryDocs.mockRejectedValue(error);
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    const res = await h.listPrograms(makeRequest(), context);
    expect(res.status).toBe(503);
    expect(parse(res)).toEqual({
      code: 'NOT_PROVISIONED',
      message: 'Run terraform apply for the ambassador container',
    });
  });

  it('keeps any other failure a 500', async () => {
    const store = memStore();
    store.queryDocs.mockRejectedValue(new Error('throttled'));
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    expect((await h.listPrograms(makeRequest(), context)).status).toBe(500);
  });
});

describe('programs', () => {
  const SEED_NAMES = [
    'Microsoft MVP',
    'Microsoft Certified Trainer',
    'AWS Community Hero',
    'AWS Ambassador',
    'GitHub Star',
    'Docker Captain',
    'VMware vExpert',
    'Microsoft Elevate Educator – Expert (MIEE)',
    'GitKraken Ambassador',
    'Microsoft Management Community',
    'MCT Regional Lead',
    'AWS Community Builders',
  ];

  it('seeds every default on the first read of an empty container, each editable and enabled', async () => {
    const store = memStore();
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    const body = parse(await h.listPrograms(makeRequest(), context));
    expect(body.items.map((p) => p.name)).toEqual(SEED_NAMES);
    expect(body.items.map((p) => p.order)).toEqual(SEED_NAMES.map((_, i) => i + 1));
    expect(
      body.items.every((p) => p.enabled && p.docType === 'program' && p.requirements.length > 0)
    ).toBe(true);
    // Each seed is created atomically, never upserted.
    expect(store.createDoc).toHaveBeenCalledTimes(DEFAULT_PROGRAMS.length);
    expect(store.upsertDoc).not.toHaveBeenCalledWith(
      'ambassador',
      expect.objectContaining({ docType: 'program' })
    );
    // Every seeded requirement says it is a starting point.
    for (const program of DEFAULT_PROGRAMS) {
      for (const req of program.requirements) expect(req.description).toMatch(/Edit to match/);
    }
    // A second read seeds nothing.
    await h.listPrograms(makeRequest(), context);
    expect(store.createDoc).toHaveBeenCalledTimes(DEFAULT_PROGRAMS.length);
  });

  it('every seed passes its own validator, questions included, and none carries an answer', () => {
    for (const program of DEFAULT_PROGRAMS) {
      const body = Object.fromEntries(Object.entries(program).filter(([key]) => key !== 'id'));
      expect(validateProgram(body).error, program.id).toBeUndefined();
      expect(program.responses).toBeUndefined();
    }
    const mvp = DEFAULT_PROGRAMS.find((p) => p.id === 'program-microsoft-mvp');
    const sections = mvp.applicationQuestions.map((q) => q.section);
    expect(sections.filter((s, i) => sections.indexOf(s) === i)).toEqual([
      'Profile Information',
      'Online Influence & Network',
      'Application Questions',
      'Technology Area',
      'Technical Expertise',
    ]);
    expect(mvp.applicationQuestions.find((q) => q.id === 'mvp-activities')).toMatchObject({
      kind: 'activities',
      maxItems: 24,
    });
    const miee = DEFAULT_PROGRAMS.find((p) => p.id === 'program-microsoft-elevate-educator-expert');
    const grid = miee.applicationQuestions.find((q) => q.kind === 'scale');
    expect(grid.rows).toHaveLength(15);
    expect(grid.options).toEqual(['Daily', 'Weekly', 'Monthly', 'Rarely', 'Never']);
    expect(miee.applicationWindow).toEqual({
      opens: '2026-05-01',
      closes: '2026-07-31',
      note: 'Applications May to 31 July 2026; announcements September 2026.',
    });
  });

  it('adds the seeds an existing container is missing, after the highest order, never touching what is stored', async () => {
    const stamp = NOW.toISOString();
    const stored = DEFAULT_PROGRAMS.slice(0, 7).map((program, index) => ({
      ...program,
      docType: 'program',
      enabled: index !== 4,
      order: index + 1,
      name: index === 0 ? 'MVP (my edit)' : program.name,
      createdAt: stamp,
      updatedAt: stamp,
    }));
    // The owner soft-deleted one seed; it must not come back.
    const gone = {
      ...DEFAULT_PROGRAMS[8],
      docType: 'program',
      enabled: false,
      order: 20,
      softDeletedAt: stamp,
    };
    const store = memStore({ ambassador: [...stored, gone] });
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    const body = parse(await h.listPrograms(makeRequest(), context));
    expect(body.items.map((p) => p.name)).toEqual([
      'MVP (my edit)',
      ...SEED_NAMES.slice(1, 7),
      'Microsoft Elevate Educator – Expert (MIEE)',
      'Microsoft Management Community',
      'MCT Regional Lead',
      'AWS Community Builders',
    ]);
    // Appended after the highest stored order (7), in seed order.
    expect(body.items.slice(7).map((p) => p.order)).toEqual([8, 9, 10, 11]);
    expect(body.items.find((p) => p.id === 'program-github-star').enabled).toBe(false);
    expect(store.createDoc).toHaveBeenCalledTimes(4);
    expect(store.data.get('ambassador').get(gone.id).softDeletedAt).toBe(stamp);
    // Nothing more on the next read.
    await h.listPrograms(makeRequest(), context);
    expect(store.createDoc).toHaveBeenCalledTimes(4);
  });

  it('two overlapping reads that both miss a seed leave the first insert, edits included, and never surface a soft-deleted one', async () => {
    const stamp = NOW.toISOString();
    const base = { docType: 'program', enabled: true, createdAt: stamp, updatedAt: stamp };
    const stored = DEFAULT_PROGRAMS.slice(0, 7).map((p, i) => ({ ...p, ...base, order: i + 1 }));
    const miee = DEFAULT_PROGRAMS.find((p) => p.id === 'program-microsoft-elevate-educator-expert');
    const gitkraken = DEFAULT_PROGRAMS.find((p) => p.id === 'program-gitkraken-ambassador');
    // What the first read inserted and the owner then edited, and what it
    // inserted and the owner then soft-deleted — both present in the store
    // while this (second) read's list and first readDoc predate them.
    const edited = { ...miee, ...base, seeded: true, order: 8, name: 'MIEE (my edit)' };
    const deleted = { ...gitkraken, ...base, seeded: true, order: 9, softDeletedAt: stamp };
    const store = memStore({ ambassador: [...stored, edited, deleted] });
    const listRows = store.queryDocs.getMockImplementation();
    store.queryDocs.mockImplementationOnce(async (name, query, params) =>
      (await listRows(name, query, params)).filter((r) => ![miee.id, gitkraken.id].includes(r.id))
    );
    const readRows = store.readDoc.getMockImplementation();
    const stale = new Set([miee.id, gitkraken.id]);
    store.readDoc.mockImplementation(async (name, id) => {
      if (stale.has(id)) {
        stale.delete(id);
        return null;
      }
      return readRows(name, id);
    });
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    const body = parse(await h.listPrograms(makeRequest(), context));
    expect(body.items.find((p) => p.id === miee.id).name).toBe('MIEE (my edit)');
    expect(body.items.find((p) => p.id === gitkraken.id)).toBeUndefined();
    expect(store.data.get('ambassador').get(miee.id).name).toBe('MIEE (my edit)');
    expect(store.data.get('ambassador').get(gitkraken.id).softDeletedAt).toBe(stamp);
    expect(store.upsertDoc).not.toHaveBeenCalledWith(
      'ambassador',
      expect.objectContaining({ docType: 'program' })
    );
    // The two seeds the first read never inserted are created once each.
    expect(store.createDoc.mock.calls.map(([, doc]) => doc.id)).toEqual([
      miee.id,
      gitkraken.id,
      'program-microsoft-management-community',
      'program-microsoft-mct-regional-lead',
      'program-aws-community-builders',
    ]);
  });

  it('backfills a stored seed with the questions and scoring it gained, and nothing else', async () => {
    const stamp = NOW.toISOString();
    const [mvpSeed, mctSeed] = DEFAULT_PROGRAMS;
    const management = DEFAULT_PROGRAMS.find(
      (p) => p.id === 'program-microsoft-management-community'
    );
    const without = (program, ...keys) =>
      Object.fromEntries(Object.entries(program).filter(([key]) => !keys.includes(key)));
    const base = { docType: 'program', enabled: true, createdAt: stamp, updatedAt: '2026-01-01' };
    // A stored seeded MVP the owner edited, from before the questions existed.
    const storedMvp = {
      ...without(mvpSeed, 'applicationQuestions'),
      ...base,
      seeded: true,
      order: 1,
      name: 'MVP (my edit)',
      description: 'My own words.',
      requirements: [mvpSeed.requirements[0]],
      enabled: false,
      membershipStatus: 'working',
      _etag: '"etag-mvp"',
    };
    // A stored seeded program carrying its own questions already.
    const own = [{ id: 'mine', section: 'S', prompt: 'My question', kind: 'text' }];
    const storedMct = { ...mctSeed, ...base, seeded: true, order: 2, applicationQuestions: own };
    // The owner's own program under a seed's id: not seeded, left alone.
    const ownManagement = {
      ...without(management, 'scoring', 'applicationQuestions'),
      ...base,
      order: 3,
      name: 'My community',
    };
    // A seeded program whose scoring was never stored. Each is stamped at its
    // seed's current revision, as seededDoc stamps a fresh one.
    const otherSeeds = DEFAULT_PROGRAMS.filter(
      (p) => ![mvpSeed.id, mctSeed.id, management.id].includes(p.id)
    ).map((p, i) => ({
      ...p,
      ...base,
      seeded: true,
      order: 10 + i,
      ...(SUPERSEDED_SEED_VALUES[p.id] ? { seedRevision: SUPERSEDED_SEED_VALUES[p.id].revision } : {}),
    }));
    const store = memStore({ ambassador: [storedMvp, storedMct, ownManagement, ...otherSeeds] });
    const log = { error: vi.fn(), info: vi.fn() };
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed, log });
    const body = parse(await h.listPrograms(makeRequest(), context));

    const mvp = body.items.find((p) => p.id === mvpSeed.id);
    expect(mvp.applicationQuestions).toEqual(mvpSeed.applicationQuestions);
    expect(mvp).toMatchObject({
      name: 'MVP (my edit)',
      description: 'My own words.',
      requirements: [mvpSeed.requirements[0]],
      enabled: false,
      membershipStatus: 'working',
      order: 1,
      updatedAt: stamp,
    });
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
    // The owner edited the requirements, so revision 2 of the MVP seed
    // (#1302) replaces nothing — but the row takes the stamp, once, as
    // SUPERSEDED_SEED_VALUES says every stored seed below its revision does.
    expect(store.patchDoc).toHaveBeenCalledWith(
      'ambassador',
      mvpSeed.id,
      { applicationQuestions: mvpSeed.applicationQuestions, seedRevision: 2, updatedAt: stamp },
      { ifMatch: '"etag-mvp"' }
    );
    expect(log.info).toHaveBeenCalledWith(
      '[ambassador] seed backfill: applicationQuestions, seedRevision'
    );
    // Its own questions stay; the owner's program is untouched; the management seed is absent, so added whole.
    expect(body.items.find((p) => p.id === mctSeed.id).applicationQuestions).toEqual(own);
    const mine = body.items.find((p) => p.id === management.id);
    expect(mine.name).toBe('My community');
    expect(mine.seeded).toBeUndefined();
    expect(mine.scoring).toBeUndefined();
    expect(mine.applicationQuestions).toBeUndefined();
    expect(store.upsertDoc).not.toHaveBeenCalledWith(
      'ambassador',
      expect.objectContaining({ docType: 'program' })
    );
    // Nothing more on the next read.
    await h.listPrograms(makeRequest(), context);
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
  });

  it('backfills scoring on a stored seed that has none, through a store without ETags', async () => {
    const management = DEFAULT_PROGRAMS.find(
      (p) => p.id === 'program-microsoft-management-community'
    );
    const stored = Object.fromEntries(Object.entries(management).filter(([k]) => k !== 'scoring'));
    const store = memStore({
      ambassador: [{ ...stored, docType: 'program', enabled: true, seeded: true, order: 1 }],
    });
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    const body = parse(await h.listPrograms(makeRequest(), context));
    expect(body.items.find((p) => p.id === management.id).scoring).toEqual(management.scoring);
    expect(store.patchDoc).toHaveBeenCalledWith(
      'ambassador',
      management.id,
      { scoring: management.scoring, updatedAt: NOW.toISOString() },
      {}
    );
  });

  it('scores a credits program by summing metrics.credits against each tier', () => {
    const program = DEFAULT_PROGRAMS.find((p) => p.id === 'program-microsoft-management-community');
    expect(program.scoring).toMatchObject({ unit: 'credits' });
    expect(program.requirements.map((r) => r.minCount)).toEqual([10, 20, 25, 50, 75, 100]);
    const evidence = [
      { id: 'a', date: '2026-02-01', sourceModule: 'manual', metrics: { credits: 6 } },
      { id: 'b', date: '2026-03-01', sourceModule: 'manual', metrics: { credits: 3 } },
      { id: 'c', date: '2026-03-02', sourceModule: 'manual', metrics: { credits: 3 } },
      { id: 'd', date: '2026-03-03', sourceModule: 'speaking', metrics: { credits: 50 } },
      { id: 'e', date: '2026-03-04', sourceModule: 'manual', metrics: {} },
    ];
    const r = computeReadiness(program, evidence, { today: '2026-10-03' });
    expect(r.unit).toBe('credits');
    expect(r.requirements[0]).toMatchObject({ unit: 'credits', count: 12, met: true });
    expect(r.requirements[1]).toMatchObject({ count: 12, met: false });
    expect(r.missing[0]).toEqual({
      id: 'tier-20',
      label: 'Community Advocate (20 credits)',
      shortfall: 8,
    });
    expect(r.explanation).toMatch(/scored in credits/);
    // An item-count program keeps counting items and says so.
    const plain = computeReadiness(DEFAULT_PROGRAMS[0], evidence, { today: '2026-10-03' });
    expect(plain.unit).toBe('items');
    expect(plain.explanation).toMatch(/number of relevant evidence items/);
  });

  it('needs super_admin to change the catalogue, and disabling never deletes', async () => {
    const store = memStore();
    const editor = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    await editor.listPrograms(makeRequest(), context);
    expect(
      (
        await editor.patchProgram(
          makeRequest({ params: { id: 'program-github-star' }, body: { enabled: false } }),
          context
        )
      ).status
    ).toBe(403);

    const admin = createAmbassadorHandlers({ guard: guardAs('super_admin'), store, ...fixed });
    const res = await admin.patchProgram(
      makeRequest({ params: { id: 'program-github-star' }, body: { enabled: false, order: 9 } }),
      context
    );
    expect(parse(res).item).toMatchObject({ enabled: false, order: 9 });
    expect(store.data.get('ambassador').get('program-github-star').softDeletedAt).toBeUndefined();
    const audit = store.upsertDoc.mock.calls.find(
      ([c, d]) => c === 'admin_audit_logs' && d.action === 'ambassador_program_updated'
    );
    expect(audit[1]).toMatchObject({
      userEmail: 'owner@example.test',
      details: { programId: 'program-github-star' },
    });
  });
});

describe('applications', () => {
  async function seeded(role = 'editor') {
    const store = memStore();
    const h = createAmbassadorHandlers({ guard: guardAs(role), store, ...fixed });
    await h.listPrograms(makeRequest(), context);
    return { store, h };
  }

  it('creates as interested with an opening history row, private by default', async () => {
    const { h } = await seeded();
    const res = await h.createApplication(
      makeRequest({ body: { programId: 'program-microsoft-mvp' } }),
      context
    );
    expect(res.status).toBe(200);
    expect(parse(res).item).toMatchObject({
      status: 'interested',
      private: true,
      programId: 'program-microsoft-mvp',
      history: [{ from: null, to: 'interested', by: 'owner@example.test' }],
    });
    expect(parse(res).item).not.toHaveProperty('statusNote');
    expect(
      (await h.createApplication(makeRequest({ body: { programId: 'nope' } }), context)).status
    ).toBe(400);
  });

  it('refuses a transition the table does not list and records one it does, with its note', async () => {
    const { h, store } = await seeded();
    const id = parse(
      await h.createApplication(
        makeRequest({ body: { programId: 'program-aws-ambassador' } }),
        context
      )
    ).id;

    const refused = await h.patchApplication(
      makeRequest({ params: { id }, body: { status: 'accepted' } }),
      context
    );
    expect(refused.status).toBe(400);
    expect(parse(refused).allowed).toEqual(['preparing', 'withdrawn']);

    await h.patchApplication(
      makeRequest({
        params: { id },
        body: { status: 'preparing', statusNote: 'Collecting talks' },
      }),
      context
    );
    await h.patchApplication(makeRequest({ params: { id }, body: { status: 'ready' } }), context);
    const submitted = parse(
      await h.patchApplication(
        makeRequest({ params: { id }, body: { status: 'submitted' } }),
        context
      )
    ).item;
    expect(submitted.history.map((row) => row.to)).toEqual([
      'interested',
      'preparing',
      'ready',
      'submitted',
    ]);
    expect(submitted.history[1].note).toBe('Collecting talks');
    expect(submitted.applicationDate).toBe('2026-10-03');
    expect(store.data.get('ambassador').get(id).statusNote).toBeUndefined();
  });

  it('lets a super_admin set any status from Settings, recorded as an override; an editor is refused', async () => {
    const { h: editor } = await seeded('editor');
    const id = parse(
      await editor.createApplication(
        makeRequest({ body: { programId: 'program-microsoft-mct' } }),
        context
      )
    ).id;
    const refused = await editor.patchApplication(
      makeRequest({ params: { id }, body: { status: 'active', statusOverride: true } }),
      context
    );
    expect(refused.status).toBe(403);

    const { h: admin, store } = await seeded('super_admin');
    const adminId = parse(
      await admin.createApplication(
        makeRequest({ body: { programId: 'program-microsoft-mct' } }),
        context
      )
    ).id;
    const set = parse(
      await admin.patchApplication(
        makeRequest({
          params: { id: adminId },
          body: { status: 'active', statusOverride: true, statusNote: 'Set from Settings' },
        }),
        context
      )
    ).item;
    expect(set.status).toBe('active');
    expect(set.history.at(-1)).toMatchObject({
      from: 'interested',
      to: 'active',
      note: 'Set from Settings',
      override: true,
    });
    expect(store.data.get('ambassador').get(adminId).statusOverride).toBeUndefined();
    // A plain move still obeys the table.
    const plain = await admin.patchApplication(
      makeRequest({ params: { id: adminId }, body: { status: 'interested' } }),
      context
    );
    expect(plain.status).toBe(400);
  });

  it('refuses statusOverride on a create, and answers 409 when the record changed under a patch', async () => {
    const { h, store } = await seeded('super_admin');
    const refused = await h.createApplication(
      makeRequest({ body: { programId: 'program-microsoft-mct', statusOverride: true } }),
      context
    );
    expect(refused.status).toBe(400);

    const id = parse(
      await h.createApplication(
        makeRequest({ body: { programId: 'program-microsoft-mct' } }),
        context
      )
    ).id;
    store.data.get('ambassador').get(id)._etag = 'etag-1';
    store.patchDoc.mockImplementationOnce(async () => {
      throw Object.assign(new Error('precondition failed'), { code: 412 });
    });
    const conflict = await h.patchApplication(
      makeRequest({ params: { id }, body: { status: 'preparing' } }),
      context
    );
    expect(conflict.status).toBe(409);
    expect(parse(conflict).code).toBe('CONFLICT');
    // The write carried the ETag it read.
    const [, , , options] = store.patchDoc.mock.calls.at(-1);
    expect(options).toEqual({ ifMatch: 'etag-1' });
  });

  it('keeps a privately stored file by its { container, path } reference, and serves it as a download', async () => {
    const { h } = await seeded('editor');
    const created = parse(
      await h.createApplication(
        makeRequest({
          body: {
            programId: 'program-microsoft-mct',
            files: [
              { name: 'agreement.pdf', path: 'ambassador/app-1/1-agreement.pdf', container: 'speakerevents', bytes: 10 },
              { name: 'no-reference-at-all' },
              { name: 'linked', url: 'https://example.com/x.pdf' },
            ],
          },
        }),
        context
      )
    ).item;
    expect(created.files).toEqual([
      {
        name: 'agreement.pdf',
        url: null,
        container: 'speakerevents',
        path: 'ambassador/app-1/1-agreement.pdf',
        bytes: 10,
        uploadedAt: null,
      },
      { name: 'linked', url: 'https://example.com/x.pdf', container: null, path: null, bytes: null, uploadedAt: null },
    ]);

    const storage = {
      readBlobForDelivery: vi.fn(async (_c, path) =>
        path === 'ambassador/app-1/1-agreement.pdf'
          ? { body: Buffer.from('%PDF'), contentType: 'application/pdf', etag: '"e1"' }
          : null
      ),
    };
    const withStorage = createAmbassadorHandlers({ guard: guardAs('editor'), store: memStore(), storage, ...fixed });
    const ok = await withStorage.downloadFile(
      makeRequest({ params: { container: 'speakerevents', blobPath: 'ambassador/app-1/1-agreement.pdf' } }),
      context
    );
    expect(ok.status).toBe(200);
    expect(ok.headers['Content-Type']).toBe('application/pdf');
    expect(ok.headers['Content-Disposition']).toBe('attachment; filename="1-agreement.pdf"');
    expect(ok.headers['Cache-Control']).toBe('private, no-store');
    expect(ok.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(ok.body.toString()).toBe('%PDF');

    for (const params of [
      { container: 'certifications', blobPath: 'ambassador/app-1/1-agreement.pdf' },
      { container: 'speakerevents', blobPath: 'events/2026/hero.png' },
      { container: 'speakerevents', blobPath: 'ambassador/../secret.pdf' },
      { container: 'speakerevents', blobPath: 'ambassador/app-1/missing.pdf' },
    ]) {
      expect((await withStorage.downloadFile(makeRequest({ params }), context)).status).toBe(404);
    }
    expect(storage.readBlobForDelivery).toHaveBeenCalledTimes(2);
    expect((await h.downloadFile(makeRequest({ params: { container: 'speakerevents', blobPath: 'ambassador/a/b.pdf' } }), context)).status).toBe(503);
  });

  it('deletes softly and only as publisher', async () => {
    const { h, store } = await seeded();
    const id = parse(
      await h.createApplication(
        makeRequest({ body: { programId: 'program-docker-captain' } }),
        context
      )
    ).id;
    expect((await h.deleteApplication(makeRequest({ params: { id } }), context)).status).toBe(403);
    const publisher = createAmbassadorHandlers({ guard: guardAs('publisher'), store, ...fixed });
    expect(
      (await publisher.deleteApplication(makeRequest({ params: { id } }), context)).status
    ).toBe(200);
    expect(store.data.get('ambassador').get(id).softDeletedAt).toBe(NOW.toISOString());
    expect(parse(await h.listApplications(makeRequest(), context)).items).toEqual([]);
  });
});

describe('evidence', () => {
  it('imports from speaking with a snapshot, once per source id, and reports what is missing', async () => {
    const store = memStore({
      speakerevents: [
        {
          id: 'event-1',
          eventName: 'KCDC',
          date: '2026-08-14T00:00:00.000Z',
          eventUrl: 'https://kcdc.info',
          attendance: 80,
        },
        { id: 'event-2', name: 'Meetup', date: '2026-09-01' },
      ],
    });
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    const first = parse(
      await h.importEvidence(
        makeRequest({ body: { sourceModule: 'speaking', ids: ['event-1', 'event-2', 'event-9'] } }),
        context
      )
    );
    expect(first.created.map((e) => e.title)).toEqual(['KCDC', 'Meetup']);
    // One id per (sourceModule, sourceId), created atomically rather than upserted.
    expect(first.created[0].id).toBe(importedEvidenceId('speaking', 'event-1'));
    expect(first.created[0].id).toMatch(/^evidence-import-[0-9a-f]{40}$/);
    expect(store.createDoc).toHaveBeenCalledTimes(2);
    expect(store.upsertDoc).not.toHaveBeenCalledWith(
      'ambassador',
      expect.objectContaining({ docType: 'evidence' })
    );
    expect(first.created[0]).toMatchObject({
      sourceModule: 'speaking',
      sourceId: 'event-1',
      date: '2026-08-14',
      snapshot: {
        title: 'KCDC',
        date: '2026-08-14',
        url: 'https://kcdc.info',
        capturedAt: NOW.toISOString(),
      },
      metrics: { attendees: 80 },
    });
    expect(first.missing).toEqual(['event-9']);

    const second = parse(
      await h.importEvidence(
        makeRequest({ body: { sourceModule: 'speaking', ids: ['event-1'] } }),
        context
      )
    );
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(1);

    const sources = parse(
      await h.listImportSources(makeRequest({ params: { sourceModule: 'speaking' } }), context)
    );
    expect(sources.items.map((s) => [s.id, s.imported])).toEqual([
      ['event-2', true],
      ['event-1', true],
    ]);
    expect(
      (await h.importEvidence(makeRequest({ body: { sourceModule: 'labs', ids: ['x'] } }), context))
        .status
    ).toBe(400);
  });

  it('two imports racing for one source document leave one row, and a UUID-era row is still recognised', async () => {
    const store = memStore({
      speakerevents: [
        { id: 'event-1', eventName: 'KCDC', date: '2026-08-14' },
        { id: 'event-2', name: 'Meetup', date: '2026-09-01' },
      ],
      ambassador: [
        {
          id: 'evidence-legacy-uuid',
          docType: 'evidence',
          title: 'Meetup (imported last year)',
          date: '2026-09-01',
          sourceModule: 'speaking',
          sourceId: 'event-2',
        },
      ],
    });
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    const first = parse(
      await h.importEvidence(
        makeRequest({ body: { sourceModule: 'speaking', ids: ['event-1', 'event-2'] } }),
        context
      )
    );
    const id = importedEvidenceId('speaking', 'event-1');
    expect(first.created.map((e) => e.id)).toEqual([id]);
    expect(first.existing).toEqual(['evidence-legacy-uuid']);

    // The owner edits the imported row, then a second import whose pre-check
    // read the list before the first landed (stale: no evidence) races in.
    await h.patchEvidence(
      makeRequest({ params: { id }, body: { title: 'KCDC (my title)' } }),
      context
    );
    const listEvidence = store.queryDocs.getMockImplementation();
    store.queryDocs.mockImplementationOnce(async (name, query, params) =>
      params?.some((p) => p.value === 'evidence') ? [] : listEvidence(name, query, params)
    );
    const second = parse(
      await h.importEvidence(
        makeRequest({ body: { sourceModule: 'speaking', ids: ['event-1'] } }),
        context
      )
    );
    expect(second.created).toEqual([]);
    expect(second.existing).toEqual([id]);
    expect(store.createDoc).toHaveBeenCalledTimes(2);
    expect(store.data.get('ambassador').get(id).title).toBe('KCDC (my title)');
    expect([...store.data.get('ambassador').values()].filter((e) => e.sourceId === 'event-1'))
      .toHaveLength(1);
  });

  it('refuses a CSV over the character limit with a 413 that names it, never a clipped import', async () => {
    const store = memStore();
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    const header = 'MTM Class ID,Course,Start Date\n';
    const text = header + 'x'.repeat(CSV_IMPORT_MAX_CHARS + 1 - header.length);
    const res = await h.importEvidence(
      makeRequest({ body: { reader: 'mct-classes', text } }),
      context
    );
    expect(res.status).toBe(413);
    expect(parse(res)).toEqual({
      error: 'text is 1,000,001 characters; the limit is 1,000,000. Split the export and import each part.',
      limit: 1_000_000,
    });
    expect(store.createDoc).not.toHaveBeenCalled();
    // Exactly at the limit is taken.
    const atLimit = header + 'y'.repeat(CSV_IMPORT_MAX_CHARS - header.length);
    expect(
      (await h.importEvidence(makeRequest({ body: { reader: 'mct-classes', text: atLimit } }), context))
        .status
    ).toBe(200);
  });

  it('imports MCT classes from a pasted Metrics That Matter CSV, once per class id, skipping rows without one', async () => {
    const store = memStore();
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    const text = [
      'MTM Class ID,Course,Learning Method,Instructor,Start Date,End Date,Location,Students',
      '1001,"AZ-104: Microsoft Azure Administrator",Virtual ILT,J. Doe,3/2/2026,3/5/2026,Remote,14',
      '1002,"SC-900, Security Fundamentals",ILT,J. Doe,2026-04-10,2026-04-10,Chicago,',
      ',,ILT,J. Doe,2026-05-01,,,',
      ',"AZ-900: Azure Fundamentals",ILT,J. Doe,2026-05-02,2026-05-02,Remote,9',
      '1003,"AZ-900: Azure Fundamentals",ILT,J. Doe,,,,',
    ].join('\r\n');
    const first = parse(
      await h.importEvidence(
        makeRequest({
          body: { reader: 'mct-classes', text, programIds: ['program-microsoft-mct'] },
        }),
        context
      )
    );
    expect(first.created.map((e) => [e.title, e.date, e.sourceId])).toEqual([
      ['AZ-104: Microsoft Azure Administrator', '2026-03-02', 'mct-class:1001'],
      ['SC-900, Security Fundamentals', '2026-04-10', 'mct-class:1002'],
    ]);
    expect(first.created[0]).toMatchObject({
      sourceModule: 'manual',
      programIds: ['program-microsoft-mct'],
      tags: ['mct-classes'],
      metrics: { attendees: 14 },
      description:
        'MCT class delivered: Virtual ILT · Instructor J. Doe · 2026-03-02 to 2026-03-05 · Remote',
      snapshot: { title: 'AZ-104: Microsoft Azure Administrator', date: '2026-03-02', url: null },
    });
    expect(first.created[1].metrics.attendees).toBeNull();
    expect(first.created[0].id).toBe(importedEvidenceId('manual', 'mct-class:1001'));
    // Two rows without a class id (one of them a full class) and one without a date.
    expect(first.skipped).toBe(3);
    expect(first.skippedReasons).toEqual({ 'missing-class-id': 2, 'missing-course-or-date': 1 });

    const again = parse(
      await h.importEvidence(makeRequest({ body: { reader: 'mct-classes', text } }), context)
    );
    expect(again.created).toEqual([]);
    expect(again.existing).toEqual([
      importedEvidenceId('manual', 'mct-class:1001'),
      importedEvidenceId('manual', 'mct-class:1002'),
    ]);

    expect(
      (await h.importEvidence(makeRequest({ body: { reader: 'nope', text } }), context)).status
    ).toBe(400);
    expect(
      (await h.importEvidence(makeRequest({ body: { reader: 'mct-classes', text: '' } }), context))
        .status
    ).toBe(400);
  });

  it('lists with filters and computes readiness over the container', async () => {
    const store = memStore();
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    await h.listPrograms(makeRequest(), context);
    await h.createEvidence(
      makeRequest({ body: { title: 'Talk', date: '2026-05-01', sourceModule: 'speaking' } }),
      context
    );
    await h.createEvidence(
      makeRequest({
        body: {
          title: 'Cert',
          date: '2026-06-01',
          sourceModule: 'certifications',
          verificationStatus: 'verified',
          programIds: ['program-microsoft-mct'],
        },
      }),
      context
    );

    expect(
      parse(
        await h.listEvidence(makeRequest({ query: { sourceModule: 'speaking' } }), context)
      ).items.map((e) => e.title)
    ).toEqual(['Talk']);
    expect(
      parse(
        await h.listEvidence(makeRequest({ query: { verificationStatus: 'verified' } }), context)
      ).items
    ).toHaveLength(1);
    expect(
      parse(
        await h.listEvidence(
          makeRequest({ query: { programId: 'program-aws-ambassador' } }),
          context
        )
      ).items.map((e) => e.title)
    ).toEqual(['Talk']);

    const res = parse(
      await h.readiness(
        makeRequest({ params: { programId: 'program-microsoft-mct' }, query: { period: '2026' } }),
        context
      )
    );
    expect(res.readiness.requirements.find((r) => r.id === 'cert')).toMatchObject({
      count: 1,
      met: true,
    });
    expect(res.readiness.explanation).toMatch(/Acceptance is decided by the program/);
    expect(
      (await h.readiness(makeRequest({ params: { programId: 'nope' } }), context)).status
    ).toBe(404);
  });
});

describe('additional programs (owner request 2026-10-05): MCT Regional Lead under MCT', () => {
  const RL = 'program-microsoft-mct-regional-lead';
  const MCT = 'program-microsoft-mct';

  async function seeded(role = 'super_admin') {
    const store = memStore();
    const h = createAmbassadorHandlers({ guard: guardAs(role), store, ...fixed });
    await h.listPrograms(makeRequest(), context);
    return { store, h };
  }

  it('seeds the Regional Lead additional to MCT, with the role requirements as questions', () => {
    const rl = DEFAULT_PROGRAMS.find((p) => p.id === RL);
    expect(rl.parentProgramId).toBe(MCT);
    expect(DEFAULT_PROGRAMS.find((p) => p.id === MCT).parentProgramId).toBeUndefined();
    const sections = rl.applicationQuestions.map((q) => q.section);
    expect(sections.filter((s, i) => sections.indexOf(s) === i)).toEqual([
      'Nomination and eligibility',
      'MCT community support',
      'Role expectations',
    ]);
    expect(rl.applicationQuestions.find((q) => q.id === 'rl-commitments')).toMatchObject({
      kind: 'scale',
      options: ['Yes', 'Partly', 'No'],
    });
    // One level only, in the seeds as in the validator below.
    for (const program of DEFAULT_PROGRAMS) {
      if (!program.parentProgramId) continue;
      const parent = DEFAULT_PROGRAMS.find((p) => p.id === program.parentProgramId);
      expect(parent, program.id).toBeDefined();
      expect(parent.parentProgramId).toBeUndefined();
    }
  });

  it('programGate: shut without a parent or while the parent is not Active, open when it is', () => {
    const child = { id: RL, parentProgramId: MCT };
    expect(programGate({ id: MCT }, null)).toEqual({ gated: false, unlocked: true, parent: null });
    expect(programGate(child, null)).toEqual({
      gated: true,
      unlocked: false,
      parent: { id: MCT, name: null, membershipStatus: 'none' },
    });
    expect(programGate(child, { id: MCT, name: 'MCT', membershipStatus: 'working' })).toMatchObject(
      { gated: true, unlocked: false, parent: { name: 'MCT', membershipStatus: 'working' } }
    );
    expect(programGate(child, { id: MCT, name: 'MCT', membershipStatus: 'active' }).unlocked).toBe(
      true
    );
    expect(UNLOCKING_MEMBERSHIP).toBe('active');
  });

  it('refuses a Regional Lead application until the MCT membership is Active, then takes it', async () => {
    const { h } = await seeded();
    const refused = await h.createApplication(makeRequest({ body: { programId: RL } }), context);
    expect(refused.status).toBe(409);
    expect(parse(refused)).toMatchObject({ code: 'PARENT_NOT_ACTIVE', parentProgramId: MCT });
    expect(parse(refused).error).toMatch(/additional to Microsoft Certified Trainer/);
    expect(parse(refused).error).toMatch(/Active on Settings/);

    // The Settings row's "Application state" starts an application the same way: refused too.
    const fromSettings = await h.createApplication(
      makeRequest({ body: { programId: RL, status: 'preparing' } }),
      context
    );
    expect(fromSettings.status).toBe(409);

    await h.patchProgram(
      makeRequest({ params: { id: MCT }, body: { membershipStatus: 'active' } }),
      context
    );
    const taken = await h.createApplication(makeRequest({ body: { programId: RL } }), context);
    expect(taken.status).toBe(200);
    expect(parse(taken).item.programId).toBe(RL);

    // Moving an existing application onto a locked child is refused the same way.
    await h.patchProgram(
      makeRequest({ params: { id: MCT }, body: { membershipStatus: 'working' } }),
      context
    );
    const mvp = parse(
      await h.createApplication(makeRequest({ body: { programId: 'program-microsoft-mvp' } }), context)
    );
    const moved = await h.patchApplication(
      makeRequest({ params: { id: mvp.id }, body: { programId: RL } }),
      context
    );
    expect(moved.status).toBe(409);
  });

  it('readiness counts evidence filed under the parent for the child and reports the gate', async () => {
    const { h, store } = await seeded();
    const evidence = (id, programIds, extra = {}) => ({
      id,
      docType: 'evidence',
      title: id,
      date: '2026-09-01',
      sourceModule: 'manual',
      programIds,
      ...extra,
    });
    store.data.get('ambassador').set('e-mct', evidence('e-mct', [MCT]));
    store.data.get('ambassador').set('e-rl', evidence('e-rl', [RL]));
    store.data.get('ambassador').set('e-mvp', evidence('e-mvp', ['program-microsoft-mvp']));
    store.data.get('ambassador').set('e-any', evidence('e-any', []));

    const locked = parse(await h.readiness(makeRequest({ params: { programId: RL } }), context));
    const lounge = locked.readiness.requirements.find((r) => r.id === 'lounge');
    expect(lounge.items.map((i) => i.id).sort()).toEqual(['e-any', 'e-mct', 'e-rl']);
    expect(locked.readiness.gate).toEqual({
      gated: true,
      unlocked: false,
      parent: { id: MCT, name: 'Microsoft Certified Trainer', membershipStatus: 'none' },
    });

    await h.patchProgram(
      makeRequest({ params: { id: MCT }, body: { membershipStatus: 'active' } }),
      context
    );
    const open = parse(await h.readiness(makeRequest({ params: { programId: RL } }), context));
    expect(open.readiness.gate.unlocked).toBe(true);
    // The parent's own readiness is ungated and does not read the child's evidence.
    const mct = parse(await h.readiness(makeRequest({ params: { programId: MCT } }), context));
    expect(mct.readiness.gate).toEqual({ gated: false, unlocked: true, parent: null });
    const teaching = mct.readiness.requirements.find((r) => r.id === 'teaching');
    expect(teaching.items.map((i) => i.id).sort()).toEqual(['e-any', 'e-mct']);
  });

  it('a program parent must exist, be another program, and have no parent of its own; empty clears', async () => {
    const { h, store } = await seeded();
    const patch = (id, body) => h.patchProgram(makeRequest({ params: { id }, body }), context);
    expect(parse(await patch(MCT, { parentProgramId: 'program-nope' }))).toEqual({
      error: 'Unknown parentProgramId program-nope',
    });
    expect(parse(await patch(MCT, { parentProgramId: MCT })).error).toMatch(/to itself/);
    // Two levels: MCT under the Regional Lead, which is already under MCT.
    expect(parse(await patch(MCT, { parentProgramId: RL })).error).toMatch(/one level only/);
    expect(store.data.get('ambassador').get(MCT).parentProgramId).toBeUndefined();

    const cleared = await patch(RL, { parentProgramId: '' });
    expect(cleared.status).toBe(200);
    expect(store.data.get('ambassador').get(RL).parentProgramId).toBeNull();

    const created = await h.createProgram(
      makeRequest({ body: { name: 'MCT Mentor', parentProgramId: MCT } }),
      context
    );
    expect(created.status).toBe(200);
    expect(parse(created).item.parentProgramId).toBe(MCT);
    expect(
      parse(
        await h.createProgram(
          makeRequest({ body: { name: 'Nested', parentProgramId: parse(created).id } }),
          context
        )
      ).error
    ).toMatch(/one level only/);
  });

  it('refuses a parent when the child is a seed not yet stored, or stored without its parent (#883 review)', async () => {
    const stamp = NOW.toISOString();
    const base = { docType: 'program', enabled: true, seeded: true, createdAt: stamp, updatedAt: stamp };
    // A catalogue stored before the Regional Lead seed existed: it is inserted on the next read.
    const withoutRl = DEFAULT_PROGRAMS.filter((p) => p.id !== RL).map((p, i) => ({ ...p, ...base, order: i + 1 }));
    let store = memStore({ ambassador: withoutRl });
    let h = createAmbassadorHandlers({ guard: guardAs('super_admin'), store, ...fixed });
    let res = await h.patchProgram(
      makeRequest({ params: { id: MCT }, body: { parentProgramId: 'program-microsoft-mvp' } }),
      context
    );
    expect(res.status).toBe(400);
    expect(parse(res).error).toMatch(/MCT Regional Lead is already additional/);
    // A stored Regional Lead from before it had a parent: backfilled on the same read.
    const rlSeed = DEFAULT_PROGRAMS.find((p) => p.id === RL);
    const storedRl = { ...rlSeed, ...base, order: 11 };
    delete storedRl.parentProgramId;
    store = memStore({ ambassador: [...withoutRl, storedRl] });
    h = createAmbassadorHandlers({ guard: guardAs('super_admin'), store, ...fixed });
    res = await h.patchProgram(
      makeRequest({ params: { id: MCT }, body: { parentProgramId: 'program-microsoft-mvp' } }),
      context
    );
    expect(res.status).toBe(400);
    expect(store.data.get('ambassador').get(MCT).parentProgramId).toBeUndefined();
  });

  it('backfills parentProgramId onto a stored Regional Lead from before it was additional', () => {
    const seed = DEFAULT_PROGRAMS.find((p) => p.id === RL);
    const stored = { ...seed, seeded: true };
    delete stored.parentProgramId;
    expect(seedBackfillFor(stored, seed)).toEqual({ parentProgramId: MCT });
    expect(seedBackfillFor({ ...seed, seeded: true }, seed)).toBeNull();
    expect(seedBackfillFor({ ...stored, parentProgramId: 'program-other' }, seed)).toBeNull();
    // An explicit clear (null) is the owner's edit, not a gap: never refilled.
    expect(seedBackfillFor({ ...stored, parentProgramId: null }, seed)).toBeNull();
  });

  it('a cleared parent stays cleared on the next catalogue read (#881 review)', async () => {
    const { h, store } = await seeded();
    const cleared = await h.patchProgram(
      makeRequest({ params: { id: RL }, body: { parentProgramId: '' } }),
      context
    );
    expect(cleared.status).toBe(200);
    const listed = parse(await h.listPrograms(makeRequest(), context)).items;
    expect(listed.find((p) => p.id === RL).parentProgramId).toBeNull();
    expect(store.data.get('ambassador').get(RL).parentProgramId).toBeNull();
  });

  it('refuses a parent on a program that already has children (#881 review)', async () => {
    const { h, store } = await seeded();
    // Regional Lead is under MCT, so MCT cannot go under the MVP.
    const res = await h.patchProgram(
      makeRequest({ params: { id: MCT }, body: { parentProgramId: 'program-microsoft-mvp' } }),
      context
    );
    expect(res.status).toBe(400);
    expect(parse(res).error).toBe(
      'MCT Regional Lead is already additional to this program; one level only'
    );
    expect(store.data.get('ambassador').get(MCT).parentProgramId).toBeUndefined();
    // Once the child is detached, the same move is allowed.
    await h.patchProgram(makeRequest({ params: { id: RL }, body: { parentProgramId: null } }), context);
    const moved = await h.patchProgram(
      makeRequest({ params: { id: MCT }, body: { parentProgramId: 'program-microsoft-mvp' } }),
      context
    );
    expect(moved.status).toBe(200);
  });
});

describe('membership upkeep, GitKraken and AWS Community Builders (2026-10-11)', () => {
  const GITKRAKEN = 'program-gitkraken-ambassador';
  const seed = DEFAULT_PROGRAMS.find((p) => p.id === GITKRAKEN);
  const { revision, fields: old } = SUPERSEDED_SEED_VALUES[GITKRAKEN];
  /** A GitKraken row as #873 stored it: the first seed, before upkeep existed. */
  const storedFirstSeed = () => {
    const row = { ...seed, ...old, seeded: true, membershipStatus: 'active' };
    delete row.upkeep;
    return row;
  };

  it('seeds GitKraken with the quarterly rule from its check-in: 2 pieces a quarter', () => {
    expect(seed.upkeep).toEqual({
      period: 'quarter',
      minCount: 2,
      evidenceTypes: [],
      note: expect.stringMatching(/contribution tracker, on that quarter’s tab/),
    });
    expect(seed.renewalCadence).toBe('quarterly');
    expect(seed.criteria).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/G2, Capterra and TrustRadius/),
        expect.stringMatching(/Merge Conflicts, Dev AI Use, Commit Graph/),
      ])
    );
    expect(seed.requirements).toEqual([
      expect.objectContaining({ id: 'quarterly-content', minCount: 2, evidenceTypes: [] }),
    ]);
  });

  it('seeds AWS Community Builders from its program page, waitlist and all', () => {
    const builders = DEFAULT_PROGRAMS.find((p) => p.id === 'program-aws-community-builders');
    expect(builders).toMatchObject({
      name: 'AWS Community Builders',
      provider: 'AWS',
      applicationUrl: 'https://builder.aws.com/community/community-builders',
    });
    expect(builders.applicationWindow.note).toMatch(/Waitlist open/);
    expect(builders.applicationQuestions).toBeUndefined();
  });

  // The repository is public; a program's tracker is often private to its members.
  it('seeds no contribution tracker, and no shared-document link anywhere', () => {
    for (const program of DEFAULT_PROGRAMS) expect(program.contributionTrackerUrl).toBeUndefined();
    const source = readFileSync(new URL('./ambassador/programs.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/docs\.google\.com|spreadsheets|sharepoint\.com/i);
  });

  it('brings a never-edited first GitKraken seed up to date, upkeep included, in one patch Cosmos takes', () => {
    const patch = seedBackfillFor(storedFirstSeed(), seed);
    const fields = Object.keys(old);
    expect(Object.keys(patch).sort()).toEqual([...fields, 'seedRevision', 'upkeep'].sort());
    expect(patch.seedRevision).toBe(revision);
    for (const field of fields) expect(patch[field]).toEqual(seed[field]);
    expect(patch.upkeep).toEqual(seed.upkeep);
    // The writer adds updatedAt to the patch; Cosmos takes at most this many operations.
    expect(Object.keys(patch).length + 1).toBeLessThanOrEqual(MAX_PATCH_OPERATIONS);
  });

  it('keeps every field the owner edited, and matches regardless of key order', () => {
    const stored = {
      ...storedFirstSeed(),
      description: 'My own words.',
      requirements: old.requirements.map((r) => Object.fromEntries(Object.entries(r).reverse())),
    };
    const patch = seedBackfillFor(stored, seed);
    expect(patch.description).toBeUndefined();
    expect(patch.requirements).toEqual(seed.requirements);
    expect(patch.criteria).toEqual(seed.criteria);
    // Membership is the owner's fact and never part of a backfill.
    expect(patch.membershipStatus).toBeUndefined();
  });

  it('leaves a current GitKraken seed alone, and never refills a cleared upkeep', () => {
    const current = { ...seed, seeded: true, seedRevision: revision };
    expect(seedBackfillFor(current, seed)).toBeNull();
    expect(seedBackfillFor({ ...current, upkeep: null }, seed)).toBeNull();
  });

  // CodeRabbit on #1077: the correction runs once. An owner who later sets a
  // field back to the first seed's value meant it, and keeps it.
  it('corrects once: after the stamp, a deliberate return to an old value stays', () => {
    const corrected = { ...storedFirstSeed(), ...seedBackfillFor(storedFirstSeed(), seed) };
    expect(corrected.seedRevision).toBe(revision);
    const restored = { ...corrected, renewalCadence: old.renewalCadence };
    expect(seedBackfillFor(restored, seed)).toBeNull();
    // A row whose every superseded field was edited still takes the stamp, once.
    const edited = { ...storedFirstSeed(), upkeep: seed.upkeep };
    for (const field of Object.keys(old)) edited[field] = `mine: ${field}`;
    expect(seedBackfillFor(edited, seed)).toEqual({ seedRevision: revision });
  });

  it('stamps a freshly seeded GitKraken at the current revision', async () => {
    const store = memStore();
    const h = createAmbassadorHandlers({ guard: guardAs('editor'), store, ...fixed });
    await h.listPrograms(makeRequest(), context);
    expect(store.data.get('ambassador').get(GITKRAKEN).seedRevision).toBe(revision);
    // MVP and Docker Captain have revisions of their own since #1302 (a
    // `reach` requirement that counts manual rows); a seed with no history
    // carries no stamp.
    expect(store.data.get('ambassador').get('program-microsoft-mvp').seedRevision).toBe(2);
    expect(store.data.get('ambassador').get('program-docker-captain').seedRevision).toBe(2);
    expect(store.data.get('ambassador').get('program-aws-community-builders').seedRevision).toBeUndefined();
  });

  // #1302: a stored MVP or Docker Captain seed whose requirements are still
  // the first seed's takes revision 2 — `manual` under `reach` — in one
  // patch; the edited case is proven on the MVP earlier in this file.
  it.each(['program-microsoft-mvp', 'program-docker-captain'])(
    'replaces an unedited first-seed requirements list on %s with revision 2',
    (id) => {
      const current = DEFAULT_PROGRAMS.find((p) => p.id === id);
      const { revision: rev, fields: v1 } = SUPERSEDED_SEED_VALUES[id];
      expect(rev).toBe(2);
      expect(Object.keys(v1)).toEqual(['requirements']);
      const patch = seedBackfillFor({ ...current, ...v1, seeded: true }, current);
      expect(patch).toEqual({ requirements: current.requirements, seedRevision: 2 });
      expect(patch.requirements).not.toEqual(v1.requirements);
      expect(patch.requirements.find((r) => r.id === 'reach').evidenceTypes).toContain('manual');
    }
  );

  // The audience rows are manual evidence filed under Docker's `reach`;
  // readiness matches by sourceModule alone, so `labs` must not list
  // `manual` or two audience months would read as hands-on material met.
  it('lists manual evidence under Docker Captain’s reach only, with the first seed’s labs list kept for the compare', () => {
    const docker = DEFAULT_PROGRAMS.find((p) => p.id === 'program-docker-captain');
    const types = Object.fromEntries(docker.requirements.map((r) => [r.id, r.evidenceTypes]));
    expect(types.labs).toEqual(['labs']);
    expect(types.reach).toEqual(['manual']);
    expect(docker.requirements.filter((r) => r.evidenceTypes.includes('manual')).map((r) => r.id)).toEqual(['reach']);
    const v1 = SUPERSEDED_SEED_VALUES['program-docker-captain'].fields.requirements;
    expect(v1.find((r) => r.id === 'labs').evidenceTypes).toEqual(['labs', 'manual']);
    const audience = {
      id: 'e-audience',
      title: 'Audience, September 2026',
      date: '2026-09-30',
      sourceModule: 'manual',
      programIds: ['program-docker-captain'],
    };
    const readiness = computeReadiness(docker, [audience, { ...audience, id: 'e-audience-2', date: '2026-08-31' }]);
    const byId = Object.fromEntries(readiness.requirements.map((r) => [r.id, r]));
    expect(byId.reach.count).toBe(2);
    expect(byId.labs).toMatchObject({ count: 0, met: false });
  });

  it('cleans upkeep and the tracker link, and refuses what is not one', () => {
    const ok = validateProgram(
      {
        upkeep: { period: 'quarter', minCount: '2', evidenceTypes: ['content', 'nope'], note: 'x' },
        contributionTrackerUrl: 'https://example.com/tracker',
      },
      { partial: true }
    );
    expect(ok.value).toEqual({
      upkeep: { period: 'quarter', minCount: 2, evidenceTypes: ['content'], note: 'x' },
      contributionTrackerUrl: 'https://example.com/tracker',
    });
    expect(validateProgram({ upkeep: null }, { partial: true }).value).toEqual({ upkeep: null });
    expect(validateProgram({ upkeep: { period: 'month', minCount: 2 } }, { partial: true }).error).toMatch(
      /upkeep.period must be one of quarter, year/
    );
    expect(validateProgram({ upkeep: { period: 'year', minCount: 0 } }, { partial: true }).error).toMatch(
      /upkeep.minCount must be at least 1/
    );
    expect(
      validateProgram({ contributionTrackerUrl: 'javascript:alert(1)' }, { partial: true }).error
    ).toMatch(/contributionTrackerUrl must be an http\(s\) URL/);
  });
});
