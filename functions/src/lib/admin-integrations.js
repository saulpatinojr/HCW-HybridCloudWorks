/**
 * Admin integrations CRUD — recordings, speaker events, settings, image
 * gallery reads, AI providers / MCP servers, AI feature switches and routing,
 * and usage records (api-surface adminReads + the remaining adminWrites
 * slices).
 *
 * No backend source to port: these mirror the browser call sites —
 * RecordingsPage.jsx, SpeakingEventsPage.jsx, lib/adminSettings.js,
 * lib/imageGallery.js, lib/aiEngine.js — behind the editor role guard.
 *
 * Semantics worth naming:
 *   - ai_providers / mcp_servers use CLIENT-CHOSEN ids (`setDoc(doc(db, col,
 *     p.id))` with seed ids like 'vertex', 'replicate-mcp'), so PUT upserts
 *     at the route id — unlike the addDoc-style collections where the server
 *     mints the id. (./admin-integrations/config-collections.js)
 *   - mcp_servers documents can carry an OAuth token (setMcpOAuthToken). The
 *     aiEngine comment says the browser never reads it back and relied on
 *     rules to someday block it; here list/get responses actually strip
 *     `oauthToken` — writes accept it, reads never return it.
 *   - The settings doc (admin_settings/integrations) is a MERGE-save
 *     (`setDoc(..., { merge: true })`): patch when it exists, create when it
 *     doesn't — a replace would drop unrelated settings fields.
 *   - Every list sorts in memory (createdAt / order / timestamp) — Cosmos
 *     ORDER BY drops docs missing the property, the trap documented in
 *     public-reads.js.
 *
 * The AI configuration routes live one concern per module under
 * ./admin-integrations/ — ai-features.js, ai-routing.js,
 * config-collections.js — and this module composes them with the handlers
 * kept here, so admin-integrations-http.js and every test import exactly what
 * they always did. Each handler body is a module-level function over `ctx`
 * (guard, store, now, uuid, aiConfigChanged); the factory only wires them.
 */
import { randomUUID } from 'node:crypto';
import {
  buildGalleryListing,
  CONTENT_USAGE_PROJECTION,
  GALLERY_MAX_LIMIT,
  parseGalleryListParams,
} from './gallery-images.js';
import { json, LIST_WINDOW, listAllHandler, validBody } from './http/admin-handler.js';
import { recordMutationAudit, AUDIT_TTL_SECONDS } from './audit.js';
import { createAiFeatureHandlers } from './admin-integrations/ai-features.js';
import { createAiRoutingHandlers } from './admin-integrations/ai-routing.js';
import { createAiTaskHandlers } from './admin-integrations/ai-tasks.js';
import { createConfigCollectionHandlers } from './admin-integrations/config-collections.js';

const dateValue = (v) => {
  if (!v) return 0;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

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

// ── recordings (RecordingsPage.jsx) ──────────────────────────────────────────

/** GET /api/cms/recordings — local library, newest first. */
async function listRecordings(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const limit = Math.min(Math.max(Number(request.query.get('limit')) || 100, 1), 500);
    const items = await ctx.store.queryDocs('recordings', `SELECT TOP ${LIST_WINDOW} * FROM c`, []);
    const sorted = items
      .sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt))
      .slice(0, limit);
    return json(200, {
      success: true,
      items: sorted,
      total: sorted.length,
    });
  } catch (error) {
    context.error('listRecordings failed:', error);
    return json(500, { error: 'Failed to list recordings' });
  }
}

/**
 * What `POST cms/recordings` accepts. #1181 (AP-B6) introduced the allowlist
 * and left out four keys the only two callers send on every save, so both
 * Recording Hub forms answered 400 from that deploy on: "route a Plaud
 * recording" (`recording-hub/recordingCards.jsx`: `recordedAt`, `source`,
 * `plaudId`, `status`) and the pasted-transcript form
 * (`recording-hub/uploadForms.jsx`: `source`, `status`). `source` is a real
 * field the hub renders (`recordingView.js` `sourceLabel`). Each is typed
 * below; `status` is accepted only as `new`, the value the server stamps
 * anyway, so the body still cannot choose a recording's state.
 */
export const RECORDING_CREATE_FIELDS = [
  'title',
  'transcript',
  'url',
  'summary',
  'audioUrl',
  'duration',
  'topics',
  'speakers',
  'metadata',
  'source',
  'plaudId',
  'recordedAt',
  'status',
];

