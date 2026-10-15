/**
 * The image-prompt HTTP handlers — the manageImagePromptConfig RPC (ported
 * from Site-Main cms-functions.js :5329-5507) plus the read/keyword endpoints
 * that replace useImagePrompts.js's direct Firestore access. Each handler is
 * a module-level function over `ctx` (`{ guard, store, now }`); the factory
 * only binds them (PR #841 split of image-prompts.js).
 */
import { errorResponse } from '../../http/error-response.js';
import {
  json,
  KEYWORD_COLLECTIONS,
  LIST_WINDOW,
  deleteIgnoringMissing,
  mergeSet,
  normalizePromptConfigKey,
} from './shared.js';
import { ADMIN_PROMPT_PAGE_ALLOWLIST, pagePathsForContent } from './pages.js';
import { promptTemplateVersionFor } from './sets.js';
import { loadKeywordMatrix } from './keywords.js';
import { composeSetPrompt, resolvePromptSetForContent } from './resolve.js';
import { CONFIG_ACTIONS } from './actions.js';

const IMAGE_PROJECTION =
  'c.id, c.imageUrl, c.title, c.slot, c.contentId, c.articleId, c.promptSet, c.promptSetId, ' +
  'c.promptName, c.promptTemplateVersion, c.approvalStatus, c.archivedAt, c.softDeletedAt, ' +
  'c.createdAt, c.generatedAt, c.imageModel, c.imageProvider, c.sourceCollection, c.width, c.height';

const MAX_KEY_LENGTH = 120;

const actor = (user) => user.email || user.preferred_username || user.oid || 'admin';

/** The normalised names a manageConfig body carries. */
function configRequest(body) {
  return {
    body,
    action: String(body.action || '').trim(),
    setName: normalizePromptConfigKey(body.setName),
    promptName: normalizePromptConfigKey(body.promptName),
    newSetName: normalizePromptConfigKey(body.newSetName),
  };
}

/** Why a manageConfig request cannot run, in the order the checks were made, or null. */
function configRefusal({ action, setName, promptName, newSetName }) {
  if (!action) return json(400, { error: 'action is required' });
  if ([setName, promptName, newSetName].some((name) => name.length > MAX_KEY_LENGTH)) {
    return json(400, { error: 'setName/promptName exceeds 120 characters' });
  }
  if (!Object.hasOwn(CONFIG_ACTIONS, action)) {
    return json(400, { error: `Unsupported action: ${action}` });
  }
  return null;
}

/** POST /api/manageImagePromptConfig — the five original actions plus the set-library ones. */
async function manageConfig(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const req = configRequest((await request.json().catch(() => null)) || {});
    const refusal = configRefusal(req);
    if (refusal) return refusal;
    return await CONFIG_ACTIONS[req.action](ctx, {
      ...req,
      nowIso: ctx.now().toISOString(),
      updatedBy: actor(auth.user),
    });
  } catch (error) {
    return errorResponse(context, 'Failed to manage image prompt config', error, 500, request);
  }
}

/** Every gallery row in `container` that carries set lineage, tagged with its container. */
const lineageRows = (store, container) =>
  store
    .queryDocs(
      container,
      `SELECT TOP ${LIST_WINDOW} ${IMAGE_PROJECTION} FROM c WHERE (IS_DEFINED(c.promptSet) AND c.promptSet != '') OR (IS_DEFINED(c.promptSetId) AND c.promptSetId != '')`,
      []
    )
    .then((rows) => rows.map((row) => ({ ...row, galleryCollection: container })))
    .catch(() => []);

/**
 * GET /api/cms/image-prompts — the whole config tree in one response,
 * plus `images`: every gallery row that carries set lineage, so the page
 * can show each set's generated images without a second read. The hook's
 * legacy-merge logic (findLegacySetByName etc.) stays client-side.
 */
async function getConfigTree({ guard, store }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const all = (container) => store.queryDocs(container, `SELECT TOP ${LIST_WINDOW} * FROM c`, []);
    const [pages, sets, prompts, legacyPages, legacySets, generated, curated] = await Promise.all([
      all('image_prompt_pages'),
      all('image_prompt_sets'),
      all('image_prompt_sets_prompts'),
      all('image_prompts'),
      all('image_prompts_sets'),
      lineageRows(store, 'generated_content_images'),
      lineageRows(store, 'curated_article_images'),
    ]);
    return json(200, {
      success: true,
      pages,
      sets,
      prompts,
      legacyPages,
      legacySets,
      images: [...generated, ...curated],
      allowedPages: [...ADMIN_PROMPT_PAGE_ALLOWLIST],
    });
  } catch (error) {
    context.error('getImagePromptConfig failed:', error);
    return json(500, { error: 'Failed to load image prompt config' });
  }
}

/**
 * What `resolveForContent` answers: the set and composed hero prompt a
 * document would generate with, or the `builtin` shape when no set applies.
 */
