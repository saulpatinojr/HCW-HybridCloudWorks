/**
 * The register's shape, and the pin that keeps its Key Vault part and the
 * Keys tab's catalogue one list (#1026).
 */
import { describe, it, expect } from 'vitest';

import { SECRET_CATALOG } from '../secret-catalog.js';
import { MAX_LEAD_DAYS } from '../reminders/settings.js';
import {
  HAND_ROTATION_DAYS,
  CREDENTIAL_REGISTER,
  CREDENTIAL_STORES,
  KEY_VAULT_METADATA_NAMES,
  LAB_CERTIFICATE_DAYS,
  RENEWAL,
  SWA_TOKEN_RESET_DAYS,
  findCredential,
  isCredentialStore,
  isRecordable,
  keyVaultCredentialId,
} from './register.js';
import { dueSoonDays } from './status.js';

describe('the Key Vault part is the catalogue, whole', () => {
  it('has a row for every secret the Keys tab can seed', () => {
    const inRegister = new Set(
      CREDENTIAL_REGISTER.filter((entry) => entry.store === 'key-vault').map((entry) => entry.name)
    );
    const missing = SECRET_CATALOG.map((entry) => entry.secret).filter((name) => !inRegister.has(name));
    expect(missing, 'catalogue secrets with no register row').toEqual([]);
  });

  it('has no Key Vault row the catalogue does not declare', () => {
    const catalogued = new Set(SECRET_CATALOG.map((entry) => entry.secret));
    const extra = CREDENTIAL_REGISTER.filter(
      (entry) => entry.store === 'key-vault' && !catalogued.has(entry.name)
    ).map((entry) => entry.name);
    expect(extra).toEqual([]);
  });

  it('names exactly the catalogue in its metadata, so a new or retired secret fails here', () => {
    // A secret added to the catalogue without metadata would still get a row
    // (issuer "Unknown"); this is what refuses that, and a stale row for a
    // secret the catalogue retired.
    expect([...KEY_VAULT_METADATA_NAMES].sort()).toEqual(
      SECRET_CATALOG.map((entry) => entry.secret).sort()
    );
    expect(CREDENTIAL_REGISTER.filter((entry) => entry.issuer === 'Unknown')).toEqual([]);
  });

  it('points each Key Vault row at its own secret_state record', () => {
    for (const entry of CREDENTIAL_REGISTER.filter((e) => e.store === 'key-vault')) {
      expect(entry.id).toBe(keyVaultCredentialId(entry.name));
      expect(entry.source.secret).toBe(entry.name);
    }
  });
});

describe('every entry', () => {
  it('has a unique id the reminders sheet can carry as credential-<id>', () => {
    const ids = CREDENTIAL_REGISTER.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      // The sheet's id pattern allows 64; the prefix takes 11.
      expect(`credential-${id}`.length).toBeLessThanOrEqual(64);
    }
  });

  it('names a known store and renewal, a consumer and an issuer', () => {
    for (const entry of CREDENTIAL_REGISTER) {
      expect(isCredentialStore(entry.store), entry.id).toBe(true);
      expect(RENEWAL, entry.id).toContain(entry.renewal);
      expect(entry.name.trim(), entry.id).not.toBe('');
      expect(entry.consumer.trim(), entry.id).not.toBe('');
      expect(entry.issuer.trim(), entry.id).not.toBe('');
    }
  });

  it('carries a whole number of days or null as its rule, longer than its warning window', () => {
    for (const entry of CREDENTIAL_REGISTER) {
      if (entry.lifetimeDays !== null) {
        expect(Number.isInteger(entry.lifetimeDays), entry.id).toBe(true);
        // A reminder's lead days are the window, and the sheet caps them.
        expect(entry.lifetimeDays, entry.id).toBeGreaterThan(dueSoonDays(entry));
        expect(dueSoonDays(entry), entry.id).toBeLessThanOrEqual(MAX_LEAD_DAYS);
      }
    }
  });

  it('says how to rotate anything someone or something rotates', () => {
    for (const entry of CREDENTIAL_REGISTER.filter((e) => ['hand', 'automation'].includes(e.renewal))) {
      expect(typeof entry.rotate, entry.id).toBe('string');
      expect(entry.rotate.length, entry.id).toBeGreaterThan(10);
    }
  });

  it('is frozen, source included', () => {
    expect(Object.isFrozen(CREDENTIAL_REGISTER)).toBe(true);
    for (const entry of CREDENTIAL_REGISTER) {
      expect(Object.isFrozen(entry)).toBe(true);
      if (entry.source) expect(Object.isFrozen(entry.source)).toBe(true);
    }
  });

  it('holds no value: no field is shaped like one', () => {
    // Names and metadata only. Nothing here should look like a key, a PEM
    // or a JWT; this is the cheap check that a paste never landed in code.
    const text = JSON.stringify(CREDENTIAL_REGISTER);
    expect(text).not.toMatch(/-----BEGIN/);
    expect(text).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}/);
    expect(text).not.toMatch(/\b(sk|nvapi|ghp|gho|github_pat)[-_][A-Za-z0-9]{12,}/);
  });
});

