/**
 * platform-settings.js — the Admin → Platform settings page's read and write
 * of six `admin_config` documents, three of which until now could only be
 * seeded by an operator holding a Cosmos data-plane role (#351, #352, and the
 * feed list from #348/#349):
 *
 *   default-heroes          → admin_config/default_heroes          read by triggers/ai-cover.js
 *   social-autopost         → admin_config/social_autopost         read by triggers/social-caption-trigger.js
 *   podcast-feeds           → admin_config/podcast_feeds           read by timers/podcasts.js
 *   (listen-and-learn-speech → admin_config/listen_and_learn_speech left this page with ADR 0034
 *                             slice 5, #860: the model is chosen under AI Engine → Tasks, and the
 *                             stored document is read once by lib/ai/ai-config.js as the migration's input)
 *   podcast-voices          → admin_config/podcast_voices          read by podcast/voice-settings.js, for
 *                             every podcast render (episodes and the live check, #725)
 *   newsletter-settings     → admin_config/newsletter_settings     read by lib/newsletter/admin-handlers.js
 *                             and lib/newsletter/issue.js (content: sections, window, intro)
 *                             and lib/newsletter/signup-config.js (the public signup box)
 *                             (to be edited from the Mailing List page, not Platform settings)
 *   reminders               → admin_config/reminders               read by timers/reminders.js, daily, which says
 *                             each dated reminder on Telegram (owner, 2026-10-06; lib/reminders/settings.js)
 *
 * Every write is normalized to EXACTLY the shape its consumer reads — the
 * whole point of a screen over a hand-seeded document is that the shape can
 * no longer drift from the code that reads it. Unknown keys are refused, not
 * dropped, so a typo in a hand-made request is a 400 rather than a document
 * that silently governs nothing. The podcast rows are validated with the
 * timer's own `isValidFeedEntry`, so a row this module accepts is a row the
 * timer will fetch.
 *
 * The write is a full replace: each document is owned entirely by this page,
 * so replacing it is also how a drifted document gets repaired. It is a
 * conditional replace (#946). The read hands the page the document's ETag,
 * the save sends it back as If-Match, and a document saved elsewhere in
 * between is a 412 that the page answers by reloading, never an overwrite. A
 * save that names no version may only create the document; replacing a stored
 * one without naming its version is a 428. The reminders sheet is the
 * exception, guarded by its own read instead (writeMerged).
 * Nothing here logs document contents; the audit row carries counts only.
 *
 * The same module reads those audit rows back for the page's Change history
 * tab (#571): `platform_setting_updated` rows, newest first, projected to who,
 * when, which setting and the recorded summary — never the email the row
 * also holds.
 */
import { ADMIN_CONFIG_PARTITION } from './cosmos-client.js';
import { authoredMessage, isAuthoredError, errorFacts } from './http/error-response.js';
import { sharedTemplateCache } from './newsletter/template-source.js';

import { isPlainObject } from './platform-setting-checks.js';

export { PlatformSettingValidationError } from './platform-setting-checks.js';
export {
  DEFAULT_SCHEDULE_DELAY_MINUTES,
  HERO_PROVIDERS,
  MAX_SCHEDULE_DELAY_MINUTES,
  PODCAST_PROVIDERS,
  SOCIAL_PROVIDERS,
  isAcceptableHeroUrl,
  normalizeDefaultHeroes,
  normalizePodcastFeeds,
  normalizePodcastVoices,
  normalizeSocialAutopost,
} from './platform-setting-media.js';
export { normalizeNewsletterSettings } from './platform-setting-newsletter.js';

import { hiddenReminderPrefixes, isHiddenReminderId } from './reminders/agent-visibility.js';
import {
  PLATFORM_SETTING_AUDIT_ACTION,
  auditDetailsForLog,
  getHistory,
  optionsFor,
  summarize,
} from './platform-setting-history.js';
import {
  MERGE_WRITE_ATTEMPTS,
  json,
  parseIfMatch,
  satisfiesIfMatch,
  settingChanged,
  writeConditional,
  tryWriteMerged,
} from './platform-setting-versions.js';
import { resolveSetting } from './platform-setting-catalogue.js';

