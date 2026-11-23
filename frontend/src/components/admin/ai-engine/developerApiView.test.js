/**
 * The Developer API tab's pure half (developerApiView.js, ADR 0042): each
 * key's state in words, the scope rows and switches, who may call each
 * endpoint, the connection values (never a secret) and the New key checks.
 */
import { describe, it, expect } from 'vitest';
import {
  connectionValues,
  endpointRows,
  keyState,
  newKeyProblem,
  orderKeys,
  scopeRows,
  scopeText,
  whenText,
  whoText,
  withScope,
} from './developerApiView';

const CATALOGUE = [
  { id: 'events:read', label: 'Read events', description: 'Read.' },
  { id: 'events:write', label: 'Create and edit events', description: 'Write.' },
  { id: 'cfs:manage', label: 'Manage calls for speakers', description: 'CfS.' },
];

describe('keyState', () => {
  it('says a key is active, when it was made or rotated, and when it was last used', () => {
    const made = keyState({
      active: true,
      keyHint: 'hcdk_0123456789abcdef_abcdefgh',
      createdAt: '2026-11-20T17:00:00.000Z',
    });
    expect(made.status).toBe('active');
    expect(made.sentence).toContain('hcdk_0123456789abcdef_abcdefgh…');
    expect(made.sentence).toContain('made ');
    expect(made.sentence).toContain('not used yet');
    const rotated = keyState({
      active: true,
      keyHint: 'hcdk_x',
      createdAt: '2026-11-01T17:00:00.000Z',
      rotatedAt: '2026-11-20T17:00:00.000Z',
      lastUsedAt: '2026-11-20T18:00:00.000Z',
    });
    expect(rotated.sentence).toContain('rotated ');
    expect(rotated.sentence).toContain('last used ');
  });

  it('says a key was revoked and when', () => {
    const state = keyState({
      active: false,
      keyHint: 'hcdk_x',
      revokedAt: '2026-11-20T17:00:00.000Z',
    });
    expect(state.status).toBe('revoked');
    expect(state.tone).toBe('danger');
    expect(state.sentence).toContain(whenText('2026-11-20T17:00:00.000Z'));
  });
});

describe('orderKeys', () => {
  it('puts active keys first and keeps the API order within each group', () => {
    const keys = [
      { keyId: 'a', active: false },
      { keyId: 'b', active: true },
      { keyId: 'c', active: true },
    ];
    expect(orderKeys(keys).map((k) => k.keyId)).toEqual(['b', 'c', 'a']);
    expect(orderKeys(null)).toEqual([]);
  });
});

describe('scopes', () => {
  it('marks the scopes a key has', () => {
    expect(scopeRows(CATALOGUE, ['cfs:manage']).map((r) => r.on)).toEqual([false, false, true]);
  });

  it('names a key’s scopes by label', () => {
    expect(scopeText(['events:read', 'cfs:manage'], CATALOGUE)).toBe(
      'Read events, Manage calls for speakers'
    );
    expect(scopeText([], CATALOGUE)).toBe('No scopes');
  });

  it('switches one scope and keeps the catalogue order', () => {
    expect(withScope(['cfs:manage'], 'events:read', true, CATALOGUE)).toEqual([
      'events:read',
      'cfs:manage',
    ]);
    expect(withScope(['events:read', 'cfs:manage'], 'events:read', false, CATALOGUE)).toEqual([
      'cfs:manage',
    ]);
  });
});

describe('endpoints', () => {
  it('says who may call each endpoint', () => {
    expect(whoText('public', CATALOGUE)).toBe('Anyone, no key needed');
    expect(whoText('key', CATALOGUE)).toBe('Any organizer key');
    expect(whoText('cfs:manage', CATALOGUE)).toBe('A key with “Manage calls for speakers”');
    expect(endpointRows([{ method: 'GET', path: 'status', who: 'key' }], CATALOGUE)).toEqual([
      { line: 'GET status', who: 'Any organizer key' },
    ]);
  });
});

describe('connectionValues', () => {
  it('gives the base URL, the header, a first call and the limit, and nothing secret', () => {
    const rows = connectionValues(
      {
        host: 'api-azure.hybridcloudworks.com',
        url: 'https://api-azure.hybridcloudworks.com/api/developer/v1',
      },
      { keyedRequestsPerMinute: 120 }
    );
    expect(rows.map((r) => r.field)).toEqual([
      'Base URL',
      'Authentication',
      'First test call',
      'Limit',
    ]);
    expect(rows[2].value).toBe(
      'GET https://api-azure.hybridcloudworks.com/api/developer/v1/status'
    );
    expect(rows[3].value).toBe('120 requests a minute per key');
    expect(JSON.stringify(rows)).not.toMatch(/hcdk_/);
  });
});

describe('newKeyProblem', () => {
  it('needs a name and at least one scope, within the API’s limits', () => {
    expect(newKeyProblem({ organizerName: ' ', scopes: ['events:read'] })).toMatch(/name/);
    expect(newKeyProblem({ organizerName: 'x'.repeat(121), scopes: ['events:read'] })).toMatch(
      /120/
    );
    expect(
      newKeyProblem({
        organizerName: 'Cloud Day',
        organizerContact: 'x'.repeat(255),
        scopes: ['a'],
      })
    ).toMatch(/254/);
    expect(newKeyProblem({ organizerName: 'Cloud Day', scopes: [] })).toMatch(/at least one/);
    expect(newKeyProblem({ organizerName: 'Cloud Day', scopes: ['cfs:manage'] })).toBeNull();
  });
});
