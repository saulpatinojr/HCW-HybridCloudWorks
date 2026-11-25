#!/usr/bin/env node
/**
 * Deployed smoke test — once the top open item in TODO.md's work order, now
 * a standing tool.
 *
 * Everything below the Critical line in the review was authored in an
 * environment that could reach neither a deployed Function App nor a Cosmos
 * account, so every fix was authored-but-unverified until this ran against the
 * real thing. The checks are the specific assumptions those fixes rested on,
 * in priority order — not a generic ping.
 *
 * Tiers (each skippable, so partial environments still give partial signal):
 *
 *   1. ANONYMOUS API SURFACE — no credentials, no side effects.
 *      Needs --base <url> (or SMOKE_BASE_URL), e.g.
 *        node smoke-deployed.mjs --base https://api-azure.hybridcloudworks.com/api
 *      Use the Cloudflare host, NOT <app>.azurewebsites.net: the Function App
 *      origin is restricted to Cloudflare IP ranges, so a direct call answers
 *      403 and every tier below reads as a broken deployment.
 *
 *      The deploy workflow does call the origin, from a runner that has a
 *      temporary allow rule, and that rule reaches the App Service front ends
 *      one at a time. A request that lands on a front end without it is
 *      refused with the platform's own 403 (the `x-ms-forbidden-ip` header),
 *      and until 2026-10-23 that failed a healthy deploy on one request (run
 *      39997538990: health 200, content list 403, detail read 200). Every
 *      request therefore goes through `originFetch`, which waits and retries
 *      that one refusal, within a budget shared by the whole run. An app
 *      answer of 403 (the guards, the CORS refusal) is never retried: those
 *      checks expect it.
 *
 *   2. COSMOS CONDITIONAL PATCH (--cosmos) — THE flagged assumption from
 *      T-204: that a failed patch predicate surfaces through the JS SDK as
 *      code 412 and a missing document as 404. Documented REST behaviour, but
 *      the JS SDK's own docs omit conditional patch, so nothing has executed
 *      it. Writes one document with a smoke- prefixed id into
 *      submission_quota (container TTL 7200 s cleans up even if we crash) and
 *      deletes it after. Needs COSMOS_ENDPOINT (+ optional COSMOS_DATABASE)
 *      and an identity with data-plane RBAC (az login locally).
 *
 *   3. AUTHENTICATED SPOT-CHECK — set SMOKE_BEARER_TOKEN to a valid Entra
 *      access token for the API scope; verifies the guard admits a real
 *      token, not merely that it refuses none.
 *
 * Deliberately NOT here: a POST public/submissions probe. It would write junk
 * into the review queue every run; tier 2 verifies the same primitive at the
 * database, which is cleaner evidence.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { results } from './lib/smoke-runner.mjs';
import { noteFirewallWaits } from './lib/smoke-origin.mjs';
import { tierAnonymous, tierAuthed, tierCosmos } from './lib/smoke-tiers.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { looksPublic, LIST_MUST_NOT_CARRY, looksValidEstate, looksValidCoderStatus, projectionLeaks } from './lib/smoke-runner.mjs';
export { FIREWALL_RETRY_INTERVAL_MS, FIREWALL_RETRY_BUDGET_MS, isOriginFirewallRefusal, createOriginFetch } from './lib/smoke-origin.mjs';

// ── argument handling ────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    base: process.env.SMOKE_BASE_URL || '',
    cosmos: false,
    help: false,
    tier: process.env.SMOKE_TIER ? Number(process.env.SMOKE_TIER) : null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') args.base = argv[++i] || '';
    else if (argv[i] === '--cosmos') args.cosmos = true;
    else if (argv[i] === '--tier') args.tier = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  // The base must include the /api route prefix — every route registers
  // relative to it, and a base without it turns every check into a 404 that
  // looks like a missing deployment.
  if (args.base) args.base = args.base.replace(/\/+$/, '');
  return args;
}

// ── main ─────────────────────────────────────────────────────────────────────

const HELP = `Usage: node smoke-deployed.mjs --base <url> [--tier <1|2|3>] [--cosmos]

  --base <url>   API base including the /api prefix (or SMOKE_BASE_URL), e.g.
                 https://api-azure.hybridcloudworks.com/api  (the Cloudflare host —
                 the azurewebsites.net origin is IP-locked and answers 403)
  --tier <n>     run only tier <n> (e.g. 1 for anonymous surface inside deploy window)
  --cosmos       also run the Cosmos conditional-patch tier
                 (needs COSMOS_ENDPOINT + az login with data-plane RBAC)

  SMOKE_BEARER_TOKEN   optional Entra access token for the authenticated tier
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.base && !args.cosmos)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 2);
  }

  const shouldRunTier = (tier) => args.tier === null || args.tier === tier;

  if (args.base) {
    if (shouldRunTier(1)) await tierAnonymous(args.base);
    if (shouldRunTier(3)) await tierAuthed(args.base);
  }
  if (args.cosmos && shouldRunTier(2)) await tierCosmos();

  noteFirewallWaits();
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === 'skip');
  console.log(
    `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`
  );
  process.exit(failed.length ? 1 : 0);
}

// Only run when executed directly, so the unit test can import the helpers.
// pathToFileURL, not `file://${argv[1]}`: on Windows argv[1] is `C:\...`, which
// never string-matches import.meta.url — the smoke test would exit 0 from
// PowerShell having checked nothing. Same fix as check-deploy-drift.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
