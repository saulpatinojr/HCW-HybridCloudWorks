/**
 * The route inventory — the replacement for the `firestore.rules` default-deny
 * catch-all, and the test `lib/auth/require-role.js` declares in its header as
 * *"the highest-value test in the port"*. It was declared and never written
 * (T-103).
 *
 * Firestore had `match /{document=**} { allow read, write: if false }`, which
 * caught every path the API forgot. Azure has no equivalent: every
 * `app.http` registration defaults to `authLevel: 'anonymous'`, so one handler
 * that forgets the guard IS the vulnerability, and it is invisible — the route
 * works, which is exactly what makes it easy to ship.
 *
 * This test enumerates every registration the Functions host would see and
 * asserts three properties of each:
 *
 *   1. **Guarded or explicitly public.** Either the route is named in
 *      `PUBLIC_ROUTES` below — a deliberate, reviewed decision — or invoking it
 *      reaches one of the recognised guards (`requireRole`, `requireUser`, or
 *      the Labs agent's `requireAgent`).
 *   2. **`OPTIONS` is registered.** Without it the host 404s a preflight before
 *      any handler runs, and every authenticated call preflights because it
 *      carries `Authorization`.
 *   3. **CORS is evaluated.** A disallowed origin is refused, and a preflight is
 *      answered, before the handler runs.
 *
 * Properties 2 and 3 are what T-102 got wrong: CORS was correct and wired into
 * one route of fifty-eight. Adding a route now fails this test unless it goes
 * through `httpRoute` and either guards or is consciously added to the
 * allowlist below.
 *
 * Adding a route to `PUBLIC_ROUTES` is a security decision. It means anyone on
 * the internet can call it, with no token, forever.
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
const GUARDS = [requireRole, requireUser, requireAgent];
const guardCalls = () => GUARDS.reduce((n, g) => n + g.mock.calls.length, 0);
const clearGuards = () => GUARDS.forEach((g) => g.mockClear());

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
const PUBLIC_ROUTES = new Set([
  // Telegram cannot send a bearer token, so `requireRole` has nothing to check.
  // Guarded instead by the X-Telegram-Bot-Api-Secret-Token header — which
  // Telegram echoes back from `setWebhook` — compared in constant time against
  // sha256(TELEGRAM_BOT_TOKEN), plus a second check that the sending chat id
  // matches TELEGRAM_CHAT_ID. See functions/telegram-http.js (T-512).
  "telegram/webhook",
  "health", // liveness probe; returns no data
  "public/content", // published documents only — lib/public-reads.js
  // The pre-render manifest's source (T-718). Published documents only,
  // asserted in the query, projected to the ARTICLE_FIELDS allowlist — every
  // field of which `public/content` above already serves. It is a bulk
  // endpoint rather than a new disclosure.
  //
  // It also does NOT rate-limit, which is load-bearing rather than an
  // oversight: anonymousKey() throws in production for a request that did not
  // arrive through Cloudflare, so a rate-limited route is unreachable from the
  // per-run origin window publish-content-manifest.yml opens. Same posture as
  // /api/health, which deploy-functions.yml already probes that way.
  "public/content-manifest",
  "public/content/{slugOrId}",
  "public/snapshots/{id}", // allowlisted to certifications + speakerevents
  "public/podcasts",
  "public/feed",
  "public/submissions", // anonymous write: validated, quota-limited, Cloudflare-verified
  // Newsletter double opt-in (#504, ADR 0030). Subscribe writes nothing to the
  // list — it emails a signed link — and is limited per caller AND per address,
  // because it is otherwise a way to make this site email a stranger. Confirm's
  // authorization is that link: an HMAC over the address and an expiry, keyed
  // off RESEND_API_KEY — lib/newsletter/confirmation-token.js.
  "public/newsletter/subscribe",
  "public/newsletter/confirm",
  // Where the signup box shows and its heading and blurb (#557). Three fields
  // projected by name from the settings document, never the postal address or
  // the reply-to it also holds; a read failure answers the defaults.
  "public/newsletter/signup-config",
  "public/media/{container}/{*blobPath}", // container allowlist — lib/blob-paths.js
  // Returns one field, `imageUrl`, for one cached news-article image — never
  // the document, which carries an internal blob path and prompt metadata. It
  // is here because the public news pages were calling the editor-gated
  // equivalent and rendering nothing (T-210).
  "public/curated-image/{id}",
  // Batched twin of the route above (T-739). Identical disclosure rules —
  // imageUrl only, archived withheld, whitespace treated as uncached — and
  // bounded at CURATED_IMAGE_BATCH_MAX so an anonymous caller cannot turn one
  // request into an unbounded point-read fan-out.
  "public/curated-images",
  // Staging preview for the Telegram approval loop (T-606). Anonymous, but the
  // HMAC token in ?t= is the authorization: signed over contentId + expiry
  // with PREVIEW_SIGNING_SECRET, 72 h TTL. Serves only forge_ready/editing/
  // approved documents, and every refusal — bad token, expired, unconfigured
  // secret, missing doc, wrong status — answers the identical 404, so the
  // route cannot be used as an existence oracle — lib/public-preview.js.
  "public/preview/{contentId}",
  // Approved Listen & Learn episodes for one certification. The generator
  // writes every episode as a draft and an editor approves them one at a time,
  // so this route returns only `status === 'published'` documents — the review
  // gate, not a display preference. Drafts, failures and transcripts awaiting
  // approval are reachable only through the editor-gated
  // `cms/listen-and-learn/*` routes.
  "public/listen-and-learn",
  // The provider-wide twin (#349): same `status === 'published'` gate, rows
  // projected to a listing allowlist with no transcript, for the podcast page.
  "public/listen-and-learn/episodes",
  // Certification lifecycle events from the Friday Skills Hub RSS scraper
  // (#461 item 4). Public because the Azure education timeline renders them
  // to every anonymous visitor; safe because the rows are a projection of a
  // public blog feed — title, summary, link, date, exam codes — filtered by
  // scraper source for a platform validated against the provider list, and
  // capped. No document id is accepted from the caller.
  "public/cert-events",
  // Reads no database, returns four enum values. The reason it is here rather
  // than guarded is that it backs indicators rendered to every anonymous
  // visitor on the landing page; the reason it is safe is that its cache bounds
  // what it can be made to do to the upstream status APIs — lib/platform-health.js
  "public/platform-health",
  // The pricing comparison's cache (#613): one point read of a document the
  // scheduled refresh wrote from three PUBLIC price lists, region validated
  // against a three-entry list, never a provider call on the request path —
  // lib/cloud-tools/public-pricing.js.
  "public/cloud-tools/pricing",
  // The price-change feed derived from that cache's daily snapshots (#613
  // Phase 3): the same one-point-read shape, region validated the same way,
  // no query and no provider call on the request path —
  // lib/cloud-tools/public-price-changes.js.
  "public/cloud-tools/price-changes",
  // "Explain this number" (#613 Phase 3): an anonymous AI call, which is the
  // one kind of public route that spends money. Acceptable because it is
  // bounded four ways — cached by a hash of the validated input (a shared
  // link costs one model call, ever), 5 per hour per Cloudflare-verified
  // client through the same counter as public/submissions, 200 per day across
  // everyone through a compare-and-increment, and an 8 KB body validated
  // field by field before any of that — lib/cloud-tools/explain/.
  "public/cloud-tools/explain",
  // "The Hybrid Lab right now" (#664, ADR 0032 decision 3): the Arc machine's
  // status, policy counts, the lab agent's queue and Coder capacity, read by
  // the Function App's own identity under Reader on rg-lab-hybrid-prod-cus.
  // Public because it backs a card every visitor to /education/labs sees;
  // safe because the read is one cached document rewritten at most once a
  // minute (a visitor cannot make it call Azure), the queries never project
  // the machine name, and the answer is { configured: false } rather than an
  // invented row when the estate is absent — lib/labs/estate.js.
  "public/labs/estate",
  // Coder's templates and running-workspace count through a server-side proxy
  // with a read-only token (#680, ADR 0032 decision 4), so the browser never
  // calls Coder and the SPA's connect-src stays closed. Same one-minute cache;
  // a failed read is cached as unreachable rather than serving stale numbers;
  // the response carries names and counts, never the URL or the token —
  // lib/labs/coder-status.js.
  "public/labs/coder-status",
  // Anonymous lab submission (#672, ADR 0032 decision 6): the one public
  // route that queues work on the lab host. CLOSED unless
  // LABS_PUBLIC_SUBMISSION_ENABLED is exactly "true" (the owner revised
  // decision 6 on 2026-09-28 and Terraform now sets it); closed, all three
  // verbs answer PUBLIC_SUBMISSION_CLOSED before reading the body, the caller
  // or the store. Open, a POST is taken only from the site's pane, by its
  // exact Origin and a Cloudflare Turnstile token siteverify passes, both
  // before any store read (lib/labs/public-lock.js); then it is bounded by
  // decision 6 and no wider: terraform-validate only, 64 KB, 2 an hour per
  // Cloudflare-verified client through the same counter as
  // public/submissions, 50 a day across everyone through a compare-and-
  // increment, refused while more than 20 jobs are queued, and refused
  // outright while no agent registered for the type is heartbeating; jobs
  // are written public: true with a one-day ttl. GET is whether a POST would
  // be taken, from a one-minute cache — lib/labs/public-submit.js.
  "public/labs/submit",
  // One public job's status and output for the page that queued it: public:
  // true documents only, an identical 404 for a missing, admin or expired
  // job, a UUID check before any read, and never the payload, the agent or
  // the requester. Behind the same switch — lib/labs/public-submit.js.
  "public/labs/job",
  // Visitor lab sessions (#1016, ADR 0032 amendment): brokered Coder workspaces
  // for visitors outside the org. Locked to the site's origin, Cloudflare
  // Turnstile verified, capped concurrency and daily client quota, automated
  // session reaping, fail-closed switch — lib/labs/visitor-session.js.
  "public/labs/visitor-session",
  // One AddOn's status through a server-side proxy (ADR 0035 decision 4),
  // so the site's pane at /tools/<id> opens only when the AddOn answers its
  // health read and the browser never calls the AddOn (connect-src stays
  // closed). Anonymous because it backs a public page; safe because it is
  // one cached document per known id, rewritten at most once a minute, the
  // ids are closed in lib/addons/registry.js (an unknown id answers 404
  // before any read), and the body is a six-field projection (configured,
  // reachable, version, edition, capabilities, asOf) that never carries the
  // AddOn's URL — lib/addons/status.js.
  "public/addons/{id}/status",
  // StreamYard On-Air webhook / Zapier relay: guarded by X-StreamYard-Api-Key /
  // Bearer token compared in constant time against STREAMYARD_API_KEY
  // (lib/streamyard/onair.js).
  "streamyard/webhook",
  // Public webinar registration on hybridcloudworks.com: validated, honeypot-
  // checked, Cloudflare-origin-verified and quota-limited per caller and per
  // address in submission_quota (lib/streamyard/onair.js).
  "public/webinars/register",
]);

const ALLOWED_ORIGIN = "https://hybridcloudworks.com";

const context = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

const makeRequest = ({ method = "GET", origin } = {}) => ({
  method,
  params: {},
  query: new Map(),
  headers: {
    get: (name) => (name.toLowerCase() === "origin" ? origin || null : null),
  },
  json: async () => ({ agentId: "inventory-probe" }),
  text: async () => "",
});

/** Invoke a registered handler, treating a throw as "did not reach the guard". */
async function invoke(options, request) {
  try {
    return await options.handler(request, context);
  } catch {
    return null;
  }
}

