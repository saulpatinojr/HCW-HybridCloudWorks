/**
 * Public routes speak to visitors only (owner direction 2026-09-28).
 *
 * "Scrub all user-facing pages; remove references to backend workings. The
 * user only knows the front end and doesn't know about tools we use (i.e.
 * Cloudflare, etc.), or when you mention items that the admin needs to
 * resolve." The lab's status read had been answering, word for word, "The
 * lab is not taking public jobs yet: its browser check (Cloudflare
 * Turnstile) is not configured." — to anyone, and the Landing Zone Builder
 * printed it under its button.
 *
 * What a `public/*` route returns in `error`, `reason` or `message` is text a
 * page may show, so it must name no vendor the site runs on, no model, no
 * setting, and nothing an admin fixes. Machine-readable `code` values are
 * exempt: they stay for logs and the admin pages (`TURNSTILE_NOT_CONFIGURED`
 * is still the code), and the frontend maps each code to its own words.
 * Log lines (`context.warn` and friends) are where the backend detail goes,
 * so they are not scanned.
 *
 * Three checks, each for a different way the words could come back:
 *
 *   1. THE SENTENCE TABLES. Every visitor sentence the lab and explain
 *      routes build their refusals from.
 *   2. THE SOURCE. Every string literal a module behind a public route puts
 *      in an `error`, `reason` or `message` property, or in a thrown
 *      `Error`/`Refusal` (whose message a handler may return), read from the
 *      parsed module so comments and log lines are not mistaken for it. The
 *      module list is checked against the registrations, so a new public
 *      route file fails here until its modules are listed.
 *   3. THE RESPONSES. The lab status read in every door state, a refused lab
 *      submission, and every explain refusal, driven through the handlers,
 *      with every string in the body scanned except `code`.
 *   4. THE LAB REPORT. The public job read, driven through its handler with
 *      the owner's real job log (lib/labs/fixtures: the run that passed, the
 *      same run with Terraform errors injected, and a job that failed before
 *      Terraform ran). The log is the runner's: the image pull with its
 *      registry and digests, module paths under /opt/avm, the host. The
 *      answer must carry none of it (LAB_TOKENS below, this file's own list,
 *      not the module's), and never the raw `output` (owner request
 *      2026-09-28).
 *
 * The parser is Vite's (`parseSync`, rolldown's oxc parser), which vitest
 * brings with it; nothing is added to package.json for it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { describe, expect, it, vi } from "vitest";

import {
  EXPLAIN_CODES,
  EXPLAIN_REASONS,
  createExplainHandlers,
} from "./cloud-tools/explain/index.js";
import {
  DOOR_CODES,
  DOOR_REASONS,
  LIMIT_CODES,
  LIMIT_REASONS,
  LOCK_CODES,
  LOCK_REASONS,
  PUBLIC_SUBMISSION_SWITCH,
  TURNSTILE_SECRET_SETTING,
  createPublicSubmitHandlers,
} from "./labs/public-submit.js";
import { REPORT_LINES } from "./labs/visitor-report.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const FRONTEND_SRC = join(SRC, "..", "..", "frontend", "src");

/**
 * Words a visitor must never read from the API: the vendors and tools the
 * site runs on, model names, and the vocabulary of an admin's to-do list.
 * Each is `[why, pattern]`, and the failure message names the why.
 */
const BACKEND_TERMS = Object.freeze([
  ["the edge and its browser check", /cloudflare|turnstile/i],
  ["the API host", /azure functions?\b|function app|static web app/i],
  ["the data and secret stores", /cosmos|key ?vault/i],
  [
    "an AI provider or model",
    /gemini|openai|anthropic|nvidia|\b(?:gpt|claude)-\d/i,
  ],
  ["an integration vendor", /elevenlabs|rss\.com|publer|\bresend\b|hostinger/i],
  ["the delivery pipeline", /github (?:app|actions)|\bTFC\b|hcp terraform/i],
  ["the lab host", /\bvps\b|vps-hostinger|\bagent\b/i],
  ["an internal limit", /queue ceiling|\bTTL\b/i],
  [
    "an admin to-do",
    /not configured|\bprovisioned\b|\bowner\b|\badmin\b|\bsecret\b|\bseed(?:ed)?\b|\bdeploy/i,
  ],
  ["an HTTP status", /\bHTTP \d{3}\b/i],
  ["a model", /\bmodel\b/i],
]);

