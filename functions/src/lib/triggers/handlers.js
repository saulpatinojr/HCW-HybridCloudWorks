/**
 * handlers.js — what each change-feed function does with a batch of changed
 * documents. One handler per container (the feed delivers a container's
 * changes in order; one lease processor per container instead of one per
 * former Firestore trigger):
 *
 *   speakerevents  → mirror eventImageUrl
 *   certifications → mirror imageUrl
 *   blogs          → mirror contentImageUrl, else template cover; slug page on createSlugPageTrigger
 *   content        → inspect on inspectTrigger; AI cover on altCoverImageTrigger; dashboard counters
 *   workflow_alerts→ Telegram on activation
 *   social_posts   → push calendar edits to Publer
 *
 * Every handler swallows per-document errors (logged) so one bad document
 * never stalls the lease behind it. Each decides from the document it is
 * given plus live state — the feed carries the current item only, and the
 * value markers / rising-edge claims / stats markers replace `before`.
 * `_etag` of the delivered item is the "event id" a rising-edge claim records:
 * stable across redeliveries of the same write, different for a new write.
 */
import { claimRisingEdge, releaseRisingEdgeClaim } from './rising-edge-claim.js';
import { evaluateActivationNotice, ACTIVATION_NOTIFIED_FIELD } from './activation-notice.js';
import { markerForFields, shouldProcessValue } from './value-marker.js';
import { generateSlug } from '../rss/feeds.js';
import { articleSlugFor } from '../cms/article-topics.js';
import { recordedFailure, errorFacts, errorCode } from '../http/error-response.js';

export const SLUG_PAGE_CLAIM_FIELDS = Object.freeze({
  flagField: 'createSlugPageTrigger',
  claimField: 'createSlugPageRunId',
  claimedAtField: 'createSlugPageRunAt',
});

export const SOCIAL_POST_SYNC_FIELDS = ['caption', 'url', 'scheduledAt', 'accountIds', 'platforms'];

export function buildPublerUpdateBody(socialPost = {}) {
  const text = [socialPost.caption, socialPost.url].filter(Boolean).join('\n\n').trim();
  if (!text)
    throw new Error('A social post must have caption or URL text before syncing to Publer');
  const post = { text };
  if (socialPost.scheduledAt) {
    const date = new Date(socialPost.scheduledAt);
    if (!Number.isNaN(date.getTime())) post.scheduled_at = date.toISOString();
  }
  return { post };
}

const eventIdOf = (doc) => doc?._etag || doc?._ts?.toString() || 'unknown';

/**
 * Wall-clock budget for one change-feed invocation (T-731).
 *
 * A single `content` document can require up to four Replicate generations
 * (each `Prefer: wait=60` plus polling), an inspection with model calls, a
 * caption generation and a Publer call. An iteration count does not bound
 * elapsed time when every iteration is mostly waiting on someone else, so a
 * batch of documents all carrying `altCoverImageTrigger` could not finish
 * inside any plausible function timeout.
 *
 * Ten minutes: comfortably inside the Flex Consumption non-HTTP default
 * (30 min) and, more importantly, inside `DEFAULT_CLAIM_TIMEOUT_MS` (15 min).
 * Overrunning the claim window is the failure that matters — a claim held past
 * it becomes reclaimable as stale, so a redelivery would re-do work that is
 * still in flight and pay for it twice.
 */
export const FEED_BUDGET_MS = 10 * 60 * 1000;

/** Thrown to make the lease NOT advance. Identified by `code`, not by message. */
export class FeedBudgetExhausted extends Error {
  constructor(label, done, total) {
    super(
      `[${label}] work budget exhausted after ${done}/${total} document(s); batch will redeliver`
    );
    this.code = 'FEED_BUDGET_EXHAUSTED';
    this.done = done;
    this.total = total;
  }
}

