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

import { AGENT_KEY_TABS } from './agentKeys';
import { DEFAULT_TAB as AGENTS_DEFAULT_TAB, tabHref as agentsTabHref } from '../agents/tabs';

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
  // The agent key tabs (Koda's, Claude Publisher's and the rest) moved to
  // the Agents page in #1905; their old addresses redirect there (below).
  // The Developer API's organizer keys (ADR 0042): make, re-scope, rotate and
  // revoke one key per event organizer, and what each key can reach.
  { id: 'developer-api', label: 'Developer API' },
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
  developer: 'developer-api',
  'developer-keys': 'developer-api',
  'organizer-keys': 'developer-api',
});

/**
 * The `?tab=` values that now live on the Agents page (#1905), and the
 * Agents tab each lands on: every agent key's own id (Koda's, Claude
 * Publisher's `claude`, and the rest), and the words that used to reach
 * Koda's tab here. `agents` opens the Agents page's Overview, which lists
 * every key.
 */
export const MOVED_TO_AGENTS = Object.freeze({
  ...Object.fromEntries(AGENT_KEY_TABS.map((agent) => [agent.id, agent.id])),
  agent: 'koda',
  muse: 'koda',
  'agent-content': 'koda',
  agents: AGENTS_DEFAULT_TAB,
});

/**
 * Where an AI Engine address that named an agent key tab goes now: the
 * Agents page's matching tab, or null when the `?tab=` value is the AI
 * Engine's own (or unknown, which lands on AI Services as before).
 */
export function agentsPageRedirect(requested) {
  if (!Object.hasOwn(MOVED_TO_AGENTS, requested ?? '')) return null;
  return agentsTabHref(MOVED_TO_AGENTS[requested]);
}

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
