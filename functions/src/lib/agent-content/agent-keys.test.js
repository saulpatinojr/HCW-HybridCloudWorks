/**
 * More than one agent key (agent-keys.js): each key has its own record,
 * switches, limit, identity and audit rows, and nothing one key's record
 * says reaches another. Koda's own behaviour is held by the tests beside
 * this one, unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AGENT_KEYS, AGENT_KEY_IDS, agentKeyById, agentKeyByRecordId, isAgentUser } from './agent-keys.js';
import {
  AGENT_ID,
  AGENT_USER,
  CAPABILITY_IDS,
  KEY_RECORD_ID,
  agentUserOf,
  buildKeyRecord,
  defaultCapabilities,
  enabledCapabilities,
  generateKey,
  hashKey,
  presentKeyRecord,
  quotaKeyFor,
} from './keys.js';
import { createAgentContentGuard } from './guard.js';
import { createAgentContentAdminHandlers } from './admin-handlers.js';
import { withAgentAccess } from './admin-access.js';
import { agentSwitchesOn, hiddenOriginPages } from '../page-links/origin-ref.js';
import { ORIGIN_PAGE_IDS, ORIGIN_PAGES } from '../page-links/origin-pages.js';
import { hiddenReminderPrefixes } from '../reminders/agent-visibility.js';
import { PROVIDED_ROWS } from '../reminders/settings.js';
import { ADMIN_CONFIG_LEAVE_OUT } from '../backup/archive-classification-admin.js';

const T0 = Date.parse('2026-11-26T12:00:10.000Z');
const CLAUDE = agentKeyById('claude');
const KODA_SECRET = generateKey();
const CLAUDE_SECRET = generateKey();
const allSwitches = (on) => Object.fromEntries(CAPABILITY_IDS.map((id) => [id, on]));
/** What Claude's key starts with: reading and writing drafts, nothing else. */
const DRAFTS_ONLY = Object.fromEntries(
  CAPABILITY_IDS.map((id) => [id, id === 'drafts.read' || id === 'drafts.write'])
);

const kodaRecord = (capabilities = allSwitches(true)) => ({
  ...buildKeyRecord({ secret: KODA_SECRET, actor: 'owner@hcw.dev', now: () => new Date(T0 - 60_000) }),
  capabilities,
});
const claudeRecord = (capabilities = allSwitches(false)) => ({
  ...buildKeyRecord({
    secret: CLAUDE_SECRET,
    actor: 'owner@hcw.dev',
    now: () => new Date(T0 - 60_000),
    agentId: 'claude',
  }),
  capabilities,
});

const request = (secret, { method = 'GET', url = 'https://api.local/api/agent-content/v1/status' } = {}) => ({
  method,
  url,
  headers: { get: (name) => (name.toLowerCase() === 'authorization' && secret ? `Bearer ${secret}` : null) },
});

/** admin_config by id, and the quota counter's compare-and-increment. */
function memoryStore(...records) {
  const docs = new Map(records.filter(Boolean).map((record) => [record.id, structuredClone(record)]));
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
      docs.set(id, { ...docs.get(id), ...updates });
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
      if (container === 'admin_config') {
        if (docs.has(doc.id)) throw Object.assign(new Error('exists'), { code: 409 });
        docs.set(doc.id, { ...doc, _etag: 'e1' });
        return docs.get(doc.id);
      }
      if (quota.has(doc.id)) throw Object.assign(new Error('exists'), { code: 409 });
      quota.set(doc.id, { ...doc });
      return doc;
    }),
    replaceDocIfMatch: vi.fn(async (container, doc) => {
      if (container === 'admin_config') {
        docs.set(doc.id, { ...doc, _etag: 'e2' });
        return docs.get(doc.id);
      }
      quota.set(doc.id, { ...doc });
      return doc;
    }),
    upsertDoc: vi.fn(async () => ({})),
  };
}