/**
 * No test in this file may touch the network.
 *
 * The properties below work by *invoking* every registered handler, and
 * `public/platform-health` really does call four third-party status APIs. On a
 * runner without egress those sockets hang until the handler's own 8 s abort
 * fires — past vitest's 5 s test timeout — so the suite failed in CI while
 * passing locally, where the connections are refused immediately. CI was right:
 * a route-inventory test that reaches the internet is not testing route
 * inventory.
 *
 * Rejecting rather than resolving is deliberate. It exercises the degradation
 * path, and it means a handler that starts making outbound calls cannot quietly
 * make this suite slow or flaky.
 */
beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in route-inventory tests");
    }),
  );
  await import("./index.js");
}, 30_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("route inventory", () => {
  it("registered the routes at all", () => {
    // A mocking mistake that silently records nothing would make every
    // assertion below vacuously pass.
    expect(httpRegistrations.size).toBeGreaterThan(50);
  });

  it("every public route in the allowlist is actually registered", () => {
    const registered = new Set(
      [...httpRegistrations.values()].map((o) => o.route),
    );
    const missing = [...PUBLIC_ROUTES].filter(
      (route) => !registered.has(route),
    );
    expect(missing).toEqual([]);
  });
});

describe("property 1 — every route is guarded or explicitly public", () => {
  it("enumerates each registration, for EVERY verb it answers", async () => {
    const unguarded = [];

    for (const [name, options] of httpRegistrations) {
      if (PUBLIC_ROUTES.has(options.route)) continue;

      // Every verb, not just methods[0] (T-732). httpRouteByMethod fans up to
      // three verbs behind one registration — admin-integrations-http.js
      // registers PUT/PATCH/DELETE on one route — so probing only the first
      // left the rest unchecked. Nothing was actually unguarded when this was
      // widened, but this test is the replacement for the firestore.rules
      // default-deny catch-all, and that catch-all had no per-verb blind spot.
      for (const method of options.methods.filter((m) => m !== "OPTIONS")) {
        clearGuards();
        await invoke(options, makeRequest({ method }));

        if (guardCalls() === 0) {
          unguarded.push(`${name} (${method} ${options.route})`);
        }
      }
    }

    // A name here is either a route that forgot the guard, or a route that
    // should be added to PUBLIC_ROUTES with a comment saying why.
    expect(unguarded).toEqual([]);
  });

  it("public routes do not consult the guard", async () => {
    const surprising = [];

    for (const [name, options] of httpRegistrations) {
      if (!PUBLIC_ROUTES.has(options.route)) continue;

      clearGuards();
      await invoke(options, makeRequest({ method: options.methods[0] }));

      if (guardCalls() > 0) {
        surprising.push(name);
      }
    }

    // Not a vulnerability if it happens — a guarded "public" route is merely
    // wrong about being public — but it means the allowlist is lying.
    expect(surprising).toEqual([]);
  });

  it("returns 401 or 403 for every guarded route on guard refusal", async () => {
    const unrefused = [];

    for (const [name, options] of httpRegistrations) {
      if (PUBLIC_ROUTES.has(options.route)) continue;

      for (const method of options.methods.filter((m) => m !== "OPTIONS")) {
        clearGuards();
        const res = await invoke(options, makeRequest({ method }));
        if (!res || (res.status !== 401 && res.status !== 403)) {
          unrefused.push(`${name} (${method} ${options.route}) returned ${res?.status}`);
        }
      }
    }

    expect(unrefused).toEqual([]);
  });
});

