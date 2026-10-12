/**
 * Every Learn catalogue this repository hand-maintains is checked here against
 * the calendar (#461, owner rule: "Old info is a no-no for Learn sites").
 *
 * WHY THIS EXISTS. The 2026-09-09 audit found the Azure page showing ten
 * exams as "expiring" ten weeks after Microsoft retired them, AWS listing
 * SOA-C02 under the CloudOps name a year after SOA-C03 replaced it, GitHub
 * with three exam codes on the wrong titles, Terraform advertising an exam
 * HashiCorp retired in July, and GCP missing five of Google's fourteen
 * certifications. None of it failed anything: a hand-typed `status` is a
 * claim with no date attached, and nothing ever compared it to today.
 *
 * Now the pages derive what they render from the dates (`@/lib/certStatus`),
 * so a card cannot say "expiring" after the last test day. What this test
 * adds is the alarm: the moment an `expiring`, `beta` or `upcoming` row's date
 * is in the past, the suite goes red until someone re-verifies the row
 * against the vendor and updates it.
 *
 * It no longer arrives unannounced. `frontend/scripts/catalogue-due-soon.mjs`
 * asks `findStatusesDueWithin` which rows this test will name in the next 21
 * days, and the Monday `warn-catalogue-due.yml` run keeps one issue on the
 * board listing them, so each re-verification is scheduled weeks before the
 * build goes red rather than discovered by it (#818). The rows due next are in
 * that issue, not here: a list in this comment went stale the day MLA-C01
 * fired.
 *
 * Deliberately uses the real clock. A frozen date would make the assertion
 * vacuous — the point is that the repository notices when the world moves.
 *
 * Azure's catalogue has the same check in `azure/certifications.test.js`
 * (#464); both run through the one `findStaleStatuses` in `@/lib/certStatus`.
 *
 * Azure joined `CATALOGUES` here with #496, which is what made the DATA_SOURCE
 * assertion below cover all eight. Until then it was the one catalogue outside
 * this list, so it was the one catalogue that could omit `DATA_SOURCE` without
 * failing a build — and it did, from #461 until #496. Its own test file stayed:
 * it carries the Azure-only rows (applied skills, retirement replacements) that
 * do not generalise, and duplicating the shared assertions costs nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  CERT_DATE_FIELDS,
  deriveStatus,
  findStaleStatuses,
  isIsoDate,
  todayIso,
} from '@/lib/certStatus';
// The one list, shared with the early warning (scripts/catalogue-due-soon.mjs,
// #818), so the alarm and the warning always cover the same catalogues.
import { CATALOGUES } from '@/data/catalogues';

const { aws, azure, gcp, github, terraform, vmware } = CATALOGUES;

describe.each(Object.entries(CATALOGUES))('%s certification catalogue', (provider, mod) => {
  const { certifications, DATA_AS_OF, DATA_SOURCE } = mod;

  it('states the day it was last checked against the vendor, and that day is not in the future', () => {
    expect(isIsoDate(DATA_AS_OF), `${provider} DATA_AS_OF must be YYYY-MM-DD`).toBe(true);
    expect(DATA_AS_OF <= todayIso(), `${provider} DATA_AS_OF is in the future`).toBe(true);
    expect(DATA_SOURCE?.label, `${provider} DATA_SOURCE.label`).toBeTruthy();
    expect(DATA_SOURCE?.url, `${provider} DATA_SOURCE.url`).toMatch(/^https:\/\//);
  });

  it('has no row whose stored status its dates have already overtaken', () => {
    const stale = findStaleStatuses(certifications, todayIso());
    expect(
      stale,
      `${provider}: re-verify these rows against ${DATA_SOURCE?.url} and update the catalogue`
    ).toEqual([]);
  });

  it('keeps every dated field as YYYY-MM-DD, and uses no dated field the shared list does not know', () => {
    // Both directions of the contract with `findStaleStatuses`: every value
    // in a listed field is a calendar day, and no row carries a *Date field
    // outside CERT_DATE_FIELDS — a new field would otherwise skip the check.
    for (const cert of certifications) {
      for (const field of CERT_DATE_FIELDS) {
        if (cert[field] !== undefined && cert[field] !== null) {
          expect(isIsoDate(cert[field]), `${provider} ${cert.code} ${field}`).toBe(true);
        }
      }
      const unlisted = Object.keys(cert).filter(
        (key) => /(Date|Opens)$/.test(key) && !CERT_DATE_FIELDS.includes(key)
      );
      expect(unlisted, `${provider} ${cert.code} has dated fields not in CERT_DATE_FIELDS`).toEqual(
        []
      );
    }
  });

  it('has unique codes and slugs, and a learn URL on every row', () => {
    const codes = certifications.map((c) => c.code);
    const slugs = certifications.map((c) => c.slug);
    expect(new Set(codes).size, `${provider} duplicate codes`).toBe(codes.length);
    expect(new Set(slugs).size, `${provider} duplicate slugs`).toBe(slugs.length);
    for (const cert of certifications) {
      expect(cert.learnUrl, `${provider} ${cert.code} learnUrl`).toMatch(/^https:\/\//);
      expect(cert.title, `${provider} ${cert.code} title`).toBeTruthy();
      expect(cert.level, `${provider} ${cert.code} level`).toBeTruthy();
    }
  });

  it('names a replacement that exists in the same catalogue', () => {
    const slugs = new Set(certifications.map((c) => c.slug));
    for (const cert of certifications) {
      if (!cert.replacement) continue;
      expect(cert.replacement.code, `${provider} ${cert.code} replacement.code`).toBeTruthy();
      if (cert.replacement.slug) {
        expect(
          slugs.has(cert.replacement.slug),
          `${provider} ${cert.code} names replacement ${cert.replacement.slug}, which is not in the catalogue`
        ).toBe(true);
      }
    }
  });
});

/**
 * #494: the rows whose dates pass at the end of September 2026.
 *
 * The alarm above is deliberately tied to the real clock, so it says nothing
 * about a date until that date arrives — which leaves the interesting question
 * unanswerable on any day before it: when 2026-09-30 passes, does the site tell
 * a reader something false, or does it merely stop being able to prove itself?
 *
 * These pin the answer at a fixed future day, so it is known now rather than
 * discovered by a red build. Two facts, and they point opposite ways:
 *
 *   THE PAGES DO NOT LIE. `deriveStatus` reads the dates at render time, so on
 *   2026-10-01 AZ-800 and AZ-801 render `retired` and PAA renders `upcoming`
 *   without anyone touching a file. Whatever the stored `status` says, no
 *   visitor is shown a retired exam as testable or a closed beta as open.
 *
 *   THE CLAIMS GO UNPROVABLE ANYWAY, which is what the alarm is for. A stored
 *   `status` that its own dates have overtaken is a claim nobody has rechecked
 *   against the vendor, and the vendor is the only thing that can say what the
 *   credential became. So the suite goes red and names the rows.
 *
 * #494's own table listed three rows and missed one: AZ-800 carries the same
 * `expiryDate` 2026-09-30 and the same `replacedBy: 'az-802'` as AZ-801, so it
 * trips in the same breath. The count was the check on that — four rows
 * across three catalogues, not the one the issue expected a person to fix.
 *
 * 2026-10-01 (#770): the day came and each vendor was re-read. Microsoft
 * retired AZ-800 and AZ-801 as announced; Google's PAA page still published no
 * GA date, so PAA is stored `upcoming` with no date. The stored statuses now
 * agree with what `deriveStatus` showed on the day, so the list of overtaken
 * rows is empty, and these tests now pin that the re-verified rows say what
 * the vendors said rather than what their old dates implied.
 */
