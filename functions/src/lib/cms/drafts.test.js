/**
 * The Drafts stage's pure half (drafts.js): what a draft may contain, the
 * document at each step, the transitions, and — the claim the owner made a
 * condition — that no draft can reach a public read.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DRAFTS_STAGE_STATUS,
  DRAFT_FIELDS,
  DRAFT_INVARIANTS,
  DraftInputError,
  MAX_DRAFT_BODY_BYTES,
  allowedActions,
  asImportedDraft,
  backToDraftsRefusal,
  buildBackToDraftsPatch,
  buildDraftUpdate,
  buildNewDraftDocument,
  buildSendToReviewPatch,
  comesFromDrafts,
  deleteRefusal,
  isAllowedEdge,
  saveRefusal,
  sendToReviewRefusal,
  stageOf,
  toDraftSummary,
  toDraftView,
  validateDraftFields,
} from "./drafts.js";
import {
  DRAFTS_ONLY_STATUSES,
  VALID_TRANSITIONS,
  canPublishFromStatus,
} from "./content-status.js";
import { buildRepoDraftData, parseRepoDraft } from "./repo-draft.js";
import { MAX_DRAFT_BYTES } from "./repo-draft-source.js";
import { FORBIDDEN_CONTENT_UPDATE_KEYS } from "./content-update-validation.js";
import {
  NEVER_PUBLIC_STATUSES,
  SQL_PUBLIC_CLAUSE,
  isPublicDocument,
} from "../public-reads.js";
import { PUBLISHED_PREDICATE } from "../public-content-manifest.js";
import { evaluatePredicate } from "../../../test/cosmos-predicate.js";
import { PREVIEWABLE_STATUSES } from "../public-preview.js";
import { classifyContentBucket } from "../triggers/dashboard-stats.js";
import {
  matchesQueueStatus,
  summarizeDashboardItems,
} from "../admin-snapshots.js";

const NOW = () => new Date("2026-10-03T12:00:00.000Z");
const EDITOR = "owner@hcw.dev";
// A synthetic fixture written to the blog template, not a real article: the
// real drafts do not live in this public repository.
const SAMPLE_01 = "docs/content/blog-sample-01-first-part.md";
const readRepoFile = (path) =>
  readFileSync(
    new URL(`./__fixtures__/${path.split("/").at(-1)}`, import.meta.url),
    "utf8",
  );

const FIELDS = Object.freeze({
  title: "One container, three clouds",
  subtitle: "What the lab image carries and why.",
  date: "2026-10-01",
  track: "how-to",
  part: "1 of 2",
  tags: ["azure", "docker"],
  reading: 7,
  body: "## Start\n\nText.\n\n## TL;DR\n\nShort.\n\n## End\n\nMore.",
});

const newDraft = (fields = FIELDS) =>
  buildNewDraftDocument({
    id: "d1",
    fields: validateDraftFields(fields),
    editor: EDITOR,
    now: NOW,
  });

/** Apply a patch the way patchDoc does: `undefined` deletes. */
const applied = (doc, patch) => {
  const next = { ...doc };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
};

// ── input ──────────────────────────────────────────────────────────────────

