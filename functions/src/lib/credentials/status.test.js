/**
 * Age, expiry and state, against a fixed clock (#1026). Every date here is
 * chosen relative to NOW so the boundaries read off the page.
 */
import { describe, it, expect } from 'vitest';

import { projectMcpServers } from '../../../test/mcp-projection.js';
import { oauthConnectionState } from '../ai/mcp-oauth.js';
import { findCredential } from './register.js';
import {
  CREDENTIAL_STATES,
  DUE_SOON_DAYS,
  SHORT_DUE_SOON_DAYS,
  buildRegisterView,
  computeCredentialStatus,
  countStates,
  dueSoonDays,
  mcpConnection,
  presentCredential,
  resolveLive,
  sourcesOf,
} from './status.js';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const daysAhead = (n) => new Date(NOW + n * DAY).toISOString();

const anthropic = findCredential('kv-anthropic-api-key'); // hand, 180
const swa = findCredential('azure-swa-deployment-token'); // hand, 90
const openai = findCredential('kv-openai-api-key'); // hand, no rule
const coderStatus = findCredential('kv-coder-status-token'); // automation, 90, live
const rotation = findCredential('lab-coder-rotation-credential'); // automation, 365, live
const chatId = findCredential('kv-telegram-chat-id'); // none
const oidc = findCredential('gh-oidc-production'); // self

const status = (entry, sources) => computeCredentialStatus(entry, resolveLive(entry, sources), NOW);

describe('dueSoonDays', () => {
  it('is a month, and two weeks for a rule shorter than half a year', () => {
    expect(dueSoonDays(anthropic)).toBe(DUE_SOON_DAYS);
    expect(dueSoonDays(swa)).toBe(SHORT_DUE_SOON_DAYS);
    expect(dueSoonDays(openai)).toBe(DUE_SOON_DAYS);
  });
});

