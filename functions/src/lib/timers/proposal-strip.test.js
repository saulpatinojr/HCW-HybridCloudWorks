/**
 * The yearly clean-up of talk proposals that were not accepted (#1777): a dry
 * run until armed, the calendar-year cycle with January as grace, accepted
 * proposals untouched, a lost race handled, a second run that finds nothing,
 * and nothing that names a person in the log or the audit row.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AUDIT_ACTION,
  CALL_PAGE_SIZE,
  MAX_STRIPS_PER_RUN,
  STRIP_SETTING,
  createProposalStrip,
  dueProposalsQuery,
  runDailyRetirement,
} from './proposal-strip.js';

const ARMED = { [STRIP_SETTING]: 'true' };
const FEB_1_2027 = new Date('2027-02-01T04:00:00.000Z');
const JAN_31_2027 = new Date('2027-01-31T04:00:00.000Z');

const call = (eventId, fields = {}) => ({
  id: `cfs-call:${eventId}`,
  eventId,
  docType: 'cfs-call',
  status: 'closed',
  closedAt: '2026-11-30T00:00:00.000Z',
  closesAt: null,
  ...fields,
});

let seq = 0;
const proposal = (eventId, fields = {}) => ({
  id: `p-${(seq += 1)}`,
  eventId,
  docType: 'cfs-submission',
  status: 'pending',
  speakerName: 'Sam Speaker',
  speakerEmail: 'sam@example.com',
  speakerBio: 'Talks about clouds.',
  title: 'A talk',
  abstract: 'What it is about.',
  format: 'talk',
  level: 'beginner',
  submittedAt: '2026-06-01T00:00:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  reviewNote: 'A note about the speaker.',
  ...fields,
});

/**
 * An in-memory `developer_events` container that answers the job's two
 * queries the way the database would: the calls a page at a time, and one
 * event's proposals that are not accepted, not stripped and (when asked)
 * sent before a date, cut at the query's TOP.
 */
function memStore(docs) {
  const rows = new Map();
  let version = 0;
  const put = (doc) => rows.set(doc.id, { ...structuredClone(doc), _etag: `"v${(version += 1)}"` });
  docs.forEach(put);
  const audits = [];
  const store = {
    rows,
    audits,
    put,
    get: (id) => structuredClone(rows.get(id)),
    proposals: () => [...rows.values()].filter((d) => d.docType === 'cfs-submission').map((d) => structuredClone(d)),
    queryDocsPage: vi.fn(async (_container, _query, _params, options = {}) => {
      const calls = [...rows.values()].filter((d) => d.docType === 'cfs-call');
      const skip = options.continuationToken ? Number(options.continuationToken) : 0;
      const size = options.maxItemCount;
      const more = skip + size < calls.length;
      return { resources: calls.slice(skip, skip + size).map((d) => structuredClone(d)), continuationToken: more ? String(skip + size) : null };
    }),
    queryDocs: vi.fn(async (_container, query, parameters, options = {}) => {
      const param = (name) => parameters.find((p) => p.name === name)?.value;
      const top = Number(/SELECT TOP (\d+)/.exec(query)[1]);
      expect(options.partitionKey).toBe(param('@eventId'));
      return [...rows.values()]
        .filter((d) => d.docType === 'cfs-submission' && d.eventId === param('@eventId'))
        .filter((d) => d.status !== 'accepted' && !d.strippedAt)
        .filter((d) => !param('@sentBefore') || d.submittedAt < param('@sentBefore'))
        .slice(0, top)
        .map(({ id, eventId, docType, status, submittedAt, strippedAt }) => ({ id, eventId, docType, status, submittedAt, strippedAt }));
    }),
    readDoc: vi.fn(async (_container, id) => (rows.has(id) ? structuredClone(rows.get(id)) : null)),
    replaceDocIfMatch: vi.fn(async (_container, doc) => {
      const current = rows.get(doc.id);
      if (!current) throw Object.assign(new Error('gone'), { code: 404 });
      if (current._etag !== doc._etag) throw Object.assign(new Error('stale'), { code: 412 });
      put(doc);
      return rows.get(doc.id);
    }),
    upsertDoc: vi.fn(async (container, doc) => {
      audits.push([container, doc]);
      return doc;
    }),
  };
  return store;
}

function harness(docs, { now = FEB_1_2027, env = ARMED } = {}) {
  const store = memStore(docs);
  const lines = [];
  const log = { log: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) };
  const job = createProposalStrip({ store, now: () => now, env, log, uuid: () => 'audit-1' });
  return { store, lines, job };
}

