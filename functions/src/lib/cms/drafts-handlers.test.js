/**
 * The routes behind /admin/drafts (drafts-handlers.js), against an in-memory
 * store with the real client's conditional-write semantics and a fetch double
 * that answers like GitHub.
 *
 * Pinned, in the order the owner asked for it: the editor role on every
 * route; create, read, update and delete; two tabs cannot overwrite each
 * other; Send to In Review lands where the original import landed; Back to
 * Drafts only for an article from Drafts; delete takes the In Review item
 * with it and refuses anything live; the import is idempotent and recognises
 * the two Docker drafts already In Review.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIST_QUERY, createDraftsHandlers } from "./drafts-handlers.js";
import { DRAFTS_STAGE_STATUS } from "./drafts.js";
import {
  checkRepoDraftPath,
  parseRepoDraft,
  repoDraftContentId,
} from "./repo-draft.js";
import { createRepoDraftSource } from "./repo-draft-source.js";
import { isPublicDocument } from "../public-reads.js";
import { matchesQueueStatus } from "../admin-snapshots.js";
import {
  API_PREFIX,
  LAB_01,
  LAB_02,
  LAB_03,
  LAB_TEXT,
  RAW_PREFIX,
  githubFetch,
  textResponse,
} from "./repo-draft-github.test-helper.js";

const USER = { oid: "u1", email: "owner@hcw.dev" };
const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const allowGuard = () => ({
  requireRole: vi.fn(async () => ({
    user: USER,
    role: "super_admin",
    error: null,
  })),
});
const denyGuard = () => ({
  requireRole: vi.fn(async () => ({
    user: null,
    role: null,
    error: { status: 403, body: "{}" },
  })),
});
const request = ({ id, body } = {}) => ({
  params: id === undefined ? {} : { id },
  headers: { get: () => "vitest" },
  json: async () => body,
});
const parse = (res) => ({ status: res.status, body: JSON.parse(res.body) });

const FIELDS = Object.freeze({
  title: "A draft written on the site",
  subtitle: "Saved from any device.",
  date: "2026-10-03",
  track: "how-to",
  part: "1 of 1",
  tags: ["azure"],
  reading: 5,
  body: "## One\n\nBody text.",
});

// ── an in-memory store with the real client's conditional writes ──────────

const failure = (code, message) => Object.assign(new Error(message), { code });

function applyUpdates(doc, updates) {
  const next = { ...doc };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

function memoryStore(seed = []) {
  let etag = 1;
  const nextEtag = () => `"e${etag++}"`;
  const docs = new Map(
    seed.map((doc) => [doc.id, { _etag: nextEtag(), ...doc }]),
  );
  const audits = [];
  const query = async (container, text, parameters = []) => {
    if (container !== "content")
      throw new Error(`unexpected container ${container}`);
    const param = (name) => parameters.find((p) => p.name === name)?.value;
    const all = [...docs.values()].map((doc) => structuredClone(doc));
    if (text === LIST_QUERY) {
      return all.filter(
        (doc) =>
          doc.contentStatus === param("@drafting") ||
          doc.draftOrigin !== undefined ||
          doc.repoPath !== undefined,
      );
    }
    if (text.includes("ARRAY_CONTAINS(@paths, c.repoPath)")) {
      return all.filter((doc) => param("@paths").includes(doc.repoPath));
    }
    if (text.includes("c.normalizedTitle = @title")) {
      return all.filter((doc) => doc.normalizedTitle === param("@title"));
    }
    throw new Error(`unexpected query ${text}`);
  };
  return {
    docs,
    audits,
    queryDocs: vi.fn(query),
    readDoc: vi.fn(async (container, id) =>
      docs.has(id) ? structuredClone(docs.get(id)) : null,
    ),
    createDoc: vi.fn(async (container, doc) => {
      if (docs.has(doc.id)) throw failure(409, "Conflict");
      const stored = { ...structuredClone(doc), _etag: nextEtag() };
      docs.set(doc.id, stored);
      return structuredClone(stored);
    }),
    patchDoc: vi.fn(async (container, id, updates, options = {}) => {
      const doc = docs.get(id);
      if (!doc) throw failure(404, "missing");
      if (options.ifMatch && options.ifMatch !== doc._etag)
        throw failure(412, "changed");
      const next = { ...applyUpdates(doc, updates), _etag: nextEtag() };
      docs.set(id, next);
      return structuredClone(next);
    }),
    deleteDocIfMatch: vi.fn(async (container, id, ifMatch) => {
      const doc = docs.get(id);
      if (!doc) throw failure(404, "missing");
      if (ifMatch !== doc._etag) throw failure(412, "changed");
      docs.delete(id);
    }),
    // Audit rows only: the Drafts routes never replace a content document.
    upsertDoc: vi.fn(async (container, doc) => {
      if (!["admin_audit_logs", "audits"].includes(container)) {
        throw new Error(
          `upsertDoc on ${container} — drafts must not replace documents`,
        );
      }
      audits.push({ container, ...doc });
      return doc;
    }),
  };
}

function setup({
  seed = [],
  fetch = githubFetch(),
  guard = allowGuard(),
} = {}) {
  const store = memoryStore(seed);
  const onContentDeleted = vi.fn(async () => ({}));
  let n = 0;
  const handlers = createDraftsHandlers({
    guard,
    store,
    source: createRepoDraftSource({ fetch: fetch.fetchImpl }),
    onContentDeleted,
    now: () => new Date("2026-10-03T12:00:00.000Z"),
    uuid: () => `id-${++n}`,
  });
  return { handlers, store, fetch, guard, onContentDeleted };
}

/** Create a draft through the route and return what the page receives. */
async function created(handlers, fields = FIELDS) {
  const res = parse(
    await handlers.create(request({ body: { fields } }), context),
  );
  expect(res.status).toBe(201);
  return res.body.draft;
}