let audits;
const auditDenial = vi.fn((entry) => {
  audits.push(entry);
});
const guardOver = (store, opts = {}) =>
  createAgentContentGuard({ store, now: () => T0, auditDenial, requestsPerMinute: 120, ...opts });

beforeEach(() => {
  audits = [];
  auditDenial.mockClear();
});

describe('the list of agent keys', () => {
  it('keeps Koda first and unchanged, and adds a second key with its own record that starts with only reading and writing drafts on', () => {
    expect(AGENT_KEY_IDS).toEqual(['koda', 'claude']);
    expect(AGENT_KEYS[0]).toEqual({ id: 'koda', displayName: 'Koda', recordId: KEY_RECORD_ID, switchesOnWhenMade: true });
    expect(AGENT_ID).toBe('koda');
    expect(KEY_RECORD_ID).toBe('agent_content_key:koda');
    expect(CLAUDE).toEqual({
      id: 'claude',
      displayName: 'Claude',
      recordId: 'agent_content_key:claude',
      switchesOnWhenMade: ['drafts.read', 'drafts.write'],
    });
    expect(new Set(AGENT_KEYS.map((key) => key.recordId)).size).toBe(AGENT_KEYS.length);
    expect(Object.isFrozen(AGENT_KEYS)).toBe(true);
    expect(Object.isFrozen(CLAUDE)).toBe(true);
  });

  it('finds a key by id or record id, and nothing else', () => {
    expect(agentKeyById('claude')).toBe(CLAUDE);
    expect(agentKeyByRecordId('agent_content_key:claude')).toBe(CLAUDE);
    for (const missing of ['', 'constructor', 'Koda', undefined, null, 'agent_content_key:other']) {
      expect(agentKeyById(missing)).toBeNull();
      expect(agentKeyByRecordId(missing)).toBeNull();
    }
  });

  it('tells an agent key from a person by the agent id the guards put on the user', () => {
    expect(isAgentUser(AGENT_USER)).toBe(true);
    expect(isAgentUser(agentUserOf(CLAUDE))).toBe(true);
    expect(isAgentUser({ oid: 'person', email: 'owner@hcw.dev' })).toBe(false);
    expect(isAgentUser({ agent: '' })).toBe(false);
    expect(isAgentUser(null)).toBe(false);
  });

  it('gives each key its own identity, Koda’s exactly as before', () => {
    expect(agentUserOf(AGENT_KEYS[0])).toEqual(AGENT_USER);
    expect(agentUserOf(CLAUDE)).toEqual({
      oid: 'agent:claude',
      sub: 'agent:claude',
      preferred_username: 'claude (agent)',
      name: 'Claude',
      email: null,
      agent: 'claude',
    });
  });

  it('keeps every key record out of the backup, as a secret', () => {
    for (const key of AGENT_KEYS) {
      expect(ADMIN_CONFIG_LEAVE_OUT.ids[key.recordId], key.recordId).toBeTruthy();
    }
  });
});

describe('each key’s switches are its own', () => {
  it('starts a new second key with only reading and writing drafts on, and Koda’s with every switch on', () => {
    expect(defaultCapabilities()).toEqual(allSwitches(true));
    expect(defaultCapabilities('koda')).toEqual(allSwitches(true));
    expect(defaultCapabilities('claude')).toEqual(DRAFTS_ONLY);
    expect(defaultCapabilities('not-a-key')).toEqual(allSwitches(false));
    const made = buildKeyRecord({ secret: CLAUDE_SECRET, actor: 'owner@hcw.dev', agentId: 'claude' });
    expect(made.id).toBe('agent_content_key:claude');
    expect(made.agent).toBe('claude');
    expect(made.capabilities).toEqual(DRAFTS_ONLY);
    expect(made.keyHash).toBe(hashKey(CLAUDE_SECRET));
    expect(JSON.stringify(made)).not.toContain(CLAUDE_SECRET);
  });

  it('reads a switch the second key’s record never stored as its starting value, and Koda’s as on', () => {
    const { capabilities: _k, ...kodaBare } = kodaRecord();
    const { capabilities: _a, ...claudeBare } = claudeRecord();
    expect(enabledCapabilities(kodaBare)).toEqual(CAPABILITY_IDS);
    expect(enabledCapabilities(claudeBare)).toEqual(['drafts.read', 'drafts.write']);
    expect(enabledCapabilities({ id: 'agent_content_key:other', capabilities: {} })).toEqual([]);
    expect(presentKeyRecord(null, 'claude').capabilities).toEqual(DRAFTS_ONLY);
    expect(presentKeyRecord(null).capabilities).toEqual(allSwitches(true));
  });

  it('keeps a rotation from changing what the second key may do', () => {
    const previous = claudeRecord({ ...allSwitches(false), 'drafts.write': true });
    const rotated = buildKeyRecord({ secret: generateKey(), actor: 'owner@hcw.dev', previous, agentId: 'claude' });
    expect(enabledCapabilities(rotated)).toEqual(['drafts.write']);
  });
});

