/**
 * public-read-images.js — the curated image reads. Each read takes the store and the
 * request; public-reads.js wires them into createPublicReadHandlers.
 */
import { errorFacts } from './http/error-response.js';
import {
  CURATED_IMAGE_BATCH_MAX,
  CURATED_IMAGE_HIT_CACHE_SECONDS,
  CURATED_IMAGE_MISS_CACHE_SECONDS,
  json,
} from './public-read-rules.js';

/**
 * GET /api/public/curated-image/{articleId} — the cached hero image for a
 * curated news article.
 *
 * This exists because the public news pages were calling an EDITOR-gated
 * endpoint. #63 moved the cache lookup off an anonymous Firestore read onto
 * `getJSON('cms/images/curated/...')`, which runs through `acquireApiToken`
 * and throws without an MSAL account — so on `/{provider}/news`, an
 * anonymous visitor's lookups all failed and no curated imagery rendered
 * where cached images used to (T-210).
 *
 * **Only `imageUrl` is returned, never the document.** The admin endpoint
 * answers with the whole thing, and the whole thing is not public: a
 * `curated_article_images` document also carries `storagePath` (an internal
 * blob path) and the prompt metadata the gallery writes — `promptSet`,
 * `promptName`, `promptTemplateVersion`, `theme`, `style`. That is
 * editorial IP and internal layout, and none of it is needed to render an
 * `<img>`.
 *
 * Archived images are withheld, which the finding did not ask for. It is a
 * deliberate hardening in the same direction as the module's other filters:
 * `archived` is set by an admin explicitly retiring an image, and the only
 * thing this can do is stop a retired image appearing on a public page.
 *
 * Absence answers 200 with `imageUrl: null`, not 404. The caller's question
 * is "is there a cached image?", and "no" is a successful answer to it —
 * matching the admin endpoint, whose `item: null` the hook already treats
 * as "not cached" rather than as an error.
 */
export async function getCuratedImage(store, request, context) {
  try {
    const id = String(request.params.id || '').trim();
    if (!id) return json(400, { error: 'articleId required' });

    const doc = await store.readDoc('curated_article_images', id, id);
    // Trimmed, so a whitespace-only value is uncached rather than being
    // handed to the browser as an `<img src>` that resolves to the page
    // itself.
    const stored = typeof doc?.imageUrl === 'string' ? doc.imageUrl.trim() : '';
    const imageUrl = doc && doc.archived !== true && stored ? stored : null;

    return json(
      200,
      { success: true, imageUrl },
      imageUrl ? CURATED_IMAGE_HIT_CACHE_SECONDS : CURATED_IMAGE_MISS_CACHE_SECONDS
    );
  } catch (error) {
    context.error('publicGetCuratedImage failed:', errorFacts(error));
    return json(500, { error: 'Failed to get curated image' });
  }
}

/**
 * GET /api/public/curated-images?ids=a,b,c — the same lookup as
 * `getCuratedImage`, for a whole grid in one round trip (T-739).
 *
 * The news grid rendered twelve cards and issued twelve
 * `public/curated-image/{id}` requests, on a route that had already
 * fetched the feed. Twelve round trips before any cover appeared.
 *
 * **Every disclosure rule of the single-id route applies here unchanged**,
 * and that is the property to protect if this is ever edited: only
 * `imageUrl` is returned, never the document — a `curated_article_images`
 * row also carries `storagePath` and the gallery's prompt metadata
 * (`promptSet`, `promptName`, `promptTemplateVersion`, `theme`, `style`),
 * which is editorial IP and internal layout. Archived images are withheld,
 * and a whitespace-only value is treated as uncached rather than handed to
 * a browser as an `<img src>` that resolves to the page itself.
 * `public-reads.curated-images.test.js` asserts the two routes agree, so a
 * change to one that is not made to the other fails.
 *
 * Absence is a null entry, not an omission and not a 404: the caller's
 * question is "which of these have covers?", and "this one does not" is a
 * successful answer that the client needs in order to stop asking.
 *
 * Bounded at `CURATED_IMAGE_BATCH_MAX`. An unbounded `ids` list on an
 * anonymous endpoint is a point-read amplifier — one request costing as
 * many reads as the caller cares to name — which is the shape of the
 * fan-out T-711 removed from the ops-health probe.
 */
export async function getCuratedImages(store, request, context) {
  try {
    const raw = String(request.query?.get?.('ids') ?? '').trim();
    if (!raw) return json(400, { error: 'ids required' });

    const ids = [
      ...new Set(
        raw
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      ),
    ];
    if (ids.length === 0) return json(400, { error: 'ids required' });
    if (ids.length > CURATED_IMAGE_BATCH_MAX) {
      return json(400, { error: `At most ${CURATED_IMAGE_BATCH_MAX} ids per request` });
    }

    // One query rather than N point reads — the same shape T-711 applied
    // to the orphan probe. `images` is keyed by id so a caller can tell
    // "no cover" from "not asked about".
    const rows = await store.queryDocs(
      'curated_article_images',
      'SELECT c.id, c.imageUrl, c.archived FROM c WHERE ARRAY_CONTAINS(@ids, c.id)',
      [{ name: '@ids', value: ids }]
    );

    const byId = new Map((rows || []).map((row) => [row.id, row]));
    const images = {};
    let anyHit = false;
    for (const id of ids) {
      const doc = byId.get(id);
      const stored = typeof doc?.imageUrl === 'string' ? doc.imageUrl.trim() : '';
      const imageUrl = doc && doc.archived !== true && stored ? stored : null;
      images[id] = imageUrl;
      if (imageUrl) anyHit = true;
    }

    // The shorter miss TTL when nothing was found, so a grid whose covers
    // are still generating is not pinned to the long hit TTL.
    return json(
      200,
      { success: true, images },
      anyHit ? CURATED_IMAGE_HIT_CACHE_SECONDS : CURATED_IMAGE_MISS_CACHE_SECONDS
    );
  } catch (error) {
    context.error('publicGetCuratedImages failed:', errorFacts(error));
    return json(500, { error: 'Failed to get curated images' });
  }
}
