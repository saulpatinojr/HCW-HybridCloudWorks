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
  eraseProposal,
  findProposalsByEmail,
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

describe("a speaker's erasure request (#1777)", () => {
  it('sends the address in the body, never in the path', async () => {
    await findProposalsByEmail('grace@example.com');
    expect(postJSON).toHaveBeenCalledWith('cms/developer-api/proposal-search', {
      speakerEmail: 'grace@example.com',
    });
    expect(postJSON.mock.calls[0][0]).not.toContain('grace');
  });

  it('deletes one proposal by id, with the id encoded into the path', async () => {
    await eraseProposal('00000000-0000-4000-8000-000000000001');
    expect(sendJSON).toHaveBeenCalledWith(
      'cms/developer-api/proposals/00000000-0000-4000-8000-000000000001',
      'DELETE'
    );
    await eraseProposal('../keys/x');
    expect(sendJSON).toHaveBeenLastCalledWith(
      'cms/developer-api/proposals/..%2Fkeys%2Fx',
      'DELETE'
    );
    await eraseProposal(undefined);
    expect(sendJSON).toHaveBeenLastCalledWith('cms/developer-api/proposals/', 'DELETE');
  });
});
