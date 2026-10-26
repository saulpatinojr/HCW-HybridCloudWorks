/**
 * The pure half of "Paste or upload a markdown draft" (drafts-markdown.js):
 * the request, the file read by the docs/content parser, and the title-derived
 * document id. The route itself is in drafts-handlers.test.js.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  MARKDOWN_ORIGINS,
  MAX_MARKDOWN_BYTES,
  MAX_REQUEST_BYTES,
  MarkdownRequestError,
  isMarkdownTooLarge,
  markdownDraftContentId,
  parseMarkdownDraft,
  readMarkdownRequest,
} from "./drafts-markdown.js";
import {
  DRAFT_ORIGINS,
  MAX_DRAFT_BODY_BYTES,
  buildNewDraftDocument,
  validateDraftFields,
} from "./drafts.js";
import { checkRepoDraftPath, repoDraftContentId } from "./repo-draft.js";

const FILE = "---\ntitle: T\ntags: [a, b]\n---\n\nBody\n";

describe("the draft origins", () => {
  it("add vault and paste beside the two that exist, with the old values unchanged", () => {
    expect(DRAFT_ORIGINS).toEqual({
      site: "drafts",
      repo: "repo-import",
      vault: "vault",
      paste: "paste",
    });
    expect(MARKDOWN_ORIGINS).toEqual({ vault: "vault", paste: "paste" });
  });

  it("buildNewDraftDocument stores the origin it is given, and 'drafts' by default", () => {
    const fields = validateDraftFields({ title: "T", body: "b" });
    const make = (origin) =>
      buildNewDraftDocument({ id: "x", fields, editor: "e", origin });
    expect(make(undefined).draftOrigin).toBe("drafts");
    expect(make("vault").draftOrigin).toBe("vault");
    expect(make("paste")).toMatchObject({
      draftOrigin: "paste",
      contentStatus: "drafting",
      Live: false,
    });
  });
});

describe("readMarkdownRequest", () => {
  it("maps the request's origin to the stored draftOrigin", () => {
    expect(readMarkdownRequest({ markdown: FILE, origin: "vault" })).toEqual({
      markdown: FILE,
      draftOrigin: "vault",
    });
    expect(
      readMarkdownRequest({ markdown: FILE, origin: "paste" }).draftOrigin,
    ).toBe("paste");
  });

  it.each([
    [null],
    [undefined],
    ["text"],
    [{}],
    [{ markdown: FILE }],
    [{ markdown: FILE, origin: "repo-import" }],
    [{ markdown: FILE, origin: "constructor" }],
    [{ markdown: "", origin: "paste" }],
    [{ markdown: 5, origin: "paste" }],
  ])("refuses %j with an authored sentence", (body) => {
    expect(() => readMarkdownRequest(body)).toThrow(MarkdownRequestError);
  });
});

describe("the size caps", () => {
  it("allow the 256 KB body plus room for front matter, in bytes", () => {
    expect(MAX_MARKDOWN_BYTES).toBeGreaterThan(MAX_DRAFT_BODY_BYTES);
    expect(isMarkdownTooLarge("a".repeat(MAX_MARKDOWN_BYTES))).toBe(false);
    expect(isMarkdownTooLarge("a".repeat(MAX_MARKDOWN_BYTES + 1))).toBe(true);
    // Two bytes a character: 3/4 of the character count would be under.
    expect(isMarkdownTooLarge("é".repeat(MAX_MARKDOWN_BYTES / 2 + 1))).toBe(
      true,
    );
    expect(MAX_REQUEST_BYTES).toBeGreaterThan(MAX_MARKDOWN_BYTES * 2);
  });
});

describe("parseMarkdownDraft", () => {
  it("reads the file with the docs/content parser into fields validateDraftFields accepts", () => {
    const parsed = parseMarkdownDraft(
      "---\ntitle: 'A title'\nsubtitle: Sub\ndate: 2026-10-01\ntrack: how-to\npart: 1 of 2\ntags: [azure, terraform]\nreading: 5\ntype: blog\n---\n\n## Hi\n",
    );
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.fields).sort()).toEqual([
      "body",
      "date",
      "part",
      "reading",
      "subtitle",
      "tags",
      "title",
      "track",
    ]);
    expect(validateDraftFields(parsed.fields)).toMatchObject({
      title: "A title",
      date: "2026-10-01",
      tags: ["azure", "terraform"],
      reading: 5,
      body: "## Hi",
    });
  });

  it("copes with Windows line endings and a byte-order mark, as a file from a Windows vault has", () => {
    const parsed = parseMarkdownDraft("﻿---\r\ntitle: Win\r\n---\r\n\r\nBody\r\n");
    expect(parsed).toMatchObject({ ok: true, fields: { title: "Win", body: "Body" } });
  });

  it("passes the parser's refusals through with their codes", () => {
    expect(parseMarkdownDraft("no block")).toMatchObject({
      ok: false,
      code: "NO_FRONT_MATTER",
    });
    expect(parseMarkdownDraft("---\ntitle: T\n---\n")).toMatchObject({
      ok: false,
      code: "EMPTY_BODY",
    });
  });

  it("does not need, and so does not weaken, the repository path checks", () => {
    expect(checkRepoDraftPath("../../etc/passwd").ok).toBe(false);
    expect(checkRepoDraftPath("docs/content/blog-template.md").ok).toBe(false);
    expect(checkRepoDraftPath("docs/content/blog-ok.md").ok).toBe(true);
  });

  it("warns about what it ignored", () => {
    const parsed = parseMarkdownDraft(
      "---\ntitle: T\ndate: soon\nreading: lots\n---\n\nBody\n",
    );
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.fields.date).toBeNull();
  });
});

describe("markdownDraftContentId", () => {
  it("is a UUID, the same for the same article however its title is cased or punctuated", () => {
    const id = markdownDraftContentId("Landing Zones: First Steps");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(markdownDraftContentId("landing zones - first steps!")).toBe(id);
    expect(markdownDraftContentId("Landing Zönes: First Steps")).toBe(id);
  });

  it("differs for another title, and from the id a repository path would have", () => {
    const id = markdownDraftContentId("One title");
    expect(markdownDraftContentId("Another title")).not.toBe(id);
    expect(id).not.toBe(repoDraftContentId("docs/content/blog-one-title.md"));
  });

  it("is null when the title has nothing to tell it apart by", () => {
    expect(markdownDraftContentId("!!!")).toBeNull();
    expect(markdownDraftContentId("")).toBeNull();
  });

  it("is stable: the namespace and recipe must not change (a change would duplicate every draft already sent in)", () => {
    expect(markdownDraftContentId("Pinned title")).toBe(
      "cf2fc369-461c-578f-bb74-4625dfe35260",
    );
  });
});

describe("every sample draft", () => {
  const dir = new URL("./__fixtures__/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".txt"));

  it("finds the fixtures", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s passes the same checks a typed draft does", (name) => {
    const parsed = parseMarkdownDraft(readFileSync(new URL(name, dir), "utf8"));
    expect(parsed.ok, parsed.error).toBe(true);
    expect(() => validateDraftFields(parsed.fields)).not.toThrow();
  });
});
