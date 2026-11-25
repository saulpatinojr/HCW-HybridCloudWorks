/**
 * publish-slugs.js — the slug and the public address of a published page:
 * how a slug is made, checked against the other holders of the same URL, and
 * turned into the page's path and URL (issue #400, #1628). Re-exported by
 * publish.js, whose header describes the pipeline.
 */
import { resolvePublishContext } from './publish-steps.js';

/**
 * Lowercase words joined by single hyphens, at most 80 characters. Runs of
 * hyphens collapse and none is left at either end, including after the cut,
 * so the result always passes the strict address rule (STRICT_SLUG in
 * scripts/build-content-manifest.mjs). Before #1628 a title like `A - B`
 * gave `a---b`, and a cut at 80 that landed on a hyphen left a `--` once the
 * suffix was added.
 */
export function slugify(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');
}

// Lowercase, letters and digits only: a document id mixes cases, and an
// address must not (#1628). Taken from AFTER the 8 characters an address
// already carries (article-topics.js), up to 6 of them, so two pages whose
// ids share those 8 get different suffixes whatever the id's length. An id
// of 8 characters or fewer has nothing after them and keeps its first 6.
const slugSuffix = (id = '') => {
  const clean = String(id || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const fromId = clean.length > 8 ? clean.slice(8, 14) : clean.slice(0, 6);
  return fromId || Date.now().toString(36).slice(-6);
};

/**
 * The slug a publish writes. Pure: the caller runs the probe, this decides.
 *
 * WHAT WENT WRONG (issue #400). Three published articles share one slug, so
 * two of them have no URL. None of the three was assigned that slug here: they
 * arrived from Site-Main already `contentStatus: published`, and the branch
 * that reuses a stored slug never probed at all. Two things follow, and both
 * are the rules below:
 *
 *   - EVERY publish probes, republishes included. Keeping the URL an article
 *     already serves is right; keeping one another document holds is not.
 *   - The probe reads `c.slug` AND `c.Slug`. They are two fields with two
 *     different values on ten of the twenty-two published articles, and the
 *     manifest routes on `slug || Slug` (scripts/build-content-manifest.mjs),
 *     so a document whose site slug lives in `Slug` alone holds a URL that
 *     `c.slug` on its own cannot see.
 *
 * WHAT THIS STILL DOES NOT PROVE, said plainly. A clean probe is a read, and a
 * read cannot establish that a slug is free at the moment of the write. Three
 * callers publish independently — the batch route, the scheduled publisher
 * (lib/scheduled-publish.js) and the Telegram approve worker
 * (functions/publish-jobs.js) — so two first publishes of two documents whose
 * titles slugify alike can both probe clean and both write the bare slug. That
 * residual is deliberate and it is bounded: the manifest build refuses to route
 * the duplicate (#386), so one article is temporarily unreachable rather than
 * two articles being served at one URL, and `scripts/report-slug-collisions.mjs`
 * names it from a checkout. Renaming one article in the CMS recovers it.
 * Suffixing every slug instead would close that window and cost every future
 * URL its readable form — and once articles are indexed at suffixed URLs, going
 * back breaks links, which is the harm that does not recover. If that trade is
 * ever wanted, it is one line here: return the suffixed slug unconditionally
 * when `reuse` is false.
 *
 * `holders` is what the probe found, or `null` when it could not answer. The
 * two paths read `null` differently, on purpose:
 *
 *   - a FIRST assignment treats it as "not established" and takes the
 *     always-suffixed slug — ugly but always unique, and the publish is never
 *     blocked by a lookup failure (the source's rule, kept);
 *   - a REPUBLISH keeps the URL the article already serves, because a failed
 *     lookup is not evidence of a clash and inventing a new URL out of one
 *     would break every inbound link to an article that was fine.
 *
 * @param {object} args
 * @param {string} args.candidate slugify(title) on a first publish, the stored slug on a republish
 * @param {string} args.contentId
 * @param {boolean} [args.reuse] true when the candidate is the slug this document already serves
 * @param {string[]|null} [args.holders] ids holding the candidate, or null when not established
 */
export function resolveSlug({ candidate = '', contentId = '', reuse = false, holders = null }) {
  // A guard for direct callers, NOT what keeps the read and the write about
  // one string — processPublishContent normalises before it probes, because a
  // trim here alone would leave the probe asking about a different value than
  // the one written. Keep the two in step if either moves.
  const base = String(candidate || '').trim();
  if (!base) return slugSuffix(contentId);
  const heldByAnother = Array.isArray(holders) && holders.some((id) => id && id !== contentId);
  if (heldByAnother) return `${base}-${slugSuffix(contentId)}`;
  if (!reuse && !Array.isArray(holders)) return `${base}-${slugSuffix(contentId)}`;
  return base;
}

/**
 * The curated path a publish writes, and with it `slugPageUrl`,
 * `publishedUrl` and `publicUrl`.
 *
 * The stored path wins, because it is the URL the article already serves and a
 * hand-curated one has to survive a republish — but only while it still names
 * the slug being written. When a republish moves off a slug another document
 * holds (resolveSlug), a stored path taken unconditionally would keep
 * advertising the contested URL while `slug` said otherwise: the article would
 * move and its own links would not, which is the bug wearing a different hat.
 * Found by Copilot's review of #403 on the first revision of this change.
 *
 * The LAST SEGMENT is replaced rather than the whole path rebuilt, so a curated
 * path sitting under some other prefix keeps that prefix. With neither a stored
 * path nor a provider to derive one from there is no path at all, exactly as
 * before.
 *
 * ALWAYS ABSOLUTE. Three frontend hooks infer an article's provider with
 * `String(doc.curatedSubpagePath || '').split('/')[1]` — useBlogData.js,
 * useFrameworkData.js and useProviderLandingContent.js — and that index is the
 * provider only when the path starts with a slash. On a relative `aws/x` it
 * reads the SECOND segment instead and the article lands under the wrong
 * provider, silently. So every path returned here is normalised, not only the
 * one whose last segment was replaced: a stored relative path echoed back
 * unchanged mis-infers exactly the same way.
 */
export function resolveCuratedSubpagePath({
  stored = '',
  provider = '',
  section = '',
  slug = '',
} = {}) {
  const raw = String(stored || '').replace(/\/+$/, '');
  if (!raw) {
    return provider && slug ? `/${String(provider).toLowerCase()}/${section}/${slug}` : null;
  }
  const segments = (raw.startsWith('/') ? raw : `/${raw}`).split('/');
  if (!slug || segments[segments.length - 1] === slug) return segments.join('/');
  segments[segments.length - 1] = slug;
  return segments.join('/');
}

/**
 * The one query that answers "who holds this URL?", and the one function that
 * runs it. Lifted out of the handler closure so it can be tested directly:
 * reading `c.Slug` as well as `c.slug` is half of what #403 fixed, and it was
 * previously pinned only through the pipeline that calls it.
 *
 * BOTH FIELDS. Cosmos property lookup is case-sensitive, so `c.slug` alone
 * cannot see a document whose site slug is in `Slug` — and the manifest routes
 * on `slug || Slug` (scripts/build-content-manifest.mjs), so such a document
 * does hold the URL.
 *
 * TOP 2 is enough: at most one of the rows can be the document asking, so two
 * rows establish that somebody else holds it.
 */
export const SLUG_HOLDERS_QUERY = 'SELECT TOP 2 c.id FROM c WHERE c.slug = @slug OR c.Slug = @slug';

/**
 * @param {{ queryDocs: Function }} store
 * @param {string} slug
 * @returns {Promise<string[]>} ids holding `slug` in either field
 */
export async function querySlugHolders(store, slug) {
  const rows = await store.queryDocs('content', SLUG_HOLDERS_QUERY, [
    { name: '@slug', value: slug },
  ]);
  return (Array.isArray(rows) ? rows : []).map((row) => row?.id).filter(Boolean);
}

/**
 * The slug an operator's input would become — `slugify` and nothing else, so
 * they cannot type a value this pipeline would never produce. `slugify` is
 * idempotent (its output is `[a-z0-9-]` only, no spaces, already <= 80 chars),
 * so re-normalising a stored slug is a no-op and a suggestion taken verbatim
 * survives unchanged.
 */
export function normalizeSlugInput(value) {
  return slugify(String(value ?? ''));
}

/**
 * SET_SLUG_REASON's decision, pure. Compare with `resolveSlug`, which is the
 * publish path's answer to a related question: that one never refuses, because
 * refusing would block a publish. This one refuses three ways.
 *
 * `holders` is what the probe found, or null when it could not answer. NOT AN
 * ARRAY IS A REFUSAL here, the opposite of what resolveSlug does with the same
 * value, and the difference is the whole point: a publish must not lose an
 * article's URL to a transient query error, but assigning a NEW slug on an
 * unverified probe is how one URL ends up held by two documents. The operator
 * can simply press the button again.
 *
 * It answers only "may this be written?". Whether anything WOULD change is
 * `buildSlugPublishUpdate`'s empty diff, which is the more exact question: on
 * these articles the URL fields can be stale even when the slug is already
 * right, and a slug comparison alone would call that a no-op.
 *
 * @param {object} args
 * @param {object} args.contentData the document, for the slug it is moving off
 * @param {string} args.contentId
 * @param {string} args.slug the ALREADY-NORMALISED candidate
 * @param {string[]|null} args.holders ids holding it, or null when unanswered
 */
export function evaluateSlugChange({
  contentData = {},
  contentId = '',
  slug = '',
  holders = null,
}) {
  if (!slug) {
    return {
      ok: false,
      status: 400,
      error: 'slug must contain at least one letter or digit once normalised',
    };
  }
  if (!Array.isArray(holders)) {
    return {
      ok: false,
      status: 503,
      error: 'Could not check whether that slug is already in use. Nothing was changed.',
    };
  }
  const heldBy = holders.filter((id) => id && id !== contentId);
  if (heldBy.length > 0) {
    return {
      ok: false,
      status: 409,
      error: `Slug '${slug}' is already held by ${heldBy.join(', ')}. Nothing was changed.`,
      heldBy,
    };
  }
  return { ok: true, slug, from: contentData.slug || contentData.Slug || null };
}

/**
 * The curated path a set-slug would write, or null when none can be computed —
 * which happens when the document has no stored `curatedSubpagePath` AND no
 * provider can be inferred from it (`resolvePublishContext` reads
 * landingProvider, 'Cloud Provider', cloudProvider, provider and Provider).
 *
 * Split out so `republishWithSlug` can ask that question BEFORE it writes
 * anything, and refuse. Owner decision on #412, 2026-09-07: a set-slug that
 * cannot compute the path has not done the thing it was asked to do, and
 * completing halfway leaves exactly the state this route was built to remove —
 * a panel reporting a move beside a link still pointing at the old URL. The
 * ordinary publish write keeps its conditional spread, and that divergence is
 * intended rather than an inconsistency to iron out: a publish is best-effort
 * on a document being published, where a missing path is one incomplete field
 * among many, while a set-slug is a surgical correction to a URL, and a
 * surgical correction that cannot compute the URL should stop and say so.
 *
 * The builder below shares this so the value the branch checks and the value
 * it writes are one computation's answer.
 */
export function resolveSlugPublishPath({ contentData = {}, slug = '' }) {
  const ctx = resolvePublishContext(contentData, {});
  return resolveCuratedSubpagePath({
    stored: contentData.curatedSubpagePath,
    provider: ctx.resolvedLandingProvider,
    section: ctx.curatedSection,
    slug,
  });
}

/**
 * Everything a slug change implies, and nothing else: the cased pair and the
 * four URL fields, derived through `resolveCuratedSubpagePath` and
 * `toPublicUrl` — the same two functions the publish write uses, so a
 * corrected URL and a published URL can never be built by different rules.
 *
 * The spread is still guarded, because this function is pure and a direct
 * caller may hand it a document with no resolvable path. On the set-slug path
 * that guard is unreachable: `republishWithSlug` refuses such a document
 * before it gets here (see `resolveSlugPublishPath`), so every update this
 * produces for that route carries all four.
 *
 * BOTH `slug` AND `Slug`, to one value. The probe reads `c.slug OR c.Slug`, so
 * a document holds every distinct value across the pair: writing only `slug`
 * would leave the article still holding its old URL in `Slug`, blocking any
 * other article that legitimately wants it, and would leave the pair divergent
 * — the exact shape (ten of the twenty-two published articles) that hid #400.
 * The publish write already sets them as a pair; this keeps that invariant
 * rather than becoming the one writer that breaks it.
 *
 * Keys whose value the document already has are dropped, so the caller can
 * tell a real change from a no-op by looking at what is left.
 */
export function buildSlugPublishUpdate({ contentData = {}, slug = '' }) {
  const curatedSubpagePath = resolveSlugPublishPath({ contentData, slug });
  const update = {
    slug,
    Slug: slug,
    ...(curatedSubpagePath && {
      curatedSubpagePath,
      slugPageUrl: toPublicUrl(curatedSubpagePath),
      publishedUrl: toPublicUrl(curatedSubpagePath),
      publicUrl: toPublicUrl(curatedSubpagePath),
    }),
  };
  return Object.fromEntries(
    Object.entries(update).filter(([key, value]) => contentData[key] !== value)
  );
}

export function toPublicUrl(pathValue) {
  if (!pathValue) return null;
  const path = String(pathValue).startsWith('/') ? String(pathValue) : `/${String(pathValue)}`;
  return `https://hybridcloudworks.com${path}`;
}

/**
 * The public URL a content document already carries, in the precedence the
 * Social Hub uses. '' when the document has none (never guessed). Shared by
 * the social-caption trigger and the related-posts interlinker.
 */
export function publicUrlOf(data = {}) {
  if (data.publishedUrl) return data.publishedUrl;
  if (data.publicUrl) return data.publicUrl;
  const path = data.curatedSubpagePath || data.slugPageUrl || '';
  return path ? toPublicUrl(path) : '';
}
