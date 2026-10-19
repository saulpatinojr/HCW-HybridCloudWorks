import { describe, expect, it } from 'vitest';
import { eligibleCerts } from './study-guide-eligibility.mjs';

/**
 * Which exams the refresher fetches a guide for: the ones a visitor can still
 * book on `today`, judged as the page judges them (deriveStatus), not as the
 * file stores them. #1091 stores a status read ahead of the vendor's day with
 * the day still to come; the 2026-10-19 run read the stored `retired` and
 * deleted PL-400's outline eleven days before its last exam day.
 */
describe('eligibleCerts', () => {
  const guide =
    'https://learn.microsoft.com/credentials/certifications/resources/study-guides/pl-400';
  const pl400 = {
    code: 'PL-400',
    status: 'retired',
    expiryDate: '2026-10-30',
    statusReadDate: '2026-10-12',
    replacedBy: 'ab-400',
    studyGuideUrl: guide,
  };
  const az800 = {
    code: 'AZ-800',
    status: 'retired',
    retiredDate: '2026-09-30',
    expiryDate: '2026-09-30',
    studyGuideUrl: guide.replace('pl-400', 'az-800'),
  };
  const az204 = {
    code: 'AZ-204',
    status: 'active',
    studyGuideUrl: guide.replace('pl-400', 'az-204'),
  };
  const noGuide = { code: 'AI-900', status: 'active' };

  it('keeps an exam stored retired ahead of its day until that day, then drops it', () => {
    expect(eligibleCerts([pl400], '2026-10-19').map((c) => c.code)).toEqual(['PL-400']);
    expect(eligibleCerts([pl400], '2026-10-30').map((c) => c.code)).toEqual(['PL-400']);
    expect(eligibleCerts([pl400], '2026-10-31')).toEqual([]);
  });

  it('skips an exam retired after its day, and one with no guide, and keeps a live one', () => {
    expect(eligibleCerts([az800, az204, noGuide], '2026-10-19').map((c) => c.code)).toEqual([
      'AZ-204',
    ]);
  });
});
