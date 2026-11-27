/**
 * The Health Hub's stored results (#1011): who may read and write them, what
 * a write must carry, and what happens when two writers meet.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MAX_SUMMARY_LENGTH,
  PROBE_RESULTS_CONTAINER,
  PULSE_DOC_ID,
  createProbeResultHandlers,
  nextResultDoc,
  parseResultWrite,
  presentPulse,
  presentResult,
  recordProbeResult,
  resultDocId,
} from './probe-results.js';
import { HEALTH_PROBES, HEALTH_PROBE_IDS } from './probe-catalogue.js';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const context = { error: vi.fn() };

/** An admin_config container in memory, with ETags that move on every write. */
function memStore(docs = []) {
  const data = new Map(docs.map((doc) => [doc.id, { _etag: 'e0', ...doc }]));
  let etag = 0;
  const stamp = (doc) => ({ ...doc, _etag: `e${(etag += 1)}` });
  return {
    data,
    readDoc: vi.fn(async (_c, id) => (data.has(id) ? { ...data.get(id) } : null)),
    createDoc: vi.fn(async (_c, doc) => {
      if (data.has(doc.id)) throw Object.assign(new Error('exists'), { code: 409 });
      data.set(doc.id, stamp(doc));
      return data.get(doc.id);
    }),
    replaceDocIfMatch: vi.fn(async (_c, doc) => {
      if (data.get(doc.id)?._etag !== doc._etag) {
        throw Object.assign(new Error('changed'), { code: 412 });
      }
      data.set(doc.id, stamp(doc));
      return data.get(doc.id);
    }),
    queryDocs: vi.fn(async () => [...data.values()].filter((doc) => doc.docType === 'health_probe_result')),
  };
}

/** A guard that admits `role` (or refuses with `error`). */
const guardAs = (role, user = { email: 'owner@hcw.example', oid: 'oid-1' }) => ({
  requireRole: vi.fn(async (_request, required) => {
    const levels = { viewer: 1, editor: 2, publisher: 3, super_admin: 4 };
    if (!role || levels[role] < levels[required]) {
      return { user: null, role: null, error: { status: 403, body: '{"error":"Forbidden"}' } };
    }
    return { user, role, error: null };
  }),
});

const request = (body) => ({ json: async () => body });
const bodyOf = (res) => JSON.parse(res.body);
const noSleep = async () => {};

const handlers = (store, role = 'editor') =>
  createProbeResultHandlers({ guard: guardAs(role), store, now: () => NOW, sleep: noSleep });

describe('the probe catalogue', () => {
  it('names each probe once, with a known kind and a real role', () => {
    expect(new Set(HEALTH_PROBE_IDS).size).toBe(HEALTH_PROBE_IDS.length);
    for (const [id, entry] of Object.entries(HEALTH_PROBES)) {
      expect(['live', 'snapshot', 'session'], id).toContain(entry.kind);
      expect(['viewer', 'editor'], id).toContain(entry.writeRole);
    }
  });
});

