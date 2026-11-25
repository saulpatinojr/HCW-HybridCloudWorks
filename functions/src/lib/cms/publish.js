/**
 * The publish pipeline — publishContent (batch, up to 25 ids) and its
 * single-item core processPublishContent, ported from Site-Main
 * cms-functions.js (:111-160, :218-360, :1337-1600, :6657-6745).
 *
 * Sequence per item, exactly as the source: publishable-status check (the one
 * canPublishFromStatus table) → quality gate → image gate (each persisting
 * its failed report onto the doc) → slug resolution (see resolveSlug) →
 * metadata validation (new publishes only) → cover trigger → the publish
 * write → forge format stats → version snapshot.
 *
 * Adaptations, each deliberate:
 *   - The scrapedImages re-hosting step (`_internal_archiveScrapedImageRefs`)
 *     is NOT ported: it re-uploads scraped assets between Firebase Storage
 *     paths, which belongs to the asset-migration phase. When refs need
 *     archiving the item still publishes and a warning is surfaced in the
 *     batch results, so nothing silently changes.
 *   - Inline body images ARE re-hosted, since 2026-09-06 (issue #374): every
 *     external `<img>` / `![](…)` URL in any body field is fetched
 *     through the guarded fetcher, stored under the article id in the public
 *     `covers` container and rewritten to the site's media path. A URL that
 *     fails is left in place and counted in the `inlineImages` summary the
 *     completed step writes; if the step itself throws, it is logged and the
 *     article publishes untouched with no summary. Nothing here can fail a
 *     publish. See ./inline-images.js. Injected as `inlineImages`; absent,
 *     nothing runs.
 *   - `params.reason === REHOST_IMAGES_REASON` (the #374 backfill, from
 *     POST cms/content/rehost-images) is a republish that touches NOTHING but
 *     the body fields and their `inlineImages` summary. A full republish of a
 *     live article would also re-run the gates, re-arm the cover trigger on an
 *     article without one, re-arm the social-caption trigger on one that never
 *     posted, rewrite Live from the caller's markLive, and re-stamp the
 *     publish dates and URLs — none of which sixteen articles need for their
 *     images to stop hotlinking. The branch shares the read, the status table,
 *     the ETag precondition and the version snapshot, and nothing else.
 *   - `params.reason === SET_SLUG_REASON` (issue #400, from POST
 *     cms/content/slug) is the second such reason, and the one the note above
 *     anticipated. It gives a published article the slug an operator asks for
 *     and lets the four URL fields follow in the same patch, writing nothing
 *     else, and it REFUSES rather than half-completing: a slug another
 *     document holds is refused rather than suffixed, and an article whose
 *     published path cannot be computed at all is refused rather than given a
 *     slug with no URL (resolveSlugPublishPath). Those are the two places a
 *     set-slug has to be stricter than a
 *     publish. See SET_SLUG_REASON for why a FULL republish cannot do this job
 *     on the very articles that need it.
 *   - bumpForgeStats' FieldValue.increment becomes read-modify-patch on the
 *     whole totals/formats objects — formatKey is user-influenced text, and
 *     writing whole objects avoids dotted-path escaping entirely.
 *   - Timestamps/publish markers are ISO strings (the migrated shape).
 *   - The source's uniqueSlug becomes pure `resolveSlug` plus the
 *     `slugHolders` probe (issue #400). Same shape — keep the bare slug when
 *     the probe finds no other holder, suffix with the document id otherwise,
 *     and never let a lookup failure block a publish — with the two gaps that
 *     put three articles on one URL closed: the probe now reads `c.Slug` as
 *     well as `c.slug`, and a republish runs it instead of reusing its stored
 *     slug unexamined. The residual a read cannot close is documented at
 *     resolveSlug.
  *
 * WHERE THE CODE IS. This file holds the route and processPublishContent;
 * the rest is split over a few files only to keep each one short, and
 * everything they export is re-exported here:
 *   publish-pipeline.js   one item: the read, the gates, the write (and the two reasons)
 *   publish-republish.js  the two narrow republishes, the slug probe, stats, snapshot
 *   publish-slugs.js      the slug and the page's path and URL
 *   publish-steps.js      the metadata check, the cover trigger, the batch results
 */