async function runEach(docs, context, label, fn, { budgetMs, monotonic }) {
  const results = [];
  const deadline = monotonic() + budgetMs;
  const list = (docs || []).filter((doc) => doc?.id);

  for (const [index, doc] of list.entries()) {
    // Checked BEFORE starting each document, and never before the first.
    // Always doing at least one is what guarantees forward progress: a single
    // document that alone exceeds the budget would otherwise be retried
    // forever, which is worse than the overrun it avoids.
    if (index > 0 && monotonic() >= deadline) {
      // THROW, do not return. The Cosmos change-feed processor checkpoints the
      // lease after the handler returns *successfully*, so returning early
      // would advance the lease past the documents this loop never looked at
      // and their triggers would never fire again — the feed only redelivers
      // on a subsequent write. Throwing leaves the lease where it is and the
      // whole batch redelivers.
      //
      // Redelivery is cheap for the documents already done: their rising-edge
      // claims are released and their trigger flags cleared, so the second
      // pass skips them without spending anything. That is the property this
      // early exit depends on, and it is the same one that makes the feed safe
      // against a killed invocation.
      context.error?.(`[${label}] budget exhausted after ${index}/${list.length}`);
      throw new FeedBudgetExhausted(label, index, list.length);
    }
    try {
      results.push(await fn(doc));
    } catch (err) {
      context.error?.(`[${label}] a document failed: ${errorFacts(err)}`);
      results.push({ id: doc.id, error: errorCode(err) });
    }
  }
  return results;
}

/** The curated slug-page fields, claimed once per `createSlugPageTrigger` request. */
async function createSlugPage({ store, now }, doc) {
  const claim = await claimRisingEdge(store, 'blogs', doc.id, {
    ...SLUG_PAGE_CLAIM_FIELDS,
    eventId: eventIdOf(doc),
    now,
  });
  if (!claim.claim) return { created: false, reason: claim.reason };
  const data = claim.data;
  const rawTitle = data.Title || data.title || 'untitled-article';
  const provider = String(
    data.landingProvider || data.cloudProvider || data['Cloud Provider'] || 'azure'
  ).toLowerCase();
  // A mirrored article with no slug of its own gets the same shape a first
  // publish gives one, `<topic>-<8 id characters>`, always lowercase (#1628).
  // Before, it was the title plus a mixed-case id slice, which failed the
  // strict address rule.
  const ownSlug = data.slug || data.Slug;
  const slug =
    ownSlug ||
    articleSlugFor({ contentData: data, contentId: doc.id, provider }) ||
    generateSlug(rawTitle) ||
    'article';
  await store.patchDoc('blogs', doc.id, {
    ...releaseRisingEdgeClaim(SLUG_PAGE_CLAIM_FIELDS),
    slug,
    Slug: slug,
    createSlugPageTrigger: false,
    curatedParent: data.curatedParent || 'Curated Articles',
    curatedSubpage: true,
    curatedSubpagePath: `/${provider}/blog/${slug}`,
    curatedLinkedAt: now().toISOString(),
  });
  return { created: true, reason: 'created', slug };
}

function blogs(h, docs, context) {
  return h.each(docs, context, 'feed:blogs', async (doc) => {
    const mirrored = await h.mirror.mirror('blogs', doc);
    const cover = mirrored.mirrored
      ? { generated: false, reason: 'mirrored' }
      : await h.mirror.generateTemplateCover(doc);
    const slug = await createSlugPage(h, doc);
    return { id: doc.id, mirrored: mirrored.reason, cover: cover.reason, slug: slug.reason };
  });
}

/**
 * Each trigger is isolated (T-733). These three used to run unguarded on
 * the theory that every run() catches internally — but each of those
 * catch blocks ends in a patchDoc that can itself throw, and when it did,
 * the document-level catch took over and skipped BOTH the remaining
 * triggers and the counter update below. Per-trigger failure semantics
 * are deliberate and documented in each trigger's header; the isolation
 * that makes them per-trigger was missing.
 */
