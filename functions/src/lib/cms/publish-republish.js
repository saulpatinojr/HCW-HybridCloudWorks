/**
 * publish-republish.js — the two narrow republishes of the publish pipeline
 * (the re-host of inline images, and a new slug), and the best-effort writes
 * every publish shares: the slug probe, the forge stats and the version
 * snapshot. publish.js describes the pipeline and why each branch is narrow.
 *
 * Every function takes the pipeline's `deps` first:
 * `{ store, uuid, inlineImages, log }`.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { normalizePublishTarget } from './publish-targets.js';
import { buildInlineImageUpdate, findInlineImageUrls, resolveBodyFields } from './inline-images.js';
import {
  buildSlugPublishUpdate,
  evaluateSlugChange,
  normalizeSlugInput,
  publicUrlOf,
  querySlugHolders,
  resolveSlugPublishPath,
} from './publish-slugs.js';

/** The first value that is set (truthy), or `fallback`: what `a || b || fallback` gives. */
const firstSet = (values, fallback) => values.find(Boolean) || fallback;

/** Where a document was read from, if it says. */
export const sourceUrlOf = (contentData) =>
  contentData.sourceUrl || contentData.url || contentData['CD Url'] || null;

/** The stored target, with the type as the fallback; null when neither names one. */
const storedTargetOf = (contentData) =>
  normalizePublishTarget(contentData.publishTarget, contentData.type) || null;

const isPreconditionFailed = (error) => error?.code === 412 || error?.statusCode === 412;

/**
 * Patch the content document over the version that was read (ifMatch).
 * False when another write landed first (412): the caller skips, it does
 * not retry. Any other failure is thrown.
 */
export async function patchAsRead(store, contentId, contentUpdate, etag) {
  try {
    await store.patchDoc('content', contentId, contentUpdate, { ifMatch: etag });
    return true;
  } catch (error) {
    if (isPreconditionFailed(error)) return false;
    throw error;
  }
}

/**
 * The ids of every document holding `slug` in EITHER field, or null when the
 * probe could not answer. Run on every publish — a republish included, which
 * is the one that was missing (#400). The query itself is `querySlugHolders`
 * (publish-slugs.js), so there is one definition of "who holds this URL?".
 *
 * BOTH BRANCHES USE THIS WRAPPER — the publish path and the set-slug path
 * (`republishWithSlug`) — and it never throws, which is its whole job. A
 * lookup failure becomes null here, and that null is where the two paths
 * part company: `resolveSlug` reads it as "not established" and carries on,
 * `evaluateSlugChange` reads it as a refusal. So the strictness a set-slug
 * needs lives in `evaluateSlugChange`, NOT in a different probe.
 *
 * That distinction is worth stating exactly because an earlier revision of
 * this comment claimed the set-slug route did not wrap the probe at all —
 * true of a design that was abandoned, and untrue of the code beneath it.
 */
export async function slugHolders({ store }, slug) {
  try {
    return await querySlugHolders(store, slug);
  } catch {
    return null;
  }
}

export async function bumpForgeStats({ store }, formatKey) {
  try {
    const doc =
      (await store.readDoc('admin_config', 'forge_stats', ADMIN_CONFIG_PARTITION)) || {};
    const totals = { ...(doc.totals || {}) };
    totals.published = (totals.published || 0) + 1;
    const formats = { ...(doc.formats || {}) };
    formats[formatKey] = { ...(formats[formatKey] || {}) };
    formats[formatKey].published = (formats[formatKey].published || 0) + 1;
    if (doc.id) {
      await store.patchDoc(
        'admin_config',
        'forge_stats',
        { totals, formats },
        { partitionKey: ADMIN_CONFIG_PARTITION }
      );
    } else {
      await store.upsertDoc('admin_config', {
        id: 'forge_stats',
        configScope: ADMIN_CONFIG_PARTITION,
        totals,
        formats,
      });
    }
  } catch {
    // Stats are best-effort; a failed bump must not fail the publish.
  }
}

/** Who saved a version, by the first name the signed-in user carries. */
const versionAuthorOf = (user) => firstSet([user?.email, user?.preferred_username, user?.oid], 'system');

