import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DEFAULT_PROGRAMS, SUPERSEDED_SEED_VALUES, currentSeedRevision } from './programs.js';
import { EVIDENCE_SOURCES, toCalendarDate } from './model.js';
import { seedBackfillFor } from './steps.js';

const byId = (id) => DEFAULT_PROGRAMS.find((p) => p.id === id);
const rule = (req) => [req.id, req.minCount, req.weight, req.evidenceTypes];
/** A program's history as [revision, fields] steps, oldest first. */
const stepsOf = (id) => SUPERSEDED_SEED_VALUES[id].revisions.map((s) => [s.revision, s.fields]);

/**
 * The SHA-256 of a value's JSON. A published seed value that names a program
 * is pinned by its digest, so an edit to it (a figure, a word, an id, the
 * order) fails here without this public file repeating it. If one of these
 * fails after a deliberate catalogue change, recompute the digest from the
 * new value and say in the pull request what changed.
 */
const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The seeds checked by hand below are picked by a trait only they have, and
// the tests describe them by that shape: this repository is public and names
// no real program outside the catalogue itself.
const seedWith = (label, test) => {
  const found = DEFAULT_PROGRAMS.filter(test);
  if (found.length !== 1) throw new Error(`expected one seed ${label}, found ${found.length}`);
  return found[0];
};
const has = (program, requirementId) => program.requirements.some((r) => r.id === requirementId);
/** The seed with an audience (`reach`) track and a hands-on (`labs`) one. */
const FOUR_TRACKS = seedWith('with reach and labs', (p) => has(p, 'reach') && has(p, 'labs'));
/** The seed whose questions end with a nominator's section; it has `reach` too. */
const NOMINATED = seedWith('with a nomination section', (p) =>
  (p.applicationQuestions ?? []).some((q) => q.section.startsWith('Nomination ('))
);
/** The open-source sponsorship: published images and project activity. */
const SPONSORSHIP = seedWith('with images and activity', (p) => has(p, 'images') && has(p, 'activity'));
/** The seed with mentorship, events and feedback asks. */
const MENTORSHIP = seedWith('with mentorship', (p) => has(p, 'mentorship'));
/** The seed that counts chats and people helped apart. */
const CHATS = seedWith('with chats', (p) => has(p, 'chats'));
/** The seed with a quarterly upkeep rule. */
const QUARTERLY = seedWith('with upkeep', (p) => p.upkeep);
/** The seed with a frequency grid among its questions (the child's scale aside). */
const GRID = seedWith('with a grid', (p) =>
  !p.parentProgramId && (p.applicationQuestions ?? []).some((q) => q.kind === 'scale')
);
/** The one seed additional to another, and that other. */
const CHILD = seedWith('with a parent', (p) => p.parentProgramId);
const PARENT = seedWith('that is a parent', (p) => p.id === CHILD.parentProgramId);
const WAITLISTED = seedWith('with a waitlist', (p) => /waitlist/.test(p.applicationWindow?.note ?? ''));

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

    expect(SUPERSEDED_SEED_VALUES[QUARTERLY.id]).toBeDefined();
    expect(currentSeedRevision(QUARTERLY.id)).toBe(3);
    expect(currentSeedRevision(FOUR_TRACKS.id)).toBe(4);
    expect(currentSeedRevision(NOMINATED.id)).toBe(3);
    expect(currentSeedRevision(PARENT.id)).toBeNull();
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

  it('counts the four-track seed against its tracks: the audience figure, content, community, labs', () => {
    const captain = byId('program-docker-captain');
    expect(captain.applicationUrl).toBe('https://app.advocu.com/dockercaptains/join');
    expect(captain.requirements.map(rule)).toEqual([
      ['reach', 1, 3, ['manual']],
      ['content', 4, 2, ['content', 'newsletter']],
      ['community', 2, 2, ['manual', 'speaking']],
      ['labs', 2, 1, ['labs', 'manual']],
    ]);
    // The audience requirement's published wording, its figure included.
    expect(digestOf(FOUR_TRACKS.requirements[0].description)).toBe(
      'eed861fe58d4552ec4cc7b7cf1418ced9826cc71880fa4cd119e1676b5c334e7'
    );
    // The tracks and exceptions as published, every figure included, in order.
    expect(digestOf(FOUR_TRACKS.criteria)).toBe(
      '6f01ea3018f1b3f9c6d123d931eb4e42f749db708e95628403a100693853fe7f'
    );
    expect(captain.eligibility).toContain('18 or older; open internationally');
    expect(captain.expirationRule).toMatch(/^One-year term/);
    expect(captain.applicationWindow).toEqual({
      opens: null,
      closes: null,
      note: expect.stringMatching(/Rolling applications through the Advocu join form/),
    });
  });

  it('seeds the open-source sponsorship as a yearly sponsorship with two counted asks', () => {
    const sponsorship = SPONSORSHIP;
    expect(sponsorship).toMatchObject({
      provider: 'Docker',
      category: 'partner',
      applicationUrl: 'https://www.docker.com/community/open-source/application/',
      renewalCadence: 'annual',
    });
    expect(sponsorship.requirements.map(rule)).toEqual([
      ['images', 1, 3, ['labs', 'manual']],
      ['activity', 1, 2, ['manual']],
    ]);
    expect(sponsorship.eligibility).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Open Source Initiative definition/),
        expect.stringMatching(/updates within the past 6 months/),
        expect.stringMatching(/Accepting donations to sustain the effort is permissible/i),
      ])
    );
    // The description as published, the paid-subscription exclusion included.
    expect(digestOf(sponsorship.description)).toBe(
      '7a108192e7516c410cc78e48262e2e00c8ca9631c70c23ee480c17f9b69942ca'
    );
  });

  it('seeds the mentorship program with the December window and its four contribution asks', () => {
    const mentorship = MENTORSHIP;
    expect(mentorship).toMatchObject({
      provider: 'HashiCorp',
      applicationUrl: 'https://www.hashicorp.com/en/ambassador',
      renewalCadence: 'annual',
    });
    expect(mentorship.applicationWindow).toEqual({
      opens: '2026-12-01',
      closes: '2027-01-05',
      note: expect.stringMatching(/^Submissions open annually 1 December to 5 January/),
    });
    expect(mentorship.requirements.map(rule)).toEqual([
      ['content', 3, 3, ['content', 'newsletter', 'listen-and-learn']],
      ['mentorship', 1, 2, ['manual', 'speaking', 'labs']],
      ['events', 1, 1, ['speaking']],
      ['feedback', 1, 1, ['manual']],
    ]);
    expect(mentorship.criteria).toEqual(
      expect.arrayContaining(['Knowledge sharing', 'Mentorship', 'Kindness'])
    );
    expect(mentorship.eligibility).toEqual(
      expect.arrayContaining([expect.stringMatching(/preceding twelve months/)])
    );
  });

  it('models the chats program as the chats and the people helped, counted apart, plus the star and the templates', () => {
    const chats = CHATS;
    expect(chats).toMatchObject({
      provider: 'Coder',
      applicationUrl: 'https://coder.com/coder-champions',
      renewalCadence: 'annual',
      expirationRule: 'Year-long programme; quarterly activity audits after the first year.',
    });
    expect(chats.requirements.map(rule)).toEqual([
      ['chats', 5, 2, ['manual']],
      ['help', 2, 3, ['manual']],
      ['star', 1, 1, ['manual']],
      ['templates', 1, 2, ['labs']],
    ]);
    expect(chats.applicationWindow).toEqual({ opens: null, closes: null, note: 'Rolling; no cohort dates.' });
  });

  it('words the quarterly seed as the published tiers, keeping the quarterly upkeep and its one counted rule', () => {
    const gk = QUARTERLY;
    // The published tiers and programme-wide asks, every figure included, in order.
    expect(digestOf(gk.criteria)).toBe('fe2097e693b12e82b43db437c0166c434dab18cf767a8d39b67454a70be3542c');
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
    const [[, first], [, second]] = stepsOf(QUARTERLY.id);
    expect(stepsOf(QUARTERLY.id).map(([r]) => r)).toEqual([2, 3]);
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

    const [[captainRevision, captain], [captainLabsRevision, captainLabs], [captainBackRevision, captainBack]] =
      stepsOf(FOUR_TRACKS.id);
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
      FOUR_TRACKS.requirements.map((r) => [r.label, r.description])
    );
    // Revision 4 (#1313) put `manual` back on `labs` once the audience rows name
    // `reach`, and records the list it replaced: revision 3's, without it.
    expect(captainBackRevision).toBe(4);
    expect(Object.keys(captainBack)).toEqual(['requirements']);
    expect(captainBack.requirements.map(rule)).toEqual([
      ['reach', 1, 3, ['manual']],
      ['content', 4, 2, ['content', 'newsletter']],
      ['community', 2, 2, ['manual', 'speaking']],
      ['labs', 2, 1, ['labs']],
    ]);
    expect(FOUR_TRACKS.requirements.map(rule)).toEqual([
      ['reach', 1, 3, ['manual']],
      ['content', 4, 2, ['content', 'newsletter']],
      ['community', 2, 2, ['manual', 'speaking']],
      ['labs', 2, 1, ['labs', 'manual']],
    ]);

    // The nominated seed's revision 2 (#1302) added `manual` to `reach`, for the monthly audience rows.
    const [[nominatedRevision, nominated], [questionsRevision, questions]] = stepsOf(NOMINATED.id);
    // Revision 3 (#1543) appended the nomination form and changed nothing else.
    expect(questionsRevision).toBe(3);
    expect(Object.keys(questions)).toEqual(['applicationQuestions']);
    expect(nominatedRevision).toBe(2);
    expect(Object.keys(nominated)).toEqual(['requirements']);
    expect(nominated.requirements.map(rule)).toEqual([
      ['talks', 4, 3, ['speaking']],
      ['articles', 6, 3, ['content', 'newsletter']],
      ['depth', 1, 1, ['certifications', 'labs']],
      ['reach', 2, 1, ['listen-and-learn']],
    ]);
    expect(NOMINATED.requirements.map(rule)).toEqual([
      ['talks', 4, 3, ['speaking']],
      ['articles', 6, 3, ['content', 'newsletter']],
      ['depth', 1, 1, ['certifications', 'labs']],
      ['reach', 2, 1, ['listen-and-learn', 'manual']],
    ]);

    const [[gridRevision, grid]] = stepsOf(GRID.id);
    expect(gridRevision).toBe(2);
    expect(Object.keys(grid).sort()).toEqual(['applicationWindow', 'description', 'recommendedActivities']);
    expect(grid.applicationWindow).toEqual({
      opens: '2026-05-01',
      closes: '2026-07-31',
      note: 'Applications May to 31 July 2026; announcements September 2026.',
    });
    expect(grid.description).toMatch(/opens in May 2026 and closes 31 July 2026/);
    expect(grid.recommendedActivities).toContain('Apply before 31 July 2026');
    // The October 2026 window is open until 2026-10-31; it moves in November.
    expect(SUPERSEDED_SEED_VALUES[CHILD.id]).toBeUndefined();
    const [[, waitlisted]] = stepsOf(WAITLISTED.id);
    expect(waitlisted.applicationWindow.note).toMatch(/^Waitlist open now/);
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
  it('corrects a quarterly row from #873 that never saw revision 2, and a revision-2 row alike, and keeps an edit at either', () => {
    const id = QUARTERLY.id;
    const seed = QUARTERLY;
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
    expect(GRID.applicationWindow).toMatchObject({ opens: '2027-05-01', closes: '2027-07-31' });
    // Rolled with the window, so the seed does not contradict itself.
    expect(GRID.description).toMatch(/open in May 2027 and close 31 July 2027/);
    expect(GRID.description).not.toMatch(/July 2026/);
    expect(GRID.recommendedActivities).toContain('Apply before 31 July 2027');
    // Open until 2026-10-31, so left as it is; it rolls to October 2027 in November.
    expect(CHILD.applicationWindow).toEqual({
      opens: '2026-10-01',
      closes: '2026-10-31',
      note: 'Nominations in September; application form in October; team announced 1 December.',
    });
    expect(WAITLISTED.applicationWindow).toEqual({
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

// #1543: the nomination form, filled in by the nominator, follows the
// application the nominee completes. Revision 3 records the list before it.
describe('the nomination form (#1543)', () => {
  const seed = NOMINATED;
  const nominationPrefix = `${seed.applicationQuestions.at(-1).id.split('-nom-')[0]}-nom-`;
  const nomination = seed.applicationQuestions.filter((q) => q.id.startsWith(nominationPrefix));
  const [, [, before]] = stepsOf(seed.id);

  it('keeps the nomination question ids, in order: answers are stored by questionId', () => {
    expect(nomination).toHaveLength(11);
    expect(digestOf(nomination.map((q) => q.id))).toBe(
      '270fb10a3a4ee185549ef42b034e023eff942683f32b49c89b609595c1141eb4'
    );
  });

  it('appends the form after the application, with its labels, kinds and limits', () => {
    expect(seed.applicationQuestions.slice(-nomination.length)).toEqual(nomination);
    expect(new Set(nomination.map((q) => q.section))).toEqual(
      new Set(['Nomination (filled in by your nominator)'])
    );
    expect(nomination.map((q) => [q.prompt, q.kind, q.maxChars, q.required])).toEqual([
      ['First Name', 'profile', null, true],
      ['Last Name', 'profile', null, true],
      ['Email Address', 'profile', null, true],
      ['Title', 'profile', null, false],
      ['Country or Region', 'profile', null, true],
      ['State or Province', 'profile', null, false],
      ['How long have you known the nominee?', 'profile', null, true],
      ['How did you meet and how have you engaged with your nominee?', 'text', 500, true],
      ['How has your nominee demonstrated impact with technology?', 'text', 500, true],
      [
        'How has your nominee demonstrated impact and influence as a community leader?',
        'text',
        500,
        true,
      ],
      [
        'Is there additional information that you would like us to know about your nominee for consideration?',
        'text',
        500,
        false,
      ],
    ]);
    // The process is explained where the section starts; every text area carries its advice.
    // Who may nominate, as the program's own FAQ words it.
    expect(digestOf(nomination[0].hint)).toBe(
      '19ecb125a9e3aa98568964432a4b6768041b1a36de2ecaa5a18d676d671b3176'
    );
    expect(nomination[0].hint).toMatch(/45 days/);
    for (const q of nomination.filter((n) => n.kind === 'text')) {
      expect(q.hint, q.id).toMatch(/80 to 90 words/);
    }
    // No guessed drop-down lists: the form's options are not published.
    for (const q of nomination) expect(q.options, q.id).toEqual([]);
  });

  it('records the revision-2 question list exactly as main seeded it, frozen', () => {
    const list = before.applicationQuestions;
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0])).toBe(true);
    expect(list).toHaveLength(28);
    expect(list.some((q) => q.id.startsWith(nominationPrefix))).toBe(false);
    expect(seed.applicationQuestions.slice(0, list.length)).toEqual(list);
    // The list as it was seeded before #1543. If this fails, an application
    // question changed: write the old list out literally in programs.js first.
    const digest = createHash('sha256').update(JSON.stringify(list)).digest('hex');
    expect(digest).toBe('30b6d834a84ee24718162b209f08062c7bbcc92e7cdbb4e009fb2c09a66180a8');
  });

  it('gives a stored row still holding the revision-2 questions the new list, once', () => {
    const stored = {
      ...seed,
      applicationQuestions: before.applicationQuestions,
      seeded: true,
      seedRevision: 2,
    };
    const patch = seedBackfillFor(stored, seed);
    expect(patch).toEqual({ applicationQuestions: seed.applicationQuestions, seedRevision: 3 });
    expect(seedBackfillFor({ ...stored, ...patch }, seed)).toBeNull();
  });

  it('keeps a question list that was changed, and only stamps the revision', () => {
    const changed = before.applicationQuestions.map((q, i) => (i === 5 ? { ...q, hint: 'Mine.' } : q));
    const stored = { ...seed, applicationQuestions: changed, seeded: true, seedRevision: 2 };
    expect(seedBackfillFor(stored, seed)).toEqual({ seedRevision: 3 });
  });
});
