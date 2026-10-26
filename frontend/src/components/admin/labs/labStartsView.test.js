/**
 * The words on the lab sessions started card and in the sentence for a letter
 * (labStartsView.js). What must hold: the sentence carries the real numbers and
 * the date range, says "sessions" and not "learners", says where counting began,
 * names no vendor, and is empty (so nothing is copied) when the answer cannot be
 * trusted.
 */
import { describe, expect, it } from 'vitest';
import { labs } from '@/data/labs/catalogue';
import {
  describeLabStarts,
  formatDay,
  labTitle,
  letterSentence,
  readLabStarts,
} from './labStartsView';

const LAB = labs.find((lab) => lab.id === 'terraform-validate-walkthrough');

const read = (over = {}) => ({
  since: '2026-10-26',
  today: '2026-11-09',
  counts: { today: 2, last7: 9, last30: 14, total: 14 },
  perLab: [
    { labId: 'terraform-validate-walkthrough', today: 1, last7: 6, last30: 10, total: 10 },
    { labId: 'a-lab-since-removed', today: 1, last7: 3, last30: 4, total: 4 },
  ],
  ...over,
});

describe('formatDay', () => {
  it('writes a day in words and refuses anything else', () => {
    expect(formatDay('2026-10-26')).toBe('26 October 2026');
    expect(formatDay('2027-01-05')).toBe('5 January 2027');
    expect(formatDay('2027-13-05')).toBe('');
    expect(formatDay('26/10/2026')).toBe('');
    expect(formatDay(undefined)).toBe('');
  });
});

describe('letterSentence', () => {
  it('carries the real numbers and the date range', () => {
    const sentence = letterSentence(read());
    expect(sentence).toContain('From 26 October 2026 to 9 November 2026');
    expect(sentence).toContain('14 lab sessions were started for visitors');
    expect(sentence).toContain('9 of them in the last 7 days');
    expect(sentence).toContain('14 in the last 30 days');
  });

  it('says where counting began and that nothing earlier is in it', () => {
    expect(letterSentence(read())).toContain(
      'Counting began on 26 October 2026, so nothing earlier is included.'
    );
  });

  it('says sessions, not people, and never promises learners', () => {
    const sentence = letterSentence(read());
    expect(sentence).toMatch(/sessions, not of people/);
    expect(sentence).toMatch(/counted twice/);
    expect(sentence).not.toMatch(/learner/i);
  });

  it('names no vendor, host or product', () => {
    const sentence = letterSentence(read());
    expect(sentence).not.toMatch(
      /coder|hostinger|cloudflare|turnstile|cosmos|azure|github|docker|terraform/i
    );
  });

  it('is singular for one session', () => {
    const sentence = letterSentence(read({ counts: { today: 1, last7: 1, last30: 1, total: 1 } }));
    expect(sentence).toContain('1 lab session was started for visitors');
    expect(sentence).toContain('1 of them in the last 7 days and 1 in the last 30 days');
  });

  it('says none were started when none were, rather than "0 of them"', () => {
    const sentence = letterSentence(read({ counts: { today: 0, last7: 0, last30: 0, total: 0 } }));
    expect(sentence).toContain('no lab sessions were started for visitors');
    expect(sentence).not.toContain('of them');
  });

  it('reads "On <day>" when counting began today', () => {
    const sentence = letterSentence(
      read({ today: '2026-10-26', counts: { today: 3, last7: 3, last30: 3, total: 3 } })
    );
    expect(sentence.startsWith('On 26 October 2026, 3 lab sessions were started')).toBe(true);
    expect(sentence).not.toContain('From 26 October 2026 to');
  });

  it('is empty when the answer cannot be trusted, so nothing is copied', () => {
    expect(letterSentence(null)).toBe('');
    expect(letterSentence({})).toBe('');
    expect(letterSentence(read({ since: 'soon' }))).toBe('');
    expect(letterSentence(read({ counts: { today: 1, last7: '9', last30: 14, total: 14 } }))).toBe(
      ''
    );
    expect(letterSentence(read({ counts: { today: -1, last7: 9, last30: 14, total: 14 } }))).toBe(
      ''
    );
  });
});

describe('readLabStarts and describeLabStarts', () => {
  it('refuses an answer without the counts', () => {
    expect(readLabStarts({ since: '2026-10-26', today: '2026-10-26' })).toBeNull();
    expect(describeLabStarts({ error: 'x' })).toBeNull();
  });

  it('lays the four figures out in order', () => {
    const view = describeLabStarts(read());
    expect(view.stats.map((s) => [s.id, s.label, s.value])).toEqual([
      ['today', 'Today', 2],
      ['last7', 'Last 7 days', 9],
      ['last30', 'Last 30 days', 14],
      ['total', 'Total', 14],
    ]);
    expect(view.sinceText).toBe('26 October 2026');
  });

  it('titles a lab from the catalogue and falls back to its id', () => {
    expect(labTitle('terraform-validate-walkthrough')).toBe(LAB.title);
    expect(labTitle('a-lab-since-removed')).toBe('a-lab-since-removed');
    const { rows } = describeLabStarts(read());
    expect(rows.map((r) => r.title)).toEqual([LAB.title, 'a-lab-since-removed']);
  });

  it('drops a per-lab row that is not made of counts', () => {
    const view = describeLabStarts(
      read({
        perLab: [
          { labId: 'ok-lab', today: 0, last7: 1, last30: 1, total: 1 },
          { labId: 'bad-lab', today: 'x', last7: 1, last30: 1, total: 1 },
          null,
        ],
      })
    );
    expect(view.rows.map((r) => r.labId)).toEqual(['ok-lab']);
  });
});