export {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  PLATFORM_SETTING_AUDIT_ACTION,
  buildHistoryQuery,
  parseHistoryQuery,
  presentHistoryEntry,
} from './platform-setting-history.js';
export {
  MERGE_WRITE_ATTEMPTS,
  parseIfMatch,
  satisfiesIfMatch,
} from './platform-setting-versions.js';
export { PLATFORM_SETTINGS, PLATFORM_SETTING_NAMES, resolveSetting } from './platform-setting-catalogue.js';

const MAX_BODY_JSON = 60_000;

/** Keys this module writes beside the value; not part of the shape. */
const PRESENTATION_METADATA = new Set(['id', 'configScope', 'updatedAt', 'updatedBy']);
/** Cosmos's own fields, by exact name (the set jobs.js strips too). */
const COSMOS_SYSTEM_FIELDS = new Set(['_rid', '_self', '_etag', '_attachments', '_ts']);

/**
 * What a stored document looks like through this page: the normalized shape
 * when it normalizes, else the empty shape. A hand-seeded document that does
 * not validate is shown empty rather than failing the read — the page's job
 * is to let the owner write a good one, and the consumer will keep reading
 * whatever is there until they do. `stored` says which happened.
 */
export function presentSetting(name, doc) {
  const spec = resolveSetting(name);
  if (!spec) throw new Error(`Unknown platform setting: ${name}`);
  if (!doc) return { value: spec.empty(), exists: false, stored: null, updatedAt: null };
  const updatedAt = doc.updatedAt;
  // A null-prototype object, filled by defineProperty from the document's OWN
  // keys: a hand-seeded document carrying `__proto__` or `constructor` (a
  // JSON.parse'd document holds those as ordinary own keys) becomes an own
  // key here too — never a prototype write — and is then refused by the
  // normalizer as unknown, the same as any other key the shape does not name.
  // Only Cosmos's own system fields are stripped, by exact name; a stray
  // `_foo` is reported, not hidden.
  const candidate = Object.create(null);
  for (const key of Object.keys(doc)) {
    if (PRESENTATION_METADATA.has(key) || COSMOS_SYSTEM_FIELDS.has(key)) continue;
    Object.defineProperty(candidate, key, {
      value: doc[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  try {
    return {
      value: spec.normalize(candidate),
      exists: true,
      stored: 'valid',
      updatedAt: updatedAt ?? null,
    };
  } catch (error) {
    if (isAuthoredError(error)) {
      return {
        value: spec.empty(),
        exists: true,
        stored: 'invalid',
        updatedAt: updatedAt ?? null,
        problem: authoredMessage(error, 'The stored value no longer passes validation.'),
      };
    }
    throw error;
  }
}

/**
 * A PUT body as the value the setting stores, or the 400 refusing it: not a
 * JSON object (or past MAX_BODY_JSON), then whatever the spec's normalizer
 * refuses. Any other error the normalizer throws is the handler's 500.
 */
function normalizedSettingValue(spec, body) {
  if (!isPlainObject(body) || JSON.stringify(body).length > MAX_BODY_JSON) {
    return { error: json(400, { error: 'Body must be a JSON object' }) };
  }
  try {
    return { value: spec.normalize(body) };
  } catch (error) {
    if (isAuthoredError(error)) {
      return { error: json(400, { error: authoredMessage(error, 'The setting was refused.') }) };
    }
    throw error;
  }
}

/**
 * The Platform settings routes' handlers: read a setting, save it, and read
 * the change history.
 *
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function, replaceDocIfMatch: Function, createDoc: Function, queryDocs?: Function }} deps.store
 *        a setting with a merge (the reminders sheet) is written under the
 *        ETag of the read it was merged from; every other setting is written
 *        under the version the save's If-Match names (replaceDocIfMatch), or
 *        created when it names none (createDoc). No setting is upserted: an
 *        upsert is the unconditional overwrite #946 removed. upsertDoc writes
 *        the audit rows only.
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {{ select: Function }} [deps.templateCache] the newsletter template cache (template-source.js)
 * @returns {{ getHistory: Function, getSetting: Function, putSetting: Function }}
 */
export function createPlatformSettingsHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
  templateCache = sharedTemplateCache,
}) {
  const deps = { guard, store, now, uuid, templateCache };
  return {
    getHistory: (request, context) => getHistory(deps, request, context),

    /** GET /api/cms/platform-settings/{setting} */
    getSetting: (request, context) => getSetting(deps, request, context),

    /**
     * PUT /api/cms/platform-settings/{setting} — body is the value itself;
     * If-Match names the version it replaces (#946).
     */
    putSetting: (request, context) => putSetting(deps, request, context),
  };
}

/**
 * Save a setting whose value is decided from the stored document (the
 * reminders sheet: the timer's stamps and the credential register's rows
 * come from the stored copy). The write is guarded by the ETag of the read
 * it was merged from, so a sync or a timer stamp that lands in between is
 * never written over: a 412 (replaced since the read) or 409 (created since
 * an absent read) re-reads and re-merges, up to MERGE_WRITE_ATTEMPTS times,
 * then answers 409 (CodeRabbit, review of #1039).
 *
 * The page does not send If-Match here, and the read does not offer an ETag
 * for this setting: the writers expected between the page's load and its
 * save are the timer and the register sync, whose fields the merge keeps, so
 * a version check would refuse saves the merge makes safe (review of #910).
 * A caller that does name a version gets exactly that version or a 412,
 * with no re-read: a retry would apply the save to a version it did not
 * name (#946).
 *
 * @param {object} spec the setting's registry entry, with `merge`
 * @param {object} requested the normalized value the caller sent
 * @param {{ updatedAt: string, updatedBy: string|null }} meta
 * @param {string[]|null} tags the If-Match tags, or null for none
 * @returns {Promise<{ value: object } | { error: object }>} the value
 *   written, or the response refusing the save
 */
async function writeMerged({ store }, spec, requested, meta, tags) {
  const attempts = tags ? 1 : MERGE_WRITE_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const stored = await store.readDoc('admin_config', spec.docId, ADMIN_CONFIG_PARTITION);
    if (tags && !satisfiesIfMatch(tags, stored)) return { error: settingChanged() };
    let value;
    // A merge that refuses (the reminders sheet past its limit once the
    // register's rows are counted) is the caller's 400, like a
    // normalizer's refusal, never a 500.
    try {
      value = spec.merge(requested, stored);
    } catch (error) {
      if (isAuthoredError(error)) {
        return { error: json(400, { error: authoredMessage(error, 'The setting was refused.') }) };
      }
      throw error;
    }
    const doc = { id: spec.docId, configScope: ADMIN_CONFIG_PARTITION, ...value, ...meta };
    const outcome = await tryWriteMerged(store, doc, stored, tags);
    if (outcome.written) return { value };
    if (outcome.error) return outcome;
  }
  return {
    error: json(409, {
      error: 'This setting changed while it was being saved. Reload the page and save again.',
    }),
  };
}


async function audit({ store, now, uuid }, action, user, details) {
  await store.upsertDoc('admin_audit_logs', {
    id: uuid(),
    action,
    userId: user?.oid || user?.sub || null,
    // The display name, so the Change history tab can say who without
    // showing the email. Rows written before this field existed show the id.
    userName: user?.name || null,
    userEmail: user?.email || user?.preferred_username || null,
    timestamp: now().toISOString(),
    details,
  });
}


/**
 * The editor check and the setting the route names: `{ auth, name, spec }`,
 * or `{ response }` refusing (403 or 404).
 */
async function openSetting({ guard }, request) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return { response: auth.error };
  const name = String(request.params?.setting || '');
  const spec = resolveSetting(request.params?.setting);
  if (!spec) return { response: json(404, { error: 'Unknown platform setting' }) };
  return { auth, name, spec };
}

