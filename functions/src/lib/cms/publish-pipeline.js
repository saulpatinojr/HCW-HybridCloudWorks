/**
 * publish-pipeline.js — one item through the publish pipeline: the read, the
 * status table, then a full publish or one of the two narrow republishes.
 * processPublishContent in publish.js runs it and turns any throw into an
 * authored sentence; publish.js's header describes the sequence.
 *
 * Every function takes the pipeline's `deps` first:
 * `{ store, now, uuid, inlineImages, log }`.
 */
import { buildContentQualityReport, buildImageReadinessReport } from './content-quality.js';
import { normalizePublishTarget } from './publish-targets.js';
import { articleSlugFor } from './article-topics.js';
import { isPublicDocument } from '../public-reads.js';
import { buildInlineImageUpdate } from './inline-images.js';
import {
  interviewBodyText,
  interviewPublishRefusal,
  isInterviewTarget,
} from '../interviews/publish-gate.js';
import { canPublishFromStatus, PUBLISHABLE_NORMALIZED_STATUSES } from './content-status.js';
import { normalizeCurrentStatusForBlogOnly } from './content-update-validation.js';
import { resolveCuratedSubpagePath, resolveSlug, slugify, toPublicUrl } from './publish-slugs.js';
import { applyPublishTimeCoverTrigger, resolvePublishContext, validatePublishMetadata } from './publish-steps.js';
import {
  bumpForgeStats,
  patchAsRead,
  rehostInlineImages,
  republishWithSlug,
  slugHolders,
  snapshotVersion,
  sourceUrlOf,
} from './publish-republish.js';

/**
 * `params.reason` value that turns processPublishContent into the narrow
 * re-host-only republish described in the module header. A string rather than
 * a boolean so a future narrow republish (a related-posts refresh, say) is a
 * second named reason and not a second flag that interacts with this one.
 */
export const REHOST_IMAGES_REASON = 'rehost-images';

/**
 * The second named reason the comment above anticipated (#400): give a
 * published article a NEW slug and let its URLs follow, writing nothing else.
 *
 * WHY IT IS NARROW, AND WHY THAT IS NOT A CONVENIENCE. A full republish of the
 * three articles on the contested URL does not merely do more than they need —
 * it FAILS. They arrived from Site-Main already published and have never been
 * through this pipeline's gates: the one still serving the URL scores 68
 * against a threshold of 82 (238 words, no inline modules) and carries no hero
 * image, so the quality gate refuses it and the image gate refuses it after
 * that. A set-slug built on the full path would therefore write a failed
 * quality report onto the article and leave its URL exactly as broken as it
 * found it. Re-litigating an article's body is not what correcting its URL is
 * for, and the article is already live either way.
 *
 * So this branch runs the probe and the two URL rules and nothing else: no
 * quality gate, no image gate, no cover or social trigger, no dates, no forge
 * stats, no Live rewrite, no status change. Like the re-host branch it shares
 * the read, the status table, the ETag precondition and the version snapshot.
 *
 * It is also STRICTER than a publish in the one place that matters. A publish
 * that finds a clash suffixes the slug and carries on, because refusing would
 * block a publish; a set-slug that finds one REFUSES, because the operator
 * asked for a specific URL and silently giving them a different one is how a
 * URL correction becomes the next URL surprise.
 */
export const SET_SLUG_REASON = 'set-slug';

/** The narrow republishes, by `params.reason`. */
const NARROW_REPUBLISHES = new Map([
  [REHOST_IMAGES_REASON, rehostInlineImages],
  [SET_SLUG_REASON, republishWithSlug],
]);

/**
 * Publish one document through every gate. Throws on an unexpected failure;
 * processPublishContent turns that into an authored sentence.
 */
