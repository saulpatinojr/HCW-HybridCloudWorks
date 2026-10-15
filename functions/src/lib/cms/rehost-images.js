/**
 * The #374 backfill: re-host the body images of articles published before
 * the publish-time step in ./inline-images.js existed.
 *
 * Two handlers behind one route, cms/content/rehost-images:
 *
 *   GET  — the candidates. Every published document whose body fields still
 *          reference a third-party image, summarised WITHOUT the body: id,
 *          title, slug, public URL, which fields, how many distinct URLs, the
 *          hosts they sit on, and the last `inlineImages` summary if a run
 *          has already been recorded. The same `findInlineImageUrls` the
 *          publish step uses decides what counts, so the list and the
 *          rewrite can never disagree about a URL. This is
 *          scripts/scan-inline-images.mjs answered from Cosmos instead of the
 *          committed manifest, so the admin page can show it.
 *   POST — `{ contentIds }`, up to MAX_BATCH, each run through the publish
 *          pipeline's processPublishContent with REHOST_IMAGES_REASON (see
 *          ./publish.js: nothing but the body fields and their summary is
 *          written). Per id the response carries the document's `inlineImages`
 *          summary, a skip with its reason, or the error. Sequential, like
 *          publishContent: each article already fetches its images through a
 *          small pool, and a batch of articles fetching in parallel on top of
 *          that would hammer the one CDN most of them share.
 *
 * Guarded like the publish route it is a narrow form of: the list needs
 * `editor`, the write needs `publisher`.
 */
import { errorResponse } from '../http/error-response.js';
import { findInlineImageUrls, resolveBodyFields } from './inline-images.js';
import { publicUrlOf, REHOST_IMAGES_REASON } from './publish.js';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Same cap as publishContent; the UI batches below it. */
export const MAX_BATCH = 25;

/** More than the published corpus by an order of magnitude; a bound, not a page. */
export const CANDIDATE_SCAN_TOP = 500;

/** Raw statuses the publish pipeline normalises to 'published' (content-update-validation.js). */
export const PUBLISHED_STATUSES = Object.freeze(['published', 'published_news', 'published_both']);

/**
 * Projected so the scan reads only what it summarises — the three body
 * fields, the identity the page shows, and the last summary. Bracketed
 * because two of these differ from each other only by case.
 */
export const CANDIDATE_QUERY = `SELECT TOP ${CANDIDATE_SCAN_TOP} c.id, c["Title"], c["title"], c["slug"], c["Slug"], c["Live"], c["publishedUrl"], c["publicUrl"], c["curatedSubpagePath"], c["slugPageUrl"], c["blogDraft"], c["Content"], c["content"], c["inlineImages"] FROM c WHERE ARRAY_CONTAINS(@statuses, c["contentStatus"])`;

/** Hostname of a URL, or 'invalid-url' — the same placeholder the rehoster logs. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return 'invalid-url';
  }
}

/**
 * The document's last `inlineImages` summary reduced to what the page shows:
 * when, how many, and the HOSTS that failed. The summary itself keeps
 * `failedUrls` (origin and path, for the editor who opens the document);
 * returning it here would make the candidates list a second way to read
 * third-party URLs out of the CMS, which the list exists not to be.
 */
export function summarizeLastRun(inlineImages) {
  if (!inlineImages || typeof inlineImages !== 'object') return null;
  const failedUrls = Array.isArray(inlineImages.failedUrls) ? inlineImages.failedUrls : [];
  return {
    at: inlineImages.at ?? null,
    rewritten: Number(inlineImages.rewritten) || 0,
    failed: Number(inlineImages.failed) || 0,
    failedHosts: [...new Set(failedUrls.map(hostOf))].sort(),
  };
}

/**
 * One candidate row, or null when the document hotlinks nothing. Carries no
 * body text and no URL of a third party: the page shows counts and hosts,
 * and the response must not be a second way to read an article out of the
 * CMS.
 */
export function summarizeCandidate(doc = {}) {
  const fields = [];
  const seen = new Set();
  const hosts = new Set();
  for (const field of resolveBodyFields(doc)) {
    const urls = findInlineImageUrls(doc[field]);
    if (urls.length === 0) continue;
    fields.push(field);
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      hosts.add(hostOf(url));
    }
  }
  if (fields.length === 0) return null;
  return {
    id: doc.id,
    title: doc.Title || doc.title || 'Untitled',
    slug: doc.slug || doc.Slug || null,
    publicUrl: publicUrlOf(doc) || null,
    live: doc.Live === true,
    fields,
    urlCount: seen.size,
    hosts: [...hosts].sort(),
    lastRun: summarizeLastRun(doc.inlineImages),
  };
}

/** Most images first, then title, so the list reads the way the scan script prints. */
export function sortCandidates(rows) {
  return [...rows].sort(
    (a, b) => b.urlCount - a.urlCount || String(a.title).localeCompare(String(b.title))
  );
}

/** Non-empty distinct strings, in order, or null when the body is not that. */
export function normalizeContentIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** The pipeline result for one id, shaped for the response. */
export function toRehostResult(contentId, r) {
  if (r.error) return { contentId, error: r.error };
  if (r.skipped) return { contentId, skipped: true, reason: r.reason || 'Skipped' };
  return { contentId, inlineImages: r.inlineImages ?? null };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function }} deps.store
 * @param {(contentId: string, params: object) => Promise<object>} deps.processPublishContent
 *   from createPublishHandlers, with the rehoster injected there.
 */
export function createRehostImageHandlers({ guard, store, processPublishContent, log = console }) {
  return {
    /** GET /api/cms/content/rehost-images — editor. */
    async listCandidates(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const rows = await store.queryDocs('content', CANDIDATE_QUERY, [
          { name: '@statuses', value: [...PUBLISHED_STATUSES] },
        ]);
        const candidates = sortCandidates(rows.map(summarizeCandidate).filter(Boolean));
        return json(200, {
          success: true,
          candidates,
          total: candidates.length,
          scanned: rows.length,
        });
      } catch (error) {
        context.error('listRehostCandidates failed:', error);
        return json(500, { error: 'Failed to list re-host candidates' });
      }
    },

    /** POST /api/cms/content/rehost-images — publisher. */
    async rehostImages(request, context) {
      const auth = await guard.requireRole(request, 'publisher');
      if (auth.error) return auth.error;
      const { user } = auth;
      try {
        const body = (await request.json().catch(() => null)) || {};
        const contentIds = normalizeContentIds(body.contentIds);
        if (!contentIds || contentIds.length === 0) {
          return json(400, { error: 'contentIds array of strings required' });
        }
        if (contentIds.length > MAX_BATCH) {
          return json(400, { error: `contentIds limited to ${MAX_BATCH} per request` });
        }

        const results = [];
        for (const contentId of contentIds) {
          const r = await processPublishContent(contentId, { user, reason: REHOST_IMAGES_REASON });
          results.push(toRehostResult(contentId, r));
        }
        const rehosted = results.filter((r) => r.inlineImages !== undefined).length;
        const skipped = results.filter((r) => r.skipped).length;
        const failed = results.filter((r) => r.error).length;
        // Counts only — the summaries name hosts at most, the log names less.
        log.log?.(
          `[rehostImages] ${contentIds.length} requested: ${rehosted} re-hosted, ${skipped} skipped, ${failed} failed`
        );
        return json(200, { success: true, results, rehosted, skipped, failed });
      } catch (error) {
        return errorResponse(context, 'Failed to re-host images', error, 500, request);
      }
    },
  };
}
