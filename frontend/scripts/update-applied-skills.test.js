// @vitest-environment node
/**
 * The three rules of the catalogue updater (#461 item 3), with every source
 * stubbed: the sync date is stamped, a source that fails or parses to zero
 * items refuses to write, and lifecycle never moves backwards — a stale
 * poster or API cannot undo a retirement #464 recorded by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  SourceError,
  assertSourceItems,
  buildCatalogue,
  buildCertificationFromSources,
  collectSources,
  foreignOwnerFor,
  inferArea,
  reconcileLifecycle,
  stampSyncDate,
  summarizeChanges,
} from './update-applied-skills.mjs';

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const okHtml = (html) => ({ ok: true, status: 200, text: async () => html });
const failed = (status) => ({ ok: false, status, text: async () => '', json: async () => ({}) });

/** Poster text with one certification per line, as the PDF parses. */
const posterText = (codes) => codes.map((code) => `Some Title\n${code}`).join('\n');

describe('rule 1 — the sync date', () => {
  it('stamps today into both the header line and DATA_AS_OF', () => {
    const source = [
      '// Verified by hand on the date below.',
      '// Last manual sync: 2026-04-16',
      '',
      "export const DATA_AS_OF = '2026-04-16';",
      'export const x = 1;',
      '',
    ].join('\n');
    const stamped = stampSyncDate(source, '2026-09-14');
    expect(stamped).toContain('// Last manual sync: 2026-09-14');
    expect(stamped).toContain("export const DATA_AS_OF = '2026-09-14';");
    expect(stamped).not.toContain('2026-04-16');
  });

  it('refuses a file that lost either marker rather than stamping half of it', () => {
    expect(() => stampSyncDate("export const DATA_AS_OF = '2026-04-16';", '2026-09-14')).toThrow(
      /Last manual sync/
    );
    expect(() => stampSyncDate('// Last manual sync: 2026-04-16', '2026-09-14')).toThrow(
      /DATA_AS_OF/
    );
  });
});

describe('rule 2 — an empty or unreachable source writes nothing', () => {
  it('names the source that parsed to zero items, in one sentence', () => {
    expect(() => assertSourceItems('certifications browse API', [], 'https://x')).toThrow(
      SourceError
    );
    expect(() => assertSourceItems('Applied Skills poster', '   ', 'https://x')).toThrow(
      'The Applied Skills poster (https://x) was fetched but parsed to zero items, so the catalogue was not written.'
    );
    expect(assertSourceItems('ok', [1], 'https://x')).toEqual([1]);
  });

  it('refuses when the browse API answers with zero results', async () => {
    const fetchImpl = async () => okJson({ count: 0, results: [] });
    const readPdf = async (label) =>
      label === 'Certifications poster' ? posterText(['AZ-104']) : 'Create an AI agent';
    await expect(collectSources({ fetchImpl, readPdf })).rejects.toThrow(
      /browse API .* parsed to zero items, so the catalogue was not written\./
    );
  });

  it('refuses when a poster parses to no certifications', async () => {
    const fetchImpl = async () =>
      okJson({ count: 1, results: [{ title: 'Microsoft Certified: X', url: '/x/', exams: [] }] });
    const readPdf = async () => 'No codes on this poster at all';
    await expect(collectSources({ fetchImpl, readPdf })).rejects.toThrow(
      'The Certifications poster (https://aka.ms/CertificationsPoster) was fetched but parsed to zero items, so the catalogue was not written.'
    );
  });

  it('turns a non-2xx answer and a network failure into sentences naming the source', async () => {
    const readPdf = async () => posterText(['AZ-104']);
    await expect(collectSources({ fetchImpl: async () => failed(503), readPdf })).rejects.toThrow(
      /browse API \(https:\/\/learn\.microsoft\.com\/.*\) answered HTTP 503/
    );
    await expect(
      collectSources({
        fetchImpl: async () => {
          throw new Error('getaddrinfo ENOTFOUND learn.microsoft.com');
        },
        readPdf,
      })
    ).rejects.toThrow(/could not be fetched \(getaddrinfo ENOTFOUND learn\.microsoft\.com\)/);
  });
});