async function runIsolated(context, label, fn) {
  try {
    return await fn();
  } catch (err) {
    context.error?.(`[${label}:content] failed: ${errorFacts(err)}`);
    return 'error';
  }
}

/** The content triggers a document's flags ask for: flag, result field, label, and the trigger. */
const CONTENT_TRIGGERS = [
  ['altCoverImageTrigger', 'aiCover', 'ai-cover', 'aiCover'],
  ['forgeReadyNotifyTrigger', 'forgeReadyNotify', 'forge-ready-notify', 'forgeReadyNotify'],
  ['socialCaptionTrigger', 'socialCaption', 'social-caption', 'socialCaption'],
];

/** The cover, the forge-ready notice and the caption, each isolated, then the counters. */
async function runContentTriggers(h, doc, context, out) {
  for (const [flag, field, label, dep] of CONTENT_TRIGGERS) {
    if (doc[flag] === true) {
      out[field] = await runIsolated(context, label, async () => (await h[dep].run(doc.id, eventIdOf(doc))).reason);
    }
  }
  // Counters last, from the document as delivered; a claim or completion
  // write above re-delivers this document and the marker then matches.
  // Isolated too: counter maintenance is what the comment above calls out
  // as needing to run, so it must not be collateral damage from a trigger.
  out.statsMoved = await runIsolated(context, 'dashboard-stats', async () => {
    const deltas = await h.dashboardStats.applyTransition({
      contentId: doc.id,
      afterData: doc,
    });
    return Object.keys(deltas).length > 0;
  });
}

/**
 * The content feed: inspection on its flag (a failure stored as a
 * sentence with a code and a reference, #945), then the cover, the
 * forge-ready notice and the caption, each isolated.
 *
 * @param {object} h - the feed handlers' dependencies
 * @param {object[]} docs - the changed content documents
 * @param {object} context - the invocation context
 * @returns {Promise<object[]>}
 */
function content(h, docs, context) {
  const { store, inspector, now } = h;
  return h.each(docs, context, 'feed:content', async (doc) => {
    const out = { id: doc.id };
    if (doc.inspectTrigger === true) {
      try {
        const r = await inspector.executeInspection({
          collectionName: 'content',
          docId: doc.id,
          newData: doc,
        });
        out.inspected = r.contentStatus;
      } catch (err) {
        // The editor shows inspectError: the inspector's sentence, or a
        // fixed one with the code and the log line's reference (#945).
        await store.patchDoc('content', doc.id, {
          inspectTrigger: false,
          inspectError: recordedFailure(context, 'The inspection failed.', err),
          inspectErrorAt: now().toISOString(),
        });
        out.inspected = 'error';
      }
    }
    await runContentTriggers(h, doc, context, out);
    return out;
  });
}

/** The alert fields the owner's Telegram message leaves out. */
const ALERT_FIELDS_OMITTED = new Set([
  'id',
  'firstSeenAt',
  'updatedAt',
  'active',
  'alertType',
  'source',
  ACTIVATION_NOTIFIED_FIELD,
  '_rid',
  '_self',
  '_etag',
  '_attachments',
  '_ts',
]);

function workflowAlerts(h, docs, context) {
  const { store, notifier, now } = h;
  return h.each(docs, context, 'feed:workflow_alerts', async (doc) => {
    if (!evaluateActivationNotice(doc).send)
      return { id: doc.id, sent: false, reason: 'snapshot' };
    const live = await store.readDoc('workflow_alerts', doc.id, doc.id);
    const decision = evaluateActivationNotice(live);
    if (!decision.send) return { id: doc.id, sent: false, reason: decision.reason };
    const result = await notifier.notifyTelegram({
      title: `Workflow alert: ${live.alertType || 'unknown'}`,
      message: JSON.stringify(
        Object.fromEntries(Object.entries(live).filter(([key]) => !ALERT_FIELDS_OMITTED.has(key))),
        null,
        2
      ),
      severity: live.severity || 'warning',
      source: live.source || 'workflow_alerts',
    });
    // Stamped only after the send succeeded; a not-configured notifier leaves
    // the alert unannounced so it announces once Telegram is configured.
    if (result.sent)
      await store.patchDoc('workflow_alerts', doc.id, {
        [ACTIVATION_NOTIFIED_FIELD]: now().toISOString(),
      });
    return { id: doc.id, sent: result.sent, reason: result.reason || 'sent' };
  });
}