describe("validateDraftFields — an allow-list of the editor fields", () => {
  it("normalises a full payload", () => {
    expect(
      validateDraftFields({
        ...FIELDS,
        title: "  Spaced  ",
        tags: "azure, docker, azure",
      }),
    ).toEqual({
      ...FIELDS,
      title: "Spaced",
      tags: ["azure", "docker"],
      kind: null,
      ideaOrigin: null,
    });
  });

  it("stores empty optional fields as empty, not as strings of nothing", () => {
    expect(validateDraftFields({ title: "T" })).toEqual({
      title: "T",
      subtitle: "",
      date: null,
      track: null,
      part: null,
      tags: [],
      reading: null,
      body: "",
      kind: null,
      ideaOrigin: null,
    });
  });

  it("carries the two taxonomy ids, lower-cased, and refuses a non-id (ADR 0033 §4)", () => {
    expect(
      validateDraftFields({
        title: "T",
        kind: " Tutorial ",
        ideaOrigin: "content-gap",
      }),
    ).toMatchObject({ kind: "tutorial", ideaOrigin: "content-gap" });
    expect(() =>
      validateDraftFields({ title: "T", kind: "Not An Id!" }),
    ).toThrow(/taxonomy id/);
    expect(() => validateDraftFields({ title: "T", ideaOrigin: 42 })).toThrow(
      /must be a string/,
    );
  });

  it.each([
    ...[...FORBIDDEN_CONTENT_UPDATE_KEYS].map((key) => [key]),
    ["Live"],
    ["publishedAt"],
    ["Cloud Provider"],
    ["id"],
  ])("refuses %s, because it is not an editor field", (key) => {
    expect(() => validateDraftFields({ title: "T", [key]: "x" })).toThrow(
      DraftInputError,
    );
    expect(() => validateDraftFields({ title: "T", [key]: "x" })).toThrow(
      /Not a draft field/,
    );
  });

  it("names exactly the editor fields: the eight from the template plus kind and idea origin", () => {
    expect(DRAFT_FIELDS).toEqual([
      "title",
      "subtitle",
      "date",
      "track",
      "part",
      "tags",
      "reading",
      "body",
      "kind",
      "ideaOrigin",
    ]);
  });

  it.each([
    ["no title", { title: "  " }, /title is required/],
    ["a title too long", { title: "x".repeat(301) }, /title exceeds 300/],
    [
      "a subtitle too long",
      { title: "T", subtitle: "x".repeat(501) },
      /subtitle exceeds 500/,
    ],
    [
      "a date that is not one",
      { title: "T", date: "2026-02-30" },
      /YYYY-MM-DD/,
    ],
    [
      "a reading time that is not whole minutes",
      { title: "T", reading: 2.5 },
      /whole number/,
    ],
    ["a reading time of zero", { title: "T", reading: 0 }, /whole number/],
    [
      "thirteen tags",
      { title: "T", tags: Array.from({ length: 13 }, (_, i) => `t${i}`) },
      /exceeds 12/,
    ],
    ["a tag too long", { title: "T", tags: ["x".repeat(41)] }, /exceeds 40/],
    [
      "a body that is not text",
      { title: "T", body: 42 },
      /body must be a string/,
    ],
    ["a title that is not text", { title: ["T"] }, /title must be a string/],
    ["no object at all", null, /JSON object/],
  ])("refuses %s", (_label, input, message) => {
    expect(() => validateDraftFields(input)).toThrow(message);
  });

  it("caps the body in UTF-8 bytes, at the cap the repository fetch uses", () => {
    expect(MAX_DRAFT_BODY_BYTES).toBe(MAX_DRAFT_BYTES);
    const atCap = "a".repeat(MAX_DRAFT_BODY_BYTES);
    expect(validateDraftFields({ title: "T", body: atCap }).body).toHaveLength(
      MAX_DRAFT_BODY_BYTES,
    );
    // Half as many characters, each two bytes, one over.
    const multiByte = "é".repeat(MAX_DRAFT_BODY_BYTES / 2) + "a";
    expect(() => validateDraftFields({ title: "T", body: multiByte })).toThrow(
      /bytes; at most/,
    );
  });

  it("keeps the body exactly as written — no trim, no TL;DR move — until it is sent to review", () => {
    const body = "\n\n## TL;DR\n\nfirst\n\n## Next\n\n";
    expect(validateDraftFields({ title: "T", body }).body).toBe(body);
  });
});

// ── the documents ──────────────────────────────────────────────────────────

