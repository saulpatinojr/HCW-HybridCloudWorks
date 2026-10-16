/**
 * The API contract (.azure/api-surface.json) held to account (T-207).
 *
 * The contract said `rpc.functions` describes "functions the frontend already
 * invokes" and then listed seventeen that were never registered — every one a
 * live 404 in the admin UI, and invisible, because nothing compared the
 * document to the code. This file is that comparison, in both directions:
 *
 *   1. `rpc.functions` = `rpc.implemented` + `rpc.notImplemented`, exactly.
 *      A name in both is a contradiction; a name in neither is undocumented.
 *   2. Every implemented RPC entry resolves to a registered route, with the
 *      methods it advertises.
 *   3. No notImplemented name is registered. Implementing one therefore
 *      REQUIRES moving it to `implemented` in the same change — the gap can
 *      close, but it can no longer close silently.
 *   4. Every route the Functions host would register is claimed somewhere in
 *      the contract, and everything the contract claims is registered. A new
 *      route without a contract entry fails here, which is the "vice versa"
 *      half T-207 asked for.
 *
 * Registrations are enumerated exactly as route-inventory.test.js does — mock
 * the host, import index.js — because several RPCs register through loops and
 * any static grep of `route:` literals misses them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const httpRegistrations = new Map();

vi.mock('@azure/functions', () => ({
  app: {
    http: (name, options) => httpRegistrations.set(name, options),
    timer: () => {},
    cosmosDB: () => {},
    storageQueue: () => {},
  },
  output: { storageQueue: (options) => options },
}));

// Handlers are never invoked here, but index.js resolves guards at import.
vi.mock('../lib/auth/default-guard.js', () => ({
  getDefaultGuard: () => ({ requireRole: vi.fn(), requireUser: vi.fn() }),
  resetDefaultGuard: () => {},
}));
vi.mock('../lib/auth/default-agent-guard.js', () => ({
  getDefaultAgentGuard: () => ({ requireAgent: vi.fn() }),
  resetDefaultAgentGuard: () => {},
}));

// Importing index.js loads every function module; none of the heavy cloud,
// media or parser SDKs are called while enumerating registrations, and
// parsing them in parallel across the inventory suites pushed beforeAll past
// the 10 s hook ceiling under full-suite load (#1203).
vi.mock('@azure/cosmos', () => ({ CosmosClient: class {} }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock('@azure/storage-blob', () => ({ BlobServiceClient: class {} }));
vi.mock('@aws-sdk/client-pricing', () => ({
  PricingClient: class {},
  GetProductsCommand: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('@breezystack/lamejs', () => ({ default: {}, Mp3Encoder: class {} }));
vi.mock('cheerio', () => ({ load: vi.fn() }));
vi.mock('turndown', () => ({ default: class { addRule() {} turndown() { return ''; } } }));
vi.mock('rss-parser', () => ({ default: class {} }));

const contract = JSON.parse(
  readFileSync(join(process.cwd(), '..', '.azure', 'api-surface.json'), 'utf8')
);

beforeAll(async () => {
  // Same rule as route-inventory: importing index.js must not reach the
  // network (platform-health's module would otherwise try).
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network disabled in contract tests');
    })
  );
  await import('./index.js');
}, 30_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

/** route path -> registered methods, from the host's point of view. */
const registeredByPath = () => {
  const map = new Map();
  for (const options of httpRegistrations.values()) {
    map.set(options.route, options.methods);
  }
  return map;
};

/**
 * Registered "METHOD path" pairs. OPTIONS is excluded: it is CORS plumbing
 * that httpRoute adds to every registration, not API surface the contract
 * should have to narrate sixty-six times.
 */
const registeredPairs = () => {
  const pairs = new Set();
  for (const options of httpRegistrations.values()) {
    for (const method of options.methods) {
      if (method !== 'OPTIONS') pairs.add(`${method} ${options.route}`);
    }
  }
  return pairs;
};

/**
 * Parse a contract route string: "POST /api/x", "POST|PATCH /api/x",
 * "GET /api/public/content/{slugOrId}". Returns null for non-literal forms
 * ("CRUD /api/x"), which must carry `registeredRoutes` instead.
 */
