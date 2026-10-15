/**
 * POST cms/content/slug — give a published article the slug it should have
 * had, and let its URLs follow (#400).
 *
 * WHY THIS EXISTS. #403 made new collisions impossible and made a republish
 * move an article off a slug another document holds. It cannot give an article
 * the RIGHT slug, and three published articles need exactly that: they share
 * one title, so they were published onto one URL and two of them are
 * unreachable. Nothing in the admin UI edited a slug, so there was no operator
 * path at all — the fix was a script that would leave nothing behind for the
 * next time, and there will be a next time.
 *
 * WHY NOT updateContentItem, WHICH ALREADY ACCEPTED A SLUG. It would have
 * "worked", in the worst sense. `slug` was on no denylist there and matched
 * none of that route's normalizers, so it fell through to the generic string
 * branch and was stored EXACTLY as sent: `{ slug: '  Hello World!!  ' }`
 * round-tripped with its spaces, its capitals and its punctuation intact, and
 * nothing asked whether another document already held the value. A control
 * built on that route would write a URL the pipeline could never produce, onto
 * a URL another article is already serving. So the route is fixed rather than
 * worked around — slug/Slug joined FORBIDDEN_CONTENT_UPDATE_KEYS in the same
 * change — and a site URL now has exactly one writer, this one.
 *
 * WHAT IT ACTUALLY DOES is one narrow republish through the publish pipeline
 * (SET_SLUG_REASON in ./publish.js): probe `c.slug OR c.Slug`, refuse a slug
 * another document holds, refuse an article whose published path cannot be
 * computed, then write the cased slug pair and curatedSubpagePath /
 * slugPageUrl / publishedUrl / publicUrl in ONE patch conditioned on the
 * read's ETag. The URLs are derived by `resolveCuratedSubpagePath` and
 * `toPublicUrl`, the same two functions the ordinary publish write uses.
 *
 * IT REFUSES RATHER THAN HALF-COMPLETING. Owner decision on #412: this route
 * exists to make a live URL correct, so an article with neither a curated path
 * nor an inferable provider is a 409 — writing the slug and no URLs would
 * leave a panel reporting a move beside a link still pointing at the old URL,
 * which is the state the route was built to remove. See
 * `resolveSlugPublishPath` for why that diverges from the publish write on
 * purpose.
 *
 * The `fields` array in the response is still the authority on what a given
 * write touched, since keys already holding the right value are dropped.
 *
 * ONE ATOMIC STEP RATHER THAN TWO. Setting the slug and moving the URLs are
 * one operation here on purpose: as two writes there is a window in which the
 * article holds its new slug at its old URL, and the operator's recovery from
 * a failure in the second write is to reason about a half-applied document.
 * Nothing is hidden by that choice — every refusal below names its reason and
 * says that nothing was written, and a success reports the previous slug, the
 * new slug and the resulting public URL.
 *
 * NORMALISATION IS SERVER-SIDE ONLY. `slugify` lives in ./publish.js and there
 * is no package shared with `frontend/`, so a client-side preview would mean a
 * second copy of the one function whose output IS the URL. The response names
 * `requested` beside `slug` instead, so the operator sees what they typed and
 * what was stored.
 */
import { randomUUID } from 'node:crypto';
import { errorResponse } from '../http/error-response.js';
import { SET_SLUG_REASON } from './publish.js';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * One `processPublishContent` result under SET_SLUG_REASON, as an HTTP
 * response. Pure, so every branch is pinned by a test rather than by reading
 * the handler.
 *
 * EVERY ERROR THE BRANCH CAN REACH CARRIES ITS OWN `status`: 400 (the slug
 * normalises to nothing), 404 (no such document), 409 (another document holds
 * the slug, or this one is not published) and 503 (the probe could not
 * answer). The `= 500` default is therefore for an error path that does not
 * exist yet, not for any of these — which is the point of naming them. It read
 * as a nicety until it was not: a missing document arrived here without a
 * status and answered 500, telling an operator who pasted a stale id that the
 * server was broken. Any new refusal added to the branch must bring its status
 * with it, or it inherits the same lie.
 *
 * A `skipped` result is a 200 — the truthful answer to "set it to what it
 * already is", and to a lost ETag race, which the publish pipeline has always
 * reported as a skip rather than an error. Reporting either as a failure would
 * train an operator to ignore the panel.
 *
 * A SUCCESS RESULT MUST CARRY `moved` AND `fields`, AND THAT IS ASSERTED, NOT
 * COERCED. `republishWithSlug` has exactly one non-error, non-skip return and
 * it always sets both — `moved` from `decision.from !== slug`, `fields` from
 * `Object.keys(update)` — so an absent one is not a case to tolerate, it is a
 * future branch that forgot. This used to read `Boolean(result.moved)`, which
 * turned that mistake into a silent lie: a MOVE reported as a repair, on the
 * one field an operator uses to tell those apart. Third instance of the same
 * lesson in this change (after the 404 that arrived without a status, and the
 * row override that blanked absent URL fields): an absent value is not a false
 * one, and coercing it destroys the distinction the caller needs.
 *
 * The throw is deliberately not a graceful degrade. It cannot fire without a
 * code change that also fails this module's tests, and a 500 naming a broken
 * invariant is worth more than a 200 that misreports what happened to a URL.
 * Note this is NOT what protects the frontend's `previousSlug !== slug`
 * fallback: that exists for an OLD SERVER answering without the field, which
 * would not be running this function at all.
 */
