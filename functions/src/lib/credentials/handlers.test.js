/**
 * The Credentials tab's routes (#1026): the role, the answer's shape, the
 * PUT's refusals, the record and its audit row, the reminders sync, and that
 * no value ever reaches an answer.
 */
import { describe, it, expect, vi } from 'vitest';

import { memoryStore } from '../../../test/memory-store.js';
import { projectMcpServers } from '../../../test/mcp-projection.js';
import { SECRETS_ROLE } from '../admin-secrets.js';
import { CREDENTIAL_REGISTER } from './register.js';
import {
  CREDENTIALS_ROLE,
  EARLIEST_ROTATION,
  ROTATION_AUDIT_ACTION,
  createCredentialRegisterHandlers,
  parseRotationBody,
  presentRegister,
} from './handlers.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const TODAY = '2026-10-09';
const LEAK = 'sk-live-THIS-MUST-NEVER-RENDER-0123456789';

const allow = () => ({
  requireRole: vi.fn(async () => ({ user: { oid: 'oid-owner', name: 'Owner' }, error: null })),
});
const deny = () => ({
  requireRole: vi.fn(async () => ({ error: { status: 403, body: JSON.stringify({ error: 'Forbidden' }) } })),
});
const request = (body) => ({ json: async () => body });
const context = () => ({ error: vi.fn(), warn: vi.fn(), log: vi.fn() });
const parse = (response) => JSON.parse(response.body);
/** An in-memory store that answers the mcp_servers projection as Cosmos would. */
const storeWith = (initial = {}) => memoryStore(initial, { query: projectMcpServers });

function setup({ guard = allow(), store = storeWith(), sync } = {}) {
  const handlers = createCredentialRegisterHandlers({
    guard,
    store,
    now: () => NOW,
    uuid: () => 'audit-1',
    ...(sync ? { sync } : {}),
  });
  return { handlers, guard, store };
}

describe('the role', () => {
  it('is the Keys tab’s, on all three routes, before anything is read', async () => {
    expect(CREDENTIALS_ROLE).toBe(SECRETS_ROLE);
    const { handlers, guard, store } = setup({ guard: deny() });
    for (const call of [
      () => handlers.getRegister(request(), context()),
      () => handlers.putRotation(request({ credentialId: 'kv-anthropic-api-key', rotatedOn: TODAY }), context()),
      () => handlers.syncReminders(request(), context()),
    ]) {
      expect((await call()).status).toBe(403);
    }
    expect(guard.requireRole.mock.calls.map((c) => c[1])).toEqual(Array(3).fill('super_admin'));
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
  });
});