/**
 * Whether a social post's edit should be pushed to Publer: `{ skip }` with
 * the answer when not, else `{ marker }`, the value the push is recorded by.
 */
async function socialPostPushCheck({ store, publer }, doc, publerPostIds) {
  if (publerPostIds.length === 0) return { skip: { id: doc.id, pushed: false, reason: 'no_publer_ids' } };
  if (doc.syncOrigin === 'publer' || doc.syncOrigin === 'system')
    return { skip: { id: doc.id, pushed: false, reason: `origin_${doc.syncOrigin}` } };
  const marker = markerForFields(doc, SOCIAL_POST_SYNC_FIELDS);
  const decision = await shouldProcessValue({
    value: marker,
    snapshotMarker: doc.publerSyncedFieldsHash,
    readLiveMarker: async () =>
      (await store.readDoc('social_posts', doc.id, doc.id))?.publerSyncedFieldsHash,
  });
  if (!decision.process) return { skip: { id: doc.id, pushed: false, reason: decision.reason } };
  if (!publer.configured) return { skip: { id: doc.id, pushed: false, reason: 'publer_not_configured' } };
  return { marker };
}

/** Push the post's fields to each of its Publer posts, and record the push. */
async function pushSocialPost({ store, publer, now }, doc, publerPostIds, marker) {
  const activeIds = Array.isArray(doc.publerActivePostIds)
    ? doc.publerActivePostIds
    : publerPostIds;
  const body = buildPublerUpdateBody(doc);
  await Promise.all(activeIds.map((id) => publer.request(`/posts/${id}`, 'PUT', body)));
  await store.patchDoc('social_posts', doc.id, {
    publerSyncedFieldsHash: marker,
    syncStatus: 'synced',
    syncOrigin: 'calendar',
    lastSyncedAt: now().toISOString(),
    syncError: null,
  });
}

/**
 * The social posts feed: push a calendar edit to Publer once, and store a
 * failed push as a sentence with a code and a reference (#945).
 *
 * @param {object} h - the feed handlers' dependencies
 * @param {object[]} docs - the changed social posts
 * @param {object} context - the invocation context
 * @returns {Promise<object[]>}
 */
function socialPosts(h, docs, context) {
  const { store, now } = h;
  return h.each(docs, context, 'feed:social_posts', async (doc) => {
    const publerPostIds = Array.isArray(doc.publerPostIds) ? doc.publerPostIds : [];
    const check = await socialPostPushCheck(h, doc, publerPostIds);
    if (check.skip) return check.skip;
    try {
      await pushSocialPost(h, doc, publerPostIds, check.marker);
      return { id: doc.id, pushed: true, reason: 'pushed' };
    } catch (err) {
      // The calendar shows syncError: a sentence with the code (Publer's
      // HTTP status) and the log line's reference, never Publer's own
      // words, which the API-keys page keeps for the owner (#945).
      await store.patchDoc('social_posts', doc.id, {
        syncStatus: 'failed',
        syncOrigin: 'system',
        syncError: recordedFailure(context, 'The post could not be synced to Publer.', err),
        lastSyncAttemptAt: now().toISOString(),
      });
      return { id: doc.id, pushed: false, reason: 'error' };
    }
  });
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function, upsertDoc: Function, replaceDocIfMatch: Function, deleteDoc: Function }} deps.store
 * @param {{ mirror: Function, generateTemplateCover: Function }} deps.mirror
 * @param {{ executeInspection: Function }} deps.inspector
 * @param {{ run: Function }} deps.aiCover
 * @param {{ applyTransition: Function }} deps.dashboardStats
 * @param {{ notifyTelegram: Function }} deps.notifier
 * @param {{ configured: boolean, request: Function }} deps.publer
 * @param {() => Date} [deps.now]
 * @param {number} [deps.feedBudgetMs] wall-clock budget per invocation (T-731)
 * @param {() => number} [deps.monotonic] elapsed-time source, injectable for tests
 */
