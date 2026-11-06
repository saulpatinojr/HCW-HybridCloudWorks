/**
 * Dashboard/queue/publish snapshot RPCs — classification helpers pinned
 * verbatim against the source (:88-110, :2000-2130), queue filter shapes and
 * the seed/recalculate flows against :6038-6170 and :6300-6470.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createAdminSnapshotHandlers,
  isBlockedContentSource,
  matchesQueueStatus,
  matchesAdminContentType,
  matchesTaxonomyFilter,
  summarizeDashboardItems,
  queueFilterFor,
  readyToPublishWhere,
  reviewWaitingSince,
  DASHBOARD_STATS_DOC_ID,
} from "./admin-snapshots.js";

const NOT_LIVE = "NOT (IS_BOOLEAN(c.Live) AND c.Live = true)";

const context = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

const allowGuard = (role = "viewer") => ({
  requireRole: vi.fn(async () => ({
    user: { oid: "u1", preferred_username: "admin@hcw.dev" },
    role,
    error: null,
  })),
});
const denyGuard = {
  requireRole: vi.fn(async () => ({
    user: null,
    role: null,
    error: { status: 403, body: "{}" },
  })),
};

const makeRequest = (body) => ({
  json: async () => {
    if (body === undefined) throw new SyntaxError("no body");
    return body;
  },
});

/** Store fake routing COUNT queries vs projected fetches. */
function makeStore({ count = 0, rows = [], doc = null } = {}) {
  return {
    queryDocs: vi.fn(async (_c, query) => {
      if (query.includes("VALUE COUNT")) return [count];
      // The two windows of a view read in its own order are disjoint in
      // Cosmos: the rows with the sort field, and the rows without it.
      const window = query.match(/(NOT )?IS_DEFINED\(c\.(\w+)\)/);
      if (!window) return rows;
      const [, without, field] = window;
      return rows.filter((row) => (row[field] !== undefined) === !without);
    }),
    readDoc: vi.fn(async () => doc),
    upsertDoc: vi.fn(async (_c, d) => d),
  };
}

const fixed = { now: () => new Date("2026-08-07T03:00:00.000Z") };

