/**
 * ai-features.js — the AI feature switches of the admin integrations surface
 * (lib/ai/ai-config.js): `admin_settings/ai-features`.
 *
 * Until ADR 0034 slice 4 (#859) this document also carried the per-feature
 * provider placement (#701, `placement.<provider>.<feature>`). The router
 * stopped reading it in slice 3 — the selection document carries what a
 * placement said (migrate-selection.js) — and the page lost the control in
 * slice 4, so the PUT no longer takes it and the GET no longer answers it. A
 * stored `placement` field stays on the document untouched, as the
 * migration's input until the first v2 save.
 *
 * Each handler body is a module-level function over `ctx` (guard, store, now,
 * aiConfigChanged); the factory at the bottom only wires them.
 */
import { AI_FEATURES, FEATURE_NAMES, FEATURES_DOC_ID } from '../ai/ai-config.js';
import { json, validBody } from '../http/admin-handler.js';
import { errorFacts } from '../http/error-response.js';

const SETTINGS_CONTAINER = 'admin_settings';
/** Kept in step with the router's reader by ai-config.js exporting it. */
const AI_FEATURES_DOC_ID = FEATURES_DOC_ID;

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The body of a PUT, checked: `{ incoming }` or `{ error }`. An unknown name
 * is either a typo or a hand-made request, and silently storing it would
 * leave a switch in the document that governs nothing.
 */
function checkAiFeaturesBody(body) {
  const incoming = body?.features;
  if (!isPlainObject(incoming)) {
    return { error: 'Body must be { features: { <name>: boolean } }' };
  }
  const unknown = Object.keys(incoming).filter((name) => !FEATURE_NAMES.includes(name));
  if (unknown.length > 0) {
    return {
      error: `Unknown AI feature(s): ${unknown.join(', ')}. Known: ${FEATURE_NAMES.join(', ')}`,
    };
  }
  return { incoming };
}

/**
 * GET /api/cms/ai-features — which parts of the site may call a model.
 *
 * The catalogue travels with the answer so the portal renders its toggles
 * from the server's list rather than a copy of it. That copy is exactly how
 * the AI Engine page came to advertise Vertex as enabled and OpenAI as
 * deprecated while the router did the opposite — a second list nobody
 * updated. There is one list, and it is AI_FEATURES.
 */
async function getAiFeatures(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const doc = await ctx.store.readDoc(SETTINGS_CONTAINER, AI_FEATURES_DOC_ID, AI_FEATURES_DOC_ID);
    const stored = doc?.features || {};
    // Absent means on, the same rule the router applies. Resolving it here
    // means the UI renders real state instead of an empty object.
    const features = Object.fromEntries(
      FEATURE_NAMES.map((name) => [name, stored[name] !== false])
    );
    return json(200, { success: true, features, catalogue: AI_FEATURES });
  } catch (error) {
    context.error('getAiFeatures failed:', errorFacts(error));
    return json(500, { error: 'Failed to read AI feature settings' });
  }
}

/**
 * PUT /api/cms/ai-features — body { features: { <name>: boolean } }. Merges;
 * never replaces.
 */
async function putAiFeatures(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = validBody(await request.json().catch(() => null));
    const checked = checkAiFeaturesBody(body);
    if (checked.error) return json(400, { error: checked.error });

    // Stored as strict booleans. The router only treats an explicit false as
    // off, so a stray 0 or "false" would read as ON — coercing here means
    // the document cannot express that ambiguity in the first place.
    const features = Object.fromEntries(
      Object.entries(checked.incoming).map(([name, value]) => [name, value !== false])
    );

    const existing = await ctx.store.readDoc(
      SETTINGS_CONTAINER,
      AI_FEATURES_DOC_ID,
      AI_FEATURES_DOC_ID
    );
    const merged = { ...(existing?.features || {}), ...features };
    const fields = { features: merged, updatedAt: ctx.now().toISOString() };
    const saved = existing
      ? await ctx.store.patchDoc(SETTINGS_CONTAINER, AI_FEATURES_DOC_ID, fields)
      : await ctx.store.upsertDoc(SETTINGS_CONTAINER, { id: AI_FEATURES_DOC_ID, ...fields });
    const result = saved || { ...existing, ...fields };
    ctx.aiConfigChanged();
    return json(200, { success: true, features: result.features || merged });
  } catch (error) {
    context.error('putAiFeatures failed:', errorFacts(error));
    return json(500, { error: 'Failed to save AI feature settings' });
  }
}

/** @param {{ guard: object, store: object, now: () => Date, aiConfigChanged: () => void }} ctx */
export function createAiFeatureHandlers(ctx) {
  return {
    getAiFeatures: (request, context) => getAiFeatures(ctx, request, context),
    putAiFeatures: (request, context) => putAiFeatures(ctx, request, context),
  };
}
