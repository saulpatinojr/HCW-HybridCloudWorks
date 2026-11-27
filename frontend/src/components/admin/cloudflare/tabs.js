/**
 * The Cloudflare page's tabs (#1905), and the words that land on them.
 *
 * Kept out of the page module so a link builder elsewhere can import the ids
 * without pulling the lazily loaded page into the main bundle. The page's
 * route is the nav registry's (adminNav.js), never typed here.
 */
import { navItemById } from '@/config/adminNav';
import { LINK_PARAMS } from '@/lib/itemLinks';
import { DEFAULT_ZONE, resolveZone } from './cloudflareLocks';

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

/**
 * The page's address parameters after a change of tab or zone (#1911): the
 * tab, and the zone (LINK_PARAMS.zone) unless it is the site's own, so an
 * address written before the picker still opens the site's zone.
 */
export function cloudflareParams(current, { tab, zone } = {}) {
  const next = new URLSearchParams(current);
  if (tab !== undefined) next.set('tab', tab);
  const picked = resolveZone(zone ?? next.get(LINK_PARAMS.zone));
  if (picked === DEFAULT_ZONE) next.delete(LINK_PARAMS.zone);
  else next.set(LINK_PARAMS.zone, picked);
  return next;
}

/** A link to one tab, in the site's zone unless another managed zone is named. */
export function tabHref(tab, zone = DEFAULT_ZONE) {
  return `${CLOUDFLARE_PATH}?${cloudflareParams('', { tab, zone })}`;
}
