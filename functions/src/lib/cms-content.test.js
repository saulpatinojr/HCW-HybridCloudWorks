import { describe, it, expect, vi } from "vitest";
import {
  createCmsContentHandlers,
  ADMIN_CONTENT_SNAPSHOT_FIELDS,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LIST_SEARCH_MAX_CHARS,
  LIST_SEARCH_MIN_CHARS,
  LIST_SORT_FIELDS,
  VERSIONS_LIST_LIMIT,
} from "./cms-content.js";

const context = { log: vi.fn(), error: vi.fn() };

const allowGuard = {
  requireRole: vi.fn(async () => ({
    user: { oid: "u1" },
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

const makeRequest = ({
  method = "GET",
  query = {},
  params = {},
  body,
} = {}) => ({
  method,
  query: { get: (k) => query[k] ?? null },
  params,
  json: async () => {
    if (body === undefined) throw new SyntaxError("no body");
    return body;
  },
});

function makeStore(over = {}) {
  return {
    queryDocs: vi.fn(async () => [{ id: "a" }, { id: "b" }]),
    readDoc: vi.fn(async () => ({ id: "a", Title: "T" })),
    upsertDoc: vi.fn(async (_c, d) => d),
    deleteDoc: vi.fn(async () => {}),
    ...over,
  };
}

describe("cms content list", () => {
  it("passes guard denials through untouched on every handler", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: denyGuard, store });
    for (const call of [
      h.list(makeRequest(), context),
      h.get(makeRequest({ query: { contentId: "a" } }), context),
      h.remove(makeRequest({ method: "DELETE", params: { id: "a" } }), context),
    ]) {
      expect((await call).status).toBe(403);
    }
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.deleteDoc).not.toHaveBeenCalled();
  });

  it("projects the admin snapshot fields, never SELECT *", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });
    await h.list(makeRequest(), context);
    const [container, query] = store.queryDocs.mock.calls[0];
    expect(container).toBe("content");
    expect(query).not.toContain("SELECT *");
    expect(query).toContain("c.id");
    // spot-check the awkward real field names survive quoting
    for (const f of [
      "CD Url",
      "Cover Image",
      "Published At",
      "contentStatus",
    ]) {
      expect(query).toContain(`c["${f}"]`);
    }
  });

  it("defaults the limit and clamps it at the source maximum", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });

    await h.list(makeRequest(), context);
    expect(store.queryDocs.mock.calls[0][2]).toContainEqual({
      name: "@limit",
      value: LIST_DEFAULT_LIMIT,
    });

    await h.list(makeRequest({ query: { limit: "5000" } }), context);
    expect(store.queryDocs.mock.calls[1][2]).toContainEqual({
      name: "@limit",
      value: LIST_MAX_LIMIT,
    });

    // `?limit=abc` produced `TOP NaN`, a 500 carrying raw Cosmos error text;
    // `?limit=0` and negatives produced `TOP 0`, a silently empty list
    // (T-310).
    for (const bad of ["abc", "0", "-5", "", "NaN"]) {
      store.queryDocs.mockClear();
      await h.list(makeRequest({ query: { limit: bad } }), context);
      const limit = store.queryDocs.mock.calls[0][2].find(
        (p) => p.name === "@limit",
      ).value;
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThanOrEqual(1);
      expect(limit).toBeLessThanOrEqual(LIST_MAX_LIMIT);
    }
  });

  it("filters by contentStatus only when asked, via parameter not interpolation", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });

    await h.list(makeRequest(), context);
    expect(store.queryDocs.mock.calls[0][1]).not.toContain("WHERE");

    await h.list(makeRequest({ query: { status: "x' OR 1=1" } }), context);
    const [, query, params] = store.queryDocs.mock.calls[1];
    expect(query).toContain("c.contentStatus = @status");
    expect(query).not.toContain("OR 1=1");
    expect(params).toContainEqual({ name: "@status", value: "x' OR 1=1" });
  });

  it("supports multi-status and live filters for the workflow pages", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });

    await h.list(
      makeRequest({ query: { status: "editing,approved_blog" } }),
      context,
    );
    const [, multiQuery, multiParams] = store.queryDocs.mock.calls[0];
    expect(multiQuery).toContain("ARRAY_CONTAINS(@statuses, c.contentStatus)");
    expect(multiParams).toContainEqual({
      name: "@statuses",
      value: ["editing", "approved_blog"],
    });

    await h.list(makeRequest({ query: { live: "true" } }), context);
    expect(store.queryDocs.mock.calls[1][1]).toContain("c.Live = true");

    // Workflow-page fields ride in the projection.
    for (const f of ["scheduledPublishDate", "softDeletedAt", "blogEditedAt"]) {
      expect(store.queryDocs.mock.calls[0][1]).toContain(`c["${f}"]`);
    }
  });
});

