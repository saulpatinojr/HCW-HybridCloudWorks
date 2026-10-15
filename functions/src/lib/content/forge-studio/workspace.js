/**
 * Forge Studio as a real workspace (ADR 0033 §7 slice 2): three editor-side
 * routes over a content document (PR #841 split of forge-studio.js):
 *   POST cms/forge/brief   — the creative brief, kind and idea origin saved
 *                            onto a draft the Drafts stage created
 *   POST cms/forge/assist  — one AI action over the draft text (outline,
 *                            expand, condense, rewrite, tone, title,
 *                            summary, metadata, social, claims), through the
 *                            router as feature `forgeAssist`, recorded on
 *                            the document's `activity[]` so AI-written text
 *                            is identifiable afterwards
 *   POST cms/forge/save    — the edited title, summary and body, under the
 *                            document's ETag, for a document the Drafts
 *                            routes no longer accept once the forge has
 *                            moved it to forge_ready or editing
 */
import { failureFields } from '../../http/error-response.js';
import { actorName, json } from './config.js';
import { briefHasSubstance, normalizeBrief, text } from './brief.js';
import { ASSIST_ACTIONS, parseAssistRequest, refuse, runAssist } from './assist.js';

export const MAX_ACTIVITY_ENTRIES = 200;
export const MAX_SAVE_BODY_CHARS = 400000;

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** One `activity[]` entry (ADR 0033): who did what, through which model. */
export function activityEntry({ at, actor, action, provider = null, model = null, details }) {
  return {
    at,
    actor,
    action,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(details ? { details } : {}),
  };
}

/** The document's activity list with one more entry, newest last, capped. */
export function appendActivity(current, entry) {
  const existing = Array.isArray(current) ? current : [];
  return [...existing, entry].slice(-MAX_ACTIVITY_ENTRIES);
}

/** A document the Studio may still write: not live, not past review. */
export function workspaceWriteRefusal(doc) {
  if (!doc) return { status: 404, error: 'Content not found.' };
  if (doc.Live === true)
    return {
      status: 409,
      error: 'This article is live; edit it from the Editor.',
    };
  const status = String(doc.contentStatus || '');
  if (status === 'published' || status === 'archived') {
    return {
      status: 409,
      error: `This article is ${status}; the Studio does not write to it.`,
    };
  }
  return null;
}

/** The content document a workspace write targets, or the refusal to answer with. */
async function loadTarget(store, body) {
  const contentId = String(body?.contentId || '').trim();
  if (!SAFE_ID.test(contentId)) return refuse(400, { ok: false, error: 'contentId required' });
  const doc = await store.readDoc('content', contentId, contentId);
  const refusal = workspaceWriteRefusal(doc);
  if (refusal) return refuse(refusal.status, { ok: false, error: refusal.error });
  return { contentId, doc };
}

async function recordActivity(store, doc, entry) {
  const activity = appendActivity(doc.activity, entry);
  await store.patchDoc('content', doc.id, { activity });
  return activity;
}

/** The fields a brief save writes onto the document. */
function briefUpdate({ brief, kind, ideaOrigin, stamp, actor, doc }) {
  return {
    forgeBrief: { ...brief, savedAt: stamp, savedBy: actor },
    type: brief.targetChannel,
    publishTarget: brief.targetChannel,
    ...(kind ? { kind } : {}),
    ...(ideaOrigin ? { ideaOrigin } : {}),
    activity: appendActivity(
      doc.activity,
      activityEntry({ at: stamp, actor, action: 'forge_brief_saved' })
    ),
    updatedAt: stamp,
    updatedBy: actor,
  };
}

/**
 * Write a normalised brief (and kind, idea origin) onto a document: the
 * route below and the forge-from-url job share it, so a brief carried on a
 * job lands exactly as one saved from the Brief tab. Resolves to
 * `{ update, written }`.
 */
export async function applyBrief(store, { doc, brief, kind = '', ideaOrigin = '', stamp, actor }) {
  const update = briefUpdate({
    brief,
    kind: text(kind, 60),
    ideaOrigin: text(ideaOrigin, 60),
    stamp,
    actor,
    doc,
  });
  const written = await store.patchDoc('content', doc.id, update);
  return { update, written };
}

/** POST cms/forge/brief — { contentId, brief, kind, ideaOrigin } */
async function saveBrief(ctx, body, auth, context) {
  const target = await loadTarget(ctx.store, body);
  if (target.error) return target.error;

  const brief = normalizeBrief(body?.brief);
  if (!briefHasSubstance(brief)) {
    return json(400, {
      ok: false,
      error: 'The brief needs an objective, a key message, an audience, a topic or a source.',
    });
  }
  const kind = text(body?.kind, 60);
  const ideaOrigin = text(body?.ideaOrigin, 60);
  const stamp = ctx.now().toISOString();
  const actor = actorName(auth.user);
  try {
    const { update, written } = await applyBrief(ctx.store, {
      doc: target.doc,
      brief,
      kind,
      ideaOrigin,
      stamp,
      actor,
    });
    return json(200, {
      ok: true,
      contentId: target.contentId,
      brief: update.forgeBrief,
      kind: kind || target.doc.kind || null,
      ideaOrigin: ideaOrigin || target.doc.ideaOrigin || null,
      etag: written?._etag || null,
    });
  } catch (error) {
    return json(502, failureFields(context, 'The brief could not be saved.', error));
  }
}

