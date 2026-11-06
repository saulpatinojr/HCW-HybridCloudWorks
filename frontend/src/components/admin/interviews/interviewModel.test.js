/**
 * The plain rules behind the admin interview pages (interviewModel.js): the
 * consent sentence pinned to the server's, the step the page starts by
 * itself (and the ones it must never start), the drafting progress, the form
 * checks and bodies, the Q&A helpers and the status moves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_WORDING_V1,
  audioProblemFor,
  createBody,
  defaultConsentDate,
  detailsUpdates,
  draftingProgress,
  emptyForm,
  formFromDoc,
  formProblems,
  interviewIdOf,
  isInFlight,
  isRealDate,
  LIMITS,
  livePagePath,
  moveQa,
  nextStep,
  parseTags,
  qaForSave,
  qaProblems,
  stageDetail,
  stageOf,
  statusActions,
  todayUtc,
} from './interviewModel';

/** One saved pass, as draft.js writes it. */
const CHECKPOINT = { transcriptVersion: 2, qa: [{ q: 'q', a: 'a', pullQuote: '' }], speakers: {} };

const here = path.dirname(fileURLToPath(import.meta.url));
const consentFile = path.resolve(here, '../../../../../functions/src/lib/interviews/consent.js');

describe('the consent sentence', () => {
  it('is word for word the server’s CONSENT_WORDING_V1', () => {
    const source = fs.readFileSync(consentFile, 'utf8');
    const block = source.slice(source.indexOf('export const CONSENT_WORDING_V1'));
    const literal = block.slice(0, block.indexOf(';'));
    const server = [...literal.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
    expect(server).toBe(CONSENT_WORDING_V1);
  });
});

describe('the interview limits', () => {
  it('are the server schema’s', () => {
    const schema = fs.readFileSync(path.resolve(path.dirname(consentFile), 'schema.js'), 'utf8');
    for (const [name, value] of Object.entries({
      MAX_TITLE: LIMITS.MAX_TITLE,
      MAX_SHORT: LIMITS.MAX_SHORT,
      MAX_ANSWER: LIMITS.MAX_ANSWER,
      MAX_QA: LIMITS.MAX_QA,
      MAX_TAGS: LIMITS.MAX_TAGS,
    })) {
      expect(schema, name).toMatch(new RegExp(`${name}: ${value},`));
    }
  });
});

describe('addresses the page builds from stored values', () => {
  it('links only a live page path on this site', () => {
    expect(livePagePath('/azure/interviews/landing-zones')).toBe('/azure/interviews/landing-zones');
    expect(livePagePath('https://phish.example/azure/interviews/x')).toBeNull();
    expect(livePagePath('//phish.example/x')).toBeNull();
    expect(livePagePath('javascript:alert(1)')).toBeNull();
    expect(livePagePath('/azure/interviews/../admin')).toBeNull();
    expect(livePagePath(null)).toBeNull();
  });

  it('accepts an interview id only in the shape the routes take', () => {
    expect(interviewIdOf(' 3f2a-b_c ')).toBe('3f2a-b_c');
    expect(interviewIdOf('..')).toBe('');
    expect(interviewIdOf('a/b')).toBe('');
    expect(interviewIdOf('')).toBe('');
  });
});

describe('nextStep: what the page starts by itself', () => {
  const audio = { provenance: { audio: { path: 'audio/i/u.mp3' } } };

  it('transcribes a recording that has no transcript yet', () => {
    expect(nextStep({ ...audio, interview: { stage: 'fetched' } })).toBe('transcribe');
    expect(nextStep({ ...audio, interview: { stage: 'created' } })).toBe('transcribe');
    expect(nextStep({ ...audio })).toBe('transcribe');
  });

  it('drafts a finished transcript that has no questions yet', () => {
    for (const status of ['done', 'provided']) {
      expect(
        nextStep({
          interview: { stage: 'transcribed' },
          transcription: { version: 1, status },
          qa: [],
        })
      ).toBe('draft');
    }
  });

  it('never replaces questions the owner may have edited, and never starts while a job runs', () => {
    expect(
      nextStep({
        interview: { stage: 'transcribed' },
        transcription: { version: 2, status: 'done' },
        qa: [{ q: 'q', a: 'a' }],
      })
    ).toBeNull();
    expect(
      nextStep({ ...audio, interview: { stage: 'fetched' }, transcription: { version: 1 } })
    ).toBeNull();
    expect(nextStep({ ...audio, interview: { stage: 'transcribing' } })).toBeNull();
    expect(nextStep({ interview: { stage: 'failed' } })).toBeNull();
    expect(nextStep({ interview: { stage: 'created' } })).toBeNull();
    expect(nextStep(null)).toBeNull();
  });
});

describe('stages', () => {
  it('reads the stage, with created for a new document', () => {
    expect(stageOf({})).toBe('created');
    expect(stageOf({ interview: { stage: 'ready' } })).toBe('ready');
    expect(isInFlight({ interview: { stage: 'drafting' } })).toBe(true);
    expect(isInFlight({ interview: { stage: 'ready' } })).toBe(false);
  });

  it('says which hour is being transcribed and which pass is being drafted', () => {
    expect(stageDetail({ interview: { stage: 'transcribing', window: 0 } })).toMatch(/Sending/);
    expect(stageDetail({ interview: { stage: 'transcribing', window: 2 } })).toBe(
      'Working on hour 3 of the recording.'
    );
    expect(
      stageDetail({
        interview: { stage: 'drafting' },
        transcription: { version: 2, status: 'done' },
        provenance: { drafting: { transcriptVersion: 2, passCount: 3, passes: [CHECKPOINT] } },
      })
    ).toBe('Pass 2 of 3 over the transcript.');
    expect(stageDetail({ interview: { stage: 'drafting' } })).toMatch(/Reading the transcript/);
    expect(stageDetail({ interview: { stage: 'ready' } })).toBe('');
  });

  it('reads the checkpoints in the shape draft.js writes, for the current transcript only', () => {
    const running = (over = {}) => ({
      transcription: { version: 2, status: 'done' },
      provenance: {
        drafting: {
          transcriptVersion: 2,
          passCount: 4,
          passes: [CHECKPOINT, CHECKPOINT],
          updatedAt: '2026-11-05T10:00:00Z',
          ...over,
        },
      },
    });
    expect(draftingProgress({})).toBeNull();
    expect(draftingProgress(running())).toEqual({ done: 2, total: 4 });
    // Checkpoints left from an older transcript are not this draft's progress.
    expect(draftingProgress(running({ transcriptVersion: 1 }))).toBeNull();
    // A finished draft clears the checkpoints and keeps the count.
    const finished = {
      transcription: { version: 2, status: 'done' },
      provenance: { drafting: { passCount: 4, transcriptVersion: 2, draftedAt: 'x' } },
    };
    expect(draftingProgress(finished)).toBeNull();
    expect(stageDetail({ ...finished, interview: { stage: 'drafting' } })).toMatch(
      /Reading the transcript/
    );
  });
});

describe('dates', () => {
  it('starts the consent date on the local day, never past today in UTC', () => {
    const late = new Date('2026-11-05T23:30:00-08:00');
    expect(todayUtc(late)).toBe('2026-11-06');
    expect(defaultConsentDate(late) <= todayUtc(late)).toBe(true);
  });

  it('knows a real date', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('26-2-3')).toBe(false);
  });
});

