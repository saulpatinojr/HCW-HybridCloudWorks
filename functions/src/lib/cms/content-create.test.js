/**
 * createContentItem handler — behavior pinned to the Site-Main source
 * (:3047-3140): dedup 409, quality-gate 422 with forceQualityBypass, the
 * runEditorialCritique opt-out, and the exact document shape written.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createContentCreateHandler,
  QUALITY_ENFORCED_STATUSES,
} from "./content-create.js";
import { defaultTaxonomy } from "./taxonomy.js";

const context = { log: vi.fn(), error: vi.fn() };

const allowGuard = {
  requireRole: vi.fn(async () => ({
    user: { oid: "oid-1", preferred_username: "editor@hcw.dev" },
    role: "editor",
    error: null,
  })),
};
const denyGuard = {
  requireRole: vi.fn(async () => ({
    user: null,
    role: null,
    error: { status: 403, body: '{"ok":false}' },
  })),
};

const makeRequest = (body) => ({
  method: "POST",
  json: async () => {
    if (body === undefined) throw new SyntaxError("no body");
    return body;
  },
});

function makeStore(over = {}) {
  return {
    queryDocs: vi.fn(async () => []), // dedup stages find nothing by default
    upsertDoc: vi.fn(async (_c, d) => d),
    ...over,
  };
}

const fixed = {
  now: () => new Date("2026-08-06T12:00:00.000Z"),
  uuid: () => "fixed-uuid",
};

/** A framework submission that clears its contract (mirrors the quality tests). */
const paragraph = (n) =>
  Array.from(
    { length: n },
    (_, i) => `Sentence ${i} with concrete hybrid-cloud detail.`,
  ).join(" ");
const readyFramework = {
  type: "framework",
  publishTarget: "framework",
  Title: "Migration Readiness Framework",
  summary: paragraph(6),
  overviewHtml: paragraph(30),
  frameworkConcepts: [
    { label: "Discover", summary: "Inventory the estate." },
    { label: "Assess", summary: "Score each workload." },
    { label: "Mobilize", summary: "Stand up the landing zone." },
  ],
};

describe("createContentItem auth and input", () => {
  it("passes guard denials through and never touches the store", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: denyGuard,
      store,
      ...fixed,
    });
    const res = await handler(makeRequest({ data: { Title: "X" } }), context);
    expect(res.status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it("treats a missing or malformed body as an empty draft, like the source default", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await handler(makeRequest(undefined), context);
    expect(res.status).toBe(200);
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc.type).toBe("blog");
    expect(doc.contentStatus).toBe("draft");
  });
});

describe("createContentItem normalization", () => {
  it("normalizes unknown types to blog and news-era targets to blog", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await handler(
      makeRequest({
        data: { type: "Mystery", publishTarget: "published_news", Title: "T" },
      }),
      context,
    );
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc.type).toBe("blog");
    expect(doc.publishTarget).toBe("blog");
  });

  it("keeps a supported type and lets the target fall back to it", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await handler(
      makeRequest({ data: { type: "framework", Title: "T" } }),
      context,
    );
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc.type).toBe("framework");
    expect(doc.publishTarget).toBe("framework");
  });
});

describe("createContentItem taxonomy (ADR 0033 §4)", () => {
  it("stores an enabled kind and idea origin, and nothing when neither is sent", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    await handler(
      makeRequest({
        data: { Title: "T", kind: "Tutorial", ideaOrigin: "audience-question" },
      }),
      context,
    );
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({
      kind: "tutorial",
      ideaOrigin: "audience-question",
    });

    await handler(makeRequest({ data: { Title: "U" } }), context);
    const plain = store.upsertDoc.mock.calls[1][1];
    expect(plain).not.toHaveProperty("kind");
    expect(plain).not.toHaveProperty("ideaOrigin");
  });

  it("400s an unknown id, naming the allowed ones, before any dedup read", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await handler(
      makeRequest({ data: { Title: "T", kind: "haiku" } }),
      context,
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(
      /kind "haiku" is not a known kind; allowed: article, tutorial/,
    );
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it("refuses a disabled id on a NEW record, reading the saved taxonomy", async () => {
    // The saved document keeps every built-in id (the normaliser insists);
    // one of them is switched off.
    const taxonomy = defaultTaxonomy();
    taxonomy.kinds = taxonomy.kinds.map((k) =>
      k.id === "tutorial" ? { ...k, enabled: false } : k,
    );
    const store = makeStore({ readDoc: vi.fn(async () => taxonomy) });
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await handler(
      makeRequest({ data: { Title: "T", kind: "tutorial" } }),
      context,
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(
      /kind "tutorial" is disabled; allowed: article, documentation/,
    );
    expect(store.readDoc).toHaveBeenCalledWith(
      "admin_config",
      "content_taxonomy",
      expect.anything(),
    );
  });
});

describe("createContentItem dedup", () => {
  it("409s with the stage reason and existing id, writing nothing", async () => {
    const store = makeStore({
      queryDocs: vi.fn(async (_c, query) =>
        query.includes('c["sourceUrl"]') ? [{ id: "existing-1" }] : [],
      ),
    });
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await handler(
      makeRequest({ data: { Title: "T", sourceUrl: "https://example.com/a" } }),
      context,
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      success: false,
      error: "Duplicate content detected",
      duplicateReason: "exact_url",
      existingId: "existing-1",
    });
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});

describe("createContentItem quality gate", () => {
  it("allows a thin draft — quality is only enforced on elevated statuses", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await handler(
      makeRequest({ data: { Title: "Thin", postContent: "Too short." } }),
      context,
    );
    expect(res.status).toBe(200);
  });

  it("422s an elevated status that fails the gate, echoing the report", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    for (const contentStatus of QUALITY_ENFORCED_STATUSES) {
      store.upsertDoc.mockClear();
      const res = await handler(
        makeRequest({
          data: { Title: "Thin", postContent: "Too short.", contentStatus },
        }),
        context,
      );
      expect(res.status).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Content quality gate failed");
      expect(body.contentQuality.ready).toBe(false);
      expect(store.upsertDoc).not.toHaveBeenCalled();
    }
  });

  it("honors forceQualityBypass exactly at boolean true", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const data = {
      Title: "Thin",
      postContent: "Too short.",
      contentStatus: "approved",
    };
    expect(
      (await handler(makeRequest({ data, forceQualityBypass: true }), context))
        .status,
    ).toBe(200);
    expect(
      (await handler(makeRequest({ data, forceQualityBypass: "yes" }), context))
        .status,
    ).toBe(422);
  });

  it("creates a genuinely ready submission at an elevated status without a bypass", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await handler(
      makeRequest({ data: { ...readyFramework, contentStatus: "approved" } }),
      context,
    );
    expect(res.status).toBe(200);
    expect(store.upsertDoc.mock.calls[0][1].contentQuality.ready).toBe(true);
  });
});