/** The backend terms a sentence contains, as `why: match` strings. */
function backendTermsIn(text) {
  const found = [];
  for (const [why, pattern] of BACKEND_TERMS) {
    const match = String(text).match(pattern);
    if (match) found.push(`${why}: "${match[0]}"`);
  }
  return found;
}

/**
 * What the lab's job log carries that a visitor must never read: the runner's
 * image, its registry and digests, the pull, its paths and the host. Kept
 * here rather than imported from visitor-report.js, so loosening the
 * module's own filter cannot loosen this guard. `ghcr` is matched as a word,
 * which covers ghcr.io, because a host-shaped pattern reads to CodeQL as an
 * unanchored URL check.
 */
const LAB_TOKENS = Object.freeze([
  /\bghcr\b/i,
  /sha256:/i,
  /\bdocker\b/i,
  /\bpulling\b/i,
  /\/opt\//,
  /\.\.\/\.\.\/\.\.\//,
  /hcw-lab-runner/i,
  /\bimage\b/i,
  /\bregistry\b/i,
  /vps-hostinger|srv939861|hostinger/i,
  /\(unauthenticated\)/i,
]);

const labTokensIn = (text) =>
  LAB_TOKENS.map((pattern) => String(text).match(pattern)?.[0]).filter(Boolean);

/**
 * Every file that registers a `public/*` route, and the modules its handlers'
 * words come from. The registration file itself is always scanned too.
 */
const PUBLIC_ROUTE_MODULES = Object.freeze({
  "functions/cloud-tools-http.js": [
    "lib/cloud-tools/explain/handler.js",
    "lib/cloud-tools/explain/validate.js",
    "lib/cloud-tools/explain/kinds/index.js",
    "lib/cloud-tools/explain/kinds/pricing.js",
    "lib/cloud-tools/explain/kinds/landingZone.js",
  ],
  // The AddOn status proxy (ADR 0035): one cached, projected read per known
  // id; its only words are the 404 for an unknown id and the 500 sentence.
  "functions/addons-public-http.js": [
    "lib/addons/status.js",
    "lib/addons/registry.js",
  ],
  "functions/labs-public-http.js": [
    "lib/labs/estate.js",
    "lib/labs/coder-status.js",
    "lib/labs/minute-cache.js",
    "lib/labs/public-submit.js",
    "lib/labs/public-bounds.js",
    "lib/labs/public-lock.js",
    "lib/labs/public-job.js",
    "lib/labs/visitor-report.js",
  ],
  "functions/newsletter-http.js": [
    "lib/newsletter/handlers.js",
    "lib/newsletter/signup-config.js",
  ],
  "functions/platform-health-http.js": ["lib/platform-health.js"],
  "functions/public-content-manifest.js": ["lib/public-content-manifest.js"],
  "functions/public-media.js": ["lib/public-media.js"],
  "functions/public-preview.js": ["lib/public-preview.js"],
  "functions/public-reads.js": [
    "lib/public-reads.js",
    "lib/cloud-tools/public-pricing.js",
    "lib/cloud-tools/public-price-changes.js",
  ],
  "functions/public-submissions.js": ["lib/submissions.js"],
  "functions/streamyard-http.js": ["lib/streamyard/onair.js"],
});

/** The wrapper every route goes through answers a wrong method itself. */
const SHARED_MODULES = Object.freeze(["lib/auth/http-route.js"]);

