/**
 * The Developer API tab's client (developerApi.js, ADR 0042): each call
 * reaches the organizer-key routes with the right verb and body, and a key id
 * is encoded into the path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getJSON = vi.fn();
const postJSON = vi.fn();
const sendJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...a) => getJSON(...a),
  postJSON: (...a) => postJSON(...a),
  sendJSON: (...a) => sendJSON(...a),
}));

const {
  DEVELOPER_KEYS_ROUTE,
  createDeveloperKey,
  developerKeyRoute,
  listDeveloperKeys,
  revokeDeveloperKey,
  rotateDeveloperKey,
  updateDeveloperKey,
} = await import('./developerApi');

const ID = '0123456789abcdef';

beforeEach(() => {
  getJSON.mockReset();
  postJSON.mockReset();
  sendJSON.mockReset();
});

describe('the calls', () => {
  it('lists, creates, rotates, changes and revokes on cms/developer-api/keys', async () => {
    expect(DEVELOPER_KEYS_ROUTE).toBe('cms/developer-api/keys');
    await listDeveloperKeys();
    expect(getJSON).toHaveBeenCalledWith('cms/developer-api/keys');
    await createDeveloperKey({
      organizerName: 'Cloud Day',
      organizerContact: 'team@example.org',
      scopes: ['cfs:manage'],
    });
    expect(postJSON).toHaveBeenCalledWith('cms/developer-api/keys', {
      organizerName: 'Cloud Day',
      organizerContact: 'team@example.org',
      scopes: ['cfs:manage'],
    });
    await rotateDeveloperKey(ID);
    expect(postJSON).toHaveBeenCalledWith(`cms/developer-api/keys/${ID}/rotate`, {});
    await updateDeveloperKey(ID, { scopes: ['events:read'] });
    expect(sendJSON).toHaveBeenCalledWith(`cms/developer-api/keys/${ID}`, 'PATCH', {
      scopes: ['events:read'],
    });
    await revokeDeveloperKey(ID);
    expect(sendJSON).toHaveBeenCalledWith(`cms/developer-api/keys/${ID}`, 'DELETE');
  });

  it('leaves an empty contact out of the create body', async () => {
    await createDeveloperKey({
      organizerName: 'Cloud Day',
      organizerContact: '',
      scopes: ['events:read'],
    });
    expect(postJSON).toHaveBeenCalledWith('cms/developer-api/keys', {
      organizerName: 'Cloud Day',
      scopes: ['events:read'],
    });
  });

  it('encodes a key id, so it cannot reach another path', () => {
    expect(developerKeyRoute('../x?y')).toBe('cms/developer-api/keys/..%2Fx%3Fy');
  });
});
