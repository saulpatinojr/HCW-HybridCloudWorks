/**
 * The register's reads, each standing alone, and its one write under the
 * document's ETag (#1026).
 */
import { describe, it, expect, vi } from 'vitest';

import { memoryStore } from '../../../test/memory-store.js';
import { PROJECTED_FIELDS, projectMcpServers } from '../../../test/mcp-projection.js';
import {
  CREDENTIAL_REGISTER_DOC_ID,
  MCP_RECORD_FIELDS,
  MCP_SERVER_IDS,
  MCP_SERVER_QUERY,
  readCredentialSources,
  recordRotation,
  sourceLabel,
} from './sources.js';

const AT = '2026-10-09T12:00:00.000Z';
const LEAK = 'sk-live-THIS-MUST-NEVER-BE-READ-0123456789';
const noSleep = () => Promise.resolve();
const down = () => Object.assign(new Error('unavailable'), { code: 503 });
const withMcp = (initial) => memoryStore(initial, { query: projectMcpServers });

describe('readCredentialSources', () => {
  it('reads every source and hands status.js the maps it reads', async () => {
    const store = withMcp({
      'admin_config/secret_state': { id: 'secret_state', secrets: { 'ANTHROPIC-API-KEY': { lastWriteAt: AT } } },
      'admin_config/coder_automation': { id: 'coder_automation', statusTokenExpiresAt: AT },
      'admin_config/credential_register': {
        id: CREDENTIAL_REGISTER_DOC_ID,
        credentials: { 'lab-agent-certificate': { rotatedOn: '2026-09-29' } },
      },
      'admin_config/reminders': { id: 'reminders', reminders: [{ id: 'a' }] },
      'mcp_servers/plaud': { id: 'plaud', status: 'connected', oauthToken: LEAK, lastTokenRefresh: AT },
    });
    const { sources, unavailable, reminderDoc } = await readCredentialSources(store);
    expect(unavailable).toEqual([]);
    expect(sources.secrets).toEqual({ 'ANTHROPIC-API-KEY': { lastWriteAt: AT } });
    expect(sources.coder.statusTokenExpiresAt).toBe(AT);
    expect(sources.records).toEqual({ 'lab-agent-certificate': { rotatedOn: '2026-09-29' } });
    expect(sources.reminders).toEqual([{ id: 'a' }]);
    expect(reminderDoc).toMatchObject({ id: 'reminders', _etag: expect.any(String) });
    expect(sources.mcp.plaud).toEqual({
      status: 'connected',
      lastTokenRefresh: AT,
      oauthStatus: null,
      oauthConnectedAt: null,
      oauthRefreshedAt: null,
      hasToken: true,
    });
    // A server with no document is null (not connected), not absent (unread).
    expect(Object.keys(sources.mcp).sort()).toEqual([...MCP_SERVER_IDS].sort());
    expect(sources.mcp['replicate-mcp']).toBeNull();
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', 'secret_state', 'admin_config');
  });

  it('names a read that failed and keeps the rest', async () => {
    const store = withMcp({});
    store.fail('admin_config', 'secret_state', 'readDoc', down());
    store.fail('admin_config', 'reminders', 'readDoc', down());
    const { sources, unavailable, reminderDoc } = await readCredentialSources(store);
    expect(unavailable.sort()).toEqual(['reminders', 'secret-state']);
    expect(sources.secrets).toEqual({});
    expect(sources.reminders).toBeNull();
    expect(reminderDoc).toBeNull();
  });

  it('reads lab_certificates and swa_reset documents when present', async () => {
    const store = withMcp({
      'admin_config/lab_certificates': {
        id: 'lab_certificates',
        certificates: {
          labAgent: { notBefore: '2026-09-26T00:00:00.000Z', notAfter: '2027-03-25T00:00:00.000Z' },
          vaultTls: { notBefore: '2026-09-26T00:00:00.000Z', notAfter: '2027-03-25T00:00:00.000Z' },
        },
      },
      'admin_config/swa_reset': {
        id: 'swa_reset',
        lastResetAt: '2026-10-11T03:15:00.000Z',
      },
    });
    const { sources, unavailable } = await readCredentialSources(store);
    expect(unavailable).toEqual([]);
    expect(sources.labCertificates).toEqual({
      labAgent: { notBefore: '2026-09-26T00:00:00.000Z', notAfter: '2027-03-25T00:00:00.000Z' },
      vaultTls: { notBefore: '2026-09-26T00:00:00.000Z', notAfter: '2027-03-25T00:00:00.000Z' },
    });
    expect(sources.swaReset).toEqual({
      lastResetAt: '2026-10-11T03:15:00.000Z',
    });
  });

  it('marks lab-certificates or swa-reset unavailable when malformed or failed', async () => {
    const store = withMcp({
      'admin_config/lab_certificates': { id: 'lab_certificates', certificates: 'bad' },
      'admin_config/swa_reset': { id: 'swa_reset', lastResetAt: 'not-a-date' },
    });
    const { unavailable } = await readCredentialSources(store);
    expect(unavailable).toContain('lab-certificates');
    expect(unavailable).toContain('swa-reset');
  });

  it('marks every MCP server unknown when the projected query fails', async () => {
    const store = withMcp({});
    store.fail('mcp_servers', '*', 'queryDocs', down());
    const { sources, unavailable } = await readCredentialSources(store);
    expect(unavailable.sort()).toEqual(MCP_SERVER_IDS.map((id) => `mcp:${id}`).sort());
    expect(sources.mcp).toEqual({});
  });

  it('reads an empty estate as empty, not as failed', async () => {
    const { sources, unavailable } = await readCredentialSources(withMcp({}));
    expect(unavailable).toEqual([]);
    expect(sources).toMatchObject({ secrets: {}, coder: null, records: {}, reminders: [] });
  });

  it('copies out only lastWriteAt and rotatedOn, so nothing else a stored record holds crosses into sources (review of #1039)', async () => {
    const store = withMcp({
      'admin_config/secret_state': {
        id: 'secret_state',
        secrets: { 'ANTHROPIC-API-KEY': { lastWriteAt: AT, value: LEAK, lastWriteBy: 'admin-1' } },
      },
      'admin_config/credential_register': {
        id: CREDENTIAL_REGISTER_DOC_ID,
        credentials: { 'lab-agent-certificate': { rotatedOn: '2026-09-29', recordedBy: 'admin-1', note: LEAK } },
      },
    });
    const { sources } = await readCredentialSources(store);
    expect(sources.secrets).toEqual({ 'ANTHROPIC-API-KEY': { lastWriteAt: AT } });
    expect(sources.records).toEqual({ 'lab-agent-certificate': { rotatedOn: '2026-09-29' } });
    expect(JSON.stringify(sources)).not.toContain(LEAK);
  });

  it('reads the sheet before any date source, which the reminders sync relies on', async () => {
    const store = withMcp({});
    await readCredentialSources(store);
    const first = Math.min(...store.readDoc.mock.invocationCallOrder);
    const sheetCall = store.readDoc.mock.calls.findIndex((call) => call[1] === 'reminders');
    expect(store.readDoc.mock.invocationCallOrder[sheetCall]).toBe(first);
    expect(store.queryDocs.mock.invocationCallOrder[0]).toBeGreaterThan(first);
  });
});