const DOCKER_IN_REVIEW = Object.freeze({
  id: repoDraftContentId(LAB_02),
  Title: "The Docker draft already In Review",
  contentStatus: "in_review",
  Live: false,
  Status: "Draft",
  repoPath: LAB_02,
  postContent: "Imported body.",
  updatedAt: "2026-09-30T00:00:00.000Z",
});
const FORGE_IN_REVIEW = Object.freeze({
  id: "forge-1",
  Title: "A forged article",
  contentStatus: "in_review",
  Live: false,
  postContent: "Forged.",
});
const LIVE_FROM_DRAFTS = Object.freeze({
  id: "live-1",
  Title: "Published from Drafts",
  contentStatus: "published",
  Live: true,
  draftOrigin: "drafts",
  normalizedTitle: "published from drafts",
});

beforeEach(() => {
  context.log.mockClear();
  context.warn.mockClear();
  context.error.mockClear();
});

// ── the role ───────────────────────────────────────────────────────────────

describe("the role", () => {
  it.each([
    "list",
    "get",
    "create",
    "update",
    "remove",
    "sendToReview",
    "backToDrafts",
    "importFromRepo",
  ])("%s asks for editor and stops at a refusal", async (name) => {
    const { handlers, guard, store, fetch } = setup({
      guard: denyGuard(),
      seed: [DOCKER_IN_REVIEW],
    });
    const res = await handlers[name](
      request({
        id: DOCKER_IN_REVIEW.id,
        body: { fields: FIELDS, etag: '"e1"' },
      }),
      context,
    );
    expect(res.status).toBe(403);
    expect(guard.requireRole).toHaveBeenCalledWith(expect.anything(), "editor");
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(fetch.fetchImpl).not.toHaveBeenCalled();
  });
});

// ── create, read, update ───────────────────────────────────────────────────

