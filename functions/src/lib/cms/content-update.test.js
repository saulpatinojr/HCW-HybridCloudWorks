/**
 * updateContentItem / transitionContentStatus handlers — behavior pinned to
 * Site-Main cms-functions.js :3564 and :6813, adapted per the module header
 * (patchDoc partial writes, sequential version/audit writes, publisher gate
 * from the guard's resolved role).
 */
import { describe, it, expect, vi } from "vitest";
import {
  createContentUpdateHandler,
  createContentStatusTransitioner,
  createContentTransitionHandler,
} from "./content-update.js";
import { isPublicDocument } from "../public-reads.js";
import { defaultTaxonomy } from "./taxonomy.js";

const context = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

const guardAs = (role) => ({
  requireRole: vi.fn(async () => ({
    user: { oid: "oid-1", preferred_username: "editor@hcw.dev", email: null },
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
  method: "POST",
  headers: { get: (k) => (k === "user-agent" ? "vitest" : null) },
  json: async () => {
    if (body === undefined) throw new SyntaxError("no body");
    return body;
  },
});

function makeStore(over = {}) {
  return {
    readDoc: vi.fn(async () => ({
      id: "c1",
      Title: "Existing",
      contentStatus: "inspected",
    })),
    patchDoc: vi.fn(async () => ({})),
    upsertDoc: vi.fn(async (_c, d) => d),
    queryDocs: vi.fn(async () => []),
    ...over,
  };
}

const fixed = {
  now: () => new Date("2026-08-06T12:00:00.000Z"),
  uuid: () => "fixed-uuid",
};

describe("updateContentItem", () => {
  it("passes guard denials through untouched", async () => {
    const store = makeStore();
    const h = createContentUpdateHandler({ guard: denyGuard, store, ...fixed });
    expect(
      (
        await h(
          makeRequest({ contentId: "c1", updates: { Title: "x" } }),
          context,
        )
      ).status,
    ).toBe(403);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it("400s without contentId/updates and on protected fields", async () => {
    const store = makeStore();
    const h = createContentUpdateHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    expect((await h(makeRequest({}), context)).status).toBe(400);
    const res = await h(
      makeRequest({ contentId: "c1", updates: { contentStatus: "published" } }),
      context,
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(
      /protected field: contentStatus/,
    );
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it("404s when the document does not exist", async () => {
    const store = makeStore({ readDoc: vi.fn(async () => null) });
    const h = createContentUpdateHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({ contentId: "nope", updates: { Title: "x" } }),
      context,
    );
    expect(res.status).toBe(404);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it("patches the content doc, then writes a version and an audit row", async () => {
    const store = makeStore();
    const h = createContentUpdateHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({
        contentId: "c1",
        updates: { Title: "New Title", blogDraft: "Draft body" },
      }),
      context,
    );
    expect(JSON.parse(res.body)).toEqual({ success: true, contentId: "c1" });

    const [container, id, patch] = store.patchDoc.mock.calls[0];
    expect(container).toBe("content");
    expect(id).toBe("c1");
    expect(patch.Title).toBe("New Title");
    expect(patch.title).toBe("New Title"); // dual-cased by validation
    expect(patch.updatedAt).toBe("2026-08-06T12:00:00.000Z");
    expect(patch.updatedBy).toBe("editor@hcw.dev");

    const versionCall = store.upsertDoc.mock.calls.find(
      ([c]) => c === "content_versions",
    );
    expect(versionCall[1]).toMatchObject({
      id: "fixed-uuid",
      contentId: "c1", // the partition key — every version scoped to its parent
      title: "New Title",
      draft: "Draft body",
      versionReason: "review_updated",
      versionCreatedAt: "2026-08-06T12:00:00.000Z",
    });

    const auditCall = store.upsertDoc.mock.calls.find(
      ([c]) => c === "admin_audit_logs",
    );
    expect(auditCall[1]).toMatchObject({
      action: "content_item_updated",
      contentId: "c1",
      contentTitle: "Existing",
      userId: "oid-1",
    });
    expect(auditCall[1].details.updatedFields).toContain("Title");
  });

  it("writes content BEFORE the version snapshot — the accepted sequential contract", async () => {
    // Owner decision 2026-08-18 (option (a), Site-Main TODO §2): no
    // cross-container batch exists, so the writes are sequential and the
    // ordering IS the durability contract — a crash between them loses one
    // snapshot, while the reverse order could record history for an edit
    // that never happened. See the migration manifest's EXCEPTION ONE notes.
    const store = makeStore();
    const h = createContentUpdateHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    await h(makeRequest({ contentId: "c1", updates: { Title: "T" } }), context);

    const patchOrder = store.patchDoc.mock.invocationCallOrder[0];
    const versionIdx = store.upsertDoc.mock.calls.findIndex(
      ([c]) => c === "content_versions",
    );
    const versionOrder = store.upsertDoc.mock.invocationCallOrder[versionIdx];
    expect(patchOrder).toBeLessThan(versionOrder);
  });

  it("version doc falls back to current data for fields not in the update", async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: "c1",
        Title: "Old",
        summary: "Old summary",
        blogDraft: "Old draft",
      })),
    });
    const h = createContentUpdateHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    await h(
      makeRequest({ contentId: "c1", updates: { category: "Migration" } }),
      context,
    );
    const versionDoc = store.upsertDoc.mock.calls.find(
      ([c]) => c === "content_versions",
    )[1];
    expect(versionDoc.title).toBe("Old");
    expect(versionDoc.summary).toBe("Old summary");
    expect(versionDoc.draft).toBe("Old draft");
  });
});

describe("updateContentItem taxonomy (ADR 0033 §4)", () => {
  // Every built-in id present (the normaliser insists), tutorial switched off.
  const disabledTutorial = defaultTaxonomy();
  disabledTutorial.kinds = disabledTutorial.kinds.map((k) =>
    k.id === "tutorial" ? { ...k, enabled: false } : k,
  );
  /** readDoc answers the taxonomy for admin_config and the record otherwise. */
  const storeWith = (record) =>
    makeStore({
      readDoc: vi.fn(async (container) =>
        container === "admin_config" ? disabledTutorial : record,
      ),
    });

  it("writes a known kind and idea origin, lower-cased", async () => {
    const store = storeWith({ id: "c1", Title: "Existing" });
    const h = createContentUpdateHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({
        contentId: "c1",
        updates: { kind: "Article", ideaOrigin: "content-gap" },
      }),
      context,
    );
    expect(res.status).toBe(200);
    expect(store.patchDoc.mock.calls[0][2]).toMatchObject({
      kind: "article",
      ideaOrigin: "content-gap",
    });
  });

  it("400s an unknown or malformed id and writes nothing", async () => {
    const store = storeWith({ id: "c1" });
    const h = createContentUpdateHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    const unknown = await h(
      makeRequest({ contentId: "c1", updates: { ideaOrigin: "rumour" } }),
      context,
    );
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body).error).toMatch(
      /ideaOrigin "rumour" is not a known idea origin; allowed: manual, content-gap, search-trend/,
    );
    const malformed = await h(
      makeRequest({ contentId: "c1", updates: { kind: "Not An Id" } }),
      context,
    );
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body).error).toMatch(
      /kind must be a taxonomy id/,
    );
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it("keeps a disabled id the record already carries, and refuses moving onto one", async () => {
    const h = createContentUpdateHandler({
      guard: guardAs("editor"),
      store: storeWith({ id: "c1", kind: "tutorial" }),
      ...fixed,
    });
    const kept = await h(
      makeRequest({ contentId: "c1", updates: { kind: "tutorial" } }),
      context,
    );
    expect(kept.status).toBe(200);

    const store = storeWith({ id: "c2", kind: "article" });
    const h2 = createContentUpdateHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    const moved = await h2(
      makeRequest({ contentId: "c2", updates: { kind: "tutorial" } }),
      context,
    );
    expect(moved.status).toBe(400);
    expect(JSON.parse(moved.body).error).toMatch(
      /kind "tutorial" is disabled; allowed: article, documentation/,
    );
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});

describe("transitionContentStatus", () => {
  it("reserves the live transition for publishers — editors get 403", async () => {
    const store = makeStore();
    const h = createContentTransitionHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({ contentId: "c1", newStatus: "published" }),
      context,
    );
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/publisher access required/);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  /**
   * Taking a page off the public site stays a publisher action (AP-F13,
   * #937): Live Pages' Archive replaced softDeleteLivePage, which required
   * publisher, so every edge OUT of published is gated like every edge into
   * it. The document's status is only known after the read, so this refusal
   * is the transitioner's, after it; an editor keeps every edge that starts
   * anywhere else.
   */
  it("reserves every edge out of published for publishers — an editor's archive gets 403", async () => {
    const live = () => ({ id: "c1", contentStatus: "published", Live: true });
    const editor = createContentTransitionHandler({
      guard: guardAs("editor"),
      store: makeStore({ readDoc: vi.fn(async () => live()) }),
      ...fixed,
    });
    for (const newStatus of ["archived", "editing", "inspected", "rejected"]) {
      const res = await editor(makeRequest({ contentId: "c1", newStatus }), context);
      expect(res.status, newStatus).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(
        /publisher access required to move a page that is on the public site/,
      );
    }

    const store = makeStore({ readDoc: vi.fn(async () => live()) });
    const publisher = createContentTransitionHandler({
      guard: guardAs("publisher"),
      store,
      ...fixed,
    });
    const res = await publisher(
      makeRequest({ contentId: "c1", newStatus: "archived", reviewNotes: "Archived from Live Pages" }),
      context,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ from: "published", to: "archived" });
    expect(store.patchDoc.mock.calls[0][2]).toMatchObject({ contentStatus: "archived", Live: false });
  });

  it("leaves an editor every edge that starts off the site: archiving a rejected item, rejecting one in review", async () => {
    for (const [contentStatus, newStatus] of [
      ["rejected", "archived"],
      ["in_review", "rejected"],
      ["inspected", "approved"],
    ]) {
      const store = makeStore({
        readDoc: vi.fn(async () => ({ id: "c1", contentStatus })),
      });
      const h = createContentTransitionHandler({
        guard: guardAs("editor"),
        store,
        ...fixed,
      });
      const res = await h(makeRequest({ contentId: "c1", newStatus }), context);
      expect(res.status, `${contentStatus} → ${newStatus}`).toBe(200);
      expect(store.patchDoc).toHaveBeenCalledTimes(1);
    }
  });

  /**
   * The gate asks what the public site serves, not what contentStatus says
   * (AP-F13, #937). isPublicDocument also serves a `Live: true` document in
   * any status and a legacy `Status: 'Live'` one; gating `published` alone
   * let an editor take either down through `rejected`.
   */
  it("gates a live editing page and a legacy Status 'Live' page like a published one", async () => {
    const shapes = {
      "a live editing page": { id: "c1", contentStatus: "editing", Live: true },
      "a legacy Status 'Live' page": {
        id: "c1",
        contentStatus: "in_review",
        Status: "Live",
      },
    };
    for (const [name, doc] of Object.entries(shapes)) {
      // The premise: the site serves it, though its status is not published.
      expect(isPublicDocument(doc), name).toBe(true);

      const refused = makeStore({ readDoc: vi.fn(async () => ({ ...doc })) });
      const editor = createContentTransitionHandler({
        guard: guardAs("editor"),
        store: refused,
        ...fixed,
      });
      const res = await editor(
        makeRequest({ contentId: "c1", newStatus: "rejected" }),
        context,
      );
      expect(res.status, name).toBe(403);
      expect(refused.patchDoc, name).not.toHaveBeenCalled();
      expect(refused.upsertDoc, name).not.toHaveBeenCalled();

      const allowed = makeStore({ readDoc: vi.fn(async () => ({ ...doc })) });
      const publisher = createContentTransitionHandler({
        guard: guardAs("publisher"),
        store: allowed,
        ...fixed,
      });
      const ok = await publisher(
        makeRequest({ contentId: "c1", newStatus: "rejected" }),
        context,
      );
      expect(ok.status, name).toBe(200);
      expect(allowed.patchDoc.mock.calls[0][2], name).toMatchObject({
        contentStatus: "rejected",
        Live: false,
        Status: "Rejected",
      });
    }
  });

  it("refuses a caller that names no role on a page on the site, rather than waving it through", async () => {
    // The transitioner's own contract, below the HTTP guard: the bot and any
    // future caller must name a role (the bot names super_admin). Undefined
    // is the forgotten argument; null and "" are the guard's empty answers.
    for (const actorRole of [undefined, null, ""]) {
      const store = makeStore({
        readDoc: vi.fn(async () => ({
          id: "c1",
          contentStatus: "published",
          Live: true,
        })),
      });
      const apply = createContentStatusTransitioner({ store, ...fixed });
      const request = { contentId: "c1", newStatus: "rejected" };
      if (actorRole !== undefined) request.actorRole = actorRole;
      const result = await apply(request);
      expect(result, String(actorRole)).toMatchObject({ ok: false, status: 403 });
      expect(store.patchDoc).not.toHaveBeenCalled();
      expect(store.upsertDoc).not.toHaveBeenCalled();
    }

    // Named, it is the role that decides.
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: "c1",
        contentStatus: "published",
        Live: true,
      })),
    });
    const apply = createContentStatusTransitioner({ store, ...fixed });
    const result = await apply({
      contentId: "c1",
      newStatus: "rejected",
      actorRole: "super_admin",
    });
    expect(result).toMatchObject({ ok: true, from: "published", to: "rejected" });
  });

  it("lets a publisher publish from an eligible status, stamping Live and publishedAt", async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: "c1",
        contentStatus: "forge_ready",
        type: "blog",
      })),
    });
    const h = createContentTransitionHandler({
      guard: guardAs("publisher"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({ contentId: "c1", newStatus: "published" }),
      context,
    );
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      contentId: "c1",
      legacyBlogId: null,
      collectionName: "content",
      from: "forge_ready",
      to: "published",
    });
    const patch = store.patchDoc.mock.calls[0][2];
    expect(patch.contentStatus).toBe("published");
    expect(patch.Live).toBe(true);
    expect(patch.publishedAt).toBe("2026-08-06T12:00:00.000Z");
  });

  it("400s an illegal transition with the allowed list", async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: "c1", contentStatus: "archived" })),
    });
    const h = createContentTransitionHandler({
      guard: guardAs("publisher"),
      store,
      ...fixed,
    });
    // archived → editing: the archive opens back onto review or the site
    // (AP-F13, #937), never straight into the editor.
    const res = await h(
      makeRequest({ contentId: "c1", newStatus: "editing" }),
      context,
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/Invalid transition: archived → editing/);
    expect(body.allowedTransitions).toEqual([
      "in_review",
      "rejected",
      "published",
    ]);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it("normalizes legacy statuses on both sides of the transition", async () => {
    const store = makeStore({
      // Stored current status is a news-era value; normalizes to published.
      readDoc: vi.fn(async () => ({
        id: "c1",
        contentStatus: "published_news",
      })),
    });
    // A publisher, because the normalised status is `published` and leaving
    // it is a publisher's edge (AP-F13, #937): the legacy spelling is read
    // as live by the gate too.
    const h = createContentTransitionHandler({
      guard: guardAs("publisher"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({ contentId: "c1", newStatus: "archived" }),
      context,
    );
    const body = JSON.parse(res.body);
    expect(body.from).toBe("published");
    expect(body.to).toBe("archived");
    const patch = store.patchDoc.mock.calls[0][2];
    expect(patch.archivedAt).toBe("2026-08-06T12:00:00.000Z");
  });

  it("resolves legacy blogId callers through the publishedBlogId query", async () => {
    const store = makeStore({
      queryDocs: vi.fn(async () => [{ id: "resolved-1" }]),
      readDoc: vi.fn(async () => ({
        id: "resolved-1",
        contentStatus: "inspected",
      })),
    });
    const h = createContentTransitionHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({ blogId: "blog-9", newStatus: "in_review" }),
      context,
    );
    const body = JSON.parse(res.body);
    expect(body.contentId).toBe("resolved-1");
    expect(body.legacyBlogId).toBe("blog-9");
    const [, query, params] = store.queryDocs.mock.calls[0];
    expect(query).toContain("c.publishedBlogId = @blogId");
    expect(params).toEqual([{ name: "@blogId", value: "blog-9" }]);
  });

  it("404s an unknown blogId and an unknown contentId", async () => {
    const h1 = createContentTransitionHandler({
      guard: guardAs("editor"),
      store: makeStore(),
      ...fixed,
    });
    expect(
      (
        await h1(
          makeRequest({ blogId: "nope", newStatus: "in_review" }),
          context,
        )
      ).status,
    ).toBe(404);

    const h2 = createContentTransitionHandler({
      guard: guardAs("editor"),
      store: makeStore({ readDoc: vi.fn(async () => null) }),
      ...fixed,
    });
    expect(
      (
        await h2(
          makeRequest({ contentId: "nope", newStatus: "in_review" }),
          context,
        )
      ).status,
    ).toBe(404);
  });

  /**
   * Undo on Live Pages and Restore on the Archive board (AP-F13, #937): the
   * edge back from archived to published, for a publisher, with the stamp
   * cleared and the audit row written like every other edge.
   */
  it("lets a publisher bring an archived page back live, clearing archivedAt, and audits it", async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: "c1",
        Title: "Was live",
        contentStatus: "archived",
        Live: false,
        Status: "Archived",
        archivedAt: "2026-10-15T11:59:00.000Z",
        publishedAt: "2026-10-01T00:00:00.000Z",
      })),
    });
    const h = createContentTransitionHandler({
      guard: guardAs("publisher"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({ contentId: "c1", newStatus: "published", reviewNotes: "Undo" }),
      context,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ from: "archived", to: "published" });
    const patch = store.patchDoc.mock.calls[0][2];
    expect(patch.contentStatus).toBe("published");
    expect(patch.Live).toBe(true);
    expect(patch.archivedAt).toBeNull();
    expect("Status" in patch && patch.Status === undefined).toBe(true);
    expect(patch.publishedAt).toBe("2026-10-01T00:00:00.000Z");
    const auditCall = store.upsertDoc.mock.calls.find(([c]) => c === "audits");
    expect(auditCall[1]).toMatchObject({
      action: "status_transition",
      resourceId: "c1",
      changes: {
        before: { contentStatus: "archived" },
        after: { contentStatus: "published" },
        notes: "Undo",
      },
    });
  });

  it("keeps the way back from the archive to publishers, like every edge into published", async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: "c1", contentStatus: "archived" })),
    });
    const h = createContentTransitionHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({ contentId: "c1", newStatus: "published" }),
      context,
    );
    expect(res.status).toBe(403);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it("restore from rejected clears the rejection marker with an explicit null", async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: "c1",
        contentStatus: "rejected",
        rejectedAt: "2026-01-01",
      })),
    });
    const h = createContentTransitionHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    await h(makeRequest({ contentId: "c1", newStatus: "inspected" }), context);
    const patch = store.patchDoc.mock.calls[0][2];
    expect(patch.rejectedAt).toBeNull();
  });

  it("writes the audit row to the audits container with the transition diff", async () => {
    const store = makeStore();
    const h = createContentTransitionHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    await h(
      makeRequest({
        contentId: "c1",
        newStatus: "in_review",
        reviewNotes: "looks ok",
      }),
      context,
    );
    const auditCall = store.upsertDoc.mock.calls.find(([c]) => c === "audits");
    expect(auditCall[1]).toMatchObject({
      id: "fixed-uuid",
      action: "status_transition",
      resourceId: "c1",
      changes: {
        before: { contentStatus: "inspected" },
        after: { contentStatus: "in_review" },
        notes: "looks ok",
      },
      metadata: { authMethod: "entra_bearer_token" },
    });
  });

  it("400s malformed requests before touching the store", async () => {
    const store = makeStore();
    const h = createContentTransitionHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    expect(
      (await h(makeRequest({ newStatus: "approved" }), context)).status,
    ).toBe(400);
    expect(
      (await h(makeRequest({ contentId: "c1", newStatus: "bogus" }), context))
        .status,
    ).toBe(400);
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});

