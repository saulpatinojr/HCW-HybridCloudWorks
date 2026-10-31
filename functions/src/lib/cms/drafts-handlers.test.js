/**
 * The routes behind /admin/drafts (drafts-handlers.js), against an in-memory
 * store with the real client's conditional-write semantics.
 *
 * Pinned, in the order the owner asked for it: the editor role on every
 * route; create, read, update and delete; two tabs cannot overwrite each
 * other; Send to In Review lands where the original import landed; Back to
 * Drafts only for an article from Drafts; delete takes the In Review item
 * with it and refuses anything live; the markdown upload is idempotent and
 * recognises an article already in Drafts or In Review.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { LIST_QUERY, createDraftsHandlers } from "./drafts-handlers.js";
import { DRAFTS_STAGE_STATUS } from "./drafts.js";
import {
  MAX_MARKDOWN_BYTES,
  MAX_REQUEST_BYTES,
  markdownDraftContentId,
} from "./drafts-markdown.js";
import { parseRepoDraft, repoDraftContentId } from "./repo-draft.js";
import { isPublicDocument } from "../public-reads.js";
import { matchesQueueStatus } from "../admin-snapshots.js";

/**
 * Synthetic drafts in ./__fixtures__, written to the blog template. They hold
 * no real article text: the real drafts do not live in this public repository.
 */
const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const FIXTURE_NAMES = readdirSync(FIXTURES).filter((name) =>
  name.endsWith(".txt"),
);
const fixtureText = (name) => readFileSync(new URL(name, FIXTURES), "utf8");
const SAMPLE_02 = "docs/content/blog-sample-02-second-part.md";

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