describe('the rows dated 2026-09-30 (#494)', () => {
  const AFTER = '2026-10-01';

  it('names no row whose dates have been overtaken once the vendors were re-read (#770)', () => {
    const named = Object.entries(CATALOGUES)
      .flatMap(([provider, mod]) =>
        findStaleStatuses(mod.certifications ?? [], AFTER).map((p) => `${provider}: ${p}`)
      )
      .sort();

    // Until 2026-10-01 this listed AZ-800, AZ-801 (expiryDate 2026-09-30) and
    // PAA (betaEndDate 2026-09-30); MLA-C01 (expiryDate 2026-09-28) had left it
    // two days earlier. All three were re-read on the day and are now stored
    // as what their vendors did, so nothing dated 2026-09-30 is left to fire.
    expect(named).toEqual([]);
  });

  it('stores each re-verified row as the vendor left it on 2026-10-01 (#770)', () => {
    const rowFor = (mod, code) => mod.certifications.find((c) => c.code === code);

    for (const code of ['AZ-800', 'AZ-801']) {
      expect(rowFor(azure, code), code).toMatchObject({
        status: 'retired',
        retiredDate: '2026-09-30',
        replacedBy: 'az-802',
      });
    }
    expect(rowFor(azure, 'AZ-802').status).toBe('active');

    // Google published no GA date and no new window: coming, undated, and no
    // longer carrying the beta fields that only a `beta` row reads.
    const paa = rowFor(gcp, 'PAA');
    expect(paa.status).toBe('upcoming');
    for (const field of CERT_DATE_FIELDS) expect(paa[field], `PAA.${field}`).toBeUndefined();
    expect(paa.betaClosesBeforeGa).toBeUndefined();
  });

  it('renders each of them correctly on that day regardless, so no page states something false', () => {
    const rowFor = (mod, code) => mod.certifications.find((c) => c.code === code);

    expect(deriveStatus(rowFor(azure, 'AZ-800'), AFTER)).toBe('retired');
    expect(deriveStatus(rowFor(azure, 'AZ-801'), AFTER)).toBe('retired');
    // Not 'active': Google closes the beta before GA, and the row says so (#770).
    expect(deriveStatus(rowFor(gcp, 'PAA'), AFTER)).toBe('upcoming');
    expect(deriveStatus(rowFor(aws, 'MLA-C01'), AFTER)).toBe('retired');
  });

  it('leaves MLA-C02 alone, because betaStartDate is not a claim about today', () => {
    // #494 called this a false positive: it looks urgent in a date sort
    // (betaStartDate 2026-09-29) but `dateProblems` checks only betaEndDate and
    // gaDate for a beta row, and MLA-C02's gaDate is 2027-01-14. Pinned so the
    // reasoning is enforced rather than restated in prose the next time
    // somebody sorts the catalogue by date and panics.
    const mla = aws.certifications.find((c) => c.code === 'MLA-C02');

    expect(mla.betaStartDate).toBe('2026-09-29');
    expect(findStaleStatuses([mla], AFTER)).toEqual([]);
    expect(deriveStatus(mla, AFTER)).toBe('beta');
    expect(findStaleStatuses([mla], '2027-01-15')).toEqual([
      "MLA-C02: status 'beta' but gaDate 2027-01-14 has been reached",
    ]);
  });
});

