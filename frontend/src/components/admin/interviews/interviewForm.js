/**
 * The new-interview form and the details editor: their defaults, their
 * checks, and the bodies they send. Split out of interviewModel.js.
 */
import { LIMITS, TAG } from './interviewLimits';

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
  const check = Object.hasOwn(SOURCE_CHECKS, form.source) ? SOURCE_CHECKS[form.source] : null;
  return check ? check(form, audioProblem) : 'Choose where the interview comes from.';
}

function transcriptProblem(form) {
  const text = String(form.transcript || '');
  if (!text.trim()) return 'Paste the transcript.';
  if (text.length > LIMITS.MAX_TRANSCRIPT) {
    return 'The transcript is longer than 400,000 characters. Split the interview.';
  }
  return '';
}

function recordingUrlProblem(form) {
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

// The check for each place an interview can come from.
const SOURCE_CHECKS = {
  transcript: transcriptProblem,
  url: recordingUrlProblem,
  file: (form, audioProblem) => audioProblem || '',
};

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