describe('an MCP server’s record is never read whole (review of #1039)', () => {
  it('asks Cosmos for a projection with no token field in it, and never point-reads the document', async () => {
    const store = withMcp({});
    await readCredentialSources(store);
    expect(store.readDoc.mock.calls.filter((call) => call[0] === 'mcp_servers')).toEqual([]);
    const [container, sql, parameters] = store.queryDocs.mock.calls[0];
    expect(container).toBe('mcp_servers');
    expect(sql).toBe(MCP_SERVER_QUERY);
    expect(parameters).toEqual([{ name: '@ids', value: [...MCP_SERVER_IDS] }]);
    expect(sql).not.toMatch(/\*/);
    // The SELECT list names no secret field; the token appears only inside
    // the presence test Cosmos evaluates, never as a projected value.
    const selectList = sql.slice('SELECT '.length, sql.indexOf(' FROM c'));
    for (const field of ['oauthRefreshToken', 'oauthClientSecret', 'oauthPending', 'apiKey']) {
      expect(selectList).not.toContain(field);
    }
    const withoutPresenceTest = selectList.replace(
      '(IS_STRING(c.oauthToken) AND LENGTH(c.oauthToken) > 0) AS hasToken',
      ''
    );
    expect(withoutPresenceTest).not.toContain('oauthToken');
  });

  it('projects exactly the fields the test emulation answers with, so the two cannot drift', () => {
    const selectList = MCP_SERVER_QUERY.slice('SELECT '.length, MCP_SERVER_QUERY.indexOf(' FROM c'));
    const names = selectList.split(/,\s*(?![^(]*\))/).map((item) => {
      const alias = item.match(/\bAS\s+(\w+)\s*$/);
      return alias ? alias[1] : item.trim().replace(/^c\./, '');
    });
    expect(names).toEqual([...PROJECTED_FIELDS]);
    expect(['id', ...MCP_RECORD_FIELDS]).toEqual([...PROJECTED_FIELDS]);
  });

  it('copies a row field by field, so a token a row carried by mistake goes no further', async () => {
    const store = memoryStore(
      {},
      {
        query: () => [
          { id: 'replicate-mcp', oauthStatus: 'connected', hasToken: true, oauthToken: LEAK, oauthRefreshToken: LEAK },
        ],
      }
    );
    const { sources } = await readCredentialSources(store);
    expect(Object.keys(sources.mcp['replicate-mcp']).sort()).toEqual([...MCP_RECORD_FIELDS].sort());
    expect(JSON.stringify(sources)).not.toContain(LEAK);
  });
});