describe('the key guard', () => {
  it('signs a key that matches the second record in as that key, with its own switches, limit and last-used stamp', async () => {
    const store = memoryStore(kodaRecord(), claudeRecord({ ...allSwitches(false), 'drafts.read': true }));
    const guard = guardOver(store);
    const auth = await guard.authenticate(request(CLAUDE_SECRET));
    expect(auth.error).toBeNull();
    expect(auth.user).toEqual({ ...agentUserOf(CLAUDE), keyHint: claudeRecord().keyHint });
    expect(auth.record.id).toBe('agent_content_key:claude');
    expect([...store.quota.keys()]).toEqual([quotaKeyFor(T0, 'claude')]);
    expect(quotaKeyFor(T0, 'claude')).toMatch(/^agent-content:claude:/);
    await vi.waitFor(() =>
      expect(store.patchDoc).toHaveBeenCalledWith(
        'admin_config',
        'agent_content_key:claude',
        { lastUsedAt: new Date(T0).toISOString() },
        { partitionKey: 'admin_config' }
      )
    );
    expect(store.docs.get(KEY_RECORD_ID).lastUsedAt).toBeNull();
  });

  it('still signs Koda’s key in as Koda, reading only Koda’s record', async () => {
    const store = memoryStore(kodaRecord(), claudeRecord());
    const auth = await guardOver(store).authenticate(request(KODA_SECRET));
    expect(auth.user).toEqual({ ...AGENT_USER, keyHint: kodaRecord().keyHint });
    expect(store.readDoc.mock.calls.filter(([container]) => container === 'admin_config').map(([, id]) => id)).toEqual([
      KEY_RECORD_ID,
    ]);
  });

  it('does not let Koda’s switches reach the second key, or the second key’s reach Koda', async () => {
    const store = memoryStore(
      kodaRecord({ ...allSwitches(true), 'drafts.write': false }),
      claudeRecord({ ...allSwitches(false), 'drafts.write': true })
    );
    const guard = guardOver(store);
    expect((await guard.requireCapability(request(CLAUDE_SECRET), 'drafts.write')).error).toBeNull();
    const claudeRead = await guard.requireCapability(request(CLAUDE_SECRET), 'drafts.read');
    expect(claudeRead.error.status).toBe(403);
    expect(JSON.parse(claudeRead.error.body).error).toMatch(/^Claude's key does not allow this: .* on the AI Engine's Claude tab\.$/);
    expect((await guard.requireCapability(request(KODA_SECRET), 'drafts.read')).error).toBeNull();
    const kodaWrite = await guard.requireCapability(request(KODA_SECRET), 'drafts.write');
    expect(kodaWrite.error.status).toBe(403);
    expect(audits.map(({ agent, reason }) => [agent, reason])).toEqual([
      ['claude', 'capability-off'],
      ['koda', 'capability-off'],
    ]);
  });

  it('refuses a revoked second key exactly as any wrong key is refused, with no hint of the key in the row', async () => {
    const { keyHash: _gone, ...revoked } = { ...claudeRecord(), revokedAt: new Date(T0 - 1000).toISOString() };
    const withKoda = await guardOver(memoryStore(kodaRecord(), revoked)).authenticate(request(CLAUDE_SECRET));
    const alone = await guardOver(memoryStore(revoked)).authenticate(request(CLAUDE_SECRET));
    const wrong = await guardOver(memoryStore(kodaRecord())).authenticate(request(generateKey()));
    for (const auth of [withKoda, alone]) {
      expect(auth.error.status).toBe(401);
      expect(auth.error.body).toBe(wrong.error.body);
      expect(auth.user).toBeNull();
    }
    expect(audits.map((row) => row.reason)).toEqual(['wrong-key', 'revoked-key', 'wrong-key']);
    for (const row of audits) expect(JSON.stringify(row)).not.toContain('hcwk_');
  });

  it('lets a freshly made Claude key read and write drafts through the agent API, and nothing else', async () => {
    const made = buildKeyRecord({ secret: CLAUDE_SECRET, actor: 'owner@hcw.dev', agentId: 'claude' });
    const store = memoryStore(kodaRecord(), made);
    const guard = guardOver(store);
    for (const capability of ['drafts.read', 'drafts.write']) {
      expect((await guard.requireCapability(request(CLAUDE_SECRET), capability)).error, capability).toBeNull();
    }
    for (const capability of CAPABILITY_IDS.filter((id) => !['drafts.read', 'drafts.write'].includes(id))) {
      expect((await guard.requireCapability(request(CLAUDE_SECRET), capability)).error.status, capability).toBe(403);
    }
    const guarded = withAgentAccess({ requireRole: vi.fn(), requireUser: vi.fn() }, { agentGuard: guard, auditDenial });
    const admin = await guarded.requireRole(
      { ...request(CLAUDE_SECRET, { url: 'https://api.local/api/cms/drafts' }), method: 'GET' },
      'editor'
    );
    expect(admin.error.status).toBe(403);
  });

  it('counts each key against its own limit', async () => {
    const store = memoryStore(kodaRecord(), claudeRecord());
    const guard = guardOver(store, { requestsPerMinute: 1 });
    expect((await guard.authenticate(request(CLAUDE_SECRET))).error).toBeNull();
    const over = await guard.authenticate(request(CLAUDE_SECRET));
    expect(over.error.status).toBe(429);
    expect(audits.at(-1)).toMatchObject({ agent: 'claude', reason: 'rate-limited' });
    expect((await guard.authenticate(request(KODA_SECRET))).error).toBeNull();
  });

  it('does not take a document stored under the wrong id as a key’s record', async () => {
    const store = memoryStore(kodaRecord());
    // A read that answers Koda's document for every id must not make Koda's
    // key sign in as the second key.
    store.readDoc.mockImplementation(async (container, id) =>
      container === 'admin_config' ? kodaRecord() : store.quota.get(id) ?? null
    );
    const auth = await guardOver(store).authenticate(request(KODA_SECRET));
    expect(auth.user.agent).toBe('koda');
  });
});

