/** Which provider and address (slug) a published item has, for build-content-manifest.mjs. */

/**
 * Providers with a `/:provider/blog/:slug` route. Mirrors VALID_PROVIDERS in
 * frontend/src/context/ProviderContext.jsx, which the test holds it to: a
 * provider missing here gets no article pages pre-rendered and no local
 * section counts. Docker since #776, when its blog detail route arrived.
 */
export const PROVIDERS = Object.freeze([
  'azure',
  'aws',
  'gcp',
  'github',
  'terraform',
  'finops',
  'vmware',
  'ansible',
  'docker',
]);
/** The provider segment an article's URL lives under. */
export function providerOf(item) {
  const raw = String(item.cloudProvider || item['Cloud Provider'] || '')
    .toLowerCase()
    .trim();
  return PROVIDERS.includes(raw) ? raw : null;
}

export function slugOf(item) {
  return String(item.slug || item.Slug || '').trim();
}

/**
 * The address of every page the build writes (articles, interviews and
 * designs): lowercase words joined by single hyphens. The slug becomes a folder of the built site, so a slash, a
 * dot or anything else that could change that folder never reaches it.
 * One pattern for all three, so they cannot drift apart. It matches `SLUG` in
 * functions/src/lib/interviews/schema.js, which the test holds it to.
 */
export const STRICT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Articles follow STRICT_SLUG too since 2026-11-12 (#1628): the 23 live
 * articles were renamed to `<topic>-<id>` addresses, the last mixed-case ones
 * among them. Kept as its own name because callers and tests import it.
 */
export const ARTICLE_SLUG = STRICT_SLUG;