/**
 * The lab agent registry's write path (#740). Property 1 already proves these
 * reach *a* guard; this pins WHICH one. They write the record the agent guard
 * trusts, so they must sit behind the admin guard at the Labs write level and
 * must never be reachable with an agent's own credential — a VPS that could
 * call them could grant itself job types or rebind its identity, which is
 * exactly what lab-agent.js's heartbeat refuses to let it do. DELETE (owner
 * request 2026-09-28) removes a record, which an agent must no more be able to
 * do than write one: it could erase another agent's registration.
 */
describe("the lab agent registry routes (#740)", () => {
  const VERBS = {
    "cms/labs/agents": ["POST"],
    "cms/labs/agents/{agentId}": ["PATCH", "DELETE"],
  };

  it.each(Object.entries(VERBS))(
    "%s is one registration answering exactly %j",
    (route, verbs) => {
      const registrations = [...httpRegistrations.values()].filter(
        (o) => o.route === route,
      );
      expect(registrations).toHaveLength(1);
      expect(PUBLIC_ROUTES.has(route)).toBe(false);
      expect(registrations[0].methods).toEqual([...verbs, "OPTIONS"]);
    },
  );

  it.each(
    Object.entries(VERBS).flatMap(([route, verbs]) =>
      verbs.map((verb) => [route, verb]),
    ),
  )(
    "%s answers %s through requireRole at editor, never requireAgent",
    async (route, method) => {
      const options = [...httpRegistrations.values()].find(
        (o) => o.route === route,
      );

      clearGuards();
      await invoke(options, makeRequest({ method }));
      expect(requireRole).toHaveBeenCalledTimes(1);
      expect(requireRole.mock.calls[0][1]).toBe("editor");
      expect(requireAgent).not.toHaveBeenCalled();
    },
  );
});

