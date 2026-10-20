import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_PROGRAMS, SUPERSEDED_SEED_VALUES, currentSeedRevision } from './programs.js';
import { EVIDENCE_SOURCES, toCalendarDate } from './model.js';
import { seedBackfillFor } from './steps.js';

const byId = (id) => DEFAULT_PROGRAMS.find((p) => p.id === id);
const rule = (req) => [req.id, req.minCount, req.weight, req.evidenceTypes];
/** A program's history as [revision, fields] steps, oldest first. */
const stepsOf = (id) => SUPERSEDED_SEED_VALUES[id].revisions.map((s) => [s.revision, s.fields]);

describe('ambassador seed programs (ADR 0033 §4)', () => {
  it('exports a frozen list of default programs', () => {
    expect(Array.isArray(DEFAULT_PROGRAMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROGRAMS)).toBe(true);
    expect(DEFAULT_PROGRAMS.length).toBeGreaterThanOrEqual(5);
  });

  it('validates each seed program contract', () => {
    for (const program of DEFAULT_PROGRAMS) {
      expect(typeof program.id).toBe('string');
      expect(program.id).toMatch(/^program-[a-z0-9-]+$/);
      expect(typeof program.name).toBe('string');
      expect(program.name.length).toBeGreaterThan(0);
      expect(typeof program.provider).toBe('string');
      expect(typeof program.category).toBe('string');
      expect(typeof program.description).toBe('string');
      expect(program.description.length).toBeGreaterThan(10);
      if (program.applicationUrl !== null) {
        expect(typeof program.applicationUrl).toBe('string');
        expect(program.applicationUrl.startsWith('https://')).toBe(true);
      }
      expect(Array.isArray(program.eligibility)).toBe(true);
      expect(Array.isArray(program.criteria)).toBe(true);
      expect(Array.isArray(program.recommendedActivities)).toBe(true);
      expect(Array.isArray(program.requirements)).toBe(true);
      expect(program.requirements.length).toBeGreaterThan(0);

      for (const req of program.requirements) {
        expect(typeof req.id).toBe('string');
        expect(typeof req.label).toBe('string');
        expect(typeof req.description).toBe('string');
        expect(Array.isArray(req.evidenceTypes)).toBe(true);
        expect(typeof req.minCount).toBe('number');
        expect(req.minCount).toBeGreaterThan(0);
        expect(typeof req.weight).toBe('number');
        expect(req.weight).toBeGreaterThan(0);
      }

      if (program.applicationQuestions) {
        expect(Array.isArray(program.applicationQuestions)).toBe(true);
        for (const q of program.applicationQuestions) {
          expect(typeof q.id).toBe('string');
          expect(typeof q.section).toBe('string');
          expect(typeof q.prompt).toBe('string');
          expect(typeof q.kind).toBe('string');
        }
      }
    }
  });

  it('includes key community programs', () => {
    const ids = DEFAULT_PROGRAMS.map((p) => p.id);
    expect(ids).toContain('program-microsoft-mvp');
    expect(ids).toContain('program-aws-community-builders');
  });

  it('exports valid superseded seed values for migration versioning', () => {
    expect(typeof SUPERSEDED_SEED_VALUES).toBe('object');
    expect(Object.isFrozen(SUPERSEDED_SEED_VALUES)).toBe(true);

    const gk = SUPERSEDED_SEED_VALUES['program-gitkraken-ambassador'];
    expect(gk).toBeDefined();
    expect(currentSeedRevision('program-gitkraken-ambassador')).toBe(3);
    expect(currentSeedRevision('program-docker-captain')).toBe(3);
    expect(currentSeedRevision('program-microsoft-mvp')).toBe(2);
    expect(currentSeedRevision('program-microsoft-mct')).toBeNull();
    // Each program's history: ascending revisions from 2, each step a
    // non-empty record of the fields it replaced, every one a seed field.
    for (const [id, { revisions }] of Object.entries(SUPERSEDED_SEED_VALUES)) {
      const seed = byId(id);
      expect(seed, id).toBeDefined();
      expect(Object.isFrozen(revisions), id).toBe(true);
      expect(revisions.length, id).toBeGreaterThan(0);
      let previous = 1;
      for (const step of revisions) {
        expect(step.revision, id).toBeGreaterThan(previous);
        previous = step.revision;
        expect(Object.keys(step.fields).length, `${id} rev ${step.revision}`).toBeGreaterThan(0);
        for (const field of Object.keys(step.fields)) expect(field in seed, `${id}.${field}`).toBe(true);
      }
    }
  });
});