describe('rule 3 — lifecycle only moves forward', () => {
  it('keeps a retirement the file records when the source says beta or active', () => {
    const report = [];
    expect(
      reconcileLifecycle({
        existing: { status: 'retired', expiryDate: '2026-06-30' },
        sourced: { status: 'beta' },
        label: 'AI-102',
        report,
      })
    ).toEqual({ status: 'retired', expiryDate: '2026-06-30' });
    expect(
      reconcileLifecycle({
        existing: { status: 'retired', expiryDate: '2026-06-30' },
        sourced: { status: 'active' },
        label: 'AI-102',
        report,
      })
    ).toEqual({ status: 'retired', expiryDate: '2026-06-30' });
    expect(report).toEqual([
      "AI-102: the source says 'beta' but the file says 'retired' (2026-06-30); kept the file's value.",
      "AI-102: the source says 'active' but the file says 'retired' (2026-06-30); kept the file's value.",
    ]);
  });

  it('keeps the file when the source names a different retirement date', () => {
    const report = [];
    expect(
      reconcileLifecycle({
        existing: { status: 'expiring', expiryDate: '2026-09-30' },
        sourced: { status: 'expiring', expiryDate: '2026-12-31' },
        label: 'AZ-800',
        report,
      })
    ).toEqual({ status: 'expiring', expiryDate: '2026-09-30' });
    expect(report).toEqual([
      "AZ-800: the source gives retirement date 2026-12-31 but the file has 2026-09-30; kept the file's value.",
    ]);
  });

  it('keeps an exam #464 made active when a stale source still says beta', () => {
    const report = [];
    expect(
      reconcileLifecycle({
        existing: { status: 'active', betaEndDate: '2026-05-07' },
        sourced: { status: 'beta' },
        label: 'AI-103',
        report,
      })
    ).toEqual({ status: 'active' });
    expect(report).toHaveLength(1);
  });

  it('moves forward: active to expiring with the date, and a new entry takes the source', () => {
    const report = [];
    expect(
      reconcileLifecycle({
        existing: { status: 'active' },
        sourced: { status: 'expiring', expiryDate: '2026-11-30' },
        label: 'MS-102',
        report,
      })
    ).toEqual({ status: 'expiring', expiryDate: '2026-11-30' });
    expect(reconcileLifecycle({ existing: {}, sourced: { status: 'beta' }, report })).toEqual({
      status: 'beta',
    });
    expect(reconcileLifecycle({ existing: {}, sourced: {}, report })).toEqual({
      status: 'active',
    });
    expect(report).toEqual([]);
  });

  it('leaves the file alone when the source has no opinion', () => {
    const report = [];
    expect(
      reconcileLifecycle({
        existing: { status: 'expiring', expiryDate: '2026-09-30' },
        sourced: {},
        label: 'AZ-801',
        report,
      })
    ).toEqual({ status: 'expiring', expiryDate: '2026-09-30' });
    expect(report).toEqual([]);
  });
});

/**
 * #494: does the Monday run actually retire AZ-800 and AZ-801 on its own?
 *
 * Both carry `status: 'expiring'` and `expiryDate: '2026-09-30'`, and #494
 * recorded the self-heal as "an expectation, not a guarantee — nobody has
 * watched that workflow correct a row yet". Waiting for 2026-10-05 to find out
 * is not the only option: `reconcileLifecycle` never reads the calendar, it
 * compares the file's status against the source's by `LIFECYCLE_RANK`. So what
 * the workflow will do on that Monday is decided entirely by what Microsoft
 * reports, and every branch of it can be exercised today.
 *
 * The answer is that it self-heals in exactly one of the three cases below,
 * and the other two are silent or near-silent. That is the design working —
 * rule 3 exists so a stale source cannot un-retire an exam — but it means the
 * row is only guaranteed to move when the source both retires it AND agrees
 * about the date. Worth knowing before trusting the Monday run to do it.
 *
 * Run over BOTH codes rather than one standing in for the pair. The label only
 * reaches the report string, so a single case would exercise the same branches
 * — but #494's own table listed AZ-801 and missed AZ-800, and a test that says
 * "AZ-800/AZ-801" while checking one of them is how that happens again.
 *
 * Both rows were retired by hand on 2026-10-01 (#770), after Microsoft did
 * exactly what the first case expects; `src/data/azure/certifications.test.js`
 * ("marks AZ-800 and AZ-801 as retired on 2026-09-30 in favour of AZ-802")
 * holds the catalogue's own facts. The last case here is the round trip that
 * retirement now depends on.
 */
