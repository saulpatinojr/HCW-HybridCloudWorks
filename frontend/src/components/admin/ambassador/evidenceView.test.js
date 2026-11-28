/**
 * The Evidence tab's rules (ADR 0033 §4): each filter narrows, none widens,
 * the years come from the dates, Group by puts every item in its group(s) in
 * a stated order, the collapsed state survives a broken storage, and the
 * guide rows read have/need from the readiness arithmetic.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  EMPTY_EVIDENCE_FILTERS,
  GROUP_BY_OPTIONS,
  anyFilterSet,
  filterEvidence,
  groupEvidence,
  groupStateKey,
  guideRows,
  readCollapsedGroups,
  writeCollapsedGroups,
  yearsOf,
} from './evidenceView';

const evidence = [
  { id: 'talk', sourceModule: 'speaking', date: '2026-08-14', programIds: [] },
  { id: 'cert', sourceModule: 'certifications', date: '2025-01-02', programIds: ['beta'] },
  { id: 'post', sourceModule: 'content', verificationStatus: 'verified', programIds: ['alpha'] },
];

describe('filterEvidence', () => {
  it('keeps everything when no filter is set', () => {
    expect(filterEvidence(evidence, EMPTY_EVIDENCE_FILTERS).map((e) => e.id)).toEqual([
      'talk',
      'cert',
      'post',
    ]);
    expect(anyFilterSet(EMPTY_EVIDENCE_FILTERS)).toBe(false);
  });

  it('narrows by source, program relevance, year and verification, all at once', () => {
    const by = (patch) =>
      filterEvidence(evidence, { ...EMPTY_EVIDENCE_FILTERS, ...patch }).map((e) => e.id);
    expect(by({ source: 'speaking' })).toEqual(['talk']);
    // Evidence naming no program counts for every program.
    expect(by({ program: 'beta' })).toEqual(['talk', 'cert']);
    expect(by({ year: '2025' })).toEqual(['cert']);
    expect(by({ verification: 'unverified' })).toEqual(['talk', 'cert']);
    expect(by({ verification: 'verified', program: 'alpha' })).toEqual(['post']);
    expect(anyFilterSet({ ...EMPTY_EVIDENCE_FILTERS, year: '2025' })).toBe(true);
  });
});

describe('yearsOf', () => {
  it('lists the years of dated items once each, newest first', () => {
    expect(yearsOf(evidence)).toEqual(['2026', '2025']);
    expect(yearsOf([])).toEqual([]);
  });
});

describe('groupEvidence', () => {
  const byId = new Map([
    ['beta', { id: 'beta', name: 'Beta Program' }],
    ['alpha', { id: 'alpha', name: 'Alpha Program' }],
  ]);
  const both = {
    id: 'both',
    sourceModule: 'manual',
    date: '2026-01-01',
    programIds: ['beta', 'alpha'],
  };
  const shape = (groups) => groups.map((g) => [g.label, g.items.map((e) => e.id)]);

  it('offers None first and answers one group for it', () => {
    expect(GROUP_BY_OPTIONS[0]).toEqual(['', 'None']);
    expect(shape(groupEvidence(evidence, ''))).toEqual([
      ['All evidence', ['talk', 'cert', 'post']],
    ]);
  });

  it('groups by source in the picker order, by program with Every program first and an item in each program it names', () => {
    expect(shape(groupEvidence([...evidence, both], 'source'))).toEqual([
      ['Speaking', ['talk']],
      ['Certifications', ['cert']],
      ['Published content', ['post']],
      ['Manual', ['both']],
    ]);
    expect(shape(groupEvidence([...evidence, both], 'program', { byId }))).toEqual([
      ['Every program', ['talk']],
      ['Alpha Program', ['post', 'both']],
      ['Beta Program', ['cert', 'both']],
    ]);
  });

  it('groups by year newest first with Undated last, and verified before unverified', () => {
    expect(shape(groupEvidence(evidence, 'year'))).toEqual([
      ['2026', ['talk']],
      ['2025', ['cert']],
      ['Undated', ['post']],
    ]);
    expect(shape(groupEvidence(evidence, 'verification'))).toEqual([
      ['Verified', ['post']],
      ['Unverified', ['talk', 'cert']],
    ]);
  });
});

describe('collapsed groups', () => {
  const memory = () => {
    const data = new Map();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
  };

  it('round-trip through storage under one key per grouping and group', () => {
    const storage = memory();
    const key = groupStateKey('source', 'speaking');
    expect(key).toBe('source:speaking');
    expect(writeCollapsedGroups({ [key]: true }, storage)).toBe(true);
    expect(readCollapsedGroups(storage)).toEqual({ 'source:speaking': true });
  });

  it('answer an empty state and false when storage is absent, throws or holds junk', () => {
    expect(readCollapsedGroups(null)).toEqual({});
    expect(writeCollapsedGroups({}, null)).toBe(false);
    const broken = {
      getItem: vi.fn(() => {
        throw new Error('blocked');
      }),
      setItem: vi.fn(() => {
        throw new Error('quota');
      }),
    };
    expect(readCollapsedGroups(broken)).toEqual({});
    expect(writeCollapsedGroups({ a: true }, broken)).toBe(false);
    const junk = memory();
    junk.setItem('ambassador.evidence.collapsed', '[1,2]');
    expect(readCollapsedGroups(junk)).toEqual({});
    junk.setItem('ambassador.evidence.collapsed', '{not json');
    expect(readCollapsedGroups(junk)).toEqual({});
  });
});

describe('guideRows', () => {
  const program = {
    id: 'p1',
    requirements: [
      { id: 'talks', label: 'Talks', evidenceTypes: ['speaking', 'labs'] },
      { id: 'posts', label: 'Posts', evidenceTypes: ['content'] },
      { id: 'any', label: 'Anything', evidenceTypes: [] },
    ],
  };
  const readiness = {
    unit: 'items',
    requirements: [
      { id: 'talks', label: 'Talks', count: 1, minCount: 4, met: false },
      { id: 'posts', label: 'Posts', count: 2, minCount: 1, met: true },
      { id: 'any', label: 'Anything', count: 0, minCount: 1, met: false },
    ],
  };

  it('reads have/need per requirement, hints the short ones with their sources, and picks the Add source', () => {
    expect(guideRows(program, readiness)).toEqual([
      {
        id: 'talks',
        label: 'Talks',
        have: 1,
        need: 4,
        unit: 'items',
        met: false,
        short: 3,
        hint: '3 more items from Speaking, Labs',
        addSource: 'speaking',
      },
      {
        id: 'posts',
        label: 'Posts',
        have: 2,
        need: 1,
        unit: 'items',
        met: true,
        short: 0,
        hint: '',
        addSource: 'content',
      },
      {
        id: 'any',
        label: 'Anything',
        have: 0,
        need: 1,
        unit: 'items',
        met: false,
        short: 1,
        hint: '1 more item from any source',
        addSource: 'manual',
      },
    ]);
  });

  it('words a credits program in credits and answers nothing before readiness lands', () => {
    const credits = guideRows(
      { id: 'p2', requirements: [{ id: 't10', label: 'Tier', evidenceTypes: ['manual'] }] },
      { unit: 'credits', requirements: [{ id: 't10', label: 'Tier', count: 4, minCount: 10 }] }
    );
    expect(credits[0]).toMatchObject({ have: 4, need: 10, hint: '6 more credits from Manual' });
    expect(guideRows(program, null)).toEqual([]);
    expect(guideRows(null, readiness)).toEqual([]);
  });
});