describe("cms content list taxonomy filters and ordering (ADR 0033)", () => {
  it("projects kind and ideaOrigin so every list can show the chips", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });
    await h.list(makeRequest(), context);
    expect(store.queryDocs.mock.calls[0][1]).toContain('c["kind"]');
    expect(store.queryDocs.mock.calls[0][1]).toContain('c["ideaOrigin"]');
  });

  it("?kind= matches the stored kind OR the kind an unclassified record derives from its type", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });
    await h.list(makeRequest({ query: { kind: "Reference-Guide" } }), context);
    const [, query, params] = store.queryDocs.mock.calls[0];
    expect(query).toContain("c.kind = @kind");
    expect(query).toContain("ARRAY_CONTAINS(@kindTypes, LOWER(c.type))");
    expect(params).toContainEqual({ name: "@kind", value: "reference-guide" });
    expect(params).toContainEqual({
      name: "@kindTypes",
      value: ["framework", "architecture"],
    });

    // A kind nothing derives to filters on the stored field alone.
    store.queryDocs.mockClear();
    await h.list(makeRequest({ query: { kind: "newsletter" } }), context);
    expect(store.queryDocs.mock.calls[0][1]).toMatch(/WHERE c\.kind = @kind$/);
  });

  it("?ideaOrigin= matches the stored origin OR the one an unclassified record derives from its source", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });
    await h.list(
      makeRequest({ query: { ideaOrigin: "imported-source" } }),
      context,
    );
    const [, query, params] = store.queryDocs.mock.calls[0];
    expect(query).toContain("c.ideaOrigin = @ideaOrigin");
    expect(query).toContain("ARRAY_CONTAINS(@originSources, c.source)");
    expect(query).not.toContain("@knownSources");
    expect(params).toContainEqual({
      name: "@originSources",
      value: ["firecrawl", "manual_url", "forge-url"],
    });

    // `manual` is also what an unknown or absent source derives to.
    store.queryDocs.mockClear();
    await h.list(makeRequest({ query: { ideaOrigin: "manual" } }), context);
    const [, manualQuery, manualParams] = store.queryDocs.mock.calls[0];
    expect(manualQuery).toContain(
      "NOT ARRAY_CONTAINS(@knownSources, c.source)",
    );
    expect(manualParams).toContainEqual({
      name: "@originSources",
      value: ["drafts", "repo"],
    });
  });

  it("orders only when asked, by one of the named timestamps, newest first", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });

    await h.list(makeRequest({ query: { live: "true" } }), context);
    expect(store.queryDocs.mock.calls[0][1]).not.toContain("ORDER BY");

    await h.list(
      makeRequest({ query: { live: "true", sort: "publishedAt" } }),
      context,
    );
    expect(store.queryDocs.mock.calls[1][1]).toMatch(
      /WHERE c\.Live = true ORDER BY c\["publishedAt"\] DESC$/,
    );

    const bad = await h.list(
      makeRequest({ query: { sort: "c.id; DROP" } }),
      context,
    );
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toContain(LIST_SORT_FIELDS.join(", "));
    expect(store.queryDocs).toHaveBeenCalledTimes(2);
  });

  it("?search= filters on title and summary under both casings, case-insensitively from the index (AP-F6, #930)", async () => {
    // A record whose summary lives only in `Summary` (the second casing the
    // module header names) was unreachable by search: the clause read
    // `summary` alone. The clause now names both, and this row is the one
    // the old clause could not have matched.
    const rows = [
      {
        id: "s",
        Title: "Arc on the edge",
        Summary: "Kubernetes at a branch office",
      },
    ];
    const store = makeStore({ queryDocs: vi.fn(async () => rows) });
    const h = createCmsContentHandlers({ guard: allowGuard, store });

    const res = await h.list(
      makeRequest({ query: { search: " Kubernetes " } }),
      context,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).items).toEqual(rows);
    const [, query, params] = store.queryDocs.mock.calls[0];
    expect(query).toContain(
      '(CONTAINS(c.title, @search, true) OR CONTAINS(c["Title"], @search, true) OR CONTAINS(c.summary, @search, true) OR CONTAINS(c["Summary"], @search, true))',
    );
    // LOWER(field) is not index-served: with it every search loaded the
    // whole container. CONTAINS's case-insensitive argument replaces it, so
    // the parameter is the trimmed term as typed, not lowercased.
    expect(query).not.toMatch(/LOWER\(c\.(title|summary)\)/);
    expect(query).not.toMatch(/LOWER\(c\["(Title|Summary)"\]\)/);
    expect(params).toContainEqual({ name: "@search", value: "Kubernetes" });

    // `q` is the same parameter, and the clause ANDs with the filters.
    store.queryDocs.mockClear();
    await h.list(makeRequest({ query: { q: "arc", live: "true" } }), context);
    const [, liveQuery, liveParams] = store.queryDocs.mock.calls[0];
    expect(liveQuery).toMatch(
      /WHERE c\.Live = true AND \(CONTAINS\(c\.title, @search, true\) OR /,
    );
    expect(liveParams).toContainEqual({ name: "@search", value: "arc" });
  });

  it("400s a search term outside LIST_SEARCH_MIN_CHARS..LIST_SEARCH_MAX_CHARS, as sort does (AP-F6, #930)", async () => {
    // The values a page mirrors before it sends the term; moving one here
    // means moving it there.
    expect([LIST_SEARCH_MIN_CHARS, LIST_SEARCH_MAX_CHARS]).toEqual([2, 100]);
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });

    for (const search of [
      "k",
      " k ",
      "x".repeat(LIST_SEARCH_MAX_CHARS + 1),
    ]) {
      const res = await h.list(makeRequest({ query: { search } }), context);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        error: `search must be ${LIST_SEARCH_MIN_CHARS} to ${LIST_SEARCH_MAX_CHARS} characters`,
      });
    }
    expect(
      (await h.list(makeRequest({ query: { q: "k" } }), context)).status,
    ).toBe(400);
    expect(store.queryDocs).not.toHaveBeenCalled();

    // Both edges are inside the bounds, and a blank term is no search at
    // all rather than a short one.
    for (const query of [
      { search: "x".repeat(LIST_SEARCH_MIN_CHARS) },
      { q: "x".repeat(LIST_SEARCH_MAX_CHARS) },
    ]) {
      expect((await h.list(makeRequest({ query }), context)).status).toBe(200);
      expect(store.queryDocs.mock.calls.at(-1)[1]).toContain("@search");
    }
    expect(
      (await h.list(makeRequest({ query: { search: "   " } }), context))
        .status,
    ).toBe(200);
    expect(store.queryDocs.mock.calls.at(-1)[1]).not.toContain("@search");
  });
});