describe.each(['AZ-800', 'AZ-801'])('%s on the first Monday after 2026-09-30 (#494)', (code) => {
  const FILE_ROW = { status: 'expiring', expiryDate: '2026-09-30' };

  it('retires the row when Microsoft reports it retired on the same date', () => {
    const report = [];

    // The expected case, and the only one that needs nobody.
    expect(
      reconcileLifecycle({
        existing: { ...FILE_ROW },
        sourced: { status: 'retired', expiryDate: '2026-09-30' },
        label: code,
        report,
      })
    ).toEqual({ status: 'retired', expiryDate: '2026-09-30' });
    expect(report).toEqual([]);
  });

  it('does NOT retire it when Microsoft reports a different retirement date, and says so', () => {
    const report = [];

    // Rank alone would move it (retired 3 > expiring 2), but the date
    // conflict is caught first and the file wins. The row stays `expiring`
    // past its own expiryDate, so the suite stays red and this line is the
    // only clue why — which is why #499 carries the summary into the PR body.
    expect(
      reconcileLifecycle({
        existing: { ...FILE_ROW },
        sourced: { status: 'retired', expiryDate: '2026-11-30' },
        label: code,
        report,
      })
    ).toEqual({ status: 'expiring', expiryDate: '2026-09-30' });
    expect(report).toEqual([
      `${code}: the source gives retirement date 2026-11-30 but the file has 2026-09-30; kept the file's value.`,
    ]);
  });

  it('does NOT retire it when Microsoft is slow and still reports it expiring, and stays silent', () => {
    const report = [];

    // Correct — an exam Microsoft has not retired should not be retired here
    // — but it reports nothing at all, so a row left stale this way is
    // invisible in the run summary. Only the red suite catches it.
    expect(
      reconcileLifecycle({
        existing: { ...FILE_ROW },
        sourced: { status: 'expiring', expiryDate: '2026-09-30' },
        label: code,
        report,
      })
    ).toEqual({ status: 'expiring', expiryDate: '2026-09-30' });
    expect(report).toEqual([]);
  });

  it('keeps the retiredDate #770 recorded when the poster still lists the exam', () => {
    // The row as stored after #770. The updater rebuilds every poster entry
    // from scratch, so a field it does not copy is a field the next run
    // deletes, and education-catalogues.test.js pins this one.
    const stored = {
      id: code.toLowerCase(),
      slug: code.toLowerCase(),
      code,
      title: `Exam ${code}`,
      status: 'retired',
      retiredDate: '2026-09-30',
      expiryDate: '2026-09-30',
      replacedBy: 'az-802',
    };
    const none = { byCode: new Map(), byTitle: new Map() };
    const existing = { byCode: new Map([[code, stored]]), byTitle: new Map() };

    expect(
      buildCertificationFromSources({ code, title: `Exam ${code}` }, none, existing)
    ).toMatchObject({
      status: 'retired',
      retiredDate: '2026-09-30',
      expiryDate: '2026-09-30',
      replacedBy: 'az-802',
    });
  });

  it('keeps statusReadDate and availableDate (#1091), which hold a badge until the vendor’s day', () => {
    // PL-400 as stored on 2026-10-12: retired ahead of its 2026-10-30 day, and
    // the day it was read on. The 2026-10-19 run dropped statusReadDate, so
    // deriveStatus showed `retired` two weeks early and the data test refused
    // the pull request. AB-400 is the mirror case: active ahead of its day.
    const retiredAhead = {
      id: 'pl-400',
      slug: 'pl-400',
      code: 'PL-400',
      title: 'Exam PL-400',
      status: 'retired',
      expiryDate: '2026-10-30',
      statusReadDate: '2026-10-12',
      replacedBy: 'ab-400',
    };
    const activeAhead = {
      id: 'ab-400',
      slug: 'ab-400',
      code: 'AB-400',
      title: 'Exam AB-400',
      status: 'active',
      availableDate: '2026-10-16',
      statusReadDate: '2026-10-12',
    };
    const none = { byCode: new Map(), byTitle: new Map() };
    const existing = {
      byCode: new Map([
        ['PL-400', retiredAhead],
        ['AB-400', activeAhead],
      ]),
      byTitle: new Map(),
    };

    expect(
      buildCertificationFromSources({ code: 'PL-400', title: 'Exam PL-400' }, none, existing)
    ).toMatchObject({ status: 'retired', expiryDate: '2026-10-30', statusReadDate: '2026-10-12' });
    expect(
      buildCertificationFromSources({ code: 'AB-400', title: 'Exam AB-400' }, none, existing)
    ).toMatchObject({
      status: 'active',
      availableDate: '2026-10-16',
      statusReadDate: '2026-10-12',
    });
  });
});