describe("buildNewDraftDocument", () => {
  it("is a draft, not Live, not inspected, with the editor fields in the import’s names", () => {
    const doc = newDraft();
    expect(doc).toMatchObject({
      id: "d1",
      contentStatus: DRAFTS_STAGE_STATUS,
      Live: false,
      Status: "Draft",
      inspectTrigger: false,
      draftOrigin: "drafts",
      Title: FIELDS.title,
      title: FIELDS.title,
      Summary: FIELDS.subtitle,
      Content: FIELDS.body,
      postContent: FIELDS.body,
      Tags: FIELDS.tags,
      keyTopics: FIELDS.tags,
      readTime: "7 min",
      frontMatter: {
        date: "2026-10-01",
        track: "how-to",
        part: "1 of 2",
        reading: 7,
      },
      createdBy: EDITOR,
      "Created At": "2026-10-03T12:00:00.000Z",
    });
  });

  it("holds no slug, no dedup title and no provider until it is sent to review", () => {
    const doc = newDraft();
    for (const key of [
      "slug",
      "Slug",
      "normalizedTitle",
      "Cloud Provider",
      "cloudProvider",
      "publishedAt",
    ]) {
      expect(doc, key).not.toHaveProperty(key);
    }
  });

  it("stores no reading time when none is given", () => {
    expect(newDraft({ title: "T" })).not.toHaveProperty("readTime");
  });

  it("is an article, manually entered, unless the owner says otherwise (ADR 0033 §4)", () => {
    expect(newDraft({ title: "T" })).toMatchObject({
      kind: "article",
      ideaOrigin: "manual",
    });
    expect(
      newDraft({
        title: "T",
        kind: "tutorial",
        ideaOrigin: "audience-question",
      }),
    ).toMatchObject({
      kind: "tutorial",
      ideaOrigin: "audience-question",
    });
    // The view resolves them, so the page's picker shows what is stored.
    expect(toDraftView(newDraft({ title: "T" })).fields).toMatchObject({
      kind: "article",
      ideaOrigin: "manual",
    });
    expect(toDraftSummary(newDraft({ title: "T" }))).toMatchObject({
      kind: "article",
      ideaOrigin: "manual",
    });
  });
});

describe("asImportedDraft — a docs/content file in the Drafts stage", () => {
  const parsed = parseRepoDraft(readRepoFile(SAMPLE_01));
  const source = {
    commitSha: "a".repeat(40),
    rawUrl: "https://raw.githubusercontent.com/x",
    contentSha256: "b".repeat(64),
  };
  const doc = asImportedDraft(
    buildRepoDraftData({
      path: SAMPLE_01,
      draft: parsed.draft,
      source,
      editor: EDITOR,
      now: NOW,
    }),
    { id: "imported", editor: EDITOR, now: NOW },
  );

  it("is a draft, whatever the repository builder says the review state is", () => {
    expect(doc).toMatchObject({
      ...DRAFT_INVARIANTS,
      id: "imported",
      draftOrigin: "repo-import",
    });
  });

  it("keeps the repository provenance, which is how a second import finds it", () => {
    expect(doc).toMatchObject({
      repoPath: SAMPLE_01,
      repoCommitSha: "a".repeat(40),
      source: "repo",
    });
  });

  it("opens in the editor with the front matter it was imported with", () => {
    const view = toDraftView(doc);
    expect(view.fields).toMatchObject({
      title: parsed.draft.title,
      subtitle: parsed.draft.subtitle,
      tags: parsed.draft.tags,
      reading: parsed.draft.reading,
    });
    expect(view.fields.body).toBe(parsed.draft.body.trim());
    expect(view.stage).toBe("draft");
  });
});

describe("buildDraftUpdate", () => {
  it("rewrites the editor fields and nothing that moves the document", () => {
    const update = buildDraftUpdate(
      validateDraftFields({ ...FIELDS, reading: null }),
      {
        current: newDraft(),
        editor: EDITOR,
        now: NOW,
      },
    );
    for (const key of [
      "contentStatus",
      "Status",
      "Live",
      "slug",
      "Slug",
      "publishedAt",
      "approvedForBlog",
    ]) {
      expect(update, key).not.toHaveProperty(key);
    }
    expect(update).toHaveProperty("readTime", undefined); // a deletion, patchDoc's convention
    expect(update.updatedBy).toBe(EDITOR);
  });

  it("writes blogDraft only when the document already carries one", () => {
    const fields = validateDraftFields(FIELDS);
    expect(
      buildDraftUpdate(fields, { current: {}, editor: EDITOR, now: NOW }),
    ).not.toHaveProperty("blogDraft");
    expect(
      buildDraftUpdate(fields, {
        current: { blogDraft: "old" },
        editor: EDITOR,
        now: NOW,
      }).blogDraft,
    ).toBe(FIELDS.body);
  });
});

// ── the state machine ──────────────────────────────────────────────────────