function resolutionBody(contentId, data, resolved, prompt) {
  const pagePaths = pagePathsForContent(data);
  if (!resolved) {
    return {
      success: true,
      contentId,
      setName: '',
      promptName: '',
      source: 'builtin',
      pagePaths,
      prompt: '',
    };
  }
  return {
    success: true,
    contentId,
    setName: resolved.set.name || resolved.set.id,
    promptName: resolved.prompt?.name || resolved.prompt?.id || '',
    promptTemplateVersion: promptTemplateVersionFor(resolved.set),
    source: resolved.source,
    pagePath: resolved.pagePath,
    pagePaths,
    prompt,
  };
}

/** The hero prompt a resolved set composes for a document, or '' for none. */
async function heroPromptFor(store, data, resolved, context) {
  if (!resolved) return '';
  return composeSetPrompt({
    set: resolved.set,
    prompt: resolved.prompt,
    slot: 'hero',
    article: data,
    keyword: await loadKeywordMatrix(store, context),
  });
}

/**
 * GET /api/cms/image-prompts/resolve?contentId= — which set a content
 * document would generate with today, and the prompt it would send for
 * the hero slot. The review board shows this beside "Generate AI Cover" so
 * the button's text can be true.
 */
async function resolveForContent({ guard, store }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const contentId = String(request.query.get('contentId') || '').trim();
    if (!contentId) return json(400, { error: 'contentId required' });
    const data = await store.readDoc('content', contentId, contentId);
    if (!data) return json(404, { error: `content ${contentId} not found` });
    const resolved = await resolvePromptSetForContent(store, data);
    const prompt = await heroPromptFor(store, data, resolved, context);
    return json(200, resolutionBody(contentId, data, resolved, prompt));
  } catch (error) {
    context.error('resolveImagePrompt failed:', error);
    return json(500, { error: 'Failed to resolve image prompt' });
  }
}

/** GET /api/cms/keyword-config — synonyms + augmentations, sorted. */
async function getKeywordConfig({ guard, store }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const [synonyms, augmentations] = await Promise.all([
      store.queryDocs('prompt_keyword_synonyms', `SELECT TOP ${LIST_WINDOW} * FROM c`, []),
      store.queryDocs('prompt_keyword_augmentations', `SELECT TOP ${LIST_WINDOW} * FROM c`, []),
    ]);
    synonyms.sort((a, b) => String(a.canonical || '').localeCompare(String(b.canonical || '')));
    augmentations.sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')));
    return json(200, { success: true, synonyms, augmentations });
  } catch (error) {
    context.error('getKeywordConfig failed:', error);
    return json(500, { error: 'Failed to load keyword config' });
  }
}

/**
 * The keyword container and document id a route names, or the response
 * refusing them: an unknown collection is a 404, a missing (or, with
 * `maxLength`, over-long) id the 400 carrying `idMessage`.
 */
function keywordTarget(request, { maxLength = Infinity, idMessage }) {
  const container = KEYWORD_COLLECTIONS[request.params.collection];
  if (!container) return { error: json(404, { error: 'Unknown keyword collection' }) };
  const id = normalizePromptConfigKey(request.params.id);
  if (!id || id.length > maxLength) return { error: json(400, { error: idMessage }) };
  return { container, id };
}

/** PUT /api/cms/keyword-config/{collection}/{id} — setDoc merge:true. */
async function putKeywordDoc({ guard, store, now }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const target = keywordTarget(request, {
    maxLength: MAX_KEY_LENGTH,
    idMessage: 'valid id required',
  });
  if (target.error) return target.error;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(400, { error: 'Body must be a JSON object' });
    }
    const { id: _ignored, ...fields } = body;
    const saved = await mergeSet(store, target.container, target.id, {
      ...fields,
      updatedAt: now().toISOString(),
    });
    return json(200, { success: true, item: saved });
  } catch (error) {
    context.error('putKeywordDoc failed:', error);
    return json(500, { error: 'Failed to save keyword doc' });
  }
}

/** DELETE /api/cms/keyword-config/{collection}/{id} */
async function deleteKeywordDoc({ guard, store }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const target = keywordTarget(request, { idMessage: 'id required' });
  if (target.error) return target.error;
  try {
    await deleteIgnoringMissing(store, target.container, target.id);
    return json(200, { success: true });
  } catch (error) {
    context.error('deleteKeywordDoc failed:', error);
    return json(500, { error: 'Failed to delete keyword doc' });
  }
}

const HANDLERS = Object.freeze({
  manageConfig,
  getConfigTree,
  resolveForContent,
  getKeywordConfig,
  putKeywordDoc,
  deleteKeywordDoc,
});

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, patchDoc: Function, deleteDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 */
export function createImagePromptHandlers({ guard, store, now = () => new Date() }) {
  const ctx = { guard, store, now };
  return Object.fromEntries(
    Object.entries(HANDLERS).map(([name, handler]) => [
      name,
      (request, context) => handler(ctx, request, context),
    ])
  );
}