/**
 * #496 in the one place that can enforce it: the script that writes the file.
 *
 * The GH exams are on the Microsoft Certifications poster and in the Learn
 * browse API, because GitHub certification moved onto Microsoft Learn. Both
 * are this script's sources, so it had always been offering them — and on
 * 2026-09-11, hours after #507 removed all six from the Azure catalogue by
 * owner decision, the first dispatch of the refreshed workflow (run
 * 34627119281) put every one of them straight back, with their six study-guide
 * outlines behind them.
 *
 * Nothing was broken. The decision was recorded in the catalogue's file header
 * and in a cross-catalogue test, and a script reads neither. This is the rule
 * moved to where the automation will meet it.
 */
describe('exams another catalogue owns are refused (#496)', () => {
  it('recognises a GH code as GitHub’s, whatever the number', () => {
    for (const code of ['GH-100', 'GH-200', 'GH-300', 'GH-500', 'GH-600', 'GH-900', 'GH-700']) {
      expect(foreignOwnerFor(code), code).toBe('src/data/github/certifications.js');
    }
  });

  it('does not refuse an Azure code, or something merely starting with the letters', () => {
    for (const code of ['AZ-104', 'AI-102', 'AB-900', 'GHOST-1', 'GH', 'GH-', 'gh-200']) {
      expect(foreignOwnerFor(code), code).toBeNull();
    }
  });

  it('drops a GH entry the poster offers, and names it in the summary', async () => {
    const out = await buildCatalogue({
      existingSkills: [],
      existingCertifications: [],
      sources: {
        certificationApiResults: [
          {
            title: 'Microsoft Certified: GitHub Actions',
            url: '/credentials/certifications/github-actions/',
            exams: [{ display_name: 'Exam GH-200' }],
          },
          {
            title: 'Microsoft Certified: Azure Administrator Associate',
            url: '/credentials/certifications/azure-administrator/',
            exams: [{ display_name: 'Exam AZ-104' }],
          },
        ],
        posterCertificationEntries: [
          { code: 'GH-200', title: 'GitHub Actions' },
          { code: 'AZ-104', title: 'Azure Administrator Associate' },
        ],
        browseResults: [],
        appliedPosterText: 'Create an AI agent',
      },
      fetchImpl: async () => okHtml('<h2>Overview</h2><p>Text</p></section>'),
    });

    // The Azure exam is carried; the GitHub one is not, and is not silent.
    expect(out.nextCertifications.map((c) => c.code)).toEqual(['AZ-104']);
    expect(out.foreign).toEqual([
      'GH-200 — GitHub Actions — carried by src/data/github/certifications.js',
    ]);

    // Refused, not "unverified" — the poster artefact bucket means "nobody
    // could confirm this exam", which would send a reviewer looking for a
    // source problem that does not exist.
    expect(out.unverified).toEqual([]);

    const summary = summarizeChanges({
      before: { certifications: [], appliedSkills: [] },
      after: { certifications: out.nextCertifications, appliedSkills: out.nextSkills },
      today: '2026-09-11',
      foreign: out.foreign,
    });
    expect(summary).toContain('### Refused because another catalogue owns the exam (#496)');
    expect(summary).toContain('GH-200 — GitHub Actions — carried by');
    expect(summary).not.toContain('Certifications added\n\n- GH-200');
  });
});