import { randomUUID } from 'node:crypto';
import { authoredMessage, errorCode, errorResponse } from '../http/error-response.js';
import { normalizePublishTarget } from './publish-targets.js';
import { publishOne } from './publish-pipeline.js';
import { accumulatePublishResult } from './publish-steps.js';

export {
  REHOST_IMAGES_REASON,
  SET_SLUG_REASON,
} from './publish-pipeline.js';
export {
  SLUG_HOLDERS_QUERY,
  buildSlugPublishUpdate,
  evaluateSlugChange,
  normalizeSlugInput,
  publicUrlOf,
  querySlugHolders,
  resolveCuratedSubpagePath,
  resolveSlug,
  resolveSlugPublishPath,
  slugify,
  toPublicUrl,
} from './publish-slugs.js';
export {
  accumulatePublishResult,
  applyPublishTimeCoverTrigger,
  getPublicSectionForPublishTarget,
  resolvePublishContext,
  validatePublishMetadata,
} from './publish-steps.js';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createPublishHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  inlineImages = null,
  log = console,
}) {
  const deps = { store, now, uuid, inlineImages, log };

  /**
   * Publish one document through every gate. Never throws: the result is
   * `{ error }` (an authored sentence) or the publish outcome.
   *
   * @param {string} contentId - the document
   * @param {object} params - the caller's options (target, flags, reason)
   * @returns {Promise<object>}
   */
  async function processPublishContent(contentId, params) {
    try {
      return await publishOne(deps, contentId, params);
    } catch (err) {
      // This result reaches the publish route's `errors`, set-slug's answer
      // and the Telegram job, so a Cosmos or system error's own words stay
      // out of it (#945); the log keeps its code.
      log.error?.(`[publish] processPublishContent failed (${errorCode(err)})`);
      return { error: authoredMessage(err, 'Publishing stopped on an unexpected failure.') };
    }
  }

  return {
    /** POST /api/publishContent — publisher; batch of up to 25 ids. */
    async publishContent(request, context) {
      const auth = await guard.requireRole(request, 'publisher');
      if (auth.error) return auth.error;
      const { user } = auth;

      try {
        const body = (await request.json().catch(() => null)) || {};
        const {
          contentIds = [],
          publishTarget = null,
          markLive = true,
          createSlugPageTrigger = true,
          addToCurated = true,
          cloudProvider = null,
          landingProvider = null,
          forceQualityBypass = false,
          forceImageBypass = false,
        } = body;

        if (!Array.isArray(contentIds) || contentIds.length === 0) {
          return json(400, { error: 'contentIds array required' });
        }
        const normalizedPublishTarget = normalizePublishTarget(publishTarget);

        const results = { published: 0, skipped: 0, errors: [], mappings: [], warnings: [] };
        for (const contentId of contentIds.slice(0, 25)) {
          const r = await processPublishContent(contentId, {
            user,
            publishTarget: normalizedPublishTarget,
            markLive,
            createSlugPageTrigger,
            addToCurated,
            cloudProvider,
            landingProvider,
            forceQualityBypass,
            forceImageBypass,
          });
          accumulatePublishResult(results, contentId, r);
        }

        return json(200, { success: true, ...results });
      } catch (error) {
        return errorResponse(context, 'Failed to publish content', error, 500, request);
      }
    },

    // Not a route. Exposed so the scheduled publisher (T-301) and the
    // re-host route (lib/cms/rehost-images.js) run the same pipeline rather
    // than a second implementation of it — the status gate, quality and image
    // gates, slug resolution and version snapshot are the publish semantics,
    // and a caller that reimplemented them would drift.
    processPublishContent,
  };
}