describe("the Drafts stage in the transition table", () => {
  it("drafting goes to in_review and nowhere else", () => {
    expect(VALID_TRANSITIONS[DRAFTS_STAGE_STATUS]).toEqual(["in_review"]);
    for (const target of [
      "approved",
      "published",
      "forge_ready",
      "editing",
      "rejected",
    ]) {
      expect(isAllowedEdge(DRAFTS_STAGE_STATUS, target), target).toBe(false);
    }
  });

  it("in_review may come back to drafting, and keeps its old edges", () => {
    expect(VALID_TRANSITIONS.in_review).toEqual([
      "approved",
      "published",
      "rejected",
      "drafting",
    ]);
  });

  it("nothing else enters drafting", () => {
    const into = Object.entries(VALID_TRANSITIONS)
      .filter(([, targets]) => targets.includes(DRAFTS_STAGE_STATUS))
      .map(([from]) => from);
    expect(into).toEqual(["in_review"]);
  });

  it("is not the forge’s `draft`, and cannot be published from", () => {
    expect(DRAFTS_STAGE_STATUS).not.toBe("draft");
    expect(canPublishFromStatus(DRAFTS_STAGE_STATUS)).toBe(false);
    expect(DRAFTS_ONLY_STATUSES).toEqual([DRAFTS_STAGE_STATUS]);
  });
});

describe("where a document is, and what may be done to it", () => {
  const docs = {
    draft: { id: "a", contentStatus: "drafting", Live: false },
    reviewFromDrafts: {
      id: "b",
      contentStatus: "in_review",
      Live: false,
      draftOrigin: "drafts",
    },
    reviewFromRepo: {
      id: "c",
      contentStatus: "in_review",
      Live: false,
      repoPath: SAMPLE_01,
    },
    reviewFromForge: { id: "d", contentStatus: "in_review", Live: false },
    approved: {
      id: "e",
      contentStatus: "approved",
      Live: false,
      draftOrigin: "drafts",
    },
    live: {
      id: "f",
      contentStatus: "published",
      Live: true,
      draftOrigin: "drafts",
    },
    liveInReview: {
      id: "g",
      contentStatus: "in_review",
      Live: true,
      repoPath: SAMPLE_01,
    },
  };

  it.each([
    [
      "draft",
      "draft",
      {
        edit: true,
        save: true,
        sendToReview: true,
        backToDrafts: false,
        delete: true,
      },
    ],
    [
      "reviewFromDrafts",
      "in_review",
      {
        edit: false,
        save: false,
        sendToReview: false,
        backToDrafts: true,
        delete: true,
      },
    ],
    [
      "reviewFromRepo",
      "in_review",
      {
        edit: false,
        save: false,
        sendToReview: false,
        backToDrafts: true,
        delete: true,
      },
    ],
    [
      "reviewFromForge",
      "in_review",
      {
        edit: false,
        save: false,
        sendToReview: false,
        backToDrafts: false,
        delete: false,
      },
    ],
    [
      "approved",
      "past_review",
      {
        edit: false,
        save: false,
        sendToReview: false,
        backToDrafts: false,
        delete: false,
      },
    ],
    [
      "live",
      "live",
      {
        edit: false,
        save: false,
        sendToReview: false,
        backToDrafts: false,
        delete: false,
      },
    ],
    [
      "liveInReview",
      "live",
      {
        edit: false,
        save: false,
        sendToReview: false,
        backToDrafts: false,
        delete: false,
      },
    ],
  ])("%s is %s", (name, stage, actions) => {
    expect(stageOf(docs[name])).toBe(stage);
    expect(allowedActions(docs[name])).toEqual(actions);
  });

  it("recognises the two Docker drafts the original import put In Review by repoPath", () => {
    expect(comesFromDrafts(docs.reviewFromRepo)).toBe(true);
    expect(comesFromDrafts(docs.reviewFromForge)).toBe(false);
  });

  describe("delete", () => {
    it("removes a draft, and an article from Drafts still In Review (one document: both go)", () => {
      expect(deleteRefusal(docs.draft)).toBeNull();
      expect(deleteRefusal(docs.reviewFromDrafts)).toBeNull();
      expect(deleteRefusal(docs.reviewFromRepo)).toBeNull();
    });

    it("refuses anything live, with a message that says so", () => {
      for (const doc of [docs.live, docs.liveInReview]) {
        expect(deleteRefusal(doc)).toMatchObject({ status: 409, code: "LIVE" });
        expect(deleteRefusal(doc).error).toMatch(
          /live on the site.*nothing was changed/,
        );
      }
    });

    it("refuses an article past review, and one that never came from Drafts", () => {
      expect(deleteRefusal(docs.approved)).toMatchObject({
        status: 409,
        code: "PAST_REVIEW",
      });
      expect(deleteRefusal(docs.reviewFromForge)).toMatchObject({
        status: 409,
        code: "NOT_A_DRAFT",
      });
    });
  });

  it("saves only a draft", () => {
    expect(saveRefusal(docs.draft)).toBeNull();
    expect(saveRefusal(docs.reviewFromDrafts)).toMatchObject({
      code: "IN_REVIEW",
    });
    expect(saveRefusal(docs.live)).toMatchObject({ code: "LIVE" });
    expect(saveRefusal(docs.approved)).toMatchObject({ code: "PAST_REVIEW" });
  });

  it("sends only a titled draft with a body", () => {
    expect(
      sendToReviewRefusal({ ...docs.draft, Title: "T", postContent: "Body" }),
    ).toBeNull();
    expect(
      sendToReviewRefusal({ ...docs.draft, Title: " ", postContent: "Body" }),
    ).toMatchObject({
      status: 422,
      code: "NO_TITLE",
    });
    expect(
      sendToReviewRefusal({ ...docs.draft, Title: "T", postContent: "  " }),
    ).toMatchObject({
      status: 422,
      code: "EMPTY_BODY",
    });
    expect(sendToReviewRefusal(docs.reviewFromDrafts)).toMatchObject({
      status: 409,
      code: "IN_REVIEW",
    });
    expect(sendToReviewRefusal(docs.live)).toMatchObject({ code: "LIVE" });
  });

  it("brings back only an article from Drafts that is still In Review", () => {
    expect(backToDraftsRefusal(docs.reviewFromDrafts)).toBeNull();
    expect(backToDraftsRefusal(docs.reviewFromRepo)).toBeNull();
    expect(backToDraftsRefusal(docs.reviewFromForge)).toMatchObject({
      code: "NOT_A_DRAFT",
    });
    expect(backToDraftsRefusal(docs.approved)).toMatchObject({
      code: "PAST_REVIEW",
    });
    expect(backToDraftsRefusal(docs.live)).toMatchObject({ code: "LIVE" });
    expect(backToDraftsRefusal(docs.draft)).toMatchObject({
      code: "ALREADY_DRAFT",
    });
  });
});

