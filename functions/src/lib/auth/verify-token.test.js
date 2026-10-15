import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { createTokenVerifier, bearerTokenFrom, ENTRA_REQUIRED_TOKEN_VERSION } from './verify-token.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const AUDIENCE = 'api://99999999-8888-7777-6666-555555555555';
const KID = 'test-prewarm-key-1';

let server;
let jwksUri;
let privateKey;

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;

  const jwk = pair.publicKey.export({ format: 'jwk' });
  const document = JSON.stringify({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] });

  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(document);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  jwksUri = `http://127.0.0.1:${server.address().port}/keys`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

function mintToken(claims = {}) {
  const payload = {
    aud: AUDIENCE,
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    tid: TENANT,
    ver: ENTRA_REQUIRED_TOKEN_VERSION,
    sub: 'user-1',
    roles: ['admin'],
    ...claims,
  };
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    keyid: KID,
    expiresIn: '1h',
  });
}

describe('verify-token', () => {
  it('throws on missing tenantId or audience', () => {
    expect(() => createTokenVerifier({ audience: AUDIENCE })).toThrow(/ENTRA_TENANT_ID/);
    expect(() => createTokenVerifier({ tenantId: TENANT })).toThrow(/ENTRA_API_AUDIENCE/);
  });

  it('supports prewarm() to prime signing keys cache', async () => {
    const verifier = createTokenVerifier({ tenantId: TENANT, audience: AUDIENCE, jwksUri });
    expect(typeof verifier.prewarm).toBe('function');
    const keys = await verifier.prewarm();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0].kid).toBe(KID);
  });

  it('verifies a valid token after prewarming', async () => {
    const verifier = createTokenVerifier({ tenantId: TENANT, audience: AUDIENCE, jwksUri });
    await verifier.prewarm();
    const token = mintToken();
    const decoded = await verifier.verify(token);
    expect(decoded.tid).toBe(TENANT);
    expect(decoded.aud).toBe(AUDIENCE);
  });

  it('bearerTokenFrom parses header accurately', () => {
    expect(bearerTokenFrom({ headers: { get: () => 'Bearer valid-token-123' } })).toBe('valid-token-123');
    expect(bearerTokenFrom({ headers: { get: () => 'bearer   spaced-token   ' } })).toBe('spaced-token');
    expect(bearerTokenFrom({ headers: { get: () => '' } })).toBeNull();
    expect(bearerTokenFrom(null)).toBeNull();
  });
});
