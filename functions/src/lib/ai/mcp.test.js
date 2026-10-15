import { describe, expect, it, vi } from 'vitest';
import {
  createMcpHandlers,
  readMcpSecret,
  resolveMcpAuthHeaders,
  validateMcpUrl,
  validateMcpApiKeyEnvVar,
  validateMcpKeyBinding,
  INTEGRATION_KEY_HOSTS,
  KNOWN_INTEGRATION_KEY_NAMES,
  TOOL_ALLOWLIST_REQUIRED_KEYS,
  mcpToolRefusal,
  validateMcpToolPolicy,
} from './mcp.js';

const context = { error: vi.fn() };
const allowGuard = {
  requireRole: vi.fn(async () => ({ role: 'editor', error: null })),
};
const denyGuard = {
  requireRole: vi.fn(async () => ({
    error: { status: 403, body: JSON.stringify({ ok: false }) },
  })),
};

const request = (body) => ({ json: async () => body });
const response = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const fixedNow = () => new Date('2026-08-24T12:00:00.000Z');

function makeStore(server, overrides = {}) {
  return {
    readDoc: vi.fn(async () => server),
    patchDoc: vi.fn(async (_container, id, updates) => ({
      ...server,
      id,
      ...updates,
    })),
    ...overrides,
  };
}

