import { PROVIDER_ALIASES } from '../public-reads.js';
import { describe, it, expect, vi } from 'vitest';
import { AuthoredError } from '../http/error-response.js';
import { stubSiblingModulesForTests } from '../interviews/sibling-modules.js';
import { INTERVIEW_UPDATE_FIELDS, validateTypedUpdates } from './content-update-validation.js';
import {
  FORBIDDEN_CONTENT_UPDATE_KEYS,
  validateAndNormalizeUpdateContentItemUpdates,
  normalizeContentUpdatesForBlogOnly,
  normalizeStatusForBlogOnly,
  normalizeCurrentStatusForBlogOnly,
  normalizeProviderName,
} from './content-update-validation.js';

describe('validateAndNormalizeUpdateContentItemUpdates', () => {
  it('rejects non-objects, empty updates, and >80 fields', () => {
    expect(() => validateAndNormalizeUpdateContentItemUpdates(null)).toThrow(/must be an object/);
    expect(() => validateAndNormalizeUpdateContentItemUpdates([])).toThrow(/must be an object/);
    expect(() => validateAndNormalizeUpdateContentItemUpdates({})).toThrow(/at least one field/);
    const many = Object.fromEntries(Array.from({ length: 81 }, (_, i) => [`f${i}`, 1]));
    expect(() => validateAndNormalizeUpdateContentItemUpdates(many)).toThrow(/exceeds 80 fields/);
  });

  it('refuses every protected workflow/identity field', () => {
    for (const field of FORBIDDEN_CONTENT_UPDATE_KEYS) {
      expect(() => validateAndNormalizeUpdateContentItemUpdates({ [field]: 'x' })).toThrow(
        new RegExp(`protected field`)
      );
    }
    // The state machine's fields specifically — the reason the denylist exists.
    for (const f of ['contentStatus', 'Live', 'updatedBy', 'Published At']) {
      expect(FORBIDDEN_CONTENT_UPDATE_KEYS.has(f)).toBe(true);
    }
  });

  it('refuses to assign a site URL — that is POST cms/content/slug (#400)', () => {
    // Before this, `slug` matched no normalizer here and fell through to the
    // generic string branch, so it was stored EXACTLY as sent and no caller
    // probed whether another document already held it. Both halves of that
    // are how three published articles ended up on one URL.
    for (const field of ['slug', 'Slug']) {
      expect(FORBIDDEN_CONTENT_UPDATE_KEYS.has(field)).toBe(true);
      expect(() =>
        validateAndNormalizeUpdateContentItemUpdates({ [field]: '  Hello World!!  ' })
      ).toThrow(/protected field/);
    }
  });

  it('writes dual-cased pairs for title, summary, tags, and cloud provider', () => {
    const out = validateAndNormalizeUpdateContentItemUpdates({
      title: '  Hello  ',
      summary: 'S',
      tags: [' a ', '', 'b'],
      cloudProvider: 'azure',
    });
    expect(out.title).toBe('Hello');
    expect(out.Title).toBe('Hello');
    expect(out.summary).toBe('S');
    expect(out.Summary).toBe('S');
    expect(out.tags).toEqual(['a', 'b']);
    expect(out.Tags).toEqual(['a', 'b']);
    expect(out.cloudProvider).toBe('Azure');
    expect(out['Cloud Provider']).toBe('Azure');
  });

  it('validates URL-suffixed fields and rejects non-http schemes', () => {
    const out = validateAndNormalizeUpdateContentItemUpdates({
      sourceUrl: ' https://example.com/a ',
      diagramUrl: '',
    });
    expect(out.sourceUrl).toBe('https://example.com/a');
    expect(out.diagramUrl).toBe('');
    expect(() =>
      validateAndNormalizeUpdateContentItemUpdates({ heroImageUrl: 'javascript:alert(1)' })
    ).toThrow(/http\(s\) URL/);
    expect(() => validateAndNormalizeUpdateContentItemUpdates({ docLink: 'not a url' })).toThrow(
      /valid URL/
    );
  });

  it('treats url, every …Url/…URL spelling and docLink as URL fields, and nothing else', () => {
    // The field test is one regex plus docLink; these pin what it must keep
    // matching (the six names the original spelled out) and what it must not.
    const out = validateAndNormalizeUpdateContentItemUpdates({
      url: 'https://example.com/',
      sourceUrl: 'https://example.com/s',
      diagramUrl: 'https://example.com/d',
      coverURL: 'https://example.com/c',
      docLink: 'https://example.com/doc',
    });
    expect(out).toEqual({
      url: 'https://example.com/',
      sourceUrl: 'https://example.com/s',
      diagramUrl: 'https://example.com/d',
      coverURL: 'https://example.com/c',
      docLink: 'https://example.com/doc',
    });
    for (const field of ['url', 'coverURL', 'docLink']) {
      expect(() =>
        validateAndNormalizeUpdateContentItemUpdates({ [field]: 'ftp://example.com/x' })
      ).toThrow(/http\(s\) URL/);
    }
    // Not a URL field: stored as plain text, however it reads.
    expect(validateAndNormalizeUpdateContentItemUpdates({ urlNote: 'not a url' })).toEqual({
      urlNote: 'not a url',
    });
  });

  it('gives …Html, …Code and …Draft fields the large string ceiling and others the default', () => {
    const large = 'x'.repeat(12_001);
    for (const field of ['overviewHtml', 'terraformCode', 'blogDraft', 'bodyHTML']) {
      expect(validateAndNormalizeUpdateContentItemUpdates({ [field]: large })[field]).toBe(large);
    }
    expect(() => validateAndNormalizeUpdateContentItemUpdates({ summaryText: large })).toThrow(
      /exceeds 12000 characters/
    );
    expect(() =>
      validateAndNormalizeUpdateContentItemUpdates({ overviewHtml: 'x'.repeat(120_001) })
    ).toThrow(/exceeds 120000 characters/);
  });

  it('a date-like field with a value the date normalizer cannot take falls through to the generic rules', () => {
    expect(validateAndNormalizeUpdateContentItemUpdates({ scheduledAt: 1700000000 })).toEqual({
      scheduledAt: 1700000000,
    });
    const asDate = new Date('2026-01-01T00:00:00.000Z');
    expect(validateAndNormalizeUpdateContentItemUpdates({ scheduledAt: asDate }).scheduledAt).toBe(
      asDate
    );
  });

  it('parses date-like string fields to Dates and rejects garbage', () => {
    const out = validateAndNormalizeUpdateContentItemUpdates({ fetchedAt: '2026-01-01' });
    expect(out.fetchedAt).toBeInstanceOf(Date);
    expect(() =>
      validateAndNormalizeUpdateContentItemUpdates({ scheduledPublishDate: 'yesterdayish' })
    ).toThrow(/valid date/);
  });

  it('enforces the large/small string ceilings by field name', () => {
    const big = 'x'.repeat(13_000);
    expect(() => validateAndNormalizeUpdateContentItemUpdates({ note: big })).toThrow(
      /exceeds 12000 characters/
    );
    // Draft/Html/Code fields get the 120k ceiling.
    expect(validateAndNormalizeUpdateContentItemUpdates({ blogDraft: big }).blogDraft).toBe(big);
  });

  it('rejects an invalid cloud provider and unsupported value types', () => {
    expect(() => validateAndNormalizeUpdateContentItemUpdates({ cloudProvider: 'ibm' })).toThrow(
      /must be one of/
    );
    expect(() => validateAndNormalizeUpdateContentItemUpdates({ fn: () => {} })).toThrow(
      /Unsupported value type/
    );
  });

  it('passes null through and skips undefined, like the source', () => {
    const out = validateAndNormalizeUpdateContentItemUpdates({
      heroPrompt: null,
      gone: undefined,
      kept: 1,
    });
    expect(out).toEqual({ heroPrompt: null, kept: 1 });
  });
});