/**
 * #496: one exam, one catalogue.
 *
 * GH-100, GH-200, GH-300, GH-500, GH-600 and GH-900 were carried in both the
 * Azure and GitHub catalogues, and four of the six disagreed about the level —
 * GH-200 rendered as Fundamentals under Azure and Associate under GitHub on the
 * same /education screen. Nothing caught it for as long as it existed, because
 * every assertion in this file reads one catalogue at a time; a contradiction
 * between two of them was invisible by construction.
 *
 * Codes rather than levels, deliberately. The level vocabularies are the
 * vendors' own and do not reconcile — AWS says Foundational, Azure Fundamentals,
 * GitHub Foundations for the same rung — so comparing levels across catalogues
 * would need a mapping table that is itself a thing to keep correct. Whereas an
 * exam code is the vendor's identifier: if two catalogues both claim one, the
 * duplication is the defect, whatever the levels happen to say. 122 codes across
 * the eight catalogues when this was written.
 */
describe('one exam, one catalogue (#496)', () => {
  it('has no exam code carried by two providers', () => {
    const owners = new Map();

    for (const [provider, mod] of Object.entries(CATALOGUES)) {
      for (const cert of mod.certifications ?? []) {
        if (!cert.code) continue;
        if (!owners.has(cert.code)) owners.set(cert.code, []);
        owners.get(cert.code).push(`${provider} (${cert.level})`);
      }
    }

    const shared = [...owners.entries()]
      .filter(([, where]) => where.length > 1)
      .map(([code, where]) => `${code}: ${where.join(' and ')}`);

    expect(
      shared,
      'each of these exams is carried by two catalogues — decide which one owns it, as #496 did for the GH-x exams'
    ).toEqual([]);
  });
});

