/**
 * Every row of Koda's admin access policy (lib/agent-content/admin-access.js,
 * ADR 0038) must name a route this Function App registers, with a method that
 * route answers. A row that names nothing would be a switch that opens no
 * door; a method the route does not answer would be a claim the API cannot
 * keep. The registrations are collected the way route-inventory.test.js
 * collects them: by importing index.js under the same mocks.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";

/** Registrations recorded in place of the real Functions host. */
const httpRegistrations = new Map();
const timerRegistrations = new Map();
const cosmosRegistrations = new Map();
const queueRegistrations = new Map();

vi.mock("@azure/functions", () => ({
  app: {
    http: (name, options) => httpRegistrations.set(name, options),
    timer: (name, options) => timerRegistrations.set(name, options),
    cosmosDB: (name, options) => cosmosRegistrations.set(name, options),
    storageQueue: (name, options) => queueRegistrations.set(name, options),
  },
  output: {
    storageQueue: (options) => ({ type: "queue", ...options }),
  },
}));

/**
 * Every guarded handler resolves its guard through one of these two modules.
 *
 * There are two, not one, and that is deliberate: the Labs VPS agent is a
 * machine identity authorized by its own App Role and its own registry, not by
 * the admin role hierarchy (lib/auth/require-agent.js). A third guard must be
 * added HERE before its routes count as guarded — that is the whole point of
 * this test, and adding one should be a visible, reviewed act.
 */
const requireRole = vi.fn(async () => ({
  error: {
    status: 403,
    headers: {},
    body: JSON.stringify({ ok: false, error: "Forbidden" }),
  },
}));
const requireUser = vi.fn(async () => ({
  error: {
    status: 401,
    headers: {},
    body: JSON.stringify({ ok: false, error: "Unauthorized" }),
  },
}));
const requireAgent = vi.fn(async () => ({
  agent: null,
  identity: null,
  error: {
    status: 403,
    headers: {},
    body: JSON.stringify({ ok: false, error: "Agent access required" }),
  },
}));

/** Every gate the inventory recognises. A route must reach at least one. */
const syncRequireRole = vi.fn(async () => ({ error: { status: 403, headers: {}, body: "Forbidden" } }));
// The Agent Content API's key guard (ADR 0037): Koda's key, never a token.
// Its routes count as guarded only through this mock, which is the point.
const agentKeyGuard = vi.fn(async () => ({
  record: null,
  user: null,
  error: { status: 401, headers: {}, body: JSON.stringify({ ok: false, error: "Unauthorized" }) },
}));
vi.mock("../lib/agent-content/guard.js", () => ({
  getAgentContentGuard: () => ({
    authenticate: agentKeyGuard,
    requireCapability: agentKeyGuard,
  }),
  resetAgentContentGuard: () => {},
}));
vi.mock("../lib/brain/guard.js", async (importOriginal) => ({ ...(await importOriginal()), getBrainSyncGuard: () => ({ requireRole: syncRequireRole, requireUser: syncRequireRole }) }));

vi.mock("../lib/auth/default-guard.js", () => ({
  getDefaultGuard: () => ({ requireRole, requireUser }),
  resetDefaultGuard: () => {},
}));

vi.mock("../lib/auth/default-agent-guard.js", () => ({
  getDefaultAgentGuard: () => ({ requireAgent }),
  resetDefaultAgentGuard: () => {},
}));

// Importing index.js loads every function module; the guard, OPTIONS and CORS
// checks below never call the cloud, media or parser SDKs, and parsing them
// in parallel across the inventory suites pushed beforeAll past the 10 s hook
// ceiling under full-suite load (#1203).
vi.mock("@azure/cosmos", () => ({ CosmosClient: class {} }));
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock("@azure/storage-blob", () => ({ BlobServiceClient: class {} }));
vi.mock("@aws-sdk/client-pricing", () => ({
  PricingClient: class {},
  GetProductsCommand: class {},
}));
vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("@breezystack/lamejs", () => ({ default: {}, Mp3Encoder: class {} }));
vi.mock("cheerio", () => ({ load: vi.fn() }));
vi.mock("turndown", () => ({ default: class { addRule() {} turndown() { return ""; } } }));
vi.mock("rss-parser", () => ({ default: class {} }));

/**
 * Routes intentionally reachable with no credential.
 *
 * Each replaces a read (or, for submissions, a write) that Firestore security
 * rules allowed anonymously. The server-side filter that replaced those rules
 * lives in the corresponding lib module — this list records the decision, it
 * does not implement it.
 */
import { POLICY } from "../lib/agent-content/admin-access.js";

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled"); }));
  await import("./index.js");
}, 30_000);
afterAll(() => vi.unstubAllGlobals());

describe("Koda's admin access policy names real routes", () => {
  it("matches every row to a registration that answers its method", () => {
    expect(httpRegistrations.size).toBeGreaterThan(50);
    const registered = [...httpRegistrations.values()].map((o) => ({ route: o.route, methods: o.methods || [] }));
    const unmatched = [];
    for (const row of POLICY) {
      const hit = registered.find((r) => r.route.toLowerCase() === row.route.toLowerCase());
      if (!hit) unmatched.push(`${row.method} ${row.route}: no such route`);
      else if (!hit.methods.map((m) => m.toUpperCase()).includes(row.method)) unmatched.push(`${row.method} ${row.route}: route answers ${hit.methods.join(",")}`);
    }
    expect(unmatched).toEqual([]);
  });

  it("names no route that only a token may call", () => {
    // Routes whose registration name says what they do, and which the owner
    // kept for people: publishing, deleting, settings, secrets, admins.
    const names = new Set([...httpRegistrations.keys()].map((n) => n.toLowerCase()));
    const routes = new Set(POLICY.map((row) => row.route.toLowerCase()));
    for (const name of names) {
      if (/^(publishcontent|savecontentschedule|unschedulecontent|unpublishcontenttoinspected|softdeletelivepage|delete\w+|cmssecrets|cmscredentials\w*|cmsadmins?\w*|cmsbootstrapreset|mcp\w*|cmsairouting\w*|cmsaifeatures|cmsaimodelcatalog\w*)$/.test(name)) {
        const reg = httpRegistrations.get([...httpRegistrations.keys()].find((k) => k.toLowerCase() === name));
        expect(routes.has(reg.route.toLowerCase()) && POLICY.some((r) => r.route.toLowerCase() === reg.route.toLowerCase() && r.method !== 'GET'), reg.route).toBe(false);
      }
    }
  });
});
