/**
 * cloudflare/prerequisites.js — the two things the Cloudflare page's routes
 * need before they can call Cloudflare (#1905), by the names the answers use
 * in `missing`, and the sentence that says which is missing and where it
 * comes from. The token is pasted by the owner on Integrations → Keys; the
 * zone id is never pasted, Terraform sets it.
 *
 * It imports nothing, so the browser's mirror test
 * (frontend/src/components/admin/cloudflare/cloudflareView.test.js) reads it
 * directly and fails when the two lists of names differ.
 */

/** What each missing thing is and where it comes from, by its name in `missing`. */
export const PREREQUISITES = Object.freeze({
  token: 'the Cloudflare admin token (CLOUDFLARE_ADMIN_TOKEN) has not been pasted: paste it on Integrations → Keys, in the row CLOUDFLARE-ADMIN-TOKEN',
  zoneId:
    "the zone id (CF_ZONE_ID) is not set on the function app, or is not a zone id: Terraform sets it on the next apply of the hcw-azure workspace, so it is not pasted on the Keys tab",
});

/** The sentence for a "not set up" answer, naming exactly what is missing and where it comes from. */
export function notConfiguredMessage(missing) {
  const parts = missing.map((name) => PREREQUISITES[name]).filter(Boolean);
  if (parts.length === 0) return 'Cloudflare is not set up yet.';
  if (parts.length === 1) return `Cloudflare is not set up yet: ${parts[0]}.`;
  return `Cloudflare is not set up yet. Two things are missing: ${parts.join('; and ')}.`;
}