/** The two ways an admin puts a recording into the container (`sourceLabel` names both). */
export const RECORDING_CREATE_SOURCES = ['plaud_mcp', 'manual_upload'];

/** A Plaud file id is an opaque short string; anything longer is not one. */
export const RECORDING_PLAUD_ID_MAX = 200;

const RECORDED_AT_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * `recordedAt` as an ISO string, or null when it is not a real moment.
 *
 * `new Date()` alone is not a validator: it rolls `2026-02-30` over to
 * 2 March, and it reads a time with no zone in the host's own zone, so the
 * same Plaud timestamp would be stored differently on a workstation and on
 * the Function App. So a string must be an ISO date, optionally with a time
 * and a zone, whose day exists in its month (checked before parsing) and
 * whose clock fields are in range; a time with no zone is read as UTC, the
 * zone every other stamp in this container uses. Epoch milliseconds are
 * accepted as a finite number.
 */
export function normaliseRecordedAt(raw) {
  if (typeof raw === 'number') {
    const when = new Date(raw);
    return Number.isFinite(raw) && !Number.isNaN(when.getTime()) ? when.toISOString() : null;
  }
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const match = RECORDED_AT_SHAPE.exec(value);
  if (!match) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  const when = new Date(zone ? value.replace(' ', 'T') : `${value.replace(' ', 'T')}${match[4] ? '' : 'T00:00'}Z`);
  return Number.isNaN(when.getTime()) ? null : when.toISOString();
}

export const RECORDING_PATCH_FIELDS = [
  'title',
  'transcript',
  'url',
  'summary',
  'audioUrl',
  'duration',
  'topics',
  'speakers',
  'metadata',
  'status',
  'contentId',
];

export const RECORDING_STATUSES = ['new', 'processing', 'routed', 'failed', 'archived'];

export const INTEGRATIONS_SETTINGS_FIELDS = ['sessionizeSpeakerId', 'speakerProfile'];

function validateRecordingCreate(body) {
  const unknown = Object.keys(body).filter((key) => !RECORDING_CREATE_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { error: `Unknown field(s): ${unknown.join(', ')}` };
  }
  const title = String(body.title || '').trim();
  const transcript = String(body.transcript || '').trim();
  if (!title || !transcript) {
    return { error: 'title and transcript are required' };
  }
  const doc = { title, transcript };
  if (body.url !== undefined) {
    if (body.url !== null && !/^https?:\/\//i.test(String(body.url).trim())) {
      return { error: 'url must be http(s) URL' };
    }
    doc.url = body.url ? String(body.url).trim() : null;
  }
  if (body.audioUrl !== undefined) {
    if (body.audioUrl !== null && !/^https?:\/\//i.test(String(body.audioUrl).trim())) {
      return { error: 'audioUrl must be http(s) URL' };
    }
    doc.audioUrl = body.audioUrl ? String(body.audioUrl).trim() : null;
  }
  if (body.summary !== undefined) doc.summary = String(body.summary || '').trim();
  if (body.duration !== undefined) {
    const d = Number(body.duration);
    if (!Number.isFinite(d) || d < 0) return { error: 'duration must be a non-negative number' };
    doc.duration = d;
  }
  if (body.topics !== undefined) {
    if (!Array.isArray(body.topics) || body.topics.some((t) => typeof t !== 'string')) {
      return { error: 'topics must be an array of strings' };
    }
    doc.topics = body.topics;
  }
  if (body.speakers !== undefined) {
    if (!Array.isArray(body.speakers) || body.speakers.some((s) => typeof s !== 'string')) {
      return { error: 'speakers must be an array of strings' };
    }
    doc.speakers = body.speakers;
  }
  if (body.metadata !== undefined) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata) || body.metadata === null) {
      return { error: 'metadata must be an object' };
    }
    doc.metadata = body.metadata;
  }
  // The body may say `new`, because both forms do; it may not say anything
  // else. The handler stamps `status: 'new'` whatever arrives.
  if (body.status !== undefined && body.status !== 'new') {
    return { error: "status on create must be 'new'" };
  }
  if (body.source !== undefined) {
    if (!RECORDING_CREATE_SOURCES.includes(body.source)) {
      return { error: `source must be one of: ${RECORDING_CREATE_SOURCES.join(', ')}` };
    }
    doc.source = body.source;
  }
  if (body.plaudId !== undefined) {
    const plaudId = typeof body.plaudId === 'string' ? body.plaudId.trim() : '';
    if (!plaudId || plaudId.length > RECORDING_PLAUD_ID_MAX) {
      return { error: `plaudId must be a non-empty string of at most ${RECORDING_PLAUD_ID_MAX} characters` };
    }
    doc.plaudId = plaudId;
  }
  if (body.recordedAt !== undefined && body.recordedAt !== null) {
    // Plaud reports start_at / created_at; stored as ISO, like createdAt.
    const recordedAt = normaliseRecordedAt(body.recordedAt);
    if (!recordedAt) {
      return { error: 'recordedAt must be an ISO date string or epoch milliseconds' };
    }
    doc.recordedAt = recordedAt;
  }
  return { doc };
}