export async function publishOne(deps, contentId, params) {
  const contentData = await deps.store.readDoc('content', contentId, contentId);
  // `status` rides along for the callers that answer HTTP directly about
  // ONE id (POST cms/content/slug). A missing document is a 404 there, and
  // without this it reached toSetSlugResponse's default and answered 500 —
  // telling an operator with a stale id that the server is broken. The
  // batch callers read `.error` alone (accumulatePublishResult,
  // toRehostResult, the scheduled publisher, the Telegram worker), so the
  // extra field changes nothing for them.
  if (!contentData) return { status: 404, error: 'Content not found' };

  const currentStatus = normalizeCurrentStatusForBlogOnly(
    contentData.contentStatus || 'ingested'
  );
  if (!canPublishFromStatus(currentStatus)) {
    return {
      error: `Cannot publish from status '${currentStatus}'. Allowed statuses: ${PUBLISHABLE_NORMALIZED_STATUSES.join(', ')}`,
    };
  }

  const nowIso = deps.now().toISOString();
  const narrow = NARROW_REPUBLISHES.get(params.reason);
  if (narrow) {
    return narrow(deps, { contentId, contentData, currentStatus, nowIso, params, versionReason: params.reason });
  }
  return fullPublish(deps, { contentId, contentData, currentStatus, nowIso, params });
}

/**
 * The interview rule and the two gates. Returns `{ refusal }` (a failed
 * gate's report is written onto the document first), or what the publish
 * needs: `params` (an interview publishes as one), `isInterview`, and the
 * two reports.
 */
async function publishGates(deps, { contentId, contentData, nowIso, params }) {
  const { store, now } = deps;
  // An interview publishes as an interview whatever target the request
  // named: the route's body defaults to `blog`, and a document whose
  // type is `interview` must not be judged by the blog rubric or land
  // under /azure/blog. Decided from the document, not the request.
  const isInterview =
    isInterviewTarget(contentData.type) || isInterviewTarget(contentData.publishTarget);
  const effectiveParams = isInterview ? { ...params, publishTarget: 'interview' } : params;
  const resolvedTarget = normalizePublishTarget(
    effectiveParams.publishTarget || contentData.publishTarget,
    contentData.type || contentData.contentType
  );
  // An interview is refused before the ordinary gates when its consent
  // record is missing or its Q&A fails the schema (ADR 0040, D5 and D9);
  // no bypass flag reaches past these two. The gates then read a copy
  // carrying the Q&A as one text, which is what the rubric counts.
  let gateData = contentData;
  if (isInterview) {
    const refusal = await interviewPublishRefusal(contentData, { now });
    if (refusal) return { refusal };
    gateData = { ...contentData, bodyText: interviewBodyText(contentData) };
  }
  const contentQuality = buildContentQualityReport(
    gateData,
    contentData.contentQuality?.critique,
    resolvedTarget
  );
  const imageReadiness = buildImageReadinessReport(gateData, resolvedTarget);
  if (!effectiveParams.forceQualityBypass && !contentQuality.ready) {
    await store.patchDoc('content', contentId, { contentQuality, updatedAt: nowIso });
    return {
      refusal: {
        error: `Content quality gate failed: ${contentQuality.issues.join('; ')}`,
        contentQuality,
      },
    };
  }
  if (!effectiveParams.forceImageBypass && !imageReadiness.ready) {
    await store.patchDoc('content', contentId, {
      imageReadiness,
      imageQuality: imageReadiness,
      updatedAt: nowIso,
    });
    return {
      refusal: {
        error: `Image readiness gate failed: ${imageReadiness.issues.join('; ')}`,
        imageReadiness,
      },
    };
  }
  return { params: effectiveParams, isInterview, contentQuality, imageReadiness };
}

/**
 * The slug this publish writes. A republish keeps the URL it already
 * serves; anything else is a first assignment. `slug || Slug` because
 * either field can be the one the manifest routed on — see slugHolders.
 */
