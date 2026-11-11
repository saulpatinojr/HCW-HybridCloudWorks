/**
 * The sessionStorage draft (#634).
 *
 * The read was module-level and the write was inline in an effect, so the two
 * field lists sat far apart and nothing checked they agreed. These pin the
 * round trip, and the defaults that make an older or partial snapshot safe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { applyBuilderSnapshot, readBuilderSnapshot, writeBuilderSnapshot } from './builderSnapshot';
import { DEFAULT_DRAFT_INSTRUCTION_PROMPT } from './draftStage';

function setters() {
  const names = [
    'setProvider',
    'setBlogLandingProvider',
    'setContentType',
    'setTitle',
    'setPublishedDate',
    'setSourceUrl',
    'setKbArticleUrls',
    'setKbDocumentUrl',
    'setKbDocumentUrls',
    'setDraftInstructionPrompt',
    'setFrameworkSourceUrls',
    'setFrameworkKnowledgePrompt',
    'setFrameworkDiagramPrompt',
    'setFrameworkImagePrompt',
    'setFrameworkConceptSeeds',
    'setDraftTitle',
    'setDraftSummary',
    'setDraftContent',
    'setDraftTopics',
    'setDraftTopic',
    'setDraftReady',
    'setSummaryPrompt',
    'setDetailsPrompt',
    'setGeneratedImages',
    'setGeneratedImageIds',
    'setSelectedUploaded',
    'setSelectedGenerated',
    'setAiTargets',
    'setSlotUrls',
  ];
  return Object.fromEntries(names.map((name) => [name, vi.fn()]));
}

describe('readBuilderSnapshot', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('is null when nothing was saved', () => {
    expect(readBuilderSnapshot()).toBeNull();
  });

  it('round-trips what was written', () => {
    writeBuilderSnapshot({ title: 'kept' });
    expect(readBuilderSnapshot()).toEqual({ title: 'kept' });
  });

  it('is null rather than a throw when the stored value is corrupt', () => {
    // A half-written or hand-edited entry must not break the page on load.
    window.sessionStorage.setItem('hcw-publish-ready-builder-draft', '{not json');
    expect(readBuilderSnapshot()).toBeNull();
  });
});

describe('writeBuilderSnapshot', () => {
  it('reports a storage failure instead of throwing', () => {
    // Private browsing and a full quota both throw here, and neither is worth
    // interrupting the operator for: the draft is still intact in memory.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(writeBuilderSnapshot({ title: 'x' })).toBe(false);
    setItem.mockRestore();
  });
});

describe('applyBuilderSnapshot', () => {
  it('restores an empty snapshot to safe defaults rather than undefined', () => {
    // A snapshot written by an older version of the page is missing fields;
    // that is normal, not a fault.
    const s = setters();
    applyBuilderSnapshot({}, s);
    expect(s.setProvider).toHaveBeenCalledWith('');
    expect(s.setContentType).toHaveBeenCalledWith('blog');
    expect(s.setKbArticleUrls).toHaveBeenCalledWith([]);
    expect(s.setDraftReady).toHaveBeenCalledWith(false);
    expect(s.setDraftInstructionPrompt).toHaveBeenCalledWith(DEFAULT_DRAFT_INSTRUCTION_PROMPT);
  });

  it('restores what was actually saved', () => {
    const s = setters();
    applyBuilderSnapshot(
      { provider: 'Azure', contentType: 'framework', title: 'T', draftReady: true },
      s
    );
    expect(s.setProvider).toHaveBeenCalledWith('Azure');
    expect(s.setContentType).toHaveBeenCalledWith('framework');
    expect(s.setTitle).toHaveBeenCalledWith('T');
    expect(s.setDraftReady).toHaveBeenCalledWith(true);
  });

  it('restores the kind and idea origin, defaulting an older snapshot (ADR 0033 §4)', () => {
    const s = { ...setters(), setTaxonomy: vi.fn() };
    applyBuilderSnapshot({ kind: 'tutorial', ideaOrigin: 'conference' }, s);
    expect(s.setTaxonomy).toHaveBeenCalledWith({ kind: 'tutorial', ideaOrigin: 'conference' });

    const older = { ...setters(), setTaxonomy: vi.fn() };
    applyBuilderSnapshot({}, older);
    expect(older.setTaxonomy).toHaveBeenCalledWith({
      kind: 'article',
      ideaOrigin: 'imported-source',
    });
  });

  it('coerces a non-array list back to an array', () => {
    // JSON.parse will hand back whatever was stored, including the wrong type.
    const s = setters();
    applyBuilderSnapshot({ kbArticleUrls: 'not an array', draftTopics: null }, s);
    expect(s.setKbArticleUrls).toHaveBeenCalledWith([]);
    expect(s.setDraftTopics).toHaveBeenCalledWith([]);
  });

  it('restores the address topic, and an older or bad snapshot to automatic (#1628)', () => {
    const s = setters();
    applyBuilderSnapshot({ draftTopic: 'finops' }, s);
    expect(s.setDraftTopic).toHaveBeenCalledWith('finops');

    const older = setters();
    applyBuilderSnapshot({}, older);
    expect(older.setDraftTopic).toHaveBeenCalledWith('');

    const bad = setters();
    applyBuilderSnapshot({ draftTopic: 'not-a-topic' }, bad);
    expect(bad.setDraftTopic).toHaveBeenCalledWith('');
  });

  it('coerces a non-boolean draftReady', () => {
    const s = setters();
    applyBuilderSnapshot({ draftReady: 'yes' }, s);
    expect(s.setDraftReady).toHaveBeenCalledWith(true);
  });

  it('normalises the restored content the way the draft stage does', () => {
    const s = setters();
    applyBuilderSnapshot({ draftContent: 'body' }, s);
    const [[restored]] = s.setDraftContent.mock.calls;
    expect(restored).toContain('body');
  });

  it('fills every image slot even when the snapshot named one', () => {
    // Spread over the blank, so a saved draft missing a slot gets '' rather
    // than undefined -- which downstream reads as "nothing selected".
    const s = setters();
    applyBuilderSnapshot({ generatedImages: { hero: '/m/h.png' } }, s);
    const [[images]] = s.setGeneratedImages.mock.calls;
    expect(images.hero).toBe('/m/h.png');
    expect(images.secondary1).toBe('');
  });

  it('merges the selection maps onto whatever is already there', () => {
    // These take an updater, not a value: the defaults are set in useState and
    // a snapshot only overrides the slots it mentions.
    const s = setters();
    applyBuilderSnapshot({ selectedGenerated: { hero: false } }, s);
    const [[update]] = s.setSelectedGenerated.mock.calls;
    expect(update({ hero: true, secondary1: true })).toEqual({ hero: false, secondary1: true });
  });

  it('writes to every setter it was given', () => {
    // The read and the write used to live apart; this is what catches a field
    // added to one list and forgotten in the other.
    const s = setters();
    applyBuilderSnapshot({}, s);
    for (const [name, fn] of Object.entries(s)) {
      expect(fn, `${name} was never called`).toHaveBeenCalled();
    }
  });
});