/** POST cms/forge/assist — { contentId, action, text, instruction?, tone? } */
async function assist(ctx, body, auth, context) {
  const parsed = parseAssistRequest(body);
  if (parsed.error) return parsed.error;
  const target = await loadTarget(ctx.store, body);
  if (target.error) return target.error;

  const { action, draft } = parsed;
  const ran = await runAssist(ctx.ai, { action, draft, body }, context);
  if (ran.error) return ran.error;
  const { result, served } = ran;
  const entry = activityEntry({
    at: ctx.now().toISOString(),
    actor: actorName(auth.user),
    action: 'forge_assist',
    provider: served.provider || null,
    model: served.model || null,
    details: { assist: action, chars: draft.length },
  });
  // Recording is part of the answer: AI-written text must be identifiable
  // afterwards, so a failure here is reported rather than swallowed.
  try {
    await recordActivity(ctx.store, target.doc, entry);
  } catch (error) {
    context?.error?.(`[forge/assist] activity write failed: ${error?.message || error}`);
    return json(502, {
      ok: false,
      error: 'The model answered but the activity record could not be written; nothing was kept.',
    });
  }
  return json(200, {
    ok: true,
    action,
    label: ASSIST_ACTIONS[action].label,
    result,
    provider: served.provider || null,
    model: served.model || null,
    activity: entry,
  });
}

/** The ETag and the edited fields of a save, or the 400 refusing it. */
function parseSaveRequest(body) {
  const etag = String(body?.etag || '');
  if (!etag) {
    return refuse(400, {
      ok: false,
      code: 'ETAG_REQUIRED',
      error:
        'etag is required: send the etag of the version you are looking at (reload the draft).',
    });
  }
  const markdown = String(body?.body ?? '');
  if (markdown.length > MAX_SAVE_BODY_CHARS) {
    return refuse(400, { ok: false, error: `body is over ${MAX_SAVE_BODY_CHARS} characters` });
  }
  return { etag, title: text(body?.title, 300), summary: text(body?.summary, 2000), markdown };
}

/** The fields a save writes: only what the body carried, plus the activity row. */
function saveUpdate(body, { title, summary, markdown }, { stamp, actor, doc }) {
  return {
    ...(title ? { Title: title } : {}),
    ...(body?.summary !== undefined ? { Summary: summary } : {}),
    ...(body?.body !== undefined ? { content: markdown, blogDraft: markdown } : {}),
    activity: appendActivity(
      doc.activity,
      activityEntry({ at: stamp, actor, action: 'forge_studio_saved' })
    ),
    updatedAt: stamp,
    updatedBy: actor,
  };
}

/** The patch under the ETag: `{ written }`, or the 412 CONFLICT / 502 to send. */
async function patchUnderEtag(store, contentId, update, etag, context) {
  try {
    return { written: await store.patchDoc('content', contentId, update, { ifMatch: etag }) };
  } catch (error) {
    if (error?.code === 412) {
      return refuse(412, {
        ok: false,
        code: 'CONFLICT',
        error:
          'This draft changed in another tab or on another device since you opened it. Nothing was saved; reload it to see the latest version.',
      });
    }
    return refuse(502, failureFields(context, 'The draft could not be saved.', error));
  }
}

/**
 * The version row every body save writes (content_versions): best-effort,
 * the save itself is already durable.
 */
function writeVersionRow(ctx, { target, parsed, body, stamp, actor }, context) {
  return ctx.store
    .upsertDoc('content_versions', {
      id: ctx.uuid(),
      contentId: target.contentId,
      title: parsed.title || target.doc.Title || target.doc.title || '',
      summary: body?.summary !== undefined ? parsed.summary : target.doc.Summary || '',
      draft: parsed.markdown,
      versionCreatedAt: stamp,
      versionCreatedBy: actor,
      versionReason: 'forge_studio_saved',
    })
    .catch((error) => context?.error?.(`[forge/save] version row failed: ${error?.message}`));
}

/** POST cms/forge/save — { contentId, etag, title?, summary?, body? } */
async function save(ctx, body, auth, context) {
  const target = await loadTarget(ctx.store, body);
  if (target.error) return target.error;
  const parsed = parseSaveRequest(body);
  if (parsed.error) return parsed.error;
  const stamp = ctx.now().toISOString();
  const actor = actorName(auth.user);
  const update = saveUpdate(body, parsed, { stamp, actor, doc: target.doc });
  const patched = await patchUnderEtag(ctx.store, target.contentId, update, parsed.etag, context);
  if (patched.error) return patched.error;
  if (body?.body !== undefined) {
    await writeVersionRow(ctx, { target, parsed, body, stamp, actor }, context);
  }
  const { written } = patched;
  return json(200, {
    ok: true,
    contentId: target.contentId,
    etag: written?._etag || null,
    title: written?.Title ?? parsed.title,
    summary: written?.Summary ?? parsed.summary,
    contentStatus: written?.contentStatus || target.doc.contentStatus || null,
    activity: update.activity,
  });
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, patchDoc: Function, upsertDoc: Function }} deps.store
 * @param {{ generateTextResponse: Function, generateJsonResponse: Function }} deps.ai
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createForgeWorkspaceHandlers({
  guard,
  store,
  ai,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
}) {
  const ctx = { store, ai, now, uuid };
  /** Editor role first, then the JSON body (null when unreadable), then the route. */
  const editorRoute = (route) => async (request, context) => {
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => null);
    return route(ctx, body, auth, context);
  };
  return {
    saveBrief: editorRoute(saveBrief),
    assist: editorRoute(assist),
    save: editorRoute(save),
  };
}