describe("classification helpers", () => {
  it("blocks the blocked host across every URL field, www-insensitively", () => {
    expect(
      isBlockedContentSource({ sourceUrl: "https://www.stackfeed.io/a" }),
    ).toBe(true);
    expect(
      isBlockedContentSource({ sourceUrls: ["https://stackfeed.io/x"] }),
    ).toBe(true);
    expect(
      isBlockedContentSource({ sourceFeed: "https://stackfeed.io/rss" }),
    ).toBe(true);
    expect(isBlockedContentSource({ sourceUrl: "https://example.com" })).toBe(
      false,
    );
    expect(isBlockedContentSource({})).toBe(false);
  });

  it("matchesQueueStatus keeps the source nuances", () => {
    expect(
      matchesQueueStatus({ contentStatus: "approved" }, "ready_to_publish"),
    ).toBe(true);
    expect(
      matchesQueueStatus(
        { contentStatus: "published", Live: true },
        "ready_to_publish",
      ),
    ).toBe(false);
    expect(
      matchesQueueStatus({ contentStatus: "editing" }, "in_progress"),
    ).toBe(true);
    expect(
      matchesQueueStatus({ contentStatus: "needs_rework" }, "in_progress"),
    ).toBe(true);
    expect(
      matchesQueueStatus({ contentStatus: "forge_ready" }, "ready_to_publish"),
    ).toBe(true);
    expect(matchesQueueStatus({ contentStatus: "draft" }, "in_progress")).toBe(
      false,
    );
    expect(matchesQueueStatus({ Live: true }, "published_live")).toBe(true);
  });

  it("matchesAdminContentType folds news into the blog filter", () => {
    expect(matchesAdminContentType({ type: "news" }, "blog")).toBe(true);
    // ADR 0040, D5: an interview is its own admin type, never folded into blog.
    expect(matchesAdminContentType({ type: "interview" }, "interview")).toBe(true);
    expect(matchesAdminContentType({ type: "interview" }, "blog")).toBe(false);
    expect(summarizeDashboardItems([{ type: "interview", contentStatus: "draft" }]).interview.total).toBe(1);
    expect(matchesAdminContentType({ type: "framework" }, "blog")).toBe(false);
    expect(
      matchesAdminContentType(
        { publishTarget: "coder_corner" },
        "coder_corner",
      ),
    ).toBe(true);
  });

  it("summarizeDashboardItems buckets exactly like the source", () => {
    const stats = summarizeDashboardItems([
      { type: "blog", contentStatus: "ingested" }, // needsReview
      { type: "blog", contentStatus: "editing" }, // inProgress
      { type: "blog", contentStatus: "published", Live: true }, // published
      { type: "framework", contentStatus: "rejected" }, // rejected, no bucket total
      { type: "blog", contentStatus: "archived" }, // total only
      {
        type: "news",
        contentStatus: "draft",
        sourceUrl: "https://stackfeed.io/x",
      }, // blocked, excluded
    ]);
    expect(stats.blog).toEqual({
      needsReview: 1,
      inProgress: 1,
      published: 1,
      total: 4,
    });
    expect(stats.rejected).toBe(1);
    expect(stats.framework.total).toBe(0);
    expect(stats.news.total).toBe(0);
  });

  it("counts in_review as a decision waiting, not as the Editor's work (#1014)", () => {
    const stats = summarizeDashboardItems([
      { type: "blog", contentStatus: "in_review" },
      { type: "blog", contentStatus: "approved" },
    ]);
    expect(stats.blog).toMatchObject({ needsReview: 1, inProgress: 1 });
    expect(matchesQueueStatus({ contentStatus: "in_review" }, "needs_review")).toBe(true);
    expect(matchesQueueStatus({ contentStatus: "in_review" }, "in_progress")).toBe(false);
  });

  it("orders review items by when each started waiting: sent to review, else arrived", () => {
    expect(
      reviewWaitingSince({
        contentStatus: "in_review",
        sentToReviewAt: "2026-08-06T00:00:00.000Z",
        "Created At": "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("2026-08-06T00:00:00.000Z");
    // A Drafts article has no fetchedAt; it falls back rather than sorting last.
    expect(
      reviewWaitingSince({ contentStatus: "draft", "Created At": "2026-02-02T00:00:00.000Z" }),
    ).toBe("2026-02-02T00:00:00.000Z");
    // sentToReviewAt only speaks for an item still in review.
    expect(
      reviewWaitingSince({
        contentStatus: "ingested",
        sentToReviewAt: "2026-08-06T00:00:00.000Z",
        fetchedAt: "2026-03-03T00:00:00.000Z",
      }),
    ).toBe("2026-03-03T00:00:00.000Z");
    expect(reviewWaitingSince({})).toBeNull();
  });

  it("queueFilterFor maps each filter to the source query shape", () => {
    expect(queueFilterFor("needs_review")).toMatchObject({
      sortField: "fetchedAt",
      params: [
        {
          name: "@statuses",
          value: ["draft", "ingested", "inspected", "in_review"],
        },
      ],
    });
    expect(queueFilterFor("published_live")).toMatchObject({
      where: "c.Live = true",
      sortField: "publishedAt",
    });
    expect(queueFilterFor("soft_deleted").params[0].value).toBe("rejected");
    expect(queueFilterFor("editing").params[0].value).toBe("editing"); // passthrough
  });

  it("queueFilterFor answers the same three-key shape for every filter", () => {
    const views = [
      "needs_review",
      "ready_to_publish",
      "published_live",
      "in_progress",
      "soft_deleted",
      "editing",
    ];
    for (const view of views) {
      const filter = queueFilterFor(view);
      expect(Object.keys(filter).sort(), view).toEqual([
        "params",
        "sortField",
        "where",
      ]);
      expect(typeof filter.where, view).toBe("string");
      expect(Array.isArray(filter.params), view).toBe(true);
    }
    expect(queueFilterFor("in_progress")).toEqual({
      where: "ARRAY_CONTAINS(@statuses, c.contentStatus)",
      params: [
        {
          name: "@statuses",
          value: ["approved", "editing", "forge_ready", "needs_rework"],
        },
      ],
      sortField: "updatedAt",
    });
    expect(queueFilterFor("soft_deleted")).toEqual({
      where: "c.contentStatus = @status",
      params: [{ name: "@status", value: "rejected" }],
      sortField: "fetchedAt",
    });
    // A table lookup, not a property read: a prototype name is a passthrough status.
    expect(queueFilterFor("constructor").params[0].value).toBe("constructor");
    // Each call hands out its own status list, so a caller cannot mutate the table.
    const first = queueFilterFor("needs_review").params[0].value;
    first.push("tampered");
    expect(queueFilterFor("needs_review").params[0].value).toEqual([
      "draft",
      "ingested",
      "inspected",
      "in_review",
    ]);
  });
});

describe("getQueueSnapshot", () => {
  it("denies without touching the store", async () => {
    const store = makeStore();
    const h = createAdminSnapshotHandlers({
      guard: denyGuard,
      store,
      ...fixed,
    });
    expect((await h.getQueueSnapshot(makeRequest({}), context)).status).toBe(
      403,
    );
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it("filters blocked sources, applies JS-side status nuance, sorts desc", async () => {
    const rows = [
      {
        id: "stale",
        contentStatus: "approved",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "fresh",
        contentStatus: "approved",
        updatedAt: "2026-06-01T00:00:00Z",
      },
      {
        id: "live-already",
        contentStatus: "published",
        Live: true,
        updatedAt: "2026-07-01T00:00:00Z",
      },
      {
        id: "blocked",
        contentStatus: "approved",
        sourceUrl: "https://stackfeed.io/x",
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ];
    const store = makeStore({ count: 10, rows });
    const h = createAdminSnapshotHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
    });
    const res = await h.getQueueSnapshot(
      makeRequest({ statusFilter: "ready_to_publish" }),
      context,
    );
    const body = JSON.parse(res.body);
    expect(body.items.map((i) => i.id)).toEqual(["fresh", "stale"]); // Live filtered, blocked dropped, desc
    expect(body.totalCount).toBe(9); // count minus blocked-in-page
  });

  it("uses projected, parameterized queries — never SELECT *", async () => {
    const store = makeStore();
    const h = createAdminSnapshotHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
    });
    await h.getQueueSnapshot(
      makeRequest({ statusFilter: "needs_review", itemLimit: 50 }),
      context,
    );
    const fetchCall = store.queryDocs.mock.calls.find(
      ([, q]) => !q.includes("VALUE COUNT"),
    );
    expect(fetchCall[1]).toContain('c["contentStatus"]');
    expect(fetchCall[1]).not.toContain("SELECT *");
    expect(fetchCall[1]).toContain(
      "ARRAY_CONTAINS(@statuses, c.contentStatus)",
    );
    // The window is the newest written, not an arbitrary TOP n (#1013).
    expect(fetchCall[1]).toMatch(/ ORDER BY c\._ts DESC$/);
  });

  it("reads every other view in its own sort field's order, with the rows that lack it after (review of #1021)", async () => {
    const rows = [
      // Rewritten lately for another reason: newest written, but published long ago.
      { id: "rewritten", Live: true, publishedAt: "2026-01-01T00:00:00Z", _ts: 1_790_000_000 },
      { id: "just-published", Live: true, publishedAt: "2026-08-06T00:00:00Z", _ts: 1_780_000_000 },
      { id: "no-date", Live: true, _ts: 1_785_000_000 },
    ];
    const store = makeStore({ count: 3, rows });
    const h = createAdminSnapshotHandlers({ guard: allowGuard(), store, ...fixed });
    const body = JSON.parse(
      (await h.getQueueSnapshot(makeRequest({ statusFilter: "published_live", itemLimit: 10 }), context)).body,
    );
    expect(body.items.map((i) => i.id)).toEqual(["just-published", "rewritten", "no-date"]);
    const windows = store.queryDocs.mock.calls.map(([, q]) => q).filter((q) => !q.includes("VALUE COUNT"));
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatch(/AND IS_DEFINED\(c\.publishedAt\) ORDER BY c\.publishedAt DESC$/);
    expect(windows[1]).toMatch(/AND NOT IS_DEFINED\(c\.publishedAt\) ORDER BY c\._ts DESC$/);
    for (const window of windows) expect(window).toMatch(/^SELECT TOP 10 /);
  });

  it("puts an article sent from Drafts where its wait says, not at the bottom", async () => {
    const rows = [
      {
        id: "feed-old",
        contentStatus: "ingested",
        fetchedAt: "2026-08-01T00:00:00Z",
      },
      {
        id: "sent-from-drafts",
        contentStatus: "in_review",
        "Created At": "2026-07-01T00:00:00Z",
        sentToReviewAt: "2026-08-06T00:00:00Z",
      },
      {
        id: "feed-new",
        contentStatus: "inspected",
        fetchedAt: "2026-08-05T00:00:00Z",
      },
    ];
    const h = createAdminSnapshotHandlers({
      guard: allowGuard(),
      store: makeStore({ count: 3, rows }),
      ...fixed,
    });
    const body = JSON.parse(
      (await h.getQueueSnapshot(makeRequest({}), context)).body,
    );
    expect(body.items.map((i) => i.id)).toEqual([
      "sent-from-drafts",
      "feed-new",
      "feed-old",
    ]);
  });

  it("filters by kind and idea origin on the resolved value, with a wider fetch window (ADR 0033 §4)", async () => {
    const rows = [
      {
        id: "stored",
        contentStatus: "inspected",
        kind: "tutorial",
        ideaOrigin: "content-gap",
      },
      {
        id: "derived",
        contentStatus: "inspected",
        type: "coder_corner",
        source: "rss",
      },
      {
        id: "other",
        contentStatus: "inspected",
        type: "blog",
        source: "manual_url",
      },
    ];
    const store = makeStore({ count: 3, rows });
    const h = createAdminSnapshotHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
    });
    const res = await h.getQueueSnapshot(
      makeRequest({
        statusFilter: "inspected",
        kindFilter: "tutorial",
        itemLimit: 10,
      }),
      context,
    );
    expect(JSON.parse(res.body).items.map((i) => i.id)).toEqual([
      "stored",
      "derived",
    ]);
    const fetchCall = store.queryDocs.mock.calls.find(
      ([, q]) => !q.includes("VALUE COUNT"),
    );
    expect(fetchCall[1]).toContain("SELECT TOP 30 ");

    const byOrigin = await h.getQueueSnapshot(
      makeRequest({ statusFilter: "inspected", ideaOriginFilter: "rss-feed" }),
      context,
    );
    expect(JSON.parse(byOrigin.body).items.map((i) => i.id)).toEqual([
      "derived",
    ]);

    expect(
      matchesTaxonomyFilter({ type: "blog" }, { kindFilter: "article" }),
    ).toBe(true);
    expect(
      matchesTaxonomyFilter(
        { type: "blog" },
        { kindFilter: "all", ideaOriginFilter: "all" },
      ),
    ).toBe(true);
    expect(
      matchesTaxonomyFilter(
        { source: "drafts" },
        { ideaOriginFilter: "rss-feed" },
      ),
    ).toBe(false);
  });
});

