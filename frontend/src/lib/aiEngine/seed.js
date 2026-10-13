/**
 * AI Engine — the default provider and MCP server documents, and the seed
 * that writes them through the config API on first admin page load.
 * Imported through `@/lib/aiEngine`, which re-exports it.
 */
import { sendJSON } from '@/lib/api';
import { fetchConfig, notifyConfigSubscribers } from './config';

/**
 * Bumped when the seed takes ownership of a field back from whatever is stored.
 * Version 2 (2026-08-23) reclaims `enabled`, `order` and `apiKeyEnvVar`, which
 * were written by a UI the API never read. See seedAiEngineIfEmpty.
 */
export const PROVIDER_SCHEMA_VERSION = 2;

/**
 * The text providers the API actually implements, in default preference order.
 *
 * THIS LIST USED TO BE FICTION. It was carried over from Site-Main unchanged and
 * described a platform that no longer existed: Vertex was listed `enabled: true`
 * though the router dropped it at the port (Vertex authenticates with GCP
 * Application Default Credentials, which a Function App cannot hold); OpenAI was
 * in DEPRECATED_PROVIDERS and deleted on sight though the router calls it; and
 * Perplexity, Bedrock and Replicate were offered though nothing routes text to
 * them. Reading this page told you the opposite of what the API would do.
 *
 * It is now the same providers as `functions/src/lib/ai/router.js`, in the
 * same order, and `aiEngine.test.js` fails if the two lists diverge. The
 * fourth, NVIDIA (#701), is also placed per feature — see getAiFeatures.
 *
 * Order is cost, not quality — see DEFAULT_PROVIDER_ORDER in ai-config.js. These
 * are seed values only: `order` and `enabled` are the administrator's to change
 * from this page, and the API honours both on every call.
 *
 * NO MODEL LISTS HERE (ADR 0034 slice 2, #857). Each card's models come from
 * the model catalogue the API refreshes weekly from the providers' own list
 * endpoints (`cms/ai-model-catalog`, merged onto the cards by
 * aiEngine/catalog.js). A list typed in here was a copy that went stale the
 * way the provider list once did, and `aiEngine.test.js` refuses one. A
 * stored document from before that day may still carry a `models` array;
 * the page ignores it. `defaultModel` stays the seed's: a pin the router's
 * own table serves, read once by the migration into the Priority list's
 * per-row model (ADR 0034 §6); since slice 4 (#859) the cards show no pin
 * and the Priority row names the model instead.
 *
 * Replicate has NOT gone away — it generates article cover images, reached
 * directly through REPLICATE_API_KEY. It was never a text provider, and listing
 * it as one is what made this page confusing.
 */