describe('MCP secret and URL helpers', () => {
  it('reads resolved Azure settings and ignores unresolved Key Vault references', () => {
    expect(readMcpSecret({ KEY: '\uFEFF real-key ' }, 'KEY')).toBe('real-key');
    expect(
      readMcpSecret({ KEY: '@Microsoft.KeyVault(SecretUri=https://vault/secrets/key)' }, 'KEY')
    ).toBe('');
    expect(
      resolveMcpAuthHeaders({
        apiKeyEnvVar: 'MCP_KEY',
        env: { MCP_KEY: 'abc' },
      })
    ).toEqual({
      Authorization: 'Bearer abc',
    });
  });

  it('never sends an app setting outside the MCP_* / integration allowlist as a bearer (ADR 0033)', () => {
    // The finding: any app-setting name was accepted, so a custom server at
    // an attacker's URL could name the Cosmos connection string.
    expect(
      resolveMcpAuthHeaders({
        apiKeyEnvVar: 'COSMOS_CONNECTION_STRING',
        env: { COSMOS_CONNECTION_STRING: 'AccountEndpoint=...' },
      })
    ).toEqual({});
    expect(() => validateMcpApiKeyEnvVar('COSMOS_CONNECTION_STRING')).toThrow(/MCP_\* app setting/);
    expect(() => validateMcpApiKeyEnvVar('ANTHROPIC_API_KEY')).toThrow(/not allowed/);
    expect(() => validateMcpApiKeyEnvVar(42)).toThrow(/string/);
  });

  it('accepts the MCP_* namespace, the seeded integration keys, and no key at all', () => {
    expect(validateMcpApiKeyEnvVar('MCP_CONTEXT7_KEY')).toBe('MCP_CONTEXT7_KEY');
    for (const name of KNOWN_INTEGRATION_KEY_NAMES) {
      expect(validateMcpApiKeyEnvVar(name)).toBe(name);
    }
    expect(validateMcpApiKeyEnvVar(null)).toBeNull();
    expect(validateMcpApiKeyEnvVar('')).toBeNull();
    expect(validateMcpApiKeyEnvVar(undefined)).toBeNull();
    expect(
      resolveMcpAuthHeaders({
        apiKeyEnvVar: 'FIRECRAWL_API_KEY',
        url: 'https://mcp.firecrawl.dev/sse',
        env: { FIRECRAWL_API_KEY: 'fc' },
      })
    ).toEqual({ Authorization: 'Bearer fc' });
  });

  it('binds each shared integration key to its vendor host, and MCP_* keys to none (AP-B1)', () => {
    // Every shared key has a binding, and every seeded host is in it.
    for (const name of KNOWN_INTEGRATION_KEY_NAMES) {
      expect(INTEGRATION_KEY_HOSTS[name].length).toBeGreaterThan(0);
    }
    expect(
      validateMcpKeyBinding({ url: 'https://mcp.firecrawl.dev/sse', apiKeyEnvVar: 'FIRECRAWL_API_KEY' })
    ).toBe('FIRECRAWL_API_KEY');
    expect(
      validateMcpKeyBinding({ url: 'https://MCP.Replicate.com/sse', apiKeyEnvVar: 'REPLICATE_API_KEY' })
    ).toBe('REPLICATE_API_KEY');
    // The finding: a shared key named on a server at any other host.
    expect(() =>
      validateMcpKeyBinding({ url: 'https://attacker.example/mcp', apiKeyEnvVar: 'REPLICATE_API_KEY' })
    ).toThrow(/REPLICATE_API_KEY may only be sent to mcp\.replicate\.com/);
    // The lab-host token's localhost binding is gone with the localhost
    // Hostinger entry (2026-10-08): the name is refused everywhere now.
    for (const url of ['http://localhost:8100', 'https://mcp.hostinger.com']) {
      expect(() => validateMcpKeyBinding({ url, apiKeyEnvVar: 'VPS_API_TOKEN' })).toThrow(/not allowed/);
    }
    expect(() =>
      validateMcpKeyBinding({ url: 'https://firecrawl.dev.attacker.example/', apiKeyEnvVar: 'FIRECRAWL_API_KEY' })
    ).toThrow(/may only be sent to mcp\.firecrawl\.dev/);
    expect(() => validateMcpKeyBinding({ url: undefined, apiKeyEnvVar: 'REPLICATE_API_KEY' })).toThrow(
      /may only be sent to/
    );
    // A per-server MCP_* secret and no key at all bind to no host.
    expect(validateMcpKeyBinding({ url: 'https://anything.example/', apiKeyEnvVar: 'MCP_CUSTOM' })).toBe(
      'MCP_CUSTOM'
    );
    expect(validateMcpKeyBinding({ url: 'https://anything.example/', apiKeyEnvVar: null })).toBeNull();
  });

  it('resolves no bearer for a shared key at an unbound host, or with no URL at all (AP-B1)', () => {
    const env = { FIRECRAWL_API_KEY: 'fc' };
    expect(
      resolveMcpAuthHeaders({ apiKeyEnvVar: 'FIRECRAWL_API_KEY', url: 'https://attacker.example/', env })
    ).toEqual({});
    expect(resolveMcpAuthHeaders({ apiKeyEnvVar: 'FIRECRAWL_API_KEY', env })).toEqual({});
    expect(
      resolveMcpAuthHeaders({ apiKeyEnvVar: 'MCP_CUSTOM', url: 'https://anything.example/', env: { MCP_CUSTOM: 'k' } })
    ).toEqual({ Authorization: 'Bearer k' });
  });

  it('prefers the stored OAuth token over the App Setting', () => {
    expect(
      resolveMcpAuthHeaders({
        oauthToken: 'oauth',
        apiKeyEnvVar: 'KEY',
        env: { KEY: 'api-key' },
      })
    ).toEqual({ Authorization: 'Bearer oauth' });
  });

  it('requires https with no exception and rejects embedded credentials', () => {
    expect(validateMcpUrl('https://example.test/mcp')).toBe('https://example.test/mcp');
    expect(() => validateMcpUrl('ftp://example.test/mcp')).toThrow(/https/);
    // A bearer token over plain http is readable on the wire (ADR 0033).
    expect(() => validateMcpUrl('http://example.test/mcp')).toThrow(/must use https/);
    // The loopback exception served only the localhost Hostinger entry,
    // which a Function App could never reach; it is gone (2026-10-08).
    for (const url of ['http://localhost:8100', 'http://127.0.0.1:8100/mcp', 'http://[::1]:8100/']) {
      expect(() => validateMcpUrl(url)).toThrow(/must use https/);
    }
    for (const url of ['https://localhost:8100', 'https://127.0.0.1:8100/mcp', 'https://[::1]:8100/']) {
      expect(() => validateMcpUrl(url)).toThrow(/loopback/);
    }
    expect(validateMcpUrl('https://mcp.hostinger.com')).toBe('https://mcp.hostinger.com/');
    expect(() => validateMcpUrl('https://user:pass@example.test/mcp')).toThrow(/credentials/);
  });
});