describe("content versions (ADR 0033 §1: written on every save, read by nothing until now)", () => {
  it("lists the versions of one record newest first, without the body, editor-guarded", async () => {
    const rows = [
      {
        id: "v2",
        contentId: "c1",
        versionCreatedAt: "2026-10-02",
        draftChars: 12,
      },
    ];
    const store = makeStore({ queryDocs: vi.fn(async () => rows) });
    const h = createCmsContentHandlers({ guard: allowGuard, store });
    const res = await h.listVersions(
      makeRequest({ params: { id: "c1" } }),
      context,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      contentId: "c1",
      versions: rows,
      limit: VERSIONS_LIST_LIMIT,
    });
    const [container, query, params] = store.queryDocs.mock.calls[0];
    expect(container).toBe("content_versions");
    expect(query).not.toContain("c.draft,");
    expect(query).toContain("LENGTH(c.draft) AS draftChars");
    expect(query).toContain(
      "WHERE c.contentId = @contentId ORDER BY c.versionCreatedAt DESC",
    );
    expect(params).toEqual([{ name: "@contentId", value: "c1" }]);

    expect((await h.listVersions(makeRequest(), context)).status).toBe(400);
    const denied = createCmsContentHandlers({ guard: denyGuard, store });
    expect(
      (
        await denied.listVersions(
          makeRequest({ params: { id: "c1" } }),
          context,
        )
      ).status,
    ).toBe(403);
  });

  it("reads one version under its content partition and 404s a version of another record", async () => {
    const store = makeStore({
      readDoc: vi.fn(async (_c, id) =>
        id === "v1" ? { id: "v1", contentId: "c1", draft: "Body" } : null,
      ),
    });
    const h = createCmsContentHandlers({ guard: allowGuard, store });
    const res = await h.getVersion(
      makeRequest({ params: { id: "c1", versionId: "v1" } }),
      context,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).version.draft).toBe("Body");
    expect(store.readDoc).toHaveBeenCalledWith("content_versions", "v1", "c1");

    expect(
      (
        await h.getVersion(
          makeRequest({ params: { id: "other", versionId: "v1" } }),
          context,
        )
      ).status,
    ).toBe(404);
    expect(
      (await h.getVersion(makeRequest({ params: { id: "c1" } }), context))
        .status,
    ).toBe(400);
  });
});

