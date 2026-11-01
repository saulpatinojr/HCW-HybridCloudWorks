/**
 * The Koda tab's pure half (kodaView.js, ADR 0037): the key's state in words,
 * the capability rows, the endpoint groups and the connector values, none of
 * which may ever carry a secret.
 */
import { describe, it, expect } from 'vitest';
import { capabilityRows, connectorValues, endpointGroups, keyState, whenText } from './kodaView';

const CATALOGUE = [
  { id: 'drafts.read', label: 'Read drafts', description: 'List and open.' },
  { id: 'drafts.write', label: 'Create and edit drafts', description: 'Create and save.' },
];

describe('keyState', () => {
  it('says there is no key', () => {
    const state = keyState({ present: false });
    expect(state.status).toBe('none');
    expect(state.sentence).toMatch(/until a key is generated/);
  });

  it('says a key is active, when it was made or rotated, and when it was last used', () => {
    const made = keyState({
      present: true,
      active: true,
      keyHint: 'hcwk_abcd1234',
      createdAt: '2026-10-31T17:00:00.000Z',
    });
    expect(made.status).toBe('active');
    expect(made.sentence).toContain('hcwk_abcd1234…');
    expect(made.sentence).toContain('made ');
    expect(made.sentence).toContain('not used yet');
    const rotated = keyState({
      present: true,
      active: true,
      keyHint: 'hcwk_abcd1234',
      createdAt: '2026-10-01T17:00:00.000Z',
      rotatedAt: '2026-10-31T17:00:00.000Z',
      lastUsedAt: '2026-10-31T18:00:00.000Z',
    });
    expect(rotated.sentence).toContain('rotated ');
    expect(rotated.sentence).toContain('last used ');
  });

  it('says a key was revoked and when', () => {
    const state = keyState({
      present: true,
      active: false,
      keyHint: 'hcwk_abcd1234',
      revokedAt: '2026-10-31T17:00:00.000Z',
    });
    expect(state.status).toBe('revoked');
    expect(state.tone).toBe('danger');
    expect(state.sentence).toContain(whenText('2026-10-31T17:00:00.000Z'));
  });
});

describe('whenText', () => {
  it('formats in the owner’s zone and dashes an absent or bad value', () => {
    expect(whenText('2026-10-31T17:00:00.000Z')).toBe('Oct 31, 2026, 12:00 PM');
    expect(whenText(null)).toBe('—');
    expect(whenText('not a date')).toBe('—');
  });
});

describe('capabilityRows and endpointGroups', () => {
  it('pairs each catalogue entry with its switch, on unless switched off', () => {
    expect(capabilityRows(CATALOGUE, { 'drafts.write': false })).toEqual([
      { ...CATALOGUE[0], on: true },
      { ...CATALOGUE[1], on: false },
    ]);
  });

  it('groups endpoints by the capability they need, status first under its own heading', () => {
    const groups = endpointGroups(
      [
        { method: 'GET', path: 'status', capability: null },
        { method: 'GET', path: 'drafts', capability: 'drafts.read' },
        { method: 'POST', path: 'drafts', capability: 'drafts.write' },
        { method: 'GET', path: 'drafts/{id}', capability: 'drafts.read' },
      ],
      CATALOGUE
    );
    expect(groups.map((g) => [g.label, g.endpoints])).toEqual([
      ['Always (no capability needed)', ['GET status']],
      ['Read drafts', ['GET drafts', 'GET drafts/{id}']],
      ['Create and edit drafts', ['POST drafts']],
    ]);
  });
});

describe('connectorValues', () => {
  it('names the host, the base URL, the header, the test call and the limit, and nothing secret', () => {
    const rows = connectorValues(
      {
        host: 'api-azure.hybridcloudworks.com',
        url: 'https://api-azure.hybridcloudworks.com/api/agent-content/v1',
      },
      120
    );
    expect(rows.map((r) => r.field)).toEqual([
      'Provider host',
      'Base URL',
      'Authentication',
      'First test call',
      'Limit',
    ]);
    expect(rows[0].value).toBe('api-azure.hybridcloudworks.com');
    expect(rows[3].value).toBe(
      'GET https://api-azure.hybridcloudworks.com/api/agent-content/v1/status'
    );
    expect(rows[4].value).toBe('120 requests a minute');
    expect(JSON.stringify(rows)).not.toMatch(/hcwk_[A-Za-z0-9_-]{20,}/);
  });
});
