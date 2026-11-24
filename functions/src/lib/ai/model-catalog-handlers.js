/**
 * model-catalog-handlers.js — the admin routes over the model catalogue
 * (ADR 0034 slice 2, #857): read it, hide or show one model, refresh it now.
 *
 * Editor-gated like `cms/ai-features` and `cms/ai-routing`. Each handler body
 * is a module-level function over `ctx` (guard, store, now, refresh,
 * aiConfigChanged); the factory at the bottom only wires them, the pattern of
 * lib/admin-integrations/ai-features.js.
 *
 * The model segment of the PATCH route is URL-encoded by the page because
 * NVIDIA's ids carry a slash (`z-ai/glm-5.3`). The host may hand the
 * segment over decoded or still encoded, so it is decoded here when it still
 * carries a percent escape; a segment that cannot be decoded is a 400.
 */
import { PROVIDERS } from './router.js';
import { readModelCatalog, setModelHidden } from './model-catalog.js';
import { json, validBody } from '../http/admin-handler.js';
import { errorFacts } from '../http/error-response.js';

/** The route's model segment as the catalogue keys it: `{ model }` or `{ error }`. */
export function decodeModelParam(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { error: 'model required' };
  if (!value.includes('%')) return { model: value };
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded ? { model: decoded } : { error: 'model required' };
  } catch {
    return { error: 'model is not a valid URL-encoded id' };
  }
}

/** GET /api/cms/ai-model-catalog — every provider's list, stale derived at read time. */
async function getModelCatalog(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const catalog = await readModelCatalog({ store: ctx.store, now: ctx.now });
    return json(200, { success: true, catalog });
  } catch (error) {
    context.error('getModelCatalog failed:', errorFacts(error));
    return json(500, { error: 'Failed to read the model catalogue' });
  }
}

/**
 * The PATCH route's inputs, validated: `{ provider, model, hidden }`, or
 * `{ error }` with the 400 sentence. The provider must be one the router
 * implements, the model id is URL-decoded (NVIDIA ids carry a `/`), and
 * the body is exactly `{ hidden: boolean }`.
 */
async function parsePatchRequest(request) {
  const provider = String(request.params.provider || '').trim();
  if (!PROVIDERS.includes(provider)) {
    return { error: `Unknown AI provider: ${provider}. Known: ${PROVIDERS.join(', ')}` };
  }
  const decoded = decodeModelParam(request.params.model);
  if (decoded.error) return { error: decoded.error };
  const body = validBody(await request.json().catch(() => null));
  if (!body || typeof body.hidden !== 'boolean') {
    return { error: 'Body must be { hidden: boolean }' };
  }
  return { provider, model: decoded.model, hidden: body.hidden };
}

/** PATCH /api/cms/ai-model-catalog/{provider}/{model} — body { hidden: boolean }. */
async function patchModelCatalogModel(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const change = await parsePatchRequest(request);
  if (change.error) return json(400, { error: change.error });
  const { provider } = change;
  try {
    const model = await setModelHidden({ store: ctx.store, now: ctx.now }, change);
    if (!model) {
      return json(404, { error: `${provider} has no model ${change.model} in the catalogue` });
    }
    ctx.aiConfigChanged();
    return json(200, { success: true, provider, model });
  } catch (error) {
    context.error('patchModelCatalogModel failed:', errorFacts(error));
    return json(500, { error: 'Failed to update the model catalogue' });
  }
}

/** POST /api/cms/ai-model-catalog/refresh — list every provider with a key now. */
async function refreshModelCatalogNow(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const summary = await ctx.refresh();
    ctx.aiConfigChanged();
    return json(200, { success: true, summary });
  } catch (error) {
    context.error('refreshModelCatalog failed:', errorFacts(error));
    return json(500, { error: 'Failed to refresh the model catalogue' });
  }
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function }} deps.store
 * @param {() => Promise<object>} deps.refresh   runs refreshModelCatalog for the keyed providers
 * @param {() => void} [deps.aiConfigChanged]
 * @param {() => Date} [deps.now]
 */
export function createModelCatalogHandlers({
  guard,
  store,
  refresh,
  aiConfigChanged = () => {},
  now = () => new Date(),
}) {
  const ctx = { guard, store, refresh, aiConfigChanged, now };
  return {
    getModelCatalog: (request, context) => getModelCatalog(ctx, request, context),
    patchModelCatalogModel: (request, context) => patchModelCatalogModel(ctx, request, context),
    refreshModelCatalog: (request, context) => refreshModelCatalogNow(ctx, request, context),
  };
}