describe("buildSendToReviewPatch — the end state the repository import produced", () => {
  const patch = buildSendToReviewPatch(newDraft(), {
    editor: EDITOR,
    now: NOW,
  });

  it("is in_review and not Live", () => {
    expect(patch).toMatchObject({
      contentStatus: "in_review",
      Live: false,
      Status: "Draft",
    });
  });

  it("normalises the body once, here, as createContentDocument does for every writer", () => {
    expect(patch.content).toBe(
      "## Start\n\nText.\n\n## End\n\nMore.\n\n## TL;DR\n\nShort.",
    );
    expect(patch.Content).toBe(patch.content);
    expect(patch.postContent).toBe(patch.content);
  });

  it("stamps the dedup title and the quality and image reports", () => {
    expect(patch.normalizedTitle).toBe("one container three clouds");
    expect(patch.contentQuality).toEqual(
      expect.objectContaining({ ready: expect.any(Boolean) }),
    );
    expect(patch.imageReadiness).toBe(patch.imageQuality);
    expect(patch.imageLineage).toBeDefined();
  });

  it("fills the provider from the tags, and never overwrites one already set", () => {
    expect(patch["Cloud Provider"]).toBe("Azure");
    const kept = buildSendToReviewPatch(
      { ...newDraft(), "Cloud Provider": "Aws" },
      { editor: EDITOR, now: NOW },
    );
    expect(kept).not.toHaveProperty("Cloud Provider");
  });

  it("sets nothing a publish owns", () => {
    for (const key of [
      "slug",
      "Slug",
      "publishedAt",
      "Published At",
      "publishedDate",
      "approvedForBlog",
    ]) {
      expect(patch, key).not.toHaveProperty(key);
    }
  });

  it("and Back to Drafts is the status and stamps only", () => {
    expect(buildBackToDraftsPatch({ editor: EDITOR, now: NOW })).toEqual({
      contentStatus: DRAFTS_STAGE_STATUS,
      Live: false,
      returnedToDraftsAt: "2026-10-03T12:00:00.000Z",
      returnedToDraftsBy: EDITOR,
      updatedAt: "2026-10-03T12:00:00.000Z",
      updatedBy: EDITOR,
    });
  });
});

