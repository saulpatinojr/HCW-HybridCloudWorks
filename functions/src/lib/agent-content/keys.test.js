/**
 * The pure half of the agent key (keys.js, ADR 0037): the key's shape, the
 * hash and its constant-time match, the record a Generate writes and what the
 * tab is told about it, the capability switches, and the per-minute counter's
 * key and Retry-After.
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_USER,
  CAPABILITY_IDS,
  KEY_PREFIX,
  KEY_RECORD_ID,
  AgentContentInputError,
  buildKeyRecord,
  defaultCapabilities,
  enabledCapabilities,
  generateKey,
  hashKey,
  hashMatches,
  isUsable,
  keyHint,
  looksLikeKey,
  minuteBucket,
  normalizeCapabilities,
  presentKeyRecord,
  quotaKeyFor,
  secondsToNextMinute,
} from './keys.js';

const NOW = () => new Date('2026-10-31T12:00:00.000Z');

describe('the key', () => {
  it('is the prefix and 32 random bytes in base64url, and looks like itself', () => {
    const key = generateKey();
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    expect(key.slice(KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(looksLikeKey(key)).toBe(true);
    expect(generateKey()).not.toBe(key);
  });

  it('refuses anything that is not shaped like a key before any read', () => {
    for (const value of [
      '',
      null,
      undefined,
      'eyJhbGciOiJSUzI1NiJ9.e30.sig', // an Entra token
      'hcwk_',
      'hcwk_short',
      `hcwk_${'a'.repeat(43)}!`,
      `other_${'a'.repeat(43)}`,
    ]) {
      expect(looksLikeKey(value)).toBe(false);
    }
  });

  it('hashes to 64 hex characters, matches itself and nothing else', () => {
    const key = generateKey();
    const hash = hashKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMatches(key, hash)).toBe(true);
    expect(hashMatches(generateKey(), hash)).toBe(false);
    expect(hashMatches(key, hash.slice(1))).toBe(false);
    expect(hashMatches(key, null)).toBe(false);
  });

  it('shows the prefix and eight characters as its hint', () => {
    expect(keyHint(`${KEY_PREFIX}abcdefghijklmnop`)).toBe(`${KEY_PREFIX}abcdefgh`);
  });
});

describe('the record', () => {
  it('keeps the hash and the hint, never the key, with every capability on', () => {
    const secret = generateKey();
    const record = buildKeyRecord({ secret, actor: 'owner@hcw.dev', now: NOW });
    expect(record.id).toBe(KEY_RECORD_ID);
    expect(record.configScope).toBe('admin_config');
    expect(record.keyHash).toBe(hashKey(secret));
    expect(record.keyHint).toBe(keyHint(secret));
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(record.createdBy).toBe('owner@hcw.dev');
    expect(record.createdAt).toBe('2026-10-31T12:00:00.000Z');
    expect(record.rotatedAt).toBeNull();
    expect(record.revokedAt).toBeNull();
    expect(record.capabilities).toEqual(defaultCapabilities());
    expect(isUsable(record)).toBe(true);
  });

  it('a rotation keeps the first creation and the switches, and stamps the rotation', () => {
    const previous = {
      ...buildKeyRecord({ secret: generateKey(), actor: 'first@hcw.dev', now: () => new Date('2026-10-01T00:00:00.000Z') }),
      capabilities: { ...defaultCapabilities(), 'drafts.delete': false },
    };
    const next = buildKeyRecord({ secret: generateKey(), actor: 'second@hcw.dev', now: NOW, previous });
    expect(next.createdAt).toBe('2026-10-01T00:00:00.000Z');
    expect(next.createdBy).toBe('first@hcw.dev');
    expect(next.rotatedAt).toBe('2026-10-31T12:00:00.000Z');
    expect(next.rotatedBy).toBe('second@hcw.dev');
    expect(next.capabilities['drafts.delete']).toBe(false);
    expect(next.keyHash).not.toBe(previous.keyHash);
  });

  it('is not usable without a hash or once revoked', () => {
    const record = buildKeyRecord({ secret: generateKey(), actor: 'a', now: NOW });
    expect(isUsable(null)).toBe(false);
    expect(isUsable({ ...record, keyHash: undefined })).toBe(false);
    expect(isUsable({ ...record, revokedAt: '2026-10-31T13:00:00.000Z' })).toBe(false);
  });

  it('is presented to the tab field by field, without the hash', () => {
    const record = buildKeyRecord({ secret: generateKey(), actor: 'a', now: NOW });
    const shown = presentKeyRecord({ ...record, somethingNew: 'not shown' });
    expect(shown).toEqual({
      present: true,
      active: true,
      keyHint: record.keyHint,
      createdAt: record.createdAt,
      createdBy: 'a',
      rotatedAt: null,
      rotatedBy: null,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      capabilities: defaultCapabilities(),
    });
    expect(JSON.stringify(shown)).not.toContain(record.keyHash);
    expect(presentKeyRecord(null)).toEqual({
      present: false,
      active: false,
      capabilities: defaultCapabilities(),
    });
  });
});

describe('the capabilities', () => {
  it('merge a change over the stored switches and refuse unknown ids and non-booleans by name', () => {
    const next = normalizeCapabilities({ 'drafts.delete': false }, { 'drafts.review': false });
    expect(next).toEqual({ ...defaultCapabilities(), 'drafts.review': false, 'drafts.delete': false });
    expect(() => normalizeCapabilities({ publish: true })).toThrow(AgentContentInputError);
    expect(() => normalizeCapabilities({ publish: true })).toThrow('Not a capability: publish');
    expect(() => normalizeCapabilities({ 'drafts.read': 'yes' })).toThrow('drafts.read must be true or false');
    expect(() => normalizeCapabilities([])).toThrow(AgentContentInputError);
  });

  it('a record with no switches has every capability; a switch off removes one', () => {
    expect(enabledCapabilities({})).toEqual([...CAPABILITY_IDS]);
    expect(enabledCapabilities({ capabilities: { 'published.read': false } })).toEqual(
      CAPABILITY_IDS.filter((id) => id !== 'published.read'),
    );
  });

  it('has no publish, slug or settings capability to switch on', () => {
    expect(CAPABILITY_IDS.some((id) => /publish|slug|setting|secret|admin/.test(id) && id !== 'published.read')).toBe(false);
  });
});

describe('the identity and the counter', () => {
  it('records Koda as the editor the Drafts routes name', () => {
    // drafts-handlers.js editorOf: email, preferred_username, oid, sub.
    expect(AGENT_USER.email).toBeNull();
    expect(AGENT_USER.preferred_username).toBe('koda (agent)');
    expect(AGENT_USER.oid).toBe('agent:koda');
  });

  it('counts per minute, and says how long until the next one', () => {
    const t = Date.parse('2026-10-31T12:00:15.000Z');
    expect(minuteBucket(t)).toBe(Math.floor(t / 60_000));
    expect(quotaKeyFor(t)).toBe(`agent-content:koda:${Math.floor(t / 60_000)}`);
    expect(quotaKeyFor(t + 44_999)).toBe(quotaKeyFor(t));
    expect(quotaKeyFor(t + 45_000)).not.toBe(quotaKeyFor(t));
    expect(secondsToNextMinute(t)).toBe(45);
    expect(secondsToNextMinute(Date.parse('2026-10-31T12:00:59.900Z'))).toBe(1);
    expect(secondsToNextMinute(Date.parse('2026-10-31T12:00:00.000Z'))).toBe(60);
  });
});