function validateRecordingPatch(body) {
  const { id: _ignored, ...updates } = body;
  const unknown = Object.keys(updates).filter((key) => !RECORDING_PATCH_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { error: `Unknown field(s): ${unknown.join(', ')}` };
  }
  if (Object.keys(updates).length === 0) {
    return { error: 'Body must contain at least one updatable field' };
  }
  const clean = {};
  if (updates.status !== undefined) {
    if (!RECORDING_STATUSES.includes(updates.status)) {
      return { error: `status must be one of: ${RECORDING_STATUSES.join(', ')}` };
    }
    clean.status = updates.status;
  }
  if (updates.contentId !== undefined) {
    clean.contentId = updates.contentId === null ? null : String(updates.contentId).trim();
  }
  if (updates.title !== undefined) {
    const title = String(updates.title || '').trim();
    if (!title) return { error: 'title cannot be empty' };
    clean.title = title;
  }
  if (updates.transcript !== undefined) {
    const transcript = String(updates.transcript || '').trim();
    if (!transcript) return { error: 'transcript cannot be empty' };
    clean.transcript = transcript;
  }
  if (updates.url !== undefined) {
    if (updates.url !== null && !/^https?:\/\//i.test(String(updates.url).trim())) {
      return { error: 'url must be http(s) URL' };
    }
    clean.url = updates.url ? String(updates.url).trim() : null;
  }
  if (updates.audioUrl !== undefined) {
    if (updates.audioUrl !== null && !/^https?:\/\//i.test(String(updates.audioUrl).trim())) {
      return { error: 'audioUrl must be http(s) URL' };
    }
    clean.audioUrl = updates.audioUrl ? String(updates.audioUrl).trim() : null;
  }
  if (updates.summary !== undefined) clean.summary = String(updates.summary || '').trim();
  if (updates.duration !== undefined) {
    const d = Number(updates.duration);
    if (!Number.isFinite(d) || d < 0) return { error: 'duration must be a non-negative number' };
    clean.duration = d;
  }
  if (updates.topics !== undefined) {
    if (!Array.isArray(updates.topics) || updates.topics.some((t) => typeof t !== 'string')) {
      return { error: 'topics must be an array of strings' };
    }
    clean.topics = updates.topics;
  }
  if (updates.speakers !== undefined) {
    if (!Array.isArray(updates.speakers) || updates.speakers.some((s) => typeof s !== 'string')) {
      return { error: 'speakers must be an array of strings' };
    }
    clean.speakers = updates.speakers;
  }
  if (updates.metadata !== undefined) {
    if (typeof updates.metadata !== 'object' || Array.isArray(updates.metadata) || updates.metadata === null) {
      return { error: 'metadata must be an object' };
    }
    clean.metadata = updates.metadata;
  }
  return { updates: clean };
}

/** POST /api/cms/recordings — both page paths require title + transcript. */
async function createRecording(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = validBody(await request.json().catch(() => null));
    if (!body) return json(400, { error: 'Body must be a JSON object' });
    const checked = validateRecordingCreate(body);
    if (checked.error) return json(400, { error: checked.error });
    const doc = {
      ...checked.doc,
      id: ctx.uuid(),
      status: 'new',
      createdAt: ctx.now().toISOString(),
    };
    await ctx.store.upsertDoc('recordings', doc);
    await recordMutationAudit(ctx.store, {
      action: 'recording_created',
      actor: auth.user,
      resource: `recordings:${doc.id}`,
      before: null,
      after: doc,
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });
    return json(200, { success: true, id: doc.id, item: doc });
  } catch (error) {
    context.error('createRecording failed:', error);
    return json(500, { error: 'Failed to create recording' });
  }
}