describe("toDraftSummary", () => {
  it("carries the etag the page sends back, and no body", () => {
    const summary = toDraftSummary({ ...newDraft(), _etag: '"e1"' });
    expect(summary).toMatchObject({
      id: "d1",
      etag: '"e1"',
      stage: "draft",
      origin: "drafts",
    });
    expect(summary).not.toHaveProperty("fields");
    expect(JSON.stringify(summary)).not.toContain("Text.");
  });
});

// ── never public ───────────────────────────────────────────────────────────

// evaluatePredicate (test/cosmos-predicate.js) runs the SQL a public read
// runs, as written, against a document, and throws on any form it does not
// understand, so a predicate that grows a new form fails this test rather
// than being skipped by it.

describe("a draft never reaches a public read", () => {
  const imported = asImportedDraft(
    buildRepoDraftData({
      path: SAMPLE_01,
      draft: parseRepoDraft(readRepoFile(SAMPLE_01)).draft,
      source: {
        commitSha: null,
        rawUrl: "https://raw.githubusercontent.com/x",
        contentSha256: "c",
      },
      editor: EDITOR,
      now: NOW,
    }),
    { id: "i1", editor: EDITOR, now: NOW },
  );
  const created = newDraft();
  const saved = applied(
    created,
    buildDraftUpdate(validateDraftFields(FIELDS), {
      current: created,
      editor: EDITOR,
      now: NOW,
    }),
  );
  const returned = applied(
    {
      ...created,
      ...buildSendToReviewPatch(created, { editor: EDITOR, now: NOW }),
    },
    buildBackToDraftsPatch({ editor: EDITOR, now: NOW }),
  );
  const DRAFTS = { created, saved, imported, returned };

  it.each(Object.keys(DRAFTS))(
    "the %s draft fails isPublicDocument",
    (name) => {
      expect(isPublicDocument(DRAFTS[name])).toBe(false);
    },
  );

  it.each(Object.keys(DRAFTS))(
    "the %s draft matches neither the list query nor the manifest/pre-render query",
    (name) => {
      expect(evaluatePredicate(SQL_PUBLIC_CLAUSE, DRAFTS[name])).toBe(false);
      expect(evaluatePredicate(PUBLISHED_PREDICATE, DRAFTS[name])).toBe(false);
    },
  );

  it("the evaluator is not vacuous: a published article passes both", () => {
    const published = {
      contentStatus: "published",
      Live: true,
      Status: "Live",
    };
    expect(evaluatePredicate(SQL_PUBLIC_CLAUSE, published)).toBe(true);
    expect(evaluatePredicate(PUBLISHED_PREDICATE, published)).toBe(true);
    expect(isPublicDocument(published)).toBe(true);
  });

  it("drafting is refused by isPublicDocument even if Live or Status were somehow set", () => {
    expect(NEVER_PUBLIC_STATUSES.has(DRAFTS_STAGE_STATUS)).toBe(true);
    expect(
      isPublicDocument({
        contentStatus: DRAFTS_STAGE_STATUS,
        Live: true,
        Status: "Live",
      }),
    ).toBe(false);
  });

  it("is not previewable through the signed staging link", () => {
    expect(PREVIEWABLE_STATUSES.has(DRAFTS_STAGE_STATUS)).toBe(false);
  });

  it("is in no Content Queue filter and on no dashboard counter", () => {
    for (const filter of [
      "needs_review",
      "in_progress",
      "in_review",
      "ready_to_publish",
      "published_live",
    ]) {
      expect(matchesQueueStatus(created, filter), filter).toBe(false);
    }
    expect(classifyContentBucket(created)).toBeNull();
    expect(summarizeDashboardItems([created]).blog).toEqual({
      needsReview: 0,
      inProgress: 0,
      published: 0,
      total: 0,
    });
  });
});
