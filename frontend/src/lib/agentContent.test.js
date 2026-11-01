/**
 * The Koda tab's client (agentContent.js, ADR 0037): each call reaches the one
 * admin route with the right verb, and the address Muse registers is built
 * from this build's API base.
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
vi.mock('@/lib/functionsBase', () => ({
  getFunctionsBase: () => 'https://api-azure.hybridcloudworks.com/api',
}));

const {
  KODA_KEY_ROUTE,
  generateKodaKey,
  kodaApiAddress,
  readKodaKey,
  revokeKodaKey,
  setKodaCapabilities,
} = await import('./agentContent');

beforeEach(() => {
  getJSON.mockReset();
  postJSON.mockReset();
  sendJSON.mockReset();
});

describe('the calls', () => {
  it('read, generate, switch and revoke on cms/agent-content/key', async () => {
    await readKodaKey();
    expect(getJSON).toHaveBeenCalledWith(KODA_KEY_ROUTE);
    await generateKodaKey();
    expect(postJSON).toHaveBeenCalledWith(KODA_KEY_ROUTE, {});
    await setKodaCapabilities({ 'drafts.delete': false });
    expect(sendJSON).toHaveBeenCalledWith(KODA_KEY_ROUTE, 'PATCH', {
      capabilities: { 'drafts.delete': false },
    });
    await revokeKodaKey();
    expect(sendJSON).toHaveBeenCalledWith(KODA_KEY_ROUTE, 'DELETE');
    expect(KODA_KEY_ROUTE).toBe('cms/agent-content/key');
  });
});

describe('kodaApiAddress', () => {
  it('uses the cross-origin API host as it stands', () => {
    expect(kodaApiAddress('/api/agent-content/v1')).toEqual({
      host: 'api-azure.hybridcloudworks.com',
      url: 'https://api-azure.hybridcloudworks.com/api/agent-content/v1',
    });
  });

  it('prefixes the page origin when the build is same-origin', () => {
    expect(
      kodaApiAddress('/api/agent-content/v1', {
        functionsBase: '/api',
        origin: 'https://hybridcloudworks.com',
      })
    ).toEqual({
      host: 'hybridcloudworks.com',
      url: 'https://hybridcloudworks.com/api/agent-content/v1',
    });
  });
});