/** Route id, non-empty body and the stored recording of a PATCH: `{ id, updates }` or `{ error }` holding the response. */
async function prepareRecordingPatch(store, request) {
  const id = String(request.params.id || '').trim();
  if (!id) return { error: json(400, { error: 'id required' }) };
  const body = validBody(await request.json().catch(() => null));
  if (!body || Object.keys(body).length === 0) {
    return { error: json(400, { error: 'Body must be a non-empty JSON object' }) };
  }
  const existing = await store.readDoc('recordings', id, id);
  if (!existing) return { error: json(404, { error: `recording ${id} not found` }) };
  const checked = validateRecordingPatch(body);
  if (checked.error) return { error: json(400, { error: checked.error }) };
  return { id, updates: checked.updates, existing };
}

/** PATCH /api/cms/recordings/{id} — routing updates (status, contentId). */
async function patchRecording(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const prepared = await prepareRecordingPatch(ctx.store, request);
    if (prepared.error) return prepared.error;
    const updated = await ctx.store.patchDoc('recordings', prepared.id, prepared.updates);
    await recordMutationAudit(ctx.store, {
      action: 'recording_updated',
      actor: auth.user,
      resource: `recordings:${prepared.id}`,
      before: prepared.existing,
      after: updated,
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });
    return json(200, { success: true, item: updated });
  } catch (error) {
    context.error('patchRecording failed:', error);
    return json(500, { error: 'Failed to update recording' });
  }
}

// ── settings (lib/adminSettings.js) ──────────────────────────────────────────

/** GET /api/cms/settings — the integrations doc, {} when missing. */
async function getSettings(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const doc = await ctx.store.readDoc(SETTINGS_CONTAINER, SETTINGS_DOC_ID, SETTINGS_DOC_ID);
    return json(200, { success: true, settings: doc || {} });
  } catch (error) {
    context.error('getSettings failed:', error);
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
      `putSettings saved but the audit row failed: ${auditError?.message || auditError}`
    );
  }
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
    if (typeof updates.speakerProfile !== 'object' || Array.isArray(updates.speakerProfile) || updates.speakerProfile === null) {
      return { error: 'speakerProfile must be an object' };
    }
    const profile = {};
    if (updates.speakerProfile.name !== undefined) profile.name = String(updates.speakerProfile.name || '').trim();
    if (updates.speakerProfile.bio !== undefined) profile.bio = String(updates.speakerProfile.bio || '').trim();
    if (updates.speakerProfile.headshotUrl !== undefined) {
      const u = String(updates.speakerProfile.headshotUrl || '').trim();
      if (u && !/^https?:\/\//i.test(u)) return { error: 'headshotUrl must be http(s) URL' };
      profile.headshotUrl = u || null;
    }
    if (updates.speakerProfile.links !== undefined) {
      if (!Array.isArray(updates.speakerProfile.links)) return { error: 'speakerProfile.links must be an array' };
      profile.links = updates.speakerProfile.links
        .filter((l) => l && typeof l === 'object' && /^https?:\/\//i.test(String(l.url || '')))
        .map((l) => ({ label: String(l.label || l.url).trim(), url: String(l.url).trim() }));
    }
    clean.speakerProfile = profile;
  }
  return { updates: clean };
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

    let settings;
    let existing;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      existing = await ctx.store.readDoc(SETTINGS_CONTAINER, SETTINGS_DOC_ID, SETTINGS_DOC_ID);
      const fields = { ...updates, updatedAt: nowIso };
      try {
        if (existing) {
          settings = existing._etag
            ? await ctx.store.patchDoc(SETTINGS_CONTAINER, SETTINGS_DOC_ID, fields, {
                ifMatch: existing._etag,
              })
            : await ctx.store.patchDoc(SETTINGS_CONTAINER, SETTINGS_DOC_ID, fields);
        } else {
          settings = await ctx.store.upsertDoc(SETTINGS_CONTAINER, { id: SETTINGS_DOC_ID, ...fields });
        }
        break;
      } catch (err) {
        if ((err?.code === 412 || err?.code === 409) && attempt < 2) continue;
        throw err;
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'sessionizeSpeakerId')) {
      await auditSpeakerIdChange(ctx, { user: auth.user, existing, updates, nowIso }, context);
    } else {
      await recordMutationAudit(ctx.store, {
        action: INTEGRATIONS_SETTING_AUDIT_ACTION,
        actor: auth.user,
        resource: `${SETTINGS_CONTAINER}:${SETTINGS_DOC_ID}`,
        before: existing,
        after: settings,
        details: { setting: INTEGRATIONS_SETTING_NAME, fields: Object.keys(updates) },
        now: ctx.now,
        uuid: ctx.uuid,
        context,
      });
    }
    return json(200, { success: true, settings });
  } catch (error) {
    context.error('putSettings failed:', error);
    return json(500, { error: 'Failed to save settings' });
  }
}