export const DEFAULT_PROVIDERS = [
  {
    id: 'gemini',
    name: 'Gemini (Google AI)',
    description: 'Gemini 3.6 Flash, 3.5 Flash-Lite, 2.5 Pro — lowest cost per token',
    icon: '🔵',
    enabled: true,
    defaultModel: 'gemini-3.5-flash-lite',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    status: 'untested',
    order: 1,
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    notes:
      'Public Generative Language API, not Vertex. Seed GEMINI-API-KEY in Key Vault; until then the API falls through to the next provider.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT-5 mini and nano',
    icon: '🟢',
    enabled: true,
    defaultModel: 'gpt-5-mini',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com/docs',
    status: 'untested',
    order: 2,
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    notes:
      "Seed OPENAI-API-KEY in Key Vault. GPT-5 mini and nano are priced at OpenAI's published rates (owner confirmation 2026-10-05); rows written before that day stay at $0, flagged unpriced.",
  },
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    description: 'Claude Opus 4.6, Sonnet 4.6, Haiku 4.5',
    icon: '🟣',
    enabled: true,
    defaultModel: 'claude-sonnet-4-6',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://docs.anthropic.com',
    status: 'untested',
    order: 3,
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    notes: 'Seed ANTHROPIC-API-KEY in Key Vault. Highest cost per token of the three.',
  },
  {
    // #701. Last in the global order on purpose: its real position is set
    // per feature under "Where AI is used" — the backup for owner-triggered
    // content unless placed first there (2026-09-29), never for the public
    // explain route.
    id: 'nvidia',
    name: 'NVIDIA API',
    description: 'GLM-5.3 — free trial tier, ~40 requests a minute',
    icon: '🟩',
    enabled: true,
    // Unset on purpose: with no pin the router uses GLM-5.3 for every
    // purpose, the one trial-tier model that answered inside the Test's 45 s
    // on 2026-10-04 (#701). Choosing one here pins it for every purpose.
    defaultModel: null,
    apiKeyEnvVar: 'NVIDIA_API_KEY',
    docsUrl: 'https://build.nvidia.com/models',
    status: 'untested',
    order: 4,
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    notes:
      'Seed NVIDIA-API-KEY (an nvapi- key from build.nvidia.com/settings/api-keys). A freshly seeded key can answer "403 Authorization failed" from here for up to about 40 minutes, the same reply a wrong key gets: Test again later before reseeding, and delete the previous key at NVIDIA only once the new one passes here. Free, so usage shows at $0. Trial terms and a ~40 requests/minute limit: the API paces itself and hands busy or failed calls to the next provider.',
  },
  {
    // Microsoft Foundry (#849, owner decision 2026-10-04): a PAID provider
    // under its own USD 75 budget, first for the content features and off
    // the public route (features-catalogue.js). No key: the Function App's
    // identity authenticates, and Terraform sets the endpoint this card's
    // apiKeyEnvVar names.
    id: 'foundry',
    name: 'Microsoft Foundry',
    description: 'GPT-5 nano and mini on Azure, billed to the app subscription',
    icon: '🟦',
    enabled: true,
    // Unset on purpose: with no pin the router uses mini for drafts and
    // analysis and nano for short calls. Choosing one here pins it for every
    // purpose.
    defaultModel: null,
    apiKeyEnvVar: 'FOUNDRY_ENDPOINT',
    docsUrl: 'https://learn.microsoft.com/azure/foundry/',
    status: 'untested',
    order: 5,
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    notes:
      'Nothing to seed: the app signs in with its own identity, and FOUNDRY_ENDPOINT is set by Terraform. A USD 75 monthly budget on its resource group alerts at 50, 90 and 100 %; a budget alerts, it does not stop spend. First for content features; never the public explain route.',
  },
];

/**
 * The Publer MCP tools the seeded server may call (#995): the 27 that only
 * read Publer and the 7 that only change the session's selection, from
 * `tools/list` on 2026-10-07. The 13 that create, schedule, publish, edit,
 * delete or upload are deliberately absent, `delete_publer_posts` among
 * them because it opens the delete that `confirm_delete_publer_posts`
 * completes. The API refuses a call outside this list whatever the role, and
 * only a super_admin can change it. docs/runbooks/publer.md has the split.
 */
export const PUBLER_MCP_ALLOWED_TOOLS = Object.freeze([
  // Read-only
  'get_publer_user',
  'list_publer_accounts',
  'lookup_publer_accounts',
  'list_publer_posts',
  'lookup_publer_posts',
  'list_publer_drafts',
  'get_recent_posts',
  'get_publer_job_status',
  'get_post_insights',
  'get_hashtag_insights',
  'get_hashtag_performing_posts',
  'get_best_times_to_post',
  'list_analytics_charts',
  'get_analytics_chart_data',
  'get_members_analytics',
  'analyze_recent_performance',
  'list_competitors',
  'get_competitors_analytics',
  'list_publer_media',
  'lookup_publer_media',
  'list_media_options',
  'generate_campaign_plan',
  'search_publer_docs',
  'read_publer_docs_page',
  'search_publer_help',
  'read_publer_help_article',
  'load_publer_card_state',
  // Session selection only
  'list_publer_workspaces',
  'select_publer_workspace',
  'change_publer_workspace',
  'select_publer_account',
  'select_publer_posts',
  'select_publer_media',
  'save_publer_card_state',
]);

