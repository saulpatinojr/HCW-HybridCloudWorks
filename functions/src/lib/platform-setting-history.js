/**
 * platform-setting-history.js — the Platform Settings change history (#571):
 * what an audit row records about a save, and the history read that lists
 * those rows, newest first. platform-settings.js re-exports the public names.
 */
import { json } from './platform-setting-versions.js';
import { PLATFORM_SETTING_NAMES, resolveSetting } from './platform-setting-catalogue.js';
import { errorFacts } from './http/error-response.js';
import { DEFAULT_NEWSLETTER_SETTINGS } from './newsletter/settings.js';
import { summarizeReminders } from './reminders/settings.js';
import { isPlainObject } from './platform-setting-checks.js';

// ── change history ─────────────────────────────────────────────────────────

/** The audit action every successful PUT writes. */
export const PLATFORM_SETTING_AUDIT_ACTION = 'platform_setting_updated';
export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 100;

/** A timestamp as the audit writer stores it: `Date#toISOString()`. */
// Exactly Date#toISOString()'s shape, milliseconds included: the cursor is
// compared as a string against stored `.sssZ` timestamps, so any other shape
// would sort differently and skip or repeat rows.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * `?setting=&limit=&after=` → `{ setting, limit, after }` or `{ error }`.
 * Every refusal happens here, before the store is touched: `setting` must be
 * a name in the spec registry (an own key, so `constructor` is refused like
 * any typo), `limit` a whole number 1..100 when given, and `after` an ISO
 * timestamp of the shape the audit writer stores.
 */
export function parseHistoryQuery(query) {
  const get = (key) => {
    const raw = query?.get?.(key);
    return raw === null || raw === undefined ? '' : String(raw).trim();
  };
  const setting = get('setting');
  if (setting !== '' && !resolveSetting(setting)) {
    return { error: `setting must be one of ${PLATFORM_SETTING_NAMES.join(', ')}` };
  }
  const limitRaw = get('limit');
  let limit = HISTORY_DEFAULT_LIMIT;
  if (limitRaw !== '') {
    limit = /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT) {
      return { error: `limit must be a whole number from 1 to ${HISTORY_MAX_LIMIT}` };
    }
  }
  const after = get('after');
  if (after !== '' && (!ISO_TIMESTAMP.test(after) || !Number.isFinite(Date.parse(after)))) {
    return { error: 'after must be an ISO timestamp such as 2026-09-14T12:00:00.000Z' };
  }
  return { setting: setting || null, limit, after: after || null };
}

/**
 * Who made a change, as the row stored it: the display name when the row has
 * one, else the Entra object id. Never the email — the row carries
 * `userEmail`, and this view has no need of it — and never anything shaped
 * like one, since a display name can be an address for an account that never
 * set a name.
 */
function actorOf(row) {
  for (const candidate of [row.userName, row.userId]) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed !== '' && !trimmed.includes('@')) return trimmed;
  }
  return null;
}

const isSummaryScalar = (value) =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

/**
 * One audit row → `{ id, at, actor, setting, summary }`, and nothing else.
 * `summary` is the recorded details minus `setting`, limited to scalars and
 * lists of scalars — which is all `summarize` writes — so a hand-written row
 * with a nested object cannot carry more than the table shows.
 */
export function presentHistoryEntry(row) {
  const details = isPlainObject(row?.details) ? row.details : {};
  const summary = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === 'setting') continue;
    if (isSummaryScalar(value)) summary[key] = value;
    else if (Array.isArray(value) && value.every(isSummaryScalar)) summary[key] = [...value];
  }
  return {
    id: String(row?.id ?? ''),
    at: typeof row?.timestamp === 'string' ? row.timestamp : null,
    actor: actorOf(row ?? {}),
    setting: typeof details.setting === 'string' ? details.setting : null,
    summary,
  };
}

/**
 * The history query. `action` and `timestamp` are both indexed on
 * `admin_audit_logs` (scripts/generate-cosmos-container-spec.mjs), so the
 * action is an index seek and the order and the `after` cursor use the range
 * index. `details.setting` is not indexed; it is evaluated only over the rows
 * the action already matched, which is a few per save.
 *
 * Paging is by timestamp: `after` is the `at` of the last row a page returned,
 * and the next page is the rows strictly older. Two saves in the same
 * millisecond could straddle a page boundary and one would be skipped, which
 * for a person clicking Save is not a case that arises.
 */
