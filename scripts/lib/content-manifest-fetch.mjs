/** Reading the published content from the site's API for build-content-manifest.mjs, and saying plainly why a read failed. */

/**
 * Fetch the published corpus from the Function App's origin (T-718).
 *
 * THIS USED TO QUERY COSMOS DIRECTLY, and that one workload is what held the
 * `0.0.0.0` sentinel open on the Cosmos firewall — the switch admitting any
 * workload in any Azure tenant at the network layer. Moving the query into the
 * app, which runs inside the subnet the firewall already admits, is what let
 * that close. See docs/decisions/0025-cosmos-firewall-datacenter-sentinel.md.
 *
 * THE ORIGIN HOSTNAME, NOT THE CLOUDFLARE ONE. A GitHub runner asking the
 * public host is served Cloudflare's Bot Fight Mode interstitial and a 403
 * (#175, and the reason ADR 0024 exists). The workflow opens a per-run App
 * Service IP allow rule for its own address instead and asks the origin
 * directly — the same window deploy-functions.yml already uses to probe
 * /api/health.
 *
 * No credential of any kind: the route is anonymous, and reaching it is the
 * authorization. That is why the window closes in an always() step.
 */
/**
 * What a non-OK status from the manifest route actually means.
 *
 * SEPARATED AND EXPORTED so the wording is asserted rather than trusted. The
 * previous version said a 403 meant the origin window and "anything else is the
 * app itself", and on 2026-08-31 that sent the investigation at a Function App
 * that was entirely healthy.
 *
 * 403 — the per-run origin allow rule is shut or has not propagated, so the
 * runner's address is not admitted. Re-running is the answer.
 *
 * 404 — THE HOST ANSWERED. It is up; this route is not on the revision it is
 * running. That is a deploy that has not happened, not an outage, and the two
 * look nothing alike once said out loud. It happened exactly this way: the
 * route arrived with #277 at 2026-08-30 02:45 UTC, the last Deploy Functions
 * run was 01:21 UTC on a commit that predates it, and the nightly job failed on
 * 08-30 and 08-31 while Monitor Functions Registered reported 121 registered
 * functions and a clean bill of health. That monitor was not wrong — the
 * functions it counted were the pre-#277 set, and counting cannot see a missing
 * one. `deploy-functions.yml` is workflow_dispatch only, so merging a route
 * never deploys it.
 */
export function describeFetchFailure(status, url) {
  if (status === 403) {
    return (
      `${url} answered 403. The per-run origin window is closed or has not propagated, so this ` +
      "runner's address is not admitted to the origin. Re-run rather than widening anything."
    );
  }
  if (status === 404) {
    return (
      `${url} answered 404. The HOST answered, so it is up — this ROUTE is not on the revision ` +
      'it is running, which is a deploy that has not happened rather than an outage. Check that ' +
      'Deploy Functions has run on a commit containing ' +
      'functions/src/functions/public-content-manifest.js: ' +
      'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/deploy-functions.yml'
    );
  }
  return (
    `${url} answered ${status}. Neither 403 (the origin window) nor 404 (a route missing from ` +
    'the deployed revision), so this is the app itself.'
  );
}

export async function fetchPublished() {
  const origin = process.env.FUNCTION_ORIGIN;
  if (!origin) {
    throw new Error(
      'FUNCTION_ORIGIN is not set. Expected the Function App origin hostname, e.g. ' +
        'https://func-site-prod-cus-01.azurewebsites.net — NOT the Cloudflare host, which ' +
        'answers datacenter clients with a bot interstitial.'
    );
  }

  const url = `${origin.replace(/\/+$/, '')}/api/public/content-manifest`;

  // TIMED OUT, and the reason is the firewall rather than politeness. The
  // workflow opens a per-run origin allow rule and closes it in an always()
  // step — but always() runs when the STEP ends, and a fetch with no timeout
  // does not end. A DNS or TLS stall would hold this open until the job's own
  // timeout, leaving a dead runner's address admitted to the origin for as long
  // as it took. A bounded failure closes the window on schedule.
  //
  // Two minutes because the response is the whole published corpus — hundreds
  // of kilobytes of article bodies — not a health check.
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch((error) => {
    if (error?.name === 'TimeoutError') {
      throw new Error(
        `${url} did not respond within 120s. The origin window is closed by the always() step ` +
          'regardless; re-run rather than widening the timeout unless the corpus has genuinely ' +
          'outgrown it.'
      );
    }
    throw error;
  });
  if (!response.ok) throw new Error(describeFetchFailure(response.status, url));

  const body = await response.json();
  if (!body?.success || !Array.isArray(body.items)) {
    throw new Error(`${url} returned an unexpected body: ${JSON.stringify(body).slice(0, 200)}`);
  }
  // `sections` is optional: a deployed revision that predates it simply does
  // not send one, and `buildManifest` then counts what it can itself. So are
  // `interviews` (ADR 0040): a revision without them pre-renders none. And
  // `designs` (#1628): a revision without them still sends its designs among
  // the articles, so null (not []) tells `buildManifest` to keep them there.
  // Present but not a list is refused: a revision that sends the field has
  // already taken designs out of `items`, so treating it as absent would
  // drop every design while the log said they were among the articles.
  if (body.designs !== undefined && !Array.isArray(body.designs)) {
    throw new Error(`${url} returned designs that are not a list: ${JSON.stringify(body.designs).slice(0, 200)}`);
  }
  return {
    items: body.items,
    sections: body.sections,
    interviews: Array.isArray(body.interviews) ? body.interviews : [],
    designs: Array.isArray(body.designs) ? body.designs : null,
  };
}
