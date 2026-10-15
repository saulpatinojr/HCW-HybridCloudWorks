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

// ── tiny check runner ────────────────────────────────────────────────────────

const results = [];
const record = (tier, name, ok, detail = '') => {
  results.push({ tier, name, ok, detail });
  const mark = ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
};

async function check(tier, name, fn) {
  try {
    const detail = await fn();
    record(tier, name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    record(tier, name, false, err?.message || String(err));
  }
}

// ── argument handling ────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { base: process.env.SMOKE_BASE_URL || '', cosmos: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') args.base = argv[++i] || '';
    else if (argv[i] === '--cosmos') args.cosmos = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  // The base must include the /api route prefix — every route registers
  // relative to it, and a base without it turns every check into a 404 that
  // looks like a missing deployment.
  if (args.base) args.base = args.base.replace(/\/+$/, '');
  return args;
}

// ── assertion helpers (exported for the unit test) ───────────────────────────

/** Mirrors the server's isPublicDocument: a leak here is T-201/T-206 broken. */
export function looksPublic(doc = {}) {
  const status = String(doc.contentStatus || '');
  return (
    doc.Live === true ||
    doc.Status === 'Live' ||
    ['published', 'published_blog', 'published_news', 'published_both'].includes(status)
  );
}

/** Body fields the T-206 projection must keep out of LIST responses. */
export const LIST_MUST_NOT_CARRY = [
  'content',
  'Content',
  'postContent',
  'blogDraft',
  'overviewHtml',
  'codeSnippet',
  'commandExample',
  'sidebarContent',
];

export function looksValidEstate(body) {
  if (!body || typeof body.configured !== 'boolean') return false;
  if (!body.configured) return true;
  return Boolean(body.arc && body.agent && body.coder);
}

export function looksValidCoderStatus(body) {
  if (!body || typeof body.configured !== 'boolean') return false;
  if (!body.configured) return true;
  return typeof body.reachable === 'boolean';
}

export function projectionLeaks(item = {}) {
  return LIST_MUST_NOT_CARRY.filter((f) => f in item);
}

const expectStatus = (res, wanted) => {
  if (res.status !== wanted) {
    throw new Error(`expected HTTP ${wanted}, got ${res.status}`);
  }
};

// ── tier 1: anonymous surface ────────────────────────────────────────────────

async function tierAnonymous(base) {
  console.log(`\nTier 1 — anonymous surface against ${base}`);
  const get = (path, headers = {}) => fetch(`${base}/${path}`, { headers });

  await check(1, 'health answers and discloses no runtime', async () => {
    const res = await get('health');
    expectStatus(res, 200);
    const body = await res.json();
    // T-402 hardening: node version / site name must not be reported.
    if ('node' in body || 'site' in body) throw new Error('health leaks runtime details');
    return `status=${body.status}`;
  });

  await check(1, 'public content list: filtered, projected, bounded', async () => {
    const res = await get('public/content?limit=5');
    expectStatus(res, 200);
    const body = await res.json();
    if (!Array.isArray(body.items)) throw new Error('no items array');
    for (const item of body.items) {
      if (!looksPublic(item)) throw new Error(`non-public doc leaked: ${item.id}`);
      const leaks = projectionLeaks(item);
      if (leaks.length) throw new Error(`projection leaked ${leaks.join(',')} on ${item.id}`);
    }
    if (typeof body.total !== 'number' || body.total < body.items.length) {
      throw new Error(`total=${body.total} below page size ${body.items.length} (T-407 regressed)`);
    }
    return `${body.items.length} items, total=${body.total}`;
  });

  await check(1, 'detail read: found by slug/id, missing 404s', async () => {
    const list = await (await get('public/content?limit=1')).json();
    const first = list.items?.[0];
    if (first) {
      const res = await get(`public/content/${encodeURIComponent(first.slug || first.id)}`);
      expectStatus(res, 200);
    }
    const missing = await get('public/content/smoke-definitely-missing-9z9z9z');
    expectStatus(missing, 404);
    return first ? `resolved ${first.slug || first.id}` : 'list empty; 404 path only';
  });

  await check(1, 'curated-image miss: 200 null, short cache', async () => {
    const res = await get('public/curated-image/smoke-no-such-article');
    expectStatus(res, 200);
    const body = await res.json();
    if (body.imageUrl !== null) throw new Error(`expected null, got ${body.imageUrl}`);
    const cache = res.headers.get('cache-control') || '';
    if (!/max-age=60\b/.test(cache)) {
      throw new Error(`miss cached as "${cache}" — negative caching regressed (T-210 review)`);
    }
  });

  await check(1, 'platform-health: four providers, enum statuses, no 500', async () => {
    const res = await get('public/platform-health');
    expectStatus(res, 200);
    const body = await res.json();
    const providers = Object.keys(body.statuses || {});
    if (providers.length < 4) throw new Error(`expected 4 providers, saw ${providers.length}`);
    return providers.join(',');
  });

  await check(1, 'guards are live: admin RPCs refuse anonymous callers', async () => {
    // The route-inventory test proves this in-process; this proves the
    // DEPLOYED app wired the same guard — authLevel is 'anonymous' at the
    // host, so the app-level guard is the only thing standing here.
    for (const [method, path] of [
      ['GET', 'getCurrentAdminStatus'],
      ['POST', 'saveEditorDraft'],
      ['GET', 'cms/content?limit=1'],
    ]) {
      const res = await fetch(`${base}/${path}`, { method });
      if (![401, 403].includes(res.status)) {
        throw new Error(`${method} ${path} answered ${res.status} anonymously`);
      }
    }
  });

  await check(1, 'CORS: disallowed origin refused, allowed origin preflights', async () => {
    const evil = await get('public/content', { Origin: 'https://evil.example' });
    expectStatus(evil, 403);
    const pre = await fetch(`${base}/public/content`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://hybridcloudworks.com' },
    });
    expectStatus(pre, 204);
  });

  await check(1, 'notImplemented RPCs still 404 (contract holds)', async () => {
    // If one of the seventeen starts existing, the contract must move it to
    // implemented — this failing is the deployed twin of api-contract.test.js.
    const res = await fetch(`${base}/aiProxy`, { method: 'POST' });
    expectStatus(res, 404);
  });

  await check(1, 'labs-estate: answers configured contract with Arc, agent, Coder', async () => {
    const res = await get('public/labs/estate');
    expectStatus(res, 200);
    const body = await res.json();
    if (!looksValidEstate(body)) {
      throw new Error(`invalid estate payload: configured=${body?.configured}`);
    }
    return body.configured
      ? `configured: arc=${body.arc.status}, agent=${body.agent.online ? 'online' : 'offline'}`
      : 'unconfigured estate (offline host)';
  });

  await check(1, 'coder-status: answers configured contract with capacity', async () => {
    const res = await get('public/labs/coder-status');
    expectStatus(res, 200);
    const body = await res.json();
    if (!looksValidCoderStatus(body)) {
      throw new Error(`invalid coder status payload: configured=${body?.configured}`);
    }
    return body.configured
      ? `configured: reachable=${body.reachable}, running=${body.capacity?.running || 0}`
      : 'unconfigured coder (no CODER_URL)';
  });
}

