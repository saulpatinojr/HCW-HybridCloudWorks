/**
 * The Recording Hub's tabs, and where old addresses land (#576).
 *
 * The page had one tab per PROVIDER — Podcast and Plaud — with Plaud carrying
 * three sub-tabs of its own. These are duties instead, so "where do I approve a
 * transcript" has one answer rather than depending on which service produced
 * it. Providers are named inside the tabs and in the page header.
 *
 * Kept out of the page module so a link builder elsewhere can import the ids
 * without pulling the lazily loaded page into the main bundle.
 */

export const RECORDING_HUB_PATH = '/admin/recording-hub';

export const TABS = Object.freeze([
  { id: 'recordings', label: 'Recordings' },
  { id: 'transcripts', label: 'Transcripts' },
  { id: 'episodes', label: 'Episodes' },
  { id: 'distribution', label: 'Distribution' },
  { id: 'stats', label: 'Stats' },
  { id: 'settings', label: 'Settings' },
]);

/**
 * Transcripts, because the page opened on Podcast and the transcript list was
 * the first thing under it. A bookmark with no `?tab=` should land where its
 * owner left off rather than on the recordings library.
 */
export const DEFAULT_TAB = 'transcripts';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

/**
 * The provider tab ids, the Plaud sub-tab ids, and the words someone would
 * reasonably type. `podcast` and `plaud` matter most: they are the only two
 * ids this page ever had, so every link written before #576 uses one of them.
 *
 * `plaud` goes to Recordings rather than Settings because the Plaud tab opened
 * on its Library sub-tab — the recordings are what that link was for, not the
 * OAuth setup that sat two sub-tabs along.
 */
export const MOVED_TABS = Object.freeze({
  podcast: 'transcripts',
  plaud: 'recordings',
  library: 'recordings',
  upload: 'recordings',
  uploads: 'recordings',
  connect: 'settings',
  connection: 'settings',
  oauth: 'settings',
  review: 'transcripts',
  transcript: 'transcripts',
  episode: 'episodes',
  show: 'episodes',
  host: 'distribution',
  rss: 'distribution',
  feed: 'distribution',
  publish: 'distribution',
  // The Stats tab (#1115): the words someone would type for it.
  statistics: 'stats',
  downloads: 'stats',
  analytics: 'stats',
  listeners: 'stats',
});

/** The tab to show for a `?tab=` value: its own, where it moved, or Transcripts. */
export function resolveTab(requested) {
  // Own properties only: `?tab=constructor` must not read Object.prototype.
  const id = Object.prototype.hasOwnProperty.call(MOVED_TABS, requested ?? '')
    ? MOVED_TABS[requested]
    : requested;
  return TAB_IDS.has(id) ? id : DEFAULT_TAB;
}

export function tabHref(tab) {
  return `${RECORDING_HUB_PATH}?tab=${encodeURIComponent(tab)}`;
}