const VISITOR_KEYS = new Set(["error", "reason", "message"]);
const THROWN = /Error$|^Refusal$/;
/** The helpers the handlers build a response with; their string arguments are its words. */
const RESPONDERS = new Set([
  "refusal",
  "reply",
  "respond",
  "json",
  "jsonResponse",
]);
/** A machine-readable code, which is not prose and is exempt. */
const CODE = /^[A-Z][A-Z0-9_]+$/;

const keyName = (property) =>
  property.key?.type === "Identifier" ? property.key.name : property.key?.value;

/** Both sides of a `&&`, `||`, `??` or `+`. */
const bothSides = (node) => [
  ...literalText(node.left),
  ...literalText(node.right),
];

/** How each kind of expression yields text; anything not listed yields none. */
const TEXT_OF = Object.freeze({
  Literal: (node) => (typeof node.value === "string" ? [node.value] : []),
  TemplateLiteral: (node) => [
    node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("…"),
  ],
  ConditionalExpression: (node) => [
    ...literalText(node.consequent),
    ...literalText(node.alternate),
  ],
  LogicalExpression: bothSides,
  BinaryExpression: bothSides,
});

/** The literal text an expression can evaluate to: literals, template text, both arms of a choice. */
function literalText(node) {
  return TEXT_OF[node?.type]?.(node) ?? [];
}

/** Walk every node of an ESTree tree. */
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "type" && value && typeof value === "object")
      walk(value, visit);
  }
}

/**
 * The visitor-facing literals in one module: `error`/`reason`/`message`
 * property values, the string arguments of a response helper (codes aside),
 * and the first argument of a thrown Error or Refusal.
 */
function visitorLiterals(source, filename) {
  const { program, errors } = parseSync(filename, source);
  if (errors.length)
    throw new Error(`${filename} did not parse: ${errors[0].message}`);
  const found = [];
  walk(program, (node) => {
    if (node.type === "Property" && VISITOR_KEYS.has(keyName(node))) {
      found.push(...literalText(node.value));
    }
    if (
      node.type === "CallExpression" &&
      RESPONDERS.has(node.callee?.name ?? "")
    ) {
      found.push(
        ...node.arguments
          .flatMap(literalText)
          .filter((text) => !CODE.test(text)),
      );
    }
    if (node.type === "NewExpression" && THROWN.test(node.callee?.name ?? "")) {
      found.push(...literalText(node.arguments[0]));
    }
  });
  return found;
}

const read = (rel) => readFileSync(join(SRC, rel), "utf8");

describe("the backend-terms check itself", () => {
  it.each([
    "The lab is not taking public jobs yet: its browser check (Cloudflare Turnstile) is not configured.",
    "gemini-3.5-flash-lite",
    "The lab's queue is full (queue ceiling 20).",
    "Ask the owner to seed the secret.",
    "Public API request failed with HTTP 503",
  ])("catches %j", (sentence) => {
    expect(backendTermsIn(sentence)).not.toEqual([]);
  });

  it.each([
    "Validation on the lab isn't available right now. You can still download the files and validate locally.",
    "You've reached the limit for explanations for now. Try again in about an hour.",
    "Please enter a valid email address.",
  ])("passes %j", (sentence) => {
    expect(backendTermsIn(sentence)).toEqual([]);
  });

  it("reads a literal out of an error property, a template, a choice, a response helper and a thrown Error, but not a log line or a code", () => {
    const source = [
      "const a = { error: 'plain' };",
      "const b = { reason: `templated ${x} end` };",
      "const c = { message: ok ? 'yes' : 'no' };",
      "throw new Error('thrown');",
      "const e = refusal(503, 'LAB_PAUSED_FOR_TODAY', `paused ${n}`);",
      "context.warn('Cloudflare said no');",
      "const d = { code: 'TURNSTILE_NOT_CONFIGURED' };",
    ].join("\n");
    expect(visitorLiterals(source, "probe.js")).toEqual([
      "plain",
      "templated … end",
      "yes",
      "no",
      "thrown",
      "paused …",
    ]);
  });
});

