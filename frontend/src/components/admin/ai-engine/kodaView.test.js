/**
 * The Koda tab's pure half (kodaView.js, ADR 0037): the key's state in words,
 * the capability rows, the endpoint groups and the connector values, none of
 * which may ever carry a secret.
 */
import { describe, it, expect } from 'vitest';
import {
  agentWords,
  capabilityRows,
  connectorValues,
  endpointGroups,
  keyState,
  startingSwitches,
  whenText,
} from './kodaView';

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

describe('another agent key’s words', () => {
  it('keeps Koda’s words, and gives another key its own name and no outside service', () => {
    expect(agentWords()).toMatchObject({
      id: 'koda',
      name: 'Koda',
      client: 'Muse',
      switchesOnWhenMade: true,
    });
    const words = agentWords({
      id: 'claude',
      displayName: 'Claude',
      switchesOnWhenMade: ['drafts.read', 'drafts.write'],
    });
    expect(words).toMatchObject({
      id: 'claude',
      name: 'Claude',
      secureField: 'the secure field Claude asks for',
      switchesOnWhenMade: ['drafts.read', 'drafts.write'],
    });
    expect(words.revealText).toMatch(/keeps only its hash/);
    expect(keyState({ present: false }, words).sentence).toBe(
      'Claude cannot reach the site until a key is generated here and pasted into the secure field Claude asks for.'
    );
    expect(startingSwitches(words, CATALOGUE)).toBe(
      'A new key starts with only Read drafts and Create and edit drafts on; everything else is off until you turn it on.'
    );
    expect(startingSwitches(agentWords())).toBe('All are on for a new key.');
    expect(JSON.stringify(connectorValues({ host: 'h', url: 'u' }, 120, words))).not.toMatch(
      /Muse/
    );
  });

  it('reads a missing switch as the key’s starting value, and a stored one as stored', () => {
    expect(capabilityRows(CATALOGUE, {}, ['drafts.read']).map((row) => row.on)).toEqual([
      true,
      false,
    ]);
    expect(
      capabilityRows(CATALOGUE, { 'drafts.read': false, 'drafts.write': true }, [
        'drafts.read',
      ]).map((row) => row.on)
    ).toEqual([false, true]);
    expect(capabilityRows(CATALOGUE, {}).map((row) => row.on)).toEqual([true, true]);
  });
});