describe("create and read", () => {
  it("creates a draft that is not Live and not on any public read", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers);
    expect(draft).toMatchObject({
      id: "id-1",
      stage: "draft",
      contentStatus: DRAFTS_STAGE_STATUS,
    });
    expect(draft.etag).toMatch(/^"e\d+"$/);
    // The defaults of the taxonomy ride along (ADR 0033 §4).
    expect(draft.fields).toEqual({
      ...FIELDS,
      kind: "article",
      ideaOrigin: "manual",
    });
    const stored = store.docs.get("id-1");
    expect(stored).toMatchObject({
      Live: false,
      Status: "Draft",
      contentStatus: "drafting",
    });
    expect(isPublicDocument(stored)).toBe(false);
    expect(store.audits.map((row) => row.action)).toEqual([
      "content_draft_created",
    ]);
  });

  it("classifies a draft on create and on save, and refuses an id the taxonomy does not know", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers, {
      ...FIELDS,
      kind: "tutorial",
      ideaOrigin: "content-gap",
    });
    expect(draft.fields).toMatchObject({
      kind: "tutorial",
      ideaOrigin: "content-gap",
    });

    const saved = parse(
      await handlers.update(
        request({
          id: draft.id,
          body: { fields: { ...FIELDS, kind: "case-study" }, etag: draft.etag },
        }),
        context,
      ),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.draft.fields).toMatchObject({
      kind: "case-study",
      ideaOrigin: "content-gap",
    });

    const refused = parse(
      await handlers.create(
        request({ body: { fields: { ...FIELDS, kind: "haiku" } } }),
        context,
      ),
    );
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("INVALID");
    expect(refused.body.error).toMatch(
      /kind "haiku" is not a known kind; allowed: article/,
    );
    expect(store.docs.size).toBe(1);
  });

  it("refuses a workflow field rather than storing it, and writes nothing", async () => {
    const { handlers, store } = setup();
    const res = parse(
      await handlers.create(
        request({
          body: {
            fields: { ...FIELDS, contentStatus: "published", Live: true },
          },
        }),
        context,
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "INVALID",
      error: expect.stringMatching(/contentStatus, Live/),
    });
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it("lists drafts and articles from Drafts, newest first, without bodies — never a forged article", async () => {
    const { handlers } = setup({
      seed: [DOCKER_IN_REVIEW, FORGE_IN_REVIEW, LIVE_FROM_DRAFTS],
    });
    await created(handlers);
    const res = parse(await handlers.list(request(), context));
    expect(res.status).toBe(200);
    expect(res.body.drafts.map((row) => [row.id, row.stage])).toEqual([
      ["id-1", "draft"],
      [DOCKER_IN_REVIEW.id, "in_review"],
      ["live-1", "live"],
    ]);
    expect(res.body.drafts[1].actions).toMatchObject({
      backToDrafts: true,
      delete: true,
      edit: false,
    });
    expect(res.body.drafts[1].origin).toBe("repo-import");
    expect(JSON.stringify(res.body)).not.toContain("Body text.");
  });

  it("reads one draft with its body, and 404s an article that never came from Drafts", async () => {
    const { handlers } = setup({ seed: [FORGE_IN_REVIEW] });
    const { id } = await created(handlers);
    const res = parse(await handlers.get(request({ id }), context));
    expect(res.body.draft.fields.body).toBe(FIELDS.body);
    expect(
      (await handlers.get(request({ id: "forge-1" }), context)).status,
    ).toBe(404);
    expect(
      (await handlers.get(request({ id: "../etc" }), context)).status,
    ).toBe(400);
  });
});

describe("update — and two tabs that cannot overwrite each other", () => {
  it("saves the fields and answers the new etag", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers);
    const res = parse(
      await handlers.update(
        request({
          id: draft.id,
          body: {
            etag: draft.etag,
            fields: { ...FIELDS, title: "Retitled", reading: "" },
          },
        }),
        context,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.draft.fields).toMatchObject({
      title: "Retitled",
      reading: null,
    });
    expect(res.body.draft.etag).not.toBe(draft.etag);
    expect(store.docs.get(draft.id)).not.toHaveProperty("readTime");
    expect(store.docs.get(draft.id).contentStatus).toBe("drafting");
  });

  it("requires the etag of the version being edited", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers);
    const res = parse(
      await handlers.update(
        request({ id: draft.id, body: { fields: FIELDS } }),
        context,
      ),
    );
    expect(res).toMatchObject({ status: 400, body: { code: "ETAG_REQUIRED" } });
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it("refuses the second tab with a 412 and the current version, and keeps the first tab’s save", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers);
    const tabA = parse(
      await handlers.update(
        request({
          id: draft.id,
          body: { etag: draft.etag, fields: { ...FIELDS, body: "Tab A" } },
        }),
        context,
      ),
    );
    expect(tabA.status).toBe(200);
    const tabB = parse(
      await handlers.update(
        request({
          id: draft.id,
          body: { etag: draft.etag, fields: { ...FIELDS, body: "Tab B" } },
        }),
        context,
      ),
    );
    expect(tabB.status).toBe(412);
    expect(tabB.body).toMatchObject({
      code: "CONFLICT",
      current: { etag: tabA.body.draft.etag },
    });
    expect(store.docs.get(draft.id).postContent).toBe("Tab A");
  });

  it("turns a write that lands between the read and the patch into the same 412", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers);
    store.patchDoc.mockImplementationOnce(async () => {
      throw failure(412, "changed");
    });
    const res = parse(
      await handlers.update(
        request({ id: draft.id, body: { etag: draft.etag, fields: FIELDS } }),
        context,
      ),
    );
    expect(res).toMatchObject({ status: 412, body: { code: "CONFLICT" } });
  });

  it("does not save over an article In Review; Back to Drafts first", async () => {
    const { handlers, store } = setup({ seed: [DOCKER_IN_REVIEW] });
    const etag = store.docs.get(DOCKER_IN_REVIEW.id)._etag;
    const res = parse(
      await handlers.update(
        request({ id: DOCKER_IN_REVIEW.id, body: { etag, fields: FIELDS } }),
        context,
      ),
    );
    expect(res).toMatchObject({ status: 409, body: { code: "IN_REVIEW" } });
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});

