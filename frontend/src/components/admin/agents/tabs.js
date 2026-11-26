/**
 * The Agents page's tabs (#1905): an Overview, then one tab per agent key
 * the site can hold (ai-engine/agentKeys.js), in that list's order.
 *
 * Kept out of the page module so a link builder elsewhere (the Integrations
 * card, the Health page, the AI Engine's redirect) can import the ids
 * without pulling the lazily loaded page into the main bundle. The page's
 * route is the nav registry's (adminNav.js), never typed here.
 */
import { navItemById } from '@/config/adminNav';
import { AGENT_KEY_TABS } from '@/components/admin/ai-engine/agentKeys';

/** The Agents page's route, from the nav registry. */
export const AGENTS_PATH = navItemById('agents').to;

export const TABS = Object.freeze([
  { id: 'overview', label: 'Overview' },
  ...AGENT_KEY_TABS.map((agent) => Object.freeze({ id: agent.id, label: agent.displayName })),
]);

export const DEFAULT_TAB = 'overview';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

/**
 * Ids that are not tabs here but name what a tab holds: the words the AI
 * Engine used to accept for Koda's tab, and the plain names of the others.
 */
export const MOVED_TABS = Object.freeze({
  agent: 'koda',
  muse: 'koda',
  'agent-content': 'koda',
  publisher: 'claude',
  'claude-publisher': 'claude',
  network: 'claude-network',
  'network-guy': 'claude-network',
  'claude-network-guy': 'claude-network',
});

/** The tab to show for a `?tab=` value: its own, where it moved, or Overview. */
export function resolveTab(requested) {
  // Own properties only: `?tab=constructor` must not read Object.prototype.
  const id = Object.hasOwn(MOVED_TABS, requested ?? '') ? MOVED_TABS[requested] : requested;
  return TAB_IDS.has(id) ? id : DEFAULT_TAB;
}

export function tabHref(tab) {
  return `${AGENTS_PATH}?tab=${encodeURIComponent(tab)}`;
}

/** An agent key's own tab, where it is made, switched, rotated and revoked. */
export const agentKeyTabHref = (id) => tabHref(id);
