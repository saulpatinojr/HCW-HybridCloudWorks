import { describe, it, expect } from 'vitest';
import { firstFilled, initialFormFrom } from './ReviewBoardShell';
import { initialBlueprintForm } from './ArchitectureReviewBoard';
import { initialFrameworkForm } from './FrameworkReviewBoard';

describe('firstFilled', () => {
  it('returns the first truthy field in key order', () => {
    expect(firstFilled({ Title: 'Legacy', title: 'Current' }, ['title', 'Title'], '')).toBe(
      'Current'
    );
    expect(firstFilled({ Title: 'Legacy' }, ['title', 'Title'], '')).toBe('Legacy');
  });

  it('skips empty strings, zero and false like the `||` chain it replaces', () => {
    expect(firstFilled({ title: '', Title: 0 }, ['title', 'Title'], 'fallback')).toBe('fallback');
    expect(firstFilled({ featured: false }, ['featured'], false)).toBe(false);
    expect(firstFilled(undefined, ['title'], 'fallback')).toBe('fallback');
  });
});

describe('initialFormFrom', () => {
  it('builds every field of the table', () => {
    const form = initialFormFrom(
      { 'Cloud Provider': 'Azure' },
      { cloudProvider: [['cloudProvider', 'Cloud Provider'], 'AWS'], tags: [['tags'], []] }
    );
    expect(form).toEqual({ cloudProvider: 'Azure', tags: [] });
  });
});

describe('board initial forms (PR #841)', () => {
  it('reads the blueprint legacy spellings and defaults', () => {
    const form = initialBlueprintForm({
      Title: 'Fan-out',
      'Cloud Provider': 'GCP',
      contentImageUrl: 'https://img',
    });
    expect(form.title).toBe('Fan-out');
    expect(form.cloudProvider).toBe('GCP');
    expect(form.diagramUrl).toBe('https://img');
    expect(form.complexity).toBe('Medium');
    expect(form.technicalSpecs).toEqual({ components: [], patterns: [] });
    expect(form.hotspots).toEqual([]);
  });

  it('gives each blueprint form its own fallback objects', () => {
    const a = initialBlueprintForm({});
    const b = initialBlueprintForm({});
    expect(a.hotspots).not.toBe(b.hotspots);
    expect(a.costAnalysis).not.toBe(b.costAnalysis);
  });

  it('reads the framework legacy spellings and defaults', () => {
    const form = initialFrameworkForm({
      frameworkConceptSeeds: ['Posture'],
      officialSources: ['https://docs'],
      recommendation: 'Use it',
    });
    expect(form.frameworkConcepts).toEqual(['Posture']);
    expect(form.frameworkSourceUrls).toEqual(['https://docs']);
    expect(form.architectureRecommendation).toBe('Use it');
    expect(form.complexity).toBe('Foundation');
    expect(form.maturityScores).toEqual({
      Security: 3,
      Reliability: 3,
      Cost: 3,
      Operations: 3,
      Performance: 3,
      Sustainability: 3,
    });
  });
});

describe('the address topic on the design and framework boards (#1628)', () => {
  it('reads the stored topic into the form, or empty for "pick automatically"', () => {
    expect(initialBlueprintForm({ topic: 'network' }).topic).toBe('network');
    expect(initialBlueprintForm({}).topic).toBe('');
    expect(initialFrameworkForm({ topic: 'finops' }).topic).toBe('finops');
    expect(initialFrameworkForm({ topic: null }).topic).toBe('');
  });
});