describe('the published rules read on 2026-10-20', () => {
  it('seeds the three new programmes with unique ids, and every evidence type is a known source', () => {
    const ids = DEFAULT_PROGRAMS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'program-docker-sponsored-oss',
        'program-hashicorp-ambassador',
        'program-coder-champion',
      ])
    );
    for (const program of DEFAULT_PROGRAMS) {
      for (const req of program.requirements) {
        for (const type of req.evidenceTypes) expect(EVIDENCE_SOURCES, req.id).toContain(type);
      }
      for (const type of program.upkeep?.evidenceTypes || []) {
        expect(EVIDENCE_SOURCES, program.id).toContain(type);
      }
    }
  });

  it('counts Docker Captain against its tracks: the audience figure, content, community, labs', () => {
    const captain = byId('program-docker-captain');
    expect(captain.applicationUrl).toBe('https://app.advocu.com/dockercaptains/join');
    expect(captain.requirements.map(rule)).toEqual([
      ['reach', 1, 3, ['manual']],
      ['content', 4, 2, ['content', 'newsletter']],
      ['community', 2, 2, ['manual', 'speaking']],
      ['labs', 2, 1, ['labs']],
    ]);
    expect(captain.requirements[0].description).toMatch(/5,000 or more monthly views/);
    expect(captain.criteria).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Docker Thought Leader: 5,000/),
        expect.stringMatching(/^Sail the extra mile/),
      ])
    );
    expect(captain.eligibility).toContain('18 or older; open internationally');
    expect(captain.expirationRule).toMatch(/^One-year term/);
    expect(captain.applicationWindow).toEqual({
      opens: null,
      closes: null,
      note: expect.stringMatching(/Rolling applications through the Advocu join form/),
    });
  });

  it('seeds Docker-Sponsored Open Source as a yearly sponsorship with two counted asks', () => {
    const dsos = byId('program-docker-sponsored-oss');
    expect(dsos).toMatchObject({
      provider: 'Docker',
      category: 'partner',
      applicationUrl: 'https://www.docker.com/community/open-source/application/',
      renewalCadence: 'annual',
    });
    expect(dsos.requirements.map(rule)).toEqual([
      ['images', 1, 3, ['labs', 'manual']],
      ['activity', 1, 2, ['manual']],
    ]);
    expect(dsos.eligibility).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Open Source Initiative definition/),
        expect.stringMatching(/updates within the past 6 months/),
        expect.stringMatching(/Accepting donations to sustain the effort is permissible/i),
      ])
    );
    expect(dsos.description).toMatch(/paid Docker subscription and DSOS are mutually exclusive/);
  });

  it('seeds HashiCorp Ambassador with the December window and its four contribution asks', () => {
    const hashi = byId('program-hashicorp-ambassador');
    expect(hashi).toMatchObject({
      provider: 'HashiCorp',
      applicationUrl: 'https://www.hashicorp.com/en/ambassador',
      renewalCadence: 'annual',
    });
    expect(hashi.applicationWindow).toEqual({
      opens: '2026-12-01',
      closes: '2027-01-05',
      note: expect.stringMatching(/^Submissions open annually 1 December to 5 January/),
    });
    expect(hashi.requirements.map(rule)).toEqual([
      ['content', 3, 3, ['content', 'newsletter', 'listen-and-learn']],
      ['mentorship', 1, 2, ['manual', 'speaking', 'labs']],
      ['events', 1, 1, ['speaking']],
      ['feedback', 1, 1, ['manual']],
    ]);
    expect(hashi.criteria).toEqual(
      expect.arrayContaining(['Knowledge sharing', 'Mentorship', 'Kindness'])
    );
    expect(hashi.eligibility).toEqual(
      expect.arrayContaining([expect.stringMatching(/preceding twelve months/)])
    );
  });

  it('models Coder Champion as the chats and the people helped, counted apart, plus the star and the templates', () => {
    const coder = byId('program-coder-champion');
    expect(coder).toMatchObject({
      provider: 'Coder',
      applicationUrl: 'https://coder.com/coder-champions',
      renewalCadence: 'annual',
      expirationRule: 'Year-long programme; quarterly activity audits after the first year.',
    });
    expect(coder.requirements.map(rule)).toEqual([
      ['chats', 5, 2, ['manual']],
      ['help', 2, 3, ['manual']],
      ['star', 1, 1, ['manual']],
      ['templates', 1, 2, ['labs']],
    ]);
    expect(coder.applicationWindow).toEqual({ opens: null, closes: null, note: 'Rolling; no cohort dates.' });
  });

  it('words GitKraken as the published tiers, keeping the quarterly upkeep and its one counted rule', () => {
    const gk = byId('program-gitkraken-ambassador');
    expect(gk.criteria).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Content Creator: 2\+ pieces of content per quarter/),
        expect.stringMatching(/^Event Host: events for 30\+ developers/),
        expect.stringMatching(/^Programme-wide: follow the brand guidelines, show the GitKraken logo/),
      ])
    );
    expect(gk.upkeep).toMatchObject({ period: 'quarter', minCount: 2, evidenceTypes: [] });
    expect(gk.requirements.map(rule)).toEqual([['quarterly-content', 2, 1, []]]);
    expect(gk.recommendedActivities).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/logo on the site/),
        expect.stringMatching(/quarterly check-in form/),
      ])
    );
  });

  it('records, for each superseded revision, exactly what the current seed replaced', () => {
    for (const [id, { revisions }] of Object.entries(SUPERSEDED_SEED_VALUES)) {
      const seed = byId(id);
      // The last step is what this file replaced; no recorded value is the seed's own.
      for (const [field, old] of Object.entries(revisions.at(-1).fields)) {
        expect(JSON.stringify(seed[field]), `${id}.${field}`).not.toBe(JSON.stringify(old));
      }
    }
    const [[, first], [, second]] = stepsOf('program-gitkraken-ambassador');
    expect(stepsOf('program-gitkraken-ambassador').map(([r]) => r)).toEqual([2, 3]);
    // Revision 2 replaced #873's guess.
    expect(first.description).toMatch(/As published 2026; edit to match\.$/);
    expect(first.criteria).toEqual(['Content', 'Speaking', 'Supporting users']);
    expect(first.renewalCadence).toBe('annual');
    expect(first.expirationRule).toBe('Reviewed annually. As published 2026; edit to match.');
    expect(first.requirements.map(rule)).toEqual([
      ['content', 3, 3, ['content']],
      ['talks', 1, 2, ['speaking']],
      ['tutorials', 1, 1, ['labs', 'content']],
    ]);
    expect(first.recommendedActivities).toEqual([
      'Publish Git workflow tutorials',
      'Answer questions in the GitKraken community',
    ]);
    // Revision 3 replaced the check-in wording of 2026-10-08.
    expect(second.description).toMatch(/quarterly check-in, October 2026\)\.$/);
    expect(second.criteria).toContain('Reviews of GitKraken on G2, Capterra and TrustRadius');
    expect(second.requirements.map(rule)).toEqual([['quarterly-content', 2, 1, []]]);

    const [[captainRevision, captain], [captainLabsRevision, captainLabs]] = stepsOf('program-docker-captain');
    expect(captainRevision).toBe(2);
    expect(captain.description).toBe(
      'Docker Captains: technology experts and leaders in the Docker community who share their knowledge. Selected by Docker.'
    );
    expect(captain.applicationUrl).toBe('https://www.docker.com/community/captains/');
    expect(captain.requirements.map(rule)).toEqual([
      ['content', 4, 3, ['content', 'newsletter']],
      ['talks', 2, 2, ['speaking']],
      ['labs', 2, 1, ['labs', 'manual']],
    ]);
    // Revision 3 (#1302) took `manual` off `labs` and changed nothing else.
    expect(captainLabsRevision).toBe(3);
    expect(Object.keys(captainLabs)).toEqual(['requirements']);
    expect(captainLabs.requirements.map(rule)).toEqual([
      ['reach', 1, 3, ['manual']],
      ['content', 4, 2, ['content', 'newsletter']],
      ['community', 2, 2, ['manual', 'speaking']],
      ['labs', 2, 1, ['labs', 'manual']],
    ]);
    expect(captainLabs.requirements.map((r) => [r.label, r.description])).toEqual(
      byId('program-docker-captain').requirements.map((r) => [r.label, r.description])
    );

    // The MVP's revision 2 (#1302) added `manual` to `reach`, for the monthly audience rows.
    const [[mvpRevision, mvp]] = stepsOf('program-microsoft-mvp');
    expect(mvpRevision).toBe(2);
    expect(Object.keys(mvp)).toEqual(['requirements']);
    expect(mvp.requirements.map(rule)).toEqual([
      ['talks', 4, 3, ['speaking']],
      ['articles', 6, 3, ['content', 'newsletter']],
      ['depth', 1, 1, ['certifications', 'labs']],
      ['reach', 2, 1, ['listen-and-learn']],
    ]);
    expect(byId('program-microsoft-mvp').requirements.map(rule)).toEqual([
      ['talks', 4, 3, ['speaking']],
      ['articles', 6, 3, ['content', 'newsletter']],
      ['depth', 1, 1, ['certifications', 'labs']],
      ['reach', 2, 1, ['listen-and-learn', 'manual']],
    ]);

    const [[mieeRevision, miee]] = stepsOf('program-microsoft-elevate-educator-expert');
    expect(mieeRevision).toBe(2);
    expect(Object.keys(miee).sort()).toEqual(['applicationWindow', 'description', 'recommendedActivities']);
    expect(miee.applicationWindow).toEqual({
      opens: '2026-05-01',
      closes: '2026-07-31',
      note: 'Applications May to 31 July 2026; announcements September 2026.',
    });
    expect(miee.description).toMatch(/opens in May 2026 and closes 31 July 2026/);
    expect(miee.recommendedActivities).toContain('Apply before 31 July 2026');
    // The October 2026 window is open until 2026-10-31; it moves in November.
    expect(SUPERSEDED_SEED_VALUES['program-microsoft-mct-regional-lead']).toBeUndefined();
    const [[, builders]] = stepsOf('program-aws-community-builders');
    expect(builders.applicationWindow.note).toMatch(/^Waitlist open now/);
  });

  it('brings a stored row still holding each replaced value up to the current seed, once', () => {
    for (const [id, { revisions }] of Object.entries(SUPERSEDED_SEED_VALUES)) {
      const seed = byId(id);
      const target = currentSeedRevision(id);
      // A row seeded by the revision before each step, holding exactly what that step replaced.
      for (const { revision, fields } of revisions) {
        const stored = { ...seed, ...fields, seeded: true, seedRevision: revision - 1 };
        const patch = seedBackfillFor(stored, seed);
        const label = `${id} at ${revision - 1}`;
        expect(Object.keys(patch).sort(), label).toEqual([...Object.keys(fields), 'seedRevision'].sort());
        expect(patch.seedRevision, label).toBe(target);
        for (const field of Object.keys(fields)) expect(patch[field], `${label}.${field}`).toEqual(seed[field]);
        expect(seedBackfillFor({ ...stored, ...patch }, seed), label).toBeNull();
      }
    }
  });

  // CodeRabbit on #1304: a row that missed a revision is matched against the
  // values it actually holds, not only against the last step's.
  it('corrects a GitKraken row from #873 that never saw revision 2, and a revision-2 row alike, and keeps an edit at either', () => {
    const id = 'program-gitkraken-ambassador';
    const seed = byId(id);
    const [[, guess], [, checkIn]] = stepsOf(id);

    // The first seed stored no revision; a row from #873 holds the guess.
    const fromFirstSeed = { ...seed, ...guess, seeded: true };
    delete fromFirstSeed.seedRevision;
    const first = seedBackfillFor(fromFirstSeed, seed);
    expect(first.seedRevision).toBe(3);
    for (const field of Object.keys(guess)) expect(first[field], field).toEqual(seed[field]);
    expect(seedBackfillFor({ ...fromFirstSeed, ...first }, seed)).toBeNull();

    // A row revision 2 corrected holds the check-in wording.
    const fromCheckIn = { ...seed, ...checkIn, seeded: true, seedRevision: 2 };
    const second = seedBackfillFor(fromCheckIn, seed);
    expect(second.seedRevision).toBe(3);
    for (const field of Object.keys(checkIn)) expect(second[field], field).toEqual(seed[field]);
    expect(seedBackfillFor({ ...fromCheckIn, ...second }, seed)).toBeNull();

    // An edited field at either revision is the owner's and stays.
    const editedFirst = seedBackfillFor({ ...fromFirstSeed, description: 'Mine.' }, seed);
    expect(editedFirst.description).toBeUndefined();
    expect(editedFirst.criteria).toEqual(seed.criteria);
    const editedSecond = seedBackfillFor({ ...fromCheckIn, criteria: ['Mine'] }, seed);
    expect(editedSecond.criteria).toBeUndefined();
    expect(editedSecond.description).toBe(seed.description);
    // A field set back to the guess after the stamp is deliberate, and kept.
    expect(seedBackfillFor({ ...seed, seeded: true, seedRevision: 3, criteria: guess.criteria }, seed)).toBeNull();
  });

  it('gives every fixed-date window real days in order, and the coming cycle its dates', () => {
    for (const program of DEFAULT_PROGRAMS) {
      const { opens, closes } = program.applicationWindow;
      for (const day of [opens, closes]) {
        if (day !== null) expect(toCalendarDate(day), program.id).toBe(day);
      }
      if (opens && closes) expect(opens <= closes, program.id).toBe(true);
    }
    const miee = byId('program-microsoft-elevate-educator-expert');
    expect(miee.applicationWindow).toMatchObject({ opens: '2027-05-01', closes: '2027-07-31' });
    // Rolled with the window, so the seed does not contradict itself.
    expect(miee.description).toMatch(/open in May 2027 and close 31 July 2027/);
    expect(miee.description).not.toMatch(/July 2026/);
    expect(miee.recommendedActivities).toContain('Apply before 31 July 2027');
    // Open until 2026-10-31, so left as it is; it rolls to October 2027 in November.
    expect(byId('program-microsoft-mct-regional-lead').applicationWindow).toEqual({
      opens: '2026-10-01',
      closes: '2026-10-31',
      note: 'Nominations in September; application form in October; team announced 1 December.',
    });
    expect(byId('program-aws-community-builders').applicationWindow).toEqual({
      opens: null,
      closes: null,
      note: 'Annual cycle; the 2026 applications closed 2026-01-21; the next cycle opens in January 2027 (waitlist on builder.aws.com)',
    });
  });

  // The repository is public; a program's tracker is often private to its members.
  it('names no shared-document link in the seed file, and seeds no tracker', () => {
    for (const program of DEFAULT_PROGRAMS) expect(program.contributionTrackerUrl).toBeUndefined();
    const source = readFileSync(new URL('./programs.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/docs\.google\.com|spreadsheets|sharepoint\.com/i);
  });
});
