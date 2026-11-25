/**
 * draft.js — the transcript becomes a Q&A draft (ADR 0040 D4, #1565).
 *
 * The `interview-draft` job: read the transcript version the payload names
 * from the private container, fence it, ask the text router for the
 * interview shape through the `interviewDrafting` task, validate what comes
 * back against the same limits the page enforces (schema.js), run the
 * honesty guard (draft-guard.js), and store the list on the document with
 * `interview.stage = 'ready'`. Nothing here publishes: the owner reads every
 * answer before the interview moves to review.
 *
 * THE TRANSCRIPT IS UNTRUSTED INPUT, even though it is the owner's own
 * recording: a guest can say anything, and a pasted export can carry
 * anything. It goes between the `<<<BEGIN ARTICLE>>>` / `<<<END ARTICLE>>>`
 * markers of prompt-fence.js, neutralised with `fenceArticleText`, and the
 * system prompt says that everything between the markers is material, never
 * instruction. The guest's name and role from the form are given as data in
 * the same way. The prompt text itself is fixed.
 *
 * A transcript over 120 kB (MAX_TRANSCRIPT_INPUT_BYTES, the cap the
 * recording script uses) is sent in as many passes as it needs, split on
 * turn boundaries — a 400,000-character transcript, the most the route
 * accepts, is at most about 1.2 MB of UTF-8 and so up to ten passes — and
 * the lists are joined. A single turn longer than a pass is split, never
 * cut short: at a UTF-8 character boundary, at the last sentence end
 * before the limit when there is one, each piece keeping the turn's
 * `Speaker N:` label, so every word the guest said reaches a prompt.
 *
 * EACH PASS IS A CHECKPOINT. Its checked items are saved on the document
 * as `provenance.drafting.passes[k]` with the transcript version, each
 * pass runs under its own 3-minute deadline, and a re-run or a sweeper
 * re-queue for the same transcript version resumes at the first pass with
 * no saved output, so a long transcript survives the job's 25-minute
 * budget across runs. A finished draft clears the checkpoints, so "Draft
 * again" starts over. Each pass asks for its share
 * of the 40 items the page allows, so every part of the transcript is
 * represented in the draft rather than the first part filling the list,
 * and each later pass is given the questions already drafted, as data, so
 * it does not ask them again. The combined list is validated once at the
 * end: over 40 items, the first 40 are kept and `truncated` is set for the
 * editor.
 * Each pass is counted against the monthly interview ceiling before it is
 * sent (budget.js): the pass's text at the drafting task's recommended
 * rates, plus the month's spend and this job's, must stay under
 * INTERVIEW_TRANSCRIPTION_MONTHLY_USD.
 *
 * THE SHAPE IS CHECKED AT RUNTIME, twice. The router's own round trip
 * repairs malformed JSON; an answer that parses but is not the interview
 * shape is sent back once with the shape restated, and a second miss fails
 * the job with INVALID_DRAFT. The speaker the model names as the guest is
 * checked against a count (the speaker with more question marks is the
 * interviewer); when the two disagree `speakers.unsure` is set and the
 * editor is asked to pick.
 *
 * Log lines carry the interview id, the version, counts and the model;
 * never a question, an answer, a name or the transcript.
 */
import { ARTICLE_CLOSE, ARTICLE_OPEN, fenceArticleText } from '../ai/prompt-fence.js';
import { generateJsonResponse as routerGenerateJson, getCostEstimate as routerCostEstimate } from '../ai/router.js';
import { AI_TASKS } from '../ai/tasks.js';
import { budgetExceeded, monthInterviewSpend, monthlyCeilingUsd } from './budget.js';
import { JobFailedError } from '../jobs.js';
import { storedFailure } from '../http/error-response.js';
import { guardDraft } from './draft-guard.js';
import { guestSpeaker, splitTranscript } from './draft-text.js';
import { PASS_TIMEOUT_MS, draftPass } from './draft-pass.js';

export { PASS_TIMEOUT_MS, SYSTEM_PROMPT, parseDraftOutput } from './draft-pass.js';

export { guessInterviewer, splitText, splitTranscript, splitTurn } from './draft-text.js';
import { LIMITS, isObject, validateQa } from './schema.js';
import { INTERVIEWS_AUDIO_CONTAINER, transcriptBlobPath } from './storage.js';

