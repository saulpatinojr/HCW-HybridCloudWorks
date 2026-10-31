/**
 * drafts-stage.js — where a Drafts-stage document is, what may be done to it,
 * and the two transitions (owner request 2026-10-03). The other half of
 * ./drafts.js, which re-exports all of this: what a draft contains, the
 * documents it is written as, and the views the page receives.
 *
 * The edges themselves are content-status.js VALID_TRANSITIONS — the one
 * table — and every check here asks it (isAllowedEdge) rather than keeping a
 * second copy.
 */
import { inferProviderFromTags } from './repo-draft.js';
import {
  buildContentQualityReport,
  buildImageLineage,
  buildImageReadinessReport,
  getPrimaryContentBody,
  normalizeContentBodyFields,
} from './content-quality.js';
import { buildDedupFields } from './content-dedup.js';
import { DRAFTS_STAGE_STATUS, VALID_TRANSITIONS } from './content-status.js';

export { DRAFTS_STAGE_STATUS };

/** The status a draft is sent to, and the only one Back to Drafts leaves. */
export const REVIEW_STATUS = 'in_review';

/**
 * `draftOrigin` values: written on this page, imported from docs/content, or
 * sent in as a whole markdown file from the owner's private vault (`vault`) or
 * pasted into the page (`paste`) — POST cms/drafts/from-markdown.
 */
export const DRAFT_ORIGINS = Object.freeze({
  site: 'drafts',
  repo: 'repo-import',
  vault: 'vault',
  paste: 'paste',
  // Written through the Agent Content API by Koda's key (ADR 0037). The same
  // Drafts routes, so the same stage; the origin is what tells them apart.
  agent: 'agent',
});

export const statusOf = (doc = {}) => String(doc.contentStatus || 'ingested');

/**
 * Did this article come through the Drafts stage? A draft now, one written or
 * imported here (`draftOrigin`), or one the original repository import put In
 * Review (`repoPath` — the two Docker drafts imported before this page
 * existed).
 */
export function comesFromDrafts(doc = {}) {
  return statusOf(doc) === DRAFTS_STAGE_STATUS || Boolean(doc.draftOrigin) || Boolean(doc.repoPath);
}

/** 'draft' | 'in_review' | 'live' | 'past_review' — what the list shows. */
export function stageOf(doc = {}) {
  if (doc.Live === true) return 'live';
  const status = statusOf(doc);
  if (status === DRAFTS_STAGE_STATUS) return 'draft';
  if (status === REVIEW_STATUS) return 'in_review';
  return 'past_review';
}

/** May the state machine walk this edge? The one table, content-status.js. */
export const isAllowedEdge = (from, to) => Boolean(VALID_TRANSITIONS[from]?.includes(to));

/** Which buttons the page offers for a document. The handlers enforce the same rules. */
export function allowedActions(doc = {}) {
  const stage = stageOf(doc);
  const fromDrafts = comesFromDrafts(doc);
  return {
    edit: stage === 'draft',
    save: stage === 'draft',
    sendToReview: stage === 'draft' && isAllowedEdge(DRAFTS_STAGE_STATUS, REVIEW_STATUS),
    backToDrafts:
      stage === 'in_review' && fromDrafts && isAllowedEdge(REVIEW_STATUS, DRAFTS_STAGE_STATUS),
    delete: stage === 'draft' || (stage === 'in_review' && fromDrafts),
  };
}

const refusal = (status, code, error) => ({ status, code, error });

const LIVE_REFUSAL = (verb) =>
  refusal(
    409,
    'LIVE',
    `This article is live on the site, so ${verb} is refused and nothing was changed. A published article is never touched from Drafts.`
  );

const pastReview = (doc, verb) =>
  refusal(
    409,
    'PAST_REVIEW',
    `This article is "${statusOf(doc)}", past review, so ${verb} is refused and nothing was changed.`
  );

/** Null when a delete may go ahead, else why not. */
export function deleteRefusal(doc) {
  if (doc.Live === true) return LIVE_REFUSAL('deleting it');
  if (!comesFromDrafts(doc)) {
    return refusal(
      409,
      'NOT_A_DRAFT',
      'This article did not come from Drafts; nothing was changed.'
    );
  }
  if (!allowedActions(doc).delete) return pastReview(doc, 'deleting it here');
  return null;
}