describe("the sentence tables the lab and explain routes answer with", () => {
  const tables = {
    DOOR_REASONS,
    LOCK_REASONS,
    LIMIT_REASONS,
    EXPLAIN_REASONS,
    REPORT_LINES,
  };
  const rows = Object.entries(tables).flatMap(([table, sentences]) =>
    Object.entries(sentences).map(([code, sentence]) => [
      `${table}.${code}`,
      sentence,
    ]),
  );

  it.each(rows)("%s names nothing behind the site", (_row, sentence) => {
    expect(backendTermsIn(sentence)).toEqual([]);
    expect(labTokensIn(sentence)).toEqual([]);
  });

  it("gives every closed door the same sentence, which points at the download", () => {
    const closed = [
      DOOR_CODES.closed,
      DOOR_CODES.unconfigured,
      DOOR_CODES.offline,
      DOOR_CODES.unavailable,
    ];
    for (const code of closed) {
      expect(DOOR_REASONS[code], code).toBe(
        "Validation on the lab isn't available right now. You can still download the files and validate locally.",
      );
    }
  });
});

describe("the pages word every code themselves", () => {
  // The pages never render `reason` or `error`; each maps the code to its own
  // sentence. A code the page does not know falls back to a generic line,
  // which is safe but vague, so every code the routes answer must be mapped.
  const readFrontend = (rel) => readFileSync(join(FRONTEND_SRC, rel), "utf8");

  it("the lab control maps every door, lock and limit code", () => {
    const rules = readFrontend("pages/tools/landingZone/labValidateRules.js");
    const codes = [DOOR_CODES, LOCK_CODES, LIMIT_CODES].flatMap((table) =>
      Object.values(table),
    );
    for (const code of codes)
      expect(rules, code).toMatch(new RegExp(`\\b${code}\\b`));
  });

  it("the explain control maps every refusal a retry would not fix", () => {
    const control = readFrontend("pages/tools/explain/ExplainControl.jsx");
    for (const code of [
      EXPLAIN_CODES.unavailable,
      EXPLAIN_CODES.rateLimited,
      EXPLAIN_CODES.paused,
    ]) {
      expect(control, code).toContain(`'${code}'`);
    }
  });
});