describe('syncMcpTools', () => {
  it('calls the configured server with a server-side bearer token and persists the manifest', async () => {
    const server = {
      id: 'context7',
      url: 'https://context7.test/mcp',
      transport: 'http',
      apiKeyEnvVar: 'MCP_KEY',
    };
    const store = makeStore(server);
    const fetch = vi.fn(async (_url, options) => {
      expect(options.headers.Authorization).toBe('Bearer secret');
      expect(JSON.parse(options.body)).toMatchObject({
        method: 'tools/list',
        id: 1,
      });
      return response({
        jsonrpc: '2.0',
        result: {
          tools: [
            {
              name: 'search',
              description: 'Search docs',
              inputSchema: { type: 'object' },
            },
          ],
        },
      });
    });

    const handlers = createMcpHandlers({
      guard: allowGuard,
      store,
      env: { MCP_KEY: 'secret' },
      fetch,
      now: fixedNow,
    });
    const result = await handlers.syncMcpTools(request({ serverId: 'context7' }), context);

    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      tools: [
        {
          name: 'search',
          description: 'Search docs',
          inputSchema: { type: 'object' },
        },
      ],
    });
    expect(store.patchDoc).toHaveBeenCalledWith('mcp_servers', 'context7', {
      tools: [
        {
          name: 'search',
          description: 'Search docs',
          inputSchema: { type: 'object' },
        },
      ],
      status: 'connected',
      lastTested: '2026-08-24T12:00:00.000Z',
      lastError: null,
    });
  });

  it('refuses to sync a server that names a shared key at an unbound host, without calling it (AP-B1)', async () => {
    const server = {
      id: 'rogue',
      url: 'https://attacker.example/mcp',
      transport: 'http',
      apiKeyEnvVar: 'FIRECRAWL_API_KEY',
      enabled: true,
    };
    const store = makeStore(server);
    const fetch = vi.fn();
    const handlers = createMcpHandlers({
      guard: allowGuard,
      store,
      env: { FIRECRAWL_API_KEY: 'the-firecrawl-key' },
      fetch,
      now: fixedNow,
    });
    const result = await handlers.syncMcpTools(request({ serverId: 'rogue' }), context);
    const body = JSON.parse(result.body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/FIRECRAWL_API_KEY may only be sent to/);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.body).not.toContain('the-firecrawl-key');

    const proxied = await handlers.mcpProxy(
      request({ serverId: 'rogue', tool: 'anything', arguments: {} }),
      context
    );
    expect(JSON.parse(proxied.body).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records a server-side error without exposing a credential', async () => {
    const store = makeStore({
      id: 'bad',
      url: 'https://bad.test/mcp',
      transport: 'http',
    });
    const fetch = vi.fn(async () => response({ error: 'invalid_token' }, 401));
    const handlers = createMcpHandlers({
      guard: allowGuard,
      store,
      env: { BAD_KEY: 'secret-value' },
      fetch,
      now: fixedNow,
    });

    const result = JSON.parse(
      (await handlers.syncMcpTools(request({ serverId: 'bad' }), context)).body
    );
    expect(result).toMatchObject({
      ok: false,
      tools: [],
      code: 'UNAUTHENTICATED',
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(store.patchDoc).toHaveBeenCalledWith(
      'mcp_servers',
      'bad',
      expect.objectContaining({
        status: 'error',
        lastError: expect.any(String),
      })
    );
  });

  it('requires the editor role before reading Cosmos', async () => {
    const store = makeStore(null);
    const handlers = createMcpHandlers({
      guard: denyGuard,
      store,
      fetch: vi.fn(),
    });
    const result = await handlers.syncMcpTools(request({ serverId: 'context7' }), context);
    expect(result.status).toBe(403);
    expect(store.readDoc).not.toHaveBeenCalled();
  });
});

