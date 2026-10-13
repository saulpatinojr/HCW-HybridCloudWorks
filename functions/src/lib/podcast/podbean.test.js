/**
 * The Podbean client (ADR 0029 §1c).
 *
 * The documentation it was written against is quoted in the module header;
 * these tests pin what the client sends — path, method, auth, body encoding —
 * so a drift shows up as a failing assertion about a request rather than as a
 * 400 in production with nothing to compare it to. The negative assertions
 * matter as much: the token travels in a query string, so "no error carries
 * the token, the secret or a URL with access_token=" is a security property.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CLIENT_ID_SETTING,
  CLIENT_SECRET_SETTING,
  PODBEAN_API_BASE_URL,
  PODBEAN_TIMEOUT_MS,
  PODBEAN_UPLOAD_TIMEOUT_MS,
  PodbeanError,
  TOKEN_EXPIRY_MARGIN_MS,
  createPodbeanClient,
  isConfigured,
} from './podbean.js';

// Deliberately unlike real credentials, so no secret scanner mistakes them.
const CLIENT_ID = 'not-a-real-podbean-client-id';
const CLIENT_SECRET = 'not-a-real-podbean-client-secret-EXAMPLE';
const TOKEN = 'not-a-real-podbean-access-token-0001';
const TOKEN_2 = 'not-a-real-podbean-access-token-0002';
const BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

const ENV = { PODBEAN_CLIENT_ID: CLIENT_ID, PODBEAN_CLIENT_SECRET: CLIENT_SECRET };

const reply = (status, body, { text } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (text !== undefined ? text : body === undefined ? '' : JSON.stringify(body)),
});

const tokenReply = (token = TOKEN, expiresIn = 604800) =>
  reply(200, {
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: 'podcast_read episode_read podcast_update episode_publish private_members',
  });

const EPISODE = {
  episode: {
    id: 'IWPNG2FB3F',
    title: 'Picking a state backend',
    media_url: 'https://mcdn.podbean.com/mf/web/abc/episode.mp3',
    permalink_url: 'https://podcast.hybridcloudworks.com/e/picking-a-state-backend/',
    publish_time: 1488276731,
    status: 'publish',
    type: 'public',
  },
};

function build({ env = ENV, responses = [], now } = {}) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => queue.shift() || reply(200, {}));
  const client = createPodbeanClient({ env, fetch: fetchImpl, ...(now ? { now } : {}) });
  const calls = () => fetchImpl.mock.calls.map(([url, init]) => ({ url, init }));
  const lastCall = () => calls().at(-1);
  return { client, fetchImpl, calls, lastCall };
}

/** Every string a caller could record or show, joined, for leak checks. */
const surfaces = (error) => [error.message, error.detail, JSON.stringify(error)].join(' ');

const expectNoCredential = (error) => {
  const text = surfaces(error);
  for (const secret of [TOKEN, TOKEN_2, CLIENT_SECRET, BASIC]) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(encodeURIComponent(secret));
  }
  expect(text).not.toMatch(/access_token=(?!\*\*\*)/);
};