/**
 * The lab start counts (lib/labs/lab-starts.js). Property 1 proves the route
 * reaches a guard; this pins the one route, the one verb and the role. It is
 * a read of aggregate counts for the Labs hub Dashboard card: editor, like the
 * Labs reads beside it, never public (the counts are for the owner's letters,
 * not for visitors), and never reachable with an agent's credential. The write
 * is not a route of its own: it happens inside public/labs/visitor-session.
 */
describe("the lab start counts route", () => {
  const ROUTE = "cms/labs/starts";

  it("is one GET registration and not public", () => {
    const registrations = [...httpRegistrations.values()].filter(
      (o) => o.route === ROUTE,
    );
    expect(registrations).toHaveLength(1);
    expect(PUBLIC_ROUTES.has(ROUTE)).toBe(false);
    expect(registrations[0].methods).toEqual(["GET", "OPTIONS"]);
  });

  it("answers through requireRole at editor, and a refusal reads nothing", async () => {
    const options = [...httpRegistrations.values()].find(
      (o) => o.route === ROUTE,
    );

    clearGuards();
    const res = await invoke(options, makeRequest({ method: "GET" }));
    expect(requireRole).toHaveBeenCalledTimes(1);
    expect(requireRole.mock.calls[0][1]).toBe("editor");
    expect(requireAgent).not.toHaveBeenCalled();
    expect(res?.status).toBe(403);
  });
});

