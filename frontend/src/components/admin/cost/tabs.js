/**
 * The Cost page's tabs, and where an old or guessed `?tab=` lands.
 *
 * Kept out of the page module so a link builder (the Decision Center, the
 * calendar's renewal items) can import the route without pulling the lazily
 * loaded page into the main bundle.
 */

export const COST_PATH = '/admin/cost';

export const TABS = Object.freeze([
  { id: 'overview', label: 'Overview' },
  { id: 'azure', label: 'Azure' },
  { id: 'ai', label: 'AI' },
  { id: 'services', label: 'Services' },
  { id: 'alerts', label: 'Alerts' },
]);

export const DEFAULT_TAB = 'overview';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

/**
 * Words someone might reasonably type or bookmark that are not tab ids here,
 * sent to the tab holding what they mean: budgets live on the Azure tab,
 * credits on the AI tab, and the settings sit under Alerts because every
 * setting is about when an alert is raised or sent.
 */
export const MOVED_TABS = Object.freeze({
  budgets: 'azure',
  spend: 'overview',
  subscriptions: 'services',
  credits: 'ai',
  signals: 'alerts',
  settings: 'alerts',
});

/** The tab to show for a `?tab=` value: its own, where it moved, or Overview. */
export function resolveTab(requested) {
  const id = Object.hasOwn(MOVED_TABS, requested) ? MOVED_TABS[requested] : requested;
  return TAB_IDS.has(id) ? id : DEFAULT_TAB;
}

export function tabHref(tab) {
  return `${COST_PATH}?tab=${encodeURIComponent(tab)}`;
}