describe('resolveLive', () => {
  it('takes the Keys tab’s last write for a Key Vault secret', () => {
    const live = resolveLive(anthropic, { secrets: { 'ANTHROPIC-API-KEY': { lastWriteAt: daysAgo(10) } } });
    expect(live).toMatchObject({ lastRotatedAt: daysAgo(10), lastRotatedSource: 'key-vault', expiresAt: null });
  });

  it('takes the later of the Keys tab’s write and the owner’s record', () => {
    const sources = {
      secrets: { 'ANTHROPIC-API-KEY': { lastWriteAt: '2026-01-02T10:00:00.000Z' } },
      records: { 'kv-anthropic-api-key': { rotatedOn: '2026-03-01' } },
    };
    expect(resolveLive(anthropic, sources)).toMatchObject({
      lastRotatedAt: '2026-03-01T00:00:00.000Z',
      lastRotatedSource: 'owner',
      recordedOn: '2026-03-01',
    });
    sources.secrets['ANTHROPIC-API-KEY'].lastWriteAt = '2026-04-01T10:00:00.000Z';
    expect(resolveLive(anthropic, sources).lastRotatedSource).toBe('key-vault');
  });

  it('ignores a recorded date for a credential that takes none, and a date that is not one', () => {
    expect(resolveLive(coderStatus, { records: { 'kv-coder-status-token': { rotatedOn: '2026-10-01' } } }))
      .toMatchObject({ lastRotatedAt: null, recordedOn: null });
    expect(resolveLive(anthropic, { records: { 'kv-anthropic-api-key': { rotatedOn: '2026-02-30' } } }))
      .toMatchObject({ lastRotatedAt: null, recordedOn: null });
  });

  it('reads the lab host’s report for the Coder tokens', () => {
    const coder = {
      statusTokenRotatedAt: daysAgo(3),
      statusTokenExpiresAt: daysAhead(87),
      rotationTokenExpiresAt: daysAhead(200),
    };
    expect(resolveLive(coderStatus, { coder })).toMatchObject({
      lastRotatedAt: daysAgo(3),
      lastRotatedSource: 'lab-host',
      expiresAt: daysAhead(87),
    });
    expect(resolveLive(rotation, { coder })).toMatchObject({ lastRotatedAt: null, expiresAt: daysAhead(200) });
  });

  it('reads Key Vault createdAt when lastWriteAt is not set', () => {
    const live = resolveLive(anthropic, { secrets: { 'ANTHROPIC-API-KEY': { createdAt: daysAgo(20) } } });
    expect(live).toMatchObject({ lastRotatedAt: daysAgo(20), lastRotatedSource: 'key-vault', expiresAt: null });
  });

  it('reads the lab host report for certificates', () => {
    const labCert = findCredential('lab-agent-certificate');
    const vaultCert = findCredential('lab-vault-tls-certificate');
    const labCertificates = {
      labAgent: { notBefore: daysAgo(10), notAfter: daysAhead(170) },
      vaultTls: { notBefore: daysAgo(15), notAfter: daysAhead(165) },
    };
    expect(resolveLive(labCert, { labCertificates })).toMatchObject({
      lastRotatedAt: daysAgo(10),
      lastRotatedSource: 'lab-host',
      expiresAt: daysAhead(170),
    });
    expect(resolveLive(vaultCert, { labCertificates })).toMatchObject({
      lastRotatedAt: daysAgo(15),
      lastRotatedSource: 'lab-host',
      expiresAt: daysAhead(165),
    });
  });

  it('reads SWA reset log for SWA deployment token', () => {
    const swaReset = { lastResetAt: daysAgo(5) };
    expect(resolveLive(swa, { swaReset })).toMatchObject({
      lastRotatedAt: daysAgo(5),
      lastRotatedSource: 'azure',
    });
  });

  it('reads an OAuth Connect server’s projected record: its connection and refresh time', () => {
    const record = {
      oauthStatus: 'connected',
      oauthConnectedAt: daysAgo(5),
      oauthRefreshedAt: daysAgo(1),
      hasToken: true,
    };
    const live = resolveLive(findCredential('mcp-replicate'), { mcp: { 'replicate-mcp': record } });
    expect(live).toEqual({
      lastRotatedAt: daysAgo(1),
      lastRotatedSource: 'oauth',
      recordedOn: null,
      expiresAt: null,
      connection: 'connected',
    });
  });

  it('tells a failed read (unknown) from an absent document (not connected)', () => {
    const replicate = findCredential('mcp-replicate');
    expect(resolveLive(replicate, { mcp: {} }).connection).toBeNull();
    expect(resolveLive(replicate, { mcp: { 'replicate-mcp': null } }).connection).toBe('not_connected');
    expect(
      resolveLive(replicate, { mcp: { 'replicate-mcp': { oauthStatus: 'disconnected', hasToken: false } } })
        .connection
    ).toBe('expired');
  });

  it('reads Plaud’s pasted token by its own fields', () => {
    const plaud = findCredential('mcp-plaud');
    const connected = { hasToken: true, status: 'connected', lastTokenRefresh: daysAgo(0.5) };
    expect(resolveLive(plaud, { mcp: { plaud: connected } })).toMatchObject({
      connection: 'connected',
      lastRotatedAt: daysAgo(0.5),
    });
    expect(resolveLive(plaud, { mcp: { plaud: { hasToken: true, status: 'disconnected' } } }).connection).toBe(
      'expired'
    );
    expect(resolveLive(plaud, { mcp: { plaud: { status: 'untested', hasToken: false } } }).connection).toBe(
      'not_connected'
    );
  });

  it('reads a connection exactly as mcp-oauth.js does, from the projection instead of the document', () => {
    // The rule is oauthConnectionState's; this holds the two to one answer
    // for every shape a Connect server's document takes.
    const documents = [
      { id: 'replicate-mcp', oauthToken: 't', oauth: { status: 'connected' } },
      { id: 'replicate-mcp', oauthToken: '', oauth: { status: 'connected' } },
      { id: 'replicate-mcp', oauth: { status: 'connected' } },
      { id: 'replicate-mcp', oauthToken: 't', oauth: { status: 'disconnected' } },
      { id: 'replicate-mcp', oauth: { status: 'pending' } },
      { id: 'replicate-mcp' },
    ];
    for (const doc of documents) {
      const [row] = projectMcpServers({
        container: 'mcp_servers',
        parameters: [{ name: '@ids', value: ['replicate-mcp'] }],
        docs: [doc],
      });
      const record = { oauthStatus: row.oauthStatus ?? null, hasToken: row.hasToken };
      expect(mcpConnection('replicate-mcp', { 'replicate-mcp': record }), JSON.stringify(doc)).toBe(
        oauthConnectionState(doc)
      );
    }
  });
});

