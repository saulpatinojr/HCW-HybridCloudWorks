/**
 * ai-routing.js — the selection document, `admin_settings/ai-routing`
 * (lib/ai/selection.js, ADR 0034 §2, #858): the Priority list and each
 * task's mode and chain.
 *
 *   GET answers the version 2 document — a stored v1 document (ADR 0033 §4,
 *   `{ routes }`) migrated in memory from the three documents, nothing
 *   written, `migrated: true` saying so — beside the task catalogue and the
 *   provider list the page renders from.
 *
 *   PUT takes the v2 document `{ version: 2, global, tasks, updatedAt }`,
 *   validated whole (selection.js validateSelection, §6's "would have no
 *   model" rule judged over the catalogue the router reads), normalised and
 *   written; an `updatedAt` that is not the one the page read is a 409 and
 *   nothing is written (§6). The stored document is version 2 from the
 *   first save, after which the "Where AI is used" placements and the card
 *   pins no longer reach the router: they were migrated into this document
 *   at that moment, and the document is what the router reads.
 *
 * The v1 `{ routes }` body the Routing tab sent, and the `routes` view GET
 * answered for it, left with that tab (ADR 0034 slice 4, #859): the Tasks
 * tab reads and writes the v2 document and nothing else sends the v1 shape.
 *
 * Each handler body is a module-level function over `ctx` (guard, store, now,
 * aiConfigChanged, availableProviders); the factory at the bottom only
 * wires them. The resolver's answer per task is a separate read, ai-tasks.js.
 */
import {
  AI_FEATURES,
  DEFAULT_PROVIDER_ORDER,
  FEATURES_DOC_ID,
  PROVIDERS_CONTAINER,
  ROUTING_DOC_ID,
  SETTINGS_CONTAINER,
  resolveProviderOrder,
  selectionFrom,
} from '../ai/ai-config.js';
import {
  SELECTION_VERSION,
  isSelectionV2,
  normalizeSelection,
  validateSelection,
} from '../ai/selection.js';
import { readModelCatalog } from '../ai/model-catalog-doc.js';
import { actorName } from '../auth/actor-name.js';
import { json, validBody } from '../http/admin-handler.js';
import { errorFacts } from '../http/error-response.js';

const BODY_SHAPE =
  'Body must be a version 2 selection document { version: 2, global: { priority: [{ provider, model? }] }, tasks, updatedAt }';

/**
 * The model catalogue as the router reads it, so what a save judges eligible
 * is what a call will. A catalogue that cannot be read is null, as in the
 * config loader: the save then judges every model by the code table.
 */
async function readCatalogOrNull(ctx, context) {
  try {
    return await readModelCatalog({ store: ctx.store, now: ctx.now });
  } catch (error) {
    context?.error?.('putAiRouting: could not read the model catalogue:', errorFacts(error));
    return null;
  }
}

/** The three documents the current selection is derived from (a v1 store migrates in memory), and the catalogue. */
async function readCurrent(ctx, context) {
  const [stored, providers, features, catalog] = await Promise.all([
    ctx.store.readDoc(SETTINGS_CONTAINER, ROUTING_DOC_ID, ROUTING_DOC_ID),
    ctx.store.queryDocs(PROVIDERS_CONTAINER, 'SELECT * FROM c'),
    ctx.store.readDoc(SETTINGS_CONTAINER, FEATURES_DOC_ID, FEATURES_DOC_ID),
    readCatalogOrNull(ctx, context),
  ]);
  const cards = Array.isArray(providers) ? providers : [];
  return {
    stored,
    cards,
    catalog,
    selection: selectionFrom({ providers: cards, features: features || null, routing: stored || null }),
  };
}

/** The answer both verbs send: the v2 document. */
function answer(selection, extra = {}) {
  return { success: true, selection, updatedAt: selection.updatedAt, ...extra };
}

/**
 * GET /api/cms/ai-routing — the selection document (version 2). `migrated`
 * says the stored document is still v1 (or absent) and what is returned
 * was derived in memory. The task catalogue travels with the answer for the
 * same reason getAiFeatures sends it: one list, the server's.
 */
async function getAiRouting(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const { stored, selection } = await readCurrent(ctx, context);
    return json(
      200,
      answer(selection, {
        migrated: !isSelectionV2(stored),
        catalogue: AI_FEATURES,
        providers: DEFAULT_PROVIDER_ORDER,
      })
    );
  } catch (error) {
    context.error('getAiRouting failed:', errorFacts(error));
    return json(500, { error: 'Failed to read AI routing' });
  }
}

/**
 * What holds a key and is switched on, for the "would have no model" rule
 * (§6): the chat providers with a key and a switch, joined by the media
 * providers with a key, which have no switch (ADR 0034 slice 5, #860) —
 * the same union the router resolves with.
 */
function availabilityFor(ctx, cards) {
  const keyed = typeof ctx.availableProviders === 'function' ? ctx.availableProviders() : null;
  if (!Array.isArray(keyed)) return undefined;
  const media =
    typeof ctx.availableMediaProviders === 'function' ? ctx.availableMediaProviders() : [];
  return {
    keyed: [...keyed, ...media],
    enabled: [...resolveProviderOrder(cards, keyed).order, ...media],
  };
}

/**
 * The next document for a PUT body, or `{ status, body }` to answer with:
 * validated whole (§6) over the catalogue the router reads, so a save never
 * accepts a chain a call would turn away, and its `updatedAt` must be the
 * one the page read.
 */
function nextSelection(ctx, body, current) {
  const eligibility = { availability: availabilityFor(ctx, current.cards), catalog: current.catalog };
  const errors = validateSelection(body, eligibility);
  if (errors.length) return { status: 400, body: { error: errors[0], errors } };
  if ((body.updatedAt ?? null) !== (current.selection.updatedAt ?? null)) {
    return {
      status: 409,
      body: {
        error: 'The selection document changed since it was read; reload and apply the change again.',
        updatedAt: current.selection.updatedAt,
      },
    };
  }
  return { selection: normalizeSelection(body) };
}

/**
 * PUT /api/cms/ai-routing — the v2 document (header). Same role as the
 * feature switches.
 */
async function putAiRouting(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const body = validBody(await request.json().catch(() => null));
    if (!body) return json(400, { error: BODY_SHAPE });

    const current = await readCurrent(ctx, context);
    const next = nextSelection(ctx, body, current);
    if (next.status) return json(next.status, next.body);

    const nowIso = ctx.now().toISOString();
    const selection = {
      ...next.selection,
      updatedAt: nowIso,
      updatedBy: actorName(auth.user),
    };
    // A full replace rather than a patch: the stored v1 `routes` map has to
    // leave the document, not linger beside the v2 fields; the Cosmos
    // system fields of the stored document are kept.
    const base = { ...(current.stored || {}) };
    delete base.routes;
    await ctx.store.upsertDoc(SETTINGS_CONTAINER, {
      ...base,
      id: ROUTING_DOC_ID,
      version: SELECTION_VERSION,
      ...selection,
    });
    ctx.aiConfigChanged();
    return json(200, answer(selection));
  } catch (error) {
    context.error('putAiRouting failed:', errorFacts(error));
    return json(500, { error: 'Failed to save AI routing' });
  }
}

/**
 * @param {{ guard: object, store: object, now: () => Date, aiConfigChanged: () => void,
 *           availableProviders?: () => string[] }} ctx
 */
export function createAiRoutingHandlers(ctx) {
  return {
    getAiRouting: (request, context) => getAiRouting(ctx, request, context),
    putAiRouting: (request, context) => putAiRouting(ctx, request, context),
  };
}
