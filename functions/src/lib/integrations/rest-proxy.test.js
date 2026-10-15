/**
 * The credentialed pass-through proxies (#180).
 *
 * Most of this file is about `assertSafePath`, because that function is the
 * security boundary rather than input tidying. These handlers attach a Key
 * Vault secret to an outbound request whose path the caller chooses — a
 * confused deputy — and the gate in front is `editor`, not `admin`, so "the
 * caller is trusted" does not survive an XSS bug in the portal or a stolen
 * session.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createRestProxy,
  createIntegration,
  createProxyAuditWriter,
  assertSafePath,
  isAllowedPath,
  AUDIT_PATH_MAX,
} from './rest-proxy.js';

const context = { log: vi.fn(), error: vi.fn() };
const allowGuard = { requireRole: vi.fn(async () => ({ role: 'editor', error: null })) };
const denyGuard = { requireRole: vi.fn(async () => ({ error: { status: 403, body: '{}' } })) };

const TEST = createIntegration({
  name: 'Test',
  baseUrl: 'https://api.example.test/v1',
  keyEnv: 'TEST_API_KEY',
  headers: ({ apiKey }) => ({ Authorization: `Bearer ${apiKey}` }),
});

const readKey = (env, name) => env?.[name] || '';
const makeRequest = (body) => ({ json: async () => body });

function build({ env = { TEST_API_KEY: 'secret' }, fetchImpl, guard = allowGuard } = {}) {
  const impl =
    fetchImpl ||
    vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ hi: true }) }));
  const handler = createRestProxy({ guard, env, fetch: impl, readKey })(TEST);
  return { handler, fetchImpl: impl };
}

describe('assertSafePath — the security boundary', () => {
  it('allows ordinary API paths', () => {
    for (const path of ['/accounts', '/api/lists/', '/profiles', '/v1/some-path_with.chars']) {
      expect(() => assertSafePath(path)).not.toThrow();
    }
  });

  it('rejects an absolute URL, which would send the key to another host', () => {
    expect(() => assertSafePath('https://evil.test/steal')).toThrow();
  });

  it('rejects a protocol-relative path — an absolute URL that does not look like one', () => {
    expect(() => assertSafePath('//evil.test/steal')).toThrow(/protocol-relative/);
  });

  it('rejects ".." segments that climb out of the versioned prefix', () => {
    expect(() => assertSafePath('/../../admin')).toThrow(/\.\./);
  });

  it('rejects backslashes, which some servers treat as separators and URL parsers do not', () => {
    // Deliberately no '..' here: the earlier rule would fire first and this
    // test would pass without ever proving the backslash rule exists.
    expect(() => assertSafePath('/a\\b')).toThrow(/backslash/);
  });

  it('rejects control characters, including a newline that could inject a header', () => {
    expect(() => assertSafePath('/x\nHost: evil.test')).toThrow(/control/);
    expect(() => assertSafePath('/x\r\nX: y')).toThrow(/control/);
  });

  it('requires a leading slash so the join cannot become a host', () => {
    expect(() => assertSafePath('evil.test/x')).toThrow(/must start/);
    expect(() => assertSafePath('')).toThrow(/must start/);
  });
});

describe('the proxy handler', () => {
  it('forwards to the integration base with the credential attached', async () => {
    const { handler, fetchImpl } = build();
    const response = await handler(makeRequest({ path: '/accounts', method: 'GET' }), context);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/v1/accounts',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      })
    );
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, status: 200, data: { hi: true } });
  });

  it('never calls fetch at all when the path is rejected', async () => {
    // The assertion that matters: a rejected path must not produce a request
    // with the key on it, not merely an error afterwards.
    const { handler, fetchImpl } = build();
    const response = await handler(makeRequest({ path: 'https://evil.test/x' }), context);

    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes an upstream error body through instead of flattening it', async () => {
    // These pages show the operator what the upstream said; "request failed"
    // removes the only useful information.
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ errors: [{ detail: 'list id required' }] }),
    }));
    const { handler } = build({ fetchImpl });
    const body = JSON.parse((await handler(makeRequest({ path: '/api/lists/' }), context)).body);

    expect(body).toMatchObject({ ok: false, status: 422 });
    expect(body.data.errors[0].detail).toBe('list id required');
  });

  it('returns non-JSON upstream errors as text rather than discarding them', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, text: async () => '<html>bad gateway' }));
    const { handler } = build({ fetchImpl });
    const body = JSON.parse((await handler(makeRequest({ path: '/x' }), context)).body);
    expect(body.data.raw).toMatch(/bad gateway/);
  });

  it('names the missing variable when the integration is unconfigured', async () => {
    const { handler, fetchImpl } = build({ env: {} });
    const body = JSON.parse((await handler(makeRequest({ path: '/x' }), context)).body);

    expect(body).toMatchObject({ ok: false, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(body.error).toMatch(/TEST_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks every required variable, not just the primary key', async () => {
    const twoKeys = createIntegration({
      name: 'Two',
      baseUrl: 'https://api.example.test',
      keyEnv: 'TEST_API_KEY',
      extraEnv: ['TEST_WORKSPACE_ID'],
      headers: () => ({}),
    });
    const handler = createRestProxy({
      guard: allowGuard,
      env: { TEST_API_KEY: 'secret' },
      fetch: vi.fn(),
      readKey,
    })(twoKeys);
    const body = JSON.parse((await handler(makeRequest({ path: '/x' }), context)).body);
    expect(body.error).toMatch(/TEST_WORKSPACE_ID/);
  });

  it('rejects a method outside the allowlist', async () => {
    const { handler, fetchImpl } = build();
    const response = await handler(makeRequest({ path: '/x', method: 'TRACE' }), context);
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not send a body on GET', async () => {
    const { handler, fetchImpl } = build();
    await handler(makeRequest({ path: '/x', method: 'GET', body: { a: 1 } }), context);
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
  });

  it('requires a role', async () => {
    const { handler, fetchImpl } = build({ guard: denyGuard });
    const response = await handler(makeRequest({ path: '/x' }), context);
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('per-integration path allowlist', () => {
  const LINKIE_ALLOWED = {
    paths: ['/profiles', '/analytics/traffic-stats'],
    patterns: [/^\/profiles\/[^/]+\/posts$/, /^\/profiles\/[^/]+\/posts\/[^/]+$/],
  };

  const withAllowlist = createIntegration({
    name: 'Linkie',
    baseUrl: 'https://app.linkie.bio/api/v1',
    keyEnv: 'TEST_API_KEY',
    headers: ({ apiKey }) => ({ Authorization: `Bearer ${apiKey}` }),
    allowedPaths: LINKIE_ALLOWED,
  });

  const handlerFor = (fetchImpl) =>
    createRestProxy({
      guard: allowGuard,
      env: { TEST_API_KEY: 'secret' },
      fetch: fetchImpl,
      readKey,
    })(withAllowlist);

  it('allows exactly the endpoints the admin page calls', () => {
    for (const path of ['/profiles', '/analytics/traffic-stats', '/profiles/abc/posts', '/profiles/abc/posts/xyz']) {
      expect(isAllowedPath(LINKIE_ALLOWED, path), path).toBe(true);
    }
  });

  it('passes every request the Linkie Hub actually sends, so the allowlist needs no widening', async () => {
    // The claim above this test used to be aspirational: the admin page called
    // /links, /links/:id and /analytics — none of which exist upstream, and all
    // of which this allowlist correctly refused. The page now calls the real
    // API (frontend/src/lib/linkie.js), and these six requests are its entire
    // surface. If a seventh appears, this test is where widening the allowlist
    // has to be argued for rather than done quietly.
    const requests = [
      { path: '/profiles', method: 'GET' },
      { path: '/profiles/p1/posts', method: 'GET' },
      { path: '/profiles/p1/posts', method: 'POST', body: [{ url: 'https://a.test' }] },
      { path: '/profiles/p1/posts/x9', method: 'PATCH', body: { url: 'https://b.test' } },
      { path: '/profiles/p1/posts/x9', method: 'DELETE' },
      { path: '/analytics/traffic-stats?link_in_bio_id=p1', method: 'GET' },
    ];
    for (const request of requests) {
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
      const response = await handlerFor(fetchImpl)(makeRequest(request), context);
      const label = `${request.method} ${request.path}`;
      expect(response.status, label).toBe(200);
      expect(JSON.parse(response.body).ok, label).toBe(true);
      // URL AND METHOD ARE NOT THE WHOLE CLAIM. A regression that forwarded
      // the right path with an empty body would satisfy the allowlist and
      // pass this test while silently posting nothing — the write would
      // succeed, and create an empty post. So the write methods assert the
      // payload arrives too, and the read methods assert one is NOT invented,
      // since a body on a GET is its own kind of wrong. Raised in review on
      // PR #429.
      const [, options] = fetchImpl.mock.calls[0];
      expect(options.method, label).toBe(request.method);
      if (request.body === undefined) {
        expect(options.body, label).toBeUndefined();
      } else {
        expect(JSON.parse(options.body), label).toEqual(request.body);
      }
      expect(fetchImpl, label).toHaveBeenCalledWith(
        `https://app.linkie.bio/api/v1${request.path}`,
        expect.objectContaining({ method: request.method })
      );
    }
  });

  it('blocks the rest of the upstream API', () => {
    // The key's scopes are broader than any one screen needs, so an allowlist
    // is worth more than trusting whatever path the caller sends.
    for (const path of ['/billing', '/profiles/abc', '/analytics', '/profiles/abc/posts/xyz/extra']) {
      expect(isAllowedPath(LINKIE_ALLOWED, path), path).toBe(false);
    }
  });

  it('checks the path without its query string, so a query cannot disguise one', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    await handlerFor(fetchImpl)(makeRequest({ path: '/profiles?limit=10' }), context);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://app.linkie.bio/api/v1/profiles?limit=10',
      expect.anything()
    );
  });

  it('never calls fetch for a path outside the allowlist', async () => {
    const fetchImpl = vi.fn();
    const response = await handlerFor(fetchImpl)(makeRequest({ path: '/billing' }), context);
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('integrations without an allowlist are unrestricted beyond assertSafePath', () => {
    // The contract for an integration that declares no allowlist. Publer had
    // none until AP-B3 (#938) enumerated the Social Hub's calls; the Publer
    // block below is where its surface is pinned.
    expect(isAllowedPath(null, '/anything/at/all')).toBe(true);
  });
});

describe('reporting a credential verdict to the API-keys page (#358)', () => {
  // The Social Hub saw Publer's 401 before the timer did, and the API-keys page
  // learned nothing from either. The proxy now records the verdict on the way
  // through — and changes nothing about what the page that made the call gets.
  const REPORTING = createIntegration({
    name: 'Reporting',
    baseUrl: 'https://api.example.test/v1',
    keyEnv: 'TEST_API_KEY',
    headers: ({ apiKey }) => ({ Authorization: `Bearer ${apiKey}` }),
    reportsKeyVerdict: true,
  });
  const upstream = (status, body = { hi: true }) =>
    vi.fn(async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) }));
  const quiet = () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() });
  const buildReporting = ({
    integration = REPORTING,
    status,
    body,
    onKeyVerdict = vi.fn(),
    // Overridable so an integration with `extraEnv` can be configured; the
    // default keeps every existing case unchanged.
    env = { TEST_API_KEY: 'secret' },
  }) => {
    const handler = createRestProxy({
      guard: allowGuard,
      env,
      fetch: upstream(status, body),
      readKey,
      onKeyVerdict,
    })(integration);
    return { handler, onKeyVerdict };
  };
  const call = (handler, ctx = quiet()) =>
    handler(makeRequest({ path: '/accounts', method: 'GET' }), ctx);

  it.each([401, 403])(
    'reports a %i under the key setting and leaves the response exactly as it was',
    async (status) => {
      const { handler, onKeyVerdict } = buildReporting({ status, body: { error: 'nope' } });
      const response = await call(handler);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: false, status, data: { error: 'nope' } });
      // The upstream's own sentence rides with the verdict (#463 item 4): the
      // API-keys page could say a key was rejected but never why, and
      // "Missing or invalid Authorization header" and a revoked key are the
      // same red light with completely different fixes.
      expect(onKeyVerdict).toHaveBeenCalledWith('TEST_API_KEY', {
        ok: false,
        status,
        detail: 'nope',
      });
    }
  );

  it.each([401, 403])(
    'reports a %i with an empty detail when the upstream gave no reason',
    async (status) => {
      const { handler, onKeyVerdict } = buildReporting({ status, body: {} });
      await call(handler);
      expect(onKeyVerdict).toHaveBeenCalledWith('TEST_API_KEY', { ok: false, status, detail: '' });
    }
  );

  it('reads the reason out of an errors array, which is the shape Publer uses', async () => {
    const { handler, onKeyVerdict } = buildReporting({
      status: 401,
      body: { errors: ['Missing or invalid Authorization header'] },
    });
    await call(handler);
    expect(onKeyVerdict).toHaveBeenCalledWith('TEST_API_KEY', {
      ok: false,
      status: 401,
      detail: 'Missing or invalid Authorization header',
    });
  });

  it('attributes a rejection to whichever setting the integration blames for that status', async () => {
    // Publer's case, and the reason the hook exists: a 401 there means the
    // WORKSPACE ID is wrong and a 403 means the KEY is — measured against the
    // live API, and the reverse of Publer's documentation. Every other
    // integration keeps the default, which blames the key for both (#358).
    const SPLIT = createIntegration({
      name: 'Split',
      baseUrl: 'https://api.example.test/v1',
      keyEnv: 'TEST_API_KEY',
      headers: ({ apiKey }) => ({ Authorization: `Bearer ${apiKey}` }),
      reportsKeyVerdict: true,
      verdictSettingForStatus: (status) =>
        Number(status) === 401 ? 'TEST_WORKSPACE_ID' : 'TEST_API_KEY',
    });

    const four01 = buildReporting({ integration: SPLIT, status: 401, body: {} });
    await call(four01.handler);
    expect(four01.onKeyVerdict).toHaveBeenCalledWith('TEST_WORKSPACE_ID', {
      ok: false,
      status: 401,
      detail: '',
    });

    const four03 = buildReporting({ integration: SPLIT, status: 403, body: {} });
    await call(four03.handler);
    expect(four03.onKeyVerdict).toHaveBeenCalledWith('TEST_API_KEY', {
      ok: false,
      status: 403,
      detail: '',
    });
  });

  it('blames the key for both statuses when an integration says nothing', async () => {
    // The default has to stay the old behaviour: Linkie has not
    // had its 401/403 semantics measured, and guessing at a split for it
    // would be the same mistake in a new place.
    for (const status of [401, 403]) {
      const { handler, onKeyVerdict } = buildReporting({ status, body: {} });
      await call(handler);
      expect(onKeyVerdict).toHaveBeenCalledWith('TEST_API_KEY', { ok: false, status, detail: '' });
    }
  });

  it('clears every setting that travelled with the key, not just the key', async () => {
    // Copilot review of 4be3eb90. Rejections can now blame a setting other
    // than the key — Publer's 401 blames the workspace id — so clearing only
    // `keyEnv` on success would leave that light stuck red through every
    // subsequent successful call. The timer's client clears the pair for the
    // same reason, and the two must agree or the page flickers between them.
    const PAIR = createIntegration({
      name: 'Pair',
      baseUrl: 'https://api.example.test/v1',
      keyEnv: 'TEST_API_KEY',
      extraEnv: ['TEST_WORKSPACE_ID'],
      headers: ({ apiKey }) => ({ Authorization: `Bearer ${apiKey}` }),
      reportsKeyVerdict: true,
    });
    const { handler, onKeyVerdict } = buildReporting({
      integration: PAIR,
      status: 200,
      env: { TEST_API_KEY: 'secret', TEST_WORKSPACE_ID: 'w1' },
    });
    await call(handler);
    expect(onKeyVerdict).toHaveBeenCalledWith('TEST_API_KEY', { ok: true });
    expect(onKeyVerdict).toHaveBeenCalledWith('TEST_WORKSPACE_ID', { ok: true });
  });

  it('reports a success, so a rotated key turns the light green from this path too', async () => {
    const { handler, onKeyVerdict } = buildReporting({ status: 200 });
    expect(JSON.parse((await call(handler)).body)).toEqual({
      ok: true,
      status: 200,
      data: { hi: true },
    });
    expect(onKeyVerdict).toHaveBeenCalledWith('TEST_API_KEY', { ok: true });
  });

  it.each([404, 429, 500])('does not report a %i — it says nothing about the key', async (status) => {
    const { handler, onKeyVerdict } = buildReporting({ status, body: { error: 'x' } });
    expect(JSON.parse((await call(handler)).body)).toEqual({
      ok: false,
      status,
      data: { error: 'x' },
    });
    expect(onKeyVerdict).not.toHaveBeenCalled();
  });

  it('reports nothing for an integration that did not opt in, even with a writer wired', async () => {
    // Linkie: its 401/403 semantics have not been read, and the
    // catalogue promises a probe only where one is wired.
    const { handler, onKeyVerdict } = buildReporting({
      integration: TEST,
      status: 401,
      body: { error: 'nope' },
    });
    expect(JSON.parse((await call(handler)).body)).toEqual({
      ok: false,
      status: 401,
      data: { error: 'nope' },
    });
    expect(onKeyVerdict).not.toHaveBeenCalled();
  });

  it('never fails the proxied call because the writer threw, and warns into the invocation log', async () => {
    const onKeyVerdict = vi.fn(async () => {
      throw new Error('Cosmos is having a day');
    });
    const { handler } = buildReporting({ status: 401, body: { error: 'nope' }, onKeyVerdict });
    const ctx = quiet();
    const response = await call(handler, ctx);
    expect(JSON.parse(response.body)).toEqual({ ok: false, status: 401, data: { error: 'nope' } });
    expect(ctx.warn).toHaveBeenCalledTimes(1);
    expect(ctx.warn.mock.calls[0][0]).toMatch(/^\[ReportingProxy\] could not record a key verdict/);
  });

  it('works with no writer, which is how every other test here builds the proxy', async () => {
    const handler = createRestProxy({
      guard: allowGuard,
      env: { TEST_API_KEY: 'secret' },
      fetch: upstream(401, { error: 'nope' }),
      readKey,
    })(REPORTING);
    expect(JSON.parse((await call(handler)).body)).toEqual({
      ok: false,
      status: 401,
      data: { error: 'nope' },
    });
  });
});

describe('the Publer allowlist (AP-B3, #938)', () => {
  // Mirrors integrations-http.js. The paths come from
  // frontend/src/components/admin/social/publerApi.js, the Social tab of
  // Platform settings and the Connections card; the methods are the three
  // those files send.
  const PUBLER_ALLOWED = {
    paths: [
      { path: '/accounts', methods: ['GET'] },
      { path: '/posts', methods: ['GET', 'DELETE'] },
      { path: '/posts/schedule', methods: ['POST'] },
      { path: '/posts/schedule/publish', methods: ['POST'] },
    ],
    patterns: [{ pattern: /^\/job_status\/[A-Za-z0-9_-]+$/, methods: ['GET'] }],
  };
  const publer = createIntegration({
    name: 'Publer',
    baseUrl: 'https://app.publer.com/api/v1',
    keyEnv: 'TEST_API_KEY',
    headers: ({ apiKey }) => ({ Authorization: `Bearer-API ${apiKey}` }),
    allowedPaths: PUBLER_ALLOWED,
    allowedMethods: ['GET', 'POST', 'DELETE'],
  });
  const handlerFor = (fetchImpl, audit = null) =>
    createRestProxy({ guard: allowGuard, env: { TEST_API_KEY: 'secret' }, fetch: fetchImpl, readKey, audit })(
      publer
    );

  it('passes every request the Social Hub actually sends, so the allowlist needs no widening', async () => {
    const requests = [
      { path: '/accounts', method: 'GET' },
      { path: '/posts?state=scheduled', method: 'GET' },
      { path: '/posts?state=published&page=1', method: 'GET' },
      { path: '/posts/schedule', method: 'POST', body: { bulk: { posts: [] } } },
      { path: '/posts/schedule/publish', method: 'POST', body: { bulk: { posts: [] } } },
      { path: '/posts?post_ids[]=abc123', method: 'DELETE' },
      { path: '/job_status/job-9_X', method: 'GET' },
    ];
    for (const request of requests) {
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
      const response = await handlerFor(fetchImpl)(makeRequest(request), context);
      const label = `${request.method} ${request.path}`;
      expect(response.status, label).toBe(200);
      expect(JSON.parse(response.body).ok, label).toBe(true);
      expect(fetchImpl, label).toHaveBeenCalledWith(
        `https://app.publer.com/api/v1${request.path}`,
        expect.objectContaining({ method: request.method })
      );
      const [, options] = fetchImpl.mock.calls[0];
      if (request.body === undefined) {
        expect(options.body, label).toBeUndefined();
      } else {
        expect(JSON.parse(options.body), label).toEqual(request.body);
      }
    }
  });

  it('refuses an unlisted Publer path for every verb, and never calls fetch', async () => {
    for (const path of ['/workspaces', '/accounts/acc-1', '/posts/post-1', '/members', '/job_status/j/extra', '/users/me']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const fetchImpl = vi.fn();
        const response = await handlerFor(fetchImpl)(makeRequest({ path, method }), context);
        expect(response.status, `${method} ${path}`).toBe(400);
        expect(fetchImpl, `${method} ${path}`).not.toHaveBeenCalled();
      }
    }
  });

  it('refuses an allowed path with a verb the Social Hub never sends it with (review on #1167)', async () => {
    // Method and path are bound, not a cross-product: Publer is not assumed
    // to refuse what the Hub never sends.
    for (const [path, method] of [
      ['/posts/schedule', 'DELETE'],
      ['/posts/schedule/publish', 'DELETE'],
      ['/accounts', 'POST'],
      ['/accounts', 'DELETE'],
      ['/posts', 'POST'],
      ['/posts/schedule', 'GET'],
      ['/job_status/j1', 'POST'],
      ['/job_status/j1', 'DELETE'],
    ]) {
      const fetchImpl = vi.fn();
      const response = await handlerFor(fetchImpl)(makeRequest({ path, method }), context);
      expect(response.status, `${method} ${path}`).toBe(400);
      expect(fetchImpl, `${method} ${path}`).not.toHaveBeenCalled();
    }
    for (const [path, method] of [
      ['/posts', 'GET'],
      ['/posts', 'DELETE'],
      ['/accounts', 'GET'],
      ['/job_status/j1', 'GET'],
    ]) {
      expect(isAllowedPath(PUBLER_ALLOWED, path, method), `${method} ${path}`).toBe(true);
    }
  });

  it('judges a bare string or RegExp entry by path alone, which is what Linkie declares', () => {
    const bare = { paths: ['/profiles'], patterns: [/^\/profiles\/[^/]+\/posts$/] };
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(isAllowedPath(bare, '/profiles', method)).toBe(true);
      expect(isAllowedPath(bare, '/profiles/p1/posts', method)).toBe(true);
    }
    expect(isAllowedPath(bare, '/profiles')).toBe(true);
  });

  it('refuses PUT and PATCH even on an allowed path, because the Social Hub never sends them', async () => {
    for (const method of ['PUT', 'PATCH']) {
      const fetchImpl = vi.fn();
      const response = await handlerFor(fetchImpl)(makeRequest({ path: '/posts', method }), context);
      expect(response.status, method).toBe(400);
      expect(JSON.parse(response.body).error, method).toContain('not an allowed Publer method');
      expect(fetchImpl, method).not.toHaveBeenCalled();
    }
  });

  it('refuses a method allowlist that names a method the proxy does not forward', () => {
    expect(() =>
      createIntegration({
        name: 'Broken',
        baseUrl: 'https://x.test',
        keyEnv: 'K',
        headers: () => ({}),
        allowedMethods: ['GET', 'TRACE'],
      })
    ).toThrow(/TRACE/);
  });
});

describe('the audit row every non-GET proxy call leaves (AP-B3, #938)', () => {
  const editor = { oid: 'oid-ed', name: 'Ed Itor', email: 'ed@example.test' };
  const editorGuard = { requireRole: vi.fn(async () => ({ user: editor, role: 'editor', error: null })) };
  const publer = createIntegration({
    name: 'Publer',
    baseUrl: 'https://app.publer.com/api/v1',
    keyEnv: 'TEST_API_KEY',
    headers: ({ apiKey }) => ({ Authorization: `Bearer-API ${apiKey}` }),
    allowedPaths: { paths: ['/posts', '/posts/schedule'] },
    allowedMethods: ['GET', 'POST', 'DELETE'],
  });
  const build = ({ fetchImpl, audit }) =>
    createRestProxy({ guard: editorGuard, env: { TEST_API_KEY: 'secret' }, fetch: fetchImpl, readKey, audit })(
      publer
    );
  const okFetch = () => vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));

  it('records the actor, method, path (query included) and upstream status of a write', async () => {
    const audit = vi.fn(async () => {});
    await build({ fetchImpl: okFetch(), audit })(makeRequest({ path: '/posts?post_ids[]=p1', method: 'DELETE' }), context);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      integration: 'Publer',
      method: 'DELETE',
      path: '/posts?post_ids[]=p1',
      pathTruncated: false,
      outcome: 'upstream',
      status: 200,
      user: editor,
      role: 'editor',
    });
  });

  it('keeps a long path whole, since the ids a delete names sit at its end', async () => {
    // Sixty ids: the kind of bulk delete the queue can send, well past the
    // 300-character prefix the first version kept (review on #1167).
    const ids = Array.from({ length: 60 }, (_, n) => `post_ids[]=post-${String(n).padStart(4, '0')}`);
    const path = `/posts?${ids.join('&')}`;
    expect(path.length).toBeGreaterThan(300);
    const audit = vi.fn(async () => {});
    await build({ fetchImpl: okFetch(), audit })(makeRequest({ path, method: 'DELETE' }), context);
    const [entry] = audit.mock.calls[0];
    expect(entry.path).toBe(path);
    expect(entry.pathTruncated).toBe(false);
  });

  it('cuts only a path past the ceiling, and says so on the row', async () => {
    const path = `/posts?${'x'.repeat(AUDIT_PATH_MAX + 50)}`;
    const audit = vi.fn(async () => {});
    // /posts is allowed and the query is not part of the check, so the call
    // is forwarded whole; only the audit row is cut, at the ceiling, and says so.
    const fetchImpl = okFetch();
    await build({ fetchImpl, audit })(makeRequest({ path, method: 'DELETE' }), context);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [entry] = audit.mock.calls[0];
    expect(entry.path).toHaveLength(AUDIT_PATH_MAX);
    expect(entry.pathTruncated).toBe(true);
    const upsertDoc = vi.fn(async () => {});
    await createProxyAuditWriter({ upsertDoc, now: () => 't', uuid: () => 'r' })(entry);
    expect(upsertDoc.mock.calls[0][1].details.pathTruncated).toBe(true);
  });

  it('records a refused path and a refused method too, since a refusal is the evidence', async () => {
    const audit = vi.fn(async () => {});
    const fetchImpl = vi.fn();
    await build({ fetchImpl, audit })(makeRequest({ path: '/workspaces', method: 'DELETE' }), context);
    await build({ fetchImpl, audit })(makeRequest({ path: '/posts', method: 'PATCH' }), context);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(audit.mock.calls.map(([entry]) => [entry.method, entry.path, entry.outcome])).toEqual([
      ['DELETE', '/workspaces', 'refused_path'],
      ['PATCH', '/posts', 'refused_method'],
    ]);
  });

  it('writes nothing for a GET', async () => {
    const audit = vi.fn(async () => {});
    await build({ fetchImpl: okFetch(), audit })(makeRequest({ path: '/posts?state=scheduled' }), context);
    expect(audit).not.toHaveBeenCalled();
  });

  it('never fails the proxied call because the audit write threw, and warns into the invocation log', async () => {
    const warn = vi.fn();
    const audit = vi.fn(async () => {
      throw new Error('cosmos is away');
    });
    const response = await build({ fetchImpl: okFetch(), audit })(
      makeRequest({ path: '/posts/schedule', method: 'POST', body: { bulk: {} } }),
      { ...context, warn }
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('audit row failed'));
  });

  it('createProxyAuditWriter writes the shared admin_audit_logs shape', async () => {
    const upsertDoc = vi.fn(async () => {});
    const write = createProxyAuditWriter({ upsertDoc, now: () => '2026-10-14T18:00:00.000Z', uuid: () => 'row-1' });
    await write({
      integration: 'Publer',
      method: 'POST',
      path: '/posts/schedule',
      outcome: 'upstream',
      status: 201,
      user: editor,
      role: 'editor',
    });
    expect(upsertDoc).toHaveBeenCalledWith('admin_audit_logs', {
      id: 'row-1',
      action: 'publer_proxy_post',
      userId: 'oid-ed',
      userName: 'Ed Itor',
      userEmail: 'ed@example.test',
      timestamp: '2026-10-14T18:00:00.000Z',
      details: {
        integration: 'Publer',
        method: 'POST',
        path: '/posts/schedule',
        outcome: 'upstream',
        status: 201,
        role: 'editor',
      },
    });
  });

  describe('AP-B12: secrets redaction on proxy responses and errors', () => {
    const publer = createIntegration({
      name: 'Publer',
      baseUrl: 'https://api.publer.io/v1',
      keyEnv: 'TEST_API_KEY',
      headers: ({ apiKey }) => ({ Authorization: `Bearer-API ${apiKey}` }),
      allowedPaths: { paths: ['/accounts'] },
      allowedMethods: ['GET', 'POST', 'DELETE'],
    });
    const handler = (fetchImpl) =>
      createRestProxy({
        guard: allowGuard,
        env: { TEST_API_KEY: 'publer-key-secret-12345' },
        fetch: fetchImpl,
        readKey,
      })(publer);

    it('redacts upstream secrets from raw text before returning to client', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'Error with key publer-key-secret-12345 in upstream response',
      }));

      const res = await handler(fetchImpl)(
        makeRequest({ path: '/accounts', method: 'GET' }),
        context
      );
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.data.raw).not.toContain('publer-key-secret-12345');
      expect(parsed.data.raw).toContain('***');
    });

    it('redacts secrets from parsed JSON upstream bodies', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'Invalid token: publer-key-secret-12345' }),
      }));

      const res = await handler(fetchImpl)(
        makeRequest({ path: '/accounts', method: 'GET' }),
        context
      );
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.data.message).not.toContain('publer-key-secret-12345');
      expect(parsed.data.message).toContain('***');
    });

    it('redacts secrets from network failure error messages', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED https://publer-key-secret-12345@api.publer.io');
      });

      const res = await handler(fetchImpl)(
        makeRequest({ path: '/accounts', method: 'GET' }),
        context
      );
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).not.toContain('publer-key-secret-12345');
      // Stronger than redaction: no transport text at all reaches the answer
      // (#945), only the service, the failure's code and a correlation id.
      expect(parsed.error).toBe('Publer could not be reached (Error).');
      expect(parsed.correlationId).toEqual(expect.any(String));
      expect(res.body).not.toContain('ECONNREFUSED https://');
    });

    it('redacts secrets containing characters that are JSON-escaped in raw upstream text', async () => {
      const complexSecret = 'key"with\\quotes';
      const complexHandler = (fetchImpl) =>
        createRestProxy({
          guard: allowGuard,
          env: { TEST_API_KEY: complexSecret },
          fetch: fetchImpl,
          readKey,
        })(publer);

      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: `Rejected: ${complexSecret}` }),
      }));

      const res = await complexHandler(fetchImpl)(
        makeRequest({ path: '/accounts', method: 'GET' }),
        context
      );
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.data.message).not.toContain(complexSecret);
      expect(parsed.data.message).toContain('***');
    });
  });
});
