/**
 * The Linkie Hub's tabs, and where old addresses land (#577).
 *
 * Kept out of the page module so a link builder elsewhere can import the ids
 * without pulling the lazily loaded page into the main bundle.
 */

export const LINKIE_PATH = '/admin/linkie-hub';

export const TABS = Object.freeze([
  { id: 'links', label: 'Links' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'settings', label: 'Settings' },
]);

/** Links, the tab that does the work and the one the page opened on. */
export const DEFAULT_TAB = 'links';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

/**
 * `connection` is the id this page shipped with for its third tab. The
 * Newsletter Hub standard puts a provider's connection test on Settings, so the
 * tab was renamed — and every link written before #577 names the old id.
 */
export const MOVED_TABS = Object.freeze({
  connection: 'settings',
  connect: 'settings',
  setup: 'settings',
  profile: 'settings',
  posts: 'links',
  link: 'links',
  stats: 'analytics',
  traffic: 'analytics',
});

/** The tab to show for a `?tab=` value: its own, where it moved, or Links. */
export function resolveTab(requested) {
  // Own properties only: `?tab=constructor` must not read Object.prototype.
  const id = Object.prototype.hasOwnProperty.call(MOVED_TABS, requested ?? '')
    ? MOVED_TABS[requested]
    : requested;
  return TAB_IDS.has(id) ? id : DEFAULT_TAB;
}

export function tabHref(tab) {
  return `${LINKIE_PATH}?tab=${encodeURIComponent(tab)}`;
}