export const DEFAULT_MCP_SERVERS = [
  {
    id: 'plaud',
    name: 'Plaud (Voice Recordings)',
    description:
      'Access your Plaud recordings, transcripts & AI notes live — no manual export needed',
    url: 'https://mcp.plaud.ai/mcp',
    transport: 'http',
    enabled: false,
    apiKeyEnvVar: null, // OAuth — token stored in oauthToken field, not an env var
    authType: 'oauth',
    tools: [
      { name: 'list_files', description: 'List recordings with optional date/keyword filters' },
      { name: 'get_file', description: 'Full details + presigned audio URL for one recording' },
      { name: 'get_note', description: 'AI-generated summary, action items & key topics' },
      { name: 'get_transcript', description: 'Full transcript with timestamps and speaker labels' },
      { name: 'get_current_user', description: 'Your Plaud account details' },
    ],
    status: 'untested',
    order: 1,
    notes:
      'OAuth auth. To connect: go to the Recordings page → Connect tab, follow the OAuth flow, and paste your access token. Token is stored server-side in Cosmos DB — never in the browser. Docs: https://docs.plaud.ai/documentation/plaud_app/mcp',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    description: 'Web scraping and content extraction — already in your project',
    url: 'https://mcp.firecrawl.dev/sse',
    transport: 'sse',
    enabled: false,
    apiKeyEnvVar: 'FIRECRAWL_API_KEY',
    tools: [],
    status: 'untested',
    order: 2,
    notes:
      'Your project already uses @mendable/firecrawl-js. Connect via MCP for tool-based access.',
  },
  {
    id: 'context7',
    name: 'Context7 (Library Docs)',
    description: 'Up-to-date library documentation for any npm/PyPI package',
    url: 'https://mcp.context7.com/mcp',
    transport: 'http',
    enabled: false,
    apiKeyEnvVar: null,
    tools: [],
    status: 'untested',
    order: 3,
    notes: 'Free public MCP server. No API key required.',
  },

  {
    // Replicate's hosted server accepts only tokens from its own sign-in
    // (2026-10-08): the REPLICATE_API_KEY bearer answers 401 invalid_token.
    // The key stays for Replicate's REST API (cover images); this server
    // signs in with Connect (functions/src/lib/ai/mcp-oauth.js).
    id: 'replicate-mcp',
    name: 'Replicate MCP',
    description: 'Run 50k+ open-source AI models as MCP tools — images, audio, video, text',
    url: 'https://mcp.replicate.com/sse',
    transport: 'sse',
    enabled: false,
    apiKeyEnvVar: null,
    authType: 'oauth',
    tools: [],
    status: 'untested',
    order: 6,
    notes:
      'Official Replicate remote MCP server (SSE). Signs in with your Replicate account: press Connect, sign in at Replicate and approve. The token is kept server-side and renewed automatically. REPLICATE_API_KEY is not used here (this server accepts only its own sign-in); it still serves cover images. Docs: https://replicate.com/docs/topics/mcp',
  },
  {
    id: 'aws-knowledge-mcp',
    name: 'AWS Knowledge Base',
    description: 'Retrieve AWS documentation, architecture patterns, and knowledge base details',
    url: 'https://knowledge-mcp.global.api.aws',
    transport: 'http',
    enabled: false,
    apiKeyEnvVar: null,
    tools: [],
    status: 'untested',
    order: 8,
    notes:
      'Free public AWS MCP server. No API key required. Provides search tools for AWS developer docs and architecture guidance.',
  },
  {
    id: 'microsoftdocs-mcp',
    name: 'Microsoft Learn / Docs',
    description: 'Retrieve Microsoft documentation, learning modules, and platform resources',
    url: 'https://learn.microsoft.com/api/mcp',
    transport: 'http',
    enabled: false,
    apiKeyEnvVar: null,
    tools: [],
    status: 'untested',
    order: 9,
    notes:
      'Free public Microsoft Learn MCP server. No API key required. Provides tools to search Microsoft documentation and learning modules.',
  },
  {
    id: 'drawio-mcp',
    name: 'Draw.io (Diagrams.net)',
    description:
      'Generate, edit, and analyze draw.io diagrams programmatically from chat prompt inputs',
    url: 'https://mcp.draw.io/mcp',
    transport: 'http',
    enabled: false,
    apiKeyEnvVar: null,
    tools: [],
    status: 'untested',
    order: 10,
    notes:
      'Uses the public Draw.io MCP server (https://mcp.draw.io/mcp) to create and update charts, workflows, and diagrams. No local installation required.',
  },
  {
    // Hostinger's hosted MCP server (2026-10-08). The localhost:8100 entry
    // this replaces was never reachable: a Function App has no localhost
    // MCP server, and its key was not an app setting.
    id: 'hostinger-mcp',
    name: 'Hostinger MCP',
    description:
      'Administer Hostinger resources (VPS, domains, DNS, and hosting) through Hostinger’s hosted MCP server',
    url: 'https://mcp.hostinger.com',
    transport: 'http',
    enabled: false,
    apiKeyEnvVar: null,
    authType: 'oauth',
    tools: [],
    status: 'untested',
    order: 11,
    notes:
      'Hostinger’s hosted MCP server (Streamable HTTP). Signs in with your Hostinger account: press Connect, sign in at Hostinger and approve. The token is kept server-side and renewed automatically. Its tools can change VPS, DNS and domain settings, so it ships switched off.',
  },
  {
    // Publer's own MCP server (2026-10-07). The URL carries no `?api_key=`:
    // Publer's settings page shows one, but the key is PUBLER_API_KEY, read
    // server-side, and mcp-policy.js refuses a query string on this host.
    id: 'publer-mcp',
    name: 'Publer MCP',
    description: 'Read Publer accounts, drafts, posts and analytics through Publer’s MCP server',
    url: 'https://mcp.publer.com',
    transport: 'http',
    enabled: false,
    apiKeyEnvVar: 'PUBLER_API_KEY',
    allowedTools: [...PUBLER_MCP_ALLOWED_TOOLS],
    tools: [],
    status: 'untested',
    order: 12,
    notes:
      'Uses PUBLER_API_KEY (the same key as the Social Hub), bound to mcp.publer.com only. Only the read and session tools are allowed; the API refuses the tools that create, schedule, publish, edit, delete or upload. Switching it on or off, and changing the allowed tools, needs super_admin. Sync lists tools even with a bad key; get_publer_user is the key check.',
  },
  {
    // Podbean's hosted MCP server (2026-10-13, the day the show moved to
    // Podbean). Read on that day: /.well-known/oauth-protected-resource names
    // https://mcp.podbean.com/ as its authorization server, which offers PKCE
    // (S256), `none` client authentication and a registration_endpoint, so
    // the generic Connect flow (lib/ai/mcp-oauth.js) signs in with no key.
    id: 'podbean-mcp',
    name: 'Podbean MCP',
    description:
      'Manage the Hybrid Cloud Insights podcast on Podbean: episodes, show details and listener statistics',
    url: 'https://mcp.podbean.com/mcp',
    transport: 'http',
    enabled: false,
    apiKeyEnvVar: null,
    authType: 'oauth',
    // Fail closed (CodeRabbit on #1114). mcpToolRefusal treats a missing
    // list as unrestricted and holds a present one to its entries, an empty
    // one included, so switching this on runs no tool until its tools are
    // named (#1115, once Connect and Sync have listed them).
    allowedTools: [],
    tools: [],
    status: 'untested',
    order: 13,
    notes:
      'Podbean’s hosted MCP server (Streamable HTTP). Signs in with your Podbean account: press Connect, sign in at Podbean and approve. The token is kept server-side and renewed automatically. It covers one public channel per connection. Its tools can publish, edit and permanently delete episodes and change the show’s details, so it ships switched off. It ships with an empty allow-list, so even switched on it runs no tool until its allowed tools are named (#1115): Connect and Sync first, then have the list set to the tools you use. Switched off, it runs no tools, but Sync can still list them and the token is still renewed; Disconnect deletes the token here and does not revoke it at Podbean. Podbean’s AI features spend Podbean AI credits. Docs: https://help.podbean.com/support/solutions/articles/25000035383',
  },
];