describe("cms content get", () => {
  it("reads contentId from GET query and from POST body, like the source", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });

    await h.get(makeRequest({ query: { contentId: "q1" } }), context);
    expect(store.readDoc).toHaveBeenCalledWith("content", "q1", "q1");

    await h.get(
      makeRequest({ method: "POST", body: { contentId: "b1" } }),
      context,
    );
    expect(store.readDoc).toHaveBeenCalledWith("content", "b1", "b1");
  });

  it("400s without contentId and 404s when absent", async () => {
    const h = createCmsContentHandlers({
      guard: allowGuard,
      store: makeStore({ readDoc: async () => null }),
    });
    expect((await h.get(makeRequest(), context)).status).toBe(400);
    const res = await h.get(
      makeRequest({ query: { contentId: "missing" } }),
      context,
    );
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain("missing");
  });
});

describe("cms content remove", () => {
  it("deletes through the store and 400s without an id", async () => {
    const store = makeStore();
    const h = createCmsContentHandlers({ guard: allowGuard, store });

    const removed = await h.remove(
      makeRequest({ method: "DELETE", params: { id: "n1" } }),
      context,
    );
    expect(removed.status).toBe(200);
    expect(store.deleteDoc).toHaveBeenCalledWith("content", "n1");

    expect(
      (await h.remove(makeRequest({ method: "DELETE" }), context)).status,
    ).toBe(400);
  });
});

describe("field list provenance", () => {
  it("carries all the awkward names that different ingestion paths wrote", () => {
    for (const f of [
      "CD Url",
      "Created At",
      "Published At",
      "Cover Image",
      "Title",
      "title",
    ]) {
      expect(ADMIN_CONTENT_SNAPSHOT_FIELDS).toContain(f);
    }
  });
});
