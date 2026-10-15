/**
 * The Social Hub's tabs, and where old addresses land (#575).
 *
 * Kept out of the page module so a link builder elsewhere can import the ids
 * without pulling the lazily loaded page into the main bundle.
 *
 * A tab is one entry here plus its panel in SocialHubPage's `PANELS`.
 */

export const SOCIAL_PATH = '/admin/social-hub';

export const TABS = Object.freeze([
  { id: 'compose', label: 'Compose' },
  { id: 'queue', label: 'Queue' },
  { id: 'published', label: 'Published' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'settings', label: 'Settings' },
]);

/** Compose, the tab the page has always opened on, and the one that does work. */
export const DEFAULT_TAB = 'compose';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

/**
 * Ids that are no longer tabs but name what a tab now holds.
 *
 * `connection` is the one that matters: the tab bar here read
 * "Connection Settings" with an id of `settings`, so a link someone wrote by
 * reading the label lands on Settings rather than falling back to Compose.
 * The rest are the section headings and the words someone would reasonably
 * type — `accounts` used to be a card inside Settings and is now its own tab,
 * so a bookmark saved before #575 must not keep pointing at Settings.
 */
export const MOVED_TABS = Object.freeze({
  connection: 'settings',
  connections: 'settings',
  'connection-settings': 'settings',
  workspace: 'settings',
  profiles: 'accounts',
  'connected-accounts': 'accounts',
  schedule: 'compose',
  scheduled: 'queue',
  calendar: 'published',
  history: 'published',
  live: 'published',
});

/** The tab to show for a `?tab=` value: its own, where it moved, or Compose. */
export function resolveTab(requested) {
  // Own properties only: `?tab=constructor` must not read Object.prototype.
  const id = Object.prototype.hasOwnProperty.call(MOVED_TABS, requested ?? '')
    ? MOVED_TABS[requested]
    : requested;
  return TAB_IDS.has(id) ? id : DEFAULT_TAB;
}

export function tabHref(tab) {
  return `${SOCIAL_PATH}?tab=${encodeURIComponent(tab)}`;
}