describe('a present but malformed source is unavailable, never empty (review of #1039)', () => {
  it.each([
    ['a string', 'not a map'],
    ['a list', [{ lastWriteAt: AT }]],
    ['a map with a non-record in it', { 'ANTHROPIC-API-KEY': 'x' }],
    ['missing', undefined],
    ['a record whose lastWriteAt is not a date', { 'ANTHROPIC-API-KEY': { lastWriteAt: 'not-a-date' } }],
    ['a record whose lastWriteAt is a number', { 'ANTHROPIC-API-KEY': { lastWriteAt: 7 } }],
  ])('secret_state whose secrets is %s', async (_label, secrets) => {
    const store = withMcp({ 'admin_config/secret_state': { id: 'secret_state', secrets } });
    const { sources, unavailable } = await readCredentialSources(store);
    expect(unavailable).toEqual(['secret-state']);
    expect(sources.secrets).toEqual({});
  });

  it.each([
    ['a string', 'nope'],
    ['a map with a non-record in it', { 'lab-agent-certificate': '2026-09-29' }],
    ['a record whose rotatedOn is not a date', { 'lab-agent-certificate': { rotatedOn: 'not-a-date' } }],
    ['a record whose rotatedOn is no real day', { 'lab-agent-certificate': { rotatedOn: '2026-02-30' } }],
    ['a record whose rotatedOn is an instant, not a day', { 'lab-agent-certificate': { rotatedOn: AT } }],
  ])('credential_register whose credentials is %s', async (_label, credentials) => {
    const store = withMcp({ 'admin_config/credential_register': { id: CREDENTIAL_REGISTER_DOC_ID, credentials } });
    const { unavailable } = await readCredentialSources(store);
    expect(unavailable).toEqual(['credential-register']);
  });

  it('a sheet whose reminders is not a list', async () => {
    const store = withMcp({ 'admin_config/reminders': { id: 'reminders', reminders: { a: 1 } } });
    const { sources, unavailable, reminderDoc } = await readCredentialSources(store);
    expect(unavailable).toEqual(['reminders']);
    expect(sources.reminders).toBeNull();
    expect(reminderDoc).toBeNull();
  });

  it('while an absent document, or a sheet with no rows yet, reads as empty', async () => {
    const store = withMcp({ 'admin_config/reminders': { id: 'reminders' } });
    const { sources, unavailable } = await readCredentialSources(store);
    expect(unavailable).toEqual([]);
    expect(sources).toMatchObject({ secrets: {}, records: {}, reminders: [] });
  });

  it('labels a source in the tab’s words', () => {
    expect(sourceLabel('secret-state')).toMatch(/Key Vault write dates/);
    expect(sourceLabel('mcp:plaud')).toBe('the plaud MCP server record (mcp_servers)');
  });
});

