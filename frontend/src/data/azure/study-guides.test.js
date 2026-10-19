/**
 * The study-guide outlines are generated data with a date on them, and the
 * same rule applies as to the catalogue: a claim with no date attached that
 * nothing ever checks is how #461 happened. These hold the shape the detail
 * page renders from, the freshness stamp, and the join back to the catalogue.
 *
 * ONE MODULE PER GUIDE (#500). The outlines are ./study-guides/<key>.js plus an
 * index; this loads the index and every module (eagerly — the page loads them
 * one at a time) and checks that the two agree, because the page decides from
 * the index whether to render an outline and from the module what to render.
 */
import { describe, expect, it } from 'vitest';
import {
  DATA_AS_OF,
  DATA_SOURCE,
  GUIDE_KEYS,
  guideKeyFor,
  outlineKeyFor,
} from './study-guides/index.js';
import { certifications } from './certifications';
import { deriveStatus, todayIso } from '@/lib/certStatus';
import { loadStudyGuideOutline, loadableGuideKeys } from '@/lib/studyGuideOutline';

const modules = import.meta.glob(['./study-guides/*.js', '!./study-guides/index.js'], {
  eager: true,
  import: 'default',
});
const STUDY_GUIDES = Object.fromEntries(
  Object.entries(modules).map(([file, outline]) => [
    file.split('/').pop().replace(/\.js$/, ''),
    outline,
  ])
);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const keys = Object.keys(STUDY_GUIDES).sort();

describe('Azure study-guide outlines', () => {
  it('stamps the day they were last read from Microsoft Learn', () => {
    expect(DATA_AS_OF).toMatch(ISO_DATE);
    // Local calendar, like every other DATA_AS_OF here: the generator stamps
    // the clock of the machine that must also run this test.
    expect(DATA_AS_OF <= todayIso()).toBe(true);
    expect(DATA_SOURCE.url).toMatch(/^https:\/\/learn\.microsoft\.com\//);
  });

  it('lists in the index exactly the guides that have a module, and the page can load each', () => {
    // The index says whether a page renders an outline section; the module is
    // what fills it. A key with no module would suspend into null on the client
    // and in the prerender; a module with no key would never be shown.
    expect(keys.length).toBeGreaterThan(0);
    expect([...GUIDE_KEYS]).toEqual(keys);
    expect(loadableGuideKeys()).toEqual(keys);
  });

  it('carries an outline for every live catalogue exam that has a study guide', () => {
    // Retired exams are skipped on purpose: Learn redirects their guides to
    // the browse page, and a redirect parses as a valid page with no areas.
    // Retired as rendered today (deriveStatus), the rule the updater applies
    // (scripts/update-study-guides.mjs, eligibleCerts): a row stored `retired`
    // ahead of its day keeps its outline until the day.
    const expected = certifications
      .filter((c) => c.studyGuideUrl && deriveStatus(c, todayIso()) !== 'retired')
      .map((c) => guideKeyFor(c.studyGuideUrl));
    const missing = expected.filter((key) => !STUDY_GUIDES[key]);
    expect(missing, 'exams with a studyGuideUrl but no outline').toEqual([]);
  });

  it('has no outline for an exam the catalogue does not carry', () => {
    // An orphan means a URL was renamed in the catalogue and the outline
    // was not regenerated — stale data that no page can reach.
    const known = new Set(certifications.map((c) => guideKeyFor(c.studyGuideUrl)).filter(Boolean));
    const orphans = keys.filter((key) => !known.has(key));
    expect(orphans).toEqual([]);
  });

  it('gives every outline at least one weighted area, and every area a name and a slug', () => {
    for (const key of keys) {
      const guide = STUDY_GUIDES[key];
      expect(guide.areas.length, `${key} has no areas`).toBeGreaterThan(0);
      expect(guide.sourceUrl, key).toMatch(/^https:\/\/learn\.microsoft\.com\//);
      // The module's file name is the join; it must name the guide it holds.
      expect(guideKeyFor(guide.sourceUrl), `${key}.js holds another guide`).toBe(key);
      for (const area of guide.areas) {
        expect(area.name, key).toBeTruthy();
        expect(area.slug, key).toMatch(/^[a-z0-9-]+$/);
        // The anchor is read off the Learn page, never derived, so it is a
        // string or an honest null — never the slug pretending to be one.
        expect(
          area.anchor === null || typeof area.anchor === 'string',
          `${key}/${area.slug} anchor`
        ).toBe(true);
        expect(Array.isArray(area.sections), key).toBe(true);
      }
    }
  });

  it('keeps each area either sectioned or flat, never both', () => {
    // A guide that lists objectives under h4 sub-headings stores them in
    // `sections`; one that lists them flat stores them in `objectives`.
    // Both populated would print every objective twice.
    for (const key of keys) {
      for (const area of STUDY_GUIDES[key].areas) {
        if (area.sections.length > 0) {
          expect(area.objectives, `${key}/${area.slug}`).toEqual([]);
        }
      }
    }
  });

  it('resolves a catalogue URL to its outline and refuses what it does not have', async () => {
    const az104 = certifications.find((c) => c.code === 'AZ-104');
    expect(az104?.studyGuideUrl).toBeTruthy();
    const key = outlineKeyFor(az104.studyGuideUrl);
    expect(key).toBe('az-104');
    const outline = await loadStudyGuideOutline(key);
    expect(outline?.examCode).toBe('AZ-104');
    expect(outline.areas[0].name).toBe('Manage Azure identities and governance');
    expect(outline.areas[0].anchor).toBe('manage-azure-identities-and-governance-2025');
    expect(outline).toEqual(STUDY_GUIDES['az-104']);

    expect(
      outlineKeyFor(
        'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/zz-000'
      )
    ).toBeNull();
    expect(outlineKeyFor(undefined)).toBeNull();
    expect(outlineKeyFor('')).toBeNull();
    expect(await loadStudyGuideOutline('zz-000')).toBeNull();
    expect(await loadStudyGuideOutline(null)).toBeNull();
  });

  it('hands use() the same thenable for an exam every time, marked fulfilled once loaded', async () => {
    // use() suspends again on a new promise, and React warns about an uncached
    // one; the page re-renders after hydration, so identity is load-bearing.
    const first = loadStudyGuideOutline('az-305');
    expect(loadStudyGuideOutline('az-305')).toBe(first);
    await first;
    // The thenable protocol use() reads to return synchronously.
    await Promise.resolve();
    expect(first.status).toBe('fulfilled');
    expect(first.value?.examCode).toBe('AZ-305');
  });

  it('keys by the study-guide URL tail, which is unique where exam codes are not', () => {
    // The catalogue's applied-skills entries share site-assigned codes, so
    // `code` cannot be the join. A URL tail can only name one guide.
    expect(
      guideKeyFor(
        'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104'
      )
    ).toBe('az-104');
    expect(guideKeyFor('https://learn.microsoft.com/.../study-guides/AZ-104/?wt.mc_id=x')).toBe(
      'az-104'
    );
    expect(new Set(GUIDE_KEYS).size).toBe(GUIDE_KEYS.length);
  });
});
