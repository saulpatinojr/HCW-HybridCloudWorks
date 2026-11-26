/**
 * archive-classification-admin.js — which `admin_config` and
 * `admin_settings` documents the yearly archive keeps, one document id at a
 * time (archive-classification.js).
 *
 * Moved out of archive-classification.js without a change to what it
 * decides. That file still re-exports what it exported before, and its
 * fingerprint still covers the lists and the code here.
 */
import { freeze, REASONS } from './archive-classification-reasons.js';
import { keep } from './archive-classification-fields.js';

// ── admin_config: one document at a time (ADR 0046 deferred this list here) ──

/**
 * `admin_config` is one container that about seventy features keep a
 * document in. The archive keeps the ones that are settings or the owner's
 * own writing, and leaves out key records and short-lived state. Each id (or
 * id prefix) the code under `functions/src` writes is named below, once; the
 * test beside this file reads the source and fails when it finds an id that
 * is in neither list.
 *
 * A document whose id is on no list is LEFT OUT and counted as `unlisted` in
 * the dry-run report, so a real document the code no longer names shows up as
 * a number for the owner instead of slipping into the archive.
 */
export const ADMIN_CONFIG_KEEP = Object.freeze({
  ids: freeze([
    // Platform Settings (platform-settings.js): one document per setting.
    'default_heroes',
    'social_autopost',
    'podcast_feeds',
    'podcast_voices',
    'newsletter_settings',
    'content_taxonomy',
    'reminders',
    'listen_and_learn_speech',
    // The newsletter's From address (newsletter/sender.js): the site's own.
    'newsletter_sender',
    // Folder names of the image gallery (gallery-images.js).
    'gallery_folders',
    // The writing tool's voice profile and prompts (content/forge-studio/config.js).
    'forge_profile',
    'forge_prompts',
    // Running totals of the writing tool (content/forge.js): numbers only.
    'forge_stats',
    // The owner's calendar alerts (calendar-alerts/model.js).
    'calendar_alerts',
    // The subscriptions ledger: what the owner pays (cost/ledger-store.js). The owner's own.
    'cost_ledger',
    // The date each credential was last replaced, by name only, never a value (credentials/sources.js).
    'credential_register',
  ]),
  prefixes: Object.freeze([
    // The owner's status, costs and notes on one community event (community-days/notes.js).
    'community_days_event_',
  ]),
});

/** Left out of `admin_config`, with the reason. */
export const ADMIN_CONFIG_LEAVE_OUT = Object.freeze({
  ids: Object.freeze({
    // The agent keys' records: a hash of each key (agent-content/agent-keys.js,
    // one per key; a test holds this list to that one).
    'agent_content_key:koda': REASONS.secret,
    'agent_content_key:claude': REASONS.secret,
    // When each Key Vault secret was last written (admin-secrets.js): a picture of the vault on one day.
    secret_state: REASONS.workingState,
    // Coder's last answers to the status token (labs/coder-status.js).
    coder_status_token: REASONS.workingState,
    // Reports the lab host and the lab checks write about themselves.
    coder_automation: REASONS.workingState,
    lab_certificates: REASONS.workingState,
    lab_canary: REASONS.workingState,
    lab_drift: REASONS.workingState,
    host_checks: REASONS.workingState,
    swa_reset: REASONS.workingState,
    // Health results (health/probe-results.js, health/pulse.js).
    health_pulse: REASONS.workingState,
    // Copies of what an outside service answered, refilled on a timer or a press.
    community_days_cache: REASONS.derived,
    cost_snapshot: REASONS.derived,
    podbean_host_overview: REASONS.derived,
    podcast_last_sample: REASONS.derived,
    search_console_snapshot: REASONS.derived,
    streamyard_onair: REASONS.derived,
    // Leases and watches: who is running what right now.
    search_console_lease: REASONS.workingState,
    delivery_monitor_watch: REASONS.workingState,
    // The writing tool's queue of web addresses, in its earlier single-document form.
    forge_queue: REASONS.workingState,
  }),
  prefixes: Object.freeze({
    // One record per key the site issued to an organizer: the key's hash,
    // the organizer's name and a contact note (developer-api/keys.js).
    'developer_api_key:': REASONS.secret,
    // One health result per probe (health/probe-results.js).
    'health_probe_result:': REASONS.workingState,
    // Podcast host statistics, one cached document per date range (podcast/host-stats.js).
    podbean_host_stats_: REASONS.derived,
    // One queued web address each, with who added it (content/forge-studio/queue.js).
    'forge_queue_item:': REASONS.workingState,
  }),
});

/**
 * The decision for one `admin_config` document id.
 * @param {unknown} id
 * @returns {{ keep: boolean, reason: string|null }}
 */
export function adminConfigDecision(id) {
  const name = typeof id === 'string' ? id : '';
  // Leave-out is read first: if an id were ever on both lists, it stays out.
  const reason = name ? leaveOutReason(ADMIN_CONFIG_LEAVE_OUT, name) : REASONS.unlisted;
  if (reason !== null) return { keep: false, reason };
  const kept = ADMIN_CONFIG_KEEP.ids.includes(name) || ADMIN_CONFIG_KEEP.prefixes.some((prefix) => name.startsWith(prefix));
  return kept ? { keep: true, reason: null } : { keep: false, reason: REASONS.unlisted };
}