export function createFeedHandlers({
  store,
  mirror,
  inspector,
  aiCover,
  forgeReadyNotify,
  socialCaption,
  dashboardStats,
  notifier,
  publer,
  now = () => new Date(),
  feedBudgetMs = FEED_BUDGET_MS,
  monotonic = Date.now,
}) {
  // `now` returns a Date and is the *content* clock (timestamps written into
  // documents); `monotonic` measures elapsed time. They are separate so a test
  // can freeze document timestamps — several below rely on that — without also
  // freezing the budget, and vice versa.
  //
  // Bound here rather than threaded through six call sites: every handler
  // shares one budget per invocation, which is the thing being bounded.
  const each = (docs, context, label, fn) =>
    runEach(docs, context, label, fn, { budgetMs: feedBudgetMs, monotonic });
  const h = { store, mirror, inspector, aiCover, forgeReadyNotify, socialCaption, dashboardStats, notifier, publer, now, each };

  return {
    speakerevents: (docs, context) =>
      each(docs, context, 'feed:speakerevents', (doc) => mirror.mirror('speakerevents', doc)),
    certifications: (docs, context) =>
      each(docs, context, 'feed:certifications', (doc) => mirror.mirror('certifications', doc)),
    blogs: (docs, context) => blogs(h, docs, context),
    content: (docs, context) => content(h, docs, context),
    workflowAlerts: (docs, context) => workflowAlerts(h, docs, context),
    socialPosts: (docs, context) => socialPosts(h, docs, context),
    createSlugPage: (doc) => createSlugPage(h, doc),
  };
}

/**
 * The `!after` branch of syncSocialPostToPubler: un-publish on Publer when a
 * social post is deleted. Called by DELETE /api/cms/social-posts/{id}.
 * Best-effort; never throws.
 *
 * One call for every id, through `publer.deletePosts` (#463 item 2). It used
 * to be one `DELETE /posts/{id}` per id, which is a form Publer does not
 * document — and the id-per-request loop counted a 200 as a removal, so a
 * post Publer declined to delete was reported here as removed and stayed
 * scheduled to publish under the owner's name. `deleted_ids` is the only
 * thing that says a post is gone, and `missingIds` is the rest.
 */
export async function unpublishFromPubler(publer, doc, log = {}) {
  const ids = Array.isArray(doc?.publerPostIds) ? doc.publerPostIds : [];
  if (!ids.length || !publer?.configured) return { attempted: 0, removed: 0 };
  try {
    const { deletedIds, missingIds } = await publer.deletePosts(ids);
    if (missingIds.length) {
      // Warned, not thrown: the caller is a delete that has already happened
      // on our side, and the operator's next move is the Publer queue itself.
      //
      // Counts only. A Publer post id is an identifier and traces stay
      // content-free — the same rule `cleanupSoftDeletedContent` states at
      // `timers/content-cleanup.js` for refused document ids.
      log.warn?.(
        `[unpublishFromPubler] Publer did not delete ${missingIds.length} of ${ids.length} ` +
          'post(s) — check the Publer queue'
      );
    }
    return { attempted: ids.length, removed: deletedIds.length };
  } catch (error) {
    log.warn?.(`[unpublishFromPubler] ${errorFacts(error)}`);
    return { attempted: ids.length, removed: 0 };
  }
}