describe('normalizeContentUpdatesForBlogOnly', () => {
  it('re-resolves publishTarget with the doc type fallback only when present', () => {
    expect(
      normalizeContentUpdatesForBlogOnly({ publishTarget: 'nonsense', type: 'framework' })
        .publishTarget
    ).toBe('framework');
    expect(normalizeContentUpdatesForBlogOnly({ Title: 'x' })).not.toHaveProperty('publishTarget');
  });

  it('collapses news-era statuses and forces approvedForNews off', () => {
    expect(
      normalizeContentUpdatesForBlogOnly({ contentStatus: 'published_news' }).contentStatus
    ).toBe('published');
    expect(normalizeContentUpdatesForBlogOnly({ approvedForNews: true }).approvedForNews).toBe(
      false
    );
  });
});

describe('status normalizers', () => {
  it('maps the retired news statuses onto blog equivalents', () => {
    expect(normalizeStatusForBlogOnly('published_news')).toBe('published');
    expect(normalizeStatusForBlogOnly('published_both')).toBe('published');
    expect(normalizeStatusForBlogOnly('approved_news')).toBe('approved');
    expect(normalizeStatusForBlogOnly('editing')).toBe('editing');
  });

  it('maps the Firestore-era admin aliases every Approve button sent (ADR 0033)', () => {
    expect(normalizeStatusForBlogOnly('approved_blog')).toBe('approved');
    expect(normalizeStatusForBlogOnly('published_blog')).toBe('published');
  });

  it('does not read Object.prototype for a status that names one of its keys', () => {
    expect(normalizeStatusForBlogOnly('constructor')).toBe('constructor');
    expect(normalizeStatusForBlogOnly('__proto__')).toBe('__proto__');
  });

  it('defaults an absent current status to ingested', () => {
    expect(normalizeCurrentStatusForBlogOnly(undefined)).toBe('ingested');
    expect(normalizeCurrentStatusForBlogOnly('')).toBe('ingested');
  });
});