describe('isConfigured', () => {
  it('names both missing settings and their vault secrets in one sentence', () => {
    const out = isConfigured({});
    expect(out.ok).toBe(false);
    expect(out.reason).toBe(
      'Podbean publishing is not configured: PODBEAN_CLIENT_ID (Key Vault secret PODBEAN-CLIENT-ID) ' +
        'and PODBEAN_CLIENT_SECRET (Key Vault secret PODBEAN-CLIENT-SECRET) are not set, ' +
        'so episodes stay on the manual upload path.'
    );
  });

  it('names only the one that is missing', () => {
    const out = isConfigured({ PODBEAN_CLIENT_ID: CLIENT_ID });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('PODBEAN_CLIENT_SECRET (Key Vault secret PODBEAN-CLIENT-SECRET) is not set');
    expect(out.reason).not.toContain('PODBEAN_CLIENT_ID (');
  });

  it('treats an unresolved Key Vault reference as absent, not as a credential', () => {
    const out = isConfigured({
      PODBEAN_CLIENT_ID: CLIENT_ID,
      PODBEAN_CLIENT_SECRET: '@Microsoft.KeyVault(SecretUri=https://kv/secrets/PODBEAN-CLIENT-SECRET)',
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain(CLIENT_SECRET_SETTING);
  });

  it('is ok when both are present', () => {
    expect(isConfigured(ENV)).toEqual({ ok: true });
    expect([CLIENT_ID_SETTING, CLIENT_SECRET_SETTING]).toEqual([
      'PODBEAN_CLIENT_ID',
      'PODBEAN_CLIENT_SECRET',
    ]);
  });
});

describe('the access token', () => {
  it('is requested with Basic auth and a form body, nothing in the URL', async () => {
    const { client, lastCall } = build({ responses: [tokenReply()] });
    expect(await client.getToken()).toBe(TOKEN);
    const { url, init } = lastCall();
    expect(url).toBe(`${PODBEAN_API_BASE_URL}/oauth/token`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Basic ${BASIC}`);
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('grant_type=client_credentials');
    expect(url).not.toContain(CLIENT_SECRET);
    // fetchWithTimeout strips timeoutMs and attaches a signal.
    expect(init.timeoutMs).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('is cached until expires_in less the margin, then fetched again', async () => {
    let clock = 1_000_000;
    const { client, fetchImpl } = build({
      responses: [tokenReply(TOKEN, 3600), tokenReply(TOKEN_2, 3600)],
      now: () => clock,
    });
    expect(await client.getToken()).toBe(TOKEN);
    clock += 3600 * 1000 - TOKEN_EXPIRY_MARGIN_MS - 1;
    expect(await client.getToken()).toBe(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 1;
    expect(await client.getToken()).toBe(TOKEN_2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('is used once and not cached when expires_in is missing or too short to be useful', async () => {
    // `null` rather than `undefined`: a default parameter would replace the latter.
    for (const expiresIn of [null, 'soon', 30]) {
      const { client, fetchImpl } = build({
        responses: [tokenReply(TOKEN, expiresIn), tokenReply(TOKEN_2, expiresIn)],
      });
      expect(await client.getToken()).toBe(TOKEN);
      expect(await client.getToken()).toBe(TOKEN_2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it('serves every resource call from the one cached token', async () => {
    const { client, calls } = build({
      responses: [tokenReply(), reply(200, { podcast: { id: 'p1' } }), reply(200, { podcast: { id: 'p1' } })],
    });
    await client.getPodcast();
    await client.getPodcast();
    expect(calls().map((c) => new URL(c.url).pathname)).toEqual([
      '/v1/oauth/token',
      '/v1/podcast',
      '/v1/podcast',
    ]);
  });

  it('a 400 invalid_grant is CREDENTIALS_REJECTED with the flattened description', async () => {
    const { client } = build({
      responses: [
        reply(400, {
          error: 'invalid_grant',
          error_description: 'The grant type is unauthorized for this client_id',
        }),
      ],
    });
    const error = await client.getToken().catch((e) => e);
    expect(error).toBeInstanceOf(PodbeanError);
    expect(error.code).toBe('CREDENTIALS_REJECTED');
    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
    expect(error.detail).toBe('invalid_grant: The grant type is unauthorized for this client_id');
    expect(error.message).toBe(
      'Podbean refused the client ID and secret while requesting an access token ' +
        '(400 invalid_grant: The grant type is unauthorized for this client_id).'
    );
  });

  it('invalid_client, unauthorized_client and a bare 401 are CREDENTIALS_REJECTED too', async () => {
    for (const [status, body] of [
      [400, { error: 'invalid_client' }],
      [400, { error: 'unauthorized_client' }],
      [401, { error: 'whatever' }],
    ]) {
      const { client } = build({ responses: [reply(status, body)] });
      const error = await client.getToken().catch((e) => e);
      expect(error.code, JSON.stringify(body)).toBe('CREDENTIALS_REJECTED');
    }
  });

  it('a 5xx or 429 on the token endpoint is retryable UPSTREAM; another 400 is VALIDATION', async () => {
    for (const [status, code, retryable] of [
      [503, 'UPSTREAM', true],
      [429, 'UPSTREAM', true],
      [400, 'VALIDATION', false],
    ]) {
      const { client } = build({ responses: [reply(status, { error: 'invalid_request' })] });
      const error = await client.getToken().catch((e) => e);
      expect(error.code, String(status)).toBe(code);
      expect(error.retryable, String(status)).toBe(retryable);
    }
  });

  it('a token response without an access_token is UPSTREAM, not a token of ""', async () => {
    const { client } = build({ responses: [reply(200, { token_type: 'Bearer' })] });
    const error = await client.getToken().catch((e) => e);
    expect(error.code).toBe('UPSTREAM');
    expect(error.message).toMatch(/without an access token/);
  });
});

describe('requests', () => {
  it('listEpisodes GETs /v1/episodes with offset and limit beside the token, and sends nothing else', async () => {
    const listing = { episodes: [], offset: 0, limit: 20, has_more: false, count: 0 };
    const { client, lastCall } = build({ responses: [tokenReply(), reply(200, listing)] });
    expect(await client.listEpisodes({ limit: 20 })).toEqual(listing);
    const { url, init } = lastCall();
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${PODBEAN_API_BASE_URL}/episodes`);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ access_token: TOKEN, offset: '0', limit: '20' });
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('getPodcast GETs /v1/podcast with the token as the access_token parameter and no body', async () => {
    const { client, lastCall } = build({
      responses: [tokenReply(), reply(200, { podcast: { id: 'p1', title: 'Hybrid Cloud Insights' } })],
    });
    expect(await client.getPodcast()).toEqual({ podcast: { id: 'p1', title: 'Hybrid Cloud Insights' } });
    const { url, init } = lastCall();
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${PODBEAN_API_BASE_URL}/podcast`);
    expect(parsed.searchParams.get('access_token')).toBe(TOKEN);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
    // The documented form, not a Bearer header.
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('authorizeUpload sends filename, filesize and content_type under the documented names', async () => {
    const answer = {
      presigned_url: 'https://s3.amazonaws.com/bucket/tmp2/49755/a.mp3?X-Amz-Signature=sig',
      expire_in: 600,
      file_key: 'tmp2/49755/a.mp3',
    };
    const { client, lastCall } = build({ responses: [tokenReply(), reply(200, answer)] });
    const out = await client.authorizeUpload({
      filename: ' a.mp3 ',
      filesize: 1291021,
      contentType: ' audio/mpeg ',
    });
    expect(out).toEqual(answer);
    const parsed = new URL(lastCall().url);
    expect(parsed.pathname).toBe('/v1/files/uploadAuthorize');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      access_token: TOKEN,
      filename: 'a.mp3',
      filesize: '1291021',
      content_type: 'audio/mpeg',
    });
    expect(lastCall().init.method).toBe('GET');
  });

  it('authorizeUpload refuses a missing filename, a bad size or a bad content type before any call', async () => {
    const good = { filename: 'a.mp3', filesize: 10, contentType: 'audio/mpeg' };
    for (const bad of [
      { ...good, filename: '  ' },
      { ...good, filesize: 0 },
      { ...good, filesize: 1.5 },
      { ...good, filesize: '10' },
      { ...good, contentType: '' },
      { ...good, contentType: 'audio' },
      { ...good, contentType: 'audio/mpeg; charset=x' },
    ]) {
      const { client, fetchImpl } = build();
      const error = await client.authorizeUpload(bad).catch((e) => e);
      expect(error, JSON.stringify(bad)).toBeInstanceOf(PodbeanError);
      expect(error.code).toBe('VALIDATION');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('uploadMedia PUTs the bytes to the presigned URL with the authorised type and NO token', async () => {
    const { client, lastCall, calls } = build({ responses: [reply(200)] });
    const bytes = Buffer.from('mp3-bytes');
    const out = await client.uploadMedia('https://s3.amazonaws.com/b/k.mp3?sig=1', bytes, 'audio/mpeg');
    expect(out).toEqual({ status: 200, bytes: bytes.length });
    const { url, init } = lastCall();
    expect(url).toBe('https://s3.amazonaws.com/b/k.mp3?sig=1');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(bytes);
    expect(init.headers['Content-Type']).toBe('audio/mpeg');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(init.headers)).not.toContain(TOKEN);
    expect(url).not.toContain('access_token');
    // The PUT needs no token, so none was fetched for it.
    expect(calls()).toHaveLength(1);
  });

  it('createEpisode POSTs the form-encoded fields with the token, leaving out undefined and null', async () => {
    const { client, lastCall } = build({ responses: [tokenReply(), reply(200, EPISODE)] });
    const out = await client.createEpisode({
      title: 'Picking a state backend',
      content: '<p>Where state lives &amp; why.</p>',
      status: 'publish',
      type: 'public',
      apple_episode_type: 'full',
      media_key: 'tmp2/49755/a.mp3',
      logo_key: undefined,
      season_number: null,
    });
    expect(out).toEqual(EPISODE);
    const { url, init } = lastCall();
    expect(url).toBe(`${PODBEAN_API_BASE_URL}/episodes`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // The token rides in the body, not the URL, on a POST.
    expect(url).not.toContain('access_token');
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      access_token: TOKEN,
      title: 'Picking a state backend',
      content: '<p>Where state lives &amp; why.</p>',
      status: 'publish',
      type: 'public',
      apple_episode_type: 'full',
      media_key: 'tmp2/49755/a.mp3',
    });
  });

  it('updateEpisode POSTs to the episode path', async () => {
    const { client, lastCall } = build({ responses: [tokenReply(), reply(200, EPISODE)] });
    await client.updateEpisode('IWPNG2FB3F', { title: 't', content: 'c', status: 'publish', type: 'public' });
    const { url, init } = lastCall();
    expect(url).toBe(`${PODBEAN_API_BASE_URL}/episodes/IWPNG2FB3F`);
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      access_token: TOKEN,
      title: 't',
      content: 'c',
      status: 'publish',
      type: 'public',
    });
    expect(PODBEAN_TIMEOUT_MS).toBeLessThan(PODBEAN_UPLOAD_TIMEOUT_MS);
  });
});

describe('the one re-auth', () => {
  const invalidToken = () =>
    reply(400, { error: 'invalid_token', error_description: 'The access token provided is invalid' });

  it('fetches a fresh token and repeats a call refused with invalid_token, once', async () => {
    const { client, calls } = build({
      responses: [tokenReply(TOKEN), invalidToken(), tokenReply(TOKEN_2), reply(200, EPISODE)],
    });
    const out = await client.createEpisode({ title: 't', content: 'c', status: 'publish', type: 'public' });
    expect(out).toEqual(EPISODE);
    const seen = calls();
    expect(seen.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/oauth/token',
      'POST /v1/episodes',
      'POST /v1/oauth/token',
      'POST /v1/episodes',
    ]);
    expect(new URLSearchParams(seen[1].init.body).get('access_token')).toBe(TOKEN);
    expect(new URLSearchParams(seen[3].init.body).get('access_token')).toBe(TOKEN_2);
  });

  it('a second invalid_token is TOKEN_REJECTED and is not repeated again', async () => {
    const { client, calls } = build({
      responses: [tokenReply(TOKEN), invalidToken(), tokenReply(TOKEN_2), invalidToken()],
    });
    const error = await client
      .createEpisode({ title: 't', content: 'c', status: 'publish', type: 'public' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(PodbeanError);
    expect(error.code).toBe('TOKEN_REJECTED');
    expect(error.retryable).toBe(false);
    expect(error.detail).toBe('invalid_token: The access token provided is invalid');
    expect(calls().filter((c) => new URL(c.url).pathname === '/v1/episodes')).toHaveLength(2);
    expectNoCredential(error);
  });

  it('never repeats a create that failed for any other reason', async () => {
    // A 5xx after the request reached Podbean may have created the episode;
    // repeating it is how a duplicate would be made.
    const { client, calls } = build({
      responses: [tokenReply(), reply(503, { error: 'server_error', error_description: 'busy' })],
    });
    const error = await client
      .createEpisode({ title: 't', content: 'c', status: 'publish', type: 'public' })
      .catch((e) => e);
    expect(error.code).toBe('UPSTREAM');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Podbean answered 503 while creating the episode: server_error: busy.');
    expect(calls().filter((c) => new URL(c.url).pathname === '/v1/episodes')).toHaveLength(1);
  });
});

describe('errors', () => {
  const failing = (response) => build({ responses: [tokenReply(), response] });

  it('storage_limit_reach is STORAGE_LIMIT and not retryable', async () => {
    const { client } = failing(
      reply(400, {
        error: 'storage_limit_reach',
        error_description: "You've uploaded too much this month",
      })
    );
    const error = await client
      .authorizeUpload({ filename: 'a.mp3', filesize: 10, contentType: 'audio/mpeg' })
      .catch((e) => e);
    expect(error.code).toBe('STORAGE_LIMIT');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/storage allowance is used up/);
  });

  it('maps the other statuses: 400 VALIDATION, 404 NOT_FOUND, 403 CREDENTIALS_REJECTED, 429 and 5xx retryable', async () => {
    for (const [status, code, retryable] of [
      [400, 'VALIDATION', false],
      [404, 'NOT_FOUND', false],
      [403, 'CREDENTIALS_REJECTED', false],
      [401, 'CREDENTIALS_REJECTED', false],
      [408, 'UPSTREAM', true],
      [429, 'UPSTREAM', true],
      [500, 'UPSTREAM', true],
      [409, 'UPSTREAM', false],
    ]) {
      const { client } = failing(reply(status, { error: 'some_error', error_description: 'said so' }));
      const error = await client.getPodcast().catch((e) => e);
      expect(error.code, String(status)).toBe(code);
      expect(error.status, String(status)).toBe(status);
      expect(error.retryable, String(status)).toBe(retryable);
      expect(error.detail).toBe('some_error: said so');
    }
  });

  it('a non-JSON error body is kept as truncated text rather than lost', async () => {
    const { client } = failing(reply(502, undefined, { text: '<html>bad gateway' }));
    const error = await client.getPodcast().catch((e) => e);
    expect(error.status).toBe(502);
    expect(error.detail).toBe('<html>bad gateway');
  });

  it('a timeout has no status and is retryable', async () => {
    const fetchImpl = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      });
    vi.useFakeTimers();
    try {
      const client = createPodbeanClient({ env: ENV, fetch: fetchImpl });
      const pending = client.getToken().catch((e) => e);
      await vi.advanceTimersByTimeAsync(PODBEAN_TIMEOUT_MS + 1);
      const error = await pending;
      expect(error).toBeInstanceOf(PodbeanError);
      expect(error.status).toBeNull();
      expect(error.code).toBe('TIMEOUT');
      expect(error.retryable).toBe(true);
      expect(error.message).toMatch(/did not answer while requesting an access token/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a network failure has no status and is retryable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.podbean.com');
    });
    const client = createPodbeanClient({ env: ENV, fetch: fetchImpl });
    const error = await client.getPodcast().catch((e) => e);
    expect(error.code).toBe('NETWORK');
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('ENOTFOUND');
  });

  it('an unconfigured client rejects every call with the plain sentence and sends nothing', async () => {
    const { client, fetchImpl } = build({ env: {} });
    expect(client.configured.ok).toBe(false);
    for (const attempt of [
      () => client.getToken(),
      () => client.getPodcast(),
      () => client.authorizeUpload({ filename: 'a.mp3', filesize: 1, contentType: 'audio/mpeg' }),
      () => client.uploadMedia('https://s3.amazonaws.com/x', Buffer.from('a'), 'audio/mpeg'),
      () => client.createEpisode({ title: 't' }),
      () => client.updateEpisode('IWPNG2FB3F', { title: 't' }),
    ]) {
      const error = await attempt().catch((e) => e);
      expect(error).toBeInstanceOf(PodbeanError);
      expect(error.code).toBe('NOT_CONFIGURED');
      expect(error.status).toBeNull();
      expect(error.message).toMatch(/^Podbean publishing is not configured: /);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the presigned PUT', () => {
  it('a 403 is an expired URL, never a rejected token', async () => {
    const { client } = build({ responses: [reply(403, undefined, { text: 'Request has expired' })] });
    const error = await client
      .uploadMedia('https://s3.amazonaws.com/b/k.mp3?X-Amz-Signature=sig', Buffer.from('mp3'), 'audio/mpeg')
      .catch((e) => e);
    expect(error).toBeInstanceOf(PodbeanError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('UPLOAD_REJECTED');
    expect(error.retryable).toBe(true);
    expect(error.detail).toBe('Request has expired');
    expect(error.message).toMatch(/^The upload host s3\.amazonaws\.com refused the PUT \(HTTP 403\)/);
    expect(error.message).toMatch(/re-run to authorise a fresh upload/);
    expect(error.message).not.toMatch(/token/i);
    // The signed URL is a credential of its own; only the host is named.
    expect(error.message).not.toContain('X-Amz-Signature');
  });

  it('other PUT failures are UPLOAD_FAILED, retryable only for 5xx/429/408', async () => {
    for (const [status, retryable] of [
      [500, true],
      [429, true],
      [408, true],
      [400, false],
      [404, false],
    ]) {
      const { client } = build({ responses: [reply(status, undefined, { text: 'nope' })] });
      const error = await client
        .uploadMedia('https://s3.amazonaws.com/b/k.mp3', Buffer.from('mp3'), 'audio/mpeg')
        .catch((e) => e);
      expect(error.code).toBe('UPLOAD_FAILED');
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(retryable);
    }
  });

  it('a fetch rejection names the upload host, never Podbean and never the signed URL', async () => {
    const signed = 'https://uploads.storage.example/put?X-Amz-Signature=sig';
    const fetchImpl = vi.fn(async () => {
      throw new Error(`getaddrinfo ENOTFOUND uploads.storage.example for ${signed}`);
    });
    const client = createPodbeanClient({ env: ENV, fetch: fetchImpl });
    const error = await client.uploadMedia(signed, Buffer.from('mp3'), 'audio/mpeg').catch((e) => e);
    expect(error.code).toBe('UPLOAD_UNREACHABLE');
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('The upload host uploads.storage.example could not be reached for the PUT');
    expect(error.message).not.toContain('Podbean');
    expect(surfaces(error)).not.toContain('X-Amz-Signature');
  });

  it('a timeout is the upload host not answering', async () => {
    const fetchImpl = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      });
    vi.useFakeTimers();
    try {
      const client = createPodbeanClient({ env: ENV, fetch: fetchImpl });
      const pending = client
        .uploadMedia('https://uploads.storage.example/put', Buffer.from('mp3'), 'audio/mpeg')
        .catch((e) => e);
      await vi.advanceTimersByTimeAsync(PODBEAN_UPLOAD_TIMEOUT_MS + 1);
      const error = await pending;
      expect(error.code).toBe('UPLOAD_UNREACHABLE');
      expect(error.message).toContain('The upload host uploads.storage.example did not answer the PUT');
      expect(error.message).toContain(`timeout after ${PODBEAN_UPLOAD_TIMEOUT_MS} ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a bad content type, zero bytes or a non-https URL before fetch is called', async () => {
    for (const [url, bytes, type] of [
      ['https://s3.amazonaws.com/x', Buffer.from('a'), ''],
      ['https://s3.amazonaws.com/x', Buffer.from('a'), 'audio/mpeg; charset=x'],
      ['https://s3.amazonaws.com/x', Buffer.from('a'), 42],
      ['https://s3.amazonaws.com/x', Buffer.alloc(0), 'audio/mpeg'],
      ['http://s3.amazonaws.com/x', Buffer.from('a'), 'audio/mpeg'],
      ['', Buffer.from('a'), 'audio/mpeg'],
    ]) {
      const { client, fetchImpl } = build();
      const error = await client.uploadMedia(url, bytes, type).catch((e) => e);
      expect(error.code).toBe('VALIDATION');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe('no credential leaves the client', () => {
  it('an error body that echoes the request line is scrubbed of the token', async () => {
    const { client } = build({
      responses: [
        tokenReply(),
        reply(400, {
          error: 'invalid_request',
          error_description: `bad request: GET /v1/podcast?access_token=${TOKEN}&x=1`,
        }),
      ],
    });
    const error = await client.getPodcast().catch((e) => e);
    expect(error.code).toBe('VALIDATION');
    expect(error.detail).toContain('access_token=***');
    expectNoCredential(error);
  });

  it('a token-endpoint error that echoes the secret or the Basic header is scrubbed', async () => {
    const { client } = build({
      responses: [
        reply(401, {
          error: 'invalid_client',
          error_description: `client ${CLIENT_ID} with secret ${CLIENT_SECRET} (Basic ${BASIC}) refused`,
        }),
      ],
    });
    const error = await client.getToken().catch((e) => e);
    expect(error.code).toBe('CREDENTIALS_REJECTED');
    expectNoCredential(error);
  });

  it('scrubs a secret however short it is (CodeRabbit on #1117: no length floor)', async () => {
    const shortSecret = 'zq7';
    const { client } = build({
      env: { PODBEAN_CLIENT_ID: CLIENT_ID, PODBEAN_CLIENT_SECRET: shortSecret },
      responses: [reply(401, { error: 'invalid_client', error_description: `secret ${shortSecret} refused` })],
    });
    const error = await client.getToken().catch((e) => e);
    expect(error.code).toBe('CREDENTIALS_REJECTED');
    expect(surfaces(error)).not.toContain(shortSecret);
    expect(error.detail).toBe('invalid_client: secret *** refused');
  });

  it('a transport error quoting the URL it was given is scrubbed of the token', async () => {
    let first = true;
    const fetchImpl = vi.fn(async (url) => {
      if (first) {
        first = false;
        return tokenReply();
      }
      throw new Error(`request to ${url} failed, reason: socket hang up`);
    });
    const client = createPodbeanClient({ env: ENV, fetch: fetchImpl });
    const error = await client.getPodcast().catch((e) => e);
    expect(error.code).toBe('NETWORK');
    expect(error.message).toContain('access_token=***');
    expectNoCredential(error);
  });

  it('an unrelated access_token in an echo is scrubbed by shape, not only by value', async () => {
    const { client } = build({
      responses: [
        tokenReply(),
        reply(400, { error: 'invalid_request', error_description: 'saw ?access_token=someone-elses-token' }),
      ],
    });
    const error = await client.getPodcast().catch((e) => e);
    expect(error.detail).toBe('invalid_request: saw ?access_token=***');
  });
});