/**
 * The Drafts stage, /admin/drafts (owner request 2026-10-03). Property 1
 * proves these reach a guard; this pins the role and the verbs. They create,
 * edit, move and delete content documents, so they sit behind requireRole at
 * editor — the role that creates and reviews content everywhere else — and
 * are never public: an anonymous caller could otherwise write the owner's
 * drafts or push them into review. One registration per template
 * (property 4).
 *
 * The routes that read drafts from the repository, cms/content/import-repo
 * with its candidates list and cms/drafts/import-repo, are retired (pre-publish
 * drafts do not live in the public repository), and asserted absent so they
 * cannot quietly come back as a second path into review.
 */
describe("the Drafts stage routes", () => {
  const VERBS = {
    "cms/drafts": ["GET", "POST"],
    "cms/drafts/{id}": ["GET", "PUT", "DELETE"],
    "cms/drafts/{id}/send-to-review": ["POST"],
    "cms/drafts/{id}/back-to-drafts": ["POST"],
    "cms/drafts/from-markdown": ["POST"],
  };

  it.each(Object.entries(VERBS))(
    "%s is one registration answering exactly %j",
    (route, verbs) => {
      const registrations = [...httpRegistrations.values()].filter(
        (o) => o.route === route,
      );
      expect(registrations).toHaveLength(1);
      expect(PUBLIC_ROUTES.has(route)).toBe(false);
      expect(registrations[0].methods).toEqual([...verbs, "OPTIONS"]);
    },
  );

  it.each(
    Object.entries(VERBS).flatMap(([route, verbs]) =>
      verbs.map((verb) => [route, verb]),
    ),
  )(
    "%s answers %s through requireRole at editor, and nothing runs behind a refusal",
    async (route, method) => {
      const options = [...httpRegistrations.values()].find(
        (o) => o.route === route,
      );

      clearGuards();
      const res = await invoke(options, makeRequest({ method }));
      expect(requireRole).toHaveBeenCalledTimes(1);
      expect(requireRole.mock.calls[0][1]).toBe("editor");
      // The guard's refusal is the answer: nothing ran behind it, including the
      // fetch that the network stub above would have rejected.
      expect(res?.status).toBe(403);
    },
  );

  it("the routes that import drafts from the repository are gone", () => {
    const routes = new Set([...httpRegistrations.values()].map((o) => o.route));
    expect(routes.has("cms/content/import-repo")).toBe(false);
    expect(routes.has("cms/content/import-repo/candidates")).toBe(false);
    expect(routes.has("cms/drafts/import-repo")).toBe(false);
  });
});

/**
 * The admin lifecycle routes (AP-B5, #940).
 * Property 1 proves these reach a guard; this pins them to super_admin.
 * They list admins, change roles, deactivate accounts and reset bootstrap,
 * which is the root of administrative authority across the estate.
 */
describe("the admin lifecycle routes (#940)", () => {
  const VERBS = {
    "cms/admins": ["GET"],
    "cms/admins/{id}": ["PATCH", "DELETE"],
    "cms/bootstrap/reset": ["POST"],
  };

  it.each(Object.entries(VERBS))(
    "%s is one registration answering exactly %j",
    (route, verbs) => {
      const registrations = [...httpRegistrations.values()].filter(
        (o) => o.route === route,
      );
      expect(registrations).toHaveLength(1);
      expect(PUBLIC_ROUTES.has(route)).toBe(false);
      expect(registrations[0].methods).toEqual([...verbs, "OPTIONS"]);
    },
  );

  it.each(
    Object.entries(VERBS).flatMap(([route, verbs]) =>
      verbs.map((verb) => [route, verb]),
    ),
  )(
    "%s answers %s through requireRole at super_admin",
    async (route, method) => {
      const options = [...httpRegistrations.values()].find(
        (o) => o.route === route,
      );

      clearGuards();
      const res = await invoke(options, makeRequest({ method }));
      expect(requireRole).toHaveBeenCalledTimes(1);
      expect(requireRole.mock.calls[0][1]).toBe("super_admin");
      expect(res?.status).toBe(403);
    },
  );
});

