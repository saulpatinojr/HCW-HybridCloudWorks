/**
 * integration-settings.js — the integrations settings document
 * (lib/adminSettings.js): `admin_settings/integrations`, read and
 * merge-saved. admin-integrations.js re-exports the public names.
 *
 * Each handler body is a module-level function over `ctx` (guard, store, now,
 * uuid); the factory at the bottom only wires them.
 */
import { json, validBody } from '../http/admin-handler.js';
import { recordMutationAudit, AUDIT_TTL_SECONDS } from '../audit.js';
import { errorFacts } from '../http/error-response.js';

const SETTINGS_CONTAINER = 'admin_settings';
const SETTINGS_DOC_ID = 'integrations';
/**
 * The Change history row a settings save writes: the same action and shape
 * platform-settings.js uses (PLATFORM_SETTING_AUDIT_ACTION), with
 * `details.setting` naming this document, so the Platform Settings hub lists
 * the Sessionize speaker id beside every other setting (ADR 0033 Platform).
 */
export const INTEGRATIONS_SETTING_AUDIT_ACTION = 'platform_setting_updated';
export const INTEGRATIONS_SETTING_NAME = 'integrations';

export const INTEGRATIONS_SETTINGS_FIELDS = ['sessionizeSpeakerId', 'speakerProfile'];

/** GET /api/cms/settings — the integrations doc, {} when missing. */
async function getSettings(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const doc = await ctx.store.readDoc(SETTINGS_CONTAINER, SETTINGS_DOC_ID, SETTINGS_DOC_ID);
    return json(200, { success: true, settings: doc || {} });
  } catch (error) {
    context.error('getSettings failed:', errorFacts(error));
    return json(500, { error: 'Failed to get settings' });
  }
}

/**
 * The Sessionize speaker id is edited on the Integrations page but it is a
 * platform setting like any other, so its save joins the Platform Settings
 * Change history through the same `platform_setting_updated` row
 * platform-settings.js writes (ADR 0033 Platform). Best effort, like that
 * writer: the save has landed, and a failed audit row must not report it as
 * refused.
 */
async function auditSpeakerIdChange(ctx, { user, existing, updates, nowIso }, context) {
  const before = String(existing?.sessionizeSpeakerId ?? '').trim();
  const after = String(updates.sessionizeSpeakerId ?? '').trim();
  try {
    await ctx.store.upsertDoc('admin_audit_logs', {
      id: ctx.uuid(),
      action: INTEGRATIONS_SETTING_AUDIT_ACTION,
      userId: user?.oid || user?.sub || null,
      userName: user?.name || null,
      userEmail: user?.email || user?.preferred_username || null,
      timestamp: nowIso,
      ttl: AUDIT_TTL_SECONDS,
      // A public identifier (it is the Sessionize URL), so the value
      // itself is a choice the history can show.
      details: {
        setting: INTEGRATIONS_SETTING_NAME,
        sessionizeSpeakerId: after || null,
        changed: before !== after,
      },
      compliance: { schemaVersion: 2, appendOnly: true },
    });
  } catch (auditError) {
    context.warn?.(
      `putSettings saved but the audit row failed: ${errorFacts(auditError)}`
    );
  }
}

const HTTP_URL = /^https?:\/\//i;

/** Plain text, trimmed; a missing value becomes the empty string. */
const profileText = (raw) => ({ value: String(raw || '').trim() });

function cleanHeadshotUrl(raw) {
  const u = String(raw || '').trim();
  if (u && !HTTP_URL.test(u)) return { error: 'headshotUrl must be http(s) URL' };
  return { value: u || null };
}

/** Links without an http(s) url are dropped, not refused. */
function cleanProfileLinks(raw) {
  if (!Array.isArray(raw)) return { error: 'speakerProfile.links must be an array' };
  return {
    value: raw
      .filter((l) => l && typeof l === 'object' && HTTP_URL.test(String(l.url || '')))
      .map((l) => ({ label: String(l.label || l.url).trim(), url: String(l.url).trim() })),
  };
}

/** The speaker profile fields, in the order they are checked and written. */
const PROFILE_CLEANERS = [
  ['name', profileText],
  ['bio', profileText],
  ['headshotUrl', cleanHeadshotUrl],
  ['links', cleanProfileLinks],
];

