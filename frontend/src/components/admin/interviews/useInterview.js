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
import { getJSON, postJSON, sendJSON } from '@/lib/api';
import { isInFlight, nextStep, stageOf } from './interviewModel';

/** How often the page reads the interview again while a job works on it. */
export const POLL_MS = 5000;

/**
 * @param {string} id - the interview's content id
 * @param {{ authReady: boolean, toast: Function, pollMs?: number }} deps
 */
export function useInterview(id, { authReady, toast, pollMs = POLL_MS }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const [advancing, setAdvancing] = useState(false);
  // One more on every finished read, success or failure, so the next check
  // is scheduled after each read even when the answer is unchanged or the
  // read failed (a network blip must not stop the progress view).
  const [reads, setReads] = useState(0);
  const started = useRef(new Set());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!id) {
      setLoadError('No interview has that address.');
      setLoading(false);
      return null;
    }
    try {
      const answer = await getJSON(`cms/interviews/${encodeURIComponent(id)}`);
      if (!alive.current) return null;
      setData(answer);
      setLoadError('');
      return answer;
    } catch (error) {
      if (alive.current) setLoadError(error?.message || 'The interview could not be read.');
      return null;
    } finally {
      if (alive.current) {
        setLoading(false);
        setReads((count) => count + 1);
      }
    }
  }, [id]);

  useEffect(() => {
    if (!authReady) return;
    // Started from an async function, as useDocVault does: the read's own
    // setState calls come after the request, not in the effect's body.
    (async () => {
      await load();
    })();
  }, [authReady, load]);

  const doc = data?.interview || null;

  // Read again every few seconds while a job is working, or while a step the
  // page started has not shown up on the document yet.
  useEffect(() => {
    if (!doc || !(isInFlight(doc) || advancing)) return undefined;
    const timer = setTimeout(load, pollMs);
    return () => clearTimeout(timer);
  }, [doc, advancing, reads, load, pollMs]);

  /** Queue a job; a 409 means one is already running, which is what was wanted. */
  const queueStep = useCallback(
    async (step) => {
      setAdvancing(true);
      try {
        await postJSON(`cms/interviews/${encodeURIComponent(id)}/${step}`, {});
        return null;
      } catch (error) {
        if (error?.status === 409) return null;
        return error instanceof Error ? error : new Error(`The ${step} step could not start.`);
      } finally {
        await load();
        if (alive.current) setAdvancing(false);
      }
    },
    [id, load]
  );

  useEffect(() => {
    const step = nextStep(doc);
    if (!step) return;
    const key = `${step}:${stageOf(doc)}:${doc?.transcription?.version ?? 0}`;
    if (started.current.has(key)) return;
    started.current.add(key);
    queueStep(step).then((error) => {
      if (error && alive.current)
        setActionError(error.message || `The ${step} step could not start.`);
    });
  }, [doc, queueStep]);

  /** Run one owner action with the busy flag, the error line and a reload. */
  const act = useCallback(
    async (name, run, success) => {
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
    },
    [load, toast]
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

  const publish = () =>
    act('publish', async () => {
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
    });

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
