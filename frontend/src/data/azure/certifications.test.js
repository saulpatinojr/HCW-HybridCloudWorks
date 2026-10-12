/**
 * The Azure catalogue is a hand-synced file, and "Old info is a no-no for
 * Learn sites" (owner, #461). These tests turn that rule into a red build:
 * a stored status that its own dates contradict fails here on the day it
 * goes stale, rather than printing "Expiring Soon" for ten weeks (#461).
 */
import { describe, expect, it } from 'vitest';
import { DATA_AS_OF, appliedSkills, certifications, timelineEvents } from './certifications';
import { CERT_DATE_FIELDS, findStaleStatuses, todayIso } from '@/lib/certStatus';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe('Azure certification data', () => {
  it('stamps the day it was last checked against Microsoft', () => {
    expect(DATA_AS_OF).toMatch(ISO_DATE);
    expect(DATA_AS_OF <= todayIso()).toBe(true);
  });

  it('has no certification whose stored status its dates contradict today', () => {
    // Fails the day a stored 'expiring' or 'beta' outlives its date. The fix
    // is to re-verify against Microsoft Learn, update the status and move
    // DATA_AS_OF — see the header of certifications.js for the sources.
    expect(findStaleStatuses(certifications, todayIso())).toEqual([]);
  });

  it('has no applied skill whose stored status its dates contradict today', () => {
    expect(findStaleStatuses(appliedSkills, todayIso())).toEqual([]);
  });

  it('uses ISO dates everywhere a date is stored', () => {
    for (const cert of certifications) {
      for (const field of ['expiryDate', 'betaEndDate', 'gaDate']) {
        if (cert[field] !== undefined) {
          expect(cert[field], `${cert.code}.${field}`).toMatch(ISO_DATE);
        }
      }
    }
    for (const event of timelineEvents) {
      expect(event.date, event.id).toMatch(ISO_DATE);
    }
  });

  it('keeps retired exams with their retirement date, and names the replacement when known', () => {
    const retired = certifications.filter((c) => c.status === 'retired');
    // The ten Microsoft retired between 2026-06-30 and 2026-08-31, plus MB-240
    // (retired 2026-06-30), SC-730 (withdrawn after its beta, no date), and
    // AZ-800 and AZ-801 (retired 2026-09-30, re-read 2026-10-01 for #770),
    // and PL-400, stored ahead of its 2026-10-30 last day (statusReadDate
    // 2026-10-12, #1091) and shown as retiring until then.
    expect(retired.map((c) => c.code).sort()).toEqual([
      'AI-102',
      'AI-900',
      'AZ-204',
      'AZ-500',
      'AZ-800',
      'AZ-801',
      'MB-240',
      'MB-280',
      'MB-335',
      'MB-700',
      'PL-200',
      'PL-400',
      'PL-500',
      'PL-600',
      'SC-730',
    ]);
    for (const cert of retired) {
      if (cert.code !== 'SC-730') expect(cert.expiryDate, cert.code).toMatch(ISO_DATE);
    }
    const bySlug = new Map(certifications.map((c) => [c.slug, c]));
    expect(bySlug.get('ai-102').replacedBy).toBe('ai-103');
    expect(bySlug.get('ai-900').replacedBy).toBe('ai-901');
  });

  it('marks AZ-800 and AZ-801 as retired on 2026-09-30 in favour of AZ-802 (#770)', () => {
    const byCode = new Map(certifications.map((c) => [c.code, c]));
    for (const code of ['AZ-800', 'AZ-801']) {
      expect(byCode.get(code).status, code).toBe('retired');
      expect(byCode.get(code).retiredDate, code).toBe('2026-09-30');
      expect(byCode.get(code).expiryDate, code).toBe('2026-09-30');
      expect(byCode.get(code).replacedBy, code).toBe('az-802');
    }
    expect(byCode.get('AZ-802')).toBeDefined();
    expect(byCode.get('AZ-802').status).toBe('active');
  });

  it('leaves AZ-802 undated, so the successor to both cannot itself go stale (#494)', () => {
    // Owner, 2026-09-11: AZ-802 becomes the single test for AZ-800 and AZ-801.
    // That is what lets #494 close the Azure half without a vendor round-trip
    // on 2026-10-01. The successor is not a third row to revisit later — it is
    // `active` and carries no date at all, so `findStaleStatuses` can never
    // name it. Both retiring rows already point at it, asserted above.
    //
    // The day Microsoft does put a date on AZ-802 this fails, which is the
    // right moment to look: a dated successor is a new obligation, and the
    // alternative is discovering it from a red build months later with no
    // record of why anyone expected it to be undated.
    const az802 = certifications.find((c) => c.code === 'AZ-802');
    const dated = CERT_DATE_FIELDS.filter(
      (field) => az802[field] !== undefined && az802[field] !== null
    );

    expect(dated, 'AZ-802 has grown a dated field — see the comment above').toEqual([]);
    expect(findStaleStatuses([az802], '2027-12-31')).toEqual([]);
  });

  it('has unique ids, slugs and codes', () => {
    for (const field of ['id', 'slug', 'code']) {
      const values = certifications.map((c) => c[field]);
      expect(new Set(values).size, field).toBe(values.length);
    }
  });

  it('points every replacedBy and nextCerts at a slug that exists', () => {
    const slugs = new Set(certifications.map((c) => c.slug));
    for (const cert of certifications) {
      if (cert.replacedBy) expect(slugs.has(cert.replacedBy), `${cert.code}.replacedBy`).toBe(true);
      for (const next of cert.nextCerts || []) {
        expect(slugs.has(next), `${cert.code}.nextCerts → ${next}`).toBe(true);
      }
    }
  });

  it('never points a replacement at a retired certification', () => {
    const bySlug = new Map(certifications.map((c) => [c.slug, c]));
    for (const cert of certifications) {
      if (cert.replacedBy) {
        expect(bySlug.get(cert.replacedBy).status, `${cert.code} → ${cert.replacedBy}`).not.toBe(
          'retired'
        );
      }
    }
  });
});