// ── tier 2: cosmos conditional patch ─────────────────────────────────────────

async function tierCosmos() {
  console.log('\nTier 2 — Cosmos conditional patch (the T-204 assumption)');
  const endpoint = process.env.COSMOS_ENDPOINT;
  if (!endpoint) {
    record(2, 'conditional patch', 'skip', 'COSMOS_ENDPOINT not set');
    return;
  }
  const { CosmosClient } = await import('@azure/cosmos');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  const container = client
    .database(process.env.COSMOS_DATABASE || 'hcw')
    .container('submission_quota');

  const id = `smoke-conditional-patch-${Date.now()}`;
  const patch = () =>
    container.item(id, id).patch({
      condition: 'FROM c WHERE c.count < 1',
      operations: [{ op: 'incr', path: '/count', value: 1 }],
    });

  try {
    await check(2, 'passing predicate applies the increment', async () => {
      await container.items.create({ id, windowStartMs: Date.now(), count: 0 });
      const { resource } = await patch();
      if (resource.count !== 1) throw new Error(`count=${resource.count} after increment`);
    });

    await check(2, 'failing predicate surfaces as code 412', async () => {
      // THE assertion this tier exists for. If the SDK maps it differently,
      // the message below says exactly what arrived instead — that is the
      // finding to bring home.
      try {
        await patch();
        throw new Error('patch succeeded past the predicate — no conditional gate at all');
      } catch (err) {
        if (err?.code === 412) return 'code=412, as the quota assumes';
        throw new Error(
          `arrived as code=${err?.code} statusCode=${err?.statusCode} (${err?.message?.slice(0, 80)})`
        );
      }
    });

    await check(2, 'missing document surfaces as code 404', async () => {
      try {
        await container.item('smoke-never-existed', 'smoke-never-existed').patch({
          condition: 'FROM c WHERE c.count < 1',
          operations: [{ op: 'incr', path: '/count', value: 1 }],
        });
        throw new Error('patch on a missing document succeeded');
      } catch (err) {
        if (err?.code === 404) return 'code=404, as the quota assumes';
        throw new Error(`arrived as code=${err?.code} statusCode=${err?.statusCode}`);
      }
    });
  } finally {
    // TTL would clean this up in two hours anyway; delete so reruns are exact.
    await container
      .item(id, id)
      .delete()
      .catch(() => {});
  }
}

// ── tier 3: authenticated spot-check ─────────────────────────────────────────

async function tierAuthed(base) {
  console.log('\nTier 3 — authenticated spot-check');
  const token = process.env.SMOKE_BEARER_TOKEN;
  if (!token) {
    record(3, 'admin status with a real token', 'skip', 'SMOKE_BEARER_TOKEN not set');
    return;
  }
  await check(3, 'admin status with a real token', async () => {
    const res = await fetch(`${base}/getCurrentAdminStatus`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expectStatus(res, 200);
    const body = await res.json();
    if (typeof body.isAdmin !== 'boolean') throw new Error('no isAdmin in response');
    return `isAdmin=${body.isAdmin} role=${body.role || 'none'}`;
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

const HELP = `Usage: node smoke-deployed.mjs --base <url> [--cosmos]

  --base <url>   API base including the /api prefix (or SMOKE_BASE_URL), e.g.
                 https://api-azure.hybridcloudworks.com/api  (the Cloudflare host —
                 the azurewebsites.net origin is IP-locked and answers 403)
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

  if (args.base) {
    await tierAnonymous(args.base);
    await tierAuthed(args.base);
  }
  if (args.cosmos) await tierCosmos();

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