describe('the admin routes behind each key’s tab', () => {
  const admin = (role = 'super_admin') => ({ requireRole: vi.fn(async () => ({ user: { email: 'owner@hcw.dev' }, role, error: null })) });
  const call = (method, query = '', body = undefined) => ({
    method,
    url: `https://api.local/api/cms/agent-content/key${query}`,
    headers: { get: () => null },
    json: async () => body ?? {},
  });
  const handlersOver = (store) =>
    createAgentContentAdminHandlers({
      guard: admin(),
      store,
      now: () => new Date(T0),
      uuid: () => 'audit-1',
      generate: () => CLAUDE_SECRET,
    });

  it('shows the second key with no key made and only reading and writing drafts on', async () => {
    const res = await handlersOver(memoryStore(kodaRecord())).getKey(call('GET', '?agent=claude'));
    const answer = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(answer).toMatchObject({ agent: 'claude', displayName: 'Claude', switchesOnWhenMade: ['drafts.read', 'drafts.write'] });
    expect(answer.key).toEqual({ present: false, active: false, capabilities: DRAFTS_ONLY });
    expect(answer.adminAccess.every((section) => section.on === false)).toBe(true);
  });

  it('makes the second key in its own record, only reading and writing drafts on, and shows the key once', async () => {
    const store = memoryStore(kodaRecord());
    const res = await handlersOver(store).generateKey(call('POST', '?agent=claude'));
    const answer = JSON.parse(res.body);
    expect(res.status).toBe(201);
    expect(answer.secret).toBe(CLAUDE_SECRET);
    const stored = store.docs.get('agent_content_key:claude');
    expect(stored.agent).toBe('claude');
    expect(stored.capabilities).toEqual(DRAFTS_ONLY);
    expect(stored.keyHash).toBe(hashKey(CLAUDE_SECRET));
    expect(JSON.stringify(stored)).not.toContain(CLAUDE_SECRET);
    // Koda's record is untouched.
    expect(store.docs.get(KEY_RECORD_ID)).toEqual(kodaRecord());
    expect(store.upsertDoc).toHaveBeenCalledWith(
      'admin_audit_logs',
      expect.objectContaining({ action: 'agent_content_key_generated', resourceId: 'claude' })
    );
  });

  it('switches and revokes only the key it names', async () => {
    const store = memoryStore(kodaRecord(), claudeRecord());
    const handlers = handlersOver(store);
    const switched = await handlers.updateCapabilities(call('PATCH', '?agent=claude', { capabilities: { 'drafts.write': true } }));
    expect(switched.status).toBe(200);
    expect(enabledCapabilities(store.docs.get('agent_content_key:claude'))).toEqual(['drafts.write']);
    expect(enabledCapabilities(store.docs.get(KEY_RECORD_ID))).toEqual(CAPABILITY_IDS);
    const revoked = await handlers.revokeKey(call('DELETE', '?agent=claude'));
    expect(JSON.parse(revoked.body).key.active).toBe(false);
    expect(store.docs.get('agent_content_key:claude').keyHash).toBeUndefined();
    expect(store.docs.get(KEY_RECORD_ID).keyHash).toBe(hashKey(KODA_SECRET));
  });

  it('means Koda’s key when no agent is named', async () => {
    const res = await handlersOver(memoryStore(kodaRecord())).getKey(call('GET'));
    expect(JSON.parse(res.body)).toMatchObject({ agent: 'koda', key: { present: true, active: true } });
  });

  it.each(['?agent=nobody', '?agent=constructor', '?agent=KODA', '?agent=agent_content_key:koda'])(
    'refuses an agent id that is not on the list (%s), reading and writing nothing',
    async (query) => {
      const store = memoryStore(kodaRecord());
      const handlers = handlersOver(store);
      for (const [action, method] of [
        ['getKey', 'GET'],
        ['generateKey', 'POST'],
        ['updateCapabilities', 'PATCH'],
        ['revokeKey', 'DELETE'],
      ]) {
        const res = await handlers[action](call(method, query, { capabilities: { 'drafts.read': true } }));
        expect(res.status, action).toBe(400);
        expect(JSON.parse(res.body).code).toBe('UNKNOWN_AGENT');
      }
      expect(store.readDoc).not.toHaveBeenCalled();
      expect(store.createDoc).not.toHaveBeenCalled();
      expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    }
  );

  it('keeps the roles: a write still needs super_admin', async () => {
    const refusal = { status: 403, body: '{}' };
    const guard = { requireRole: vi.fn(async (req, role) => (role === 'super_admin' ? { error: refusal } : { user: {}, role, error: null })) };
    const handlers = createAgentContentAdminHandlers({ guard, store: memoryStore() });
    expect(await handlers.generateKey(call('POST', '?agent=claude'))).toBe(refusal);
    expect(guard.requireRole).toHaveBeenCalledWith(expect.anything(), 'super_admin');
  });
});