const PERSONAL = ['Sam Speaker', 'sam@example.com', 'Talks about clouds', 'A note about the speaker'];

describe('the dry run (the way it ships)', () => {
  it('counts what it would strip, changes nothing, and writes one summary line and one audit row', async () => {
    const docs = [call('ev'), proposal('ev'), proposal('ev', { status: 'rejected' }), proposal('ev', { status: 'accepted' })];
    for (const env of [{}, { [STRIP_SETTING]: 'false' }, { [STRIP_SETTING]: 'TRUE' }, { [STRIP_SETTING]: '1' }]) {
      const { store, lines, job } = harness(docs, { env });
      const summary = await job.run();
      expect(summary).toMatchObject({ dryRun: true, eligibleCount: 2, strippedCount: 0, cycleYear: 2026, callsExamined: 1 });
      expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
      expect(store.readDoc).not.toHaveBeenCalled();
      expect(store.proposals().every((p) => p.speakerEmail === 'sam@example.com')).toBe(true);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('dry-run: would strip 2');
      expect(store.audits).toHaveLength(1);
      expect(store.audits[0][0]).toBe('admin_audit_logs');
      expect(store.audits[0][1]).toMatchObject({ action: AUDIT_ACTION, actor: 'system', details: { dryRun: true, eligibleCount: 2 } });
    }
  });

  it('writes its line and its row on an idle run too', async () => {
    const { store, lines, job } = harness([], { env: {} });
    expect(await job.run()).toMatchObject({ dryRun: true, eligibleCount: 0, callsExamined: 0, hasMore: false });
    expect(lines).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
  });
});