describe('the new-interview form', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const filled = {
    ...emptyForm(now),
    title: 'A conversation about landing zones',
    guestName: 'Ada Example',
    guestRole: 'Cloud architect',
    tags: 'Azure, landing zones, azure',
    consentConfirmed: true,
    consentDate: '2026-11-01',
    transcript: 'Speaker 1: Hello\nSpeaker 2: Hi',
  };

  it('accepts a complete form', () => {
    expect(formProblems(filled, { now })).toEqual({});
  });

  it('names every missing or wrong field', () => {
    const problems = formProblems(
      { ...emptyForm(now), date: 'nope', transcript: '' },
      { now, photo: { name: 'p.png' } }
    );
    expect(Object.keys(problems).sort()).toEqual(
      ['consent', 'date', 'guestName', 'photoAlt', 'source', 'title'].sort()
    );
    expect(formProblems({ ...filled, consentDate: '2026-11-09' }, { now }).consent).toMatch(
      /future/
    );
    expect(formProblems({ ...filled, consentDate: '' }, { now }).consent).toMatch(/date/);
    expect(formProblems({ ...filled, title: 'x'.repeat(161) }, { now }).title).toMatch(/160/);
    expect(
      formProblems({ ...filled, source: 'url', url: 'http://x.test/a.mp3' }, { now }).source
    ).toMatch(/https/);
    expect(
      formProblems({ ...filled, source: 'url', url: 'https://x.test/a.mp3' }, { now })
    ).toEqual({});
    expect(
      formProblems({ ...filled, source: 'file' }, { now, audioProblem: 'Too long.' }).source
    ).toBe('Too long.');
    expect(formProblems({ ...filled, source: 'other' }, { now }).source).toMatch(/Choose/);
    expect(formProblems({ ...filled, transcript: 'x'.repeat(400_001) }, { now }).source).toMatch(
      /400,000/
    );
  });

  it('says why a chosen recording cannot go yet', () => {
    expect(audioProblemFor('transcript', null)).toBe('');
    expect(audioProblemFor('file', null)).toMatch(/Choose/);
    expect(audioProblemFor('file', { file: {}, reading: true })).toMatch(/still being read/);
    expect(audioProblemFor('file', { file: {}, problem: 'No.' })).toBe('No.');
    expect(audioProblemFor('file', { file: {}, problem: '' })).toBe('');
  });

  it('builds the create body with tags as slugs and the consent as given', () => {
    expect(createBody(filled)).toEqual({
      title: 'A conversation about landing zones',
      subtitle: '',
      date: filled.date,
      guest: { name: 'Ada Example', role: 'Cloud architect' },
      bio: '',
      tags: ['azure', 'landing-zones'],
      consent: { confirmed: true, date: '2026-11-01' },
    });
    expect(createBody({ ...filled, guestRole: ' ' }).guest).toEqual({ name: 'Ada Example' });
  });

  it('round-trips a stored document through the details form without the consent', () => {
    const doc = {
      title: 'T',
      subtitle: 'S',
      date: '2026-10-01',
      guest: { name: 'G', role: 'R' },
      bio: 'B',
      tags: ['a', 'b-c'],
      image: { src: '/x.png', alt: 'A' },
    };
    const form = formFromDoc(doc);
    expect(form).toMatchObject({ title: 'T', tags: 'a, b-c', photoAlt: 'A' });
    expect(detailsUpdates(form)).toEqual({
      title: 'T',
      subtitle: 'S',
      date: '2026-10-01',
      guest: { name: 'G', role: 'R' },
      bio: 'B',
      tags: ['a', 'b-c'],
    });
    expect(formFromDoc({ Title: 'Legacy' }).title).toBe('Legacy');
  });

  it('turns typed tags into lower-case hyphenated words, once each', () => {
    expect(parseTags(' Azure , Landing Zones!, , azure')).toEqual(['azure', 'landing-zones']);
  });
});

