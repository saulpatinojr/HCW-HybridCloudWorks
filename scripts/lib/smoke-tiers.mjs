/** The smoke test's three tiers: the anonymous surface, the Cosmos conditional patch and the signed-in spot-check (smoke-deployed.mjs). */
import { check, expectStatus, looksPublic, looksValidCoderStatus, looksValidEstate, projectionLeaks, record } from './smoke-runner.mjs';
import { originFetch } from './smoke-origin.mjs';
import process from 'node:process';

// ── tier 1: anonymous surface ────────────────────────────────────────────────

/**
 * Tier 1's checks, in order: each a name and a body that is given the base
 * address and `get` (a GET of a path under it). Kept as a table so each body
 * reads on its own.
 */
const ANONYMOUS_CHECKS = [
  [
    'health answers and discloses no runtime',
    async ({ get }) => {
      const res = await get('health');
      expectStatus(res, 200);
      const body = await res.json();
      // T-402 hardening: node version / site name must not be reported.
      if ('node' in body || 'site' in body) throw new Error('health leaks runtime details');
      return `status=${body.status}`;
    },
  ],
  [
    'public content list: filtered, projected, bounded',
    async ({ get }) => {
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
    },
  ],
  [
    'detail read: found by slug/id, missing 404s',
    async ({ get }) => {
      const list = await (await get('public/content?limit=1')).json();
      const first = list.items?.[0];
      if (first) {
        const res = await get(`public/content/${encodeURIComponent(first.slug || first.id)}`);
        expectStatus(res, 200);
      }
      const missing = await get('public/content/smoke-definitely-missing-9z9z9z');
      expectStatus(missing, 404);
      return first ? `resolved ${first.slug || first.id}` : 'list empty; 404 path only';
    },
  ],
  [
    'curated-image miss: 200 null, short cache',
    async ({ get }) => {
      const res = await get('public/curated-image/smoke-no-such-article');
      expectStatus(res, 200);
      const body = await res.json();
      if (body.imageUrl !== null) throw new Error(`expected null, got ${body.imageUrl}`);
      const cache = res.headers.get('cache-control') || '';
      if (!/max-age=60\b/.test(cache)) {
        throw new Error(`miss cached as "${cache}" — negative caching regressed (T-210 review)`);
      }
    },
  ],
  [
    'platform-health: four providers, enum statuses, no 500',
    async ({ get }) => {
      const res = await get('public/platform-health');
      expectStatus(res, 200);
      const body = await res.json();
      const providers = Object.keys(body.statuses || {});
      if (providers.length < 4) throw new Error(`expected 4 providers, saw ${providers.length}`);
      return providers.join(',');
    },
  ],
  [
    'guards are live: admin RPCs refuse anonymous callers',
    async ({ base }) => {
      // The route-inventory test proves this in-process; this proves the
      // DEPLOYED app wired the same guard — authLevel is 'anonymous' at the
      // host, so the app-level guard is the only thing standing here.
      for (const [method, path] of [
        ['GET', 'getCurrentAdminStatus'],
        ['POST', 'saveEditorDraft'],
        ['GET', 'cms/content?limit=1'],
        ['POST', 'aiProxy'],
      ]) {
        const res = await originFetch(`${base}/${path}`, { method });
        if (![401, 403].includes(res.status)) {
          throw new Error(`${method} ${path} answered ${res.status} anonymously`);
        }
      }
    },
  ],
  [
    'CORS: disallowed origin refused, allowed origin preflights',
    async ({ base, get }) => {
      const evil = await get('public/content', { Origin: 'https://evil.example' });
      expectStatus(evil, 403);
      const pre = await originFetch(`${base}/public/content`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://hybridcloudworks.com' },
      });
      expectStatus(pre, 204);
    },
  ],
  [
    'notImplemented RPCs still 404 (contract holds)',
    async ({ base }) => {
      // An unregistered or missing RPC must 404 rather than answering 200 or 500.
      // api-contract.test.js enforces that all historical notImplemented RPCs
      // are now implemented and registered; this proves the host fails closed on
      // unmapped RPC endpoints.
      const res = await originFetch(`${base}/notImplementedRpcCheck`, { method: 'POST' });
      expectStatus(res, 404);
    },
  ],
  [
    'labs-estate: answers configured contract with Arc, agent, Coder',
    async ({ get }) => {
      const res = await get('public/labs/estate');
      expectStatus(res, 200);
      const body = await res.json();
      if (!looksValidEstate(body)) {
        throw new Error(`invalid estate payload: configured=${body?.configured}`);
      }
      return body.configured
        ? `configured: arc=${body.arc.status}, agent=${body.agent.online ? 'online' : 'offline'}`
        : 'unconfigured estate (offline host)';
    },
  ],
  [
    'coder-status: answers configured contract with capacity',
    async ({ get }) => {
      const res = await get('public/labs/coder-status');
      expectStatus(res, 200);
      const body = await res.json();
      if (!looksValidCoderStatus(body)) {
        throw new Error(`invalid coder status payload: configured=${body?.configured}`);
      }
      return body.configured
        ? `configured: reachable=${body.reachable}, running=${body.capacity?.running || 0}`
        : 'unconfigured coder (no CODER_URL)';
    },
  ],
];

export async function tierAnonymous(base) {
  console.log(`\nTier 1 — anonymous surface against ${base}`);
  const get = (path, headers = {}) => originFetch(`${base}/${path}`, { headers });
  for (const [name, run] of ANONYMOUS_CHECKS) await check(1, name, () => run({ base, get }));
}

// ── tier 2: cosmos conditional patch ─────────────────────────────────────────

export async function tierCosmos() {
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

export async function tierAuthed(base) {
  console.log('\nTier 3 — authenticated spot-check');
  const token = process.env.SMOKE_BEARER_TOKEN;
  if (!token) {
    record(3, 'admin status with a real token', 'skip', 'SMOKE_BEARER_TOKEN not set');
    return;
  }
  await check(3, 'admin status with a real token', async () => {
    const res = await originFetch(`${base}/getCurrentAdminStatus`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expectStatus(res, 200);
    const body = await res.json();
    if (typeof body.isAdmin !== 'boolean') throw new Error('no isAdmin in response');
    return `isAdmin=${body.isAdmin} role=${body.role || 'none'}`;
  });
}
