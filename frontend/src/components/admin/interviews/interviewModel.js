/**
 * interviewModel.js — the plain rules behind the admin interview pages
 * (ADR 0040, D5, D7 and D9; issue #1565). No React and no network here, so
 * every rule is tested on its own (interviewModel.test.js).
 *
 * The server is the authority on every one of these: the create route checks
 * the consent and the fields (functions/src/lib/interviews/admin.js and
 * consent.js), the update route checks the fields against the interview
 * schema (functions/src/lib/interviews/schema.js), and publishing checks the
 * consent again. The checks here exist so the owner reads a plain sentence
 * beside the field before anything is sent.
 */

/**
 * The sentence the consent box shows. Copied from CONSENT_WORDING_V1 in
 * functions/src/lib/interviews/consent.js, which stores `wording: 'v1'` on
 * the record; interviewModel.test.js reads that file and fails if the two
 * differ, because the record says the guest agreed to exactly these words.
 */
export const CONSENT_WORDING_V1 =
  'The guest has agreed that this interview may be published on hybridcloudworks.com, ' +
  'and knows the recording is kept privately for the site’s records.';

/** The limits `normalizeInterview` and the server schema share. */
export const LIMITS = Object.freeze({
  MAX_TITLE: 160,
  MAX_SHORT: 240,
  MAX_ANSWER: 6000,
  MAX_QA: 40,
  MAX_TAGS: 20,
  MAX_TRANSCRIPT: 400_000,
});

/** Lower-case words joined by hyphens, the shape the server keeps a tag in. */
const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What each stage of `interview.stage` means, in the words the page shows. */
export const STAGE_LABELS = Object.freeze({
  created: 'Waiting for a recording or a transcript',
  uploading: 'Uploading the recording',
  fetching: 'Downloading the recording from the link',
  fetched: 'Recording received',
  transcribing: 'Transcribing the recording',
  transcribed: 'Transcript ready',
  drafting: 'Drafting the questions and answers',
  ready: 'Draft ready for your review',
  failed: 'Stopped with a problem',
});

/** Stages a job is working on: the page checks again every few seconds. */
export const IN_FLIGHT_STAGES = Object.freeze([
  'uploading',
  'fetching',
  'transcribing',
  'drafting',
]);

/** The status names the content pipeline uses, in plain words. */
export const STATUS_LABELS = Object.freeze({
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  published: 'Published',
  inspected: 'Unpublished',
  rejected: 'Rejected',
  archived: 'Archived',
});

/** The stage an interview document is at; a new one is `created`. */
export function stageOf(doc) {
  const stage = doc?.interview?.stage;
  return typeof stage === 'string' && stage ? stage : 'created';
}

/** True while a job is still working on the interview. */
export function isInFlight(doc) {
  return IN_FLIGHT_STAGES.includes(stageOf(doc));
}

const hasQa = (doc) => Array.isArray(doc?.qa) && doc.qa.length > 0;

/**
 * The next step the page starts by itself, or null.
 *
 * A job does not start the next one (functions/src/functions/interviews-jobs.js
 * says why), so the page does, but only where nothing the owner made can be
 * lost: a recording with no transcript yet is transcribed, and a transcript
 * with no questions yet is drafted. Once a Q&A exists, a new draft waits for
 * the owner's "Draft again", because a draft replaces the list.
 *
 * @param {object} doc - the interview document from GET cms/interviews/{id}
 * @returns {'transcribe' | 'draft' | null}
 */
export function nextStep(doc) {
  if (!doc) return null;
  const stage = stageOf(doc);
  const transcription = doc.transcription || {};
  const hasTranscript = Number.isInteger(transcription.version) && transcription.version > 0;
  const audio = doc.provenance?.audio;
  if (!hasTranscript && audio?.path && (stage === 'fetched' || stage === 'created')) {
    return 'transcribe';
  }
  if (
    stage === 'transcribed' &&
    ['done', 'provided'].includes(transcription.status) &&
    !hasQa(doc)
  ) {
    return 'draft';
  }
  return null;
}

/**
 * The drafting checkpoints as `{ done, total }`, or null when there are none
 * for the current transcript. While a draft runs, the job saves each pass's
 * items as it finishes (functions/src/lib/interviews/draft.js):
 * `provenance.drafting = { transcriptVersion, passCount, passes: [...] }`, so
 * a retried draft resumes and the page can say "pass 2 of 4". A finished
 * draft clears `passes` and keeps `passCount`; checkpoints of an older
 * transcript version are not this draft's progress.
 */
export function draftingProgress(doc) {
  const drafting = doc?.provenance?.drafting;
  if (!drafting || typeof drafting !== 'object' || !Array.isArray(drafting.passes)) return null;
  const current = doc?.transcription?.version;
  if (Number.isInteger(current) && drafting.transcriptVersion !== current) return null;
  const total =
    Number.isInteger(drafting.passCount) && drafting.passCount > 0 ? drafting.passCount : null;
  if (!total) return null;
  return { done: Math.min(drafting.passes.length, total), total };
}