describe('computeCredentialStatus', () => {
  it('estimates a hand credential’s next rotation from its rule and last rotation', () => {
    const result = status(anthropic, { secrets: { 'ANTHROPIC-API-KEY': { lastWriteAt: daysAgo(100) } } });
    expect(result).toMatchObject({
      ageDays: 100,
      expiresAt: daysAhead(80),
      expiryEstimated: true,
      daysLeft: 80,
      state: 'ok',
    });
    expect(result.reason).toBe(`Next rotation due on ${daysAhead(80).slice(0, 10)}.`);
  });

  it('turns due-soon inside the window and overdue past the date', () => {
    const at = (age) => status(anthropic, { secrets: { 'ANTHROPIC-API-KEY': { lastWriteAt: daysAgo(age) } } });
    // 180 days is not shorter than half a year, so the window is a month.
    expect(at(180 - 31).state).toBe('ok');
    expect(at(180 - 30)).toMatchObject({ state: 'due-soon', daysLeft: 30 });
    expect(at(180 - 30).reason).toMatch(/^Rotation due in 30 days, on \d{4}-\d{2}-\d{2}\.$/);
    expect(at(180)).toMatchObject({ state: 'overdue', daysLeft: 0 });
    expect(at(215)).toMatchObject({ state: 'overdue', daysLeft: -35 });
    expect(at(215).reason).toMatch(/^Rotation was due on /);
  });

  it('uses the short window for the 90-day reset', () => {
    const at = (age) => status(swa, { records: { 'azure-swa-deployment-token': { rotatedOn: daysAgo(age).slice(0, 10) } } });
    expect(at(90 - 16).state).toBe('ok');
    expect(at(90 - 14).state).toBe('due-soon');
  });

  it('is unknown for a hand credential with a rule and no date, and says what to do', () => {
    expect(status(anthropic, {})).toMatchObject({
      state: 'unknown',
      ageDays: null,
      expiresAt: null,
      reason: 'No rotation date is known: record when it was last rotated.',
    });
  });

  it('is ok for a hand credential with no rule, whatever its age', () => {
    expect(status(openai, { secrets: { 'OPENAI-API-KEY': { lastWriteAt: daysAgo(900) } } })).toMatchObject({
      state: 'ok',
      ageDays: 900,
      expiresAt: null,
    });
  });

  it('judges an automation credential by its report, and never estimates one', () => {
    // The hand-minted year-long token, written 200 days ago with no report:
    // an estimate from 90 days would call it overdue. It is unknown.
    const unreported = status(coderStatus, {
      secrets: { 'CODER-STATUS-TOKEN': { lastWriteAt: daysAgo(200) } },
    });
    expect(unreported).toMatchObject({ state: 'unknown', ageDays: 200, expiresAt: null });
    const reported = status(coderStatus, {
      coder: { statusTokenRotatedAt: daysAgo(1), statusTokenExpiresAt: daysAhead(10) },
    });
    expect(reported).toMatchObject({ state: 'due-soon', expiryEstimated: false, daysLeft: 10 });
    expect(reported.reason).toMatch(/^Expires in 10 days, on /);
    expect(status(rotation, { coder: { rotationTokenExpiresAt: daysAgo(1) } })).toMatchObject({
      state: 'overdue',
      reason: `Expired on ${daysAgo(1).slice(0, 10)}.`,
    });
  });

  it('is overdue for a signed-out connection and unknown for one never made', () => {
    const replicate = findCredential('mcp-replicate');
    expect(
      status(replicate, { mcp: { 'replicate-mcp': { oauthStatus: 'disconnected', hasToken: false } } }).state
    ).toBe('overdue');
    expect(status(replicate, { mcp: { 'replicate-mcp': null } }).state).toBe('unknown');
    expect(status(replicate, { mcp: {} })).toMatchObject({
      state: 'unknown',
      reason: 'Its connection could not be read.',
    });
    expect(
      status(replicate, { mcp: { 'replicate-mcp': { oauthStatus: 'connected', hasToken: true } } }).state
    ).toBe('ok');
  });

  it('never flags an identifier or a self-renewing identity', () => {
    expect(status(chatId, {}).state).toBe('ok');
    expect(status(oidc, {}).state).toBe('ok');
  });
});

