/**
 * The Decision Center's pure half (#1013, #1014): its tabs, the words each
 * item's kind and stage are shown as, how long something has waited, and
 * where each source's full list lives. Everything here is a function of the
 * API's answer (POST getDecisionCenter, functions/src/lib/decision-center.js),
 * so it is tested without rendering.
 */

/** The query parameter that holds the selected tab, so Back from an item returns to it. */
export const DECISIONS_PARAM = 'decisions';

export const DECISION_TABS = Object.freeze([
  { id: 'all', label: 'Needs a Decision' },
  { id: 'frameworks', label: 'Frameworks' },
  { id: 'queues', label: 'Queues' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'governance', label: 'Governance' },
  { id: 'other', label: 'Other Actions' },
]);

export const DEFAULT_DECISION_TAB = 'all';

const TAB_IDS = new Set(DECISION_TABS.map((tab) => tab.id));

/** The tab a `?decisions=` value opens: its own, or Needs a Decision. */
export const resolveDecisionTab = (value) => (TAB_IDS.has(value) ? value : DEFAULT_DECISION_TAB);

/** The items a tab lists, in the order the API sent (newest first). */
export const itemsForTab = (items, tab) =>
  tab === DEFAULT_DECISION_TAB ? items : items.filter((item) => item.category === tab);

/** Rows a tab shows before "Show all". */
export const VISIBLE_ROWS = 15;

/** What each item is, as a reader says it. A content item's kind is its content type. */
export const KIND_LABELS = Object.freeze({
  blog: 'Blog',
  news: 'News',
  architecture: 'Architecture',
  framework: 'Framework',
  coder_corner: 'Coder Corner',
  transcript: 'Podcast transcript',
  chapter: 'Listen & Learn chapter',
  newsletter: 'Newsletter issue',
  social: 'Social post',
  forge_queue: 'Forge Studio Queue entry',
  alert: 'Workflow alert',
  secret: 'App setting',
  reminder: 'Reminder',
  ambassador: 'Ambassador',
});

/** Where each item waits. Content stages are lib/status.js's; the rest are the API's. */
export const STAGE_LABELS = Object.freeze({
  drafts: 'Drafts',
  review: 'Review',
  editor: 'Editor',
  publish: 'Ready to publish',
  live: 'Not live yet',
  off: 'Off the pipeline',
  approval: 'Awaiting approval',
  keep: 'Keep or delete',
  rejected: 'Rejected',
  retry: 'Failed, retry',
  compose: 'Compose',
  'sync failed': 'Sync failed',
  acknowledge: 'Acknowledge',
  configure: 'Configure',
  due: 'Due today',
  overdue: 'Overdue',
  deadline: 'Deadline',
});

const humanize = (value) => {
  const words = String(value ?? '').replace(/_/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
};

export const kindLabel = (kind) => KIND_LABELS[kind] ?? humanize(kind);
export const stageLabel = (stage) => STAGE_LABELS[stage] ?? humanize(stage);

/** "waiting 3d", "waiting 5h", "waiting 12m", "due in 2d" — or '' with no time. */
export function waitingLabel(iso, nowMs = Date.now()) {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return '';
  const diff = nowMs - at;
  const mins = Math.floor(Math.abs(diff) / 60000);
  let span = `${Math.floor(mins / 1440)}d`;
  if (mins < 60) span = `${mins}m`;
  else if (mins < 1440) span = `${Math.floor(mins / 60)}h`;
  return diff < 0 ? `in ${span}` : `waiting ${span}`;
}

/** The page holding each source's whole list, for "there are more" and "could not be read". */
export const SOURCE_PAGES = Object.freeze({
  'review-queue': '/admin/review-queue',
  frameworks: '/admin/frameworks',
  'coder-corner': '/admin/coder-corner',
  editor: '/admin/editor',
  'forge-ready': '/admin/review-queue?status=forge_ready',
  'publish-ready': '/admin/publish',
  'podcast-transcripts': '/admin/recording-hub?tab=transcripts',
  'listen-and-learn': '/admin/listen-and-learn?tab=review',
  newsletters: '/admin/newsletter-hub?tab=newsletter',
  social: '/admin/social-hub?tab=queue',
  'forge-queue': '/admin/forge-studio?tab=queue',
  'workflow-alerts': '/admin/health?tab=alerts',
  'unresolved-secrets': '/admin/health?tab=overview',
  reminders: '/admin/platform-settings?tab=reminders',
  ambassador: '/admin/ambassador?tab=applications',
});

/** The source rows a tab speaks for: every row on Needs a Decision, its own category's otherwise. */
export const sourcesForTab = (sources, tab) =>
  tab === DEFAULT_DECISION_TAB ? sources : sources.filter((row) => row.category === tab);

/** What an empty tab says, and where to go instead. */
export const EMPTY_TEXT = Object.freeze({
  all: {
    title: 'Nothing is waiting on you',
    description:
      'Review items, staged content, approvals, open alerts, due reminders and deadlines will appear here.',
  },
  frameworks: {
    title: 'No framework is waiting for review',
    description: 'A framework sent for review appears here until it is approved or rejected.',
  },
  queues: {
    title: 'The queues are clear',
    description:
      'New imports, feed items, drafts sent to review and Editor work needing action appear here.',
  },
  pipelines: {
    title: 'No pipeline is waiting on you',
    description:
      'Forge-ready drafts, staged content, transcripts, chapters, newsletter issues and failed posts appear here.',
  },
  governance: {
    title: 'No open alert or setting needs attention',
    description:
      'Open workflow alerts and app settings whose Key Vault reference does not resolve appear here.',
  },
  other: {
    title: 'No other action is due',
    description: 'Coder Corner reviews, due reminders and Ambassador deadlines appear here.',
  },
});