function setup({ seed = [], guard = allowGuard() } = {}) {
  const store = memoryStore(seed);
  const onContentDeleted = vi.fn(async () => ({}));
  let n = 0;
  const handlers = createDraftsHandlers({
    guard,
    store,
    onContentDeleted,
    now: () => new Date("2026-10-03T12:00:00.000Z"),
    uuid: () => `id-${++n}`,
  });
  return { handlers, store, guard, onContentDeleted };
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
  id: repoDraftContentId(SAMPLE_02),
  Title: "The Docker draft already In Review",
  contentStatus: "in_review",
  Live: false,
  Status: "Draft",
  repoPath: SAMPLE_02,
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
    "createFromMarkdown",
    "update",
    "remove",
    "sendToReview",
    "backToDrafts",
  ])("%s asks for editor and stops at a refusal", async (name) => {
    const { handlers, guard, store } = setup({
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

// ── a whole markdown file → a draft ───────────────────────────────────────

const MARKDOWN = [
  "---",
  "title: A draft from my vault",
  "subtitle: Written in Obsidian.",
  "date: 2026-10-20",
  "track: how-to",
  "part: 1 of 2",
  "tags: [azure, terraform]",
  "reading: 7",
  "status: outlined",
  "---",
  "",
  "## First step",
  "",
  "Body text.",
  "",
].join("\n");

const fromMarkdown = async (handlers, markdown, origin = "vault") =>
  parse(
    await handlers.createFromMarkdown(
      request({ body: { markdown, origin } }),
      context,
    ),
  );

describe("from-markdown — a whole file becomes a draft", () => {
  it("creates a draft from the file, never Live and never public, and reports the warnings", async () => {
    const { handlers, store } = setup();
    const res = await fromMarkdown(
      handlers,
      `${MARKDOWN}\nSee [part two](blog-sample-02-x.md).\n`,
    );
    const id = markdownDraftContentId("A draft from my vault");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      outcome: "created",
      contentId: id,
      title: "A draft from my vault",
      draft: { id, stage: "draft", origin: "vault" },
    });
    expect(res.body.warnings).toEqual([
      expect.stringContaining("blog-sample-02-x.md"),
    ]);
    const stored = store.docs.get(id);
    expect(stored).toMatchObject({
      Title: "A draft from my vault",
      Summary: "Written in Obsidian.",
      Tags: ["azure", "terraform"],
      readTime: "7 min",
      draftOrigin: "vault",
      contentStatus: "drafting",
      Live: false,
      Status: "Draft",
      createdBy: "owner@hcw.dev",
      frontMatter: {
        date: "2026-10-20",
        track: "how-to",
        part: "1 of 2",
        reading: 7,
      },
    });
    expect(stored.postContent).toContain("## First step");
    expect(stored.postContent).not.toContain("status: outlined");
    expect(isPublicDocument(stored)).toBe(false);
    expect(matchesQueueStatus(stored, "in_review")).toBe(false);
  });

  it("stores a pasted file under the paste origin", async () => {
    const { handlers, store } = setup();
    const res = await fromMarkdown(handlers, MARKDOWN, "paste");
    expect(res.status).toBe(201);
    expect(store.docs.get(res.body.contentId).draftOrigin).toBe("paste");
    expect(res.body.draft.origin).toBe("paste");
  });

  it("reports a second upload of the same article as already present, and writes nothing", async () => {
    const { handlers, store } = setup();
    const first = await fromMarkdown(handlers, MARKDOWN);
    store.createDoc.mockClear();
    // Same article, different case and punctuation in the title, other origin.
    const again = await fromMarkdown(
      handlers,
      MARKDOWN.replace("A draft from my vault", "a DRAFT from my vault!"),
      "paste",
    );
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      ok: true,
      outcome: "skipped",
      code: "ALREADY_IMPORTED",
      contentId: first.body.contentId,
      stage: "draft",
    });
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.docs.size).toBe(1);
  });

  it("recognises an article already imported from docs/content or written on the page", async () => {
    const { handlers, store } = setup({ seed: [DOCKER_IN_REVIEW] });
    const imported = await fromMarkdown(
      handlers,
      MARKDOWN.replace(
        "A draft from my vault",
        "The Docker draft already In Review",
      ),
    );
    expect(imported.body).toMatchObject({
      outcome: "skipped",
      code: "ALREADY_IMPORTED",
      contentId: DOCKER_IN_REVIEW.id,
      stage: "in_review",
    });
    const typed = await created(handlers);
    const again = await fromMarkdown(
      handlers,
      MARKDOWN.replace("A draft from my vault", FIELDS.title),
    );
    expect(again.body).toMatchObject({
      code: "ALREADY_IMPORTED",
      contentId: typed.id,
    });
    expect(store.docs.size).toBe(2);
  });

  it("never duplicates when two uploads race (a double click)", async () => {
    const { handlers, store } = setup();
    const [a, b] = await Promise.all([
      fromMarkdown(handlers, MARKDOWN),
      fromMarkdown(handlers, MARKDOWN),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(store.docs.size).toBe(1);
    const skipped = a.status === 200 ? a : b;
    expect(skipped.body).toMatchObject({
      outcome: "skipped",
      code: "ALREADY_IMPORTED",
    });
  });

  it("skips a title a published article already carries", async () => {
    const { handlers, store } = setup({ seed: [LIVE_FROM_DRAFTS] });
    const res = await fromMarkdown(
      handlers,
      MARKDOWN.replace("A draft from my vault", "Published from Drafts"),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "skipped",
      code: "PUBLISHED_ELSEWHERE",
      existingId: "live-1",
    });
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it.each([
    ["no front matter", "Just text, no block.\n", "NO_FRONT_MATTER"],
    ["no title", "---\nsubtitle: x\n---\n\nBody\n", "NO_TITLE"],
    ["no article", "---\ntitle: Only a title\n---\n", "EMPTY_BODY"],
  ])(
    "refuses a file with %s (422) and writes nothing",
    async (_name, text, code) => {
      const { handlers, store } = setup();
      const res = await fromMarkdown(handlers, text);
      expect(res).toMatchObject({ status: 422, body: { ok: false, code } });
      expect(res.body.error).toEqual(expect.any(String));
      expect(store.createDoc).not.toHaveBeenCalled();
    },
  );

  it("refuses a field the draft rules refuse, in the owner's words (400)", async () => {
    const { handlers, store } = setup();
    const res = await fromMarkdown(
      handlers,
      MARKDOWN.replace("track: how-to", `track: ${"t".repeat(41)}`),
    );
    expect(res).toMatchObject({ status: 400, body: { ok: false } });
    expect(res.body.error).toMatch(/track/);
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it.each([
    ["no origin", { markdown: MARKDOWN }],
    ["an unknown origin", { markdown: MARKDOWN, origin: "drafts" }],
    ["an inherited key as origin", { markdown: MARKDOWN, origin: "toString" }],
    ["no markdown", { origin: "paste" }],
    ["blank markdown", { markdown: "  \n", origin: "paste" }],
    ["markdown that is not text", { markdown: { a: 1 }, origin: "paste" }],
  ])("refuses %s (400)", async (_name, body) => {
    const { handlers, store } = setup();
    const res = parse(
      await handlers.createFromMarkdown(request({ body }), context),
    );
    expect(res).toMatchObject({
      status: 400,
      body: { ok: false, code: "INVALID" },
    });
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it("refuses a file over the size cap (413), by bytes not characters", async () => {
    const { handlers, store } = setup();
    const body = "é".repeat(MAX_MARKDOWN_BYTES / 2 + 1);
    const res = await fromMarkdown(
      handlers,
      `---\ntitle: Big\n---\n\n${body}`,
    );
    expect(res).toMatchObject({ status: 413, body: { code: "TOO_LARGE" } });
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it("refuses a body over the 256 KB cap that fits under the file cap (400)", async () => {
    const { handlers, store } = setup();
    const body = "a".repeat(256 * 1024 + 1);
    const res = await fromMarkdown(
      handlers,
      `---\ntitle: Big\n---\n\n${body}`,
    );
    expect(res).toMatchObject({ status: 400, body: { code: "INVALID" } });
    expect(res.body.error).toMatch(/at most 262144/);
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it("refuses an oversized request by its declared length without reading it", async () => {
    const { handlers, store } = setup();
    const json = vi.fn(async () => ({ markdown: MARKDOWN, origin: "paste" }));
    const res = parse(
      await handlers.createFromMarkdown(
        {
          params: {},
          headers: {
            get: (name) => (name === "content-length" ? "9999999" : null),
          },
          json,
        },
        context,
      ),
    );
    expect(res.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it("audits who sent in what, without the file's text", async () => {
    const { handlers, store } = setup();
    await fromMarkdown(handlers, MARKDOWN);
    await fromMarkdown(handlers, MARKDOWN);
    const rows = store.audits.filter(
      (row) => row.action === "content_draft_from_markdown",
    );
    expect(rows.map((row) => row.details)).toEqual([
      { origin: "vault", outcome: "created" },
      { origin: "vault", outcome: "skipped", code: "ALREADY_IMPORTED" },
    ]);
    expect(JSON.stringify(store.audits)).not.toContain("Body text.");
  });

  it("does not log or answer with the markdown when the store fails", async () => {
    const { handlers, store } = setup();
    store.createDoc.mockRejectedValueOnce(new Error("Body text. boom"));
    const logged = [];
    const spy = (...args) => logged.push(JSON.stringify(args));
    const res = parse(
      await handlers.createFromMarkdown(
        request({ body: { markdown: MARKDOWN, origin: "paste" } }),
        { log: spy, warn: spy, error: spy },
      ),
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("Body text.");
    expect(logged.join("")).not.toContain("Body text.");
  });

  it("ignores every front-matter key that is not one of the seven, so a file cannot set a workflow or identity field", async () => {
    const { handlers, store } = setup();
    const injected = [
      "contentStatus: published",
      "Live: true",
      "Status: Published",
      "id: attacker-chosen-id",
      "slug: attacker-slug",
      "Slug: attacker-slug",
      "partitionKey: other",
      "ownerId: someone-else",
      "createdBy: someone-else",
      "draftOrigin: repo-import",
      "kind: framework",
      "ideaOrigin: forge",
      "approvedForBlog: true",
      "publishedAt: 2020-01-01",
      "__proto__: polluted",
      "constructor: polluted",
    ].join("\n");
    const res = await fromMarkdown(
      handlers,
      MARKDOWN.replace("status: outlined", injected),
    );
    expect(res.status).toBe(201);
    const id = markdownDraftContentId("A draft from my vault");
    expect(res.body.contentId).toBe(id);
    expect([...store.docs.keys()]).toEqual([id]);
    const stored = store.docs.get(id);
    expect(stored).toMatchObject({
      id,
      Live: false,
      contentStatus: "drafting",
      Status: "Draft",
      approvedForBlog: false,
      draftOrigin: "vault",
      kind: "article",
      ideaOrigin: "manual",
      createdBy: "owner@hcw.dev",
    });
    for (const key of [
      "slug",
      "Slug",
      "partitionKey",
      "ownerId",
      "publishedAt",
      "polluted",
    ]) {
      expect(stored, key).not.toHaveProperty(key);
    }
    expect(JSON.stringify(stored)).not.toContain("attacker");
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect({}.polluted).toBeUndefined();
    expect(isPublicDocument(stored)).toBe(false);
  });

  describe("the request is counted as it is read", () => {
    const streamOf = (chunks, { onPull } = {}) => {
      let index = 0;
      let cancelled = false;
      const body = new ReadableStream({
        pull(controller) {
          onPull?.(index);
          if (index < chunks.length) controller.enqueue(chunks[index++]);
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      return { body, wasCancelled: () => cancelled, pulled: () => index };
    };
    const streamed = (stream, headers = {}) => ({
      params: {},
      headers: {
        get: (name) => headers[String(name).toLowerCase()] ?? null,
      },
      body: stream.body,
      json: vi.fn(async () => {
        throw new Error("json() must not be used when there is a stream");
      }),
    });
    const encode = (value) => new TextEncoder().encode(JSON.stringify(value));

    it("refuses an oversize body with no Content-Length (chunked), stops reading, and writes nothing", async () => {
      const { handlers, store } = setup();
      const chunk = new Uint8Array(64 * 1024).fill(32);
      const chunks = Array.from({ length: 200 }, () => chunk); // ~12.5 MB
      const stream = streamOf(chunks);
      const res = parse(
        await handlers.createFromMarkdown(streamed(stream), context),
      );
      expect(res).toMatchObject({ status: 413, body: { code: "TOO_LARGE" } });
      // Abandoned as soon as the limit was passed, not read to the end.
      expect(stream.wasCancelled()).toBe(true);
      expect(stream.pulled()).toBeLessThan(20);
      expect(store.createDoc).not.toHaveBeenCalled();
      expect(store.queryDocs).not.toHaveBeenCalled();
    });

    it("refuses a body bigger than the Content-Length it declares", async () => {
      const { handlers, store } = setup();
      const big = new Uint8Array(MAX_REQUEST_BYTES + 1).fill(32);
      const res = parse(
        await handlers.createFromMarkdown(
          streamed(streamOf([big]), { "content-length": "100" }),
          context,
        ),
      );
      expect(res.status).toBe(413);
      expect(store.createDoc).not.toHaveBeenCalled();
    });

    it("reads a body that arrives in pieces, and creates the draft", async () => {
      const { handlers, store } = setup();
      const bytes = encode({ markdown: MARKDOWN, origin: "vault" });
      const half = Math.floor(bytes.length / 2);
      const res = parse(
        await handlers.createFromMarkdown(
          streamed(streamOf([bytes.slice(0, half), bytes.slice(half)])),
          context,
        ),
      );
      expect(res.status).toBe(201);
      expect(store.docs.size).toBe(1);
    });

    it("reads a body that is exactly at the limit", async () => {
      const { handlers } = setup();
      const base = encode({ markdown: MARKDOWN, origin: "vault", pad: "" });
      const pad = " ".repeat(MAX_REQUEST_BYTES - base.length);
      const bytes = encode({ markdown: MARKDOWN, origin: "vault", pad });
      expect(bytes.length).toBe(MAX_REQUEST_BYTES);
      const res = parse(
        await handlers.createFromMarkdown(streamed(streamOf([bytes])), context),
      );
      expect(res.status).toBe(201);
    });

    it("answers a stream that is not JSON as a missing field (400), not a crash", async () => {
      const { handlers, store } = setup();
      const res = parse(
        await handlers.createFromMarkdown(
          streamed(streamOf([new TextEncoder().encode("{not json")])),
          context,
        ),
      );
      expect(res).toMatchObject({ status: 400, body: { code: "INVALID" } });
      expect(store.createDoc).not.toHaveBeenCalled();
    });
  });

  it("takes every sample draft through the route, once", async () => {
    const files = FIXTURE_NAMES.map(fixtureText);
    expect(files.length).toBeGreaterThan(0);
    const { handlers, store } = setup();
    for (const text of files) {
      const res = await fromMarkdown(handlers, text);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    expect(store.docs.size).toBe(files.length);
    for (const text of files) {
      expect((await fromMarkdown(handlers, text)).body.outcome).toBe("skipped");
    }
    expect(store.docs.size).toBe(files.length);
  });
});

describe("the sample drafts", () => {
  it.each(FIXTURE_NAMES)("%s parses into a draft", (name) => {
    const parsed = parseRepoDraft(fixtureText(name));
    expect(parsed.ok, parsed.error).toBe(true);
  });
});

describe("the typed routes' body bound and the audit's credential (review of #1478)", () => {
  it("refuses an oversize typed save by its declared size, before any read or write", async () => {
    const { handlers, store } = setup();
    const req = {
      ...request({ body: { fields: FIELDS } }),
      headers: {
        get: (name) =>
          name.toLowerCase() === "content-length" ? String(10 * 1024 * 1024) : "vitest",
      },
    };
    const res = parse(await handlers.create(req, context));
    expect(res).toMatchObject({ status: 413, body: { code: "TOO_LARGE" } });
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it("records the admin page's token as the credential of a transition, as before", async () => {
    const { handlers, store } = setup();
    const draft = await created(handlers);
    const res = parse(
      await handlers.sendToReview(
        request({ id: draft.id, body: { etag: draft.etag } }),
        context,
      ),
    );
    expect(res.status).toBe(200);
    const row = store.audits.find((a) => a.action === "status_transition");
    expect(row.metadata.authMethod).toBe("entra_bearer_token");
  });

  it("a failed counter update after a delete is logged without the id or the message", async () => {
    const { handlers, store, onContentDeleted } = setup();
    const draft = await created(handlers);
    onContentDeleted.mockRejectedValueOnce(
      Object.assign(new Error("Request rate is large: id secret-ish"), { code: 429 }),
    );
    const warn = vi.fn();
    const res = await handlers.remove(
      request({ id: draft.id, body: { etag: draft.etag } }),
      { ...context, warn },
    );
    expect(res.status).toBe(200);
    expect(store.docs.has(draft.id)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain(draft.id);
    expect(line).not.toContain("secret-ish");
    expect(line).toContain("429");
  });
});