describe('recordRotation', () => {
  const change = (overrides = {}) => ({
    credentialId: 'lab-agent-certificate',
    rotatedOn: '2026-09-29',
    actor: 'oid-1',
    at: AT,
    ...overrides,
  });

  it('creates the document with one record: a date and who recorded it', async () => {
    const store = memoryStore();
    const record = await recordRotation(store, change());
    expect(record).toEqual({ rotatedOn: '2026-09-29', recordedAt: AT, recordedBy: 'oid-1' });
    expect(store.get('admin_config', CREDENTIAL_REGISTER_DOC_ID)).toMatchObject({
      id: CREDENTIAL_REGISTER_DOC_ID,
      configScope: 'admin_config',
      docType: 'credential_register',
      credentials: { 'lab-agent-certificate': record },
    });
  });

  it('changes one record and keeps every other', async () => {
    const store = memoryStore({
      'admin_config/credential_register': {
        id: CREDENTIAL_REGISTER_DOC_ID,
        credentials: { 'kv-anthropic-api-key': { rotatedOn: '2026-01-01', recordedAt: AT, recordedBy: 'x' } },
      },
    });
    await recordRotation(store, change());
    const { credentials } = store.get('admin_config', CREDENTIAL_REGISTER_DOC_ID);
    expect(Object.keys(credentials).sort()).toEqual(['kv-anthropic-api-key', 'lab-agent-certificate']);
    expect(store.replaceDocIfMatch).toHaveBeenCalledWith(
      'admin_config',
      expect.objectContaining({ _etag: expect.any(String) }),
      { partitionKey: 'admin_config' }
    );
  });

  it('clears a record with a null date', async () => {
    const store = memoryStore({
      'admin_config/credential_register': {
        id: CREDENTIAL_REGISTER_DOC_ID,
        credentials: { 'lab-agent-certificate': { rotatedOn: '2026-01-01' } },
      },
    });
    expect(await recordRotation(store, change({ rotatedOn: null }))).toBeNull();
    expect(store.get('admin_config', CREDENTIAL_REGISTER_DOC_ID).credentials).toEqual({});
  });

  it('reads again and re-applies when another write got there first, so both land', async () => {
    const store = memoryStore({
      'admin_config/credential_register': { id: CREDENTIAL_REGISTER_DOC_ID, credentials: {} },
    });
    // Another record lands between this write's read and its replace.
    const realRead = store.readDoc.getMockImplementation();
    let raced = false;
    store.readDoc.mockImplementation(async (...args) => {
      const doc = await realRead(...args);
      if (!raced) {
        raced = true;
        const current = store.get('admin_config', CREDENTIAL_REGISTER_DOC_ID);
        await store.replaceDocIfMatch('admin_config', {
          ...current,
          credentials: { 'kv-anthropic-api-key': { rotatedOn: '2026-02-02' } },
        });
      }
      return doc;
    });
    await recordRotation(store, change(), { sleep: noSleep });
    expect(Object.keys(store.get('admin_config', CREDENTIAL_REGISTER_DOC_ID).credentials).sort()).toEqual([
      'kv-anthropic-api-key',
      'lab-agent-certificate',
    ]);
  });

  it('treats a lost create as a race too', async () => {
    const store = memoryStore();
    store.fail('admin_config', CREDENTIAL_REGISTER_DOC_ID, 'createDoc', Object.assign(new Error('x'), { code: 409 }));
    await recordRotation(store, change(), { sleep: noSleep });
    expect(store.createDoc).toHaveBeenCalledTimes(2);
    expect(store.get('admin_config', CREDENTIAL_REGISTER_DOC_ID).credentials['lab-agent-certificate']).toBeTruthy();
  });

  it('gives up with CONFLICT after every attempt lost, and names no credential', async () => {
    const store = memoryStore({
      'admin_config/credential_register': { id: CREDENTIAL_REGISTER_DOC_ID, credentials: {} },
    });
    store.fail(
      'admin_config',
      CREDENTIAL_REGISTER_DOC_ID,
      'replaceDocIfMatch',
      Object.assign(new Error('x'), { code: 412 }),
      3
    );
    const error = await recordRotation(store, change(), { attempts: 3, sleep: noSleep }).catch((e) => e);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).not.toContain('lab-agent');
  });

  it('refuses to write over a malformed document, which it would otherwise replace with one record', async () => {
    const malformed = { id: CREDENTIAL_REGISTER_DOC_ID, credentials: 'hand-edited' };
    const store = memoryStore({ 'admin_config/credential_register': malformed });
    const error = await recordRotation(store, change(), { sleep: noSleep }).catch((e) => e);
    expect(error.code).toBe('MALFORMED');
    expect(error.message).not.toContain('lab-agent');
    expect(store.get('admin_config', CREDENTIAL_REGISTER_DOC_ID).credentials).toBe('hand-edited');
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('refuses to write over a register whose stored date is malformed, too (review of #1039)', async () => {
    const malformed = { id: CREDENTIAL_REGISTER_DOC_ID, credentials: { other: { rotatedOn: 'not-a-date' } } };
    const store = memoryStore({ 'admin_config/credential_register': malformed });
    const error = await recordRotation(store, change(), { sleep: noSleep }).catch((e) => e);
    expect(error.code).toBe('MALFORMED');
    expect(store.get('admin_config', CREDENTIAL_REGISTER_DOC_ID).credentials).toEqual(malformed.credentials);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('throws any other store error at once', async () => {
    const store = memoryStore();
    store.fail('admin_config', CREDENTIAL_REGISTER_DOC_ID, 'createDoc', down());
    const sleep = vi.fn(noSleep);
    await expect(recordRotation(store, change(), { sleep })).rejects.toMatchObject({ code: 503 });
    expect(sleep).not.toHaveBeenCalled();
  });
});