describe('normalizeProviderName', () => {
  it('canonicalizes provider spellings and rejects unknowns', () => {
    expect(normalizeProviderName('AWS')).toBe('Aws');
    expect(normalizeProviderName('google cloud')).toBe('Gcp');
    expect(normalizeProviderName('Fin-Ops')).toBe('Finops');
    expect(normalizeProviderName('oracle')).toBe('');
  });

  it('canonicalizes Docker to the stored value Docker, whatever the casing', () => {
    expect(normalizeProviderName('Docker')).toBe('Docker');
    expect(normalizeProviderName('docker')).toBe('Docker');
    expect(normalizeProviderName(' DOCKER ')).toBe('Docker');
  });

  it('knows every provider the site routes, VMware and Ansible included', () => {
    expect(normalizeProviderName('VMware')).toBe('Vmware');
    expect(normalizeProviderName('vmware')).toBe('Vmware');
    expect(normalizeProviderName('Ansible')).toBe('Ansible');
    expect(normalizeProviderName('GitHub')).toBe('Github');
    expect(normalizeProviderName('FinOps')).toBe('Finops');
    for (const key of Object.keys(PROVIDER_ALIASES)) {
      const stored = normalizeProviderName(key);
      expect(stored, key).not.toBe('');
      // The stored value lower-cases back to the route segment publish.js writes.
      expect(stored.toLowerCase(), key).toBe(key);
      expect(normalizeProviderName(stored), key).toBe(stored);
    }
  });
});

describe("validateTypedUpdates, the interview hook (ADR 0040, D5)", () => {
  it("passes any other type through untouched, without loading the schema", async () => {
    stubSiblingModulesForTests({ schema: {} });
    const updates = { title: "x", qa: "not a list" };
    expect(await validateTypedUpdates("blog", updates)).toBe(updates);
    expect(await validateTypedUpdates(undefined, updates)).toBe(updates);
    stubSiblingModulesForTests(null);
  });

  it("passes an interview update naming none of the interview fields through untouched", async () => {
    stubSiblingModulesForTests({ schema: {} });
    const updates = { summary: "a summary" };
    expect(await validateTypedUpdates("interview", updates)).toBe(updates);
    stubSiblingModulesForTests(null);
  });

  it("runs the interview fields through the schema and keeps the checked form, both title spellings", async () => {
    const validateInterviewFields = vi.fn((fields) => ({ ...fields, title: fields.title.trim(), tags: ["a-b"] }));
    stubSiblingModulesForTests({ schema: { validateInterviewFields } });
    const out = await validateTypedUpdates("interview", { title: "  Spaced  ", tags: ["A-B"], summary: "s" });
    expect(validateInterviewFields).toHaveBeenCalledWith({ title: "  Spaced  ", tags: ["A-B"] });
    expect(out).toEqual({ title: "Spaced", Title: "Spaced", tags: ["a-b"], summary: "s" });
    stubSiblingModulesForTests(null);
  });

  it("refuses with the schema's own sentence as a ContentValidationError", async () => {
    stubSiblingModulesForTests({
      schema: {
        validateInterviewFields: () => {
          throw new AuthoredError("qa[2] a is missing.");
        },
      },
    });
    await expect(validateTypedUpdates("interview", { qa: [{ q: "q" }] })).rejects.toMatchObject({
      name: "ContentValidationError",
      message: "qa[2] a is missing.",
    });
    stubSiblingModulesForTests(null);
  });

  it("names every field the admin page edits", () => {
    expect([...INTERVIEW_UPDATE_FIELDS].sort()).toEqual(
      ["bio", "date", "guest", "image", "qa", "related", "subtitle", "tags", "title"]
    );
  });
});

describe("an interview's private blocks and its type through updateContentItem (ADR 0040, D9)", () => {
  it("refuses consent, provenance, interview and transcription like every other protected field", () => {
    for (const key of ["consent", "provenance", "interview", "transcription"]) {
      expect(() => validateAndNormalizeUpdateContentItemUpdates({ [key]: { planted: true } })).toThrow(
        `updates cannot modify protected field: ${key}`
      );
    }
  });

  it("refuses turning a document into an interview, or an interview into anything else", async () => {
    stubSiblingModulesForTests({ schema: { validateInterviewFields: (f) => f } });
    for (const key of ["type", "publishTarget", "contentType"]) {
      await expect(validateTypedUpdates("blog", { [key]: "Interview" })).rejects.toMatchObject({
        name: "ContentValidationError",
        message: expect.stringContaining("POST cms/interviews"),
      });
      await expect(validateTypedUpdates("interview", { [key]: "blog" })).rejects.toMatchObject({
        name: "ContentValidationError",
        message: expect.stringContaining("stays an interview"),
      });
    }
    // Saying what it already is, or clearing nothing, is fine either way.
    expect(await validateTypedUpdates("interview", { publishTarget: "interview" })).toEqual({ publishTarget: "interview" });
    expect(await validateTypedUpdates("blog", { publishTarget: "framework" })).toEqual({ publishTarget: "framework" });
    stubSiblingModulesForTests(null);
  });
});