describe('mcpProxy', () => {
  it('calls an enabled tool and returns its text plus raw result', async () => {
    const store = makeStore({
      id: 'context7',
      url: 'https://context7.test/mcp',
      transport: 'http',
      enabled: true,
    });
    const fetch = vi.fn(async () =>
      response({
        jsonrpc: '2.0',
        result: { content: [{ type: 'text', text: 'documentation' }] },
      })
    );
    const handlers = createMcpHandlers({ guard: allowGuard, store, fetch });
    const result = JSON.parse(
      (
        await handlers.mcpProxy(
          request({
            serverId: 'context7',
            tool: 'get-library-docs',
            arguments: { topic: 'mcp' },
          }),
          context
        )
      ).body
    );

    expect(result).toEqual({
      ok: true,
      result: 'documentation',
      raw: { content: [{ type: 'text', text: 'documentation' }] },
    });
  });

  it('does not call a disabled server', async () => {
    const fetch = vi.fn();
    const handlers = createMcpHandlers({
      guard: allowGuard,
      store: makeStore({
        id: 'disabled',
        url: 'https://disabled.test/mcp',
        enabled: false,
      }),
      fetch,
    });
    const result = await handlers.mcpProxy(
      request({ serverId: 'disabled', tool: 'noop', arguments: {} }),
      context
    );
    expect(result.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Publer MCP binding (2026-10-07)', () => {
  const PUBLER_MCP_URL = 'https://mcp.publer.com/';

  it('accepts PUBLER_API_KEY at mcp.publer.com and sends it as a bearer there', () => {
    expect(validateMcpApiKeyEnvVar('PUBLER_API_KEY')).toBe('PUBLER_API_KEY');
    expect(INTEGRATION_KEY_HOSTS.PUBLER_API_KEY).toEqual(['mcp.publer.com']);
    expect(validateMcpKeyBinding({ url: PUBLER_MCP_URL, apiKeyEnvVar: 'PUBLER_API_KEY' })).toBe(
      'PUBLER_API_KEY'
    );
    expect(
      validateMcpKeyBinding({ url: 'https://MCP.Publer.com', apiKeyEnvVar: 'PUBLER_API_KEY' })
    ).toBe('PUBLER_API_KEY');
    // Publer's server names "Authorization: Bearer YOUR_KEY" in its own
    // missing-key error, beside the settings page's "Bearer-API", so the
    // shared resolver's shape is one it accepts.
    expect(
      resolveMcpAuthHeaders({
        apiKeyEnvVar: 'PUBLER_API_KEY',
        url: PUBLER_MCP_URL,
        env: { PUBLER_API_KEY: 'pk' },
      })
    ).toEqual({ Authorization: 'Bearer pk' });
  });

  it('refuses PUBLER_API_KEY at every other host, the REST host included', () => {
    for (const url of [
      'https://app.publer.com/api/v1',
      'https://publer.com/mcp',
      'https://mcp.publer.com.attacker.example/',
      'https://attacker.example/mcp',
      'http://localhost:8100',
    ]) {
      expect(() => validateMcpKeyBinding({ url, apiKeyEnvVar: 'PUBLER_API_KEY' })).toThrow(
        /PUBLER_API_KEY may only be sent to mcp\.publer\.com/
      );
      expect(
        resolveMcpAuthHeaders({
          apiKeyEnvVar: 'PUBLER_API_KEY',
          url,
          env: { PUBLER_API_KEY: 'pk' },
        })
      ).toEqual({});
    }
    // The workspace id is an identifier the REST proxy sends, never an MCP key.
    expect(() => validateMcpApiKeyEnvVar('PUBLER_WORKSPACE_ID')).toThrow(/not allowed/);
  });

  it('refuses a Publer MCP URL carrying the key as a query string, without echoing it', () => {
    expect(validateMcpUrl('https://mcp.publer.com')).toBe(PUBLER_MCP_URL);
    let message = '';
    try {
      validateMcpUrl('https://mcp.publer.com?api_key=the-publer-key');
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/must not carry a query string/);
    expect(message).not.toContain('the-publer-key');
  });

  it('leaves every other key, host and URL rule as it was', () => {
    // The lab-host token left with the localhost Hostinger entry (2026-10-08).
    expect([...KNOWN_INTEGRATION_KEY_NAMES]).toEqual([
      'FIRECRAWL_API_KEY',
      'PUBLER_API_KEY',
      'REPLICATE_API_KEY',
    ]);
    expect(INTEGRATION_KEY_HOSTS).toEqual({
      FIRECRAWL_API_KEY: ['mcp.firecrawl.dev', 'api.firecrawl.dev'],
      PUBLER_API_KEY: ['mcp.publer.com'],
      REPLICATE_API_KEY: ['mcp.replicate.com', 'api.replicate.com'],
    });
    // A query string elsewhere is untouched by the Publer rule.
    expect(validateMcpUrl('https://example.test/mcp?profile=a')).toBe(
      'https://example.test/mcp?profile=a'
    );
    // No other shared key gained mcp.publer.com.
    for (const name of ['FIRECRAWL_API_KEY', 'REPLICATE_API_KEY']) {
      expect(() => validateMcpKeyBinding({ url: PUBLER_MCP_URL, apiKeyEnvVar: name })).toThrow(
        /may only be sent to/
      );
    }
    // MCP_* still binds to no host, Publer's included.
    expect(validateMcpKeyBinding({ url: PUBLER_MCP_URL, apiKeyEnvVar: 'MCP_PUBLER' })).toBe(
      'MCP_PUBLER'
    );
  });

  it('syncs the Publer server over Streamable HTTP with the key from the app setting', async () => {
    const store = makeStore({
      id: 'publer-mcp',
      url: 'https://mcp.publer.com',
      transport: 'http',
      apiKeyEnvVar: 'PUBLER_API_KEY',
      enabled: false,
    });
    const fetch = vi.fn(async (url, options) => {
      expect(url).toBe(PUBLER_MCP_URL);
      expect(options.headers.Authorization).toBe('Bearer pk');
      // Publer answers tools/list as one SSE frame (measured 2026-10-07).
      return response(
        'event: message\ndata: {"result":{"tools":[{"name":"get_publer_user","description":"Who","inputSchema":{"type":"object"}}]},"jsonrpc":"2.0","id":1}\n\n',
        200,
        { 'content-type': 'text/event-stream' }
      );
    });
    const handlers = createMcpHandlers({
      guard: allowGuard,
      store,
      env: { PUBLER_API_KEY: 'pk' },
      fetch,
      now: fixedNow,
    });
    const result = await handlers.syncMcpTools(request({ serverId: 'publer-mcp' }), context);
    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      tools: [{ name: 'get_publer_user', description: 'Who', inputSchema: { type: 'object' } }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('MCP tool allowlist (#995, 2026-10-07)', () => {
  // A cut of the seeded publer-mcp list (frontend/src/lib/aiEngine/seed.js,
  // checked against this policy by frontend/src/lib/aiEngine.test.js).
  const READ_TOOLS = ['get_publer_user', 'lookup_publer_accounts', 'list_publer_drafts'];
  const WRITE_TOOLS = [
    'submit_publer_posts',
    'publish_publer_draft',
    'update_publer_post',
    'reschedule_publer_post',
    'change_publer_post_state',
    'delete_publer_posts',
    'confirm_delete_publer_posts',
    'create_publer_post_from_file',
    'create_publer_photo_draft',
    'create_publer_ideas',
    'upload_publer_media_from_url',
    'upload_publer_chat_media',
    'upload_publer_media',
  ];
  const seededPubler = (over = {}) => ({
    id: 'publer-mcp',
    url: 'https://mcp.publer.com',
    transport: 'http',
    apiKeyEnvVar: 'PUBLER_API_KEY',
    allowedTools: [...READ_TOOLS],
    enabled: true,
    ...over,
  });
  const superAdminGuard = {
    requireRole: vi.fn(async () => ({ role: 'super_admin', error: null })),
  };
  const toolResult = () =>
    response({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Saul, Business' }] } });
  const call = (guard, server, tool, fetch) =>
    createMcpHandlers({ guard, store: makeStore(server), env: { PUBLER_API_KEY: 'pk' }, fetch }).mcpProxy(
      request({ serverId: server.id, tool, arguments: {} }),
      context
    );

  it('requires a non-empty list for the Publer key only, and fails closed on a malformed one', () => {
    expect([...TOOL_ALLOWLIST_REQUIRED_KEYS]).toEqual(['PUBLER_API_KEY']);
    expect(validateMcpToolPolicy({ apiKeyEnvVar: 'PUBLER_API_KEY', allowedTools: READ_TOOLS })).toEqual(
      READ_TOOLS
    );
    for (const allowedTools of [undefined, null, []]) {
      expect(() => validateMcpToolPolicy({ apiKeyEnvVar: 'PUBLER_API_KEY', allowedTools })).toThrow(
        /PUBLER_API_KEY must name the tools/
      );
    }
    for (const allowedTools of ['all', [''], [42], { 0: 'x' }]) {
      expect(() => validateMcpToolPolicy({ apiKeyEnvVar: 'MCP_X', allowedTools })).toThrow(
        /array of tool names/
      );
    }
    // The other shared keys, and no key, need no list.
    for (const apiKeyEnvVar of ['FIRECRAWL_API_KEY', 'REPLICATE_API_KEY', 'MCP_X', null]) {
      expect(validateMcpToolPolicy({ apiKeyEnvVar })).toBeNull();
    }
  });

  it('refuses every write tool on the seeded server with 403, for an editor, and sends nothing', async () => {
    for (const tool of WRITE_TOOLS) {
      const fetch = vi.fn();
      const result = await call(allowGuard, seededPubler(), tool, fetch);
      expect(result.status).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.ok).toBe(false);
      expect(body.error).toContain(`"${tool}"`);
      expect(body.error).toContain('"publer-mcp"');
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('refuses a super_admin the same way unless the list names the tool', async () => {
    const fetch = vi.fn(async () => toolResult());
    const refused = await call(superAdminGuard, seededPubler(), 'submit_publer_posts', fetch);
    expect(refused.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();

    const listed = seededPubler({ allowedTools: [...READ_TOOLS, 'submit_publer_posts'] });
    const allowed = await call(superAdminGuard, listed, 'submit_publer_posts', fetch);
    expect(allowed.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes get_publer_user to Publer with the server-side key', async () => {
    const fetch = vi.fn(async (_url, options) => {
      expect(JSON.parse(options.body)).toMatchObject({
        method: 'tools/call',
        params: { name: 'get_publer_user' },
      });
      expect(options.headers.Authorization).toBe('Bearer pk');
      return toolResult();
    });
    const result = await call(allowGuard, seededPubler(), 'get_publer_user', fetch);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ ok: true, result: 'Saul, Business' });
  });

  it('refuses every call to a Publer-key server stored without a list', async () => {
    for (const allowedTools of [undefined, []]) {
      const fetch = vi.fn();
      const result = await call(allowGuard, seededPubler({ allowedTools }), 'get_publer_user', fetch);
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body).error).toMatch(/must name the tools it may call/);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('holds the platform job path to the same list (callMcpTool via mcpToolRefusal)', () => {
    expect(
      mcpToolRefusal({ serverId: 'publer-mcp', server: seededPubler(), tool: 'publish_publer_draft' })
    ).toMatch(/not in the allowedTools of MCP server "publer-mcp"/);
    expect(
      mcpToolRefusal({ serverId: 'publer-mcp', server: seededPubler(), tool: 'get_publer_user' })
    ).toBeNull();
  });

  it('leaves Firecrawl as it was: no list, any tool name reaches the server', async () => {
    const firecrawl = {
      id: 'firecrawl',
      url: 'https://mcp.firecrawl.dev/mcp',
      transport: 'http',
      apiKeyEnvVar: 'FIRECRAWL_API_KEY',
      enabled: true,
    };
    const fetch = vi.fn(async () => toolResult());
    const result = await createMcpHandlers({
      guard: allowGuard,
      store: makeStore(firecrawl),
      env: { FIRECRAWL_API_KEY: 'fc' },
      fetch,
    }).mcpProxy(request({ serverId: 'firecrawl', tool: 'firecrawl_scrape', arguments: {} }), context);
    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Given a list, it is held to it.
    expect(
      mcpToolRefusal({
        serverId: 'firecrawl',
        server: { ...firecrawl, allowedTools: ['firecrawl_search'] },
        tool: 'firecrawl_scrape',
      })
    ).toMatch(/not in the allowedTools/);
  });

  it('never widens allowedTools on Sync', async () => {
    const store = makeStore(seededPubler());
    const fetch = vi.fn(async () =>
      response({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [...READ_TOOLS, ...WRITE_TOOLS].map((name) => ({ name })) },
      })
    );
    const handlers = createMcpHandlers({
      guard: allowGuard,
      store,
      env: { PUBLER_API_KEY: 'pk' },
      fetch,
      now: fixedNow,
    });
    const result = await handlers.syncMcpTools(request({ serverId: 'publer-mcp' }), context);
    expect(JSON.parse(result.body).tools).toHaveLength(READ_TOOLS.length + WRITE_TOOLS.length);
    const [, , patch] = store.patchDoc.mock.calls[0];
    expect(Object.keys(patch).sort()).toEqual(['lastError', 'lastTested', 'status', 'tools']);
  });
});
