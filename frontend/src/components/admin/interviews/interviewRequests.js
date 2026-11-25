/**
 * The requests behind useInterview, kept out of the hook so each reads on its
 * own. `ctx` is the hook's `{ id, alive, currentId, setRead, setReads }`:
 * the interview's id, refs saying the page is still mounted and still on that
 * id, and the setters a read writes to.
 */
import { getJSON, postJSON } from '@/lib/api';

/** Whether the page is still mounted and still showing interview `id`. */
const stillOn = ({ alive, currentId, id }) => alive.current && currentId.current === id;

/** Read the interview; resolves to the answer, or null when it failed or the page moved on. */
export async function loadInterview(ctx) {
  const { id, setRead, setReads } = ctx;
  if (!id) {
    setRead({ id, data: null, error: 'No interview has that address.', done: true });
    return null;
  }
  try {
    const answer = await getJSON(`cms/interviews/${encodeURIComponent(id)}`);
    if (!stillOn(ctx)) return null;
    setRead({ id, data: answer, error: '', done: true });
    return answer;
  } catch (error) {
    // A failed re-read keeps the document already shown for this id.
    if (stillOn(ctx)) {
      setRead((last) => ({
        id,
        data: last.id === id ? last.data : null,
        error: error?.message || 'The interview could not be read.',
        done: true,
      }));
    }
    return null;
  } finally {
    if (stillOn(ctx)) setReads((count) => count + 1);
  }
}

/**
 * Queue a job; resolves to null when it started (or was already running,
 * which is what was wanted), or to the error otherwise.
 */
export async function postInterviewStep(id, step) {
  try {
    await postJSON(`cms/interviews/${encodeURIComponent(id)}/${step}`, {});
    return null;
  } catch (error) {
    // Already running is what was wanted; an interview being deleted is not.
    if (error?.status === 409 && error?.code !== 'INTERVIEW_DELETED') return null;
    return error instanceof Error ? error : new Error(`The ${step} step could not start.`);
  }
}

/** Publish the interview; throws the server's refusal, toasts where it went live. */
export async function publishInterview(contentId, toast) {
  const result = await postJSON('publishContent', {
    contentIds: [contentId],
    publishTarget: 'interview',
    cloudProvider: 'Azure',
    markLive: true,
    createSlugPageTrigger: true,
    addToCurated: true,
  });
  const refused = (result?.errors || []).find((entry) => entry.contentId === contentId);
  if (refused) {
    throw Object.assign(new Error(refused.error || 'The interview was not published.'), {
      code: refused.code,
    });
  }
  const mapping = (result?.mappings || []).find((entry) => entry.contentId === contentId);
  toast?.({
    title: 'Published',
    description: mapping?.curatedSubpagePath
      ? `Live at ${mapping.curatedSubpagePath} within five minutes.`
      : 'The interview page is live within five minutes.',
  });
  return result;
}

/** Read again after `pollMs` while `active`. Returns the effect cleanup. */
export function pollAfter(active, load, pollMs) {
  if (!active) return undefined;
  const timer = setTimeout(load, pollMs);
  return () => clearTimeout(timer);
}

/** The key that says a step was started for this stage and transcript version. */
export function stepKey(id, step, stage, doc) {
  return `${id}:${step}:${stage}:${doc?.transcription?.version ?? 0}`;
}
