import { describe, it, expect } from 'vitest';
import {
  KEY_PREFIX,
  SCOPE_IDS,
  buildKeyRecord,
  developerKeyFrom,
  generateKey,
  hashKey,
  hashMatches,
  isKeyId,
  isUsable,
  keyHint,
  keyRecordId,
  looksLikeKey,
  normalizeKeyRequest,
  normalizeScopes,
  organizerUser,
  parseKey,
  presentKeyRecord,
  quotaKeyFor,
  scopesOf,
  secondsToNextMinute,
} from './keys.js';
import { looksLikeKey as looksLikeAgentKey } from '../agent-content/keys.js';
import { makeRequest } from './test-store.test-helper.js';

describe('organizer keys (ADR 0042)', () => {
  it('makes hcdk_<id>_<secret> keys whose id the parser reads back', () => {
    const { keyId, secret } = generateKey();
    expect(secret.startsWith(KEY_PREFIX)).toBe(true);
    expect(isKeyId(keyId)).toBe(true);
    expect(parseKey(secret)?.keyId).toBe(keyId);
    expect(looksLikeKey(secret)).toBe(true);
  });

  it('keeps the id on a rotation and changes the secret', () => {
    const first = generateKey();
    const second = generateKey({ keyId: first.keyId });
    expect(second.keyId).toBe(first.keyId);
    expect(second.secret).not.toBe(first.secret);
    // A malformed id is not trusted: a fresh one is made instead.
    expect(generateKey({ keyId: 'not-hex' }).keyId).not.toBe('not-hex');
  });

  it('is never mistaken for Koda\'s key, nor Koda\'s for it', () => {
    const { secret } = generateKey();
    expect(looksLikeAgentKey(secret)).toBe(false);
    expect(looksLikeKey(`hcwk_${'a'.repeat(43)}`)).toBe(false);
    expect(looksLikeKey(null)).toBe(false);
    expect(looksLikeKey('hcdk_short')).toBe(false);
  });

  it('compares hashes in constant time and refuses a malformed stored hash', () => {
    const { secret } = generateKey();
    expect(hashMatches(secret, hashKey(secret))).toBe(true);
    expect(hashMatches(`${secret}x`, hashKey(secret))).toBe(false);
    expect(hashMatches(secret, 'abc')).toBe(false);
    expect(hashMatches(secret, undefined)).toBe(false);
  });

  it('shows a hint that cannot be used as a key', () => {
    const { keyId, secret } = generateKey();
    const hint = keyHint(secret);
    expect(hint.startsWith(`${KEY_PREFIX}${keyId}_`)).toBe(true);
    expect(looksLikeKey(hint)).toBe(false);
    expect(keyHint('nonsense')).toBeNull();
  });

  it('reads the key from Bearer, a bare Authorization, or X-API-Key, never the query', () => {
    const { secret } = generateKey();
    expect(developerKeyFrom(makeRequest({ headers: { Authorization: `Bearer ${secret}` } }))).toBe(secret);
    expect(developerKeyFrom(makeRequest({ headers: { Authorization: secret } }))).toBe(secret);
    expect(developerKeyFrom(makeRequest({ headers: { 'X-API-Key': secret } }))).toBe(secret);
    expect(developerKeyFrom(makeRequest({ headers: { Authorization: 'Basic abc' } }))).toBeNull();
    expect(developerKeyFrom(makeRequest({ headers: { Authorization: '   ', 'X-API-Key': secret } }))).toBe(secret);
    expect(developerKeyFrom(makeRequest({ query: { key: secret } }))).toBeNull();
    expect(developerKeyFrom({})).toBeNull();
  });

  it('normalizes scopes to the known list, in catalogue order, and refuses the rest by name', () => {
    expect(normalizeScopes(['cfs:manage', 'events:read', 'cfs:manage'])).toEqual(['events:read', 'cfs:manage']);
    expect(() => normalizeScopes([])).toThrow(/non-empty/);
    expect(() => normalizeScopes('cfs:manage')).toThrow(/non-empty/);
    expect(() => normalizeScopes(['events:publish'])).toThrow(/Not a scope: events:publish/);
    expect(SCOPE_IDS).toEqual(['events:read', 'events:write', 'cfs:manage']);
  });

  it('has no scope that publishes', () => {
    expect(SCOPE_IDS.some((id) => /publish|schedule/.test(id))).toBe(false);
  });

  it('reads only organizerName, organizerContact and scopes from a make request', () => {
    expect(
      normalizeKeyRequest({ organizerName: '  Ada   Org ', scopes: ['cfs:manage'], keyHash: 'x', organizerContact: '' }),
    ).toEqual({ organizerName: 'Ada Org', organizerContact: null, scopes: ['cfs:manage'] });
    expect(() => normalizeKeyRequest(null)).toThrow(/JSON object/);
    expect(() => normalizeKeyRequest([])).toThrow(/JSON object/);
    expect(() => normalizeKeyRequest({ scopes: ['cfs:manage'] })).toThrow(/organizerName is required/);
    expect(() => normalizeKeyRequest({ organizerName: '   ', scopes: ['cfs:manage'] })).toThrow(/required/);
    expect(() => normalizeKeyRequest({ organizerName: 5, scopes: ['cfs:manage'] })).toThrow(/text/);
    expect(() => normalizeKeyRequest({ organizerName: 'x'.repeat(121), scopes: ['cfs:manage'] })).toThrow(/at most/);
  });

  it('stores the hash and hint only, and carries organizer and history across a rotation', () => {
    const now = () => new Date('2026-11-21T00:00:00Z');
    const { keyId, secret } = generateKey();
    const organizer = { organizerName: 'Org', organizerContact: 'org@example.com', scopes: ['cfs:manage'] };
    const record = buildKeyRecord({ keyId, secret, actor: 'owner', organizer, now });
    expect(record.id).toBe(keyRecordId(keyId));
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(record.keyHash).toBe(hashKey(secret));
    expect(isUsable(record)).toBe(true);

    const rotated = generateKey({ keyId });
    const later = () => new Date('2026-11-22T00:00:00Z');
    const next = buildKeyRecord({ keyId, secret: rotated.secret, actor: 'owner2', organizer: {}, now: later, previous: record });
    expect(next.createdAt).toBe(record.createdAt);
    expect(next.rotatedBy).toBe('owner2');
    expect(next.scopes).toEqual(['cfs:manage']);
    expect(next.organizerContact).toBe('org@example.com');
    expect(hashMatches(secret, next.keyHash)).toBe(false);
  });

  it('presents a record without its hash, and a revoked one as inactive', () => {
    const { keyId, secret } = generateKey();
    const record = buildKeyRecord({ keyId, secret, actor: 'o', organizer: { organizerName: 'Org', scopes: ['cfs:manage'] } });
    const shown = presentKeyRecord(record);
    expect(shown).not.toHaveProperty('keyHash');
    expect(shown.active).toBe(true);
    const { keyHash: _gone, ...revoked } = { ...record, revokedAt: 'now' };
    expect(isUsable(revoked)).toBe(false);
    expect(presentKeyRecord(revoked).active).toBe(false);
    expect(presentKeyRecord({}).scopes).toEqual([]);
    expect(isUsable({ ...record, kind: 'other' })).toBe(false);
  });

  it('filters stored scopes to the known ones', () => {
    expect(scopesOf({ scopes: ['cfs:manage', 'admin'] })).toEqual(['cfs:manage']);
    expect(scopesOf(undefined)).toEqual([]);
  });

  it('names the organizer as the actor, never by email', () => {
    const user = organizerUser({ keyId: 'abcdef0123456789', organizerName: 'Org', keyHint: 'h' });
    expect(user.oid).toBe('developer:abcdef0123456789');
    expect(user.email).toBeNull();
    expect(organizerUser({ keyId: 'abcdef0123456789' }).name).toBe('organizer');
  });

  it('counts per key per minute', () => {
    expect(quotaKeyFor('abcdef0123456789', 120_000)).toBe('developer-api:abcdef0123456789:2');
    expect(secondsToNextMinute(59_500)).toBe(1);
    expect(secondsToNextMinute(0)).toBe(60);
  });
});