/**
 * The live page's address for the link on the status panel, or null. Only a
 * path on this site under /azure/interviews/ is linked: the stored value can
 * be edited through the generic content route, and the admin must never be
 * sent to another site from here.
 */
export function livePagePath(value) {
  return typeof value === 'string' && /^\/azure\/interviews\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    ? value
    : null;
}

/** An interview id as the routes accept it (functions/src/lib/interviews/admin.js), else ''. */
export function interviewIdOf(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
}

/** One line of detail under the stage: the window or the pass being worked on. */
export function stageDetail(doc) {
  const stage = stageOf(doc);
  if (stage === 'transcribing') {
    const window = doc?.interview?.window;
    return Number.isInteger(window) && window > 0
      ? `Working on hour ${window + 1} of the recording.`
      : 'Sending the recording to the transcription service.';
  }
  if (stage === 'drafting') {
    const progress = draftingProgress(doc);
    if (progress?.total && progress.total > 1) {
      return `Pass ${Math.min(progress.done + 1, progress.total)} of ${progress.total} over the transcript.`;
    }
    return 'Reading the transcript and writing the questions and answers.';
  }
  return '';
}

/** Today as `YYYY-MM-DD` in UTC, the clock the server judges the consent date by. */
export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * The date the consent box starts on: the local calendar day, unless that is
 * already tomorrow in UTC (east of Greenwich late in the evening), when the
 * server would call it the future.
 */
export function defaultConsentDate(now = new Date()) {
  const local = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const utc = todayUtc(now);
  return local > utc ? utc : local;
}

/** Tags typed as `azure, landing zones` become `['azure', 'landing-zones']`. */
export function parseTags(text) {
  return [
    ...new Set(
      String(text || '')
        .split(',')
        .map((tag) =>
          tag
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
        )
        .filter(Boolean)
    ),
  ];
}

