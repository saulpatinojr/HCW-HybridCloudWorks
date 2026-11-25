/** The design entries of the content manifest (build-content-manifest.mjs). */
import { providerOf, slugOf, STRICT_SLUG } from './content-manifest-items.mjs';
import { PUBLIC_CONTENT_DETAIL_FIELDS } from '../../functions/src/lib/public-reads.js';

/**
 * Providers with a design page, `/<provider>/architecture-designs/<slug>`.
 * Mirrors ProviderArchitectureDispatcher in frontend/src/App.jsx, which the
 * test holds it to: any other provider's design address is the app's 404
 * page, so a design there gets no page built.
 */
export const DESIGN_PROVIDERS = Object.freeze(['aws', 'azure', 'gcp', 'finops', 'vmware']);

export const isDesignItem = (item) => String(item?.type || '').toLowerCase() === 'architecture';

/**
 * The design routes and seeds (#1628), onto `routes`, `data` and `skipped`.
 * `architecture:<slug>` is the key ArchitectureDetailTemplate reads, as
 * `usePublicData` keys it.
 *
 * PROJECTED TO WHAT `public/content` ANSWERS, PUBLIC_CONTENT_DETAIL_FIELDS,
 * the same list the route projects to (DESIGN_FIELDS in
 * functions/src/lib/public-content-manifest.js), imported rather than
 * copied. The route's projection is the boundary; this one is the second
 * layer, as `project` is for articles, so a field a route regression let
 * through still never reaches the committed manifest. Not narrower than
 * that list: a page built from a seed does not fetch again in the browser,
 * so a narrower seed would show readers less than the live page does.
 *
 * A design whose address repeats one of the built-in designs
 * (frontend/src/data/architectures.js) is still listed: the pre-render drops
 * the repeated route, and the seed is the API's copy, which the page lays
 * over the built-in one exactly as it does in the browser.
 */
/** Keep only the public detail fields, and only when present. */
function projectDesign(item) {
  const out = {};
  for (const field of PUBLIC_CONTENT_DETAIL_FIELDS) {
    if (item[field] !== undefined) out[field] = item[field];
  }
  return out;
}

export function addDesigns(designs, { routes, data, skipped }) {
  for (const item of designs) {
    const slug = slugOf(item);
    if (!slug || !STRICT_SLUG.test(slug)) {
      skipped.push(`design ${item?.id || '(no id)'}: no usable slug`);
      continue;
    }
    const provider = providerOf(item);
    if (!provider || !DESIGN_PROVIDERS.includes(provider)) {
      const named = item.cloudProvider || item['Cloud Provider'] || 'unset';
      skipped.push(`design ${slug}: no design page for provider (${named})`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(data, `architecture:${slug}`)) {
      // One key per slug, whatever the provider: the page reads
      // `architecture:<slug>`. First one in wins, as for articles.
      skipped.push(`design ${slug}: duplicate slug (item ${item.id}); first occurrence kept`);
      continue;
    }
    routes.push(`/${provider}/architecture-designs/${slug}`);
    data[`architecture:${slug}`] = projectDesign(item);
  }
}