describe('armed', () => {
  it('strips what was not accepted, leaves accepted proposals whole, and marks each so it is never done twice', async () => {
    const accepted = proposal('ev', { status: 'accepted' });
    const pending = proposal('ev');
    const rejected = proposal('ev', { status: 'rejected', reviewedAt: '2026-07-01T00:00:00.000Z', reviewedBy: 'key-1' });
    const { store, job } = harness([call('ev'), accepted, pending, rejected]);

    expect(await job.run()).toMatchObject({ dryRun: false, eligibleCount: 2, strippedCount: 2, skippedCount: 0, racedCount: 0, failedCount: 0, hasMore: false });

    for (const id of [pending.id, rejected.id]) {
      const after = store.get(id);
      for (const field of ['speakerName', 'speakerEmail', 'speakerBio', 'reviewNote']) expect(after).not.toHaveProperty(field);
      expect(after).toMatchObject({ title: 'A talk', abstract: 'What it is about.', format: 'talk', level: 'beginner', strippedAt: FEB_1_2027.toISOString(), strippedReason: 'cycle_ended' });
    }
    expect(store.get(rejected.id)).toMatchObject({ status: 'rejected', reviewedAt: '2026-07-01T00:00:00.000Z', reviewedBy: 'key-1' });
    const { _etag, ...kept } = store.get(accepted.id);
    expect(kept).toEqual(accepted);

    // The second run finds nothing left to do.
    store.replaceDocIfMatch.mockClear();
    expect(await job.run()).toMatchObject({ eligibleCount: 0, strippedCount: 0 });
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('waits through January and starts on 1 February', async () => {
    const docs = [call('ev', { closedAt: '2026-12-31T23:59:59.000Z' }), proposal('ev')];
    for (const now of [new Date('2026-12-31T23:59:59Z'), new Date('2027-01-01T00:00:00Z'), JAN_31_2027, new Date('2027-01-31T23:59:59.999Z')]) {
      const { store, job } = harness(docs, { now });
      expect(await job.run(), now.toISOString()).toMatchObject({ eligibleCount: 0, strippedCount: 0 });
      expect(store.queryDocs).not.toHaveBeenCalled();
    }
    const { job } = harness(docs, { now: new Date('2027-02-01T00:00:00.000Z') });
    expect(await job.run()).toMatchObject({ eligibleCount: 1, strippedCount: 1 });
  });

  it('puts a call closed one minute into the new year in the new year', async () => {
    const { job } = harness([call('ev', { closedAt: '2027-01-01T00:00:00.000Z' }), proposal('ev', { submittedAt: '2026-12-30T00:00:00.000Z' })]);
    expect(await job.run()).toMatchObject({ eligibleCount: 0 });
    const next = harness([call('ev', { closedAt: '2027-01-01T00:00:00.000Z' }), proposal('ev')], { now: new Date('2028-02-01T00:00:00Z') });
    expect(await next.job.run()).toMatchObject({ strippedCount: 1, cycleYear: 2027 });
  });

  it('goes by a passed deadline when the organizer never pressed close', async () => {
    const { job } = harness([call('ev', { status: 'open', closedAt: null, closesAt: '2026-09-01T00:00:00.000Z' }), proposal('ev')]);
    expect(await job.run()).toMatchObject({ strippedCount: 1 });
  });

  it('goes by the year each proposal was sent in when the call never closed', async () => {
    const old = proposal('ev', { submittedAt: '2026-12-31T23:59:59.000Z' });
    const recent = proposal('ev', { submittedAt: '2027-01-01T00:00:00.000Z' });
    const { store, job } = harness([call('ev', { status: 'open', closedAt: null, closesAt: null }), old, recent]);
    expect(await job.run()).toMatchObject({ eligibleCount: 1, strippedCount: 1 });
    expect(store.get(old.id).strippedAt).toBeTruthy();
    expect(store.get(recent.id).speakerEmail).toBe('sam@example.com');
    const [, query, parameters] = store.queryDocs.mock.calls[0];
    expect(query).toContain('c.submittedAt < @sentBefore');
    expect(parameters).toContainEqual({ name: '@sentBefore', value: '2027-01-01T00:00:00.000Z' });
  });

  it('skips a call that closed in a year that is not over, without reading its proposals', async () => {
    const { store, job } = harness([call('later', { closedAt: '2027-01-15T00:00:00.000Z' }), proposal('later', { submittedAt: '2026-03-01T00:00:00.000Z' })]);
    expect(await job.run()).toMatchObject({ callsExamined: 1, eligibleCount: 0 });
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('ignores a call record with no event id', async () => {
    const { job } = harness([{ id: 'cfs-call:x', docType: 'cfs-call', status: 'closed', closedAt: '2026-01-01T00:00:00Z' }]);
    expect(await job.run()).toMatchObject({ callsExamined: 0, eligibleCount: 0 });
  });
});

describe('a proposal that changes while the job runs', () => {
  it('reads again after a 412 and leaves a proposal that was accepted meanwhile untouched', async () => {
    const target = proposal('ev');
    const { store, job } = harness([call('ev'), target]);
    const realRead = store.readDoc.getMockImplementation();
    let reads = 0;
    store.readDoc.mockImplementation(async (...args) => {
      const doc = await realRead(...args);
      reads += 1;
      // The organizer accepts it between the job's first read and its write.
      if (reads === 1) store.put({ ...store.get(target.id), status: 'accepted' });
      return doc;
    });
    expect(await job.run()).toMatchObject({ eligibleCount: 1, strippedCount: 0, skippedCount: 1, racedCount: 0 });
    expect(store.get(target.id)).toMatchObject({ status: 'accepted', speakerEmail: 'sam@example.com', reviewNote: 'A note about the speaker.' });
    expect(store.get(target.id)).not.toHaveProperty('strippedAt');
  });

  it('strips the newer version after one lost race when it is still not accepted', async () => {
    const target = proposal('ev');
    const { store, job } = harness([call('ev'), target]);
    const realRead = store.readDoc.getMockImplementation();
    let reads = 0;
    store.readDoc.mockImplementation(async (...args) => {
      const doc = await realRead(...args);
      reads += 1;
      if (reads === 1) store.put({ ...store.get(target.id), status: 'rejected', reviewNote: 'A newer note.' });
      return doc;
    });
    expect(await job.run()).toMatchObject({ strippedCount: 1, racedCount: 0 });
    expect(store.get(target.id)).toMatchObject({ status: 'rejected', strippedReason: 'cycle_ended' });
    expect(store.get(target.id)).not.toHaveProperty('reviewNote');
  });

  it('leaves it for the next run after a second lost race, and says there is more to do', async () => {
    const target = proposal('ev');
    const { store, job } = harness([call('ev'), target]);
    store.replaceDocIfMatch.mockImplementation(async () => {
      throw Object.assign(new Error('stale'), { code: 412 });
    });
    expect(await job.run()).toMatchObject({ strippedCount: 0, racedCount: 1, hasMore: true });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    expect(store.get(target.id).speakerEmail).toBe('sam@example.com');
  });

  it('skips a proposal deleted before the read or before the write', async () => {
    const first = proposal('ev');
    const second = proposal('ev');
    const { store, job } = harness([call('ev'), first, second]);
    store.readDoc.mockImplementationOnce(async () => null);
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      throw Object.assign(new Error('gone'), { code: 404 });
    });
    expect(await job.run()).toMatchObject({ eligibleCount: 2, strippedCount: 0, skippedCount: 2, failedCount: 0 });
  });

  it('counts a write that fails for another reason, carries on, and logs no error text', async () => {
    const first = proposal('ev');
    const second = proposal('ev');
    const { store, lines, job } = harness([call('ev'), first, second]);
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      throw Object.assign(new Error('sam@example.com could not be written'), { code: 503 });
    });
    expect(await job.run()).toMatchObject({ strippedCount: 1, failedCount: 1, hasMore: true });
    expect(lines.join('\n')).not.toContain('sam@example.com');
  });
});