/** Null when a save may go ahead, else why not. */
export function saveRefusal(doc) {
  if (doc.Live === true) return LIVE_REFUSAL('saving over it');
  if (stageOf(doc) === 'in_review') {
    return refusal(
      409,
      'IN_REVIEW',
      'This article is In Review, so it is not saved from here. Use Back to Drafts to edit it again.'
    );
  }
  if (stageOf(doc) !== 'draft') return pastReview(doc, 'saving over it');
  return null;
}

/** Null when Send to In Review may go ahead, else why not. */
export function sendToReviewRefusal(doc) {
  const blocked = saveRefusal(doc);
  if (blocked)
    return blocked.code === 'IN_REVIEW'
      ? { ...blocked, error: 'This article is already In Review.' }
      : blocked;
  if (!isAllowedEdge(statusOf(doc), REVIEW_STATUS)) return pastReview(doc, 'sending it to review');
  if (!String(doc.Title || doc.title || '').trim()) {
    return refusal(422, 'NO_TITLE', 'Give the draft a title before sending it to In Review.');
  }
  if (!getPrimaryContentBody(doc)) {
    return refusal(422, 'EMPTY_BODY', 'The draft has no body yet; write the article first.');
  }
  return null;
}

/** Null when Back to Drafts may go ahead, else why not. */
export function backToDraftsRefusal(doc) {
  if (doc.Live === true) return LIVE_REFUSAL('moving it back to Drafts');
  if (!comesFromDrafts(doc)) {
    return refusal(
      409,
      'NOT_A_DRAFT',
      'This article did not come from Drafts; nothing was changed.'
    );
  }
  if (stageOf(doc) === 'draft')
    return refusal(409, 'ALREADY_DRAFT', 'This article is already a draft.');
  if (!allowedActions(doc).backToDrafts) return pastReview(doc, 'moving it back to Drafts');
  return null;
}

/**
 * drafting → in_review: the same end state the repository import produced —
 * an in_review, Live false document with the body normalised, the dedup
 * fields, the quality and image-readiness reports and the image lineage
 * createContentDocument stamps on every new document — so the review board
 * cannot tell an article sent from Drafts from one imported straight into
 * review. The provider is filled from the tags only when none is set
 * (repo-draft.js inferProviderFromTags), never overwritten.
 */
export function buildSendToReviewPatch(doc, { editor, now = () => new Date() }) {
  const stamp = now().toISOString();
  const body = getPrimaryContentBody(doc);
  const bodies = normalizeContentBodyFields({
    Content: body,
    content: body,
    postContent: body,
    ...(typeof doc.blogDraft === 'string' && { blogDraft: body }),
  });
  const title = String(doc.Title || doc.title || '').trim();
  const tags = Array.isArray(doc.Tags) ? doc.Tags : [];
  const provider = doc['Cloud Provider'] || doc.cloudProvider ? null : inferProviderFromTags(tags);
  const merged = { ...doc, ...bodies };
  const imageReadiness = buildImageReadinessReport(merged);
  return {
    contentStatus: REVIEW_STATUS,
    Live: false,
    Status: 'Draft',
    ...bodies,
    ...buildDedupFields({ url: doc.sourceUrl, title }),
    ...(provider && { 'Cloud Provider': provider, cloudProvider: provider }),
    contentQuality: buildContentQualityReport(merged, null),
    imageReadiness,
    imageQuality: imageReadiness,
    ...(!doc.imageLineage && { imageLineage: buildImageLineage(merged) }),
    sentToReviewAt: stamp,
    sentToReviewBy: editor,
    updatedAt: stamp,
    updatedBy: editor,
  };
}

/** in_review → drafting. Status and stamps only; the article is left as the reviewer left it. */
export function buildBackToDraftsPatch({ editor, now = () => new Date() }) {
  const stamp = now().toISOString();
  return {
    contentStatus: DRAFTS_STAGE_STATUS,
    Live: false,
    returnedToDraftsAt: stamp,
    returnedToDraftsBy: editor,
    updatedAt: stamp,
    updatedBy: editor,
  };
}