describe("createContentItem critique wiring", () => {
  it("runs the injected critique by default and skips it on the opt-out", async () => {
    const critiqueDraft = vi.fn(async () => null);
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store: makeStore(),
      critiqueDraft,
      ...fixed,
    });

    await handler(
      makeRequest({ data: { Title: "T", postContent: "Body." } }),
      context,
    );
    expect(critiqueDraft).toHaveBeenCalledWith({
      title: "T",
      postContent: "Body.",
    });

    critiqueDraft.mockClear();
    await handler(
      makeRequest({ data: { Title: "T" }, runEditorialCritique: false }),
      context,
    );
    expect(critiqueDraft).not.toHaveBeenCalled();
  });

  it("folds critique issues into the stored quality report", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      critiqueDraft: async () => ({
        verdict: "revise",
        issues: ["Too generic"],
      }),
      ...fixed,
    });
    await handler(
      makeRequest({ data: { Title: "T", postContent: "Body." } }),
      context,
    );
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc.contentQuality.critique.verdict).toBe("revise");
    expect(doc.contentQuality.issues.join(" ")).toContain("Too generic");
  });
});

describe("createContentItem document shape", () => {
  it("writes the source field set with a fresh id and ISO timestamps", async () => {
    const store = makeStore();
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await handler(
      makeRequest({
        data: {
          id: "client-supplied", // must never become the document key
          Title: "A Real Title",
          sourceUrl: "https://www.example.com/post?utm_source=x",
          postContent: "Body text.",
        },
      }),
      context,
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      contentId: "fixed-uuid",
    });

    const [container, doc] = store.upsertDoc.mock.calls[0];
    expect(container).toBe("content");
    expect(doc.id).toBe("fixed-uuid");
    expect(doc.storageCollection).toBe("content");
    expect(doc.normalizedUrl).toBe("https://example.com/post");
    expect(doc.normalizedTitle).toBe("a real title");
    expect(doc.createdBy).toBe("editor@hcw.dev");
    expect(doc["Created At"]).toBe("2026-08-06T12:00:00.000Z");
    expect(doc.updatedAt).toBe("2026-08-06T12:00:00.000Z");
    // The readiness report is stored under both names, as the source did.
    expect(doc.imageQuality).toBe(doc.imageReadiness);
    expect(doc.imageLineage).toBeTruthy();
    expect(doc.contentQuality.score).toBeTypeOf("number");
  });
});

describe("createContentItem originRef (#1886)", () => {
  const PROGRAM = {
    id: "program-example",
    docType: "program",
    name: "Example Program",
    requirements: [],
  };
  const readDoc = vi.fn(async (container, id) =>
    container === "ambassador" && id === PROGRAM.id ? PROGRAM : null,
  );

  it("stores the checked reference, never the caller's own label", async () => {
    const store = makeStore({ readDoc });
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await handler(
      makeRequest({
        data: { Title: "T", originRef: { page: "ambassador", id: PROGRAM.id } },
      }),
      context,
    );
    expect(res.status).toBe(200);
    expect(store.upsertDoc.mock.calls[0][1].originRef).toEqual({
      page: "ambassador",
      id: PROGRAM.id,
      part: null,
      label: "Example Program",
    });
  });

  it("refuses a reference to a record that does not exist, and writes nothing", async () => {
    const store = makeStore({ readDoc });
    const handler = createContentCreateHandler({
      guard: allowGuard,
      store,
      ...fixed,
    });
    const res = await handler(
      makeRequest({
        data: {
          Title: "T",
          originRef: { page: "ambassador", id: "program-none" },
        },
      }),
      context,
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe(
      "No Ambassador program has that id.",
    );
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});