describe('the AWS catalogue feeds the detail page too', () => {
  it('resolves every current slug, every previous slug, and every nextCerts link', () => {
    const slugs = new Set(aws.certifications.map((c) => c.slug));
    for (const cert of aws.certifications) {
      expect(aws.findCertificationBySlug(cert.slug)?.code).toBe(cert.code);
      for (const old of cert.previousSlugs ?? []) {
        expect(
          slugs.has(old),
          `${old} is both a previousSlug of ${cert.code} and a live slug`
        ).toBe(false);
        expect(aws.findCertificationBySlug(old)?.code, `old link /${old}`).toBe(cert.code);
      }
      for (const next of cert.nextCerts ?? []) {
        expect(slugs.has(next), `${cert.code} nextCerts -> ${next}`).toBe(true);
      }
    }
    expect(aws.findCertificationBySlug('soa-c02')?.code).toBe('SOA-C03');
    expect(aws.findCertificationBySlug('no-such-exam')).toBeUndefined();
  });

  it('carries the detail-page fields on every row', () => {
    for (const cert of aws.certifications) {
      expect(typeof cert.longDescription, `${cert.code} longDescription`).toBe('string');
      expect(Array.isArray(cert.modules), `${cert.code} modules`).toBe(true);
      expect(typeof cert.prerequisites, `${cert.code} prerequisites`).toBe('string');
    }
  });
});

describe('the facts the 2026-09-09 audit asked for (#461 items 5–9)', () => {
  const byCode = (mod) => Object.fromEntries(mod.certifications.map((c) => [c.code, c]));

  it('GitHub: each code sits on the title Microsoft Learn schedules it under', () => {
    const gh = byCode(github);
    expect(gh['GH-900']?.title).toBe('GitHub Foundations');
    expect(gh['GH-100']?.title).toBe('GitHub Administration');
    expect(gh['GH-200']?.title).toBe('GitHub Actions');
    expect(gh['GH-300']?.title).toBe('GitHub Copilot');
    expect(gh['GH-500']?.title).toBe('GitHub Advanced Security');
    expect(gh['GH-600']?.title).toBe('GitHub Agentic AI Developer');
  });

  it('AWS: CloudOps is SOA-C03, the three version bumps and ANS-C01 carry their dates', () => {
    const a = byCode(aws);
    expect(a['SOA-C02']).toBeUndefined();
    expect(a['SOA-C03']?.title).toContain('CloudOps');
    expect(a['MLA-C01']).toMatchObject({ status: 'retired', retiredDate: '2026-09-28' });
    expect(a['MLA-C01'].expiryDate).toBeUndefined();
    expect(a['MLA-C02']).toMatchObject({ status: 'beta', gaDate: '2027-01-14' });
    expect(a['SAP-C02']).toMatchObject({ status: 'expiring', expiryDate: '2026-11-16' });
    expect(a['SAP-C03']).toMatchObject({ status: 'upcoming', availableDate: '2026-11-17' });
    expect(a['DVA-C02']).toMatchObject({ status: 'expiring', expiryDate: '2026-11-30' });
    expect(a['DVA-C03']).toMatchObject({ status: 'upcoming', availableDate: '2026-12-01' });
    expect(a['ANS-C01']).toMatchObject({ status: 'expiring', expiryDate: '2026-12-31' });
    expect(a['AIB-C01']).toMatchObject({ status: 'beta', level: 'Business' });
  });

  it('Terraform: 004 not 003, Consul retired, both Advanced credentials present', () => {
    const codes = terraform.certifications.map((c) => c.code);
    expect(codes).not.toContain('TA-003');
    expect(codes).toContain('TA-004');
    expect(terraform.certifications.find((c) => /Consul/.test(c.title))).toMatchObject({
      status: 'retired',
      retiredDate: '2026-07-15',
    });
    const titles = terraform.certifications.map((c) => c.title);
    expect(titles).toContain('HashiCorp Certified: Terraform Authoring and Operations Advanced');
    expect(titles).toContain('HashiCorp Certified: Vault Operations Advanced');
  });

  it('GCP: the five missing credentials are present and Workspace is the Associate one', () => {
    const titles = gcp.certifications.map((c) => c.title);
    for (const title of [
      'Generative AI Leader',
      'Associate Data Practitioner',
      'Associate Google Workspace Administrator',
      'Professional Cloud Database Engineer',
      'Professional Cloud DevOps Engineer',
    ]) {
      expect(titles).toContain(title);
    }
    expect(titles).not.toContain('Professional Google Workspace Administrator');
  });

  it('VMware: the role-based VCAP-VCF trio replaces VCAP-DCV Deploy and VCP-VVF is listed', () => {
    const codes = vmware.certifications.map((c) => c.code);
    expect(codes).not.toContain('VCAP-DCV');
    expect(codes).toEqual(
      expect.arrayContaining(['VCAP-VCF-ADMIN', 'VCAP-VCF-ARCH', 'VCAP-VCF-SUPPORT', 'VCP-VVF'])
    );
    const examCodes = vmware.certifications.map((c) => c.examCode).filter(Boolean);
    expect(examCodes).toEqual(
      expect.arrayContaining(['3V0-11.26', '3V0-12.26', '3V0-13.26', '2V0-16.25'])
    );
    // Learning paths must point at a code that is still in the catalogue.
    for (const path of vmware.learningPaths) {
      expect(codes, `learning path "${path.title}" -> ${path.certCode}`).toContain(path.certCode);
    }
  });
});

