/**
 * One status vocabulary for the whole admin (ADR 0033 §2).
 *
 * Until 2026-10-03 five surfaces used five vocabularies — PASS/FAIL/UNKNOWN,
 * connected/error/untested, Broken/Not configured/Working, failed/degraded,
 * OPERATIONAL/REGIONAL — for the same five situations. A reader learning one
 * page learned nothing about the next. This module names the situations once:
 *
 *   SYSTEM_STATUS   how a dependency, probe or integration is doing
 *   CONTENT_STATUS  where a piece of content is in the pipeline, as a person
 *                   reads it (the stored ids are content-status.js's)
 *
 * Both carry a tone (ok / warn / bad / down / off / muted) the StatusBadge
 * turns into colour AND an icon, so colour is never the only signal.
 *
 * Every other status table in the admin (speaking, ambassador, chapter) is
 * built by `statusTable` below, so the record shape — `{ id, label, tone,
 * help }` — is written once and a badge can read any of them.
 *
 * ## The system status model (#1010, #1011)
 *
 * Five states, and the rules for moving between them, are written here and
 * nowhere else in the frontend. The server keeps one mirror for the health
 * pulse (functions/src/lib/health/status-model.js), and
 * pages/admin/health/statusParity.test.js fails if the two disagree on an id,
 * a window or a classification.
 *
 *   healthy   it answered and every check passed
 *   degraded  it answered, but slower, partly, or with a warning count above zero
 *   critical  it answered, but said no: a setting or key is wrong or missing,
 *             a credential was refused, or the check itself fails
 *   offline   it could not be reached at all (a network error, a timeout, a
 *             502, 503 or 504), or it has been silent past its heartbeat window
 *   unknown   never checked, or the last check is older than its freshness
 *             window: stale. The last value and its age are still shown.
 *
 * Until 2026-10-08 critical was `misconfigured` and offline was `unavailable`.
 * `toSystemStatus` still reads both words (LEGACY_SYSTEM_IDS), so a stored
 * result or an older caller keeps working.
 *
 * TRANSITIONS
 *
 *   - Only a check that ran moves a result to healthy, degraded, critical or
 *     offline: a probe, a Test button, or the server-side pulse. When a check
 *     fails, `classifyFailure` decides between critical and offline.
 *   - A result becomes unknown when it ages past `freshnessWindow` for its
 *     probe, and comes back the moment a newer check lands.
 *   - A heartbeat (the pulse itself, a lab agent) is offline after MISSED_BEATS
 *     missed beats in a row. That is three, the rule the lab agents' 90 s
 *     window (3 × 30 s) already used.
 */

/**
 * A frozen status table from `{ id: [label, tone, help] }` rows. `fields`
 * names the columns in row order, for a table that carries more than the
 * three every badge needs (CONTENT_STATUS adds `stage`).
 */
export function statusTable(rows, fields = ['label', 'tone', 'help']) {
  const entries = Object.entries(rows).map(([id, values]) => {
    const record = { id };
    fields.forEach((field, index) => {
      record[field] = values[index];
    });
    return [id, Object.freeze(record)];
  });
  return Object.freeze(Object.fromEntries(entries));
}

export const SYSTEM_STATUS = statusTable({
  healthy: ['Healthy', 'ok', 'It answered and every check passed.'],
  degraded: ['Degraded', 'warn', 'Working, but slower, partial, or with something to look at.'],
  critical: [
    'Critical',
    'bad',
    'It answered, but said no: a setting or key is wrong or missing, or its check fails.',
  ],
  offline: ['Offline', 'down', 'Not reachable, or silent for longer than it should be.'],
  unknown: ['Unknown', 'muted', 'Never checked, or the last check is too old to trust (stale).'],
});

/** The ids the model used until 2026-10-08, and the state each now means. */
export const LEGACY_SYSTEM_IDS = Object.freeze({
  misconfigured: 'critical',
  unavailable: 'offline',
});

/** The words older surfaces still produce, by the shared state each means. */
const SYSTEM_WORDS = Object.freeze({
  healthy: ['healthy', 'ok', 'pass', 'connected', 'working', 'live', 'operational', 'success'],
  degraded: ['degraded', 'regional', 'slow', 'going live', 'pending', 'partial'],
  critical: [
    'critical',
    'misconfigured',
    'not configured',
    'unconfigured',
    'never',
    'missing',
    'fail',
    'failed',
    'failing',
    'error',
    'broken',
    'rejected',
  ],
  offline: ['offline', 'unavailable', 'unreachable', 'down', 'disconnected', 'timeout'],
  unknown: ['unknown', 'stale', 'untested'],
});

const WORD_TO_SYSTEM = new Map(
  Object.entries(SYSTEM_WORDS).flatMap(([id, words]) => words.map((word) => [word, id]))
);

