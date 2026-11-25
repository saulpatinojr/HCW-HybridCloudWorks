/**
 * useInterview — one interview on its admin page: read it, check again every
 * few seconds while a job works on it, start the next step where it is safe,
 * and the owner's actions (ADR 0040, D5 and D7; issue #1565).
 *
 * The routes it calls, all on the Function App:
 *
 *   GET    cms/interviews/{id}               the document, its transcript and the consent wording
 *   POST   cms/interviews/{id}/transcribe    queue a transcription (the next version)
 *   POST   cms/interviews/{id}/draft         queue a draft from the current transcript
 *   POST   updateContentItem                 save the details or the Q&A
 *   POST   transitionContentStatus           Send to review, Approve
 *   POST   publishContent                    Publish (publisher)
 *   POST   unpublishContentToInspected       Unpublish (publisher)
 *   DELETE cms/interviews/{id}/audio         Delete the recording (publisher)
 *
 * Why the page starts steps: a job does not start the next job (the jobs
 * slice explains why), so the page moves a new interview along. It starts
 * only the steps `nextStep` names, and each at most once per stage and
 * transcript version, so a reload or a slow poll never queues two.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { postJSON, sendJSON } from '@/lib/api';
import { isInFlight, nextStep, stageOf } from './interviewModel';
import {
  loadInterview,
  pollAfter,
  postInterviewStep,
  publishInterview,
  stepKey,
} from './interviewRequests';

/** How often the page reads the interview again while a job works on it. */
export const POLL_MS = 5000;

/**
 * @param {string} id - the interview's content id
 * @param {{ authReady: boolean, toast: Function, pollMs?: number }} deps
 */
/** What the page shows from a read: only a read made for the id it is on. */
function readFor(read, id) {
  const mine = read.id === id;
  return {
    data: mine ? read.data : null,
    loadError: mine ? read.error : '',
    loading: !mine || !read.done,
  };
}

/** A ref that is true while the component is mounted. */
function useAliveRef() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/**
 * Start the step `nextStep` names, at most once per stage and transcript
 * version, and say on the page when it could not start.
 */
function startNextStep({ id, doc, started, queueStep, alive, setActionError }) {
  const step = nextStep(doc);
  const key = step && stepKey(id, step, stageOf(doc), doc);
  if (!step || started.current.has(key)) return;
  started.current.add(key);
  queueStep(step).then((error) => {
    if (error && alive.current)
      setActionError(error.message || `The ${step} step could not start.`);
  });
}

/** Run one owner action with the busy flag, the error line and a reload. */
async function runOwnerAction({ setBusy, setActionError, toast, load, alive }, name, run, success) {
  setBusy(name);
  setActionError('');
  try {
    const result = await run();
    if (success) toast?.({ title: success });
    return result ?? true;
  } catch (error) {
    setActionError(error?.message || 'That did not work. Try again.');
    return false;
  } finally {
    await load();
    if (alive.current) setBusy('');
  }
}

export function useInterview(id, { authReady, toast, pollMs = POLL_MS }) {
  // Each read is stored with the id it was made for, and shown only while the
  // page is on that id: the router reuses this page when only the id
  // changes, and a slow answer for the last interview must not appear, or be
  // acted on, under the next one's address.
  const [read, setRead] = useState({ id: undefined, data: null, error: '', done: false });
  const { data, loadError, loading } = readFor(read, id);
  const [actionError, setActionError] = useState('');
  const [errorFor, setErrorFor] = useState(id);
  if (errorFor !== id) {
    setErrorFor(id);
    setActionError('');
  }
  const [busy, setBusy] = useState('');
  const [advancing, setAdvancing] = useState(false);
  // One more on every finished read, success or failure, so the next check
  // is scheduled after each read even when the answer is unchanged or the
  // read failed (a network blip must not stop the progress view).
  const [reads, setReads] = useState(0);
  const started = useRef(new Set());
  const alive = useAliveRef();

  // The id the page is on now, for answers that arrive after it moved on.
  const currentId = useRef(id);
  useEffect(() => {
    currentId.current = id;
  }, [id]);

  const load = useCallback(
    () => loadInterview({ id, alive, currentId, setRead, setReads }),
    [id, alive]
  );

  useEffect(() => {
    if (!authReady) return;
    // Started from an async function, as the other admin lists do: the read's own
    // setState calls come after the request, not in the effect's body.
    (async () => {
      await load();
    })();
  }, [authReady, load]);

  const doc = data?.interview || null;

  // Read again every few seconds while a job is working, or while a step the
  // page started has not shown up on the document yet.
  useEffect(
    () => pollAfter(Boolean(doc) && (isInFlight(doc) || advancing), load, pollMs),
    // `reads` schedules the next check after every finished read.
    [doc, advancing, reads, load, pollMs]
  );

  /** Queue a job; a 409 means one is already running, which is what was wanted. */
  const queueStep = useCallback(
    async (step) => {
      setAdvancing(true);
      try {
        return await postInterviewStep(id, step);
      } finally {
        await load();
        if (alive.current) setAdvancing(false);
      }
    },
    [id, load, alive]
  );

  useEffect(() => {
    startNextStep({ id, doc, started, queueStep, alive, setActionError });
  }, [id, doc, queueStep, alive]);

  /** Run one owner action with the busy flag, the error line and a reload. */
  const act = useCallback(
    (name, run, success) =>
      runOwnerAction({ setBusy, setActionError, toast, load, alive }, name, run, success),
    [load, toast, alive]
  );

  const contentId = id;

  const saveUpdates = (updates, success = 'Saved') =>
    act('save', () => postJSON('updateContentItem', { contentId, updates }), success);

  const transition = (newStatus, label) =>
    act(
      newStatus,
      () =>
        postJSON('transitionContentStatus', {
          contentId,
          newStatus,
          reviewNotes: '',
          publishTarget: 'interview',
        }),
      label
    );

  const publish = () => act('publish', () => publishInterview(contentId, toast));

  const unpublish = () =>
    act(
      'unpublish',
      () =>
        postJSON('unpublishContentToInspected', {
          contentId,
          currentStatus: doc?.contentStatus || 'published',
          reviewNotes: 'Unpublished from the Interviews page',
        }),
      'Unpublished. The page leaves the site within five minutes.'
    );

  const deleteAudio = () =>
    act(
      'delete-audio',
      () => sendJSON(`cms/interviews/${encodeURIComponent(contentId)}/audio`, 'DELETE'),
      'Recording deleted. The transcript is kept.'
    );

  const rerun = (step) =>
    act(step, async () => {
      const error = await queueStep(step);
      if (error) throw error;
      return true;
    });

  return {
    data,
    doc,
    loading,
    loadError,
    actionError,
    clearActionError: () => setActionError(''),
    busy,
    advancing,
    reload: load,
    saveUpdates,
    transition,
    publish,
    unpublish,
    deleteAudio,
    transcribeAgain: () => rerun('transcribe'),
    draftAgain: () => rerun('draft'),
  };
}