/**
 * The Drafts stage's two edges belong to lib/cms/drafts-handlers.js, which
 * checks where the article came from and writes under the read's ETag. The
 * generic transition (the admin portal's and the Telegram bot's) must refuse
 * both, or any in_review article could be dropped into the owner's Drafts and
 * a half-written draft pushed on with no title check.
 */
describe("transitionContentStatus and the Drafts stage", () => {
  it.each([
    ["in_review", "drafting"],
    ["drafting", "in_review"],
    ["drafting", "published"],
    ["drafting", "rejected"],
  ])("refuses %s → %s and writes nothing", async (from, to) => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: "c1",
        contentStatus: from,
        repoPath: "docs/content/blog-x.md",
      })),
    });
    const h = createContentTransitionHandler({
      guard: guardAs("super_admin"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({ contentId: "c1", newStatus: to }),
      context,
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      code: "DRAFTS_STAGE",
      error: expect.stringMatching(/\/admin\/drafts/),
    });
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it("leaves in_review’s own edges alone", async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: "c1", contentStatus: "in_review" })),
    });
    const h = createContentTransitionHandler({
      guard: guardAs("editor"),
      store,
      ...fixed,
    });
    const res = await h(
      makeRequest({ contentId: "c1", newStatus: "approved" }),
      context,
    );
    expect(res.status).toBe(200);
  });
});