describe("property 2 — every route accepts OPTIONS", () => {
  it("so a preflight is not 404ed before any handler runs", () => {
    const missing = [...httpRegistrations.entries()]
      .filter(([, options]) => !options.methods.includes("OPTIONS"))
      .map(([name, options]) => `${name} (${options.route})`);

    expect(missing).toEqual([]);
  });
});

describe("property 3 — every route evaluates CORS", () => {
  it("refuses a disallowed origin before the handler runs", async () => {
    const notEvaluated = [];

    for (const [name, options] of httpRegistrations) {
      clearGuards();
      const res = await invoke(
        options,
        makeRequest({
          method: options.methods[0],
          origin: "https://evil.test",
        }),
      );

      if (res?.status !== 403 || guardCalls() > 0) {
        notEvaluated.push(`${name} (${options.route})`);
      }
    }

    expect(notEvaluated).toEqual([]);
  });

  it("answers a preflight with 204 and the full method list", async () => {
    const broken = [];

    for (const [name, options] of httpRegistrations) {
      const res = await invoke(
        options,
        makeRequest({ method: "OPTIONS", origin: ALLOWED_ORIGIN }),
      );

      const methods = res?.headers?.["Access-Control-Allow-Methods"] || "";
      const advertisesEverything = [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ].every((verb) => methods.includes(verb));

      if (res?.status !== 204 || !advertisesEverything) {
        broken.push(`${name} (${options.route})`);
      }
    }

    expect(broken).toEqual([]);
  });
});