/**
 * The 2026-10-05 full re-read of the Azure, AWS and GCP catalogues (owner
 * request: "review and update all Learn portals … as new tests are in
 * beta/expired"). Each assertion is a vendor sentence read that day and
 * quoted in its catalogue's header; the dated ones are also what
 * `deriveStatus` must make of the row on the day the vendor named.
 */
describe('the 2026-10-05 re-read', () => {
  const rowFor = (mod, code) => mod.certifications.find((c) => c.code === code);

  it('moves DATA_AS_OF on all three to that day or later, because every row was read', () => {
    // A floor, not an exact day: update-learn-catalogue.yml stamps the Azure
    // DATA_AS_OF on every weekly run, so pinning 2026-10-05 failed the
    // updater's own check on its first run after this re-read (2026-10-12).
    for (const [provider, { DATA_AS_OF: asOf }] of Object.entries({ azure, aws, gcp })) {
      expect(asOf >= '2026-10-05', `${provider} DATA_AS_OF is ${asOf}`).toBe(true);
    }
  });

  it('Azure: AI-500 is out of beta, PL-400 hands over to AB-400 on October 16, MS-102 names AB-650', () => {
    expect(rowFor(azure, 'AI-500')).toMatchObject({ status: 'active' });
    expect(rowFor(azure, 'AI-500').gaDate).toBeUndefined();

    // The stored statuses of these two moved in the 2026-10-12 re-read below;
    // the dates, and so what a visitor sees on each day, did not.
    const pl400 = rowFor(azure, 'PL-400');
    expect(pl400).toMatchObject({ expiryDate: '2026-10-30', replacedBy: 'ab-400' });
    expect(deriveStatus(pl400, '2026-10-30')).toBe('expiring');
    expect(deriveStatus(pl400, '2026-10-31')).toBe('retired');

    const ab400 = rowFor(azure, 'AB-400');
    expect(ab400).toMatchObject({ availableDate: '2026-10-16', level: 'Associate' });
    expect(deriveStatus(ab400, '2026-10-15')).toBe('upcoming');
    expect(deriveStatus(ab400, '2026-10-16')).toBe('active');
    expect(azure.timelineEvents.find((e) => e.id === 'pl-400-ab-400')?.date).toBe('2026-10-16');
    expect(azure.timelineEvents.find((e) => e.id === 'dp-420-rename')?.date).toBe('2026-10-06');

    expect(rowFor(azure, 'MS-102')).toMatchObject({
      expiryDate: '2026-11-30',
      replacedBy: 'ab-650',
    });
    expect(rowFor(azure, 'AB-650').status).toBe('beta');
    for (const [code, slug] of [
      ['AZ-204', 'azure-ai-cloud-developer-associate'],
      ['AZ-500', 'cloud-and-ai-security-engineer-associate'],
      ['PL-200', 'ab-410'],
      ['MB-280', 'ab-210'],
    ]) {
      expect(rowFor(azure, code), code).toMatchObject({ status: 'retired', replacedBy: slug });
    }
  });

  it('Azure: every learnUrl is a credential page, never the bare browse root', () => {
    // Two exams may share one (AZ-800/AZ-801, PL-400/AB-400 each earn one
    // credential), so uniqueness is not the rule; the root is never right.
    const root = 'https://learn.microsoft.com/en-us/credentials/certifications/';
    for (const cert of azure.certifications) expect(cert.learnUrl, cert.code).not.toBe(root);
  });

  it('GCP: PAA stays upcoming without a date — Google dated registration (Nov 2), not the exam', () => {
    const paa = rowFor(gcp, 'PAA');
    expect(paa.status).toBe('upcoming');
    for (const field of CERT_DATE_FIELDS) expect(paa[field], `PAA.${field}`).toBeUndefined();
    expect(paa.description).toMatch(/November 2, 2026/);
    expect(rowFor(gcp, 'PMLE').topics).not.toContain('Vertex AI');
  });

  it('AWS: nothing stored moved; the SAP/DVA one-day conflict closed on the stored dates', () => {
    expect(rowFor(aws, 'SAP-C02')).toMatchObject({ status: 'expiring', expiryDate: '2026-11-16' });
    expect(rowFor(aws, 'DVA-C02')).toMatchObject({ status: 'expiring', expiryDate: '2026-11-30' });
    expect(rowFor(aws, 'MLA-C02')).toMatchObject({ status: 'beta', gaDate: '2027-01-14' });
  });
});

