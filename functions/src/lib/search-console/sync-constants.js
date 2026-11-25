/**
 * sync-constants.js — the fixed numbers and names one Search Console run
 * (sync.js) works with. They live here so the run's helper files can share
 * them; sync.js exports them again, so callers keep importing from sync.js.
 */
import { RUN_DEADLINE_MS } from './lease.js';

export const CONTAINER = 'admin_config';
export const SNAPSHOT_DOC_ID = 'search_console_snapshot';
export const SNAPSHOT_DOC_TYPE = 'search_console_snapshot';

/**
 * The site's domain. The Search Console property is the Domain property
 * `sc-domain:hybridcloudworks.com`, which covers this host and every
 * subdomain (api-azure., docs., the lab hosts), and the report covers all of
 * them (owner decision of 2026-11-09 on #1612, which replaced the first
 * version's main-site-only rule). So Search Analytics is read with no
 * filter: every total, the daily line and each top-50 table count the same
 * pages as Google's own Performance screen for the property.
 */
export const SITE_DOMAIN = 'hybridcloudworks.com';
/** Only the main site publishes a sitemap. */
export const DEFAULT_SITEMAP_URL = `https://${SITE_DOMAIN}/sitemap.xml`;
/** The most pages one run inspects, sitemap pages and strays together. */
export const MAX_URLS = 900;
/** The most strays one run inspects, after the sitemap's pages and inside MAX_URLS. */
export const STRAYS_INSPECTED_MAX = 150;
/** How much later than a job's creation a finished run must be to supersede it. */
export const SUPERSEDE_SLACK_MS = 5000;
export const CONCURRENCY = 4;
/** Gap between inspection starts: 110 ms is at most about 545 a minute, under Google's 600. */
export const INSPECT_SPACING_MS = 110;
export const HISTORY_MAX = 120;
export const STRAYS_MAX = 100;
export const TOP_ROWS = 50;
export const PAGE_ROWS_FOR_STRAYS = 1000;
export const RANGE_DAYS = 90;
export const SHORT_RANGE_DAYS = 28;
/** Google's Search Analytics data lags about two days. */
export const LAG_DAYS = 2;
/**
 * A sitemap index may point at this many child sitemaps. When it lists more,
 * the rest are not read, and the run treats the sitemap as not read in full.
 */
export const MAX_CHILD_SITEMAPS = 20;
export const WRITE_ATTEMPTS = 3;
/** Long strings from Google are cut to this length before they are stored. */
export const MAX_FIELD = 2048;

/** What Google's API does not offer, shown on the page as is. */
export const NOT_AVAILABLE = Object.freeze(['Page indexing totals and reasons', 'Links (internal and external)']);

export const NOT_INSPECTED_BUDGET = 'Not inspected in the last run: the daily allowance of Google page inspections was used up.';
export const NOT_INSPECTED_QUOTA = 'Not inspected in the last run: Google answered that its quota was used up.';
export const NOT_IN_SITEMAP_READ =
  'Not inspected in the last run: the sitemap could not be read in full, and the part that was read does not list this page.';
export const NOT_IN_SEARCH_READ =
  "Not inspected in the last run: the pages Google shows in search could not be worked out (the sitemap or Google's page list could not be read in full), so this page was not looked for.";
export const NOT_INSPECTED_DEADLINE = `Not inspected in the last run: the run reached its ${RUN_DEADLINE_MS / 60000}-minute time limit first.`;