describe("non-HTTP triggers", () => {
  it("the scheduler timers stay behind one feature flag", () => {
    // Not an authorization surface, but they are registrations, and two of
    // them delete blobs (cleanupTempStorage and cleanupUnusedCertImages, both
    // dry-run until their own *_DELETE setting, T-302). The
    // nineteen are the timers in schedulers.js — the seventeen from T-323 plus
    // buildWeeklyNewsletter (#504) and probeAiProviders (#701); the twentieth
    // is platformJobSweeper (jobs-sweeper.js), behind its own flag; the
    // twenty-first is cosmosExportScheduler (cosmos-export.js, ADR 0028),
    // behind FEATURE_FLAG_COSMOS_EXPORT; the twenty-second is
    // refreshToolServiceCache (cloud-tools-jobs.js, #613), behind
    // FEATURE_FLAG_REFRESH_TOOL_SERVICE_CACHE; the twenty-third is
    // labsWeeklyRollup (labs-jobs.js, #665), behind
    // FEATURE_FLAG_LABS_WEEKLY_ROLLUP; the twenty-fourth is sendReminders
    // (schedulers.js, owner request 2026-10-06), behind
    // FEATURE_FLAG_SEND_REMINDERS; the twenty-fifth is healthPulse
    // (schedulers.js, #1010), behind FEATURE_FLAG_HEALTH_PULSE; the
    // twenty-sixth is labCanary (schedulers.js, #1009), behind
    // FEATURE_FLAG_LAB_CANARY; the twenty-seventh is
    // ambassadorAudienceMonthly (ambassador-audience.js, #1302), behind
    // FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY.
    expect(timerRegistrations.size).toBe(27);
    expect(timerRegistrations.has("ambassadorAudienceMonthly")).toBe(true);
    expect(timerRegistrations.has("healthPulse")).toBe(true);
    expect(timerRegistrations.has("labCanary")).toBe(true);
    expect(timerRegistrations.has("platformJobSweeper")).toBe(true);
    expect(timerRegistrations.has("cosmosExportScheduler")).toBe(true);
    expect(timerRegistrations.has("refreshToolServiceCache")).toBe(true);
    expect(timerRegistrations.has("labsWeeklyRollup")).toBe(true);
    expect(timerRegistrations.has("buildWeeklyNewsletter")).toBe(true);
    expect(timerRegistrations.has("probeAiProviders")).toBe(true);
    for (const name of ["cleanupTempStorage", "cleanupUnusedCertImages"]) {
      // The two that delete blobs: registered, and their handlers are the
      // dry-run-by-default factories (lib/timers/temp-storage.js, cert-image-cleanup.js).
      expect(timerRegistrations.has(name)).toBe(true);
    }
  });

  it("the platform job worker is the only queue trigger, on the identity-based host connection", () => {
    // lib/jobs.js (T-322). A second queue trigger is a second place long work
    // can run unreviewed; make adding one a visible act.
    expect([...queueRegistrations.keys()]).toEqual(["platformJobWorker"]);
    const worker = queueRegistrations.get("platformJobWorker");
    expect(worker.queueName).toBe("platform-jobs");
    expect(worker.connection).toBe("AzureWebJobsStorage");
  });

  it("registers the six change-feed functions on the identity-based binding, one lease prefix each", () => {
    // T-324. A change-feed function runs its processor continuously and bills
    // lease-container RU, so every registration is a deliberate act; and the
    // binding is the identity form (COSMOS_CONNECTION__accountEndpoint +
    // __credential), never COSMOS_CONNECTION_STRING — the account primary key
    // that used to sit in app settings for two empty TODO handlers (T-315).
    expect([...cosmosRegistrations.keys()].sort()).toEqual([
      "mirrorCertificationImages",
      "mirrorSpeakerEventImages",
      "notifyWorkflowAlerts",
      "processBlogChanges",
      "processContentChanges",
      "syncSocialPostsToPubler",
    ]);
    const prefixes = new Set();
    for (const [name, options] of cosmosRegistrations) {
      expect(options.connection).toBe("COSMOS_CONNECTION");
      expect(options.leaseContainerName).toBe("leases");
      expect(options.createLeaseContainerIfNotExists).toBe(false);
      expect(options.leaseContainerPrefix).toBe(`${name}-`);
      prefixes.add(options.leaseContainerPrefix);
    }
    expect(prefixes.size).toBe(6);
    expect(
      [...cosmosRegistrations.values()].map((o) => o.containerName).sort(),
    ).toEqual([
      "blogs",
      "certifications",
      "content",
      "social_posts",
      "speakerevents",
      "workflow_alerts",
    ]);
  });

  it("starts every change feed from now, never from the beginning of its container (#817)", () => {
    // startFromBeginning: true on a new lease prefix replays the whole
    // container. On `content` that is a paid model call, up to four image
    // generations, a caption and a Publer post per document, for every
    // document ever written.
    for (const [name, options] of cosmosRegistrations) {
      expect(options.startFromBeginning, name).toBe(false);
    }
  });

  it("caps the content feed at 8 documents a batch, and the mirror feeds at 50 (#817)", () => {
    // T-731: one content document can need several paid calls, so fifty of
    // them cannot finish inside any timeout; the mirrors do one blob copy each.
    for (const [name, options] of cosmosRegistrations) {
      const expected = options.containerName === "content" ? 8 : 50;
      expect(options.maxItemsPerInvocation, name).toBe(expected);
    }
  });

  it("returns from an empty or missing batch without doing any work (#817)", async () => {
    const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    for (const [, options] of cosmosRegistrations) {
      await expect(options.handler([], context)).resolves.toBeUndefined();
      await expect(
        options.handler(undefined, context),
      ).resolves.toBeUndefined();
    }
    expect(context.log).not.toHaveBeenCalled();
  });
});

/**
 * Property 4 — the one the host enforces and the other three cannot see.
 *
 * Properties 1–3 ask whether each registration is *correct*. This asks whether
 * the set of them is *servable*, which is a different question and the one that
 * shipped broken: the Azure Functions host keys its route table on the route
 * template ALONE, not on template + method. Two functions declaring the same
 * `route` with different `methods` are a conflict — the host starts one and
 * refuses the other with "is in error: The route specified conflicts with the
 * route defined by function X". The losing verb answers 404.
 *
 * Seven `cms/*` templates were declared two or three times each and eight
 * functions never started: list, patch and put across certifications,
 * recordings, social posts, settings, config and keyword-config, which is most
 * of what the admin UI does (T-510). Every one of those registrations
 * passed properties 1, 2 and 3 — individually they were all fine.
 *
 * `httpRegistrations` is keyed by function NAME, which is exactly why the
 * mock could not see it: two functions sharing a route are two distinct keys.
 * The fix is `httpRouteByMethod` — one template, one registration, the method
 * fan-out inside it — and this test is what keeps a second one from appearing.
 *
 * Templates are compared with parameter names collapsed (`{id}` and `{docId}`
 * are the same template to a router) and case-folded, because ASP.NET routing
 * matches on shape, not on spelling.
 */