function parseRoute(routeString) {
  const match = /^([A-Z]+(?:\|[A-Z]+)*) \/api\/(.+)$/.exec(routeString);
  if (!match) return null;
  return { methods: match[1].split('|'), path: match[2] };
}

/**
 * Every "METHOD path" pair the contract claims, across rpc and rest. Pairs,
 * not paths: one path legitimately splits across entries (GET cms/settings is
 * an admin read, PUT cms/settings an admin write), and methods are the unit at
 * which drift happens — a contract advertising a PATCH nobody registered is
 * exactly the lie this test exists to catch.
 */
function claimedPairs() {
  const pairs = [];
  for (const entry of contract.rpc.implemented) {
    const parsed = parseRoute(entry.route);
    expect(parsed, `unparseable rpc route: ${entry.route}`).not.toBeNull();
    for (const method of parsed.methods) pairs.push(`${method} ${parsed.path}`);
  }
  for (const [section, value] of Object.entries(contract.rest)) {
    if (section === 'description') continue;
    for (const entry of value.endpoints ?? []) {
      if (entry.registeredRoutes) {
        pairs.push(...entry.registeredRoutes);
      } else {
        const parsed = parseRoute(entry.route);
        expect(
          parsed,
          `rest entry needs a parseable route or registeredRoutes: ${entry.route}`
        ).not.toBeNull();
        for (const method of parsed.methods) pairs.push(`${method} ${parsed.path}`);
      }
    }
  }
  return pairs;
}

describe('rpc — the invoked list is partitioned, exactly', () => {
  it('functions = implemented + notImplemented, no overlap, no gap', () => {
    const implemented = contract.rpc.implemented.map((e) => e.name);
    const notImplemented = contract.rpc.notImplemented.functions;
    const invoked = contract.rpc.functions;

    const overlap = implemented.filter((n) => notImplemented.includes(n));
    expect(overlap, 'a name cannot be both implemented and notImplemented').toEqual([]);

    // Set equality with readable diffs in both directions.
    const union = new Set([...implemented, ...notImplemented]);
    const undocumented = invoked.filter((n) => !union.has(n));
    const uninvoked = [...union].filter((n) => !invoked.includes(n));
    expect(undocumented, 'invoked but neither implemented nor notImplemented').toEqual([]);
    expect(uninvoked, 'documented but missing from the invoked list').toEqual([]);
  });

  it('every implemented RPC resolves to a registered route with its methods', () => {
    const registered = registeredByPath();
    const problems = [];

    for (const entry of contract.rpc.implemented) {
      const { methods, path } = parseRoute(entry.route);
      const actual = registered.get(path);
      if (!actual) {
        problems.push(`${entry.name}: route ${path} is not registered`);
        continue;
      }
      for (const method of methods) {
        if (!actual.includes(method)) {
          problems.push(`${entry.name}: ${path} lacks ${method} (has ${actual.join(',')})`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('no notImplemented function is registered', () => {
    // The teeth of T-207: this is what turns "implement one of the seventeen"
    // into a change that must also update the contract.
    const registered = registeredByPath();
    const leaked = contract.rpc.notImplemented.functions.filter((name) => registered.has(name));
    expect(leaked, 'registered but still listed as notImplemented').toEqual([]);
  });
});

describe('routes ↔ contract, both directions', () => {
  it('every registered method+route is claimed by the contract, and vice versa', () => {
    const registered = registeredPairs();
    const claimed = claimedPairs();

    // Duplicate claims are contract rot too — one endpoint documented twice
    // drifts twice.
    const seen = new Set();
    const duplicated = claimed.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
    expect(duplicated, 'endpoint claimed more than once in the contract').toEqual([]);

    const unclaimed = [...registered].filter((p) => !seen.has(p));
    const phantom = [...seen].filter((p) => !registered.has(p));
    expect(unclaimed, 'registered but absent from the contract').toEqual([]);
    expect(phantom, 'in the contract but not registered').toEqual([]);
  });
});