// ── image gallery reads (lib/imageGallery.js) ────────────────────────────────

/** The content documents using an image, when asked for; [] on a failed read. */
function contentUsageRows(ctx, params, context) {
  if (!params.usage) return Promise.resolve([]);
  return ctx.store
    .queryDocs(
      'content',
      `SELECT TOP 2000 ${CONTENT_USAGE_PROJECTION} FROM c WHERE NOT IS_DEFINED(c.softDeletedAt) AND (IS_DEFINED(c.heroImageUrl) OR IS_DEFINED(c.altCoverImage) OR IS_DEFINED(c.contentImageUrl) OR IS_DEFINED(c.coverImage) OR IS_DEFINED(c.aiImageUrls) OR IS_DEFINED(c.secondaryImageUrls))`,
      []
    )
    .catch((error) => {
      context.warn?.('listImages usage read failed:', error?.message);
      return [];
    });
}

/**
 * GET /api/cms/images — the media library listing (ADR 0033). Query:
 * q, folder, source, provider, slot, tag, set, contentId, articleId,
 * state (active|archived|trash|all), sort (newest|oldest|title|most-used),
 * offset, limit (≤200), usage=1 (attach the content documents using each
 * image). Filtering, sorting and paging live in
 * lib/gallery-images.js buildGalleryListing; this does the reads.
 *
 * The read window is ORDER BY c._ts DESC — `_ts` exists on every row
 * where `createdAt` does not (curated rows never had one), so the newest
 * thousand are what the window holds. Within it, rows sort by createdAt
 * with a curated row's generatedAt standing in.
 *
 * `curated` and `generated` are still returned, newest first, for the
 * editor's gallery and the Submit URLs preview gallery, which read them.
 */
async function listImages(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const params = parseGalleryListParams((key) => request.query.get(key));
    const where = params.articleId ? ' WHERE c.articleId = @articleId' : '';
    const parameters = params.articleId ? [{ name: '@articleId', value: params.articleId }] : [];
    const query = `SELECT TOP ${LIST_WINDOW} * FROM c${where} ORDER BY c._ts DESC`;
    const [curated, generated, content] = await Promise.all([
      ctx.store.queryDocs('curated_article_images', query, parameters),
      ctx.store.queryDocs('generated_content_images', query, parameters),
      contentUsageRows(ctx, params, context),
    ]);
    const listing = buildGalleryListing({ curated, generated, content }, params);
    // The compatibility arrays: every matching row of each collection,
    // newest first, capped at `limit`.
    const matching = buildGalleryListing(
      { curated, generated, content },
      { ...params, offset: 0, limit: GALLERY_MAX_LIMIT * 5 }
    ).items;
    return json(200, {
      success: true,
      ...listing,
      curated: matching
        .filter((item) => item.galleryCollection === 'curated_article_images')
        .slice(0, params.limit),
      generated: matching
        .filter((item) => item.galleryCollection === 'generated_content_images')
        .slice(0, params.limit),
    });
  } catch (error) {
    context.error('listImages failed:', error);
    return json(500, { error: 'Failed to list images' });
  }
}

/**
 * GET /api/cms/images/curated/{id} — single cache lookup for
 * useGenerateCuratedImages (was a direct curated_article_images getDoc).
 * Missing docs answer 200 with item:null — the hook treats absence as
 * "generate a new one", not an error.
 */
async function getCuratedImage(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const id = String(request.params.id || '').trim();
    if (!id) return json(400, { error: 'id required' });
    const doc = await ctx.store.readDoc('curated_article_images', id, id);
    return json(200, { success: true, item: doc || null });
  } catch (error) {
    context.error('getCuratedImage failed:', error);
    return json(500, { error: 'Failed to get curated image' });
  }
}