/**
 * Write a normalized value the way its setting is saved: merged with the
 * stored document, or conditional on the version the caller read.
 * `{ value, etag }` as written, or `{ error }` holding the refusal.
 */
async function saveSetting(deps, spec, { value, meta, tags }) {
  if (spec.merge) {
    const merged = await writeMerged(deps, spec, value, meta, tags);
    return merged.error ? merged : { value: merged.value, etag: null };
  }
  const result = await writeConditional(deps, spec, value, meta, tags);
  return result.error ? result : { value, etag: result.written?._etag ?? null };
}

/**
 * The reminders sheet as the agent key may see it: without the rows kept for
 * a Page whose switch is off on the key (reminders/agent-visibility.js). The
 * key cannot save the sheet, so the shorter list is never written back.
 */
async function hideRowsFromAgent(store, user, presented) {
  const hidden = await hiddenReminderPrefixes(store, user);
  if (!hidden.length || !Array.isArray(presented.value?.reminders)) return;
  presented.value = {
    ...presented.value,
    reminders: presented.value.reminders.filter((row) => !isHiddenReminderId(row?.id, hidden)),
  };
}

/** GET /api/cms/platform-settings/{setting} */
async function getSetting(deps, request, context) {
  // `history` has its own literal route, but the host's choice between a
  // literal and this template is not guaranteed (platform-settings-http.js),
  // so the segment reaches the history reader from here too. No setting
  // is named `history`.
  if (request.params?.setting === 'history') return getHistory(deps, request, context);
  const opened = await openSetting(deps, request);
  if (opened.response) return opened.response;
  const { name, spec, auth } = opened;
  const { store } = deps;
  try {
    const doc = await store.readDoc('admin_config', spec.docId, ADMIN_CONFIG_PARTITION);
    const presented = presentSetting(name, doc);
    if (name === 'reminders') await hideRowsFromAgent(store, auth.user, presented);
    // The version the page's save names in If-Match (#946): null when
    // nothing is stored (the save creates), and null for a merged setting,
    // whose save is guarded by its own read (writeMerged).
    const etag = spec.merge ? null : (doc?._etag ?? null);
    return json(
      200,
      {
        success: true,
        setting: name,
        ...presented,
        etag,
        ...optionsFor(spec),
      },
      etag
    );
  } catch (error) {
    context.error(`getPlatformSetting(${name}) failed:`, errorFacts(error));
    return json(500, { error: 'Failed to read platform setting' });
  }
}