describe("the source of every public route", () => {
  it("lists every file that registers a public route", () => {
    const registering = readdirSync(join(SRC, "functions"))
      .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
      .filter((name) => /route:\s*['"]public\//.test(read(`functions/${name}`)))
      .map((name) => `functions/${name}`)
      .sort();
    expect(registering).toEqual(Object.keys(PUBLIC_ROUTE_MODULES).sort());
  });

  const modules = [
    ...new Set([
      ...Object.keys(PUBLIC_ROUTE_MODULES),
      ...Object.values(PUBLIC_ROUTE_MODULES).flat(),
      ...SHARED_MODULES,
    ]),
  ];

  it.each(modules)(
    "%s puts no backend term in a visitor-facing string",
    (rel) => {
      const offending = visitorLiterals(read(rel), rel)
        .map((text) => [text, backendTermsIn(text)])
        .filter(([, terms]) => terms.length);
      expect(offending).toEqual([]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* The responses, driven through the handlers                                  */
/* -------------------------------------------------------------------------- */

/** Every string in a response body, by path, except the machine-readable `code`. */
function bodyStrings(value, path = "body") {
  if (typeof value === "string") return [[path, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "code" ? [] : bodyStrings(child, `${path}.${key}`),
  );
}

function expectVisitorOnly(res) {
  const offending = bodyStrings(JSON.parse(res.body))
    .map(([path, text]) => [path, text, backendTermsIn(text)])
    .filter(([, , terms]) => terms.length);
  expect(offending).toEqual([]);
}

const NOW = Date.parse("2026-09-28T12:00:00Z");
const newContext = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
const headersOf = (map) => ({
  get: (name) => map[String(name).toLowerCase()] ?? null,
});

/** A store holding what the door reads: the agents, and the queued count. */
function labStore({ agents = [], queued = 0, fail = false } = {}) {
  return {
    queryDocs: vi.fn(async (container) => {
      if (fail) throw new Error("store down");
      return container === "lab_agents" ? agents : [queued];
    }),
    readDoc: vi.fn(async () => null),
    upsertDoc: vi.fn(async (_container, doc) => doc),
    createDoc: vi.fn(async (_container, doc) => doc),
    incrementIf: vi.fn(async () => {
      throw Object.assign(new Error("missing"), { code: 404 });
    }),
    replaceDocIfMatch: vi.fn(async (_container, doc) => doc),
  };
}

const onlineAgent = {
  lastSeenAt: new Date(NOW - 10_000).toISOString(),
  capabilities: ["terraform-validate"],
};

function labHandlers({ env, store }) {
  return createPublicSubmitHandlers({
    identity: {
      anonymousKey: () => ({ key: "client-hash", trusted: true }),
      trustedClientIp: () => null,
    },
    store,
    env,
    now: () => NOW,
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: false }),
    })),
  });
}

const OPEN = {
  [PUBLIC_SUBMISSION_SWITCH]: "true",
  [TURNSTILE_SECRET_SETTING]: "secret-value",
};
const statusRequest = {
  method: "GET",
  headers: headersOf({}),
  text: async () => "",
};

describe("what the lab routes answer", () => {
  it.each([
    ["switched off", { env: {}, store: labStore() }, DOOR_CODES.closed],
    [
      "switched on with no browser-check secret",
      { env: { [PUBLIC_SUBMISSION_SWITCH]: "true" }, store: labStore() },
      DOOR_CODES.unconfigured,
    ],
    ["no runner online", { env: OPEN, store: labStore() }, DOOR_CODES.offline],
    [
      "a full queue",
      { env: OPEN, store: labStore({ agents: [onlineAgent], queued: 99 }) },
      DOOR_CODES.full,
    ],
    [
      "an unreadable lab",
      { env: OPEN, store: labStore({ fail: true }) },
      DOOR_CODES.unavailable,
    ],
  ])(
    "the status read, %s, keeps the code and says only visitor words",
    async (_label, deps, code) => {
      const res = await labHandlers(deps).getSubmissionStatus(
        statusRequest,
        newContext(),
      );
      expect(JSON.parse(res.body)).toMatchObject({
        open: false,
        code,
        reason: DOOR_REASONS[code],
      });
      expectVisitorOnly(res);
    },
  );

  it("a submission refused at the browser check says only visitor words", async () => {
    const request = {
      method: "POST",
      headers: headersOf({ origin: "https://hybridcloudworks.com" }),
      text: async () =>
        JSON.stringify({
          type: "terraform-validate",
          payload: "terraform {}\n",
          turnstileToken: "token",
        }),
    };
    const res = await labHandlers({ env: OPEN, store: labStore() }).submitJob(
      request,
      newContext(),
    );
    expect(res.status).toBe(403);
    expectVisitorOnly(res);
  });
});

describe("what the lab job read answers: a report, never the job log", () => {
  const log = (name) =>
    readFileSync(new URL(`./labs/fixtures/${name}`, import.meta.url), "utf8");
  const JOB_ID = "3f2b8c1e-9d4a-4c5b-8e7f-0a1b2c3d4e5f";
  const jobRequest = {
    method: "GET",
    headers: headersOf({}),
    query: new URLSearchParams({ jobId: JOB_ID }),
  };

  /** A finished public job as the agent leaves it, with the raw log on the document. */
  const finishedJob = (status, exitCode, output) => ({
    id: JOB_ID,
    type: "terraform-validate",
    public: true,
    status,
    exitCode,
    output,
    agentId: "vps-hostinger-01",
    createdAt: "2026-09-28T11:58:00.000Z",
    claimedAt: "2026-09-28T11:58:05.000Z",
    finishedAt: "2026-09-28T11:59:00.000Z",
    _ts: Math.floor(NOW / 1000) - 60,
  });

  it("the fixtures carry every token the scan is for, bar the host, so a clean answer means something", () => {
    const raw = [
      "validate-valid.log",
      "validate-invalid.log",
      "validate-not-run.log",
    ]
      .map(log)
      .join("\n");
    for (const pattern of LAB_TOKENS.filter(
      (p) => !/hostinger/.test(p.source),
    )) {
      expect(raw, String(pattern)).toMatch(pattern);
    }
  });

  it.each([
    ["the run that passed", "succeeded", 0, "validate-valid.log", "valid"],
    [
      "the run with Terraform errors injected",
      "failed",
      1,
      "validate-invalid.log",
      "invalid",
    ],
    [
      "a job that failed before Terraform ran",
      "failed",
      125,
      "validate-not-run.log",
      "error",
    ],
    [
      "a run that ran out of time",
      "timeout",
      -1,
      "validate-valid.log",
      "error",
    ],
  ])(
    "%s: the verdict and visitor words only",
    async (_label, status, exitCode, file, verdict) => {
      const store = {
        ...labStore(),
        readDoc: vi.fn(async () => finishedJob(status, exitCode, log(file))),
      };
      const res = await labHandlers({ env: OPEN, store }).getJob(
        jobRequest,
        newContext(),
      );
      expect(res.status).toBe(200);
      const { job } = JSON.parse(res.body);
      expect(job).not.toHaveProperty("output");
      expect(job.report.verdict).toBe(verdict);
      expect(labTokensIn(res.body)).toEqual([]);
      expectVisitorOnly(res);
    },
  );

  it("keeps the teaching value: Terraform’s errors with the learner’s file and line", async () => {
    const store = {
      ...labStore(),
      readDoc: vi.fn(async () =>
        finishedJob("failed", 1, log("validate-invalid.log")),
      ),
    };
    const res = await labHandlers({ env: OPEN, store }).getJob(
      jobRequest,
      newContext(),
    );
    const { report } = JSON.parse(res.body).job;
    expect(report.errors[0]).toContain('on alz.tf line 14, in module "alz":');
    expect(report.modules).toContain("avm-ptn-alz@0.21.0");
    expect(report.providers).toContain("hashicorp/azurerm v4.81.0");
  });
});

describe("what the explain route answers", () => {
  const pricingBody = {
    region: "us-east-1",
    scenarioId: "three-tier",
    scenarioLabel: "Three-tier web app",
    extras: [],
    egressGb: 100,
    results: [
      { provider: "aws", total: 10, base: 10, segments: [], unavailable: [] },
    ],
  };
  const explainRequest = {
    method: "POST",
    text: async () => JSON.stringify(pricingBody),
  };
  const identity = {
    anonymousKey: () => ({ key: "client-hash", trusted: true }),
  };
  const refusingAi = {
    resolveProvider: vi.fn(async () => {
      throw Object.assign(new Error("no key for gemini"), {
        code: "AI_NOT_CONFIGURED",
      });
    }),
    generateTextResponse: vi.fn(),
  };

  it("keeps the provider out of the unavailable answer, and the log keeps it", async () => {
    const store = { readDoc: vi.fn(async () => null) };
    const context = newContext();
    const res = await createExplainHandlers({
      identity,
      store,
      ai: refusingAi,
      now: () => NOW,
    }).explain(explainRequest, context);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe(EXPLAIN_CODES.unavailable);
    expectVisitorOnly(res);
    expect(context.warn).toHaveBeenCalledWith(
      expect.stringContaining("gemini"),
    );
  });
});