// ── transitions ────────────────────────────────────────────────────────────

describe("Send to In Review", () => {
  it("lands the same document In Review, normalised and stamped, where the review board lists it", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers, {
      ...FIELDS,
      body: "## TL;DR\n\nShort.\n\n## One\n\nBody text.",
    });
    const res = parse(
      await handlers.sendToReview(
        request({ id: draft.id, body: { etag: draft.etag } }),
        context,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.reviewPath).toBe(`/admin/review-queue/${draft.id}`);
    expect(res.body.draft.stage).toBe("in_review");
    const stored = store.docs.get(draft.id);
    expect(stored).toMatchObject({
      contentStatus: "in_review",
      Live: false,
      "Cloud Provider": "Azure",
    });
    expect(stored.content).toBe("## One\n\nBody text.\n\n## TL;DR\n\nShort.");
    expect(matchesQueueStatus(stored, "in_review")).toBe(true);
    expect(isPublicDocument(stored)).toBe(false);
    expect(store.docs.size).toBe(1);
    expect(
      store.audits.find((row) => row.container === "audits"),
    ).toMatchObject({
      action: "status_transition",
      changes: {
        before: { contentStatus: "drafting" },
        after: { contentStatus: "in_review" },
      },
    });
  });

  it("refuses a draft with no body yet", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers, { title: "Only a title" });
    const res = parse(
      await handlers.sendToReview(
        request({ id: draft.id, body: { etag: draft.etag } }),
        context,
      ),
    );
    expect(res).toMatchObject({ status: 422, body: { code: "EMPTY_BODY" } });
    expect(store.docs.get(draft.id).contentStatus).toBe("drafting");
  });

  it("refuses a title a published article already carries", async () => {
    const { handlers, store } = setup({ seed: [LIVE_FROM_DRAFTS] });
    const draft = await created(handlers, {
      ...FIELDS,
      title: "Published from Drafts",
    });
    const res = parse(
      await handlers.sendToReview(
        request({ id: draft.id, body: { etag: draft.etag } }),
        context,
      ),
    );
    expect(res).toMatchObject({
      status: 409,
      body: { code: "PUBLISHED_ELSEWHERE", existingId: "live-1" },
    });
    expect(store.docs.get(draft.id).contentStatus).toBe("drafting");
  });

  it("refuses a stale etag", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers);
    await handlers.update(
      request({ id: draft.id, body: { etag: draft.etag, fields: FIELDS } }),
      context,
    );
    const res = parse(
      await handlers.sendToReview(
        request({ id: draft.id, body: { etag: draft.etag } }),
        context,
      ),
    );
    expect(res).toMatchObject({ status: 412, body: { code: "CONFLICT" } });
    expect(store.docs.get(draft.id).contentStatus).toBe("drafting");
  });
});