/** The speaker profile as `{ value }`, or `{ error }` naming the first bad field. */
function cleanSpeakerProfile(raw) {
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
    return { error: 'speakerProfile must be an object' };
  }
  const profile = {};
  for (const [key, clean] of PROFILE_CLEANERS) {
    if (raw[key] === undefined) continue;
    const cleaned = clean(raw[key]);
    if (cleaned.error) return cleaned;
    profile[key] = cleaned.value;
  }
  return { value: profile };
}

function validateIntegrationsSettings(body) {
  const { id: _ignored, ...updates } = body;
  const unknown = Object.keys(updates).filter((key) => !INTEGRATIONS_SETTINGS_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { error: `Unknown field(s): ${unknown.join(', ')}` };
  }
  const clean = {};
  if (updates.sessionizeSpeakerId !== undefined) {
    clean.sessionizeSpeakerId = updates.sessionizeSpeakerId === null ? null : String(updates.sessionizeSpeakerId).trim();
  }
  if (updates.speakerProfile !== undefined) {
    const profile = cleanSpeakerProfile(updates.speakerProfile);
    if (profile.error) return { error: profile.error };
    clean.speakerProfile = profile.value;
  }
  return { updates: clean };
}

/**
 * One write of the settings document: a patch guarded by the ETag of the
 * read when there is one, or a create when the document is missing.
 */
function writeSettingsOnce(store, existing, fields) {
  if (!existing) {
    return store.upsertDoc(SETTINGS_CONTAINER, { id: SETTINGS_DOC_ID, ...fields });
  }
  return existing._etag
    ? store.patchDoc(SETTINGS_CONTAINER, SETTINGS_DOC_ID, fields, {
        ifMatch: existing._etag,
      })
    : store.patchDoc(SETTINGS_CONTAINER, SETTINGS_DOC_ID, fields);
}

/**
 * Merge `updates` into the settings document, reading it afresh before each
 * of up to three tries: a 412 or 409 means another save landed in between.
 * Answers the document as it was read before the winning write, and as saved.
 */
async function mergeSaveSettings(store, updates, nowIso) {
  for (let attempt = 0; ; attempt += 1) {
    const existing = await store.readDoc(SETTINGS_CONTAINER, SETTINGS_DOC_ID, SETTINGS_DOC_ID);
    const fields = { ...updates, updatedAt: nowIso };
    try {
      return { existing, settings: await writeSettingsOnce(store, existing, fields) };
    } catch (err) {
      if ((err?.code === 412 || err?.code === 409) && attempt < 2) continue;
      throw err;
    }
  }
}

/** The Change history row for a settings save; the speaker id has its own row shape. */
async function auditSettingsSave(ctx, { user, existing, settings, updates, nowIso }, context) {
  if (Object.prototype.hasOwnProperty.call(updates, 'sessionizeSpeakerId')) {
    await auditSpeakerIdChange(ctx, { user, existing, updates, nowIso }, context);
    return;
  }
  await recordMutationAudit(ctx.store, {
    action: INTEGRATIONS_SETTING_AUDIT_ACTION,
    actor: user,
    resource: `${SETTINGS_CONTAINER}:${SETTINGS_DOC_ID}`,
    before: existing,
    after: settings,
    details: { setting: INTEGRATIONS_SETTING_NAME, fields: Object.keys(updates) },
    now: ctx.now,
    uuid: ctx.uuid,
    context,
  });
}

/** PUT /api/cms/settings — merge-save (setDoc merge:true semantics). */
async function putSettings(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = validBody(await request.json().catch(() => null));
    if (!body || Object.keys(body).length === 0) {
      return json(400, { error: 'Body must be a non-empty JSON object' });
    }
    const checked = validateIntegrationsSettings(body);
    if (checked.error) return json(400, { error: checked.error });
    const { updates } = checked;
    const nowIso = ctx.now().toISOString();

    const { existing, settings } = await mergeSaveSettings(ctx.store, updates, nowIso);
    await auditSettingsSave(ctx, { user: auth.user, existing, settings, updates, nowIso }, context);
    return json(200, { success: true, settings });
  } catch (error) {
    context.error('putSettings failed:', errorFacts(error));
    return json(500, { error: 'Failed to save settings' });
  }
}

/** The settings routes, over the shared `ctx`. */
export function createIntegrationSettingsHandlers(ctx) {
  return {
    getSettings: (request, context) => getSettings(ctx, request, context),
    putSettings: (request, context) => putSettings(ctx, request, context),
  };
}
