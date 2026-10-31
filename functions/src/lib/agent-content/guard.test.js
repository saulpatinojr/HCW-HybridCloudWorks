/**
 * The agent key guard (guard.js, ADR 0037): the three gates in order, what
 * each refusal answers and records, the per-minute limit's 429, the capability
 * check, the identity the Drafts routes receive, and that nothing reads or
 * writes the store before the key's shape has passed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LAST_USED_EVERY_MS, createAgentContentGuard } from './guard.js';
import { AGENT_USER, KEY_RECORD_ID, buildKeyRecord, generateKey } from './keys.js';

const T0 = Date.parse('2026-10-31T12:00:10.000Z');
const SECRET = generateKey();
const RECORD = buildKeyRecord({ secret: SECRET, actor: 'owner@hcw.dev', now: () => new Date(T0 - 60_000) });

/**
 * Something shaped like a signed JSON web token (an Entra access token), built
 * at run time so no token-shaped literal sits in the source for a secret
 * scanner to flag: a base64url header, an empty payload and a fake signature.
 */
const TOKEN_SHAPED = `Bearer ${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.sig`;

const request = (authorization) => ({
  headers: { get: (name) => (name.toLowerCase() === 'authorization' ? authorization : null) },
});
const body = (res) => JSON.parse(res.body);

/** A store with the key record and the quota counter's compare-and-increment. */
function memoryStore(record = RECORD) {
  const docs = new Map();
  if (record) docs.set(record.id, structuredClone(record));
  const quota = new Map();
  return {
    docs,
    quota,
    readDoc: vi.fn(async (container, id) => {
      if (container === 'admin_config') return docs.has(id) ? structuredClone(docs.get(id)) : null;
      if (container === 'submission_quota') return quota.get(id) ?? null;
      throw new Error(`unexpected read of ${container}`);
    }),
    patchDoc: vi.fn(async (container, id, updates) => {
      const doc = docs.get(id);
      docs.set(id, { ...doc, ...updates });
      return docs.get(id);
    }),
    incrementIf: vi.fn(async (container, id, { conditionValues }) => {
      const doc = quota.get(id);
      if (!doc) throw Object.assign(new Error('missing'), { code: 404 });
      if (!(doc.windowStartMs > conditionValues.windowFloor && doc.count < conditionValues.limit)) {
        throw Object.assign(new Error('predicate'), { code: 412 });
      }
      doc.count += 1;
      return doc;
    }),
    createDoc: vi.fn(async (container, doc) => {
      if (quota.has(doc.id)) throw Object.assign(new Error('exists'), { code: 409 });
      quota.set(doc.id, { ...doc });
      return doc;
    }),
    replaceDocIfMatch: vi.fn(async (container, doc) => {
      quota.set(doc.id, { ...doc });
      return doc;
    }),
  };
}

let audits;
const auditDenial = vi.fn(async (entry) => {
  audits.push(entry);
});

function setup({ record = RECORD, now = () => T0, requestsPerMinute = 120 } = {}) {
  const store = memoryStore(record);
  const guard = createAgentContentGuard({ store, now, auditDenial, requestsPerMinute });
  return { store, guard };
}

beforeEach(() => {
  audits = [];
  auditDenial.mockClear();
});

describe('gate 1 — the bearer value', () => {
  it('answers 401 with no Authorization, reading nothing', async () => {
    const { store, guard } = setup();
    const auth = await guard.authenticate(request(null));
    expect(auth.error.status).toBe(401);
    expect(body(auth.error).code).toBe('UNAUTHENTICATED');
    expect(store.readDoc).not.toHaveBeenCalled();
  });

  it('answers 401 for an Entra token or any value not shaped like a key, reading and writing nothing', async () => {
    const { store, guard } = setup();
    const auth = await guard.authenticate(request(TOKEN_SHAPED));
    expect(auth.error.status).toBe(401);
    expect(store.readDoc).not.toHaveBeenCalled();
    // No audit row: a value that is not a site key is no credential, and a
    // scanner's random bearers must not become a write per request.
    expect(audits).toEqual([]);
    expect(auditDenial).not.toHaveBeenCalled();
  });
});

describe('gate 2 — the record', () => {
  it('answers the same 401 when there is no key, when it is wrong, and when it is revoked', async () => {
    const noKey = setup({ record: null });
    const none = await noKey.guard.authenticate(request(`Bearer ${SECRET}`));
    const wrong = await setup().guard.authenticate(request(`Bearer ${generateKey()}`));
    const revoked = await setup({
      record: { ...RECORD, keyHash: undefined, revokedAt: '2026-10-31T11:00:00.000Z' },
    }).guard.authenticate(request(`Bearer ${SECRET}`));
    for (const auth of [none, wrong, revoked]) {
      expect(auth.error.status).toBe(401);
      expect(body(auth.error)).toEqual(body(none.error));
    }
    expect(audits.map((a) => a.reason)).toEqual(['no-key', 'wrong-key', 'revoked-key']);
    // The audit row never carries the key or any part of it.
    for (const entry of audits) {
      expect(JSON.stringify(entry)).not.toContain('hcwk_');
    }
  });

  it('reads the one record in the admin_config partition', async () => {
    const { store, guard } = setup();
    await guard.authenticate(request(`Bearer ${SECRET}`));
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', KEY_RECORD_ID, 'admin_config');
  });
});