describe("property 4 — no two registrations share a route template", () => {
  const normalise = (route) =>
    String(route ?? "")
      .toLowerCase()
      .replace(/\{[^}]*\}/g, "{}");

  it("because the host would refuse to start all but one of them", () => {
    const byTemplate = new Map();
    for (const [name, options] of httpRegistrations) {
      const template = normalise(options.route);
      if (!byTemplate.has(template)) byTemplate.set(template, []);
      byTemplate.get(template).push(name);
    }

    const conflicts = [...byTemplate.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([template, names]) => `${template} <- ${names.join(", ")}`);

    // A failure here means the host will 404 a verb that the code, the tests
    // and the API surface all say exists. Merge the registrations with
    // httpRouteByMethod rather than renaming the route.
    expect(conflicts).toEqual([]);
  });

  it("and every method a merged registration declares has a handler behind it", async () => {
    // httpRouteByMethod fans out on request.method. A method listed in
    // `methods` with nothing in `handlers` would 405 at runtime — reachable
    // only by editing one and not the other, which is precisely the kind of
    // drift the merge is supposed to end.
    const merged = [...httpRegistrations.entries()].filter(
      ([, options]) =>
        options.methods.filter((m) => m !== "OPTIONS").length > 1,
    );
    expect(merged.length).toBeGreaterThan(0);

    for (const [name, options] of merged) {
      for (const method of options.methods) {
        if (method === "OPTIONS") continue;
        const response = await invoke(
          options,
          makeRequest({ method, origin: ALLOWED_ORIGIN }),
        );
        // `invoke` returns null when the handler threw, which every guarded
        // route does on an unauthenticated probe — that is a reached handler,
        // not a missing one. Only an actual 405 means the dispatcher found no
        // entry for the method it declared.
        expect(
          response?.status,
          `${name} ${method} fell through to the 405 branch — no handler registered`,
        ).not.toBe(405);
      }
    }
  });
});

/**
 * The Doc Vault, /admin/doc-vault (owner request 2026-10-26). Property 1
 * proves these reach a guard; this pins the role and the verbs. They hold the
 * owner's private letters, applications and notes, so every route, reads
 * included, sits behind requireRole at publisher (above the editor role that
 * collaborators hold) and none is public. One registration per template
 * (property 4).
 */
describe("the Doc Vault routes", () => {
  const VERBS = {
    "cms/doc-vault": ["GET", "POST"],
    "cms/doc-vault/upload": ["POST"],
    "cms/doc-vault/{id}": ["GET", "PUT", "DELETE"],
    "cms/doc-vault/{id}/untrash": ["POST"],
    "cms/doc-vault/{id}/versions/{version}": ["GET"],
    "cms/doc-vault/{id}/restore-version": ["POST"],
  };

  it.each(Object.entries(VERBS))(
    "%s is one registration answering exactly %j, and is not public",
    (route, verbs) => {
      const registrations = [...httpRegistrations.values()].filter(
        (o) => o.route === route,
      );
      expect(registrations).toHaveLength(1);
      expect(PUBLIC_ROUTES.has(route)).toBe(false);
      expect(registrations[0].methods).toEqual([...verbs, "OPTIONS"]);
    },
  );

  it.each(
    Object.entries(VERBS).flatMap(([route, verbs]) =>
      verbs.map((verb) => [route, verb]),
    ),
  )(
    "%s answers %s through requireRole at publisher, and nothing runs behind a refusal",
    async (route, method) => {
      const options = [...httpRegistrations.values()].find(
        (o) => o.route === route,
      );

      clearGuards();
      const res = await invoke(options, makeRequest({ method }));
      expect(requireRole).toHaveBeenCalledTimes(1);
      expect(requireRole.mock.calls[0][1]).toBe("publisher");
      expect(requireUser).not.toHaveBeenCalled();
      expect(res?.status).toBe(403);
    },
  );

  it("registers no route for the vault beyond these", () => {
    const routes = [...httpRegistrations.values()]
      .map((o) => o.route)
      .filter((route) => route.startsWith("cms/doc-vault"));
    expect(routes.sort()).toEqual(Object.keys(VERBS).sort());
  });
});