/**
 * Map the words older surfaces still produce onto the shared vocabulary.
 * Unknown input is `unknown`, never a guess.
 */
export function toSystemStatus(value) {
  const word = String(value ?? '')
    .trim()
    .toLowerCase();
  return SYSTEM_STATUS[WORD_TO_SYSTEM.get(word)] ?? SYSTEM_STATUS.unknown;
}

// ── Transitions ──────────────────────────────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** How often the server-side health pulse runs (functions/src/functions/schedulers.js). */
export const PULSE_INTERVAL_MS = 5 * MINUTE_MS;

/** Beats a heartbeat may miss before it is offline. */
export const MISSED_BEATS = 3;

/** The pulse is late, and the hub cannot vouch for itself, after this long. */
export const PULSE_LATE_AFTER_MS = MISSED_BEATS * PULSE_INTERVAL_MS;

/**
 * How long a result stays evidence, by where it came from. Past this it is
 * shown as unknown (stale), with its last value and its age.
 *
 *   pulse     anything the pulse wrote. It rewrites every result each run, so
 *             a result three beats old means the pulse stopped.
 *   snapshot  read from the ops snapshot. The page reads it on load and the
 *             pulse re-reads it every five minutes: the same three beats.
 *   live      a request someone made: a Test button, or Test all. A day old,
 *             it says how things were yesterday.
 *   session   a check run in a signed-in browser (smoke tests, the Labs round
 *             trip). The same day. A probe may set a `freshForMs` of its
 *             own: shorter when what it checks lives less long (the session
 *             token checks, because an access token lasts about ninety
 *             minutes), or a little longer when a daily timer records it (the
 *             Cloudflare rate limit, 26 hours, #1918).
 */
export const FRESHNESS_MS = Object.freeze({
  pulse: PULSE_LATE_AFTER_MS,
  snapshot: PULSE_LATE_AFTER_MS,
  live: 24 * HOUR_MS,
  session: 24 * HOUR_MS,
});

/** The freshness window for one probe's result. */
export function freshnessWindow(probe, result) {
  if (result?.checkedBy === 'pulse') return FRESHNESS_MS.pulse;
  if (Number.isFinite(probe?.freshForMs)) return probe.freshForMs;
  return FRESHNESS_MS[probe?.kind] ?? FRESHNESS_MS.live;
}

/** Milliseconds since `iso`, or null when it is not a time. */
export function ageMs(iso, now = Date.now()) {
  const then = Date.parse(iso ?? '');
  return Number.isFinite(then) ? Math.max(0, now - then) : null;
}