describe('presentCredential and the view', () => {
  it('names every field and carries nothing a source adds', () => {
    const row = presentCredential(
      anthropic,
      { secrets: { 'ANTHROPIC-API-KEY': { lastWriteAt: daysAgo(1), value: 'LEAK', lastWriteVersion: 'v9' } } },
      NOW
    );
    expect(Object.keys(row).sort()).toEqual(
      [
        'ageDays',
        'connection',
        'consumer',
        'daysLeft',
        'dueSoonDays',
        'expiresAt',
        'expiryEstimated',
        'id',
        'issuer',
        'lastRotatedAt',
        'lastRotatedSource',
        'lifetimeDays',
        'name',
        'reason',
        'recordable',
        'recordedOn',
        'renewal',
        'rotate',
        'sourceUnavailable',
        'state',
        'store',
      ].sort()
    );
    expect(JSON.stringify(row)).not.toContain('LEAK');
    expect(row.sourceUnavailable).toBeNull();
  });

  it('presents the whole register and counts its states', () => {
    const view = buildRegisterView({}, NOW);
    expect(view.credentials.length).toBeGreaterThan(50);
    const counts = countStates(view.credentials);
    expect(Object.keys(counts)).toEqual(CREDENTIAL_STATES);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(view.credentials.length);
    expect(view.counts).toEqual(counts);
  });
});

describe('a source that could not be read (review of #1039)', () => {
  const recorded = { records: { 'kv-anthropic-api-key': { rotatedOn: '2026-09-01' } } };

  it('names the sources each entry’s dates come from', () => {
    expect(sourcesOf(anthropic)).toEqual(['secret-state', 'credential-register']);
    expect(sourcesOf(coderStatus)).toEqual(['secret-state', 'coder-automation']);
    expect(sourcesOf(findCredential('lab-agent-certificate'))).toEqual(['lab-certificates', 'credential-register']);
    expect(sourcesOf(findCredential('azure-swa-deployment-token'))).toEqual(['swa-reset', 'credential-register']);
    expect(sourcesOf(findCredential('mcp-plaud'))).toEqual(['mcp:plaud']);
    expect(sourcesOf(oidc)).toEqual([]);
  });

  it('shows a Key Vault credential unknown, with nothing computed, when secret_state could not be read', () => {
    // Without the guard, the owner's date alone would date this key, though a
    // later Key Vault write nobody could read may exist.
    expect(presentCredential(anthropic, recorded, NOW).state).toBe('ok');
    const row = presentCredential(anthropic, recorded, NOW, ['secret-state']);
    expect(row).toMatchObject({
      state: 'unknown',
      sourceUnavailable: 'secret-state',
      lastRotatedAt: null,
      lastRotatedSource: null,
      ageDays: null,
      expiresAt: null,
      expiryEstimated: false,
      daysLeft: null,
      recordedOn: '2026-09-01',
      reason: 'Its Key Vault write date could not be read, so its age and expiry are not shown.',
    });
  });

  it('leaves a credential that does not read the missing source alone, and counts after the change', () => {
    const sources = {
      ...recorded,
      records: { ...recorded.records, 'lab-agent-certificate': { rotatedOn: '2026-09-29' } },
    };
    const whole = buildRegisterView(sources, NOW);
    const partial = buildRegisterView(sources, NOW, ['secret-state']);
    const byId = (view) => Object.fromEntries(view.credentials.map((c) => [c.id, c]));
    expect(byId(partial)['lab-agent-certificate']).toEqual(byId(whole)['lab-agent-certificate']);
    expect(partial.counts).toEqual(countStates(partial.credentials));
    expect(partial.counts.unknown).toBeGreaterThan(whole.counts.unknown);
  });

  it('reads the recorded date as unknown too when the register document could not be read', () => {
    const row = presentCredential(findCredential('lab-agent-certificate'), {}, NOW, ['credential-register']);
    expect(row).toMatchObject({ state: 'unknown', sourceUnavailable: 'credential-register', recordedOn: null });
  });
});