describe('the Q&A list', () => {
  it('moves an item and stays put at the ends', () => {
    const qa = [{ q: '1' }, { q: '2' }, { q: '3' }];
    expect(moveQa(qa, 0, 1).map((i) => i.q)).toEqual(['2', '1', '3']);
    expect(moveQa(qa, 0, -1)).toBe(qa);
    expect(moveQa(qa, 2, 1)).toBe(qa);
  });

  it('lists what stops a save', () => {
    expect(qaProblems([])).toEqual(['Keep at least one question and answer.']);
    const problems = qaProblems([
      { q: '', a: '' },
      { q: 'x'.repeat(241), a: 'y'.repeat(6001), pullQuote: 'z'.repeat(241) },
    ]);
    expect(problems).toEqual([
      'Question 1 is empty.',
      'Answer 1 is empty.',
      'Question 2 is longer than 240 characters.',
      'Answer 2 is longer than 6000 characters.',
      'The pull quote of question 2 is longer than 240 characters.',
    ]);
    expect(qaProblems(Array.from({ length: 41 }, () => ({ q: 'q', a: 'a' })))).toEqual([
      'Keep at most 40 questions.',
    ]);
  });

  it('trims for saving and keeps the honesty flag only where it is still set', () => {
    expect(
      qaForSave([
        { q: ' q ', a: ' a ', needsReview: true },
        { q: 'q', a: 'a', pullQuote: ' p ', needsReview: false },
      ])
    ).toEqual([
      { q: 'q', a: 'a', pullQuote: '', needsReview: true },
      { q: 'q', a: 'a', pullQuote: 'p' },
    ]);
  });
});

describe('statusActions', () => {
  it('offers the next move with the role the server asks for', () => {
    expect(statusActions('draft', { hasQa: true })).toEqual([
      { id: 'review', label: 'Send to review', minRole: 'editor', to: 'in_review' },
    ]);
    expect(statusActions('in_review', { hasQa: true })[0]).toMatchObject({
      id: 'approve',
      to: 'approved',
    });
    expect(statusActions('approved', { hasQa: true })[0]).toMatchObject({
      id: 'publish',
      minRole: 'publisher',
    });
    expect(statusActions('inspected', { hasQa: true })[0].id).toBe('review');
    expect(statusActions('published')[0]).toMatchObject({ id: 'unpublish', minRole: 'publisher' });
    expect(statusActions('approved', { live: true })[0].id).toBe('unpublish');
  });

  it('offers nothing to review without questions, and nothing for an unknown status', () => {
    expect(statusActions('draft', { hasQa: false })).toEqual([]);
    expect(statusActions('archived', { hasQa: true })).toEqual([]);
  });
});