/**
 * The 2026-10-12 re-read of AB-400 and PL-400, the two rows #1091 named. Both
 * are stored ahead of their days under rule 2 of `deriveStatus`, so each badge
 * keeps its current status until Microsoft's day and the alarm above has
 * nothing to fire on. The vendor sentences are quoted in the Azure header.
 */
describe('the 2026-10-12 re-read', () => {
  /** The Azure catalogue row with this exam code, as the file stores it. */
  const rowFor = (code) => azure.certifications.find((c) => c.code === code);

  it('stores AB-400 active and PL-400 retired, each showing its old badge until its day', () => {
    const ab400 = rowFor('AB-400');
    expect(ab400).toMatchObject({ status: 'active', availableDate: '2026-10-16' });
    expect(deriveStatus(ab400, '2026-10-12')).toBe('upcoming');
    expect(deriveStatus(ab400, '2026-10-15')).toBe('upcoming');
    expect(deriveStatus(ab400, '2026-10-16')).toBe('active');

    const pl400 = rowFor('PL-400');
    expect(pl400).toMatchObject({ status: 'retired', expiryDate: '2026-10-30' });
    expect(deriveStatus(pl400, '2026-10-12')).toBe('expiring');
    expect(deriveStatus(pl400, '2026-10-30')).toBe('expiring');
    expect(deriveStatus(pl400, '2026-10-31')).toBe('retired');
  });

  it('leaves the alarm nothing to name on either day', () => {
    const rows = [rowFor('AB-400'), rowFor('PL-400')];
    for (const day of ['2026-10-16', '2026-10-31']) {
      expect(findStaleStatuses(rows, day), day).toEqual([]);
    }
  });
});