// ── usage records (aiEngine getUsageRecords) ─────────────────────────────────

/** GET /api/cms/ai-usage?limit=&since= — timestamp desc. */
async function listUsage(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const limit = Math.min(Math.max(Number(request.query.get('limit')) || 100, 1), 500);
    const since = String(request.query.get('since') || '').trim();

    // Newest first IN THE QUERY (ADR 0033): `TOP 1000` with no ORDER BY
    // returned an arbitrary thousand, so once the container held more
    // rows than that the newest calls could be the ones left out. Every
    // row carries `timestamp` (usage.js writes it), so the ORDER BY
    // drops nothing; the in-memory sort below stays as the tiebreak.
    let query = `SELECT TOP ${LIST_WINDOW} * FROM c`;
    const parameters = [];
    if (since) {
      if (Number.isNaN(new Date(since).getTime())) {
        return json(400, { error: 'since must be a valid date' });
      }
      query += ' WHERE c.timestamp >= @since';
      parameters.push({ name: '@since', value: since });
    }
    query += ' ORDER BY c.timestamp DESC';
    const rows = await ctx.store.queryDocs('ai_usage', query, parameters);
    const items = rows
      .sort((a, b) => dateValue(b.timestamp) - dateValue(a.timestamp))
      .slice(0, limit);
    return json(200, { success: true, items, total: items.length });
  } catch (error) {
    context.error('listUsage failed:', error);
    return json(500, { error: 'Failed to list usage records' });
  }
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, patchDoc: Function, deleteDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {() => void} [deps.onAiConfigChanged]
 * @param {() => string[]} [deps.availableProviders]
 * @param {() => Promise<object>} [deps.effectiveSelection]
 * @param {{ callProvider: Function, getCostEstimate: Function }} [deps.ai]
 * @param {() => number} [deps.clock]
 */
export function createAdminIntegrationHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  // Called after any write the AI router reads (providers, features,
  // routing), so the router's 60 s cache is dropped in THIS process and a
  // change applies on the next call rather than after the TTL (ADR 0033).
  // Other warm instances converge within the TTL, as before.
  onAiConfigChanged = () => {},
  // The providers holding a key (router.availableProviders), for the
  // selection document's "would have no model" rule (ADR 0034 §6, #858).
  // Omitted, that one rule is not checked on save.
  availableProviders = null,
  // The media providers holding a key (router.availableMediaProviders),
  // keyed-is-enabled, for the same rule (ADR 0034 slice 5, #860).
  availableMediaProviders = null,
  // The resolver's answer over the loaded configuration
  // (router.resolveEffectiveSelection) and the router's call, for the Tasks
  // tab's effective read and per-task Test (ADR 0034 slice 4, #859).
  // Omitted, those two routes answer 503.
  effectiveSelection = null,
  ai = null,
  clock = () => Date.now(),
}) {
  const aiConfigChanged = () => {
    try {
      onAiConfigChanged();
    } catch {
      // Invalidation is a convenience; the write already happened.
    }
  };
  const ctx = {
    guard,
    store,
    now,
    uuid,
    clock,
    aiConfigChanged,
    availableProviders,
    availableMediaProviders,
    effectiveSelection,
    ai,
  };

  return {
    listRecordings: (request, context) => listRecordings(ctx, request, context),
    createRecording: (request, context) => createRecording(ctx, request, context),
    patchRecording: (request, context) => patchRecording(ctx, request, context),
    /** GET /api/cms/speakerevents — writes stay on the upsert/delete RPCs. */
    listSpeakerEvents: listAllHandler(ctx, {
      container: 'speakerevents',
      name: 'listSpeakerEvents',
      failure: 'Failed to list speaker events',
    }),
    getSettings: (request, context) => getSettings(ctx, request, context),
    putSettings: (request, context) => putSettings(ctx, request, context),
    ...createAiFeatureHandlers(ctx),
    ...createAiRoutingHandlers(ctx),
    ...createAiTaskHandlers(ctx),
    listImages: (request, context) => listImages(ctx, request, context),
    getCuratedImage: (request, context) => getCuratedImage(ctx, request, context),
    ...createConfigCollectionHandlers(ctx),
    listUsage: (request, context) => listUsage(ctx, request, context),
  };
}