describe('GET cms/credentials', () => {
  it('answers every credential, the stores and the counts, privately', async () => {
    const { handlers } = setup();
    const response = await handlers.getRegister(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('private, no-store');
    const body = parse(response);
    expect(body.credentials).toHaveLength(CREDENTIAL_REGISTER.length);
    expect(body.stores.map((s) => s.id)).toContain('key-vault');
    expect(body.counts).toEqual(expect.objectContaining({ ok: expect.any(Number), overdue: 0 }));
    expect(body.unavailable).toEqual([]);
    expect(body.generatedAt).toBe(NOW.toISOString());
  });

  it('says whether each reminder is on the sheet, by its due date', async () => {
    const store = storeWith({
      'admin_config/credential_register': {
        id: 'credential_register',
        credentials: {
          'lab-agent-certificate': { rotatedOn: '2026-09-29' },
          'lab-vault-tls-certificate': { rotatedOn: '2026-09-29' },
        },
      },
      'admin_config/reminders': {
        id: 'reminders',
        reminders: [
          {
            id: 'credential-lab-agent-certificate',
            title: 'Rotate /etc/hcw/labs-agent.pem (sp-labs-agent-lab-hybrid-prod-cus-01)',
            dueDate: '2027-03-28',
          },
          { id: 'credential-lab-vault-tls-certificate', title: 'Rotate /etc/vault.d/tls/vault.crt', dueDate: '2027-01-01' },
        ],
      },
    });
    const body = parse(await setup({ store }).handlers.getRegister(request(), context()));
    const byId = Object.fromEntries(body.credentials.map((c) => [c.id, c]));
    expect(byId['lab-agent-certificate'].reminder).toEqual({
      id: 'credential-lab-agent-certificate',
      kind: 'rotate',
      dueDate: '2027-03-28',
      leadDays: 30,
      inSheet: true,
    });
    expect(byId['lab-vault-tls-certificate'].reminder.inSheet).toBe(false);
    // A rule and no date: the reminder asks for the date, due today (#1026).
    expect(byId['kv-anthropic-api-key'].reminder).toEqual({
      id: 'credential-kv-anthropic-api-key',
      kind: 'record',
      dueDate: TODAY,
      leadDays: 0,
      inSheet: false,
    });
    // No rule: no reminder.
    expect(byId['kv-openai-api-key'].reminder).toBeNull();
  });

  it('shows a Key Vault credential unknown, without expiry or reminder, when secret_state cannot be read', async () => {
    const store = storeWith({
      'admin_config/credential_register': {
        id: 'credential_register',
        credentials: {
          'kv-anthropic-api-key': { rotatedOn: '2026-09-01' },
          'lab-agent-certificate': { rotatedOn: '2026-09-29' },
        },
      },
    });
    const whole = parse(await setup({ store }).handlers.getRegister(request(), context()));
    store.fail('admin_config', 'secret_state', 'readDoc', Object.assign(new Error('x'), { code: 503 }));
    const partial = parse(await setup({ store }).handlers.getRegister(request(), context()));
    const byId = (body) => Object.fromEntries(body.credentials.map((c) => [c.id, c]));

    expect(byId(whole)['kv-anthropic-api-key']).toMatchObject({ state: 'ok', reminder: { kind: 'rotate' } });
    expect(byId(partial)['kv-anthropic-api-key']).toMatchObject({
      state: 'unknown',
      sourceUnavailable: 'secret-state',
      expiresAt: null,
      daysLeft: null,
      ageDays: null,
      reminder: null,
    });
    // Every Key Vault row is affected; a lab host file is not.
    expect(byId(partial)['kv-openai-api-key'].state).toBe('unknown');
    expect(byId(partial)['lab-agent-certificate']).toEqual(byId(whole)['lab-agent-certificate']);
    // The counts are the rows' counts after the change.
    const tally = (body) =>
      body.credentials.reduce((counts, c) => ({ ...counts, [c.state]: (counts[c.state] ?? 0) + 1 }), {});
    expect(partial.counts).toEqual({ ok: 0, 'due-soon': 0, overdue: 0, unknown: 0, ...tally(partial) });
    expect(partial.counts.unknown).toBeGreaterThan(whole.counts.unknown);
    expect(partial.unavailable.map((u) => u.id)).toEqual(['secret-state']);
  });

  it('names a source it could not read, says unknown rather than missing, and still answers', async () => {
    const store = storeWith();
    store.fail('admin_config', 'reminders', 'readDoc', Object.assign(new Error('x'), { code: 503 }));
    store.fail('admin_config', 'coder_automation', 'readDoc', Object.assign(new Error('x'), { code: 503 }));
    const body = parse(await setup({ store }).handlers.getRegister(request(), context()));
    expect(body.unavailable.map((u) => u.id).sort()).toEqual(['coder-automation', 'reminders']);
    expect(body.unavailable[0].label).toEqual(expect.any(String));
  });

  it('never carries a value or a token, whatever the sources hold', async () => {
    const store = storeWith({
      'admin_config/secret_state': {
        id: 'secret_state',
        secrets: { 'ANTHROPIC-API-KEY': { lastWriteAt: '2026-10-01T00:00:00.000Z', value: LEAK } },
      },
      'mcp_servers/replicate-mcp': {
        id: 'replicate-mcp',
        oauthToken: LEAK,
        oauthRefreshToken: LEAK,
        oauthClientSecret: LEAK,
        oauth: { status: 'connected', connectedAt: '2026-10-08T00:00:00.000Z', tokenEndpoint: 'https://x' },
      },
      'mcp_servers/plaud': { id: 'plaud', oauthToken: LEAK, status: 'connected' },
      'admin_config/coder_automation': { id: 'coder_automation', lastError: LEAK },
    });
    const response = await setup({ store }).handlers.getRegister(request(), context());
    expect(response.body).not.toContain(LEAK);
    expect(response.body).not.toContain('tokenEndpoint');
    // The connections were read, from the projection: no point read of either.
    const byId = Object.fromEntries(parse(response).credentials.map((c) => [c.id, c]));
    expect(byId['mcp-replicate'].connection).toBe('connected');
    expect(byId['mcp-plaud'].connection).toBe('connected');
    expect(store.readDoc.mock.calls.filter((call) => call[0] === 'mcp_servers')).toEqual([]);
  });
});

describe('parseRotationBody', () => {
  const ok = (body) => parseRotationBody(body, TODAY);

  it('takes a register id whose renewal is hand, and a real past date or null', () => {
    expect(ok({ credentialId: 'kv-anthropic-api-key', rotatedOn: '2026-10-01' }).value).toMatchObject({
      rotatedOn: '2026-10-01',
    });
    expect(ok({ credentialId: 'lab-agent-certificate', rotatedOn: null }).value.rotatedOn).toBeNull();
    expect(ok({ credentialId: 'lab-agent-certificate', rotatedOn: TODAY }).error).toBeUndefined();
    // A day of grace for a clock ahead of UTC.
    expect(ok({ credentialId: 'lab-agent-certificate', rotatedOn: '2026-10-10' }).error).toBeUndefined();
  });

  it('refuses any other key, so a pasted value is never stored', () => {
    expect(ok({ credentialId: 'kv-anthropic-api-key', rotatedOn: TODAY, value: LEAK }).error).toMatch(
      /"value" is not a field this route reads/
    );
    expect(ok({ credentialId: 'kv-anthropic-api-key', rotatedOn: TODAY, value: LEAK }).error).not.toContain(LEAK);
  });

  it('refuses an unknown id, and one with nothing to record, saying why', () => {
    expect(ok({ credentialId: 'nope', rotatedOn: TODAY }).error).toBe(
      'credentialId is not a credential the register knows'
    );
    expect(ok({ credentialId: 'constructor', rotatedOn: TODAY }).error).toMatch(/not a credential/);
    expect(ok({ credentialId: 'kv-coder-status-token', rotatedOn: TODAY }).error).toMatch(/renewed by automation/);
    expect(ok({ credentialId: 'gh-oidc-production', rotatedOn: TODAY }).error).toMatch(/renews itself/);
    expect(ok({ credentialId: 'kv-telegram-chat-id', rotatedOn: TODAY }).error).toMatch(/an identifier/);
  });

  it('refuses a date that is not one, a typo before 2000 and one in the future', () => {
    const at = (rotatedOn) => ok({ credentialId: 'lab-agent-certificate', rotatedOn }).error;
    expect(at('2026-02-30')).toMatch(/real date/);
    expect(at('09/29/2026')).toMatch(/real date/);
    expect(at(undefined)).toMatch(/real date/);
    expect(at('0202-09-29')).toBe(`rotatedOn must be on or after ${EARLIEST_ROTATION}`);
    expect(at('2026-10-11')).toMatch(/in the future/);
  });

  it('refuses a body that is not an object', () => {
    expect(ok(null).error).toBe('The body must be a JSON object');
    expect(ok([]).error).toBe('The body must be a JSON object');
  });
});

describe('PUT cms/credentials', () => {
  it('records the date, writes one audit row, syncs the reminders and answers the register', async () => {
    const sync = vi.fn(async () => ({ synced: true, changed: true, reminders: 1 }));
    const { handlers, store } = setup({ sync });
    const response = await handlers.putRotation(
      request({ credentialId: 'lab-agent-certificate', rotatedOn: '2026-09-29' }),
      context()
    );
    expect(response.status).toBe(200);
    const body = parse(response);
    expect(body.recorded).toEqual({ credentialId: 'lab-agent-certificate', rotatedOn: '2026-09-29' });
    expect(body.reminders).toEqual({ synced: true, changed: true, reminders: 1 });
    expect(store.get('admin_config', 'credential_register').credentials['lab-agent-certificate']).toEqual({
      rotatedOn: '2026-09-29',
      recordedAt: NOW.toISOString(),
      recordedBy: 'oid-owner',
    });
    const row = body.credentials.find((c) => c.id === 'lab-agent-certificate');
    expect(row).toMatchObject({ recordedOn: '2026-09-29', lastRotatedSource: 'owner', state: 'ok' });
    expect(store.audit).toEqual([
      expect.objectContaining({
        id: 'audit-1',
        action: ROTATION_AUDIT_ACTION,
        userId: 'oid-owner',
        details: { credentialId: 'lab-agent-certificate', rotatedOn: '2026-09-29', cleared: false },
      }),
    ]);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ store }));
  });

  it('runs the real sync, so the reminder is on the sheet when the answer comes back', async () => {
    const { handlers, store } = setup();
    const body = parse(
      await handlers.putRotation(request({ credentialId: 'lab-agent-certificate', rotatedOn: '2026-09-29' }), context())
    );
    // One row for each of the eight: this one dated, the rest asking for a date.
    const rows = store.get('admin_config', 'reminders').reminders;
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.id === 'credential-lab-agent-certificate')).toMatchObject({
      dueDate: '2027-03-28',
      title: expect.stringMatching(/^Rotate /),
    });
    expect(body.credentials.find((c) => c.id === 'lab-agent-certificate').reminder).toMatchObject({
      kind: 'rotate',
      inSheet: true,
    });
    expect(body.credentials.filter((c) => c.reminder?.inSheet === false)).toEqual([]);
  });

  it('answers 500 for a malformed register document, and leaves it as it was', async () => {
    const store = storeWith({ 'admin_config/credential_register': { id: 'credential_register', credentials: 'x' } });
    const ctx = context();
    const response = await setup({ store }).handlers.putRotation(
      request({ credentialId: 'lab-agent-certificate', rotatedOn: TODAY }),
      ctx
    );
    expect(response.status).toBe(500);
    expect(parse(response).error).toMatch(/nothing changed/);
    expect(ctx.error.mock.calls[0][0]).toBe('putCredentialRotation failed (MALFORMED)');
    expect(store.get('admin_config', 'credential_register').credentials).toBe('x');
  });

  it('refuses a bad body with 400 and writes nothing', async () => {
    const { handlers, store } = setup();
    const response = await handlers.putRotation(request({ credentialId: 'kv-coder-status-token', rotatedOn: TODAY }), context());
    expect(response.status).toBe(400);
    expect(parse(response).success).toBe(false);
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.audit).toEqual([]);
  });

  it('answers 409 when the record kept losing races, and 500 for a store error, saying nothing changed', async () => {
    const lost = setup();
    lost.store.fail('admin_config', 'credential_register', 'createDoc', Object.assign(new Error('x'), { code: 409 }), 6);
    const body = request({ credentialId: 'lab-agent-certificate', rotatedOn: TODAY });
    // Six lost creates: every attempt reads nothing and loses.
    const conflict = await lost.handlers.putRotation(body, context());
    expect(conflict.status).toBe(409);
    const broken = setup();
    broken.store.fail('admin_config', 'credential_register', 'readDoc', Object.assign(new Error('x'), { code: 503 }));
    const ctx = context();
    const failed = await broken.handlers.putRotation(body, ctx);
    expect(failed.status).toBe(500);
    expect(parse(failed).error).toMatch(/nothing changed/);
    expect(ctx.error.mock.calls[0][0]).not.toContain('lab-agent');
  }, 10_000);

  it('still answers 200 when the audit row and the sync fail after the record landed', async () => {
    const store = storeWith();
    store.fail('admin_audit_logs', 'audit-1', 'upsertDoc', new Error('audit down'));
    const sync = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 500 });
    });
    const ctx = context();
    const response = await setup({ store, sync }).handlers.putRotation(
      request({ credentialId: 'lab-agent-certificate', rotatedOn: TODAY }),
      ctx
    );
    expect(response.status).toBe(200);
    expect(parse(response).reminders).toEqual({ synced: false, reason: 'error' });
    expect(ctx.warn).toHaveBeenCalledTimes(2);
  });

  it('clears a record with null', async () => {
    const store = storeWith({
      'admin_config/credential_register': {
        id: 'credential_register',
        credentials: { 'lab-agent-certificate': { rotatedOn: '2026-09-29' } },
      },
    });
    const response = await setup({ store }).handlers.putRotation(
      request({ credentialId: 'lab-agent-certificate', rotatedOn: null }),
      context()
    );
    expect(parse(response).recorded).toEqual({ credentialId: 'lab-agent-certificate', rotatedOn: null });
    expect(store.get('admin_config', 'credential_register').credentials).toEqual({});
    expect(store.audit[0].details.cleared).toBe(true);
  });
});

describe('POST cms/credentials/reminders', () => {
  it('syncs and answers the register with the summary', async () => {
    const sync = vi.fn(async () => ({ synced: true, changed: false, reminders: 0 }));
    const response = await setup({ sync }).handlers.syncReminders(request(), context());
    expect(response.status).toBe(200);
    expect(parse(response).reminders).toEqual({ synced: true, changed: false, reminders: 0 });
    expect(sync).toHaveBeenCalledOnce();
  });
});

describe('presentRegister', () => {
  it('says inSheet unknown, not false, when the sheet could not be read', () => {
    const body = presentRegister(
      {
        sources: { records: { 'lab-agent-certificate': { rotatedOn: '2026-09-29' } }, reminders: null },
        unavailable: ['reminders'],
      },
      NOW.getTime()
    );
    expect(body.credentials.find((c) => c.id === 'lab-agent-certificate').reminder.inSheet).toBeNull();
  });
});