/**
 * The provider fields the seed owns and keeps current: what the card is
 * called, the line under the name, the icon, and the setup note. The page has
 * no control to edit any of them, so a stored value that differs from
 * `DEFAULT_PROVIDERS` is only ever an old copy of the seed. Seeding writes a
 * document once, when it is missing, and the card renders the stored document,
 * so without this a rename never reached the page: #701 renamed "NVIDIA API
 * Catalog" to "NVIDIA API" on 2026-09-29, and the card still said Catalog
 * after the deploy. `notes` joined on 2026-10-04 for the same reason: the
 * warning that a fresh NVIDIA key is refused for a while had to reach the
 * stored card, not only a card seeded after it was written.
 */
export const SEED_OWNED_PROVIDER_FIELDS = Object.freeze(['name', 'description', 'icon', 'notes']);

/**
 * `[{ id, patch }]` bringing each stored provider's seed-owned fields back to
 * the seed. Providers the seed does not know are left alone; an empty list
 * means nothing to write.
 */
export function providerDisplayPatches(stored, defaults = DEFAULT_PROVIDERS) {
  return (stored || []).flatMap((existing) => {
    const seed = defaults.find((p) => p.id === existing?.id);
    if (!seed) return [];
    const patch = {};
    for (const field of SEED_OWNED_PROVIDER_FIELDS) {
      if (seed[field] !== undefined && existing[field] !== seed[field]) patch[field] = seed[field];
    }
    return Object.keys(patch).length ? [{ id: existing.id, patch }] : [];
  });
}