export function buildHistoryQuery({ setting, limit, after }) {
  const where = ['c.action = @action'];
  const parameters = [
    { name: '@limit', value: limit },
    { name: '@action', value: PLATFORM_SETTING_AUDIT_ACTION },
  ];
  if (setting) {
    where.push('c.details.setting = @setting');
    parameters.push({ name: '@setting', value: setting });
  }
  if (after) {
    where.push('c.timestamp < @after');
    parameters.push({ name: '@after', value: after });
  }
  return {
    query: `SELECT TOP @limit c.id, c.timestamp, c.userId, c.userName, c.details FROM c WHERE ${where.join(' AND ')} ORDER BY c.timestamp DESC`,
    parameters,
  };
}

/**
 * What the audit row records for each setting: counts and ids, never
 * contents. A setting not listed here records nothing beyond its name.
 */
const AUDIT_SUMMARIES = Object.freeze({
  'default-heroes': (value) => ({ providers: Object.keys(value.heroes).length }),
  'social-autopost': (value) => ({
    enabled: value.enabled,
    accounts: value.accountIds.length,
    scheduleDelayMinutes: value.scheduleDelayMinutes,
  }),
  // Whether a main feed is set, never which one: the audit row records
  // counts, and a URL is content.
  'podcast-feeds': (value) => ({ feeds: value.feeds.length, mainFeed: Boolean(value.mainFeedUrl) }),
  // Ids are settings; labels and descriptions are content, so only
  // which entries exist and which are on is recorded.
  'content-taxonomy': (value) => ({
    kinds: value.kinds.length,
    kindsEnabled: value.kinds.filter((k) => k.enabled).map((k) => k.id),
    ideaOrigins: value.ideaOrigins.length,
    ideaOriginsEnabled: value.ideaOrigins.filter((o) => o.enabled).map((o) => o.id),
  }),
  // Voice ids are settings, not content, and which ones were chosen is
  // the point of the row: a change of voice is what a listener hears.
  'podcast-voices': (value) => ({ ...value }),
  // Whether each is set, never the address or the inbox: those are
  // personal details, and the audit row records settings, not content.
  'newsletter-settings': (value) => ({
    postalAddress: Boolean(value.postalAddress),
    replyTo: Boolean(value.replyTo),
    sendDay: value.sendDay,
    sendTime: value.sendTime,
    timeZone: value.timeZone,
    sections: value.sections.filter((entry) => entry.enabled).map((entry) => entry.id),
    windowDays: value.windowDays,
    introEnabled: value.introEnabled,
    introTone: value.introTone,
    // Where the box shows is a setting; its wording is content, so only
    // whether it differs from the default is recorded.
    signupPlacement: value.signupPlacement,
    signupHeadingCustom: value.signupHeading !== DEFAULT_NEWSLETTER_SETTINGS.signupHeading,
    signupBlurbCustom: value.signupBlurb !== DEFAULT_NEWSLETTER_SETTINGS.signupBlurb,
    // An id, not content: which design the email uses.
    templateId: value.templateId || null,
  }),
  // Counts and the next date; titles and notes are content.
  reminders: summarizeReminders,
});

/** What the audit row records: counts, never contents. */
export const summarize = (name, value) => AUDIT_SUMMARIES[name]?.(value) ?? {};

/** What a spec offers to choose from, or nothing. */
export const optionsFor = (spec) =>
  typeof spec.options === 'function' ? { options: spec.options() } : {};

/**
 * The audit details as a log line may carry them: the row may keep the
 * template id, telemetry says only whether a template is chosen.
 */
export const auditDetailsForLog = (details) =>
  details.templateId === undefined
    ? details
    : { ...details, templateId: details.templateId ? '[set]' : null };

/**
 * GET /api/cms/platform-settings/history?setting=&limit=&after=
 *
 * The `platform_setting_updated` audit rows, newest first. Editor, the same
 * as reading a setting. The response carries `{ id, at, actor, setting,
 * summary }` per row and `nextAfter` when a full page came back; the log
 * line on failure names no query value.
 */
export async function getHistory({ guard, store }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const parsed = parseHistoryQuery(request.query);
  if (parsed.error) return json(400, { error: parsed.error });
  try {
    const { query, parameters } = buildHistoryQuery(parsed);
    const rows = await store.queryDocs('admin_audit_logs', query, parameters);
    const entries = (rows ?? []).slice(0, parsed.limit).map(presentHistoryEntry);
    const last = entries.at(-1);
    return json(200, {
      success: true,
      entries,
      nextAfter: entries.length === parsed.limit && last?.at ? last.at : null,
    });
  } catch (error) {
    context.error(`getPlatformSettingHistory failed: ${errorFacts(error)}`);
    return json(500, { error: 'Failed to read platform settings history' });
  }
}
