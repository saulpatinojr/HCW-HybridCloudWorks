/**
 * The Speaking Events Hub's tabs, and where other ids land (#573).
 *
 * Kept out of the page module so a link elsewhere can import `tabHref`
 * without pulling the lazily loaded page into the main bundle.
 */

export const SPEAKING_EVENTS_PATH = '/admin/speaking';

export const TABS = Object.freeze([
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'sources', label: 'Sources' },
  { id: 'publishing', label: 'Publishing' },
  // Not "Upcoming": that tab is the owner's own sessions. This one is other
  // people's events the owner could send a talk to (#1823). Named and placed
  // by the owner on 2026-11-24: a tab's name is one or two words, and this
  // one sits after Publishing. The id stays `apply`, so old links still work.
  { id: 'apply', label: 'Future Events' },
  { id: 'settings', label: 'Settings' },
]);

export const DEFAULT_TAB = 'upcoming';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

/**
 * The page was one scroll with no tabs, so no id ever existed here. These name
 * what a tab now holds — the page's old section and button names — so a
 * hand-typed link lands where its content went rather than on Upcoming.
 */
export const MOVED_TABS = Object.freeze({
  events: 'upcoming',
  calendar: 'upcoming',
  delivered: 'past',
  'community-days': 'apply',
  calls: 'apply',
  cfp: 'apply',
  'call-for-speakers': 'apply',
  history: 'past',
  sessionize: 'sources',
  sync: 'sources',
  manual: 'sources',
  'manual-entries': 'sources',
  publish: 'publishing',
  snapshot: 'publishing',
  speaker: 'settings',
  profile: 'settings',
  display: 'settings',
});

/** The tab to show for a `?tab=` value: its own, where it moved, or Upcoming. */
export function resolveTab(requested) {
  // Own properties only: `?tab=constructor` must not read Object.prototype.
  const id = Object.prototype.hasOwnProperty.call(MOVED_TABS, requested ?? '')
    ? MOVED_TABS[requested]
    : requested;
  return TAB_IDS.has(id) ? id : DEFAULT_TAB;
}

export function tabHref(tab) {
  return `${SPEAKING_EVENTS_PATH}?tab=${encodeURIComponent(tab)}`;
}