describe('gate 3 — the limit', () => {
  it('lets the limit through in a minute and refuses the next with 429 and Retry-After', async () => {
    const { guard } = setup({ requestsPerMinute: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect((await guard.authenticate(request(`Bearer ${SECRET}`))).error).toBeNull();
    }
    const refused = await guard.authenticate(request(`Bearer ${SECRET}`));
    expect(refused.error.status).toBe(429);
    expect(refused.error.headers['Retry-After']).toBe('50');
    expect(body(refused.error).code).toBe('RATE_LIMITED');
    expect(audits.at(-1).reason).toBe('rate-limited');
  });

  it('starts a fresh count in the next minute', async () => {
    let now = T0;
    const { guard } = setup({ requestsPerMinute: 1, now: () => now });
    expect((await guard.authenticate(request(`Bearer ${SECRET}`))).error).toBeNull();
    expect((await guard.authenticate(request(`Bearer ${SECRET}`))).error.status).toBe(429);
    now += 60_000;
    expect((await guard.authenticate(request(`Bearer ${SECRET}`))).error).toBeNull();
  });

  it('a store fault in the counter is a fault, not an allowance', async () => {
    const { store, guard } = setup();
    store.incrementIf.mockRejectedValue(Object.assign(new Error('down'), { code: 503 }));
    await expect(guard.authenticate(request(`Bearer ${SECRET}`))).rejects.toThrow('down');
  });
});

describe('a key that passes', () => {
  it('yields Koda as the user, with the record and the key hint', async () => {
    const { guard } = setup();
    const auth = await guard.authenticate(request(`Bearer ${SECRET}`));
    expect(auth.error).toBeNull();
    expect(auth.user).toEqual({ ...AGENT_USER, keyHint: RECORD.keyHint });
    expect(auth.record.id).toBe(KEY_RECORD_ID);
  });

  it('stamps lastUsedAt at most once per interval, without waiting for the write', async () => {
    let now = T0;
    const { store, guard } = setup({ now: () => now });
    await guard.authenticate(request(`Bearer ${SECRET}`));
    await Promise.resolve();
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
    expect(store.patchDoc.mock.calls[0].slice(0, 3)).toEqual([
      'admin_config',
      KEY_RECORD_ID,
      { lastUsedAt: new Date(T0).toISOString() },
    ]);
    now += LAST_USED_EVERY_MS - 1;
    await guard.authenticate(request(`Bearer ${SECRET}`));
    await Promise.resolve();
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
    now += 1;
    await guard.authenticate(request(`Bearer ${SECRET}`));
    await Promise.resolve();
    expect(store.patchDoc).toHaveBeenCalledTimes(2);
  });

  it('a failed lastUsedAt write changes nothing', async () => {
    const { store, guard } = setup();
    store.patchDoc.mockRejectedValue(new Error('down'));
    const auth = await guard.authenticate(request(`Bearer ${SECRET}`));
    expect(auth.error).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('the capability', () => {
  it('passes when on, and answers 403 naming the switch when off', async () => {
    const off = { ...RECORD, capabilities: { ...RECORD.capabilities, 'drafts.delete': false } };
    const { guard } = setup({ record: off });
    expect((await guard.requireCapability(request(`Bearer ${SECRET}`), 'drafts.read')).error).toBeNull();
    const refused = await guard.requireCapability(request(`Bearer ${SECRET}`), 'drafts.delete');
    expect(refused.error.status).toBe(403);
    expect(body(refused.error).error).toContain('Delete drafts');
    expect(body(refused.error).error).toContain('Koda tab');
    expect(audits.at(-1)).toEqual(expect.objectContaining({ reason: 'capability-off', capability: 'drafts.delete' }));
  });

  it('a record with no switches has every capability', async () => {
    const { guard } = setup({ record: { ...RECORD, capabilities: undefined } });
    expect((await guard.requireCapability(request(`Bearer ${SECRET}`), 'published.read')).error).toBeNull();
  });
});

describe('the audit sink', () => {
  it('never changes the answer when it throws', async () => {
    const store = memoryStore(null);
    const guard = createAgentContentGuard({
      store,
      now: () => T0,
      auditDenial: () => {
        throw new Error('sink down');
      },
    });
    const auth = await guard.authenticate(request(`Bearer ${SECRET}`));
    expect(auth.error.status).toBe(401);
  });

  it('never consults the admin registry, and an admin token is refused before any read', async () => {
    const { store, guard } = setup();
    const auth = await guard.requireCapability(request(TOKEN_SHAPED), 'drafts.read');
    expect(auth.error.status).toBe(401);
    expect(store.readDoc).not.toHaveBeenCalled();
  });
});