async function publishSlug(deps, { contentId, contentData, isRepublish, provider }) {
  const rawTitle = contentData.Title || contentData.title || 'Untitled Article';
  const existingSlug = contentData.slug || contentData.Slug;
  // A document that is public now, or has been, keeps its address:
  //  - unpublishing sets the status back to `inspected`, but only a publish
  //    writes `curatedSubpagePath`, and nothing clears it;
  //  - a legacy article can be served (`Live: true`, `Status: 'Live'`, a
  //    `published_*` status: isPublicDocument, the public reads' own test)
  //    with no curated path at all.
  // Without this, its next publish would build a new address and break
  // every link to the old one (#1628 reviews).
  const publishedBefore =
    isRepublish || Boolean(contentData.curatedSubpagePath) || isPublicDocument(contentData);
  const reuse = Boolean(publishedBefore && existingSlug);
  // NORMALISED ONCE, HERE, because the probe and the write have to be about
  // the same string. `slugify` already trims, but a STORED slug need not —
  // this corpus is migrated and hand-edited, which is the corpus that
  // produced #400. A `'  shared-slug  '` probed untrimmed matches no holder,
  // and resolveSlug (which trims) then writes `shared-slug` onto a URL
  // another article already holds: the read says free, the write says
  // taken, and nothing in between notices.
  // A first publish of any page (article, design, framework, code page,
  // interview) gets `<topic>-<8 id characters>` (article-topics.js; owner
  // decision of 2026-11-12, #1628). The title slug is only the fallback
  // for a document with no usable id.
  const firstSlug = articleSlugFor({ contentData, contentId, provider }) || slugify(rawTitle);
  // A stored slug of only spaces is no address: fall back to the one a
  // first publish would build, rather than a bare id suffix.
  const candidate = String((reuse ? existingSlug : firstSlug) || '').trim() || firstSlug;
  // Probed on EVERY publish, to answer one question: does another document
  // already hold this URL? Three did (#400), and the branch that reused a
  // stored slug never asked.
  return resolveSlug({
    candidate,
    contentId,
    reuse,
    holders: await slugHolders(deps, candidate),
  });
}

/** The full publish: the gates, the slug, the metadata check, the write, the stats and the snapshot. */
async function fullPublish(deps, { contentId, contentData, currentStatus, nowIso, params: requestParams }) {
  const gates = await publishGates(deps, { contentId, contentData, nowIso, params: requestParams });
  if (gates.refusal) return gates.refusal;
  const { params, isInterview, contentQuality, imageReadiness } = gates;

  const ctx = resolvePublishContext(contentData, params);
  const isRepublish = currentStatus === 'published';
  const slug = await publishSlug(deps, { contentId, contentData, isRepublish, provider: ctx.inferredProvider });
  const curatedSubpagePath = resolveCuratedSubpagePath({
    stored: contentData.curatedSubpagePath,
    provider: ctx.resolvedLandingProvider,
    section: ctx.curatedSection,
    slug,
  });

  const metadataErrors = isRepublish
    ? []
    : validatePublishMetadata({
        contentData,
        publishTarget: ctx.effectivePublishTarget,
        cloudProvider: ctx.inferredProvider,
        slug,
      });
  if (metadataErrors.length > 0) {
    return { error: `Publish metadata validation failed: ${metadataErrors.join('; ')}` };
  }

  // scrapedImages re-hosting deliberately not ported — see module header.
  const refs = Array.isArray(contentData.scrapedImages) ? contentData.scrapedImages : [];
  const needsArchive = refs.length > 0 && refs.some((r) => !r.stored);
  const warning = needsArchive
    ? 'scrapedImages not re-hosted (asset-migration phase); published with original refs.'
    : undefined;

  const contentUpdate = await publishUpdate(deps, {
    contentId,
    contentData,
    nowIso,
    params,
    isInterview,
    ctx,
    slug,
    curatedSubpagePath,
    reports: { contentQuality, imageReadiness },
  });

  // Conditioned on the ETag from the read at the top of publishOne.
  // Everything above — the status gate, the quality and image reports, the
  // slug — was decided from `contentData`; without the precondition two
  // concurrent runs both pass the gate and both publish, which the
  // scheduled publisher makes reachable rather than theoretical
  // (T-301).
  if (!(await patchAsRead(deps.store, contentId, contentUpdate, contentData._etag))) {
    return { skipped: true, reason: 'Content changed while publishing; not retried' };
  }

  if (contentData.forgeMeta?.formatKey && !isRepublish) {
    await bumpForgeStats(deps, contentData.forgeMeta.formatKey);
  }

  await snapshotVersion(deps, {
    contentId,
    snapToSave: { ...contentData, ...contentUpdate },
    nowIso,
    params,
    versionReason: isRepublish ? 'republished' : 'published',
  });

  return {
    blogId: contentId,
    reused: isRepublish,
    slug,
    curatedSubpagePath,
    expectedPublicUrl: curatedSubpagePath ? toPublicUrl(curatedSubpagePath) : null,
    sourceUrl: sourceUrlOf(contentData),
    landingProvider: ctx.resolvedLandingProvider || null,
    publishTarget: ctx.effectivePublishTarget || null,
    ...(warning && { warning }),
  };
}