describe("getPublishSnapshot", () => {
  it("returns both buckets with totals and Live filtered out of ready", async () => {
    const store = {
      queryDocs: vi.fn(async (_c, query, params) => {
        if (query.includes("VALUE COUNT")) return [7];
        if (params.length > 0) {
          // ready bucket fetch
          return [
            {
              id: "r1",
              contentStatus: "approved",
              updatedAt: "2026-05-01T00:00:00Z",
            },
            {
              id: "r-live",
              contentStatus: "published",
              Live: true,
              updatedAt: "2026-06-01T00:00:00Z",
            },
          ];
        }
        return [{ id: "p1", publishedAt: "2026-04-01T00:00:00Z" }];
      }),
      readDoc: vi.fn(),
      upsertDoc: vi.fn(),
    };
    const h = createAdminSnapshotHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
    });
    const body = JSON.parse(
      (await h.getPublishSnapshot(makeRequest({}), context)).body,
    );
    expect(body.readyTotal).toBe(7);
    expect(body.readyCandidates.map((i) => i.id)).toEqual(["r1"]);
    expect(body.publishedItems.map((i) => i.id)).toEqual(["p1"]);
  });

  it("counts and fetches the ready bucket without live pages, so readyTotal matches the list", async () => {
    // Fails if the ready COUNT goes back to the bare ready_to_publish window:
    // that window includes the `published` status, so it counted every live
    // page as staged while readyCandidates dropped them.
    const store = makeStore({ count: 3, rows: [] });
    const h = createAdminSnapshotHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
    });
    await h.getPublishSnapshot(makeRequest({}), context);
    const readyQueries = store.queryDocs.mock.calls
      .map(([, query]) => query)
      .filter((query) => query.includes("ARRAY_CONTAINS(@statuses"));
    expect(readyQueries).toHaveLength(2); // the COUNT and the fetch
    for (const query of readyQueries) expect(query).toContain(NOT_LIVE);
  });
});

