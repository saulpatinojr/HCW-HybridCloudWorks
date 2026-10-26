/**
 * A Doc Vault document can never appear on the public site (owner rule
 * 2026-10-26: pre-publish and personal documents must never be public).
 *
 * Four locks, each tested on its own so one failing does not hide another:
 *
 *   1. NAMING. The container is `doc_vault`. No module outside the Doc Vault's
 *      own files names it, in the Functions app, the build scripts, the
 *      pre-render, the sitemap, the search index or the public pages, so no
 *      public read can address it.
 *   2. SHAPE. A vault document carries no field a public read keys on (Live,
 *      contentStatus, a slug, a status), so the public clauses
 *      (isPublicDocument, SQL_PUBLIC_CLAUSE, the manifest's PUBLISHED_PREDICATE)
 *      refuse it in every state it can be in.
 *   3. BEHAVIOUR. Every public route is run against a store that answers
 *      EVERY read, from EVERY container, with a vault document. Nothing of it
 *      reaches a response, and no route read the vault container.
 *   4. THE FRONT END. The page, its routes and its client code live under the
 *      admin only; the public bundle, the sitemap, robots.txt and the search
 *      index do not mention it.
 *
 * Lock 3 is the strong one: it would catch a public route that returned
 * whatever its store gave it, which is a bug in that route, not in the vault.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQL_PUBLIC_CLAUSE, isPublicDocument } from '../public-reads.js';
import { PUBLISHED_PREDICATE } from '../public-content-manifest.js';
import { evaluatePredicate } from '../../../test/cosmos-predicate.js';
import { buildArchivedVersion, buildNewDocument, buildNextDocument } from './model.js';

// ── the poisoned store ─────────────────────────────────────────────────────

const poison = vi.hoisted(() => {
  const SENTINEL = {
    title: 'VAULT-TITLE-SENTINEL-92d1',
    body: 'VAULT-BODY-SENTINEL-4be7 a private paragraph',
    tag: 'vault-tag-sentinel-6c0a',
    link: 'https://example.com/VAULT-LINK-SENTINEL-3f58',
    admin: 'vault-admin-sentinel-a17e',
  };
  const doc = {
    id: 'vault-doc-1',
    docType: 'document',
    title: SENTINEL.title,
    category: 'Letter',
    tags: [SENTINEL.tag],
    body: SENTINEL.body,
    bodyBytes: 40,
    source: 'pasted',
    relatedLink: SENTINEL.link,
    dedupeKey: 'letter|vault title',
    version: 3,
    restoredFromVersion: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: SENTINEL.admin,
    updatedAt: '2026-10-02T00:00:00.000Z',
    updatedBy: SENTINEL.admin,
    deletedAt: null,
    deletedBy: null,
  };
  return { SENTINEL, doc, containers: new Set(), verbs: new Map() };
});

vi.mock('@azure/cosmos', () => ({ CosmosClient: class {} }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock('@azure/storage-blob', () => ({ BlobServiceClient: class {} }));
vi.mock('@aws-sdk/client-pricing', () => ({ PricingClient: class {}, GetProductsCommand: class {} }));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('@breezystack/lamejs', () => ({ default: {}, Mp3Encoder: class {} }));
vi.mock('cheerio', () => ({ load: vi.fn() }));
vi.mock('turndown', () => ({ default: class { addRule() {} turndown() { return ''; } } }));
vi.mock('rss-parser', () => ({ default: class {} }));

const httpRegistrations = vi.hoisted(() => new Map());
vi.mock('@azure/functions', () => ({
  app: {
    http: (name, options) => httpRegistrations.set(name, options),
    timer: () => {},
    cosmosDB: () => {},
    storageQueue: () => {},
  },
  output: { storageQueue: (options) => options },
}));
vi.mock('../auth/default-guard.js', () => ({
  getDefaultGuard: () => ({
    requireRole: async () => ({ error: { status: 403, headers: {}, body: '{}' } }),
    requireUser: async () => ({ error: { status: 401, headers: {}, body: '{}' } }),
  }),
  resetDefaultGuard: () => {},
}));
vi.mock('../auth/default-agent-guard.js', () => ({
  getDefaultAgentGuard: () => ({
    requireAgent: async () => ({ agent: null, identity: null, error: { status: 403, headers: {}, body: '{}' } }),
  }),
  resetDefaultAgentGuard: () => {},
}));

vi.mock('../cosmos-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  /** Note which container a verb addressed, and answer with a vault document whatever was asked. */
  const answer = (verb, shape) => async (container) => {
    poison.containers.add(container);
    poison.verbs.set(verb, (poison.verbs.get(verb) ?? 0) + 1);
    return shape(structuredClone(poison.doc));
  };
  return {
    ...actual,
    readDoc: answer('readDoc', (doc) => doc),
    queryDocs: answer('queryDocs', (doc) => [doc]),
    queryDocsPage: answer('queryDocsPage', (doc) => ({ resources: [doc], continuationToken: null, hasMoreResults: false })),
    countDocs: answer('countDocs', () => 1),
    upsertDoc: answer('upsertDoc', (doc) => doc),
    createDoc: answer('createDoc', (doc) => doc),
    patchDoc: answer('patchDoc', (doc) => doc),
    replaceDocIfMatch: answer('replaceDocIfMatch', (doc) => doc),
    incrementIf: answer('incrementIf', (doc) => doc),
    deleteDoc: answer('deleteDoc', () => undefined),
    deleteDocIfMatch: answer('deleteDocIfMatch', () => undefined),
  };
});

