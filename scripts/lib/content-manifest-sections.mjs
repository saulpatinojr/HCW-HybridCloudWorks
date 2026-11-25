/** Counting the manifest's entries per section and comparing them with the server's sections (build-content-manifest.mjs). */
import { providerOf, PROVIDERS } from './content-manifest-items.mjs';

/**
 * Sections countable from the corpus this script is handed, keyed by the `type`
 * their page selects on.
 *
 * THIS IS THE FALLBACK PATH, not the main one, and it is approximate. The
 * manifest route counts every countable section across every container a
 * section page reads (functions/src/lib/public-section-counts.js) and
 * `buildManifest` prefers its answer. What is below runs only when the deployed
 * revision predates that field, so that merging the route and deploying it can
 * happen in either order without the five frameworks pages returning to the
 * sitemap in between.
 *
 * Approximate in a specific, measured way. `useFrameworkData` does NOT read the
 * `content` container alone: like useBlogData and useCoderCornerData it falls
 * back to the legacy `blogs` container when `content` yields nothing for a
 * provider, and this script is handed `content` only. That gap is survivable
 * rather than harmless — on 2026-09-07 `blogs` held five published documents,
 * all `type: blog` and all slug-duplicates of `content` documents, so it puts
 * nothing on any page and no framework in any count. `coder-corner` and `code`
 * are still absent here despite reading the same two containers, because their
 * pages had nothing in `content` at all, so this path's zero for them would
 * rest entirely on a container it cannot see.
 *
 * `architecture-designs` joins on the same terms and with a stronger claim than
 * frameworks has. The AWS and Azure architecture pages do fall back to `blogs`,
 * so this path's view of them is the same approximation as above — but a zero
 * counted here only drops a route whose `architecture-blueprints.js` is also
 * empty (`sitemapRoutes` in frontend/scripts/prerender.mjs), and the one
 * provider whose module is empty is VMware, whose page reads `content` and
 * nothing else. For the only route this count can act on, the corpus this
 * script is handed IS the corpus the page reads.
 */
export const SECTION_TYPES = Object.freeze({
  frameworks: 'framework',
  'architecture-designs': 'architecture',
});

/**
 * Published items per provider per section, so the pre-render can leave a
 * section page with nothing in it out of the sitemap (issue #373).
 *
 * Returns null when no item carries a non-empty string `type` — the deployed
 * manifest route predates the field, or the corpus carries the field but no
 * value — so a consumer cannot mistake "unknown" for "zero". A `null` or empty
 * `type` counts as absent for the same reason.
 * `_unattributed` counts items of the section's type that name no recognised
 * provider; the frameworks page infers a provider from titles and URLs as a
 * last resort, so while that count is non-zero no provider's zero is trusted.
 */
const hasType = (item) => typeof item?.type === 'string' && item.type.trim() !== '';

export function sectionCounts(items) {
  if (!items.some(hasType)) return null;
  const sections = {};
  for (const provider of [...PROVIDERS, '_unattributed']) {
    sections[provider] = Object.fromEntries(Object.keys(SECTION_TYPES).map((s) => [s, 0]));
  }
  for (const item of items) {
    if (!hasType(item)) continue;
    const type = item.type.trim().toLowerCase();
    for (const [section, wanted] of Object.entries(SECTION_TYPES)) {
      if (type !== wanted) continue;
      sections[providerOf(item) || '_unattributed'][section] += 1;
    }
  }
  return sections;
}

/**
 * A `sections` map the route sent, or null when it sent nothing usable.
 *
 * Anything that is not a plain object is treated as absent rather than
 * repaired: the consumer reads `sections[provider][section]`, and a value that
 * is not that shape must not be allowed to answer `undefined` and be mistaken
 * for a section this build simply has no count for.
 */
export function serverSections(sections) {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) return null;
  return sections;
}

/**
 * The run-log line saying where the section counts came from — or that there
 * are none.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the one worth a function. The
 * first version of this line printed "counted frameworks locally" whenever the
 * route sent nothing, but `sectionCounts()` returns null when no item carries a
 * `type` at all, and then nothing was counted: `manifest.sections` is null and
 * the pre-render drops no route. That is a plausible state during exactly the
 * upgrade window this message exists to narrate — an older deployed revision
 * that sends neither `sections` nor `type` — so the message would have claimed
 * a count that did not happen, in the one situation someone reads it.
 *
 * Worth asserting rather than trusting, for the same reason
 * `describeFetchFailure` is: nobody watches this run, they read the line it
 * leaves behind, and a wrong line sends them somewhere else.
 *
 * The per-provider figure is read off whichever provider the map happens to
 * carry first rather than off `azure` by name, so a map that never mentions
 * Azure still reports its real width.
 *
 * @param {object|null} sections the counts that ended up on the manifest
 * @param {boolean} fromRoute whether the route supplied them
 */
export function describeSectionCounts(sections, fromRoute) {
  if (fromRoute) {
    const providers = Object.keys(sections || {});
    const width = providers.length ? Object.keys(sections[providers[0]] || {}).length : 0;
    return `sections: from the route — ${width} per provider, across every container a section page reads`;
  }
  if (sections) {
    return 'sections: route sent none — counted frameworks locally from the corpus; deploy Functions for the rest';
  }
  return 'sections: none — the route sent none and no item carries a type, so no section page leaves the sitemap this build';
}