/** Everything the publish write sets on the content document. */
async function publishUpdate(deps, { contentId, contentData, nowIso, params, isInterview, ctx, slug, curatedSubpagePath, reports }) {
  const contentUpdate = {};

  // No AI cover for an interview (ADR 0040, D5): the guest photo is the
  // form's, optional, and nothing is generated in the guest's name.
  if (!isInterview) applyPublishTimeCoverTrigger(contentUpdate, contentData);

  // Inline body images (issue #374). Runs after the gates, so it never
  // spends a fetch on an article that will not publish, and before the
  // write, so the rewritten body and its summary land in the same patch
  // as the status change. Best-effort by construction: a failed image is
  // left as it was and named on the document.
  const inlineImageUpdate = await buildInlineImageUpdate({
    contentData,
    contentId,
    rehost: deps.inlineImages,
    nowIso,
    log: deps.log,
  });
  if (inlineImageUpdate) Object.assign(contentUpdate, inlineImageUpdate);

  // Social caption auto-queue (backlog #1): armed once per document, on a
  // LIVE publish only — a republish or an edit-and-republish must not
  // post to social again. The change-feed trigger
  // (lib/triggers/social-caption-trigger.js) decides everything else,
  // including whether autoposting is enabled at all.
  if (params.markLive && !contentData.socialCaptionGeneratedAt) {
    contentUpdate.socialCaptionTrigger = true;
  }

  const persistedIso = ctx.persistedPublishedDate
    ? ctx.persistedPublishedDate.toISOString()
    : null;
  const publishMarker = persistedIso || contentData.publishedAt || nowIso;

  return Object.assign(contentUpdate, {
    contentStatus: 'published',
    Live: Boolean(params.markLive),
    publishTarget: ctx.effectivePublishTarget,
    contentQuality: reports.contentQuality,
    imageReadiness: reports.imageReadiness,
    imageQuality: reports.imageReadiness,
    slug,
    Slug: slug,
    ...urlFields(curatedSubpagePath),
    ...providerFields(ctx),
    publishedAt: publishMarker,
    ...(persistedIso && {
      'Published At': persistedIso,
      publishedDate: persistedIso,
      datePublished: persistedIso,
    }),
  });
}

/** The four URL fields of a page with a path; none when there is no path. */
const urlFields = (curatedSubpagePath) =>
  curatedSubpagePath && {
    curatedSubpagePath,
    slugPageUrl: toPublicUrl(curatedSubpagePath),
    publishedUrl: toPublicUrl(curatedSubpagePath),
    publicUrl: toPublicUrl(curatedSubpagePath),
  };

/** The landing zone and the cloud provider, each only when known. */
const providerFields = (ctx) => ({
  ...(ctx.resolvedLandingProvider && {
    landingProvider: ctx.resolvedLandingProvider,
    targetLandingZone: `/${String(ctx.resolvedLandingProvider).toLowerCase()}/${ctx.curatedSection}`,
  }),
  ...(ctx.inferredProvider && {
    'Cloud Provider': ctx.inferredProvider,
    cloudProvider: ctx.inferredProvider,
  }),
});