// Providers and servers that have been permanently removed from defaults.
//
// `openai` used to be on this list and was deleted from the container on every
// admin page load, while the API called it happily. The four ids here are the
// real removals: none is reachable through the AI router, so their documents
// govern nothing — verified against the backend, which reads `ai_providers` in
// exactly one place (lib/ai/ai-config.js) and looks up only providers the
// router implements.
//
// `vertex` in particular cannot be made to work from a Function App at all: it
// authenticates with GCP Application Default Credentials. Gemini is reached
// through the public API instead, as the `gemini` provider above.
const DEPRECATED_PROVIDERS = ['vertex', 'perplexity', 'bedrock', 'replicate'];
const DEPRECATED_MCP_SERVERS = ['anthropic-mcp', 'openai-mcp', 'perplexity-mcp'];

// URL migrations for servers that changed endpoints.
const MCP_URL_PATCHES = {
  'aws-knowledge-mcp': 'https://knowledge-mcp.global.api.aws',
  'microsoftdocs-mcp': 'https://learn.microsoft.com/api/mcp',
  'replicate-mcp': 'https://mcp.replicate.com/sse',
  'hostinger-mcp': 'https://mcp.hostinger.com',
};
const MCP_TRANSPORT_PATCHES = {
  'replicate-mcp': 'sse',
  'hostinger-mcp': 'http',
};

/**
 * Field migrations for stored servers (2026-10-08): Replicate and Hostinger
 * moved to OAuth Connect, so their stored documents lose the key name the
 * server refuses (or that was never set) and gain `authType: 'oauth'`, which
 * is what puts the Connect button on the card. Their notes and Hostinger's
 * description follow the seed, since the old ones told the owner to fetch a
 * token from Notion for a localhost server. Values come from
 * DEFAULT_MCP_SERVERS, so the seed and the migration cannot disagree.
 *
 * Written in ONE patch with any URL change: the API checks a key name
 * against the URL beside it, and the old key name is no longer allowed.
 */
const MCP_FIELD_PATCH_KEYS = {
  'replicate-mcp': ['apiKeyEnvVar', 'authType', 'notes'],
  'hostinger-mcp': ['apiKeyEnvVar', 'authType', 'description', 'notes'],
};

const putConfig = (route, id, data) => sendJSON(`cms/config/${route}/${id}`, 'PUT', data);
const patchConfig = (route, id, patch) => sendJSON(`cms/config/${route}/${id}`, 'PATCH', patch);
const deleteConfig = (route, id) => sendJSON(`cms/config/${route}/${id}`, 'DELETE');

/** Delete the deprecated documents of one collection and write the missing defaults. */
function seedCollectionWrites(route, stored, defaults, deprecated) {
  const ids = new Set(stored.map((doc) => doc.id));
  const writes = deprecated.filter((id) => ids.has(id)).map((id) => deleteConfig(route, id));
  defaults.forEach((doc) => {
    if (stored.length === 0 || !ids.has(doc.id)) writes.push(putConfig(route, doc.id, doc));
  });
  return writes;
}

