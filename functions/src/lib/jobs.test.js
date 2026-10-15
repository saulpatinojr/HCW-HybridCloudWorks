/**
 * Platform jobs (T-322) — the contract every long handler will sit on.
 * Load-bearing: the type allowlist and payload cap at enqueue, the
 * etag-conditioned claim (at-least-once delivery must not run a job twice),
 * the three terminal outcomes, and that a job-level failure never throws
 * back into the queue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createJobHandlers,
  registerJobType,
  getJobType,
  listJobTypes,
  resetJobTypes,
  publicJob,
  JOB_READ_FLOOR,
  JOBS_CONTAINER,
  TERMINAL_JOB_STATUSES,
} from './jobs.js';
import { AuthoredError } from './http/error-response.js';

const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const USER = { oid: 'u1', email: 'editor@hcw.dev' };
const guardAs = (role) => ({
  requireRole: vi.fn(async () => ({ user: USER, role, error: null })),
});
const denyGuard = {
  requireRole: vi.fn(async () => ({
    user: null,
    role: null,
    error: { status: 403, body: '{}' },
  })),
};

const makeRequest = (body, { method = 'POST', query = {} } = {}) => ({
  method,
  headers: { get: () => 'vitest' },
  query: { get: (k) => query[k] ?? null },
  json: async () => body ?? {},
});

function makeStore(docs = {}) {
  const etags = new Map();
  return {
    docs,
    readDoc: vi.fn(async (_c, id) =>
      docs[id] ? { ...docs[id], _etag: etags.get(id) ?? 'e1' } : null
    ),
    upsertDoc: vi.fn(async (_c, d) => {
      docs[d.id] = { ...d };
      return d;
    }),
    patchDoc: vi.fn(async (_c, id, u) => {
      docs[id] = { ...docs[id], ...u };
      return docs[id];
    }),
    replaceDocIfMatch: vi.fn(async (_c, d) => {
      const { _etag, ...rest } = d;
      docs[d.id] = rest;
      etags.set(d.id, 'e2');
      return rest;
    }),
  };
}

const NOW = new Date('2026-08-21T05:00:00.000Z');
const fixed = { now: () => NOW, uuid: () => 'job-1' };

beforeEach(() => {
  resetJobTypes();
  vi.clearAllMocks();
});

describe('registry', () => {
  it('ships noop and refuses bad registrations', () => {
    expect(getJobType('noop')).toMatchObject({
      type: 'noop',
      role: 'editor',
      maxPayloadBytes: 1024,
    });
    expect(() => registerJobType('Bad Name', { worker: async () => {} })).toThrow(/kebab-case/);
    expect(() => registerJobType('no-worker', {})).toThrow(/worker/);
    expect(() => registerJobType('noop', { worker: async () => {} })).toThrow(/already registered/);
    expect(listJobTypes().map((t) => t.type)).toEqual(['noop']);
  });
});

describe('enqueueJob', () => {
  it('requires the editor role before reading the body', async () => {
    const store = makeStore();
    const h = createJobHandlers({ guard: denyGuard, store, ...fixed });
    const res = await h.enqueueJob(makeRequest({ type: 'noop' }), context, {
      enqueue: vi.fn(),
    });
    expect(res.status).toBe(403);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('rejects unknown types, oversized payloads and a missing queue', async () => {
    const store = makeStore();
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    const enqueue = vi.fn();

    const unknown = await h.enqueueJob(makeRequest({ type: 'forge-article' }), context, {
      enqueue,
    });
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body).error).toContain('noop');

    const big = await h.enqueueJob(
      makeRequest({ type: 'noop', payload: { x: 'y'.repeat(1100) } }),
      context,
      { enqueue }
    );
    expect(big.status).toBe(413);

    const unwired = await h.enqueueJob(makeRequest({ type: 'noop' }), context, {});
    expect(unwired.status).toBe(500);

    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('writes the document, sends the message, answers 202 with a poll hint', async () => {
    const store = makeStore();
    const enqueue = vi.fn();
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    const res = await h.enqueueJob(
      makeRequest({ type: 'noop', payload: { delayMs: 5 } }),
      context,
      { enqueue }
    );
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      jobId: 'job-1',
      type: 'noop',
      status: 'queued',
      poll: 'getJob?jobId=job-1',
    });
    expect(store.upsertDoc).toHaveBeenCalledWith(
      JOBS_CONTAINER,
      expect.objectContaining({
        id: 'job-1',
        type: 'noop',
        status: 'queued',
        attempts: 0,
        requestedBy: USER,
        createdAt: NOW.toISOString(),
      })
    );
    expect(enqueue).toHaveBeenCalledWith({ jobId: 'job-1', type: 'noop' });
  });

  it('merges a type’s acceptedDetails into the 202 body, and the base fields win', async () => {
    // A caller is told what a run is expected to cost at the moment it asks
    // for one (ADR 0029 §2a); the hook cannot masquerade as acceptance.
    registerJobType('priced', {
      worker: async () => 1,
      role: 'editor',
      acceptedDetails: (payload) => ({
        speech: { provider: 'elevenlabs', estimatedCostUsd: payload.n * 0.9 },
        ok: false,
        jobId: 'forged',
      }),
    });
    const h = createJobHandlers({ guard: guardAs('editor'), store: makeStore(), ...fixed });
    const res = await h.enqueueJob(makeRequest({ type: 'priced', payload: { n: 2 } }), context, {
      enqueue: vi.fn(),
    });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      jobId: 'job-1',
      type: 'priced',
      status: 'queued',
      poll: 'getJob?jobId=job-1',
      speech: { provider: 'elevenlabs', estimatedCostUsd: 1.8 },
    });
  });

  it('still enqueues when acceptedDetails throws, and says so', async () => {
    registerJobType('priced-badly', {
      worker: async () => 1,
      role: 'editor',
      acceptedDetails: () => {
        throw new Error('no cost table');
      },
    });
    const store = makeStore();
    const enqueue = vi.fn();
    const warn = vi.fn();
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    const res = await h.enqueueJob(makeRequest({ type: 'priced-badly' }), { ...context, warn }, {
      enqueue,
    });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, jobId: 'job-1' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'enqueueJob: acceptedDetails failed for',
      'priced-badly',
      'no cost table'
    );
  });

  it('answers the base 202 when acceptedDetails returns something JSON cannot carry', async () => {
    // json() runs after the document is written and the message sent; a
    // BigInt or a cycle surfacing there would report 500 for a job that IS
    // queued and invite a duplicate on retry (Copilot review on #447).
    const circular = {};
    circular.self = circular;
    const cases = [
      ['bigint', () => ({ speech: { characters: 9000n } })],
      ['cycle', () => circular],
      // The hook is synchronous by contract; a Promise would otherwise
      // stringify to {} and hide the mistake without a word.
      ['promise', async () => ({ speech: { estimatedCostUsd: 7.2 } })],
      ['array', () => [{ speech: 1 }]],
      ['string', () => 'not an object'],
    ];
    for (const [name, hook] of cases) {
      registerJobType(`unserialisable-${name}`, {
        worker: async () => 1,
        role: 'editor',
        acceptedDetails: hook,
      });
      const store = makeStore();
      const enqueue = vi.fn();
      const warn = vi.fn();
      const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
      const res = await h.enqueueJob(
        makeRequest({ type: `unserialisable-${name}` }),
        { ...context, warn },
        { enqueue }
      );
      expect(res.status, name).toBe(202);
      expect(JSON.parse(res.body), name).toEqual({
        ok: true,
        jobId: 'job-1',
        type: `unserialisable-${name}`,
        status: 'queued',
        poll: 'getJob?jobId=job-1',
      });
      expect(store.upsertDoc, name).toHaveBeenCalledTimes(1);
      expect(enqueue, name).toHaveBeenCalledTimes(1);
      if (name === 'bigint' || name === 'cycle' || name === 'promise') {
        expect(warn, name).toHaveBeenCalledWith(
          'enqueueJob: acceptedDetails failed for',
          `unserialisable-${name}`,
          expect.stringMatching(/BigInt|circular|Promise.*synchronous/i)
        );
      }
    }
  });

  it('enforces a stricter per-type role on top of editor', async () => {
    registerJobType('admin-only', { worker: async () => 1, role: 'super_admin' });
    const guard = {
      requireRole: vi.fn(async (_r, role) =>
        role === 'super_admin' ? { error: { status: 403 } } : { user: USER, role }
      ),
    };
    const h = createJobHandlers({ guard, store: makeStore(), ...fixed });
    const res = await h.enqueueJob(makeRequest({ type: 'admin-only' }), context, {
      enqueue: vi.fn(),
    });
    expect(res.status).toBe(403);
    expect(guard.requireRole).toHaveBeenCalledTimes(2);
  });
});

describe('getJob', () => {
  it('reads by query on GET and by body on POST, hides system fields', async () => {
    const store = makeStore({
      'job-1': {
        id: 'job-1',
        type: 'noop',
        status: 'succeeded',
        _rid: 'r',
        _self: 's',
        _ts: 1,
      },
    });
    const h = createJobHandlers({ guard: guardAs('viewer'), store, ...fixed });

    const byQuery = await h.getJob(
      makeRequest(null, { method: 'GET', query: { jobId: 'job-1' } }),
      context
    );
    expect(byQuery.status).toBe(200);
    expect(JSON.parse(byQuery.body).job).toEqual({
      id: 'job-1',
      type: 'noop',
      status: 'succeeded',
    });

    const byBody = await h.getJob(makeRequest({ jobId: 'job-1' }), context);
    expect(byBody.status).toBe(200);

    const missing = await h.getJob(makeRequest({ jobId: 'nope' }), context);
    expect(missing.status).toBe(404);

    const blank = await h.getJob(makeRequest({}), context);
    expect(blank.status).toBe(400);
  });

  it('publicJob strips every Cosmos system field', () => {
    expect(
      publicJob({
        id: 'a',
        _rid: 1,
        _self: 2,
        _etag: 3,
        _attachments: 4,
        _ts: 5,
        status: 'queued',
      })
    ).toEqual({ id: 'a', status: 'queued' });
  });
});

describe('runJob', () => {
  const queued = () => ({
    id: 'job-1',
    type: 'noop',
    payload: { delayMs: 0 },
    status: 'queued',
    attempts: 0,
  });

  it('claims with the etag, runs the worker, records success', async () => {
    const store = makeStore({ 'job-1': queued() });
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    const out = await h.runJob({ jobId: 'job-1' }, context);
    expect(out).toEqual({ jobId: 'job-1', outcome: 'succeeded' });
    expect(store.replaceDocIfMatch).toHaveBeenCalledWith(
      JOBS_CONTAINER,
      expect.objectContaining({
        id: 'job-1',
        status: 'running',
        attempts: 1,
        _etag: 'e1',
        startedAt: NOW.toISOString(),
      })
    );
    expect(store.docs['job-1']).toMatchObject({
      status: 'succeeded',
      result: { echoed: { delayMs: 0 }, delayedMs: 0 },
      error: null,
    });
    expect(TERMINAL_JOB_STATUSES).toContain(store.docs['job-1'].status);
  });

  it('skips a message whose job is not queued (duplicate delivery) and a lost claim race', async () => {
    const store = makeStore({ 'job-1': { ...queued(), status: 'running' } });
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    expect(await h.runJob({ jobId: 'job-1' }, context)).toEqual({
      jobId: 'job-1',
      outcome: 'skipped',
    });
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();

    const racy = makeStore({ 'job-2': { ...queued(), id: 'job-2' } });
    racy.replaceDocIfMatch.mockRejectedValueOnce(
      Object.assign(new Error('precondition'), { code: 412 })
    );
    const h2 = createJobHandlers({
      guard: guardAs('editor'),
      store: racy,
      ...fixed,
    });
    expect(await h2.runJob({ jobId: 'job-2' }, context)).toEqual({
      jobId: 'job-2',
      outcome: 'skipped',
    });
    expect(racy.patchDoc).not.toHaveBeenCalled();
  });

  it('ignores malformed messages and missing documents without throwing', async () => {
    const store = makeStore();
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    expect(await h.runJob({}, context)).toEqual({
      jobId: null,
      outcome: 'ignored',
    });
    expect(await h.runJob({ jobId: 'ghost' }, context)).toEqual({
      jobId: 'ghost',
      outcome: 'missing',
    });
  });

  it('records a worker failure as failed, in its own words only when authored, and does not throw (#945)', async () => {
    registerJobType('explode', {
      role: 'editor',
      worker: async () => {
        throw Object.assign(new Error('Request rate is large. ActivityId: 9f ' + 'x'.repeat(3000)), {
          code: 429,
        });
      },
    });
    registerJobType('refuse', {
      role: 'editor',
      worker: async () => {
        throw new AuthoredError('The source URL answered 404.', { code: 'SOURCE_GONE' });
      },
    });
    const store = makeStore({
      'job-1': { ...queued(), type: 'explode' },
      'job-2': { ...queued(), id: 'job-2', type: 'refuse' },
    });
    const ctx = { ...context, error: vi.fn(), warn: vi.fn(), invocationId: 'inv-run' };
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    expect(await h.runJob({ jobId: 'job-1' }, ctx)).toEqual({
      jobId: 'job-1',
      outcome: 'failed',
    });
    expect(store.docs['job-1'].status).toBe('failed');
    // getJob serves this field: the store's words never land in it, the
    // code and the log line's correlation id do.
    expect(store.docs['job-1'].error).toBe('The job failed (429; reference inv-run).');
    expect(ctx.error).toHaveBeenCalledWith('[inv-run] runJob: explode failed (name=Error code=429)');
    expect(JSON.stringify(ctx.error.mock.calls)).not.toContain('ActivityId');

    await h.runJob({ jobId: 'job-2' }, ctx);
    expect(store.docs['job-2'].error).toBe('The source URL answered 404.');
  });

  it('records a timeout as timeout', async () => {
    registerJobType('slow', {
      role: 'editor',
      timeoutMs: 10,
      worker: () => new Promise((r) => setTimeout(r, 200)),
    });
    const store = makeStore({ 'job-1': { ...queued(), type: 'slow' } });
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    expect(await h.runJob({ jobId: 'job-1' }, context)).toEqual({
      jobId: 'job-1',
      outcome: 'timeout',
    });
    expect(store.docs['job-1']).toMatchObject({
      status: 'timeout',
      error: expect.stringMatching(/^The job ran out of time \(JOB_TIMEOUT; reference [\w-]+\)\.$/),
    });
  });

  it('fails a job whose type is not registered in this deployment', async () => {
    const store = makeStore({
      'job-1': { ...queued(), type: 'from-the-future' },
    });
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    expect(await h.runJob({ jobId: 'job-1' }, context)).toEqual({
      jobId: 'job-1',
      outcome: 'failed',
    });
    expect(store.docs['job-1'].error).toContain('not registered');
  });

  it('invokes onComplete after the terminal write, success and failure alike (T-607)', async () => {
    const seen = [];
    registerJobType('hooked-ok', {
      role: 'editor',
      worker: async () => ({ done: true }),
      onComplete: async ({ status, result, error }) => seen.push({ status, result, error }),
    });
    registerJobType('hooked-bad', {
      role: 'editor',
      worker: async () => {
        throw new Error('nope');
      },
      onComplete: async ({ status, error }) => seen.push({ status, error }),
    });
    const store = makeStore({
      'job-1': { ...queued(), type: 'hooked-ok' },
      'job-2': { ...queued(), id: 'job-2', type: 'hooked-bad' },
    });
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    await h.runJob({ jobId: 'job-1' }, context);
    await h.runJob({ jobId: 'job-2' }, context);
    expect(seen).toEqual([
      { status: 'succeeded', result: { done: true }, error: null },
      // The hook gets what the document stores, never the raw message (#945).
      { status: 'failed', error: expect.stringMatching(/^The job failed \(Error; reference [\w-]+\)\.$/) },
    ]);
    // The terminal status was already persisted when each hook ran.
    expect(store.docs['job-1'].status).toBe('succeeded');
    expect(store.docs['job-2'].status).toBe('failed');
  });

  it('a throwing onComplete is logged and never changes the job outcome', async () => {
    registerJobType('hook-explodes', {
      role: 'editor',
      worker: async () => 'fine',
      onComplete: async () => {
        throw new Error('hook boom');
      },
    });
    const store = makeStore({ 'job-1': { ...queued(), type: 'hook-explodes' } });
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    expect(await h.runJob({ jobId: 'job-1' }, context)).toEqual({
      jobId: 'job-1',
      outcome: 'succeeded',
    });
    expect(store.docs['job-1'].status).toBe('succeeded');
    expect(context.warn).toHaveBeenCalledWith(expect.stringContaining('hook boom'));
  });

  it('passes AbortSignal to worker and aborts signal on timeout (AP-B7)', async () => {
    let capturedSignal = null;
    let abortedAtWorker = false;
    registerJobType('abortable-job', {
      role: 'editor',
      timeoutMs: 50,
      worker: async (_payload, { signal }) => {
        capturedSignal = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortedAtWorker = true;
            reject(new Error('aborted'));
          });
        });
      },
    });
    const store = makeStore({ 'job-abort': { ...queued(), id: 'job-abort', type: 'abortable-job' } });
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    const outcome = await h.runJob({ jobId: 'job-abort' }, context);
    expect(outcome.outcome).toBe('timeout');
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal.aborted).toBe(true);
    expect(abortedAtWorker).toBe(true);
    expect(store.docs['job-abort'].status).toBe('timeout');
  });

  it('disarms the deadline once the worker settles, so a slow terminal write does not fire the signal (#942)', async () => {
    let capturedSignal = null;
    let abortedAtHook = null;
    registerJobType('near-deadline', {
      role: 'editor',
      timeoutMs: 30,
      // Done just inside the budget.
      worker: async (_payload, { signal }) => {
        capturedSignal = signal;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { done: true };
      },
      onComplete: async () => {
        abortedAtHook = capturedSignal.aborted;
      },
    });
    const store = makeStore({ 'job-near': { ...queued(), id: 'job-near', type: 'near-deadline' } });
    const patch = store.patchDoc.getMockImplementation();
    // The terminal write outlasts what was left of the budget.
    store.patchDoc.mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return patch(...args);
    });
    const h = createJobHandlers({ guard: guardAs('editor'), store, ...fixed });
    expect(await h.runJob({ jobId: 'job-near' }, context)).toEqual({
      jobId: 'job-near',
      outcome: 'succeeded',
    });
    expect(store.docs['job-near'].status).toBe('succeeded');
    expect(abortedAtHook).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(capturedSignal.aborted).toBe(false);
  });

  it('noop ends its delay when the job’s signal fires, not when the delay does (#942 follow-up)', async () => {
    const job = new AbortController();
    const started = Date.now();
    const run = getJobType('noop').worker({ delayMs: 20_000 }, { signal: job.signal });
    job.abort(Object.assign(new Error('job timed out'), { code: 'JOB_TIMEOUT' }));
    await expect(run).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1000);
    // Without a signal the delay is the delay, as before.
    await expect(getJobType('noop').worker({ delayMs: 1 }, {})).resolves.toMatchObject({ delayedMs: 1 });
  });
});

describe('getJob role gating and email redaction (AP-B10)', () => {
  it('gates job inspection on stricter role requirement and returns 403 for unauthorized viewer', async () => {
    registerJobType('super-job', { worker: async () => 1, role: 'super_admin' });
    const store = makeStore({
      'job-super': {
        id: 'job-super',
        type: 'super-job',
        status: 'succeeded',
      },
    });
    const guard = {
      requireRole: vi.fn(async (_r, role) =>
        role === 'super_admin'
          ? { error: { status: 403, body: JSON.stringify({ error: 'Forbidden' }) } }
          : { user: USER, role: 'viewer', error: null }
      ),
    };
    const h = createJobHandlers({ guard, store, ...fixed });
    const res = await h.getJob(
      makeRequest(null, { method: 'GET', query: { jobId: 'job-super' } }),
      context
    );
    expect(res.status).toBe(403);
    expect(guard.requireRole).toHaveBeenCalledWith(expect.anything(), 'viewer');
    expect(guard.requireRole).toHaveBeenCalledWith(expect.anything(), 'super_admin');
  });

  it('gates editor-tier jobs so a viewer receives 403', async () => {
    registerJobType('editor-job', { worker: async () => 1, role: 'editor' });
    const store = makeStore({
      'job-editor': {
        id: 'job-editor',
        type: 'editor-job',
        status: 'succeeded',
      },
    });
    const guard = {
      requireRole: vi.fn(async (_r, role) =>
        role === 'editor'
          ? { error: { status: 403, body: JSON.stringify({ error: 'Forbidden' }) } }
          : { user: USER, role: 'viewer', error: null }
      ),
    };
    const h = createJobHandlers({ guard, store, ...fixed });
    const res = await h.getJob(
      makeRequest(null, { method: 'GET', query: { jobId: 'job-editor' } }),
      context
    );
    expect(res.status).toBe(403);
    expect(guard.requireRole).toHaveBeenCalledWith(expect.anything(), 'viewer');
    expect(guard.requireRole).toHaveBeenCalledWith(expect.anything(), 'editor');
  });

  it('holds a job whose type is no longer registered at the enqueue floor, so a viewer gets 403 (#945)', async () => {
    const store = makeStore({
      'job-gone': { id: 'job-gone', type: 'retired-type', status: 'succeeded', result: { sourceUrl: 'x' } },
    });
    // A guard that lets a viewer through the first gate and refuses anything stricter.
    const viewerOnly = {
      requireRole: vi.fn(async (_r, role) =>
        role === 'viewer'
          ? { user: USER, role: 'viewer', error: null }
          : { error: { status: 403, body: JSON.stringify({ error: 'Forbidden' }) } }
      ),
    };
    const refused = await createJobHandlers({ guard: viewerOnly, store, ...fixed }).getJob(
      makeRequest(null, { method: 'GET', query: { jobId: 'job-gone' } }),
      context
    );
    expect(JOB_READ_FLOOR).toBe('editor');
    expect(refused.status).toBe(403);
    expect(viewerOnly.requireRole).toHaveBeenCalledWith(expect.anything(), 'editor');
    expect(refused.body).not.toContain('sourceUrl');

    const editor = await createJobHandlers({ guard: guardAs('editor'), store, ...fixed }).getJob(
      makeRequest(null, { method: 'GET', query: { jobId: 'job-gone' } }),
      context
    );
    expect(editor.status).toBe(200);
  });

  it('answers a failed read with the safe sentence and a correlation id, never the store text (#945)', async () => {
    const store = makeStore({});
    store.readDoc.mockRejectedValueOnce(new Error('Request rate is large. ActivityId: 9f'));
    const ctx = { ...context, error: vi.fn(), invocationId: 'inv-job' };
    const res = await createJobHandlers({ guard: guardAs('viewer'), store, ...fixed }).getJob(
      makeRequest(null, { method: 'GET', query: { jobId: 'job-1' } }),
      ctx
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'Failed to read job', correlationId: 'inv-job' });
    expect(JSON.stringify(ctx.error.mock.calls)).not.toContain('ActivityId');
  });

  it('redacts requestedBy email in publicJob', () => {
    const job = publicJob({
      id: 'job-1',
      type: 'noop',
      requestedBy: { oid: 'u1', email: 'editor@hcw.dev' },
      status: 'queued',
    });
    expect(job.requestedBy.oid).toBe('u1');
    expect(job.requestedBy.email).toBe('e***@hcw.dev');
    expect(job.requestedBy.email).not.toBe('editor@hcw.dev');
  });
});

