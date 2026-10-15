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
import { recordedFailure } from '../http/error-response.js';

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
      context.error?.(`[${label}] ${doc.id}: ${err?.message || err}`);
      results.push({ id: doc.id, error: err?.message || String(err) });
    }
  }
  return results;
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

  const speakerevents = (docs, context) =>
    each(docs, context, 'feed:speakerevents', (doc) => mirror.mirror('speakerevents', doc));
  const certifications = (docs, context) =>
    each(docs, context, 'feed:certifications', (doc) => mirror.mirror('certifications', doc));

  const blogs = (docs, context) =>
    each(docs, context, 'feed:blogs', async (doc) => {
      const mirrored = await mirror.mirror('blogs', doc);
      const cover = mirrored.mirrored
        ? { generated: false, reason: 'mirrored' }
        : await mirror.generateTemplateCover(doc);
      const slug = await createSlugPage(doc);
      return { id: doc.id, mirrored: mirrored.reason, cover: cover.reason, slug: slug.reason };
    });

  /** The curated slug-page fields, claimed once per `createSlugPageTrigger` request. */
  async function createSlugPage(doc) {
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
    const baseSlug = generateSlug(rawTitle) || `article-${doc.id.slice(0, 6)}`;
    const slug = data.slug || data.Slug || `${baseSlug}-${doc.id.slice(0, 6)}`;
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

  /**
   * The content feed: inspection on its flag (a failure stored as a
   * sentence with a code and a reference, #945), then the cover, the
   * forge-ready notice and the caption, each isolated.
   *
   * @param {object[]} docs - the changed content documents
   * @param {object} context - the invocation context
   * @returns {Promise<object[]>}
   */
  const content = (docs, context) =>
    each(docs, context, 'feed:content', async (doc) => {
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
      // Each trigger is isolated (T-733). These three used to run unguarded on
      // the theory that every run() catches internally — but each of those
      // catch blocks ends in a patchDoc that can itself throw, and when it did,
      // the document-level catch took over and skipped BOTH the remaining
      // triggers and the counter update below. Per-trigger failure semantics
      // are deliberate and documented in each trigger's header; the isolation
      // that makes them per-trigger was missing.
      const runIsolated = async (label, fn) => {
        try {
          return await fn();
        } catch (err) {
          context.error?.(`[${label}:content] ${doc.id}: ${err?.message || err}`);
          return 'error';
        }
      };

      if (doc.altCoverImageTrigger === true) {
        out.aiCover = await runIsolated(
          'ai-cover',
          async () => (await aiCover.run(doc.id, eventIdOf(doc))).reason
        );
      }
      if (doc.forgeReadyNotifyTrigger === true) {
        out.forgeReadyNotify = await runIsolated(
          'forge-ready-notify',
          async () => (await forgeReadyNotify.run(doc.id, eventIdOf(doc))).reason
        );
      }
      if (doc.socialCaptionTrigger === true) {
        out.socialCaption = await runIsolated(
          'social-caption',
          async () => (await socialCaption.run(doc.id, eventIdOf(doc))).reason
        );
      }
      // Counters last, from the document as delivered; a claim or completion
      // write above re-delivers this document and the marker then matches.
      // Isolated too: counter maintenance is what the comment above calls out
      // as needing to run, so it must not be collateral damage from a trigger.
      out.statsMoved = await runIsolated('dashboard-stats', async () => {
        const deltas = await dashboardStats.applyTransition({
          contentId: doc.id,
          afterData: doc,
        });
        return Object.keys(deltas).length > 0;
      });
      return out;
    });

  const workflowAlerts = (docs, context) =>
    each(docs, context, 'feed:workflow_alerts', async (doc) => {
      if (!evaluateActivationNotice(doc).send)
        return { id: doc.id, sent: false, reason: 'snapshot' };
      const live = await store.readDoc('workflow_alerts', doc.id, doc.id);
      const decision = evaluateActivationNotice(live);
      if (!decision.send) return { id: doc.id, sent: false, reason: decision.reason };
      const omit = new Set([
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
      const result = await notifier.notifyTelegram({
        title: `Workflow alert: ${live.alertType || 'unknown'}`,
        message: JSON.stringify(
          Object.fromEntries(Object.entries(live).filter(([key]) => !omit.has(key))),
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

  /**
   * The social posts feed: push a calendar edit to Publer once, and store a
   * failed push as a sentence with a code and a reference (#945).
   *
   * @param {object[]} docs - the changed social posts
   * @param {object} context - the invocation context
   * @returns {Promise<object[]>}
   */
  const socialPosts = (docs, context) =>
    each(docs, context, 'feed:social_posts', async (doc) => {
      const publerPostIds = Array.isArray(doc.publerPostIds) ? doc.publerPostIds : [];
      if (publerPostIds.length === 0) return { id: doc.id, pushed: false, reason: 'no_publer_ids' };
      if (doc.syncOrigin === 'publer' || doc.syncOrigin === 'system')
        return { id: doc.id, pushed: false, reason: `origin_${doc.syncOrigin}` };
      const marker = markerForFields(doc, SOCIAL_POST_SYNC_FIELDS);
      const decision = await shouldProcessValue({
        value: marker,
        snapshotMarker: doc.publerSyncedFieldsHash,
        readLiveMarker: async () =>
          (await store.readDoc('social_posts', doc.id, doc.id))?.publerSyncedFieldsHash,
      });
      if (!decision.process) return { id: doc.id, pushed: false, reason: decision.reason };
      if (!publer.configured) return { id: doc.id, pushed: false, reason: 'publer_not_configured' };
      try {
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

  return {
    speakerevents,
    certifications,
    blogs,
    content,
    workflowAlerts,
    socialPosts,
    createSlugPage,
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
    log.warn?.(`[unpublishFromPubler] ${error?.message || error}`);
    return { attempted: ids.length, removed: 0 };
  }
}