export function toSetSlugResponse(result = {}, { contentId, requested }) {
  if (result.error) {
    const { status = 500, error, heldBy } = result;
    return json(status, { error, ...(heldBy && { heldBy }) });
  }
  if (result.skipped) {
    return json(200, {
      contentId,
      requested,
      changed: false,
      reason: result.reason || 'Nothing to change',
      slug: result.slug || null,
      curatedSubpagePath: result.curatedSubpagePath || null,
      publicUrl: result.expectedPublicUrl || null,
    });
  }
  // The invariant, checked rather than papered over — see the header.
  if (typeof result.moved !== 'boolean' || !Array.isArray(result.fields)) {
    throw new Error(
      'set-slug: the pipeline returned a successful result without a boolean `moved` ' +
        'and an array `fields`. Both are how the caller tells a slug MOVE from a ' +
        'URL-only REPAIR; a branch that omits either must not report success.'
    );
  }
  return json(200, {
    contentId,
    requested,
    changed: true,
    // `changed` says a write happened; `moved` says whether the URL the site
    // routes on is a different one now. A repair — `Slug` brought into line
    // with `slug`, or URL fields that were never written — is changed but not
    // moved, and an operator correcting a live URL has to be able to tell
    // those apart. `fields` names what was actually written.
    moved: result.moved,
    fields: result.fields,
    previousSlug: result.previousSlug || null,
    slug: result.slug || null,
    curatedSubpagePath: result.curatedSubpagePath || null,
    publicUrl: result.expectedPublicUrl || null,
  });
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ upsertDoc: Function }} deps.store — for the audit row only; the
 *   content write belongs to the pipeline.
 * @param {(contentId: string, params: object) => Promise<object>} deps.processPublishContent
 *   from createPublishHandlers, so the probe, the ETag precondition, the URL
 *   derivation and the version snapshot are the publish pipeline's and not a
 *   second copy of them here.
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createSetSlugHandlers({
  guard,
  store,
  processPublishContent,
  now = () => new Date(),
  uuid = randomUUID,
  log = console,
}) {
  /**
   * Best-effort, and the ordering is the reason: this runs after the write, and
   * a thrown audit row would replace the operator's answer — did the slug move,
   * and to what URL — with a 500 that says neither.
   */
  async function auditSlugSet(row) {
    try {
      await store.upsertDoc('admin_audit_logs', { id: uuid(), ...row });
    } catch (error) {
      log.error?.('setContentSlug: audit row failed', error);
    }
  }

  return {
    /** POST /api/cms/content/slug — publisher. */
    async setContentSlug(request, context) {
      const auth = await guard.requireRole(request, 'publisher');
      if (auth.error) return auth.error;
      const { user } = auth;

      try {
        const body = (await request.json().catch(() => null)) || {};
        const contentId = typeof body.contentId === 'string' ? body.contentId.trim() : '';
        if (!contentId) return json(400, { error: 'contentId is required' });
        if (typeof body.slug !== 'string') return json(400, { error: 'slug must be a string' });

        const result = await processPublishContent(contentId, {
          user,
          reason: SET_SLUG_REASON,
          slug: body.slug,
        });
        const response = toSetSlugResponse(result, { contentId, requested: body.slug });

        await auditSlugSet({
          action: 'content_slug_set',
          userId: user.oid || user.sub || null,
          userEmail: user.email || null,
          timestamp: now().toISOString(),
          contentId,
          details: {
            contentId,
            requested: body.slug,
            status: response.status,
            previousSlug: result.previousSlug || null,
            slug: result.slug || null,
            // Both, for the same reason the response carries both: a later
            // reader of this log needs to know whether a URL moved or was
            // repaired, and which fields the patch touched.
            moved: Boolean(result.moved),
            fields: Array.isArray(result.fields) ? result.fields : [],
            ...(result.error && { error: result.error }),
            ...(result.skipped && { skipped: result.reason || 'Nothing to change' }),
          },
          userAgent: request.headers?.get?.('user-agent') || null,
          compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
        });

        return response;
      } catch (error) {
        return errorResponse(context, 'Failed to set the slug', error, 500, request);
      }
    },
  };
}