describe('the admin allow-list', () => {
  const roleGuard = { requireRole: vi.fn(), requireUser: vi.fn() };
  const adminRequest = (secret) => ({
    ...request(secret, { url: 'https://api.local/api/cms/drafts' }),
    method: 'GET',
  });

  it('opens a route to the second key only through its own section switch, acting as that key', async () => {
    const store = memoryStore(
      kodaRecord({ ...allSwitches(true), 'admin.pipeline': false }),
      claudeRecord({ ...allSwitches(false), 'admin.pipeline': true })
    );
    const guarded = withAgentAccess(roleGuard, { agentGuard: guardOver(store), auditDenial });
    const claude = await guarded.requireRole(adminRequest(CLAUDE_SECRET), 'editor');
    expect(claude.error).toBeNull();
    expect(claude.user).toMatchObject({ oid: 'agent:claude', preferred_username: 'claude (agent)', agent: 'claude' });
    const koda = await guarded.requireRole(adminRequest(KODA_SECRET), 'editor');
    expect(koda.error.status).toBe(403);
    expect(audits.at(-1)).toMatchObject({ agent: 'koda', reason: 'section-off', section: 'admin.pipeline' });
  });

  it('refuses the second key a section it has not had switched on, naming it in the row', async () => {
    const store = memoryStore(kodaRecord(), claudeRecord());
    const guarded = withAgentAccess(roleGuard, { agentGuard: guardOver(store), auditDenial });
    const res = await guarded.requireRole(adminRequest(CLAUDE_SECRET), 'editor');
    expect(res.error.status).toBe(403);
    expect(audits.at(-1)).toMatchObject({ agent: 'claude', reason: 'section-off' });
    expect(roleGuard.requireRole).not.toHaveBeenCalled();
  });
});