/** Version history is best-effort, exactly as the source: a failed row never fails the write it records. */
export async function snapshotVersion({ store, uuid }, { contentId, snapToSave, nowIso, params, versionReason }) {
  try {
    await store.upsertDoc('content_versions', {
      id: uuid(),
      contentId,
      title: snapToSave.Title || snapToSave.title || '',
      summary: snapToSave.Summary || snapToSave.summary || '',
      draft: firstSet([snapToSave.blogDraft, snapToSave.content, snapToSave.Content, snapToSave.postContent], ''),
      authorName: firstSet(
        [snapToSave.editorAuthor, snapToSave.siteAuthor, snapToSave.publishedByName, snapToSave.createdByName],
        ''
      ),
      tags: snapToSave.Tags || snapToSave.keyTopics || [],
      sidebarContent: snapToSave.sidebarContent || '',
      publishedDate: firstSet([snapToSave.publishedDate, snapToSave.datePublished, snapToSave['Published At']], ''),
      orderedImageUrls: snapToSave.contentImages || snapToSave.orderedImageUrls || [],
      versionCreatedAt: nowIso,
      versionCreatedBy: versionAuthorOf(params.user),
      versionReason,
    });
  } catch {
    // Best-effort, see above.
  }
}

/** Why a document cannot be re-hosted, or null when it can. */
function rehostRefusal(contentData, currentStatus, inlineImages) {
  if (currentStatus !== 'published') {
    return { error: `Only a published document can be re-hosted; status is '${currentStatus}'` };
  }
  if (typeof inlineImages !== 'function') {
    return { error: 'Inline image re-hosting is not configured on this deployment' };
  }
  const hasExternal = resolveBodyFields(contentData).some(
    (field) => findInlineImageUrls(contentData[field]).length > 0
  );
  if (!hasExternal) {
    return { skipped: true, reason: 'No third-party image URLs in the body fields' };
  }
  return null;
}

/**
 * The re-host-only republish (publish.js header, REHOST_IMAGES_REASON).
 * Reached from processPublishContent once the document is read and its
 * status has passed the one publishable table; from here on only a document
 * that is already published is accepted, because on anything else "re-host"
 * would be a first publish wearing a smaller name.
 *
 * The patch carries the rewritten body field(s), the `inlineImages` summary
 * and `updatedAt` — never contentStatus, Live, the slug, the URLs, the
 * dates, the quality reports or either trigger. Conditioned on the ETag
 * like the publish write; a lost race is a skip, not a retry.
 */
export async function rehostInlineImages(deps, { contentId, contentData, currentStatus, nowIso, params, versionReason }) {
  const { inlineImages, log } = deps;
  const refusal = rehostRefusal(contentData, currentStatus, inlineImages);
  if (refusal) return refusal;

  const update = await buildInlineImageUpdate({
    contentData,
    contentId,
    rehost: inlineImages,
    nowIso,
    log,
  });
  // Null here cannot mean "nothing to do" (checked above); it means the
  // rehoster threw whole and the step logged it. Say so instead of
  // reporting a re-host that did not happen.
  if (!update) {
    return { error: 'Re-hosting failed before any image was stored; see the function log' };
  }

  const contentUpdate = { ...update, updatedAt: nowIso };
  if (!(await patchAsRead(deps.store, contentId, contentUpdate, contentData._etag))) {
    return { skipped: true, reason: 'Content changed while re-hosting; not retried' };
  }

  await snapshotVersion(deps, {
    contentId,
    snapToSave: { ...contentData, ...contentUpdate },
    nowIso,
    params,
    versionReason,
  });

  const slug = contentData.slug || contentData.Slug || null;
  return {
    blogId: contentId,
    reused: true,
    rehosted: true,
    slug,
    curatedSubpagePath: contentData.curatedSubpagePath || null,
    expectedPublicUrl: publicUrlOf(contentData) || null,
    sourceUrl: sourceUrlOf(contentData),
    landingProvider: contentData.landingProvider || null,
    publishTarget: storedTargetOf(contentData),
    inlineImages: update.inlineImages,
  };
}

/**
 * Everything checked before a set-slug writes. Returns `{ refusal }`, or the
 * normalised `slug`, the probe's `decision` and the `curatedSubpagePath`.
 *
 * `params.slug` is the operator's raw input; it is normalised HERE, so the
 * value probed, the value written and the value reported are one string.
 */