describe('the issue’s list', () => {
  const reminderBearing = CREDENTIAL_REGISTER.filter(
    (entry) => entry.renewal === 'hand' && Number.isInteger(entry.lifetimeDays)
  )
    .map((entry) => entry.id)
    .sort();

  it('gives exactly the hand-only credentials it names a rule, and so a reminder', () => {
    expect(reminderBearing).toEqual(
      [
        'kv-anthropic-api-key',
        'kv-telegram-bot-token',
        'gh-manifest-app-private-key',
        'gh-copilot-review-app-private-key',
        'lab-coder-github-oauth-secret',
        'azure-swa-deployment-token',
        'lab-agent-certificate',
        'lab-vault-tls-certificate',
      ].sort()
    );
  });

  it('uses the rules the repository states', () => {
    expect(findCredential('azure-swa-deployment-token').lifetimeDays).toBe(SWA_TOKEN_RESET_DAYS);
    expect(SWA_TOKEN_RESET_DAYS).toBe(90);
    expect(findCredential('lab-agent-certificate').lifetimeDays).toBe(LAB_CERTIFICATE_DAYS);
    expect(findCredential('lab-vault-tls-certificate').lifetimeDays).toBe(LAB_CERTIFICATE_DAYS);
    expect(LAB_CERTIFICATE_DAYS).toBe(180);
    // The owner's rule for the hand-only ones that never expire (2026-10-09).
    expect(HAND_ROTATION_DAYS).toBe(180);
    for (const id of [
      'kv-anthropic-api-key',
      'kv-telegram-bot-token',
      'gh-manifest-app-private-key',
      'gh-copilot-review-app-private-key',
      'lab-coder-github-oauth-secret',
    ]) {
      expect(findCredential(id).lifetimeDays, id).toBe(HAND_ROTATION_DAYS);
    }
  });

  it('marks the Coder tokens as renewed by the lab host, with their lifetimes', () => {
    const status = findCredential('kv-coder-status-token');
    expect(status.renewal).toBe('automation');
    expect(status.lifetimeDays).toBe(90);
    expect(status.source).toEqual({ secret: 'CODER-STATUS-TOKEN', coder: 'statusToken' });
    const rotation = findCredential('lab-coder-rotation-credential');
    expect(rotation.renewal).toBe('automation');
    expect(rotation.lifetimeDays).toBe(365);
    expect(rotation.source).toEqual({ coder: 'rotationToken' });
  });

  it('keeps the MCP OAuth connections, renewed by their timer', () => {
    for (const [id, server] of [
      ['mcp-plaud', 'plaud'],
      ['mcp-replicate', 'replicate-mcp'],
      ['mcp-hostinger', 'hostinger-mcp'],
    ]) {
      expect(findCredential(id).renewal).toBe('automation');
      expect(findCredential(id).source).toEqual({ mcpServer: server });
    }
  });

  it('marks the Cloudflare API tokens as renewed by automation', () => {
    for (const id of [
      'tfc-azure-cloudflare-api-token',
      'tfc-lab-cloudflare-api-token',
      'lab-caddy-cloudflare-api-token',
    ]) {
      const entry = findCredential(id);
      expect(entry.renewal, id).toBe('automation');
      expect(entry.lifetimeDays, id).toBeNull();
      expect(entry.rotate, id).toMatch(/roll-token|roll-cloudflare-tokens/i);
      expect(isRecordable(entry), id).toBe(false);
    }
  });

  it('marks Google API keys and AWS pricing access keys as renewed by automation', () => {
    for (const id of [
      'kv-gemini-api-key',
      'kv-youtube-api-key',
      'kv-gcp-billing-api-key',
      'kv-aws-access-key-id',
      'kv-aws-secret-access-key',
    ]) {
      const entry = findCredential(id);
      expect(entry.renewal, id).toBe('automation');
      expect(entry.lifetimeDays, id).toBeNull();
      expect(entry.rotate, id).toMatch(/roll-cloud-credentials/i);
      expect(isRecordable(entry), id).toBe(false);
    }
  });

  it('calls an identifier an identifier, not a credential to rotate', () => {
    for (const name of ['TELEGRAM-CHAT-ID', 'PUBLER-WORKSPACE-ID', 'PODBEAN-CLIENT-ID', 'CODER-URL']) {
      expect(findCredential(keyVaultCredentialId(name)).renewal).toBe('none');
    }
  });
});

describe('lookups', () => {
  it('finds by id and nothing else', () => {
    expect(findCredential('kv-anthropic-api-key').name).toBe('ANTHROPIC-API-KEY');
    expect(findCredential('constructor')).toBeUndefined();
    expect(findCredential(undefined)).toBeUndefined();
  });

  it('lets only a hand-renewed credential take a recorded rotation', () => {
    expect(isRecordable(findCredential('kv-anthropic-api-key'))).toBe(true);
    expect(isRecordable(findCredential('lab-agent-certificate'))).toBe(true);
    expect(isRecordable(findCredential('kv-coder-status-token'))).toBe(false);
    expect(isRecordable(findCredential('gh-oidc-production'))).toBe(false);
    expect(isRecordable(findCredential('kv-telegram-chat-id'))).toBe(false);
  });

  it('lists every store an entry uses, and no unused one', () => {
    const used = new Set(CREDENTIAL_REGISTER.map((entry) => entry.store));
    expect(CREDENTIAL_STORES.map((store) => store.id).filter((id) => !used.has(id))).toEqual([]);
  });
});