/** "just now", "12 min ago", "3 h ago", "2 d ago"; null when `iso` is not a time. */
export function describeAge(iso, now = Date.now()) {
  const age = ageMs(iso, now);
  if (age === null) return null;
  const minutes = Math.round(age / MINUTE_MS);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** A window as words: "15 min", "24 h". */
export function describeWindow(ms) {
  if (ms < HOUR_MS) return `${Math.round(ms / MINUTE_MS)} min`;
  if (ms < 48 * HOUR_MS) return `${Math.round(ms / HOUR_MS)} h`;
  return `${Math.round(ms / (24 * HOUR_MS))} d`;
}

/**
 * A result as it should be shown now: unchanged while fresh; past its window,
 * unknown, with `stale: true` and the value it had as `lastStatus`. A result
 * with no time (never checked) is returned as it is.
 */
export function applyFreshness(result, windowMs, now = Date.now()) {
  if (!result) return result;
  const status = toSystemStatus(result.status).id;
  const age = ageMs(result.checkedAt, now);
  if (age === null || age <= windowMs) return { ...result, status, stale: false };
  return { ...result, status: 'unknown', stale: true, lastStatus: status, windowMs };
}

/** A refusal that names a missing or unset setting: critical, never offline. */
const MISSING_SETTING = /not configured|is not set|not provisioned|no \S+( \S+)? (is )?configured/i;

/** What an unreachable dependency says, in the words fetch, Node and our own routes use. */
const UNREACHABLE =
  /failed to fetch|networkerror|network error|load failed|timed out|\btimeout\b|did not answer|could not be reached|unreachable|not reachable|econnrefused|econnreset|enotfound|eai_again|getaddrinfo|socket hang up|no heartbeat|\bHTTP (502|503|504)\b/i;

/** HTTP statuses that mean nothing answered behind the gateway. */
const UNREACHABLE_STATUSES = new Set([502, 503, 504]);

/**
 * Critical or offline, for a check that failed. Takes the thrown Error (its
 * `status`, when the API client set one, is read first) or the message alone.
 *
 * A missing setting is critical. A network error, a timeout or a gateway
 * status is offline. Anything else answered and said no — a 401, a 403, a
 * 500, a failing assertion — and is critical.
 */
export function classifyFailure(failure) {
  const message = String(failure?.message ?? failure ?? '');
  if (MISSING_SETTING.test(message)) return 'critical';
  if (UNREACHABLE_STATUSES.has(Number(failure?.status))) return 'offline';
  return UNREACHABLE.test(message) ? 'offline' : 'critical';
}

/** Worst first. Unknown is not ranked: it is what is left when nothing is known. */
const SEVERITY = Object.freeze(['offline', 'critical', 'degraded', 'healthy']);

/**
 * The worst of several statuses: offline, then critical, then degraded, then
 * healthy. Unknown counts only when nothing else is known, so one probe that
 * was never pressed does not hide that everything else is fine.
 */
export function worstStatus(statuses) {
  const ids = new Set([...statuses].map((status) => toSystemStatus(status).id));
  return SEVERITY.find((id) => ids.has(id)) ?? 'unknown';
}

/**
 * The pulse's own state from its heartbeat: unknown until it has ever
 * reported, healthy while its last beat is inside PULSE_LATE_AFTER_MS, and
 * offline once it is later than that.
 */
export function pulseStatus(pulse, now = Date.now()) {
  const age = ageMs(pulse?.lastBeatAt, now);
  if (age === null) return 'unknown';
  const lateAfter = Number(pulse?.lateAfterMs) || PULSE_LATE_AFTER_MS;
  return age > lateAfter ? 'offline' : 'healthy';
}

/**
 * The Health Hub's one word. While the pulse beats, the worst of the probes'
 * fresh results. Once it is late the hub is offline, whatever the last
 * results said, because nothing is re-checking them; before it has ever
 * beaten, unknown.
 */
export function hubStatus(pulse, statuses, now = Date.now()) {
  const beat = pulseStatus(pulse, now);
  return beat === 'healthy' ? worstStatus(statuses) : beat;
}

/**
 * Content pipeline statuses as a reader sees them. Ids are the stored values
 * in functions/src/lib/cms/content-status.js; `stage` is the pipeline stage
 * the dashboard and the stepper place it in.
 */
export const CONTENT_STATUS = statusTable(
  {
    drafting: [
      'Drafting',
      'muted',
      'drafts',
      'Being written on the Drafts page; not in the pipeline yet.',
    ],
    draft: ['Draft', 'muted', 'review', 'Created by a tool and waiting for a first look.'],
    ingested: ['Ingested', 'muted', 'review', 'Arrived from a feed or import; not yet inspected.'],
    inspected: [
      'Inspected',
      'warn',
      'review',
      'The inspector has read it; waiting for your decision.',
    ],
    needs_rework: [
      'Needs rework',
      'warn',
      'editor',
      'The inspector found problems to fix before review.',
    ],
    in_review: ['In review', 'warn', 'review', 'Being reviewed on its board.'],
    approved: ['Approved', 'ok', 'editor', 'Cleared for editing and publishing.'],
    editing: ['Editing', 'ok', 'editor', 'Open in the editor.'],
    forge_ready: [
      'Forge ready',
      'ok',
      'publish',
      'AI-drafted and graded above the threshold; one click from publishing.',
    ],
    published: ['Published', 'ok', 'live', 'Marked published; live when the Live flag is set.'],
    rejected: [
      'Rejected',
      'bad',
      'off',
      'Declined; deleted after the grace period unless restored.',
    ],
    archived: ['Archived', 'off', 'off', 'Kept but no longer live or in the pipeline.'],
  },
  ['label', 'tone', 'stage', 'help']
);

/** Legacy spellings still found on old documents and in old links. */
const CONTENT_ALIASES = Object.freeze({
  approved_blog: 'approved',
  approved_news: 'approved',
  published_blog: 'published',
  published_news: 'published',
  published_both: 'published',
  published_live: 'published',
  ready_to_publish: 'approved',
});

const LIVE = Object.freeze({
  id: 'live',
  label: 'Live',
  tone: 'ok',
  stage: 'live',
  help: 'Visitors can open this page now.',
});

/** A status no table knows, shown as words rather than thrown. */
const unlistedContentStatus = (raw) => ({
  label: raw.replace(/_/g, ' '),
  tone: 'muted',
  stage: 'review',
  help: '',
});

export function contentStatusInfo(statusOrItem) {
  const item =
    typeof statusOrItem === 'string' ? { contentStatus: statusOrItem } : statusOrItem || {};
  const raw = String(item.contentStatus || 'ingested').toLowerCase();
  const id = CONTENT_ALIASES[raw] || raw;
  const base = CONTENT_STATUS[id] || unlistedContentStatus(raw);
  const offThePipeline = id === 'rejected' || id === 'archived';
  if (item.Live === true && !offThePipeline) return LIVE;
  return { id, ...base };
}