describe('parseResultWrite', () => {
  it('accepts a known probe in the shared words, and the old words for them', () => {
    expect(parseResultWrite({ probeId: 'publer', status: 'critical', summary: 'Refused.' })).toMatchObject(
      { probeId: 'publer', kind: 'live', writeRole: 'editor', status: 'critical' }
    );
    // A browser still holding the words used until 2026-10-08.
    expect(parseResultWrite({ probeId: 'publer', status: 'unavailable', summary: 'x' }).status).toBe(
      'offline'
    );
    expect(parseResultWrite({ probeId: 'resend', status: 'misconfigured', summary: 'x' }).status).toBe(
      'critical'
    );
  });

  it('refuses an unknown probe, an unknown status, an empty summary and a silly duration', () => {
    expect(parseResultWrite({ probeId: 'nope', status: 'healthy', summary: 'x' }).problem).toMatch(/probeId/);
    expect(parseResultWrite({ probeId: '__proto__', status: 'healthy', summary: 'x' }).problem).toMatch(
      /probeId/
    );
    expect(parseResultWrite({ probeId: 'publer', status: 'fine', summary: 'x' }).problem).toMatch(/status/);
    expect(parseResultWrite({ probeId: 'publer', status: 'healthy', summary: '  ' }).problem).toMatch(
      /summary/
    );
    expect(
      parseResultWrite({ probeId: 'publer', status: 'healthy', summary: 'x', durationMs: -1 }).problem
    ).toMatch(/durationMs/);
    expect(parseResultWrite(null).problem).toMatch(/probeId/);
  });

  it('caps the summary and the detail, and takes the kind from the catalogue, not the body', () => {
    const parsed = parseResultWrite({
      probeId: 'cosmos',
      kind: 'live',
      status: 'healthy',
      summary: 'x'.repeat(MAX_SUMMARY_LENGTH + 50),
      detail: 'y'.repeat(5000),
    });
    expect(parsed.kind).toBe('snapshot');
    expect(parsed.summary).toHaveLength(MAX_SUMMARY_LENGTH);
    expect(parsed.detail).toHaveLength(2000);
  });
});

describe('transitions', () => {
  const entry = (status, checkedAt) => ({
    probeId: 'publer',
    kind: 'live',
    status,
    summary: status,
    checkedAt,
    checkedBy: 'admin',
  });

  it('starts statusSince at the first result and moves it only when the status changes', () => {
    const first = nextResultDoc(null, entry('healthy', '2026-10-08T10:00:00.000Z'));
    expect(first).toMatchObject({ statusSince: '2026-10-08T10:00:00.000Z', previousStatus: null });

    const same = nextResultDoc(first, entry('healthy', '2026-10-08T11:00:00.000Z'));
    expect(same).toMatchObject({ statusSince: '2026-10-08T10:00:00.000Z', previousStatus: null });

    const changed = nextResultDoc(same, entry('critical', '2026-10-08T11:30:00.000Z'));
    expect(changed).toMatchObject({ statusSince: '2026-10-08T11:30:00.000Z', previousStatus: 'healthy' });
  });
});

