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

// The shared limits and the form rules live in their own files; they are
// exported from here too, where the pages import them.
import { LIMITS } from './interviewLimits';

export { LIMITS };
export {
  todayUtc,
  defaultConsentDate,
  parseTags,
  emptyForm,
  isRealDate,
  detailsProblems,
  formProblems,
  sourceProblem,
  audioProblemFor,
  createBody,
  formFromDoc,
  detailsUpdates,
} from './interviewForm';

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
  // A recording marked deleted (`deletedAt`, written before the delete
  // finishes) still has its path for a moment; it is never transcribed.
  const usableAudio = Boolean(audio?.path) && !audio?.deletedAt;
  if (!hasTranscript && usableAudio && (stage === 'fetched' || stage === 'created')) {
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