describe("readyToPublishWhere", () => {
  it("is the ready_to_publish window narrowed to not-live, with the same parameters", () => {
    const ready = queueFilterFor("ready_to_publish");
    const narrowed = readyToPublishWhere();
    expect(narrowed.where).toBe(`${ready.where} AND ${NOT_LIVE}`);
    expect(narrowed.params).toEqual(ready.params);
    expect(narrowed.params[0].value).toEqual([
      "approved",
      "forge_ready",
      "published",
    ]);
  });
});

describe("getAdminDashboardSnapshot", () => {
  it("serves the fast path from the stats doc, projected to the UI shape", async () => {
    const store = makeStore({
      doc: {
        id: DASHBOARD_STATS_DOC_ID,
        blog: { needsReview: 3, inProgress: 2, published: 5, total: 10 },
        rejected: 4,
        totalDocs: 99,
        schemaVersion: 1,
        _ts: 123,
      },
    });
    const h = createAdminSnapshotHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
    });
    const body = JSON.parse(
      (await h.getAdminDashboardSnapshot(makeRequest({}), context)).body,
    );
    expect(body.stats.blog).toEqual({
      needsReview: 3,
      inProgress: 2,
      published: 5,
      total: 10,
    });
    expect(body.stats.rejected).toBe(4);
    expect(body.stats).not.toHaveProperty("totalDocs"); // UI shape, not doc shape
    expect(store.upsertDoc).not.toHaveBeenCalled(); // no reseed on the fast path
  });

  it("carries the Publish stage's count: ready to publish and not live", async () => {
    // The dashboard's Publish badge. The stats document has no bucket for it,
    // so it is the same COUNT as getPublishSnapshot's readyTotal.
    const store = makeStore({ count: 4, doc: { id: DASHBOARD_STATS_DOC_ID } });
    const h = createAdminSnapshotHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
    });
    const body = JSON.parse(
      (await h.getAdminDashboardSnapshot(makeRequest({}), context)).body,
    );
    expect(body.readyToPublish).toBe(4);
    const countCall = store.queryDocs.mock.calls.find(([, query]) =>
      query.includes("VALUE COUNT"),
    );
    expect(countCall[1]).toContain(readyToPublishWhere().where);
    expect(countCall[2]).toEqual(readyToPublishWhere().params);
  });

  it("falls back to a live scan and seeds the doc when unseeded", async () => {
    const store = makeStore({
      doc: null,
      rows: [
        {
          id: "a",
          contentStatus: "ingested",
          type: "blog",
          fetchedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const h = createAdminSnapshotHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
    });
    const body = JSON.parse(
      (await h.getAdminDashboardSnapshot(makeRequest({}), context)).body,
    );
    expect(body.stats.blog.needsReview).toBe(1);
    const seeded = store.upsertDoc.mock.calls[0][1];
    expect(seeded.id).toBe(DASHBOARD_STATS_DOC_ID);
    expect(seeded.blog.needsReview).toBe(1);
    expect(body.recentNeedsReview.map((i) => i.id)).toEqual(["a"]);
  });

  it("reads the newest review items from an ordered window, in_review included (#1013)", async () => {
    const store = makeStore({
      doc: { id: DASHBOARD_STATS_DOC_ID },
      rows: [
        { id: "old", contentStatus: "ingested", fetchedAt: "2026-01-01T00:00:00Z" },
        {
          id: "sent",
          contentStatus: "in_review",
          sentToReviewAt: "2026-08-01T00:00:00Z",
        },
      ],
    });
    const h = createAdminSnapshotHandlers({
      guard: allowGuard(),
      store,
      ...fixed,
    });
    const body = JSON.parse(
      (await h.getAdminDashboardSnapshot(makeRequest({}), context)).body,
    );
    expect(body.recentNeedsReview.map((i) => i.id)).toEqual(["sent", "old"]);
    const [, query, params] = store.queryDocs.mock.calls[0];
    expect(query).toMatch(/^SELECT TOP 30 .* ORDER BY c\._ts DESC$/);
    expect(params[0].value).toContain("in_review");
  });
});

