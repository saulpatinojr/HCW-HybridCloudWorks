/**
 * kind / ideaOrigin on a content record (ADR 0033 §4): checked against the
 * stored taxonomy, with the one asymmetry — a disabled id survives on a
 * record that already carries it, and is refused everywhere else.
 */
import { describe, it, expect, vi } from "vitest";
import {
  TaxonomyFieldError,
  derivedKindTypes,
  derivedOriginSources,
  hasTaxonomyFields,
  validateTaxonomyFields,
  validateTaxonomyFieldsWithStore,
} from "./taxonomy-fields.js";
import { defaultTaxonomy } from "./taxonomy.js";

const taxonomy = {
  kinds: [
    { id: "article", label: "Article", enabled: true },
    { id: "tutorial", label: "Tutorial", enabled: false },
  ],
  ideaOrigins: [
    { id: "manual", label: "Manual", enabled: true },
    { id: "content-gap", label: "Content gap", enabled: true },
  ],
};

describe("validateTaxonomyFields", () => {
  it("returns only the fields present, lower-cased and trimmed", () => {
    expect(validateTaxonomyFields({ kind: " Article " }, taxonomy)).toEqual({
      kind: "article",
    });
    expect(validateTaxonomyFields({ Title: "x" }, taxonomy)).toEqual({});
    expect(validateTaxonomyFields({ kind: undefined }, taxonomy)).toEqual({});
  });

  it("a null or empty value clears the field, so derivation takes over", () => {
    expect(
      validateTaxonomyFields({ kind: null, ideaOrigin: "" }, taxonomy),
    ).toEqual({
      kind: null,
      ideaOrigin: null,
    });
  });

  it("refuses an unknown id, naming the enabled ones", () => {
    expect(() =>
      validateTaxonomyFields({ ideaOrigin: "rumour" }, taxonomy),
    ).toThrow(
      'ideaOrigin "rumour" is not a known idea origin; allowed: manual, content-gap',
    );
    try {
      validateTaxonomyFields({ kind: "haiku" }, taxonomy);
    } catch (error) {
      expect(error).toBeInstanceOf(TaxonomyFieldError);
      expect(error.status).toBe(400);
      expect(error.message).toBe(
        'kind "haiku" is not a known kind; allowed: article',
      );
    }
  });

  it("refuses a disabled id on a new record and on a move, keeps it on a record that has it", () => {
    expect(() =>
      validateTaxonomyFields({ kind: "tutorial" }, taxonomy),
    ).toThrow('kind "tutorial" is disabled; allowed: article');
    expect(() =>
      validateTaxonomyFields({ kind: "tutorial" }, taxonomy, {
        existing: { kind: "article" },
      }),
    ).toThrow(/disabled/);
    expect(
      validateTaxonomyFields({ kind: "tutorial" }, taxonomy, {
        existing: { kind: "tutorial" },
      }),
    ).toEqual({ kind: "tutorial" });
  });

  it("refuses a non-string", () => {
    expect(() => validateTaxonomyFields({ kind: 7 }, taxonomy)).toThrow(
      "kind must be a string id",
    );
  });
});

describe("validateTaxonomyFieldsWithStore", () => {
  it("reads the taxonomy only when a field is named, and falls back to the defaults", async () => {
    const store = { readDoc: vi.fn(async () => null) };
    expect(
      await validateTaxonomyFieldsWithStore(store, { Title: "x" }),
    ).toEqual({});
    expect(store.readDoc).not.toHaveBeenCalled();

    expect(
      await validateTaxonomyFieldsWithStore(store, { kind: "tutorial" }),
    ).toEqual({
      kind: "tutorial",
    });
    expect(store.readDoc).toHaveBeenCalledTimes(1);
    expect(hasTaxonomyFields({ ideaOrigin: "manual" })).toBe(true);
    expect(hasTaxonomyFields({ kind: undefined })).toBe(false);
  });
});

describe("the inverse of the read-time derivation, for the list filters", () => {
  it("names the types whose unclassified records show under each kind", () => {
    expect(derivedKindTypes("article")).toEqual(["blog", "news"]);
    expect(derivedKindTypes("reference-guide")).toEqual([
      "framework",
      "architecture",
    ]);
    expect(derivedKindTypes("tutorial")).toEqual(["coder_corner"]);
    expect(derivedKindTypes("interview")).toEqual(["interview"]);
    expect(derivedKindTypes("newsletter")).toEqual([]);
  });

  it("names the sources whose unclassified records show under each origin; only manual takes the unknown ones", () => {
    expect(derivedOriginSources("rss-feed")).toMatchObject({
      sources: ["rss"],
      includesUnknownSource: false,
    });
    expect(derivedOriginSources("manual")).toMatchObject({
      sources: ["drafts", "repo"],
      includesUnknownSource: true,
    });
    expect(derivedOriginSources("conference").sources).toEqual([]);
  });

  it("every default kind and origin is either derivable or filterable on the stored field", () => {
    const { kinds, ideaOrigins } = defaultTaxonomy();
    for (const kind of kinds)
      expect(Array.isArray(derivedKindTypes(kind.id))).toBe(true);
    for (const origin of ideaOrigins) {
      expect(Array.isArray(derivedOriginSources(origin.id).sources)).toBe(true);
    }
  });
});