describe('recordProbeResult', () => {
  const entry = {
    probeId: 'publer',
    kind: 'live',
    status: 'healthy',
    summary: 'Connected.',
    checkedAt: NOW.toISOString(),
    checkedBy: 'admin',
  };

  it('creates the first result and replaces later ones under their ETag', async () => {
    const store = memStore();
    await recordProbeResult(store, entry, { sleep: noSleep });
    expect(store.createDoc).toHaveBeenCalledTimes(1);
    await recordProbeResult(
      store,
      { ...entry, status: 'critical', checkedAt: '2026-10-08T12:05:00.000Z' },
      { sleep: noSleep }
    );
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
    expect(store.data.get(resultDocId('publer'))).toMatchObject({
      status: 'critical',
      previousStatus: 'healthy',
      configScope: 'admin_config',
      docType: 'health_probe_result',
    });
  });

  it('reads again and decides again when another writer got there first', async () => {
    const store = memStore([
      { id: resultDocId('publer'), probeId: 'publer', status: 'healthy', checkedAt: '2026-10-08T11:00:00.000Z' },
    ]);
    // The pulse lands between this write's read and its replace.
    const realRead = store.readDoc.getMockImplementation();
    let raced = false;
    store.readDoc.mockImplementation(async (c, id) => {
      const doc = await realRead(c, id);
      if (!raced) {
        raced = true;
        store.data.set(id, { ...doc, status: 'degraded', checkedAt: '2026-10-08T11:30:00.000Z', _etag: 'moved' });
      }
      return doc;
    });
    const { written } = await recordProbeResult(store, { ...entry, status: 'critical' }, { sleep: noSleep });
    expect(written).toBe(true);
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    // Decided against what the other writer left, not against the first read.
    expect(store.data.get(resultDocId('publer'))).toMatchObject({
      status: 'critical',
      previousStatus: 'degraded',
    });
  });

  it('treats a 409 on the first write as a race, and keeps a newer stored result', async () => {
    const store = memStore();
    store.createDoc.mockImplementationOnce(async (_c, doc) => {
      store.data.set(doc.id, { ...doc, checkedAt: '2026-10-08T12:10:00.000Z', _etag: 'other' });
      throw Object.assign(new Error('exists'), { code: 409 });
    });
    const { written, doc } = await recordProbeResult(store, entry, { sleep: noSleep });
    expect(written).toBe(false);
    expect(doc.checkedAt).toBe('2026-10-08T12:10:00.000Z');
  });

  it('gives up with CONFLICT after every attempt loses, and rethrows anything else', async () => {
    const store = memStore([{ id: resultDocId('publer'), probeId: 'publer', status: 'healthy' }]);
    store.replaceDocIfMatch.mockRejectedValue(Object.assign(new Error('changed'), { code: 412 }));
    await expect(recordProbeResult(store, entry, { attempts: 3, sleep: noSleep })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(3);

    store.replaceDocIfMatch.mockRejectedValue(Object.assign(new Error('boom'), { code: 500 }));
    await expect(recordProbeResult(store, entry, { sleep: noSleep })).rejects.toThrow('boom');
  });
});

describe('GET cms/health/probe-results', () => {
  it('needs only viewer, and answers each known probe and the pulse, field by field', async () => {
    const store = memStore([
      {
        id: resultDocId('cosmos'),
        docType: 'health_probe_result',
        probeId: 'cosmos',
        kind: 'snapshot',
        status: 'unavailable',
        summary: 'down',
        checkedAt: '2026-10-08T11:58:00.000Z',
        checkedBy: 'pulse',
        recordedBy: 'pulse',
        secretish: 'never shown',
      },
      {
        id: resultDocId('retired-probe'),
        docType: 'health_probe_result',
        probeId: 'retired-probe',
        status: 'healthy',
        summary: 'x',
      },
      { id: PULSE_DOC_ID, docType: 'health_pulse', lastBeatAt: '2026-10-08T11:58:00.000Z', checks: 14 },
    ]);
    const res = await handlers(store, 'viewer').getProbeResults(request(), context);
    expect(res.status).toBe(200);
    const body = bodyOf(res);
    expect(Object.keys(body.results)).toEqual(['cosmos']);
    expect(body.results.cosmos).toEqual({
      probeId: 'cosmos',
      kind: 'snapshot',
      // Stored under the old word, read as the new one.
      status: 'offline',
      summary: 'down',
      detail: null,
      checkedAt: '2026-10-08T11:58:00.000Z',
      checkedBy: 'pulse',
      durationMs: null,
      statusSince: null,
      previousStatus: null,
    });
    expect(body.pulse).toMatchObject({ lastBeatAt: '2026-10-08T11:58:00.000Z', intervalMs: 300000, checks: 14 });
    expect(store.queryDocs.mock.calls[0][0]).toBe(PROBE_RESULTS_CONTAINER);
  });

  it('refuses a caller with no admin role, and says so on a failed read', async () => {
    const refused = await handlers(memStore(), null).getProbeResults(request(), context);
    expect(refused.status).toBe(403);
    const store = memStore();
    store.queryDocs.mockRejectedValue(new Error('cosmos down'));
    const failed = await handlers(store, 'viewer').getProbeResults(request(), context);
    expect(failed.status).toBe(500);
    expect(bodyOf(failed).error).toMatch(/stored probe results/);
  });
});

describe('PUT cms/health/probe-results', () => {
  it('records at the server’s time, as an admin, without naming the person to the page', async () => {
    const store = memStore();
    const res = await handlers(store, 'editor').putProbeResult(
      request({ probeId: 'publer', status: 'healthy', summary: 'Connected — 2 accounts.', durationMs: 412 }),
      context
    );
    expect(res.status).toBe(200);
    const { result } = bodyOf(res);
    expect(result).toMatchObject({
      probeId: 'publer',
      status: 'healthy',
      checkedAt: NOW.toISOString(),
      checkedBy: 'admin',
      durationMs: 412,
    });
    expect(JSON.stringify(result)).not.toContain('owner@hcw.example');
    // The actor is kept for audit, on the document only.
    expect(store.data.get(resultDocId('publer')).recordedBy).toBe('owner@hcw.example');
  });

  it('lets a viewer record a probe a viewer can run, and not one that needs an editor', async () => {
    const store = memStore();
    const viewer = handlers(store, 'viewer');
    const ok = await viewer.putProbeResult(
      request({ probeId: 'identity-token', status: 'healthy', summary: 'every comparison holds' }),
      context
    );
    expect(ok.status).toBe(200);
    const refused = await viewer.putProbeResult(
      request({ probeId: 'publer', status: 'healthy', summary: 'x' }),
      context
    );
    expect(refused.status).toBe(403);
    expect(bodyOf(refused).error).toMatch(/requires editor/);
    expect(store.data.has(resultDocId('publer'))).toBe(false);
  });

  it('refuses a stranger before reading the body, and a bad body with 400', async () => {
    const body = vi.fn(async () => ({ probeId: 'publer' }));
    const stranger = await handlers(memStore(), null).putProbeResult({ json: body }, context);
    expect(stranger.status).toBe(403);
    expect(body).not.toHaveBeenCalled();

    const bad = await handlers(memStore()).putProbeResult(request({ probeId: 'publer', status: 'x' }), context);
    expect(bad.status).toBe(400);
  });

  it('answers 409 when the probe kept changing, and 500 when the store fails', async () => {
    const store = memStore([{ id: resultDocId('publer'), probeId: 'publer', status: 'healthy' }]);
    store.replaceDocIfMatch.mockRejectedValue(Object.assign(new Error('changed'), { code: 412 }));
    const conflict = await handlers(store).putProbeResult(
      request({ probeId: 'publer', status: 'healthy', summary: 'x' }),
      context
    );
    expect(conflict.status).toBe(409);

    store.readDoc.mockRejectedValue(new Error('cosmos down'));
    const failed = await handlers(store).putProbeResult(
      request({ probeId: 'publer', status: 'healthy', summary: 'x' }),
      context
    );
    expect(failed.status).toBe(500);
  });
});

describe('presenting', () => {
  it('hides an unknown checkedBy as admin and drops a malformed time', () => {
    expect(presentResult({ probeId: 'x', status: 'healthy', checkedBy: 'someone@x', checkedAt: 'nope' })).toMatchObject({
      checkedBy: 'admin',
      checkedAt: null,
    });
    expect(presentResult(null)).toBeNull();
  });

  it('says the pulse or a scheduled timer by name (#1918), and nothing else', () => {
    for (const checker of ['pulse', 'timer']) {
      expect(presentResult({ probeId: 'x', status: 'healthy', checkedBy: checker }).checkedBy).toBe(checker);
    }
    expect(presentResult({ probeId: 'x', status: 'healthy', checkedBy: 'checkCloudflareRateLimit' }).checkedBy).toBe('admin');
  });

  it('records an admin PUT as admin, whatever checkedBy the body claims', async () => {
    const store = memStore();
    const res = await handlers(store).putProbeResult(
      request({ probeId: 'cloudflare-rate-limit', status: 'healthy', summary: 'On.', checkedBy: 'timer' }),
      context
    );
    expect(bodyOf(res).result.checkedBy).toBe('admin');
  });

  it('says a pulse that never beat is no pulse', () => {
    expect(presentPulse(null)).toBeNull();
    expect(presentPulse({ lastBeatAt: 'never' })).toBeNull();
  });
});