describe("Back to Drafts", () => {
  it("brings the Docker draft the original import put In Review back to Drafts", async () => {
    const { handlers, store } = setup({ seed: [DOCKER_IN_REVIEW] });
    const etag = store.docs.get(DOCKER_IN_REVIEW.id)._etag;
    const res = parse(
      await handlers.backToDrafts(
        request({ id: DOCKER_IN_REVIEW.id, body: { etag } }),
        context,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.draft).toMatchObject({
      stage: "draft",
      actions: { edit: true, sendToReview: true },
    });
    expect(store.docs.get(DOCKER_IN_REVIEW.id)).toMatchObject({
      contentStatus: "drafting",
      Live: false,
    });
  });

  it("round-trips: a draft sent to review comes back editable", async () => {
    const { handlers } = setup();
    const draft = await created(handlers);
    const sent = parse(
      await handlers.sendToReview(
        request({ id: draft.id, body: { etag: draft.etag } }),
        context,
      ),
    );
    const back = parse(
      await handlers.backToDrafts(
        request({ id: draft.id, body: { etag: sent.body.draft.etag } }),
        context,
      ),
    );
    expect(back.body.draft.stage).toBe("draft");
    expect(back.body.draft.fields.title).toBe(FIELDS.title);
  });

  it("does not reach an article that never came from Drafts", async () => {
    const { handlers, store } = setup({ seed: [FORGE_IN_REVIEW] });
    const etag = store.docs.get("forge-1")._etag;
    const res = await handlers.backToDrafts(
      request({ id: "forge-1", body: { etag } }),
      context,
    );
    expect(res.status).toBe(404);
    expect(store.docs.get("forge-1").contentStatus).toBe("in_review");
  });
});

describe("delete", () => {
  it("deletes a draft and moves the dashboard counters", async () => {
    const { handlers, store, onContentDeleted } = setup();
    const draft = await created(handlers);
    const res = parse(
      await handlers.remove(
        request({ id: draft.id, body: { etag: draft.etag } }),
        context,
      ),
    );
    expect(res).toMatchObject({
      status: 200,
      body: { deleted: draft.id, stage: "draft" },
    });
    expect(store.docs.has(draft.id)).toBe(false);
    expect(onContentDeleted).toHaveBeenCalledWith(draft.id);
  });

  it("removes both: a draft already sent forward and still In Review leaves nothing behind", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers);
    const sent = parse(
      await handlers.sendToReview(
        request({ id: draft.id, body: { etag: draft.etag } }),
        context,
      ),
    );
    const res = parse(
      await handlers.remove(
        request({ id: draft.id, body: { etag: sent.body.draft.etag } }),
        context,
      ),
    );
    expect(res).toMatchObject({ status: 200, body: { stage: "in_review" } });
    expect(store.docs.size).toBe(0);
  });

  it("refuses a live article and touches nothing", async () => {
    const { handlers, store, onContentDeleted } = setup({
      seed: [LIVE_FROM_DRAFTS],
    });
    const etag = store.docs.get("live-1")._etag;
    const res = parse(
      await handlers.remove(request({ id: "live-1", body: { etag } }), context),
    );
    expect(res).toMatchObject({ status: 409, body: { code: "LIVE" } });
    expect(res.body.error).toMatch(/live on the site/);
    expect(store.deleteDocIfMatch).not.toHaveBeenCalled();
    expect(store.docs.get("live-1")).toMatchObject({
      Live: true,
      contentStatus: "published",
    });
    expect(onContentDeleted).not.toHaveBeenCalled();
  });

  it("refuses a stale etag, so a draft sent to review in another tab is not deleted from this one", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers);
    await handlers.sendToReview(
      request({ id: draft.id, body: { etag: draft.etag } }),
      context,
    );
    const res = parse(
      await handlers.remove(
        request({ id: draft.id, body: { etag: draft.etag } }),
        context,
      ),
    );
    expect(res).toMatchObject({ status: 412, body: { code: "CONFLICT" } });
    expect(store.docs.has(draft.id)).toBe(true);
  });

  it("turns a delete that races a write into the same 412", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers);
    store.deleteDocIfMatch.mockImplementationOnce(async () => {
      throw failure(412, "changed");
    });
    const res = parse(
      await handlers.remove(
        request({ id: draft.id, body: { etag: draft.etag } }),
        context,
      ),
    );
    expect(res).toMatchObject({ status: 412, body: { code: "CONFLICT" } });
  });
});

// ── the import ─────────────────────────────────────────────────────────────