/**
 * PUT /api/cms/platform-settings/{setting} — body is the value itself;
 * If-Match names the version it replaces (#946). Answers the stored value
 * and its new ETag, which the next save from the same page names; 412
 * when the named version is no longer stored, 428 when a stored document
 * would be replaced without naming one, `If-Match: *` included.
 */
async function putSetting(deps, request, context) {
  const opened = await openSetting(deps, request);
  if (opened.response) return opened.response;
  const { auth, name, spec } = opened;

  const parsed = normalizedSettingValue(spec, await request.json().catch(() => null));
  if (parsed.error) return parsed.error;
  let { value } = parsed;
  const tags = parseIfMatch(request.headers?.get?.('if-match'));

  try {
    const updatedAt = deps.now().toISOString();
    const meta = { updatedAt, updatedBy: auth.user?.oid || auth.user?.sub || null };
    const saved = await saveSetting(deps, spec, { value, meta, tags });
    if (saved.error) return saved.error;
    ({ value } = saved);
    const { etag } = saved;
    // A different newsletter template takes effect on the next preview,
    // not when the cached copy of the previous one expires.
    if (name === 'newsletter-settings') deps.templateCache.select(value.templateId);
    // Best effort, like forge-stats bumps: the setting is already saved,
    // so a failed audit row must not turn into a 500 that makes the page
    // report a failure (and the owner retry) for a write that took.
    const details = { setting: name, ...summarize(name, value) };
    try {
      await audit(deps, PLATFORM_SETTING_AUDIT_ACTION, auth.user, details);
    } catch (auditError) {
      context.warn?.(
        `putPlatformSetting(${name}) saved but the audit row failed (${JSON.stringify(auditDetailsForLog(details))}): ${errorFacts(auditError)}`
      );
    }
    return json(
      200,
      {
        success: true,
        setting: name,
        value,
        exists: true,
        stored: 'valid',
        updatedAt,
        etag,
        ...optionsFor(spec),
      },
      etag
    );
  } catch (error) {
    context.error(`putPlatformSetting(${name}) failed:`, errorFacts(error));
    return json(500, { error: 'Failed to save platform setting' });
  }
}