describe('buildCatalogue — the rules applied to the whole file', () => {
  const existingCertifications = [
    {
      id: 'ai-102',
      slug: 'ai-102',
      code: 'AI-102',
      officialCode: 'AI-102',
      title: 'Designing and Implementing a Microsoft Azure AI Solution',
      level: 'Associate',
      status: 'retired',
      expiryDate: '2026-06-30',
      replacedBy: 'ai-103',
      description: 'd',
      longDescription: 'ld',
      topics: [],
      hours: 45,
      prepTime: '~3 months',
      successRate: null,
      learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/azure-ai-engineer/',
      studyGuideUrl: 's',
      practiceUrl: 'p',
      modules: [],
      appliedSkills: [],
      prerequisites: 'none',
      nextCerts: [],
    },
    {
      id: 'ai-103',
      slug: 'ai-103',
      code: 'AI-103',
      officialCode: 'AI-103',
      title: 'Azure AI Apps and Agents Developer Associate',
      level: 'Associate',
      status: 'active',
      betaEndDate: '2026-05-07',
      description: 'd',
      longDescription: 'ld',
      topics: [],
      hours: 45,
      prepTime: '~3 months',
      successRate: null,
      learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/ai-103/',
      studyGuideUrl: 's',
      practiceUrl: 'p',
      modules: [],
      appliedSkills: [],
      prerequisites: 'none',
      nextCerts: [],
    },
  ];
  const existingSkills = [
    {
      id: 'apl-csa',
      slug: 'create-agents-in-microsoft-copilot-studio',
      code: 'APL-CSA',
      officialCode: 'applied-skill.create-agents-in-microsoft-copilot-studio',
      title: 'Create agents in Microsoft Copilot Studio',
      area: 'AI Business',
      level: 'Intermediate',
      status: 'retired',
      expiryDate: '2026-07-08',
      description: 'd',
      learnUrl:
        'https://learn.microsoft.com/en-us/credentials/applied-skills/create-agents-in-microsoft-copilot-studio/',
    },
    {
      id: 'apl-fdw',
      slug: 'implement-a-data-warehouse-in-microsoft-fabric',
      code: 'APL-FDW',
      officialCode: 'applied-skill.implement-a-data-warehouse-in-microsoft-fabric',
      title: 'Implement a data warehouse in Microsoft Fabric',
      area: 'Data',
      level: 'Intermediate',
      status: 'expiring',
      expiryDate: '2026-09-30',
      description: 'd',
      learnUrl:
        'https://learn.microsoft.com/en-us/credentials/applied-skills/implement-a-data-warehouse-in-microsoft-fabric/',
    },
  ];
  const sources = {
    // The API still says "(beta)" for AI-103, which #464 made active.
    certificationApiResults: [
      {
        title: 'Microsoft Certified: Azure AI Apps and Agents Developer Associate (beta)',
        url: '/credentials/certifications/ai-103/',
        exams: [{ display_name: 'Exam AI-103' }],
      },
      {
        title: 'Microsoft Certified: Azure Administrator Associate',
        url: '/credentials/certifications/azure-administrator/',
        exams: [{ display_name: 'Exam AZ-104' }],
      },
    ],
    // The poster lists AI-103 and AZ-104, has dropped the retired AI-102, and
    // carries a template label that parsed as an exam.
    posterCertificationEntries: [
      { code: 'AI-103', title: 'Azure AI Apps and Agents Developer Associate (Beta)' },
      { code: 'AZ-104', title: 'Azure Administrator Associate' },
      { code: 'MB-300', title: 'Full certification title' },
    ],
    // The browse API no longer lists the retired skill, and its page names a
    // later date for the expiring one.
    browseResults: [
      {
        uid: 'applied-skill.implement-a-data-warehouse-in-microsoft-fabric',
        title: 'Microsoft Applied Skills: Implement a data warehouse in Microsoft Fabric',
        url: '/credentials/applied-skills/implement-a-data-warehouse-in-microsoft-fabric/',
        display_levels: ['Intermediate'],
        display_subjects: ['fabric'],
      },
    ],
    appliedPosterText: 'Create an AI agent',
  };
  const fetchImpl = async () =>
    okHtml(
      '<h2>Overview</h2><p>Text</p> This credential will retire on December 31, 2026 </section>'
    );

  it('keeps retirements, refuses the poster artefact, and reports every decision', async () => {
    const out = await buildCatalogue({
      existingSkills,
      existingCertifications,
      sources,
      fetchImpl,
    });

    const certs = new Map(out.nextCertifications.map((c) => [c.code, c]));
    expect([...certs.keys()]).toEqual(['AI-102', 'AI-103', 'AZ-104']);
    expect(certs.get('AI-102')).toMatchObject({ status: 'retired', expiryDate: '2026-06-30' });
    expect(certs.get('AI-103')).toMatchObject({ status: 'active', betaEndDate: '2026-05-07' });
    expect(certs.get('AZ-104')).toMatchObject({ status: 'active', slug: 'azure-administrator' });

    const skills = new Map(out.nextSkills.map((s) => [s.code, s]));
    expect(skills.get('APL-CSA')).toMatchObject({ status: 'retired', expiryDate: '2026-07-08' });
    expect(skills.get('APL-FDW')).toMatchObject({ status: 'expiring', expiryDate: '2026-09-30' });

    expect(out.kept).toEqual([
      'APL-CSA — Create agents in Microsoft Copilot Studio (retired)',
      'AI-102 — Designing and Implementing a Microsoft Azure AI Solution (retired)',
    ]);
    expect(out.disagreements).toEqual([
      "APL-FDW (implement-a-data-warehouse-in-microsoft-fabric): the source gives retirement date 2026-12-31 but the file has 2026-09-30; kept the file's value.",
      "AI-103: the source says 'beta' but the file says 'active'; kept the file's value.",
    ]);
    expect(out.unverified).toEqual(['MB-300 — Full certification title']);
  });

  it('reports the code actually written when a kept skill has to give up its code', async () => {
    // A new skill from the browse API has no entry in the file, so it gets a
    // generated code — APL-BAA for this slug — which is exactly the code the
    // retired skill below already holds. The retired skill is kept under a
    // fresh code, and the summary must name that code, not the old one.
    const retiredWithClashingCode = {
      id: 'apl-old',
      slug: 'old-thing',
      code: 'APL-BAA',
      officialCode: 'applied-skill.old-thing',
      title: 'Old thing nobody lists any more',
      area: 'AI',
      level: 'Intermediate',
      status: 'retired',
      expiryDate: '2026-01-31',
      description: 'd',
      learnUrl: 'https://learn.microsoft.com/en-us/credentials/applied-skills/old-thing/',
    };
    const out = await buildCatalogue({
      existingSkills: [retiredWithClashingCode],
      existingCertifications,
      sources: {
        ...sources,
        browseResults: [
          {
            uid: 'applied-skill.build-an-agent',
            title: 'Microsoft Applied Skills: Build an agent',
            url: '/credentials/applied-skills/build-an-agent/',
            display_levels: ['Intermediate'],
          },
        ],
      },
      fetchImpl: async () => failed(404),
    });
    const sourced = out.nextSkills.find((s) => s.slug === 'build-an-agent');
    const kept = out.nextSkills.find((s) => s.slug === 'old-thing');
    expect(sourced.code).toBe('APL-BAA');
    expect(kept.code).not.toBe('APL-BAA');
    expect(kept).toMatchObject({ status: 'retired', expiryDate: '2026-01-31' });
    // The certification fixture still reports AI-102 as kept; the skill line
    // is the one under test.
    const skillLines = out.kept.filter((line) => line.includes('Old thing'));
    expect(skillLines).toEqual([
      `${kept.code} — Old thing nobody lists any more (retired) — kept as ${kept.code} (was APL-BAA, now taken by a sourced skill)`,
    ]);
    expect(out.kept.some((line) => line.startsWith('APL-BAA'))).toBe(false);
  });

  it('treats a detail page that does not answer as no opinion, not as a reprieve', async () => {
    const out = await buildCatalogue({
      existingSkills,
      existingCertifications,
      sources,
      fetchImpl: async () => failed(404),
    });
    expect(out.nextSkills.find((s) => s.code === 'APL-FDW')).toMatchObject({
      status: 'expiring',
      expiryDate: '2026-09-30',
    });
    expect(out.disagreements.filter((line) => line.startsWith('APL-FDW'))).toEqual([]);
  });
});

