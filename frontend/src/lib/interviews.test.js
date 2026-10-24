/**
 * The interview file format: what is accepted, what stops the build and says
 * which file and field, and how an interview becomes the pages of the book.
 */
import { describe, it, expect } from 'vitest';
import {
  InterviewError,
  buildBookPages,
  formatInterviewDate,
  interviewPath,
  interviewSummary,
  isExternalLink,
  lastSpread,
  leafCount,
  normalizeInterview,
  safeLink,
  sortInterviews,
  spreadStatus,
  visiblePageIndexes,
} from './interviews';
import { makeInterview, rawInterview } from '@/test-utils/interviews';

const reject = (overrides, slug = 'a-test-interview') =>
  expect(() => normalizeInterview(rawInterview(overrides), slug));

describe('normalizeInterview', () => {
  it('accepts a complete file and returns one shape', () => {
    const interview = makeInterview();
    expect(interview).toMatchObject({
      slug: 'a-test-interview',
      title: 'A Test Interview',
      date: '2026-10-01',
      guest: { name: 'Test Guest', role: 'Test Role' },
      tags: ['landing-zones', 'governance'],
    });
    expect(interview.qa).toHaveLength(3);
    expect(interview.qa[1].pullQuote).toBe('');
    expect(interview.related.labs).toEqual([
      { title: 'A lab', url: '/azure/education/labs/a-lab' },
    ]);
  });

  it('accepts the smallest valid file: a title, a date, a guest and one question', () => {
    const interview = normalizeInterview(
      {
        title: 'Small',
        date: '2026-01-31',
        guest: { name: 'G' },
        qa: [{ q: 'Q?', a: 'A.' }],
      },
      'small'
    );
    expect(interview.subtitle).toBe('');
    expect(interview.bio).toBe('');
    expect(interview.image).toBeNull();
    expect(interview.tags).toEqual([]);
    expect(interview.related).toEqual({ labs: [], learn: [] });
  });

  it('trims the text it keeps', () => {
    const interview = makeInterview('a-test-interview', { title: '  Padded title  ' });
    expect(interview.title).toBe('Padded title');
  });

  it('names the file and the field when something is wrong', () => {
    reject({ title: undefined }).toThrow('a-test-interview.json: title is missing.');
    reject({ guest: { role: 'no name' } }).toThrow('a-test-interview.json: guest name is missing.');
    reject({ qa: [] }).toThrow(/qa must be a list with at least one question and answer/);
    reject({ qa: [{ q: 'Only a question' }] }).toThrow('qa[1] a is missing.');
  });

  it('throws an InterviewError, so a build log can tell it from a crash', () => {
    reject({ title: undefined }).toThrow(InterviewError);
  });

  it.each([
    ['2026-13-01', /not a real date/],
    ['2026-02-30', /not a real date/],
    ['01/10/2026', /written YYYY-MM-DD/],
    ['2026-10-1', /written YYYY-MM-DD/],
  ])('refuses the date %s', (date, message) => {
    reject({ date }).toThrow(message);
  });

  it('accepts a real leap day and refuses a false one', () => {
    expect(makeInterview('leap', { date: '2028-02-29' }).date).toBe('2028-02-29');
    reject({ date: '2026-02-29' }).toThrow(/not a real date/);
  });

  it.each(['Not A Slug', 'under_score', 'Capital', '-lead', 'trail-', 'a--b', ''])(
    'refuses the file name %j',
    (slug) => {
      expect(() => normalizeInterview(rawInterview(), slug)).toThrow(
        /file name must be lower-case/
      );
    }
  );

  it('refuses tags that are not lower-case words joined by hyphens', () => {
    reject({ tags: ['Landing Zones'] }).toThrow(/tags\[1\] must be lower-case words/);
    reject({ tags: 'landing-zones' }).toThrow(/tags must be a list/);
  });

  it('requires a description for a picture, so it is never silent to a screen reader', () => {
    reject({ image: { src: '/images/x.jpg' } }).toThrow(/image alt/);
    reject({ image: { src: '/images/x.jpg', alt: '   ' } }).toThrow(/image alt/);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.example/x',
    'http://plain.example/x',
    'ftp://example.com',
    '/path\\with-backslash',
    '/with space',
    'relative/path',
    '',
  ])('refuses the link %j in the related lists and in the picture', (url) => {
    reject({ related: { labs: [{ title: 'Bad', url }] } }).toThrow(
      /url must be an address on this site/
    );
    reject({ image: { src: url, alt: 'x' } }).toThrow(/image src must be an address on this site/);
  });

  it('bounds the sizes it accepts, so one file cannot make a monster page', () => {
    reject({ title: 'x'.repeat(161) }).toThrow(/title is 161 characters; the most is 160/);
    reject({ qa: [{ q: 'Q?', a: 'a'.repeat(6001) }] }).toThrow(/qa\[1\] a is 6001 characters/);
    reject({ qa: Array.from({ length: 41 }, () => ({ q: 'Q?', a: 'A.' })) }).toThrow(
      /more than 40 questions/
    );
  });

  it('does not treat markup as anything special: it is kept as plain text', () => {
    const interview = makeInterview('a-test-interview', {
      qa: [{ q: 'Is <b>this</b> bold?', a: '<img src=x onerror=alert(1)>' }],
    });
    expect(interview.qa[0].a).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('safeLink and isExternalLink', () => {
  it('accepts a path on this site and an https address', () => {
    expect(safeLink('/azure/education')).toBe('/azure/education');
    expect(safeLink('https://learn.microsoft.com/x?y=1#z')).toBe(
      'https://learn.microsoft.com/x?y=1#z'
    );
  });

  it('says which of the two leaves the site', () => {
    expect(isExternalLink('https://learn.microsoft.com/')).toBe(true);
    expect(isExternalLink('/azure/education')).toBe(false);
  });

  it.each([null, undefined, 42, {}, [], 'https://', 'https:///no-host'])('refuses %j', (value) => {
    expect(safeLink(value)).toBeNull();
  });
});

describe('ordering, summary and dates', () => {
  it('sorts newest first and keeps a steady order within a day', () => {
    const list = [
      makeInterview('b-second', { date: '2026-05-01' }),
      makeInterview('a-first', { date: '2026-05-01' }),
      makeInterview('c-newest', { date: '2026-09-01' }),
      makeInterview('d-oldest', { date: '2025-01-01' }),
    ];
    expect(sortInterviews(list).map((i) => i.slug)).toEqual([
      'c-newest',
      'a-first',
      'b-second',
      'd-oldest',
    ]);
  });

  it('does not change the list it is given', () => {
    const list = [
      makeInterview('a-b', { date: '2026-01-01' }),
      makeInterview('c-d', { date: '2027-01-01' }),
    ];
    sortInterviews(list);
    expect(list.map((i) => i.slug)).toEqual(['a-b', 'c-d']);
  });

  it('summarises with the bio, then the first answer, then the title, and cuts at a word', () => {
    expect(interviewSummary(makeInterview())).toBe('Test Guest exists only in the test suite.');
    const noBio = makeInterview('x-y', { bio: undefined });
    expect(interviewSummary(noBio)).toBe('The first answer, which is a plain sentence.');
    const long = makeInterview('x-z', { bio: `${'word '.repeat(100)}` });
    const short = interviewSummary(long, 40);
    expect(short.length).toBeLessThanOrEqual(40);
    expect(short.endsWith('…')).toBe(true);
  });

  it('formats the date the file says, whatever the reader time zone is', () => {
    expect(formatInterviewDate('2026-10-01')).toBe('1 October 2026');
    expect(formatInterviewDate('2026-12-31')).toBe('31 December 2026');
  });

  it('builds the address of an interview, encoded', () => {
    expect(interviewPath('azure-landing-zones-2026')).toBe(
      '/azure/interviews/azure-landing-zones-2026'
    );
  });
});

describe('buildBookPages', () => {
  const kinds = (interview) => buildBookPages(interview).map((page) => page.kind);

  it('starts with the cover and ends with the back cover', () => {
    const pages = buildBookPages(makeInterview());
    expect(pages[0].kind).toBe('cover');
    expect(pages.at(-1).kind).toBe('end');
  });

  it('has one page per question, numbered', () => {
    const qa = buildBookPages(makeInterview()).filter((page) => page.kind === 'qa');
    expect(qa.map((page) => [page.number, page.total])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('always has an even number of pages, adding one blank page when it must', () => {
    for (let questions = 1; questions <= 6; questions += 1) {
      for (const withRelated of [true, false]) {
        for (const withBio of [true, false]) {
          const interview = makeInterview('x-y', {
            bio: withBio ? 'A bio.' : undefined,
            guest: { name: 'G' },
            tags: [],
            qa: Array.from({ length: questions }, (_, i) => ({ q: `Q${i}?`, a: 'A.' })),
            related: withRelated ? rawInterview().related : {},
          });
          const pages = buildBookPages(interview);
          expect(pages.length % 2).toBe(0);
          expect(pages.at(-1).kind).toBe('end');
          // No blank page unless it was needed to make the count even.
          const blanks = pages.filter((page) => page.kind === 'blank').length;
          expect(blanks).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('leaves out the guest page and the related page when there is nothing for them', () => {
    const bare = makeInterview('x-y', {
      bio: undefined,
      guest: { name: 'G' },
      tags: [],
      related: {},
    });
    expect(kinds(bare)).not.toContain('bio');
    expect(kinds(bare)).not.toContain('related');
    expect(kinds(makeInterview())).toEqual(expect.arrayContaining(['bio', 'related']));
  });

  it('carries every question and answer into the pages, so the book misses nothing', () => {
    const interview = makeInterview();
    const text = JSON.stringify(buildBookPages(interview));
    for (const item of interview.qa) {
      expect(text).toContain(item.q);
      expect(text).toContain(item.a);
    }
  });
});

describe('the spreads of a book', () => {
  const pages = buildBookPages(makeInterview()); // cover, bio, 3 questions, related, blank?, end

  it('has one leaf per two pages and as many spreads as leaves, plus the closed start', () => {
    expect(leafCount(pages)).toBe(pages.length / 2);
    expect(lastSpread(pages)).toBe(leafCount(pages));
  });

  it('shows the cover alone on the right when closed, and the back cover alone on the left when finished', () => {
    expect(visiblePageIndexes(0, pages)).toEqual([0]);
    expect(visiblePageIndexes(lastSpread(pages), pages)).toEqual([pages.length - 1]);
  });

  it('shows two facing pages in between, left then right', () => {
    expect(visiblePageIndexes(1, pages)).toEqual([1, 2]);
    expect(visiblePageIndexes(2, pages)).toEqual([3, 4]);
  });

  it('shows every page exactly once across the whole book', () => {
    const seen = [];
    for (let spread = 0; spread <= lastSpread(pages); spread += 1) {
      seen.push(...visiblePageIndexes(spread, pages));
    }
    expect(seen.sort((a, b) => a - b)).toEqual(pages.map((_, index) => index));
  });

  it('stays inside the book when asked for a spread beyond either end', () => {
    expect(visiblePageIndexes(-4, pages)).toEqual(visiblePageIndexes(0, pages));
    expect(visiblePageIndexes(99, pages)).toEqual(visiblePageIndexes(lastSpread(pages), pages));
  });

  it('tells a screen reader where it is, counting only the inside pages', () => {
    expect(spreadStatus(0, pages)).toBe('Cover.');
    expect(spreadStatus(lastSpread(pages), pages)).toBe('Back cover.');
    expect(spreadStatus(1, pages)).toBe(`Pages 1 and 2 of ${pages.length - 2}.`);
    expect(spreadStatus(2, pages)).toBe(`Pages 3 and 4 of ${pages.length - 2}.`);
  });
});