describe("recalculateDashboardStats", () => {
  /** The scan answers `content`; the marker read answers its own container. */
  function recountStore({ rows, markers = [] }) {
    return {
      queryDocs: vi.fn(async (container) =>
        container === "content_stats_markers" ? markers : rows,
      ),
      readDoc: vi.fn(async () => null),
      upsertDoc: vi.fn(async (_c, d) => d),
      createDoc: vi.fn(async (_c, d) => d),
      replaceDocIfMatch: vi.fn(async (_c, d) => d),
    };
  }

  it("requires editor, scans, and fully overwrites the stats doc", async () => {
    const store = recountStore({
      rows: [
        { id: "a", contentStatus: "published", Live: true, type: "framework" },
        { id: "b", contentStatus: "rejected", type: "blog" },
      ],
      markers: [
        { id: "a", bucket: "published", type: "framework", _etag: "1" },
        { id: "b", bucket: "rejected", type: "blog", _etag: "2" },
      ],
    });
    const h = createAdminSnapshotHandlers({
      guard: allowGuard("editor"),
      store,
      ...fixed,
    });
    const res = await h.recalculateDashboardStats(makeRequest({}), context);
    const body = JSON.parse(res.body);
    expect(body.totalDocs).toBe(2);
    expect(body.stats.framework.published).toBe(1);
    expect(body.stats.rejected).toBe(1);
    expect(body.markers).toEqual({
      checked: 2,
      created: 0,
      rewritten: 0,
      skipped: 0,
    });

    // No counters document yet: created, so one made meanwhile is a conflict, not overwritten.
    const doc = store.createDoc.mock.calls.find(([c]) => c === "system")[1];
    expect(doc).toMatchObject({
      id: DASHBOARD_STATS_DOC_ID,
      totalDocs: 2,
      recalculatedAt: "2026-08-07T03:00:00.000Z",
      recalculatedBy: "admin@hcw.dev",
    });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(body.attempts).toBe(1);
  });

  describe("a run the change feed overtakes starts again (review of #1021)", () => {
    const stale = () => Object.assign(new Error("changed since read"), { code: 412 });
    const counters = { id: DASHBOARD_STATS_DOC_ID, _etag: "v1", rejected: 0 };
    const rows = [{ id: "a", contentStatus: "ingested", type: "blog" }];
    const markers = [{ id: "a", bucket: "needsReview", type: "blog", _etag: "m1" }];
    const handlersOver = (store) =>
      createAdminSnapshotHandlers({ guard: allowGuard("editor"), store, ...fixed });

    it("writes the counters only under the ETag they had before the scan", async () => {
      const store = recountStore({ rows, markers });
      store.readDoc.mockResolvedValue(counters);
      const res = await handlersOver(store).recalculateDashboardStats(makeRequest({}), context);
      expect(res.status).toBe(200);
      expect(store.replaceDocIfMatch).toHaveBeenCalledWith(
        "system",
        expect.objectContaining({ id: DASHBOARD_STATS_DOC_ID, _etag: "v1", totalDocs: 1 }),
      );
    });

    it("scans again when the feed wrote the counters during the run", async () => {
      const store = recountStore({ rows, markers });
      store.readDoc.mockResolvedValue(counters);
      store.replaceDocIfMatch.mockRejectedValueOnce(stale());
      const res = await handlersOver(store).recalculateDashboardStats(makeRequest({}), context);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).attempts).toBe(2);
      const scans = store.queryDocs.mock.calls.filter(([c]) => c === "content");
      expect(scans).toHaveLength(2);
    });

    it("scans again when the feed moved a marker after the scan read it, and writes nothing from that run", async () => {
      const moved = [{ id: "a", bucket: "inProgress", type: "blog", _etag: "m1" }];
      const store = recountStore({ rows, markers: moved });
      store.readDoc.mockResolvedValue(counters);
      // The marker rewrite loses to the feed once; the counters write is never reached on that run.
      store.replaceDocIfMatch.mockRejectedValueOnce(stale());
      const res = await handlersOver(store).recalculateDashboardStats(makeRequest({}), context);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).attempts).toBe(2);
      const systemWrites = store.replaceDocIfMatch.mock.calls.filter(([c]) => c === "system");
      expect(systemWrites).toHaveLength(1);
    });

    it("gives up after three overtaken runs, says so, and leaves the counters as they were", async () => {
      const store = recountStore({ rows, markers });
      store.readDoc.mockResolvedValue(counters);
      store.replaceDocIfMatch.mockImplementation(async (container, doc) => {
        if (container === "system") throw stale();
        return doc;
      });
      const res = await handlersOver(store).recalculateDashboardStats(makeRequest({}), context);
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).message).toMatch(/Press Recount again/);
      expect(store.queryDocs.mock.calls.filter(([c]) => c === "content")).toHaveLength(3);
    });
  });

  it("re-derives the markers too, so in_review moves out of inProgress for good (#1014)", async () => {
    const store = recountStore({
      rows: [{ id: "sent", contentStatus: "in_review", type: "blog" }],
      markers: [{ id: "sent", bucket: "inProgress", type: "blog", _etag: "1" }],
    });
    const h = createAdminSnapshotHandlers({
      guard: allowGuard("editor"),
      store,
      ...fixed,
    });
    const body = JSON.parse(
      (await h.recalculateDashboardStats(makeRequest({}), context)).body,
    );
    expect(body.stats.blog).toMatchObject({ needsReview: 1, inProgress: 0 });
    expect(body.markers.rewritten).toBe(1);
    expect(store.replaceDocIfMatch).toHaveBeenCalledWith(
      "content_stats_markers",
      expect.objectContaining({ id: "sent", bucket: "needsReview", _etag: "1" }),
    );
  });

  it("leaves the counters as they were when a marker write fails, so Recount can be pressed again", async () => {
    const store = recountStore({
      rows: [{ id: "x", contentStatus: "ingested", type: "blog" }],
    });
    store.createDoc.mockRejectedValueOnce(
      Object.assign(new Error("throttled"), { code: 429 }),
    );
    const h = createAdminSnapshotHandlers({
      guard: allowGuard("editor"),
      store,
      ...fixed,
    });
    const res = await h.recalculateDashboardStats(makeRequest({}), context);
    expect(res.status).toBe(500);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.createDoc.mock.calls.some(([c]) => c === "system")).toBe(false);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it("denies non-editors without scanning", async () => {
    const store = makeStore();
    const h = createAdminSnapshotHandlers({
      guard: denyGuard,
      store,
      ...fixed,
    });
    expect(
      (await h.recalculateDashboardStats(makeRequest({}), context)).status,
    ).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });
});