// ── repository files ───────────────────────────────────────────────────────

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const posix = (path) => path.split(sep).join('/');

function walk(dir, keep, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage' || entry === '.git') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

const isSource = (path) => /\.(?:js|mjs|cjs|jsx|ts|tsx|json|tf|ya?ml|html|txt|xml)$/.test(path);
const isTest = (path) => /\.test\.[cm]?[jt]sx?$/.test(path) || /[\\/]test[\\/]/.test(path);
const read = (path) => readFileSync(path, 'utf8');

// ── 1. naming ──────────────────────────────────────────────────────────────

describe('lock 1: nothing outside the Doc Vault names its container or its code', () => {
  /** Everywhere the container's name or the vault's modules may appear, and why. */
  const ALLOWED = new Set([
    'functions/src/lib/doc-vault/model.js',
    'functions/src/lib/doc-vault/handlers.js',
    'functions/src/lib/doc-vault/markdown.js',
    'functions/src/functions/doc-vault-http.js',
    // The registration is imported by name, like every other.
    'functions/src/functions/index.js',
    // Backed up with the other authored work (ADR 0028).
    'functions/src/lib/backup/export-classification.js',
    // The container list and its generated form (Terraform reads the JSON).
    'scripts/lib/migration-manifest.mjs',
    'scripts/generate-cosmos-container-spec.mjs',
    'infra/cosmos-containers.json',
    // The reviewed Terraform plan that creates it.
    'scripts/assert-expected-plan.mjs',
    // The route inventory, the API contract and the function inventory name
    // routes, not the container.
    'functions/function-inventory.json',
    '.azure/api-surface.json',
    'functions/test/doc-vault-store.js',
    // The Doc Vault's own front end.
    'frontend/src/lib/api.js',
    'frontend/src/config/adminNav.js',
    'frontend/src/App.jsx',
  ]);
  const NEEDLES = [/doc_vault/, /doc-vault/, /docVault/, /DocVault/];

  const scan = (root, label) =>
    walk(join(REPO, root), (path) => isSource(path) && !isTest(path))
      .map((path) => posix(relative(REPO, path)))
      .filter((path) => !path.startsWith('frontend/src/pages/admin/docVault/'))
      .filter((path) => path !== 'frontend/src/pages/admin/DocVaultPage.jsx')
      .filter((path) => !path.startsWith('functions/src/lib/doc-vault/'))
      .filter((path) => NEEDLES.some((needle) => needle.test(read(join(REPO, path)))))
      .map((path) => `${label}: ${path}`);

  it('is true of the Functions app, the build scripts, the infrastructure and the front end', () => {
    const named = [
      ...scan('functions/src', 'functions'),
      ...scan('functions/test', 'functions'),
      ...scan('scripts', 'scripts'),
      ...scan('infra', 'infra'),
      ...scan('frontend/src', 'frontend'),
      ...scan('frontend/scripts', 'frontend scripts'),
      ...scan('frontend/public', 'frontend public'),
    ].filter((entry) => !ALLOWED.has(entry.split(': ')[1]));
    expect(
      named,
      'a module outside the Doc Vault names its container or its code; if it must, add it to ALLOWED in this test with the reason, and tell the owner'
    ).toEqual([]);
  });

  it('keeps every public route handler and every public build step in the list that is checked', () => {
    // A guard that scans nothing passes for the wrong reason.
    const scanned = walk(join(REPO, 'functions/src/functions'), (path) => isSource(path) && !isTest(path));
    expect(scanned.some((path) => posix(path).endsWith('functions/src/functions/public-reads.js'))).toBe(true);
    expect(scanned.some((path) => posix(path).endsWith('functions/src/functions/public-content-manifest.js'))).toBe(true);
    expect(read(join(REPO, 'functions/src/functions/doc-vault-http.js'))).toContain('cms/doc-vault');
  });

  it('names the container in exactly the places it is declared and backed up', () => {
    const holders = [
      'functions/src/lib/doc-vault/model.js',
      'scripts/lib/migration-manifest.mjs',
      'infra/cosmos-containers.json',
      'functions/src/lib/backup/export-classification.js',
    ];
    for (const path of holders) expect(read(join(REPO, path)), path).toMatch(/['"]doc_vault['"]/);
    const spec = JSON.parse(read(join(REPO, 'infra/cosmos-containers.json')));
    expect(spec.containers.filter((c) => c.name === 'doc_vault')).toHaveLength(1);
  });
});

// ── 2. shape ───────────────────────────────────────────────────────────────

describe('lock 2: the public clauses refuse a vault document in every state', () => {
  const fields = { title: 'Letter', category: 'Letter', tags: ['a'], body: 'text', relatedLink: null };
  const now = new Date('2026-10-26T00:00:00Z');
  const shapes = () => {
    const created = buildNewDocument({ id: 'd', fields, source: 'pasted', adminId: 'a', now });
    const next = buildNextDocument({ current: { ...created, _etag: 'e' }, fields, source: 'pasted', adminId: 'a', now });
    return {
      'a new document': created,
      'a later version': next,
      'an earlier version': buildArchivedVersion(created),
      'a document in Trash': { ...created, deletedAt: now.toISOString(), deletedBy: 'a' },
      'a document that was uploaded': { ...created, source: 'uploaded' },
      'the stored document after every system field is added': { ...created, _rid: 'r', _self: 's', _etag: 'e', _attachments: 'x', _ts: 1 },
    };
  };

  it.each(Object.keys(shapes()))('%s is not public by isPublicDocument', (name) => {
    expect(isPublicDocument(shapes()[name])).toBe(false);
  });

  it.each(Object.keys(shapes()))('%s fails the SQL public clause and the manifest predicate', (name) => {
    expect(evaluatePredicate(SQL_PUBLIC_CLAUSE, shapes()[name])).toBe(false);
    expect(evaluatePredicate(PUBLISHED_PREDICATE, shapes()[name])).toBe(false);
  });

  it('carries no field a public read keys on', () => {
    const KEYED_ON = ['Live', 'live', 'contentStatus', 'Status', 'status', 'slug', 'publishedAt', 'public', 'published', 'provider', 'Cloud Provider', 'type', 'kind'];
    for (const [name, doc] of Object.entries(shapes())) {
      for (const key of KEYED_ON) expect(Object.keys(doc), `${name} has ${key}`).not.toContain(key);
    }
  });
});

// ── 3. behaviour ───────────────────────────────────────────────────────────

describe('lock 3: no public route serves a vault document, whatever store it reads', () => {
  const context = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  let responses;

  /** Every path parameter any public route takes, filled with something that gets past a shape check. */
  const PARAMS = {
    slugOrId: 'vault-doc-1',
    id: 'vault-doc-1',
    contentId: 'vault-doc-1',
    container: 'content',
    blobPath: 'vault-doc-1.png',
  };

  const makeRequest = (method) => ({
    method,
    params: { ...PARAMS },
    query: new URLSearchParams('limit=5&provider=azure&section=blog&region=eastus&id=vault-doc-1&t=x'),
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => '',
  });

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network disabled in the no-leak test');
    }));
    await import('../../functions/index.js');
    responses = [];
    for (const [name, options] of httpRegistrations) {
      if (!options.route.startsWith('public/') && options.route !== 'health') continue;
      for (const method of options.methods.filter((m) => m !== 'OPTIONS')) {
        let response = null;
        try {
          response = await options.handler(makeRequest(method), context);
        } catch {
          response = null;
        }
        responses.push({ name, method, route: options.route, response });
      }
    }
  }, 60_000);

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('exercised the public routes, and they read from stores', () => {
    const routes = new Set(responses.map((r) => r.route));
    expect(routes.size).toBeGreaterThan(20);
    expect(routes.has('public/content')).toBe(true);
    expect(routes.has('public/content-manifest')).toBe(true);
    expect(routes.has('public/content/{slugOrId}')).toBe(true);
    expect(routes.has('public/feed')).toBe(true);
    expect(routes.has('public/snapshots/{id}')).toBe(true);
    // Not vacuous: the poisoned store was asked, and by more than one verb.
    expect(poison.containers.size).toBeGreaterThan(3);
    expect(poison.verbs.get('queryDocs')).toBeGreaterThan(0);
    expect(poison.verbs.get('readDoc')).toBeGreaterThan(0);
    expect(responses.filter((r) => r.response && r.response.status < 400).length).toBeGreaterThan(5);
  });

  it('never read the vault container', () => {
    expect([...poison.containers]).not.toContain('doc_vault');
  });

  /**
   * The routes that answer with what their query returns and filter in the
   * query, not in code, so a store that ignores the query (this one) makes
   * them serve it. Each is covered another way, named here:
   *   - public/content-manifest runs PUBLISHED_PREDICATE in SQL; lock 2
   *     evaluates that predicate against every shape a vault document takes.
   *   - public/podcasts serves the `podcasts` container, which has no status
   *     field (public-reads.js says so); only the podcast ingest writes it.
   * Both never read `doc_vault` (above). A route added to this list is a
   * decision to rely on the container or the query alone, so it is made here,
   * in the open.
   */
  const FILTERS_IN_THE_QUERY = new Set(['public/content-manifest', 'public/podcasts']);

  it('puts none of a vault document in any response of a route that checks what it reads', () => {
    const leaks = [];
    for (const { route, method, response } of responses) {
      if (!response || FILTERS_IN_THE_QUERY.has(route)) continue;
      const text = JSON.stringify(response);
      for (const [what, value] of Object.entries(poison.SENTINEL)) {
        if (text.includes(value)) leaks.push(`${method} ${route} served the vault document's ${what}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('names only routes that exist, so the list above cannot rot', () => {
    const routes = new Set(responses.map((r) => r.route));
    for (const route of FILTERS_IN_THE_QUERY) expect(routes.has(route), route).toBe(true);
  });

  it('put none of it in a log line either', () => {
    const logged = JSON.stringify([context.log.mock.calls, context.warn.mock.calls, context.error.mock.calls, context.debug.mock.calls]);
    for (const value of Object.values(poison.SENTINEL)) expect(logged).not.toContain(value);
  });

  it('serves the vault routes to no anonymous caller', () => {
    const vaultRoutes = [...httpRegistrations.values()].filter((o) => o.route.startsWith('cms/doc-vault'));
    expect(vaultRoutes.length).toBe(6);
    expect(vaultRoutes.every((o) => !o.route.startsWith('public/'))).toBe(true);
  });
});

// ── 4. the front end ───────────────────────────────────────────────────────

describe('lock 4: the public site does not carry the page, its client or a way to it', () => {
  it('has the page only under the admin routes', () => {
    const app = read(join(REPO, 'frontend/src/App.jsx'));
    const mentions = app.split('\n').filter((line) => /doc-vault|DocVault/.test(line));
    expect(mentions.length).toBeGreaterThan(0);
    // The lazy import, and the one route inside the AdminAuthGuard block.
    const adminBlock = app.slice(app.indexOf('{/* --- Admin CMS --- */}'), app.indexOf('{/* Catch-All */}'));
    expect(adminBlock).toContain('path="doc-vault"');
    const outside = app.replace(adminBlock, '');
    expect(outside.match(/path="[^"]*doc-vault[^"]*"/g) ?? []).toEqual([]);
  });

  it('is disallowed to crawlers with the rest of /admin, and absent from the search index and the sitemap code', () => {
    expect(read(join(REPO, 'frontend/public/robots.txt'))).toMatch(/^Disallow: \/admin\s*$/m);
    expect(read(join(REPO, 'frontend/src/data/searchIndex.js'))).not.toMatch(/doc.?vault/i);
    expect(read(join(REPO, 'frontend/scripts/prerender.mjs'))).not.toMatch(/doc.?vault/i);
    expect(read(join(REPO, 'scripts/build-content-manifest.mjs'))).not.toMatch(/doc.?vault/i);
    expect(read(join(REPO, 'frontend/scripts/generate-public-data.cjs'))).not.toMatch(/doc.?vault/i);
  });
});
