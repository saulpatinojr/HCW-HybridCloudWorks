import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KINDS,
  DEFAULT_IDEA_ORIGINS,
  defaultTaxonomy,
  normalizeContentTaxonomy,
  resolveContentTaxonomy,
  resolveIdeaOrigin,
  resolveKind,
} from './taxonomy.js';

describe('content taxonomy defaults', () => {
  it('ships both lists enabled, in order, with unique slug ids', () => {
    const { kinds, ideaOrigins } = defaultTaxonomy();
    expect(kinds).toHaveLength(DEFAULT_KINDS.length);
    expect(ideaOrigins).toHaveLength(DEFAULT_IDEA_ORIGINS.length);
    for (const list of [kinds, ideaOrigins]) {
      expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
      list.forEach((x, i) => {
        expect(x.enabled).toBe(true);
        expect(x.order).toBe(i);
        expect(x.id).toMatch(/^[a-z0-9][a-z0-9-]{1,39}$/);
      });
    }
  });

  it('keeps the two dimensions apart: a kind id is never an origin id', () => {
    const kindIds = new Set(DEFAULT_KINDS.map((k) => k.id));
    for (const origin of DEFAULT_IDEA_ORIGINS) expect(kindIds.has(origin.id)).toBe(false);
  });
});

describe('classifying a record that predates the taxonomy', () => {
  it('derives the idea origin from the pipeline source', () => {
    expect(resolveIdeaOrigin({ source: 'rss' })).toBe('rss-feed');
    expect(resolveIdeaOrigin({ source: 'manual_url' })).toBe('imported-source');
    expect(resolveIdeaOrigin({ source: 'forge-url' })).toBe('imported-source');
    expect(resolveIdeaOrigin({ source: 'recording' })).toBe('recording');
    expect(resolveIdeaOrigin({ source: 'template-form' })).toBe('audience-question');
    expect(resolveIdeaOrigin({ source: 'drafts' })).toBe('manual');
    expect(resolveIdeaOrigin({})).toBe('manual');
  });

  it('prefers a stored origin over the derived one', () => {
    expect(resolveIdeaOrigin({ source: 'rss', ideaOrigin: 'content-gap' })).toBe('content-gap');
  });

  it('derives the kind from the publish type and prefers a stored kind', () => {
    expect(resolveKind({ type: 'blog' })).toBe('article');
    expect(resolveKind({ type: 'framework' })).toBe('reference-guide');
    expect(resolveKind({ type: 'coder_corner' })).toBe('tutorial');
    expect(resolveKind({ publishTarget: 'architecture' })).toBe('reference-guide');
    expect(resolveKind({ type: 'blog', kind: 'tutorial' })).toBe('tutorial');
    expect(resolveKind({})).toBe('article');
  });
});

describe('normalizeContentTaxonomy', () => {
  it('accepts the defaults unchanged and re-numbers order from the array', () => {
    const saved = normalizeContentTaxonomy(defaultTaxonomy());
    expect(saved.kinds.map((k) => k.order)).toEqual(saved.kinds.map((_, i) => i));
  });

  it('lets an admin disable, rename, reorder and add; a dropped built-in comes back enabled', () => {
    const base = defaultTaxonomy();
    const kinds = [...base.kinds].reverse();
    kinds[0] = { ...kinds[0], enabled: false, label: 'Renamed' };
    kinds.push({ id: 'webinar', label: 'Webinar', description: '' });
    const saved = normalizeContentTaxonomy({ kinds, ideaOrigins: base.ideaOrigins });
    expect(saved.kinds[0].enabled).toBe(false);
    expect(saved.kinds[0].label).toBe('Renamed');
    expect(saved.kinds.at(-1)).toMatchObject({ id: 'webinar', enabled: true });

    // A built-in the stored list lacks is appended, enabled, at the end: a
    // taxonomy saved before `interview` existed (ADR 0040) keeps validating
    // on read and on save, and a built-in cannot be removed by dropping it.
    const dropped = base.kinds.filter((k) => k.id !== 'article');
    const restored = normalizeContentTaxonomy({ kinds: dropped, ideaOrigins: base.ideaOrigins });
    expect(restored.kinds.at(-1)).toMatchObject({ id: 'article', enabled: true });
    expect(restored.kinds).toHaveLength(base.kinds.length);
    expect(restored.kinds.map((k) => k.order)).toEqual(restored.kinds.map((_, i) => i));
  });

  it('classifies an interview as its own kind (ADR 0040, D5)', () => {
    expect(DEFAULT_KINDS.find((k) => k.id === 'interview')).toBeTruthy();
    expect(resolveKind({ type: 'interview' })).toBe('interview');
    expect(resolveKind({ publishTarget: 'INTERVIEW' })).toBe('interview');
  });

  it('refuses bad ids, duplicates, blank labels, non-boolean enabled and unknown keys', () => {
    const base = defaultTaxonomy();
    const withBad = (kinds) => ({ kinds, ideaOrigins: base.ideaOrigins });
    expect(() =>
      normalizeContentTaxonomy(withBad([...base.kinds, { id: 'Bad Id', label: 'x' }]))
    ).toThrow(/id must be/);
    expect(() =>
      normalizeContentTaxonomy(withBad([...base.kinds, { id: 'article', label: 'x' }]))
    ).toThrow(/twice/);
    expect(() =>
      normalizeContentTaxonomy(withBad([...base.kinds, { id: 'okay', label: '' }]))
    ).toThrow(/label must be/);
    expect(() =>
      normalizeContentTaxonomy(withBad([...base.kinds, { id: 'okay', label: 'x', enabled: 'yes' }]))
    ).toThrow(/enabled must be/);
    expect(() => normalizeContentTaxonomy({ ...base, extra: 1 })).toThrow(/unknown keys/);
  });
});

describe('resolveContentTaxonomy', () => {
  it('returns the stored document when it validates, else the defaults', async () => {
    const stored = defaultTaxonomy();
    stored.kinds[0].enabled = false;
    expect(
      (await resolveContentTaxonomy({ readDoc: async () => ({ ...stored, id: 'content_taxonomy' }) }))
        .kinds[0].enabled
    ).toBe(false);
    expect(
      (await resolveContentTaxonomy({ readDoc: async () => ({ kinds: 'nope' }) })).kinds
    ).toHaveLength(DEFAULT_KINDS.length);
    expect((await resolveContentTaxonomy({ readDoc: async () => null })).ideaOrigins).toHaveLength(
      DEFAULT_IDEA_ORIGINS.length
    );
  });
});