/**
 * ONE-TIME RESET OF enabled/order ON PROVIDERS THAT ALREADY EXIST.
 *
 * Documents written before PROVIDER_SCHEMA_VERSION 2 hold values that never
 * meant anything: until 2026-08-23 the API read providers from environment
 * variables alone and never opened this container, so every switch and every
 * order field on this page was decorative. The stored `anthropic` document,
 * for instance, says `enabled: false` while Claude was in fact serving every
 * request as the first-choice provider.
 *
 * There is therefore no administrator intent to preserve in those fields, and
 * carrying them forward would land the new, working UI with Claude switched
 * off and a stale order — which reads as a broken feature rather than a
 * migrated one. The version marker is what keeps this a migration rather than
 * a reset: once stamped, real choices made through the UI are never touched
 * again. Fields the seed does not own (defaultModel, status, notes) are left
 * alone even on the first pass.
 */
function providerSchemaWrites(providers) {
  return providers.flatMap((existing) => {
    const seed = DEFAULT_PROVIDERS.find((p) => p.id === existing.id);
    if (!seed || existing.schemaVersion >= PROVIDER_SCHEMA_VERSION) return [];
    return [
      patchConfig('ai-providers', existing.id, {
        enabled: seed.enabled,
        order: seed.order,
        apiKeyEnvVar: seed.apiKeyEnvVar,
        schemaVersion: PROVIDER_SCHEMA_VERSION,
      }),
    ];
  });
}

/**
 * The one PATCH a stored server needs to match the seed's migrations — its
 * URL, transport and migrated fields — or an empty object when it already
 * does. Exported for aiEngine.test.js, which holds the result against the
 * API's own policy.
 */
export function mcpServerPatch(server, defaults = DEFAULT_MCP_SERVERS) {
  const patch = {};
  if (MCP_URL_PATCHES[server.id] && server.url !== MCP_URL_PATCHES[server.id]) {
    patch.url = MCP_URL_PATCHES[server.id];
  }
  if (MCP_TRANSPORT_PATCHES[server.id] && server.transport !== MCP_TRANSPORT_PATCHES[server.id]) {
    patch.transport = MCP_TRANSPORT_PATCHES[server.id];
  }
  const seed = defaults.find((doc) => doc.id === server.id);
  for (const key of (seed && MCP_FIELD_PATCH_KEYS[server.id]) || []) {
    const wanted = seed[key] ?? null;
    // null and absent are the same "no key name" to the API.
    if ((server[key] ?? null) !== wanted) patch[key] = wanted;
  }
  return patch;
}

function serverEndpointWrites(servers) {
  return servers.flatMap((server) => {
    const patch = mcpServerPatch(server);
    return Object.keys(patch).length > 0 ? [patchConfig('mcp-servers', server.id, patch)] : [];
  });
}

/** Seed the config collections if empty.
 *  Also deletes deprecated provider/server docs and patches stale URLs.
 *  Called once on admin page load.
 */
export async function seedAiEngineIfEmpty() {
  const [providers, servers] = await Promise.all([
    fetchConfig('ai-providers'),
    fetchConfig('mcp-servers'),
  ]);

  const writes = [
    // ─ AI Providers ───────────────────────────────────────────────
    ...seedCollectionWrites('ai-providers', providers, DEFAULT_PROVIDERS, DEPRECATED_PROVIDERS),
    ...providerSchemaWrites(providers),
    // Names, descriptions and icons follow the seed on every load, so a rename
    // in DEFAULT_PROVIDERS reaches the stored document the card renders.
    ...providerDisplayPatches(providers).map(({ id, patch }) =>
      patchConfig('ai-providers', id, patch)
    ),
    // The model lists are the catalogue's (#857), never patched from here; a
    // pin the catalogue no longer lists shows on the card as "not listed".
    // ─ MCP Servers ───────────────────────────────────────────────
    ...seedCollectionWrites('mcp-servers', servers, DEFAULT_MCP_SERVERS, DEPRECATED_MCP_SERVERS),
    ...serverEndpointWrites(servers),
  ];

  if (writes.length > 0) {
    await Promise.all(writes);
    await Promise.all([
      notifyConfigSubscribers('ai-providers'),
      notifyConfigSubscribers('mcp-servers'),
    ]);
  }
}