describe("Import from docs/content", () => {
  it("imports every article file as a draft, never the contract docs or a README", async () => {
    const { handlers, store } = setup();
    const res = parse(await handlers.importFromRepo(request(), context));
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ imported: 3 });
    expect(res.body.results.map((r) => r.path)).toEqual([
      LAB_01,
      LAB_02,
      LAB_03,
    ]);
    for (const path of [LAB_01, LAB_02, LAB_03]) {
      const doc = store.docs.get(repoDraftContentId(path));
      expect(doc).toMatchObject({
        contentStatus: "drafting",
        Live: false,
        repoPath: path,
        draftOrigin: "repo-import",
      });
      expect(isPublicDocument(doc)).toBe(false);
    }
  });

  it("is idempotent: a second run fetches no file and writes nothing", async () => {
    const fetch = githubFetch();
    const { handlers, store } = setup({ fetch });
    await handlers.importFromRepo(request(), context);
    const before = structuredClone([...store.docs.entries()]);
    fetch.calls.length = 0;
    const res = parse(await handlers.importFromRepo(request(), context));
    expect(res.body.counts).toEqual({ skipped: 3 });
    expect(res.body.results.every((r) => r.code === "ALREADY_IMPORTED")).toBe(
      true,
    );
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `${API_PREFIX}contents/docs/content?ref=main`,
    ]);
    expect([...store.docs.entries()]).toEqual(before);
  });

  it("never duplicates when two imports race (a double click)", async () => {
    const { handlers, store } = setup();
    await Promise.all([
      handlers.importFromRepo(request(), context),
      handlers.importFromRepo(request(), context),
    ]);
    expect(store.docs.size).toBe(3);
  });

  it("shows a Docker draft the original import put In Review as In Review, and leaves it alone", async () => {
    const fetch = githubFetch();
    const { handlers, store } = setup({ seed: [DOCKER_IN_REVIEW], fetch });
    const res = parse(await handlers.importFromRepo(request(), context));
    const docker = res.body.results.find((r) => r.path === LAB_02);
    expect(docker).toMatchObject({
      outcome: "skipped",
      code: "ALREADY_IMPORTED",
      stage: "in_review",
    });
    expect(fetch.calls.map((c) => c.url)).not.toContain(
      `${RAW_PREFIX}blog-lab-02-one-container.md`,
    );
    expect(store.docs.get(DOCKER_IN_REVIEW.id).contentStatus).toBe("in_review");
  });

  it("skips a file whose title a published article already carries", async () => {
    const title = parseRepoDraft(LAB_TEXT[LAB_01]).draft.title;
    const live = {
      id: "old-post",
      Live: true,
      contentStatus: "published",
      normalizedTitle: title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    };
    const { handlers, store } = setup({ seed: [live] });
    const res = parse(await handlers.importFromRepo(request(), context));
    expect(res.body.results.find((r) => r.path === LAB_01)).toMatchObject({
      outcome: "skipped",
      code: "PUBLISHED_ELSEWHERE",
      existingId: "old-post",
    });
    expect(store.docs.has(repoDraftContentId(LAB_01))).toBe(false);
  });

  it("reports one unreadable file without stopping the rest", async () => {
    const fetch = githubFetch({
      files: { ...LAB_TEXT, [LAB_03]: "no front matter" },
    });
    const { handlers } = setup({ fetch });
    const res = parse(await handlers.importFromRepo(request(), context));
    expect(res.body.counts).toEqual({ imported: 2, refused: 1 });
    expect(res.body.results.find((r) => r.path === LAB_03)).toMatchObject({
      code: "NO_FRONT_MATTER",
    });
  });

  it("answers 503 when GitHub’s rate limit is used up, before touching the store", async () => {
    const limited = vi.fn(async () =>
      textResponse("{}", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1790000000",
        },
      }),
    );
    const { handlers, store } = setup({
      fetch: { fetchImpl: limited, calls: [] },
    });
    const res = parse(await handlers.importFromRepo(request(), context));
    expect(res).toMatchObject({ status: 503, body: { code: "RATE_LIMITED" } });
    expect(store.queryDocs).not.toHaveBeenCalled();
  });
});

/**
 * The owner's migration: the files in docs/content today. Read from disk, so
 * a new file that would not import, or a contract doc that would, fails here.
 */
describe("the docs/content directory as it stands", () => {
  const dir = join(process.cwd(), "..", "docs", "content");
  const names = readdirSync(dir).filter(
    (name) => name.startsWith("blog-") && name.endsWith(".md"),
  );
  const importable = names
    .map((name) => `docs/content/${name}`)
    .filter((path) => checkRepoDraftPath(path).ok);

  it("holds seventeen articles once the two contract docs are set aside", () => {
    expect(names).toContain("blog-template.md");
    expect(names).toContain("blog-machine.md");
    expect(importable).toHaveLength(17);
    expect(importable).not.toContain("docs/content/blog-template.md");
    expect(importable).not.toContain("docs/content/blog-machine.md");
  });

  it.each(importable)("%s parses into a draft", (path) => {
    const parsed = parseRepoDraft(
      readFileSync(join(process.cwd(), "..", ...path.split("/")), "utf8"),
    );
    expect(parsed.ok, parsed.error).toBe(true);
  });
});
