/**
 * The AI Engine's tabs, and where old addresses land (ADR 0033, ADR 0034).
 *
 * Kept out of the page module so a link builder elsewhere can import the ids
 * without pulling the lazily loaded page into the main bundle. A tab is one
 * entry here plus its panel in AIEnginePage's `PANELS`.
 *
 * `siteservices` was a placeholder tab whose state saved nothing; its
 * question ("which provider serves what") is answered by the Tasks tab, so
 * the old address lands there. The tab was called Routing until ADR 0034
 * slice 4 (#859) made it one row per task; its id stays `routing` so every
 * link written down since ADR 0033 still opens it, and `tasks` is an alias.
 */

export const AI_ENGINE_PATH = '/admin/ai-engine';

/**
 * Where a vendor's MCP sign-in sends the browser back to (2026-10-08). The
 * API registers `<site origin>` + this path with each vendor verbatim
 * (functions/src/lib/ai/mcp-policy.js MCP_OAUTH_CALLBACK_PATH), and
 * aiEngine.test.js holds the two together.
 */
export const MCP_OAUTH_CALLBACK_PATH = `${AI_ENGINE_PATH}/oauth/callback`;

export const TABS = Object.freeze([
  { id: 'services', label: 'AI Services' },
  { id: 'routing', label: 'Tasks' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'playground', label: 'Playground' },
  { id: 'usage', label: 'Usage & Cost' },
  // Koda, the owner's content agent (ADR 0037): its API key, what the key may
  // do, and how the Muse connector reaches the site. The one place the key is
  // made, switched and revoked.
  { id: 'koda', label: 'Koda' },
]);

export const DEFAULT_TAB = 'services';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

/** Ids that are no longer tabs but name what a tab now holds. */
export const MOVED_TABS = Object.freeze({
  siteservices: 'routing',
  'site-services': 'routing',
  routes: 'routing',
  tasks: 'routing',
  providers: 'services',
  features: 'services',
  priority: 'services',
  'where-ai-is-used': 'services',
  servers: 'mcp',
  tools: 'mcp',
  cost: 'usage',
  'usage-cost': 'usage',
  spend: 'usage',
  agent: 'koda',
  agents: 'koda',
  muse: 'koda',
  'agent-content': 'koda',
});

/** The tab to show for a `?tab=` value: its own, where it moved, or AI Services. */
export function resolveTab(requested) {
  // Own properties only: `?tab=constructor` must not read Object.prototype.
  const id = Object.prototype.hasOwnProperty.call(MOVED_TABS, requested ?? '')
    ? MOVED_TABS[requested]
    : requested;
  return TAB_IDS.has(id) ? id : DEFAULT_TAB;
}

export function tabHref(tab) {
  return `${AI_ENGINE_PATH}?tab=${encodeURIComponent(tab)}`;
}