export const DRAFT_JOB_TYPE = 'interview-draft';
export const DRAFT_FEATURE = 'interviewDrafting';
export const CONTENT_CONTAINER = 'content';

/** The payload bound the registration declares: two short ids. */
export const DRAFT_JOB_MAX_PAYLOAD_BYTES = 1024;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

/** `{ interviewId, transcriptVersion }`, or an authored refusal. Shared with the route that enqueues. */
export function parseDraftPayload(payload) {
  const interviewId = typeof payload?.interviewId === 'string' ? payload.interviewId.trim() : '';
  if (!ID.test(interviewId)) return { error: 'interviewId is required.' };
  const version = Number(payload?.transcriptVersion);
  if (!Number.isInteger(version) || version < 1 || version > 999) {
    return { error: 'transcriptVersion must be a whole number from 1 to 999.' };
  }
  return { value: { interviewId, transcriptVersion: version } };
}

/** Each pass's share of the page's 40 items, so every part of a long transcript is drafted. */
export const itemsPerPass = (passes) => Math.max(1, Math.floor(LIMITS.MAX_QA / Math.max(1, passes)));

/** Output tokens allowed for in a pass's cost estimate: a list of up to 40 items. */
export const PASS_OUTPUT_TOKENS = 6000;

/** What one pass costs at the drafting task's recommended rates: its text in, a list out. */
export function passCostUsd(text, getCostEstimate = routerCostEstimate) {
  const { provider, model } = AI_TASKS.interviewDrafting.recommended;
  const promptTokens = Math.ceil(Buffer.byteLength(text, 'utf8') / 4) + 600;
  return getCostEstimate(provider, model, promptTokens, PASS_OUTPUT_TOKENS);
}