describe('summarizeChanges — the pull request body', () => {
  it('lists additions, changes and removals by code, and says when only the date moved', () => {
    const before = {
      certifications: [{ code: 'AZ-104', title: 'Admin', status: 'active' }],
      appliedSkills: [{ code: 'APL-A', title: 'A', status: 'active' }],
    };
    const after = {
      certifications: [
        { code: 'AZ-104', title: 'Admin', status: 'expiring', expiryDate: '2026-12-31' },
        { code: 'AZ-802', title: 'Hybrid', status: 'active' },
      ],
      appliedSkills: [],
    };
    const summary = summarizeChanges({ before, after, today: '2026-09-14', kept: ['x — y'] });
    expect(summary).toContain('Catalogue checked against Microsoft Learn on 2026-09-14.');
    expect(summary).toContain('- AZ-802 — Hybrid (active)');
    expect(summary).toContain('- AZ-104: status active → expiring, expiryDate — → 2026-12-31');
    expect(summary).toContain('- APL-A — A');
    expect(summary).toContain('### Kept from the file');
    expect(summary).not.toContain('only the sync date moved');

    const unchanged = summarizeChanges({ before, after: before, today: '2026-09-14' });
    expect(unchanged).toContain('No entry changed; only the sync date moved.');
  });
});

/**
 * Pins written before #1859 split three long functions into smaller ones to
 * meet the linter's complexity limit. They hold what each function returns
 * today, so the split cannot change a single field.
 */
