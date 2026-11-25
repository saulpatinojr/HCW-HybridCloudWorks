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
 * The AI configuration routes, the recordings routes and the settings
 * document live one concern per module under ./admin-integrations/ —
 * ai-features.js, ai-routing.js, config-collections.js, recordings.js,
 * recording-rules.js, integration-settings.js — and this module composes them with the handlers
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
import { json, LIST_WINDOW, listAllHandler } from './http/admin-handler.js';
import { createAiFeatureHandlers } from './admin-integrations/ai-features.js';
import { createAiRoutingHandlers } from './admin-integrations/ai-routing.js';
import { createAiTaskHandlers } from './admin-integrations/ai-tasks.js';
import { createConfigCollectionHandlers } from './admin-integrations/config-collections.js';
import { createIntegrationSettingsHandlers } from './admin-integrations/integration-settings.js';
import { createRecordingHandlers, dateValue } from './admin-integrations/recordings.js';
import { errorFacts } from './http/error-response.js';

export {
  RECORDING_CREATE_FIELDS,
  RECORDING_CREATE_SOURCES,
  RECORDING_PATCH_FIELDS,
  RECORDING_PLAUD_ID_MAX,
  RECORDING_STATUSES,
  normaliseRecordedAt,
} from './admin-integrations/recording-rules.js';
export {
  INTEGRATIONS_SETTINGS_FIELDS,
  INTEGRATIONS_SETTING_AUDIT_ACTION,
  INTEGRATIONS_SETTING_NAME,
} from './admin-integrations/integration-settings.js';

// ── recordings (RecordingsPage.jsx) ──────────────────────────────────────────

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
      context.warn?.('listImages usage read failed:', errorFacts(error));
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
    context.error('listImages failed:', errorFacts(error));
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
    context.error('getCuratedImage failed:', errorFacts(error));
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
    context.error('listUsage failed:', errorFacts(error));
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
    ...createRecordingHandlers(ctx),
    /** GET /api/cms/speakerevents — writes stay on the upsert/delete RPCs. */
    listSpeakerEvents: listAllHandler(ctx, {
      container: 'speakerevents',
      name: 'listSpeakerEvents',
      failure: 'Failed to list speaker events',
    }),
    ...createIntegrationSettingsHandlers(ctx),
    ...createAiFeatureHandlers(ctx),
    ...createAiRoutingHandlers(ctx),
    ...createAiTaskHandlers(ctx),
    listImages: (request, context) => listImages(ctx, request, context),
    getCuratedImage: (request, context) => getCuratedImage(ctx, request, context),
    ...createConfigCollectionHandlers(ctx),
    listUsage: (request, context) => listUsage(ctx, request, context),
  };
}