/**
 * The reason a leave-out list gives for one document id, or null when the
 * list does not name it. The exact ids are read first, then the prefixes in
 * the order they are written.
 * @param {{ ids: Record<string, string>, prefixes: Record<string, string> }} list
 * @param {string} name
 * @returns {string|null}
 */
export function leaveOutReason(list, name) {
  if (Object.hasOwn(list.ids, name)) return list.ids[name];
  const match = Object.entries(list.prefixes).find(([prefix]) => name.startsWith(prefix));
  return match ? match[1] : null;
}

// ── admin_settings: one document at a time, like admin_config ───────────────

/**
 * `admin_settings` is another container several features keep one document
 * in. ADR 0046 said "phase 2 reads every document id before the first run";
 * this list is that reading, held to the code by the test beside this file.
 * A document whose id is on neither list is LEFT OUT and counted as
 * `unlisted`.
 *
 * `fields`, where an id has it, is the keep list for that one document: the
 * `integrations` document is saved by merging (admin-integrations.js), so a
 * copy carried over from the earlier site can hold fields today's writer
 * would refuse, and only the two it accepts are kept.
 */
export const ADMIN_SETTINGS_KEEP = Object.freeze({
  ids: Object.freeze({
    // Which AI features are on, and where each is placed (ai/ai-config.js).
    'ai-features': null,
    // Which model each task uses (ai/routing-table.js, ai/selection.js).
    'ai-routing': null,
    // Which commands the site's Telegram bot answers (telegram/bot.js): on/off switches.
    telegram_bot: null,
    // The owner's speaker id and speaker profile (admin-integrations.js INTEGRATIONS_SETTINGS_FIELDS).
    integrations: Object.freeze({ ...keep('scalar', ['id', 'sessionizeSpeakerId', 'updatedAt']), speakerProfile: 'nested' }),
  }),
  prefixes: Object.freeze([
    // One news source each: its name, web addresses and limits (rss/source-handlers.js).
    'blog-source-',
  ]),
});

/** Left out of `admin_settings`, with the reason. */
export const ADMIN_SETTINGS_LEAVE_OUT = Object.freeze({
  ids: Object.freeze({
    // Who first set the site up: an administrator's object id (admin-identity.js). Part of the access list.
    'bootstrap-state': REASONS.accessList,
    // The last result of each service's connection test, with who pressed
    // the button and the far end's error sentence (integrations/integration-status.js).
    'integration-status': REASONS.workingState,
    // The model list fetched from the providers on a timer (ai/model-catalog.js).
    'ai-model-catalog': REASONS.derived,
  }),
  prefixes: Object.freeze({
    // The last run of one news source (rss/source-run.js).
    'run-': REASONS.workingState,
  }),
});

/**
 * The decision for one `admin_settings` document id.
 * @param {unknown} id
 * @returns {{ keep: boolean, reason: string|null, fields: object|null }}
 */
export function adminSettingsDecision(id) {
  const name = typeof id === 'string' ? id : '';
  const out = (reason) => ({ keep: false, reason, fields: null });
  // Leave-out is read first, as for admin_config.
  const reason = name ? leaveOutReason(ADMIN_SETTINGS_LEAVE_OUT, name) : REASONS.unlisted;
  if (reason !== null) return out(reason);
  if (Object.hasOwn(ADMIN_SETTINGS_KEEP.ids, name)) {
    return { keep: true, reason: null, fields: ADMIN_SETTINGS_KEEP.ids[name] };
  }
  if (ADMIN_SETTINGS_KEEP.prefixes.some((prefix) => name.startsWith(prefix))) {
    return { keep: true, reason: null, fields: null };
  }
  return out(REASONS.unlisted);
}

// ── For the dry-run report: which settings document ─────────────────────────

/** What the report calls a document whose id the code does not name. */
export const OTHER_DOCUMENT = '(other)';

/**
 * A printable name for one document of `admin_config` or `admin_settings`,
 * so the dry-run report can say which settings document a field is in. Only
 * an id the keep lists above name is printed, as it is written there; an id
 * that matches a kept prefix prints as the prefix and `*` (what follows the
 * prefix can be an id); anything else is `(other)`. `null` for every other
 * container: their record ids are never printed.
 *
 * @param {string} container
 * @param {unknown} id
 * @returns {string|null}
 */
export function archiveDocumentLabel(container, id) {
  const lists = container === 'admin_config' ? { ids: ADMIN_CONFIG_KEEP.ids, prefixes: ADMIN_CONFIG_KEEP.prefixes } : container === 'admin_settings' ? { ids: Object.keys(ADMIN_SETTINGS_KEEP.ids), prefixes: ADMIN_SETTINGS_KEEP.prefixes } : null;
  if (!lists) return null;
  if (typeof id !== 'string' || !id) return OTHER_DOCUMENT;
  if (lists.ids.includes(id)) return id;
  const prefix = lists.prefixes.find((start) => id.startsWith(start));
  return prefix ? `${prefix}*` : OTHER_DOCUMENT;
}
