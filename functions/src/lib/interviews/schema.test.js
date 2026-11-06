/**
 * The interview shape on the server (ADR 0040 D4): the same limits the page
 * enforces, pinned against the frontend source so the two cannot drift,
 * and the two validators' refusals.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIMITS, INTERVIEW_FIELDS, safeLink, validateInterviewFields, validateQa } from './schema.js';

const FRONTEND = fileURLToPath(new URL('../../../../frontend/src/lib/interviews.js', import.meta.url));

describe('the limits are the frontend’s', () => {
  const source = readFileSync(FRONTEND, 'utf8');
  const constant = (name) => {
    const match = source.match(new RegExp(`const ${name} = (\\d+);`));
    if (!match) throw new Error(`frontend/src/lib/interviews.js no longer declares ${name}; update this test's reader, not the limits`);
    return Number(match[1]);
  };

  it.each([
    ['MAX_TITLE', 'MAX_TITLE'],
    ['MAX_SHORT', 'MAX_SHORT'],
    ['MAX_ANSWER', 'MAX_ANSWER'],
    ['MAX_QA', 'MAX_QA'],
    ['MAX_LINKS', 'MAX_LINKS'],
  ])('%s matches frontend/src/lib/interviews.js', (ours, theirs) => {
    expect(LIMITS[ours]).toBe(constant(theirs));
  });

  it('the slug and tag rules and the link rule read the same', () => {
    expect(source).toContain("const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;");
    expect(source).toContain("const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;");
    for (const [url, expected] of [
      ['/azure/labs', '/azure/labs'],
      ['//evil.example/x', null],
      ['https://learn.microsoft.com/azure', 'https://learn.microsoft.com/azure'],
      ['http://learn.microsoft.com/azure', null],
      ['https:///host', null],
      ['javascript:alert(1)', null],
      ['data:text/html,x', null],
      ['https://a.example/with space', null],
      [42, null],
    ]) {
      expect(safeLink(url), String(url)).toBe(expected);
    }
  });
});

describe('validateQa', () => {
  const item = (over = {}) => ({ q: 'Why Azure?', a: 'Because the estate was already there.', pullQuote: '', ...over });

  it('trims, keeps an optional pull quote and the review flag, and bounds the list', () => {
    const result = validateQa([item({ q: '  Why Azure? ', needsReview: true }), item({ pullQuote: 'already there' })]);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([
      { q: 'Why Azure?', a: 'Because the estate was already there.', pullQuote: '', needsReview: true },
      { q: 'Why Azure?', a: 'Because the estate was already there.', pullQuote: 'already there' },
    ]);
    expect(validateQa([item({ needsReview: 'yes' })]).value[0].needsReview).toBeUndefined();
  });

  it('refuses an empty list, too many items, a missing field and an over-long one, naming the item', () => {
    expect(validateQa([])).toMatchObject({ ok: false, error: expect.stringMatching(/at least one/) });
    expect(validateQa(null)).toMatchObject({ ok: false });
    expect(validateQa(Array.from({ length: LIMITS.MAX_QA + 1 }, () => item()))).toMatchObject({
      ok: false,
      error: `qa has more than ${LIMITS.MAX_QA} questions.`,
    });
    expect(validateQa([item(), { q: 'x' }])).toMatchObject({ ok: false, error: 'qa[2] a is missing.' });
    expect(validateQa([item({ q: 'q'.repeat(LIMITS.MAX_SHORT + 1) })])).toMatchObject({
      ok: false,
      error: `qa[1] q is ${LIMITS.MAX_SHORT + 1} characters; the most is ${LIMITS.MAX_SHORT}.`,
    });
    expect(validateQa([item({ a: 'a'.repeat(LIMITS.MAX_ANSWER + 1) })])).toMatchObject({ ok: false, error: expect.stringMatching(/qa\[1\] a is/) });
    expect(validateQa([item({ pullQuote: 'p'.repeat(LIMITS.MAX_SHORT + 1) })])).toMatchObject({ ok: false, error: expect.stringMatching(/pullQuote/) });
    expect(validateQa(['not an object'])).toMatchObject({ ok: false, error: 'qa[1] must have a q and an a.' });
    expect(validateQa([item({ a: 42 })])).toMatchObject({ ok: false, error: 'qa[1] a must be text.' });
  });
});

describe('validateInterviewFields', () => {
  it('accepts every public field within the limits and normalises them', () => {
    const result = validateInterviewFields({
      slug: 'azure-landing-zones-2026',
      title: ' Landing zones ',
      subtitle: '',
      date: '2026-11-05',
      guest: { name: 'Alex Example', role: '' },
      bio: 'Runs an estate.',
      image: { src: '/media/covers/x.png', alt: 'Alex at a desk' },
      tags: ['landing-zones'],
      qa: [{ q: 'Q?', a: 'A.' }],
      related: { labs: [{ title: 'Lab', url: '/azure/labs/x' }], learn: null },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        slug: 'azure-landing-zones-2026',
        title: 'Landing zones',
        subtitle: '',
        date: '2026-11-05',
        guest: { name: 'Alex Example', role: '' },
        bio: 'Runs an estate.',
        image: { src: '/media/covers/x.png', alt: 'Alex at a desk' },
        tags: ['landing-zones'],
        qa: [{ q: 'Q?', a: 'A.', pullQuote: '' }],
        related: { labs: [{ title: 'Lab', url: '/azure/labs/x' }], learn: [] },
      },
    });
    expect(validateInterviewFields({ image: null, related: undefined })).toEqual({
      ok: true,
      value: { image: null, related: { labs: [], learn: [] } },
    });
    expect(INTERVIEW_FIELDS).toEqual(['slug', 'title', 'subtitle', 'date', 'guest', 'bio', 'image', 'tags', 'qa', 'related']);
  });

  it('refuses a field it does not name, so the private blocks are never written through an update', () => {
    for (const key of ['consent', 'provenance', 'interview', 'transcription', 'contentStatus', 'Live', '__proto__']) {
      expect(validateInterviewFields({ [key]: {} }), key).toMatchObject({ ok: false, error: `${key} is not a field an interview has.` });
    }
    expect(validateInterviewFields(['title'])).toMatchObject({ ok: false, error: 'The update must be an object of fields.' });
    expect(validateInterviewFields(null)).toMatchObject({ ok: false });
  });

  it('refuses each bad value with the frontend’s sentence', () => {
    const bad = (partial) => validateInterviewFields(partial);
    expect(bad({ slug: 'Not A Slug' })).toMatchObject({ ok: false, error: 'slug must be lower-case words joined by hyphens.' });
    expect(bad({ title: 't'.repeat(LIMITS.MAX_TITLE + 1) })).toMatchObject({ ok: false, error: expect.stringMatching(/^title is 161 characters/) });
    expect(bad({ title: '' })).toMatchObject({ ok: false, error: 'title is missing.' });
    expect(bad({ date: '2026-13-01' })).toMatchObject({ ok: false, error: 'date is not a real date.' });
    expect(bad({ date: '5 Nov 2026' })).toMatchObject({ ok: false, error: 'date must be a date written YYYY-MM-DD.' });
    expect(bad({ guest: 'Alex' })).toMatchObject({ ok: false, error: 'guest must have a name and, if you like, a role.' });
    expect(bad({ guest: { role: 'x' } })).toMatchObject({ ok: false, error: 'guest name is missing.' });
    expect(bad({ image: { src: 'http://x.example/a.png', alt: 'a' } })).toMatchObject({ ok: false, error: expect.stringMatching(/^image src must be/) });
    expect(bad({ image: { src: '/a.png' } })).toMatchObject({ ok: false, error: 'image alt (what the picture shows) is missing.' });
    expect(bad({ image: 'x' })).toMatchObject({ ok: false, error: 'image must have a src and an alt.' });
    expect(bad({ tags: 'landing-zones' })).toMatchObject({ ok: false, error: 'tags must be a list.' });
    expect(bad({ tags: ['Landing Zones'] })).toMatchObject({ ok: false, error: expect.stringMatching(/^tags\[1\] must be lower-case/) });
    expect(bad({ tags: Array.from({ length: LIMITS.MAX_TAGS + 1 }, () => 'a') })).toMatchObject({ ok: false, error: expect.stringMatching(/more than/) });
    expect(bad({ related: { labs: 'x' } })).toMatchObject({ ok: false, error: 'related.labs must be a list.' });
    expect(bad({ related: 'x' })).toMatchObject({ ok: false, error: 'related must have labs and learn lists.' });
    expect(bad({ related: { labs: Array.from({ length: LIMITS.MAX_LINKS + 1 }, () => ({ title: 't', url: '/x' })) } })).toMatchObject({
      ok: false,
      error: `related.labs has more than ${LIMITS.MAX_LINKS} links.`,
    });
    expect(bad({ related: { learn: [{ title: 't', url: 'javascript:x' }] } })).toMatchObject({ ok: false, error: expect.stringMatching(/^related\.learn\[1\] url must be/) });
    expect(bad({ related: { learn: ['x'] } })).toMatchObject({ ok: false, error: 'related.learn[1] must have a title and a url.' });
    expect(bad({ qa: [] })).toMatchObject({ ok: false, error: 'qa must be a list with at least one question and answer.' });
  });
});
