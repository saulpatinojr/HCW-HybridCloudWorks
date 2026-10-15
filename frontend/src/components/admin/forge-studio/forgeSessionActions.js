/**
 * The operations a Forge Studio session offers (ADR 0033 §7 slice 2), each
 * sequencing the server calls in forgeJobs.js and dispatching the
 * transitions in forgeSessionReducer.js. Every one takes the same `ctx`:
 *
 *   ctx.get()          the session as it stands
 *   ctx.dispatch(a)    one transition
 *   ctx.onContentId(id) mirror the document id to the URL
 *
 * Every write that fails is said on the page; nothing here retries a save.
 */
import {
  FORGE_JOB_MAX_WAIT_MS,
  assistOn,
  createDraftDocument,
  isConflict,
  jobFailure,
  readDocument,
  saveBriefOn,
  saveText,
  sendDraftToReview,
  writeFirstDraft,
} from './forgeJobs';

/**
 * Run `task` as the `busy` operation: the messages clear as it begins, an
 * error lands on the page (with whatever `describeFailure` adds), and busy
 * clears after. Resolves to the task's value, or null when it threw.
 */
async function attempt(ctx, begin, fallback, task, describeFailure = () => ({})) {
  ctx.dispatch({ type: 'begin', ...begin });
  try {
    return await task();
  } catch (err) {
    ctx.dispatch({ type: 'failed', error: err?.message || fallback, ...describeFailure(err) });
    return null;
  } finally {
    ctx.dispatch({ type: 'end' });
  }
}

function showDoc(ctx, doc) {
  ctx.dispatch({ type: 'showDoc', doc });
  const id = doc?.id || '';
  if (id) ctx.onContentId(id);
}

/** GET the document as it now stands; the one on the session when no id is given. */
export async function loadDoc(ctx, contentId) {
  const id = String(contentId || ctx.get().contentId || '').trim();
  if (!id) return null;
  ctx.dispatch({ type: 'loadStart' });
  try {
    const doc = await readDocument(id);
    showDoc(ctx, doc);
    return doc;
  } catch (err) {
    ctx.dispatch({ type: 'failed', error: err?.message || 'The document could not be read.' });
    return null;
  } finally {
    ctx.dispatch({ type: 'loadEnd' });
  }
}

/** Start a mode: a fresh brief seeded for it, title kept if given. */
export function start(ctx, mode, extras = {}) {
  const { title = '', ...briefExtras } = extras;
  ctx.dispatch({ type: 'start', mode, title, briefExtras });
  ctx.onContentId('');
}

export function reset(ctx) {
  ctx.dispatch({ type: 'reset' });
  ctx.onContentId('');
}

/** Save the brief as a draft and stop there (no AI). */
export function saveAsDraft(ctx, options) {
  return attempt(ctx, { busy: 'create' }, 'The draft could not be saved.', async () => {
    const { contentId, brief, title } = ctx.get();
    const id = contentId || (await createDraftDocument({ title, brief, ...options }));
    if (contentId) await saveBriefOn(id, brief);
    await loadDoc(ctx, id);
    ctx.dispatch({ type: 'notice', notice: 'Saved as a draft. It is on the Drafts page.' });
    return id;
  });
}

/** Write the first draft; the job, or null when it failed (the error is on the page). */
export function generate(ctx, options = {}) {
  const jobOptions = {
    onUpdate: (job) => ctx.dispatch({ type: 'job', job }),
    maxWaitMs: FORGE_JOB_MAX_WAIT_MS,
  };
  return attempt(
    ctx,
    { busy: 'generate', job: { status: 'queued' } },
    'The forge job failed.',
    async () => {
      const { id, job } = await writeFirstDraft(ctx.get(), options, jobOptions);
      ctx.dispatch({ type: 'job', job });
      if (id) await loadDoc(ctx, id);
      const failure = jobFailure(job);
      if (failure) throw failure;
      ctx.dispatch({ type: 'notice', notice: 'The draft is written and graded. Review it below.' });
      return job;
    },
    (err) => (err?.job ? { job: err.job } : {})
  );
}

/** One AI action over the given text, recorded on the document. */
export function assist(ctx, action, { text, instruction = '', tone = '' }) {
  const { contentId } = ctx.get();
  if (!contentId) {
    ctx.dispatch({
      type: 'failed',
      error: 'Create the draft first; every AI action is recorded on it.',
    });
    return Promise.resolve(null);
  }
  return attempt(ctx, { busy: 'assist', keepNotice: true }, 'The action failed.', async () => {
    const res = await assistOn(contentId, action, { text, instruction, tone });
    const result = {
      action,
      label: res.label,
      result: res.result,
      provider: res.provider,
      model: res.model,
    };
    ctx.dispatch({ type: 'assisted', result, activity: res.activity });
    return result;
  });
}

/** Save the edited title, summary and body under the ETag; true when it took. */
export async function save(ctx) {
  const { doc, contentId, text } = ctx.get();
  if (!doc) return false;
  const res = await attempt(
    ctx,
    { busy: 'save' },
    'The draft was not saved.',
    async () => {
      const answer = await saveText(contentId, doc, text);
      ctx.dispatch({ type: 'saved', etag: answer.etag, activity: answer.activity });
      return answer;
    },
    (err) => (isConflict(err) ? { conflict: true } : {})
  );
  return Boolean(res);
}

/** Drafts stage → In Review. Only a `drafting` document can take this edge. */
export function sendToReview(ctx) {
  const { doc, contentId } = ctx.get();
  if (!doc) return Promise.resolve(null);
  return attempt(ctx, { busy: 'send' }, 'Send to review failed.', async () => {
    const res = await sendDraftToReview(contentId, doc._etag);
    await loadDoc(ctx, contentId);
    ctx.dispatch({
      type: 'notice',
      notice: 'Sent to In Review. It is on the Review Queue; nothing was published.',
    });
    return res;
  });
}
