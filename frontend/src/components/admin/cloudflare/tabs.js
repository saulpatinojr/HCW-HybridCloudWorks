/**
 * The Cloudflare page's tabs (#1905), and the words that land on them.
 *
 * Kept out of the page module so a link builder elsewhere can import the ids
 * without pulling the lazily loaded page into the main bundle. The page's
 * route is the nav registry's (adminNav.js), never typed here.
 */
import { navItemById } from '@/config/adminNav';

/** The Cloudflare page's route, from the nav registry. */
export const CLOUDFLARE_PATH = navItemById('cloudflare').to;

export const TABS = Object.freeze([
  { id: 'overview', label: 'Overview' },
  { id: 'settings', label: 'Settings' },
  { id: 'dns', label: 'DNS' },
  { id: 'rules', label: 'Rules' },
  { id: 'cache', label: 'Cache' },
]);

export const DEFAULT_TAB = 'overview';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

/** Words someone may type or link for a tab that has another id. */
export const MOVED_TABS = Object.freeze({
  status: 'overview',
  zone: 'settings',
  records: 'dns',
  rulesets: 'rules',
  purge: 'cache',
});

/** The tab to show for a `?tab=` value: its own, where it moved, or Overview. */
export function resolveTab(requested) {
  // Own properties only: `?tab=constructor` must not read Object.prototype.
  const id = Object.hasOwn(MOVED_TABS, requested ?? '') ? MOVED_TABS[requested] : requested;
  return TAB_IDS.has(id) ? id : DEFAULT_TAB;
}

export function tabHref(tab) {
  return `${CLOUDFLARE_PATH}?tab=${encodeURIComponent(tab)}`;
}
