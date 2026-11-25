/**
 * "Where this came from" for content another admin Page sent into the
 * Pipeline (#1886). Pinned: only a Page on the list, only a record that
 * exists and is not deleted, only a part the record has; the stored shape;
 * the list filter; and that no later update can rewrite it.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ORIGIN_PAGES,
  ORIGIN_PAGE_IDS,
  OriginRefError,
  defaultIdeaOriginFor,
  originFilterClause,
  originRefOf,
  parseOriginRef,
  resolveOriginRef,
} from "./origin-ref.js";
import { FORBIDDEN_CONTENT_UPDATE_KEYS } from "../cms/content-update-validation.js";
import { DEFAULT_IDEA_ORIGINS } from "../cms/taxonomy.js";
import { isAuthoredError } from "../http/error-response.js";

const PROGRAM = Object.freeze({
  id: "program-gitkraken-ambassador",
  docType: "program",
  name: "GitKraken Ambassador",
  requirements: [{ id: "quarterly-content", label: "Two pieces a quarter" }],
});

const storeWith = (...docs) => ({
  readDoc: vi.fn(async (container, id) => {
    const doc = docs.find((d) => d.id === id && container === "ambassador");
    return doc ? structuredClone(doc) : null;
  }),
});

describe("parseOriginRef", () => {
  it("is null when the request names none", () => {
    expect(parseOriginRef(undefined)).toBeNull();
    expect(parseOriginRef(null)).toBeNull();
  });

  it("refuses a Page that is not on the list", () => {
    expect(() => parseOriginRef({ page: "cost", id: "x" })).toThrow(
      OriginRefError,
    );
  });

  it("refuses unknown keys, so a label cannot be supplied by the caller", () => {
    expect(() =>
      parseOriginRef({ page: "ambassador", id: PROGRAM.id, label: "Anything" }),
    ).toThrow(/Not an originRef field: label/);
  });

  it("refuses an id or part outside the id shape", () => {
    expect(() => parseOriginRef({ page: "ambassador", id: "a b" })).toThrow(
      OriginRefError,
    );
    expect(() =>
      parseOriginRef({ page: "ambassador", id: PROGRAM.id, part: "x/y" }),
    ).toThrow(OriginRefError);
  });

  it("reads an empty part as none", () => {
    expect(
      parseOriginRef({ page: "ambassador", id: PROGRAM.id, part: "" }),
    ).toEqual({
      page: "ambassador",
      id: PROGRAM.id,
      part: null,
    });
  });

  it("throws an authored error, so the route answers 400 with the sentence", () => {
    try {
      parseOriginRef("ambassador");
    } catch (error) {
      expect(isAuthoredError(error)).toBe(true);
      return;
    }
    throw new Error("expected a refusal");
  });
});

describe("resolveOriginRef: the Ambassador entry", () => {
  it("returns the stored shape with the program's name as the label", async () => {
    const ref = await resolveOriginRef(storeWith(PROGRAM), {
      page: "ambassador",
      id: PROGRAM.id,
      part: "quarterly-content",
    });
    expect(ref).toEqual({
      page: "ambassador",
      id: PROGRAM.id,
      part: "quarterly-content",
      label: "GitKraken Ambassador",
    });
  });

  it("reads the record from the Page's own container, by id", async () => {
    const store = storeWith(PROGRAM);
    await resolveOriginRef(store, { page: "ambassador", id: PROGRAM.id });
    expect(store.readDoc).toHaveBeenCalledWith(
      "ambassador",
      PROGRAM.id,
      PROGRAM.id,
    );
  });

  it("refuses a program that does not exist", async () => {
    await expect(
      resolveOriginRef(storeWith(), { page: "ambassador", id: PROGRAM.id }),
    ).rejects.toThrow("No Ambassador program has that id.");
  });

  it("refuses a deleted program and a record of another kind", async () => {
    const deleted = { ...PROGRAM, softDeletedAt: "2026-11-01T00:00:00.000Z" };
    await expect(
      resolveOriginRef(storeWith(deleted), {
        page: "ambassador",
        id: PROGRAM.id,
      }),
    ).rejects.toThrow(OriginRefError);
    const application = { ...PROGRAM, docType: "application" };
    await expect(
      resolveOriginRef(storeWith(application), {
        page: "ambassador",
        id: PROGRAM.id,
      }),
    ).rejects.toThrow(OriginRefError);
  });

  it("refuses a requirement the program does not have", async () => {
    await expect(
      resolveOriginRef(storeWith(PROGRAM), {
        page: "ambassador",
        id: PROGRAM.id,
        part: "no-such-requirement",
      }),
    ).rejects.toThrow(/no requirement/);
  });

  it("reads nothing when the request names no reference", async () => {
    const store = storeWith(PROGRAM);
    expect(await resolveOriginRef(store, undefined)).toBeNull();
    expect(store.readDoc).not.toHaveBeenCalled();
  });
});

describe("every Page on the list", () => {
  it("names an idea origin the taxonomy ships", () => {
    const shipped = new Set(
      DEFAULT_IDEA_ORIGINS.map((entry) => entry.id ?? entry),
    );
    for (const id of ORIGIN_PAGE_IDS) {
      expect(shipped.has(ORIGIN_PAGES[id].ideaOrigin), id).toBe(true);
      expect(defaultIdeaOriginFor({ page: id })).toBe(
        ORIGIN_PAGES[id].ideaOrigin,
      );
    }
  });

  it("refuses a missing record (check(null) is a refusal)", () => {
    for (const id of ORIGIN_PAGE_IDS) {
      expect(ORIGIN_PAGES[id].check(null, null).refusal, id).toBeTruthy();
    }
  });
});

describe("originRefOf", () => {
  it("is null for a document without one", () => {
    expect(originRefOf({})).toBeNull();
    expect(originRefOf({ originRef: "ambassador" })).toBeNull();
  });

  it("falls back to the id when the stored label is empty", () => {
    expect(
      originRefOf({ originRef: { page: "ambassador", id: "p1", label: "" } }),
    ).toEqual({
      page: "ambassador",
      id: "p1",
      part: null,
      label: "p1",
    });
  });
});

describe("originFilterClause", () => {
  it("adds nothing when the list names no Page", () => {
    const parameters = [];
    expect(originFilterClause("", "", parameters)).toEqual({ clause: null });
    expect(parameters).toEqual([]);
  });

  it("matches one Page, or one record on it, by parameter", () => {
    const parameters = [];
    const { clause } = originFilterClause("ambassador", PROGRAM.id, parameters);
    expect(clause).toBe(
      "(c.originRef.page = @originPage AND c.originRef.id = @originId)",
    );
    expect(parameters).toEqual([
      { name: "@originPage", value: "ambassador" },
      { name: "@originId", value: PROGRAM.id },
    ]);
  });

  it("refuses a Page not on the list and a malformed id", () => {
    expect(originFilterClause("cost", "", []).error).toMatch(/originPage/);
    expect(originFilterClause("ambassador", "a'b", []).error).toMatch(
      /originId/,
    );
  });
});

describe("after the create", () => {
  it("no update can rewrite where a piece came from", () => {
    expect(FORBIDDEN_CONTENT_UPDATE_KEYS.has("originRef")).toBe(true);
  });
});