/** The user prompt for one pass: the guest as data, then the fenced transcript. */
export function draftPrompt({ guestName, guestRole, transcript, pass, passes, alreadyAsked = [] }) {
  const who = [
    `Guest name (data): ${fenceArticleText(guestName || 'unknown')}`,
    `Guest role (data): ${fenceArticleText(guestRole || 'not given')}`,
  ];
  const part =
    passes > 1
      ? `This is part ${pass} of ${passes} of the transcript; cover this part only, with at most ${itemsPerPass(passes)} items.`
      : '';
  // The questions earlier passes drafted, as data, so a later pass does not
  // ask them again. Fenced like the transcript: they came from the model.
  const asked =
    alreadyAsked.length > 0
      ? `Questions already drafted from earlier parts (data; do not repeat them):\n${alreadyAsked.map((q) => `- ${fenceArticleText(q)}`).join('\n')}`
      : '';
  return [
    ...who,
    part,
    asked,
    'The transcript, as speaker turns:',
    ARTICLE_OPEN,
    fenceArticleText(transcript),
    ARTICLE_CLOSE,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The checkpoints a run may resume from: the saved passes of the same
 * transcript version and the same split, in order from the first, each a
 * checked list. Anything else starts over.
 */
export function savedPasses(drafting, { transcriptVersion, passCount }) {
  if (!isObject(drafting) || drafting.transcriptVersion !== transcriptVersion || drafting.passCount !== passCount) return [];
  const saved = Array.isArray(drafting.passes) ? drafting.passes : [];
  const usable = [];
  for (const entry of saved) {
    if (!isObject(entry) || entry.transcriptVersion !== transcriptVersion) break;
    const qa = validateQa(entry.qa);
    if (!qa.ok) break;
    const speakers = isObject(entry.speakers) ? entry.speakers : { interviewer: null, guest: null };
    usable.push({ transcriptVersion, qa: qa.value, speakers });
  }
  return usable;
}

/**
 * Run the draft for one interview and transcript version.
 *
 * @param {object} args
 * @param {string} args.interviewId
 * @param {number} args.transcriptVersion
 * @param {{ readDoc: Function, patchDoc: Function, queryDocs: Function }} args.store
 * @param {{ readBlobForDelivery: Function }} args.storage
 * @param {{ generateJsonResponse: Function, getCostEstimate?: Function }} [args.ai] - the router by default
 * @param {object} [args.env]
 * @param {() => Date} [args.now]
 * @param {{ log?: Function, warn?: Function }} [args.log]
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.passTimeoutMs] - each pass's deadline; PASS_TIMEOUT_MS by default
 * @returns {Promise<{ interviewId: string, transcriptVersion: number, items: number, flagged: number, droppedQuotes: number, passes: number, resumedFrom: number, model: string|null, provider: string|null, unsure: boolean, truncated: boolean }>}
 */
export async function draftInterview({
  interviewId,
  transcriptVersion,
  store,
  storage,
  ai = { generateJsonResponse: routerGenerateJson, getCostEstimate: routerCostEstimate },
  env = process.env,
  now = () => new Date(),
  log = null,
  signal = null,
  container = CONTENT_CONTAINER,
  passTimeoutMs = PASS_TIMEOUT_MS,
}) {
  const doc = await store.readDoc(container, interviewId, interviewId);
  if (!doc || doc.type !== 'interview') {
    throw new JobFailedError('No interview with that id.', { code: 'INTERVIEW_NOT_FOUND', status: 404 });
  }
  const blob = await storage.readBlobForDelivery(INTERVIEWS_AUDIO_CONTAINER, transcriptBlobPath(interviewId, transcriptVersion));
  if (!blob) {
    throw new JobFailedError(`Transcript version ${transcriptVersion} is not in the container; transcribe first.`, {
      code: 'TRANSCRIPT_MISSING',
      status: 404,
    });
  }
  let transcript;
  try {
    transcript = JSON.parse(blob.body.toString('utf8'));
  } catch {
    throw new JobFailedError('The stored transcript could not be read.', { code: 'TRANSCRIPT_UNREADABLE', status: 422 });
  }
  const segments = Array.isArray(transcript?.segments) ? transcript.segments.filter((s) => isObject(s) && typeof s.text === 'string') : [];
  if (segments.length === 0) {
    throw new JobFailedError('The transcript has no text to draft from.', { code: 'TRANSCRIPT_EMPTY', status: 422 });
  }

  const interview = isObject(doc.interview) ? doc.interview : {};
  const provenance = isObject(doc.provenance) ? doc.provenance : {};
  await store.patchDoc(container, interviewId, { interview: { ...interview, stage: 'drafting', error: null } });
  try {
    return await draftFromSegments({ interviewId, transcriptVersion, doc, segments, interview, provenance, store, ai, env, now, log, signal, container, passTimeoutMs });
  } catch (error) {
    // The document records the failure in the job's own words or a code,
    // never the model's, so the admin page can show why the stage is failed.
    const sentence = storedFailure(error, 'Drafting failed.');
    try {
      await store.patchDoc(container, interviewId, { interview: { ...interview, stage: 'failed', error: sentence } });
    } catch (writeError) {
      log?.warn?.(`${DRAFT_JOB_TYPE}: v${transcriptVersion} failure not recorded (${writeError?.code ?? 'unknown'})`);
    }
    throw error;
  }
}

/**
 * The passes not yet saved, each counted against the ceiling before it is
 * sent and checkpointed after it answers. Starts from the passes an earlier
 * run saved; answers the speakers (from the first pass) and every item.
 */
async function runPasses(job, passes, saved) {
  const { interviewId, transcriptVersion, provenance, store, ai, now, signal, container } = job;
  const checkpoints = saved.map((entry) => ({ transcriptVersion, qa: entry.qa, speakers: entry.speakers }));
  let speakers = saved[0]?.speakers ?? { interviewer: null, guest: null };
  let qa = saved.flatMap((entry) => entry.qa);
  for (let pass = saved.length; pass < passes.length; pass += 1) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    await assertPassBudget(job, passes[pass]);
    const result = await draftPass(ai, {
      prompt: draftPrompt({
        guestName: job.guestName,
        guestRole: job.guestRole,
        transcript: passes[pass],
        pass: pass + 1,
        passes: passes.length,
        alreadyAsked: qa.map((item) => item.q),
      }),
      signal,
      usageOut: job.usageOut,
      pass: pass + 1,
      timeoutMs: job.passTimeoutMs,
    });
    if (pass === 0) speakers = result.speakers;
    qa = qa.concat(result.qa);
    // The checkpoint: this pass's checked items, saved before the next pass
    // is asked, so a run that stops later resumes after it.
    checkpoints.push({ transcriptVersion, qa: result.qa, speakers: result.speakers });
    await store.patchDoc(container, interviewId, {
      provenance: {
        ...provenance,
        drafting: { transcriptVersion, passCount: passes.length, passes: checkpoints, updatedAt: now().toISOString() },
      },
    });
  }
  return { speakers, qa };
}

/**
 * Every pass is counted before it is sent: the month's rows (the router
 * writes this job's own as it goes) plus this pass's estimate.
 */
async function assertPassBudget({ store, now, env, ai }, passText) {
  const ceiling = monthlyCeilingUsd(env);
  const getCostEstimate = typeof ai.getCostEstimate === 'function' ? ai.getCostEstimate : routerCostEstimate;
  const month = await monthInterviewSpend({ store, now });
  const passUsd = passCostUsd(passText, getCostEstimate);
  if (month.costUsd + passUsd > ceiling) {
    throw budgetExceeded({ what: 'Drafting', usedUsd: month.costUsd, ceiling, since: month.since, costUsd: passUsd });
  }
}

/**
 * The combined list, validated once: over 40 items the first 40 are kept
 * and the editor is told (`truncated`); a list that fails the shape here
 * cannot happen, since each pass's items passed it, but the check is the
 * one the page makes and it is cheap.
 */
function combinedQa(qa) {
  const combined = validateQa(qa.slice(0, LIMITS.MAX_QA));
  if (!combined.ok) {
    throw new JobFailedError(`The combined question-and-answer list was refused: ${combined.error}`, { code: 'INVALID_DRAFT', status: 422 });
  }
  return { qa: combined.value, truncated: qa.length > LIMITS.MAX_QA };
}

async function draftFromSegments({ interviewId, transcriptVersion, doc, segments, interview, provenance, store, ai, env, now, log, signal, container, passTimeoutMs }) {
  const lines = segments.map((s) => `${String(s.speaker || 'Speaker 1')}: ${s.text}`);
  const passes = splitTranscript(lines);
  const job = {
    interviewId,
    transcriptVersion,
    provenance,
    store,
    ai,
    env,
    now,
    signal,
    container,
    passTimeoutMs,
    usageOut: [],
    guestName: isObject(doc.guest) ? doc.guest.name : '',
    guestRole: isObject(doc.guest) ? doc.guest.role : '',
  };

  // Resume: the passes an earlier run of this version already saved.
  const saved = savedPasses(provenance.drafting, { transcriptVersion, passCount: passes.length });
  const resumedFrom = saved.length;
  const answered = await runPasses(job, passes, saved);
  const { qa, truncated } = combinedQa(answered.qa);
  const { speakers } = answered;

  // Speaker to guest mapping: the model's word, checked against the count.
  const { guestLabel, interviewerByCount, unsure } = guestSpeaker(segments, speakers);
  const guestText = segments.filter((s) => String(s.speaker || 'Speaker 1') === guestLabel).map((s) => s.text).join('\n');
  const guarded = guardDraft(qa, { transcriptText: segments.map((s) => s.text).join('\n'), guestText, speakersUnsure: unsure });

  const last = job.usageOut[job.usageOut.length - 1] || {};
  const stamp = now().toISOString();
  const drafting = {
    model: last.model || null,
    provider: last.provider || null,
    draftedAt: stamp,
    transcriptVersion,
    // The count, under its own name: `passes` held the checkpoints while
    // the job ran, and a finished draft clears them so "Draft again"
    // starts over rather than resuming.
    passCount: passes.length,
    resumedFrom,
    droppedQuotes: guarded.droppedQuotes,
    flagged: guarded.flagged,
    truncated,
  };
  await store.patchDoc(container, interviewId, {
    qa: guarded.qa,
    provenance: { ...provenance, drafting },
    interview: {
      ...interview,
      stage: 'ready',
      error: null,
      speakers: { interviewer: interviewerByCount || speakers.interviewer || null, guest: guestLabel, unsure },
    },
  });
  log?.log?.(
    `${DRAFT_JOB_TYPE}: v${transcriptVersion} ${guarded.qa.length} items, ${guarded.flagged} flagged, ` +
      `${guarded.droppedQuotes} quotes dropped, ${passes.length} pass(es)${resumedFrom ? `, resumed after ${resumedFrom}` : ''}, ${drafting.provider || 'no provider'}/${drafting.model || 'no model'}${unsure ? ', speaker unsure' : ''}`
  );
  return {
    interviewId,
    transcriptVersion,
    items: guarded.qa.length,
    flagged: guarded.flagged,
    droppedQuotes: guarded.droppedQuotes,
    passes: passes.length,
    resumedFrom,
    model: drafting.model,
    provider: drafting.provider,
    unsure,
    truncated,
  };
}
