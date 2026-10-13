/**
 * The admin portal's provider list, held against the API's.
 *
 * This file exists because the two silently disagreed for the whole of the
 * migration. `DEFAULT_PROVIDERS` came over from Site-Main and was never
 * revisited, so the AI Engine page showed:
 *
 *   - Vertex, `enabled: true`, though the router removed it at the port — it
 *     authenticates with GCP Application Default Credentials, which a Function
 *     App cannot hold, so it could not have worked at all.
 *   - OpenAI in DEPRECATED_PROVIDERS, deleted from the container on every admin
 *     page load, though the router calls OpenAI happily.
 *   - Perplexity, Bedrock and Replicate, none of which anything routes text to.
 *
 * Every one of those was visible on screen and wrong, and nothing failed. The
 * owner reasonably concluded from the page that Gemini/Vertex was the primary
 * provider when Anthropic was in fact first and Vertex was gone.
 *
 * So the lists are compared here, against the API's own source. Importing the
 * backend module directly is the point: a fixture copied into this file would
 * reintroduce the exact problem it is meant to catch.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROVIDERS,
  aggregateByProvider,
  aggregateBySource,
  providerDisplayPatches,
  SEED_OWNED_PROVIDER_FIELDS,
} from './aiEngine.js';
import { visibleModelsFor as visibleModelsOnThePage } from './aiEngine/catalog.js';
import {
  DEFAULT_MODEL_TABLE,
  PROVIDERS,
  getCostEstimate,
} from '../../../functions/src/lib/ai/router.js';
import {
  readModelCatalog,
  seedModelsFor,
  visibleModelsFor as visibleModelsInTheApi,
} from '../../../functions/src/lib/ai/model-catalog.js';
import { USAGE_SOURCES } from '../../../functions/src/lib/ai/usage.js';
import {
  MCP_OAUTH_CALLBACK_PATH as API_CALLBACK_PATH,
  PASTED_TOKEN_SERVER_IDS as API_PASTED_TOKEN_SERVER_IDS,
  mcpToolRefusal,
  usesOAuthConnect as apiUsesOAuthConnect,
  validateMcpKeyBinding,
  validateMcpToolPolicy,
  validateMcpUrl,
} from '../../../functions/src/lib/ai/mcp-policy.js';
import {
  DEFAULT_MCP_SERVERS,
  DEPRECATED_MCP_SERVERS,
  PUBLER_MCP_ALLOWED_TOOLS,
  mcpServerPatch,
} from './aiEngine/seed.js';
import { MCP_OAUTH_CALLBACK_PATH } from '../components/admin/ai-engine/tabs.js';
import {
  PASTED_TOKEN_SERVER_IDS,
  usesOAuthConnect,
} from '../components/admin/ai-engine/McpOAuth.jsx';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_LABELS, labelForSource } from '../pages/admin/AIEngineUsageTab.jsx';

const ids = DEFAULT_PROVIDERS.map((p) => p.id);

describe('DEFAULT_PROVIDERS matches the API', () => {
  it('lists exactly the providers the router implements, in the same order', () => {
    expect(ids).toEqual([...PROVIDERS]);
  });

  it('offers no provider the API cannot route to', () => {
    // The specific failure: 'vertex' on this list for months.
    const strangers = ids.filter((id) => !PROVIDERS.includes(id));
    expect(strangers, 'listed in the portal but unknown to the router').toEqual([]);
  });

  it('names the environment variable the router actually reads for each', () => {
    // A wrong apiKeyEnvVar sends someone to seed the wrong secret, and the
    // symptom is a provider that stays silently unavailable.
    const expected = {
      gemini: 'GEMINI_API_KEY',
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      nvidia: 'NVIDIA_API_KEY',
      // Not a key: the endpoint Terraform sets (#849).
      foundry: 'FOUNDRY_ENDPOINT',
    };
    for (const provider of DEFAULT_PROVIDERS) {
      expect(provider.apiKeyEnvVar, provider.id).toBe(expected[provider.id]);
    }
  });

  it('gives every provider a contiguous order starting at 1', () => {
    // Ties are the one case where the active provider can differ between
    // Function App instances, so the seed must not create one.
    expect(DEFAULT_PROVIDERS.map((p) => p.order)).toEqual(
      DEFAULT_PROVIDERS.map((_, index) => index + 1)
    );
  });

  it('seeds every provider enabled, matching the API rule that absent means on', () => {
    expect(DEFAULT_PROVIDERS.every((p) => p.enabled === true)).toBe(true);
  });

  it('carries no model list of its own; the catalogue is the list (ADR 0034 slice 2, #857)', () => {
    // A list typed in here is a copy that goes stale the way the provider
    // list once did. The cards read cms/ai-model-catalog instead.
    for (const provider of DEFAULT_PROVIDERS) {
      expect(provider, provider.id).not.toHaveProperty('models');
    }
  });

  it('pins a defaultModel the router’s own table serves, or no pin at all', () => {
    for (const provider of DEFAULT_PROVIDERS) {
      // NVIDIA and Foundry seed no pin, so the router's per-purpose table
      // decides (#701, #849): a pin here would apply one model to drafting,
      // grading and captions.
      if (provider.id === 'nvidia' || provider.id === 'foundry') {
        expect(provider.defaultModel).toBeNull();
        continue;
      }
      expect(seedModelsFor(provider.id), provider.id).toContain(provider.defaultModel);
    }
  });

  it('before the first refresh, a card offers exactly the models the router defaults to', async () => {
    // The API seeds a never-refreshed provider from the router table in
    // memory; the page's visibility rule over that answer is the card's list.
    const catalog = await readModelCatalog({ store: { readDoc: async () => null } });
    const routerDefaults = [
      ...new Set(Object.values(DEFAULT_MODEL_TABLE.nvidia).map(([, m]) => m)),
    ];
    expect([...visibleModelsOnThePage(catalog, 'nvidia')].sort()).toEqual(routerDefaults.sort());
    for (const provider of PROVIDERS) {
      expect(visibleModelsOnThePage(catalog, provider).length, provider).toBeGreaterThan(0);
    }
  });

  it('the page and the API agree on which models a card may offer', async () => {
    const seeded = await readModelCatalog({ store: { readDoc: async () => null } });
    const catalog = {
      providers: {
        ...seeded.providers,
        openai: {
          ...seeded.providers.openai,
          models: {
            'gpt-5-nano': {
              id: 'gpt-5-nano',
              status: 'live',
              hidden: false,
              capabilities: ['text'],
            },
            'gpt-4o': { id: 'gpt-4o', status: 'retired', hidden: false, capabilities: ['text'] },
            'gpt-5-mini': {
              id: 'gpt-5-mini',
              status: 'live',
              hidden: true,
              capabilities: ['text'],
            },
            'o3-mini': { id: 'o3-mini', status: 'unknown', hidden: false, capabilities: ['text'] },
            'gpt-4o-mini': {
              id: 'gpt-4o-mini',
              status: 'live',
              hidden: false,
              capabilities: ['text'],
            },
            // A speech model the list endpoint also returns: no text capability, never selectable.
            'gpt-4o-mini-tts': {
              id: 'gpt-4o-mini-tts',
              status: 'live',
              hidden: false,
              capabilities: [],
            },
          },
        },
      },
    };
    for (const provider of PROVIDERS) {
      expect(visibleModelsOnThePage(catalog, provider), provider).toEqual(
        visibleModelsInTheApi(catalog, provider)
      );
    }
    expect(visibleModelsOnThePage(catalog, 'openai')).toEqual([
      'gpt-4o-mini',
      'gpt-5-nano',
      'o3-mini',
    ]);
  });

  it('prices every NVIDIA call at zero, so the usage view shows the saving', () => {
    const agg = aggregateByProvider([
      {
        provider: 'nvidia',
        totalTokens: 3000,
        estimatedCostUsd: getCostEstimate('nvidia', 'z-ai/glm-5.3', 900, 2100),
      },
    ]);
    expect(agg.nvidia).toMatchObject({ calls: 1, tokens: 3000, costUsd: 0 });
  });
});

describe('a stored provider follows the seed for what the card shows', () => {
  const nvidia = DEFAULT_PROVIDERS.find((p) => p.id === 'nvidia');

  it('calls NVIDIA "NVIDIA API", not "NVIDIA API Catalog" (owner, 2026-09-29)', () => {
    expect(nvidia.name).toBe('NVIDIA API');
  });

  it('patches a stored document still carrying the old name, and only what differs', () => {
    // The document the page seeded on 2026-09-25, before the rename.
    const stored = [
      {
        ...nvidia,
        name: 'NVIDIA API Catalog',
        defaultModel: 'z-ai/glm-5.3-flash',
        status: 'connected',
      },
    ];
    expect(providerDisplayPatches(stored)).toEqual([
      { id: 'nvidia', patch: { name: 'NVIDIA API' } },
    ]);
  });

  it('writes nothing when every stored document already matches the seed', () => {
    expect(providerDisplayPatches(DEFAULT_PROVIDERS.map((p) => ({ ...p })))).toEqual([]);
  });

  it('never touches fields the administrator sets, nor providers the seed does not know', () => {
    const stored = [
      { id: 'gemini', name: 'Old Gemini', defaultModel: 'custom', enabled: false, order: 9 },
      { id: 'someone-else', name: 'Kept as is' },
    ];
    const [only] = providerDisplayPatches(stored);
    expect(only.id).toBe('gemini');
    expect(Object.keys(only.patch).every((k) => SEED_OWNED_PROVIDER_FIELDS.includes(k))).toBe(true);
    expect(only.patch).not.toHaveProperty('defaultModel');
    expect(only.patch).not.toHaveProperty('enabled');
    expect(providerDisplayPatches([{ id: 'someone-else', name: 'x' }])).toEqual([]);
  });
});

describe('usage aggregation', () => {
  const rows = [
    {
      provider: 'gemini',
      source: 'listen-and-learn:audio',
      totalTokens: 17280,
      estimatedCostUsd: 0.17,
      estimatedTokens: true,
    },
    {
      provider: 'gemini',
      source: 'listen-and-learn:audio',
      totalTokens: 17000,
      estimatedCostUsd: 0.17,
    },
    {
      provider: 'gemini',
      source: 'listen-and-learn:script',
      totalTokens: 4000,
      estimatedCostUsd: 0.002,
    },
    { provider: 'anthropic', source: 'admin', totalTokens: 900, estimatedCostUsd: 0.01 },
  ];

  it('groups by provider, as it always has', () => {
    const agg = aggregateByProvider(rows);
    expect(Object.keys(agg).sort()).toEqual(['anthropic', 'gemini']);
    expect(agg.gemini.calls).toBe(3);
    expect(agg.gemini.tokens).toBe(38280);
  });

  it('groups by feature, which is the question when one vendor serves several', () => {
    // Provider alone answers "which vendor". It cannot answer "what did the
    // audio cost", and audio is priced an order of magnitude above text.
    const agg = aggregateBySource(rows);
    expect(Object.keys(agg).sort()).toEqual([
      'admin',
      'listen-and-learn:audio',
      'listen-and-learn:script',
    ]);
    expect(agg['listen-and-learn:audio'].calls).toBe(2);
    expect(agg['listen-and-learn:audio'].tokens).toBe(34280);
    expect(agg['listen-and-learn:audio'].costUsd).toBeCloseTo(0.34, 6);
  });

  it('counts rows whose tokens were derived rather than reported', () => {
    // Shown on the page so a derived figure is never read as a billed one.
    const agg = aggregateBySource(rows);
    expect(agg['listen-and-learn:audio'].estimated).toBe(1);
    expect(agg['listen-and-learn:script'].estimated).toBe(0);
  });

  it('treats a row with no source as an admin call', () => {
    // Every row imported from before the source field existed.
    const agg = aggregateBySource([{ provider: 'openai', totalTokens: 10, estimatedCostUsd: 0 }]);
    expect(agg.admin.calls).toBe(1);
  });

  it('handles missing totals without producing NaN', () => {
    const agg = aggregateBySource([{ provider: 'gemini', source: 'admin' }]);
    expect(agg.admin.tokens).toBe(0);
    expect(agg.admin.costUsd).toBe(0);
  });
});

describe('SOURCE_LABELS covers every source the API writes', () => {
  it('names each USAGE_SOURCES value, so none renders as a raw slug', () => {
    for (const source of Object.values(USAGE_SOURCES)) {
      expect(SOURCE_LABELS[source], `no label for "${source}"`).toBeTruthy();
    }
  });

  it('names the source the Playground itself sends, which the API does not list', () => {
    // aiEngine.chat defaults to 'admin_playground'; it showed as a raw slug until 2026-09-29.
    expect(SOURCE_LABELS.admin_playground).toBe('Admin playground');
  });
});

describe('usage aggregation counts unpriced rows (ADR 0033)', () => {
  it('counts rows for a model with no confirmed rate, so $0 never reads as free', () => {
    const agg = aggregateByProvider([
      {
        provider: 'openai',
        model: 'gpt-5-mini',
        totalTokens: 10,
        estimatedCostUsd: 0,
        unpriced: true,
      },
      { provider: 'openai', model: 'gpt-4o', totalTokens: 10, estimatedCostUsd: 0.1 },
    ]);
    expect(agg.openai).toMatchObject({ calls: 2, unpriced: 1, costUsd: 0.1 });
  });

  it('labels a router-recorded row by its feature, and the unspecified slug by name', () => {
    expect(labelForSource('ai:inspector', { inspector: { label: 'Content Inspector' } })).toBe(
      'AI — Content Inspector'
    );
    expect(labelForSource('ai:newFeature', {})).toBe('AI — newFeature');
    expect(labelForSource(USAGE_SOURCES.aiUnspecified)).toBe('AI — task not named');
    expect(labelForSource('admin_test')).toBe('AI Engine — Test');
    expect(labelForSource('something-else')).toBe('something-else');
  });
});

describe('the seeded Publer MCP server passes the API policy (#995)', () => {
  const publer = DEFAULT_MCP_SERVERS.find((server) => server.id === 'publer-mcp');
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

  it('ships switched off, at the bound host, with the 34 read and session tools', () => {
    expect(publer.enabled).toBe(false);
    expect(validateMcpUrl(publer.url)).toBe('https://mcp.publer.com/');
    expect(validateMcpKeyBinding(publer)).toBe('PUBLER_API_KEY');
    expect(validateMcpToolPolicy(publer)).toEqual([...PUBLER_MCP_ALLOWED_TOOLS]);
    expect(PUBLER_MCP_ALLOWED_TOOLS).toHaveLength(34);
    expect(new Set(PUBLER_MCP_ALLOWED_TOOLS).size).toBe(34);
  });

  it('names none of the 13 write tools, so the API refuses each one', () => {
    for (const tool of WRITE_TOOLS) {
      expect(publer.allowedTools).not.toContain(tool);
      expect(
        mcpToolRefusal({ serverId: publer.id, server: { ...publer, enabled: true }, tool })
      ).toMatch(/not in the allowedTools/);
    }
    expect(
      mcpToolRefusal({ serverId: publer.id, server: publer, tool: 'get_publer_user' })
    ).toBeNull();
  });
});

describe('the OAuth Connect servers (2026-10-08) match the API', () => {
  const byId = (id) => DEFAULT_MCP_SERVERS.find((server) => server.id === id);

  it('seeds Replicate at its SSE URL and Hostinger’s and Podbean’s hosted servers, all OAuth, none with a key', () => {
    expect(byId('replicate-mcp')).toMatchObject({
      url: 'https://mcp.replicate.com/sse',
      transport: 'sse',
      authType: 'oauth',
      apiKeyEnvVar: null,
      enabled: false,
    });
    expect(byId('hostinger-mcp')).toMatchObject({
      url: 'https://mcp.hostinger.com',
      transport: 'http',
      authType: 'oauth',
      apiKeyEnvVar: null,
      enabled: false,
    });
    expect(byId('hostinger-mcp').notes).not.toMatch(/Notion|localhost/i);
    for (const id of ['replicate-mcp', 'hostinger-mcp']) {
      const server = byId(id);
      expect(validateMcpUrl(server.url)).toMatch(/^https:\/\//);
      expect(validateMcpKeyBinding(server)).toBeNull();
      expect(apiUsesOAuthConnect(server)).toBe(true);
    }
    expect(validateMcpToolPolicy(byId('replicate-mcp'))).toBeNull();
    expect(validateMcpToolPolicy(byId('hostinger-mcp'))).toBeNull();
  });

  it('retires podbean-mcp: Podbean admits no web app, so the seed deletes it on sight', () => {
    // Measured 2026-10-13: registration and a client metadata document both
    // refused the site's callback ("allowlisted URI: Claude, ChatGPT, Cursor,
    // or loopback"), and a developer-app token got 401 from the MCP server.
    expect(byId('podbean-mcp')).toBeUndefined();
    expect(DEPRECATED_MCP_SERVERS).toContain('podbean-mcp');
  });

  it('every seeded server is https and passes the API’s save-time checks', () => {
    for (const server of DEFAULT_MCP_SERVERS) {
      expect(() => validateMcpUrl(server.url), server.id).not.toThrow();
      expect(() => validateMcpKeyBinding(server), server.id).not.toThrow();
    }
  });

  it('the card and the API agree on which servers use Connect — Plaud does not', () => {
    expect([...PASTED_TOKEN_SERVER_IDS]).toEqual([...API_PASTED_TOKEN_SERVER_IDS]);
    for (const server of DEFAULT_MCP_SERVERS) {
      expect(usesOAuthConnect(server), server.id).toBe(apiUsesOAuthConnect(server));
    }
    expect(usesOAuthConnect(byId('plaud'))).toBe(false);
    expect(
      DEFAULT_MCP_SERVERS.filter(usesOAuthConnect)
        .map((s) => s.id)
        .sort()
    ).toEqual(['hostinger-mcp', 'replicate-mcp']);
  });

  it('migrates the stored Replicate document: no key, OAuth, the seed’s notes — URL and transport kept', () => {
    const stored = {
      id: 'replicate-mcp',
      url: 'https://mcp.replicate.com/sse',
      transport: 'sse',
      apiKeyEnvVar: 'REPLICATE_API_KEY',
      status: 'error',
      lastError: 'SSE GET returned HTTP 401',
      notes: 'Official Replicate remote MCP server (SSE). Uses REPLICATE_API_KEY.',
    };
    const patch = mcpServerPatch(stored);
    expect(patch).toEqual({
      apiKeyEnvVar: null,
      authType: 'oauth',
      notes: byId('replicate-mcp').notes,
    });
    const migrated = { ...stored, ...patch };
    expect(validateMcpKeyBinding(migrated)).toBeNull();
    expect(apiUsesOAuthConnect(migrated)).toBe(true);
    expect(mcpServerPatch(migrated)).toEqual({});
  });

  it('migrates the stored Hostinger document in one patch the API accepts', () => {
    const stored = {
      id: 'hostinger-mcp',
      url: 'http://localhost:8100',
      transport: 'http',
      apiKeyEnvVar: 'VPS_API_TOKEN',
      description:
        'Administer Hostinger resources (VPS, domains, DNS, and hosting) via the Hostinger API',
      notes: 'Requires the secret (fetched from Notion DB).',
      status: 'error',
      lastError: 'fetch failed',
    };
    const patch = mcpServerPatch(stored);
    expect(patch).toEqual({
      url: 'https://mcp.hostinger.com',
      apiKeyEnvVar: null,
      authType: 'oauth',
      description: byId('hostinger-mcp').description,
      notes: byId('hostinger-mcp').notes,
    });
    // One patch: the old key name is refused by itself, so it must leave
    // in the same write that moves the URL.
    expect(() => validateMcpKeyBinding(stored)).toThrow(/not allowed/);
    const migrated = { ...stored, ...patch };
    expect(validateMcpUrl(migrated.url)).toBe('https://mcp.hostinger.com/');
    expect(validateMcpKeyBinding(migrated)).toBeNull();
    expect(apiUsesOAuthConnect(migrated)).toBe(true);
    expect(mcpServerPatch(migrated)).toEqual({});
  });

  it('touches no other server, and treats an absent key name as no key name', () => {
    const others = DEFAULT_MCP_SERVERS.filter(
      (s) => !['replicate-mcp', 'hostinger-mcp'].includes(s.id)
    );
    for (const server of others) {
      expect(mcpServerPatch(server), server.id).toEqual({});
    }
    const { apiKeyEnvVar: _gone, ...noKeyField } = byId('replicate-mcp');
    expect(mcpServerPatch(noKeyField)).toEqual({});
  });

  it('the callback page sits where the API registers the redirect URI', () => {
    expect(MCP_OAUTH_CALLBACK_PATH).toBe(API_CALLBACK_PATH);
    expect(MCP_OAUTH_CALLBACK_PATH).toBe('/admin/ai-engine/oauth/callback');
    const app = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8');
    expect(app).toContain('path="ai-engine/oauth/callback"');
  });
});