describe('behaviour held across the #1859 split', () => {
  it('inferArea: each area, in the order the checks run', () => {
    const skill = (title, extra = {}) => ({ title, ...extra });
    expect(inferArea(skill('Secure identity with Entra'))).toBe('Security');
    expect(inferArea(skill('x', { display_subjects: ['Compliance'] }))).toBe('Security');
    expect(inferArea(skill('Configure Active Directory'))).toBe('Security');
    expect(inferArea(skill('Build a Power Apps canvas app'))).toBe('AI Business');
    expect(inferArea(skill('x', { display_products: ['Copilot Studio'] }))).toBe('AI Business');
    expect(inferArea(skill('Monitor workloads'))).toBe('Operations');
    expect(inferArea(skill('Do a management task'))).toBe('Operations');
    expect(inferArea(skill('Deploy to Kubernetes'))).toBe('Containers');
    expect(inferArea(skill('Implement a SQL database'))).toBe('Data');
    expect(inferArea(skill('Build in Microsoft Fabric'))).toBe('Data');
    expect(inferArea(skill('Automate with GitHub'))).toBe('DevTools');
    expect(inferArea(skill('Write C# code'))).toBe('DevTools');
    expect(inferArea(skill('x', { display_subjects: ['Business applications'] }))).toBe(
      'AI Business'
    );
    expect(inferArea(skill('Configure storage accounts'))).toBe('Storage');
    expect(inferArea(skill('Configure a virtual network'))).toBe('Networking');
    expect(inferArea(skill('Create an AI agent'))).toBe('AI');
    // Security is checked first, so it wins over a later match.
    expect(inferArea(skill('Kubernetes security baseline'))).toBe('Security');
  });

  const none = { byCode: new Map(), byTitle: new Map() };

  it('buildCertificationFromSources: every default a new certification gets, per level', () => {
    const api = (title, extra = {}) => ({
      title: `Microsoft Certified: ${title}`,
      url: `/credentials/certifications/${title.toLowerCase().replace(/\s+/g, '-')}/`,
      ...extra,
    });
    const indexes = (code, result) => ({ byCode: new Map([[code, result]]), byTitle: new Map() });

    expect(
      buildCertificationFromSources(
        { code: 'AZ-900', title: 'Azure Fundamentals' },
        indexes(
          'AZ-900',
          api('Azure Fundamentals', { display_subjects: ['a', 'b', 'c', 'd', 'e'] })
        ),
        none
      )
    ).toEqual({
      id: 'az-900',
      slug: 'azure-fundamentals',
      code: 'AZ-900',
      officialCode: 'AZ-900',
      title: 'Microsoft Certified: Azure Fundamentals',
      level: 'Fundamentals',
      status: 'active',
      description: 'Azure Fundamentals validates role-based Microsoft cloud skills.',
      longDescription:
        'Azure Fundamentals validates skills for Microsoft cloud and AI workloads using official Microsoft certification requirements.',
      topics: ['a', 'b', 'c', 'd'],
      hours: 10,
      prepTime: '~4 weeks',
      successRate: null,
      learnUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/azure-fundamentals/',
      studyGuideUrl:
        'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-900',
      practiceUrl:
        'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications#examid=az-900',
      modules: [],
      appliedSkills: [],
      prerequisites: 'Review the official Microsoft Learn certification page for prerequisites.',
      nextCerts: [],
    });

    const expert = buildCertificationFromSources(
      { code: 'AZ-305', title: 'Azure Solutions Architect Expert (beta)' },
      indexes('AZ-305', api('Azure Solutions Architect Expert', { display_products: ['p'] })),
      none
    );
    expect(expert).toMatchObject({
      level: 'Expert',
      status: 'beta',
      hours: 60,
      prepTime: '~10 weeks',
      topics: ['p'],
    });

    const associate = buildCertificationFromSources(
      { code: 'AZ-104', title: 'Azure Administrator Associate' },
      indexes('AZ-104', api('Azure Administrator Associate')),
      none
    );
    expect(associate).toMatchObject({
      level: 'Associate',
      hours: 35,
      prepTime: '~6 weeks',
      topics: ['Azure Administrator Associate'],
    });
  });

  it('buildCertificationFromSources: a known certification keeps every field the file has', () => {
    const stored = {
      id: 'kept-id',
      slug: 'kept-slug',
      code: 'AZ-104',
      title: 'Kept title',
      level: 'Specialty',
      status: 'expiring',
      expiryDate: '2026-12-31',
      featured: true,
      retiredDate: '2027-01-01',
      replacedBy: 'az-105',
      betaEndDate: '2026-01-01',
      betaDiscount: '80%',
      gaDate: '2026-02-01',
      statusReadDate: '2026-10-12',
      availableDate: '2026-10-16',
      description: 'd',
      longDescription: 'ld',
      topics: ['t'],
      hours: 1,
      prepTime: 'p',
      successRate: 0.5,
      learnUrl: 'https://example.test/learn',
      studyGuideUrl: 'https://example.test/guide',
      practiceUrl: 'https://example.test/practice',
      modules: ['m'],
      appliedSkills: ['s'],
      prerequisites: 'pre',
      nextCerts: ['n'],
    };
    const existing = { byCode: new Map([['AZ-104', stored]]), byTitle: new Map() };
    const { title: _omit, ...rest } = stored;
    const built = buildCertificationFromSources(
      { code: 'AZ-104', title: 'Poster title' },
      none,
      existing
    );
    expect(built).toEqual({ ...rest, title: 'Kept title', officialCode: 'AZ-104' });
    // The file is written with JSON.stringify, so the order of the keys is
    // the order of the lines in the catalogue, and a reorder is a noisy diff.
    expect(Object.keys(built)).toEqual([
      'id',
      'slug',
      'code',
      'officialCode',
      'title',
      'level',
      'status',
      'featured',
      'retiredDate',
      'expiryDate',
      'replacedBy',
      'betaEndDate',
      'betaDiscount',
      'gaDate',
      'statusReadDate',
      'availableDate',
      'description',
      'longDescription',
      'topics',
      'hours',
      'prepTime',
      'successRate',
      'learnUrl',
      'studyGuideUrl',
      'practiceUrl',
      'modules',
      'appliedSkills',
      'prerequisites',
      'nextCerts',
    ]);
  });

  it('buildCatalogue: what an applied skill’s detail page says about its lifecycle', async () => {
    const result = (slug, title) => ({
      url: `/credentials/applied-credentials/${slug}/`,
      title: `Microsoft Applied Skills: ${title}`,
      uid: `applied.${slug}`,
    });
    const pages = {
      'retiring-skill':
        '<h2>Overview</h2><p>Retiring overview.</p></section>This credential will retire on March 31, 2027',
      'current-skill': '<h2>Overview</h2><p>Current overview.</p></section>',
    };
    const out = await buildCatalogue({
      existingSkills: [],
      existingCertifications: [],
      sources: {
        browseResults: [
          result('retiring-skill', 'Retiring skill'),
          result('current-skill', 'Current skill'),
          { ...result('silent-skill', 'Silent skill'), display_levels: ['Advanced'] },
        ],
        appliedPosterText: '',
        certificationApiResults: [],
        posterCertificationEntries: [],
      },
      fetchImpl: async (url) => {
        const slug = Object.keys(pages).find((key) => url.includes(key));
        return slug ? okHtml(pages[slug]) : failed(404);
      },
    });
    expect(out.nextSkills).toEqual([
      {
        id: 'current-skill',
        slug: 'current-skill',
        code: 'APL-CS',
        officialCode: 'applied.current-skill',
        title: 'Current skill',
        area: 'AI',
        level: 'Intermediate',
        status: 'active',
        expiryDate: undefined,
        description: 'Current overview.',
        learnUrl:
          'https://learn.microsoft.com/en-us/credentials/applied-credentials/current-skill/',
      },
      {
        id: 'retiring-skill',
        slug: 'retiring-skill',
        code: 'APL-RS',
        officialCode: 'applied.retiring-skill',
        title: 'Retiring skill',
        area: 'AI',
        level: 'Intermediate',
        status: 'expiring',
        expiryDate: '2027-03-31',
        description: 'Retiring overview.',
        learnUrl:
          'https://learn.microsoft.com/en-us/credentials/applied-credentials/retiring-skill/',
      },
      {
        id: 'silent-skill',
        slug: 'silent-skill',
        code: 'APL-SS',
        officialCode: 'applied.silent-skill',
        title: 'Silent skill',
        area: 'AI',
        level: 'Advanced',
        status: 'active',
        expiryDate: undefined,
        description: 'Validate hands-on skills for Silent skill.',
        learnUrl: 'https://learn.microsoft.com/en-us/credentials/applied-credentials/silent-skill/',
      },
    ]);
    expect(Object.keys(out.nextSkills[0])).toEqual([
      'id',
      'slug',
      'code',
      'officialCode',
      'title',
      'area',
      'level',
      'status',
      'expiryDate',
      'description',
      'learnUrl',
    ]);
    expect(out.disagreements).toEqual([]);
  });
});