async function slugChangePlan(deps, { contentId, contentData, currentStatus, params }) {
  if (currentStatus !== 'published') {
    return {
      refusal: {
        status: 409,
        error: `Only a published article can be given a new slug; status is '${currentStatus}'`,
      },
    };
  }

  const slug = normalizeSlugInput(params.slug);
  // slugHolders swallows a lookup failure into null, and evaluateSlugChange
  // reads null as a refusal — the strict half of the split documented on
  // both functions. An empty slug is refused before a probe is spent on it.
  const decision = evaluateSlugChange({
    contentData,
    contentId,
    slug,
    holders: slug ? await slugHolders(deps, slug) : [],
  });
  if (!decision.ok) return { refusal: decision };

  // NO PATH, NO WRITE. Owner decision on #412, 2026-09-07: this route exists
  // to make a live URL correct, so if it cannot compute the path it has not
  // done what it was asked, and writing the slug anyway leaves the state the
  // route was built to remove — a panel reporting a move beside a link still
  // pointing at the old URL, because `expectedPublicUrl` would fall back
  // through publicUrlOf to whatever stale publishedUrl the document carried.
  // A refusal of a well-formed request, so it takes the same 409 shape as
  // the held-slug refusal above rather than a 500, and it names what would
  // make the path determinable. Reasoning in full at resolveSlugPublishPath.
  const curatedSubpagePath = resolveSlugPublishPath({ contentData, slug });
  if (!curatedSubpagePath) {
    return {
      refusal: {
        status: 409,
        error:
          'Cannot determine the published path for this article, so nothing was changed. ' +
          'Give it a cloud provider (Aws, Azure, Gcp, Github, Terraform or Finops) or an ' +
          'existing curatedSubpagePath, then set the slug again.',
      },
    };
  }
  return { slug, decision, curatedSubpagePath };
}

/**
 * The set-slug republish (SET_SLUG_REASON in publish-pipeline.js — read the
 * constant's comment for why it is narrow and why it is stricter). Reached
 * from processPublishContent once the document is read and its status has
 * passed the one publishable table; from here only an already-published
 * document is accepted, because assigning a URL to anything else is a first
 * publish wearing a smaller name.
 *
 * ONE conditional patch carries the slug pair AND the four URL fields, so
 * there is no window in which an article holds a new slug at its old URL.
 * All four, not "whatever could be derived": the path is resolved and
 * REFUSED ON first (slugChangePlan), so by the time anything is written
 * there is one.
 */
export async function republishWithSlug(deps, { contentId, contentData, currentStatus, nowIso, params, versionReason }) {
  const plan = await slugChangePlan(deps, { contentId, contentData, currentStatus, params });
  if (plan.refusal) return plan.refusal;
  const { slug, decision } = plan;

  const update = buildSlugPublishUpdate({ contentData, slug });
  if (Object.keys(update).length === 0) {
    return {
      skipped: true,
      slug,
      reason: 'Already on that slug, and its URLs already match',
      curatedSubpagePath: contentData.curatedSubpagePath || null,
      expectedPublicUrl: publicUrlOf(contentData) || null,
    };
  }

  const contentUpdate = { ...update, updatedAt: nowIso };
  if (!(await patchAsRead(deps.store, contentId, contentUpdate, contentData._etag))) {
    return { skipped: true, reason: 'Content changed while setting the slug; not retried' };
  }

  await snapshotVersion(deps, {
    contentId,
    snapToSave: { ...contentData, ...contentUpdate },
    nowIso,
    params,
    versionReason,
  });

  const after = { ...contentData, ...contentUpdate };
  return {
    blogId: contentId,
    reused: true,
    // TWO DIFFERENT OUTCOMES, AND THE CALLER MUST BE ABLE TO TELL THEM APART.
    // `moved` is whether the slug the site actually routes on changed;
    // `fields` is what the patch wrote. They come apart on exactly the
    // articles this exists for: with `slug` already right and `Slug` still
    // holding the old value, or the URL fields never written, the write is a
    // REPAIR — real, and one of the situations the control is for — but
    // nothing moved. This used to report `slugChanged: true` for both, which
    // the panel rendered as `Moved from "x" to "x"`.
    moved: decision.from !== slug,
    fields: Object.keys(update),
    slug,
    previousSlug: decision.from,
    curatedSubpagePath: after.curatedSubpagePath || null,
    expectedPublicUrl: publicUrlOf(after) || null,
    sourceUrl: sourceUrlOf(contentData),
    landingProvider: contentData.landingProvider || null,
    publishTarget: storedTargetOf(contentData),
  };
}