describe('what each key may see on other Pages', () => {
  const sections = [...new Set(ORIGIN_PAGE_IDS.map((id) => ORIGIN_PAGES[id].agentSection))];
  const on = (ids) => Object.fromEntries(CAPABILITY_IDS.map((id) => [id, ids.includes(id)]));

  it('hides Pipeline references by the asking key’s own switches', async () => {
    const store = memoryStore(kodaRecord(allSwitches(true)), claudeRecord(allSwitches(false)));
    expect(await hiddenOriginPages(store, AGENT_USER)).toEqual([]);
    expect((await hiddenOriginPages(store, agentUserOf(CLAUDE))).sort()).toEqual([...ORIGIN_PAGE_IDS].sort());
    const opened = memoryStore(kodaRecord(allSwitches(false)), claudeRecord(on(sections)));
    expect(await hiddenOriginPages(opened, agentUserOf(CLAUDE))).toEqual([]);
    expect((await hiddenOriginPages(opened, AGENT_USER)).sort()).toEqual([...ORIGIN_PAGE_IDS].sort());
  });

  it('hides kept reminder rows by the asking key’s own switches', async () => {
    const prefixes = PROVIDED_ROWS.map(({ prefix }) => prefix).sort();
    const store = memoryStore(kodaRecord(allSwitches(true)), claudeRecord(allSwitches(false)));
    expect(await hiddenReminderPrefixes(store, AGENT_USER)).toEqual([]);
    expect((await hiddenReminderPrefixes(store, agentUserOf(CLAUDE))).sort()).toEqual(prefixes);
  });

  it('fails closed for a key with no record and for an agent id not on the list', async () => {
    const store = memoryStore(kodaRecord(allSwitches(true)));
    expect(await agentSwitchesOn(store, 'claude')).toEqual([]);
    expect(await agentSwitchesOn(store, 'nobody')).toEqual([]);
    expect((await hiddenOriginPages(store, { agent: 'nobody' })).sort()).toEqual([...ORIGIN_PAGE_IDS].sort());
    expect(await hiddenOriginPages(store, { oid: 'person' })).toEqual([]);
  });
});