/** The form a new interview starts with. */
export function emptyForm(now = new Date()) {
  return {
    title: '',
    subtitle: '',
    date: defaultConsentDate(now),
    guestName: '',
    guestRole: '',
    bio: '',
    tags: '',
    consentConfirmed: false,
    consentDate: defaultConsentDate(now),
    source: 'transcript',
    url: '',
    transcript: '',
    photoAlt: '',
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written `YYYY-MM-DD`. */
export function isRealDate(value) {
  if (!ISO_DATE.test(String(value || ''))) return false;
  const [y, m, d] = value.split('-').map(Number);
  const real = new Date(Date.UTC(y, m - 1, d));
  return real.getUTCFullYear() === y && real.getUTCMonth() === m - 1 && real.getUTCDate() === d;
}

/**
 * The problems with the guest's details, by field. Shared by the new form
 * and the edit page's details section.
 */
export function detailsProblems(form) {
  const problems = {};
  const title = String(form.title || '').trim();
  if (!title) problems.title = 'Give the interview a title.';
  else if (title.length > LIMITS.MAX_TITLE) {
    problems.title = `The title is ${title.length} characters; the most is ${LIMITS.MAX_TITLE}.`;
  }
  if (String(form.subtitle || '').trim().length > LIMITS.MAX_SHORT) {
    problems.subtitle = `The subtitle can be at most ${LIMITS.MAX_SHORT} characters.`;
  }
  if (!isRealDate(form.date)) problems.date = 'Give the interview date as a real date.';
  const name = String(form.guestName || '').trim();
  if (!name) problems.guestName = 'The guest’s name is required.';
  else if (name.length > LIMITS.MAX_SHORT) problems.guestName = 'The name is too long.';
  if (String(form.guestRole || '').trim().length > LIMITS.MAX_SHORT) {
    problems.guestRole = `The role can be at most ${LIMITS.MAX_SHORT} characters.`;
  }
  if (String(form.bio || '').trim().length > LIMITS.MAX_ANSWER) {
    problems.bio = `The bio can be at most ${LIMITS.MAX_ANSWER} characters.`;
  }
  const tags = parseTags(form.tags);
  if (tags.length > LIMITS.MAX_TAGS) problems.tags = `Use at most ${LIMITS.MAX_TAGS} tags.`;
  else if (tags.some((tag) => !TAG.test(tag))) problems.tags = 'Tags are words and hyphens only.';
  return problems;
}

/**
 * Every problem with the new-interview form, by field, or `{}` when it can be
 * sent. `photo` is the chosen image file (or null) and `audio` is
 * `{ problem }` from the file check and the length read.
 */
export function formProblems(form, { now = new Date(), audioProblem = '', photo = null } = {}) {
  const problems = detailsProblems(form);
  if (!form.consentConfirmed) {
    problems.consent = 'Tick the box once the guest has agreed to publication.';
  } else if (!isRealDate(form.consentDate)) {
    problems.consent = 'Give the date the guest agreed.';
  } else if (form.consentDate > todayUtc(now)) {
    problems.consent = 'The date the guest agreed cannot be in the future.';
  }
  if (photo && !String(form.photoAlt || '').trim()) {
    problems.photoAlt = 'Describe the photo in a few words, for people who cannot see it.';
  }
  const source = sourceProblem(form, audioProblem);
  if (source) problems.source = source;
  return problems;
}

/**
 * The problem with the interview's source, or ''. `audioProblem` is the
 * file check's sentence when the source is a file.
 */
export function sourceProblem(form, audioProblem = '') {
  if (form.source === 'transcript') {
    const text = String(form.transcript || '');
    if (!text.trim()) return 'Paste the transcript.';
    if (text.length > LIMITS.MAX_TRANSCRIPT) {
      return 'The transcript is longer than 400,000 characters. Split the interview.';
    }
    return '';
  }
  if (form.source === 'url') {
    let parsed = null;
    try {
      parsed = new URL(String(form.url || '').trim());
    } catch {
      parsed = null;
    }
    return parsed && parsed.protocol === 'https:'
      ? ''
      : 'Give the recording’s address, starting with https://.';
  }
  if (form.source === 'file') return audioProblem || '';
  return 'Choose where the interview comes from.';
}

/** The file check's sentence for a chosen recording, or '' when it can go. */
export function audioProblemFor(source, audio) {
  if (source !== 'file') return '';
  if (!audio?.file) return 'Choose a recording file.';
  if (audio.reading) return 'Wait a moment: the recording’s length is still being read.';
  return audio.problem || '';
}

/** The body of POST cms/interviews for a checked form. */
export function createBody(form) {
  const role = String(form.guestRole || '').trim();
  return {
    title: String(form.title).trim(),
    subtitle: String(form.subtitle || '').trim(),
    date: form.date,
    guest: { name: String(form.guestName).trim(), ...(role ? { role } : {}) },
    bio: String(form.bio || '').trim(),
    tags: parseTags(form.tags),
    consent: { confirmed: true, date: form.consentDate },
  };
}

/** The details form for a stored interview document. */
export function formFromDoc(doc = {}) {
  return {
    title: doc.title || doc.Title || '',
    subtitle: doc.subtitle || '',
    date: doc.date || '',
    guestName: doc.guest?.name || '',
    guestRole: doc.guest?.role || '',
    bio: doc.bio || '',
    tags: Array.isArray(doc.tags) ? doc.tags.join(', ') : '',
    photoAlt: doc.image?.alt || '',
  };
}

/** The updates updateContentItem takes for the details form. */
export function detailsUpdates(form) {
  const body = createBody({ ...form, consentDate: '' });
  delete body.consent;
  return body;
}

/** An empty question for the editor's Add button. */
export const emptyQaItem = () => ({ q: '', a: '', pullQuote: '' });

/** The Q&A list with item `index` moved by `delta` (−1 up, +1 down). */
export function moveQa(qa, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= qa.length) return qa;
  const next = qa.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** The problems with a Q&A list before it is saved, as a list of sentences. */
export function qaProblems(qa) {
  const problems = [];
  if (!Array.isArray(qa) || qa.length === 0) return ['Keep at least one question and answer.'];
  if (qa.length > LIMITS.MAX_QA) problems.push(`Keep at most ${LIMITS.MAX_QA} questions.`);
  qa.forEach((item, i) => {
    const n = i + 1;
    if (!String(item.q || '').trim()) problems.push(`Question ${n} is empty.`);
    if (!String(item.a || '').trim()) problems.push(`Answer ${n} is empty.`);
    if (String(item.q || '').trim().length > LIMITS.MAX_SHORT) {
      problems.push(`Question ${n} is longer than ${LIMITS.MAX_SHORT} characters.`);
    }
    if (String(item.a || '').trim().length > LIMITS.MAX_ANSWER) {
      problems.push(`Answer ${n} is longer than ${LIMITS.MAX_ANSWER} characters.`);
    }
    if (String(item.pullQuote || '').trim().length > LIMITS.MAX_SHORT) {
      problems.push(
        `The pull quote of question ${n} is longer than ${LIMITS.MAX_SHORT} characters.`
      );
    }
  });
  return problems;
}

/** The list as the update route takes it: trimmed, the flag kept only where set. */
export function qaForSave(qa) {
  return qa.map((item) => ({
    q: String(item.q || '').trim(),
    a: String(item.a || '').trim(),
    pullQuote: String(item.pullQuote || '').trim(),
    ...(item.needsReview === true ? { needsReview: true } : {}),
  }));
}

/**
 * The status moves the page offers for a content status, each with the role
 * the server asks for. Publishing needs `approved`, the pipeline's rule
 * (functions/src/lib/cms/content-status.js).
 */
export function statusActions(status, { live = false, hasQa: qaPresent = false } = {}) {
  if (live || status === 'published') {
    return [{ id: 'unpublish', label: 'Unpublish', minRole: 'publisher' }];
  }
  if (!qaPresent) return [];
  if (status === 'approved') return [{ id: 'publish', label: 'Publish', minRole: 'publisher' }];
  if (status === 'in_review') {
    return [{ id: 'approve', label: 'Approve', minRole: 'editor', to: 'approved' }];
  }
  if (['draft', 'inspected', 'ingested', 'needs_rework', 'rejected'].includes(status)) {
    return [{ id: 'review', label: 'Send to review', minRole: 'editor', to: 'in_review' }];
  }
  return [];
}