describe('bounds', () => {
  it('stops at the per-run limit and says there is more', async () => {
    const docs = [call('big'), call('next')];
    for (let i = 0; i < MAX_STRIPS_PER_RUN + 3; i += 1) docs.push(proposal('big'));
    docs.push(proposal('next'));
    const { store, job } = harness(docs);
    expect(await job.run()).toMatchObject({ strippedCount: MAX_STRIPS_PER_RUN, hasMore: true });
    // The next day's run finishes the work.
    expect(await job.run()).toMatchObject({ strippedCount: 4, hasMore: false });
    expect(store.proposals().every((p) => p.strippedAt)).toBe(true);
  });

  it('reads every page of calls', async () => {
    const docs = [];
    for (let i = 0; i < CALL_PAGE_SIZE + 1; i += 1) docs.push(call(`ev-${i}`));
    docs.push(proposal(`ev-${CALL_PAGE_SIZE}`));
    const { store, job } = harness(docs);
    expect(await job.run()).toMatchObject({ callsExamined: CALL_PAGE_SIZE + 1, strippedCount: 1, hasMore: false });
    expect(store.queryDocsPage).toHaveBeenCalledTimes(2);
  });
});

describe('what is recorded', () => {
  it('keeps every id, name and address out of the log lines and the audit row', async () => {
    const target = proposal('ev-secret-name');
    const { store, lines, job } = harness([call('ev-secret-name'), target, proposal('ev-secret-name', { status: 'accepted' })]);
    await job.run();
    const recorded = `${lines.join('\n')}\n${JSON.stringify(store.audits)}`;
    for (const text of [...PERSONAL, target.id, 'ev-secret-name']) expect(recorded, text).not.toContain(text);
    expect(Object.keys(store.audits[0][1].details).sort()).toEqual(
      ['callsExamined', 'cycleYear', 'dryRun', 'eligibleCount', 'failedCount', 'hasMore', 'racedCount', 'skippedCount', 'strippedCount'].sort(),
    );
  });

  it('asks the database only for rows that are not accepted and not stripped', () => {
    const query = dueProposalsQuery({ limit: 7 });
    expect(query).toContain('SELECT TOP 7 ');
    expect(query).toContain("(NOT IS_DEFINED(c.status) OR c.status != 'accepted')");
    expect(query).toContain('(NOT IS_DEFINED(c.strippedAt) OR IS_NULL(c.strippedAt))');
    expect(query).not.toContain('@sentBefore');
    expect(query).not.toMatch(/speaker|reviewNote/);
  });
});

describe('runDailyRetirement', () => {
  it('runs both steps in order and answers both summaries', async () => {
    const order = [];
    const result = await runDailyRetirement({
      rejected: async () => (order.push('rejected'), { softDeletedCount: 1 }),
      proposals: async () => (order.push('proposals'), { eligibleCount: 2 }),
    });
    expect(order).toEqual(['rejected', 'proposals']);
    expect(result).toEqual({ softDeletedCount: 1, proposals: { eligibleCount: 2 } });
  });

  it('still runs the second step when the first fails, then throws the first failure', async () => {
    const proposals = vi.fn(async () => ({}));
    const boom = new Error('first');
    await expect(runDailyRetirement({ rejected: async () => Promise.reject(boom), proposals })).rejects.toBe(boom);
    expect(proposals).toHaveBeenCalledTimes(1);
  });

  it('throws the second step’s failure when only it fails', async () => {
    const boom = new Error('second');
    await expect(runDailyRetirement({ rejected: async () => ({}), proposals: async () => Promise.reject(boom) })).rejects.toBe(boom);
  });
});
