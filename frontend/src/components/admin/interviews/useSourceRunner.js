/**
 * useSourceRunner — send an interview's source to the server once the
 * interview exists (ADR 0040, D7): a pasted transcript, an audio link the
 * server fetches, or a recording uploaded in blocks and then queued for
 * transcription.
 *
 *   transcript  POST cms/interviews/{id}/transcript     { text }
 *               (a retry reads GET cms/interviews/{id} first: each store
 *               is a new version, so a send whose answer was lost is not
 *               sent again)
 *   url         POST cms/interviews/{id}/audio-from-url { url }
 *   file        lib/interviewUpload.js, then POST cms/interviews/{id}/transcribe
 *
 * A failed upload keeps its session: pressing the same button again sends
 * only the blocks the server has not acknowledged (`createAudioUpload`). The
 * form never writes a transcript or a Q&A itself; the jobs do.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getJSON, postJSON } from '@/lib/api';
import { createAudioUpload } from '@/lib/interviewUpload';

/**
 * Store a pasted transcript, at most once per interview: a retry first reads
 * the interview, and an earlier send that landed (its answer lost) is taken
 * as done, because each store makes a new transcript version.
 */
async function sendTranscriptOnce(interviewId, text, sent) {
  const base = `cms/interviews/${encodeURIComponent(interviewId)}`;
  if (sent.has(interviewId)) {
    const answer = await getJSON(base);
    if (answer?.interview?.transcription?.status === 'provided') return;
  }
  sent.add(interviewId);
  await postJSON(`${base}/transcript`, { text });
}

/**
 * Queue the server's download of an audio link. A 409 is "a download for
 * this interview is already running": an earlier send landed and only its
 * answer was lost, which is what was wanted. A deleted interview is not.
 */
async function queueDownload(path, url) {
  try {
    await postJSON(path, { url: String(url).trim() });
  } catch (error) {
    if (error?.status !== 409 || error?.code === 'INTERVIEW_DELETED') throw error;
  }
}

export function useSourceRunner() {
  const [progress, setProgress] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [canResume, setCanResume] = useState(false);
  const upload = useRef(null);
  const controller = useRef(null);
  // Interviews whose transcript was sent but not answered: the text may be
  // stored already, and storing it again makes a second version.
  const transcriptSent = useRef(new Set());

  /**
   * @param {string} interviewId
   * @param {{ source: 'transcript'|'url'|'file', transcript?: string, url?: string, file?: File, durationSec?: number }} input
   * @returns {Promise<boolean>} true once the server has the source
   */
  const run = useCallback(async (interviewId, input) => {
    const route = (step) => `cms/interviews/${encodeURIComponent(interviewId)}/${step}`;
    setRunning(true);
    setError(null);
    setCanResume(false);
    controller.current = new AbortController();
    try {
      if (input.source === 'transcript') {
        await sendTranscriptOnce(interviewId, input.transcript, transcriptSent.current);
      } else if (input.source === 'url') {
        await queueDownload(route('audio-from-url'), input.url);
      } else {
        const same =
          upload.current &&
          upload.current.interviewId === interviewId &&
          upload.current.file === input.file;
        if (!same) {
          upload.current = {
            interviewId,
            file: input.file,
            job: createAudioUpload({
              interviewId,
              file: input.file,
              durationSec: input.durationSec,
              onProgress: setProgress,
            }),
          };
        }
        await upload.current.job.run({ signal: controller.current.signal });
        try {
          await postJSON(route('transcribe'), {});
        } catch (queueError) {
          // Already queued (a second tap, or the page's own step): fine.
          if (queueError?.status !== 409) throw queueError;
        }
      }
      return true;
    } catch (failure) {
      const code = failure?.code || null;
      setError({ message: failure?.message || 'The interview’s source could not be sent.', code });
      // A failed upload whose session is still open carries on from the
      // blocks the server acknowledged; a deleted interview never does.
      const job = input.source === 'file' ? upload.current?.job : null;
      setCanResume(
        Boolean(job?.state.session && !job.state.completed && code !== 'INTERVIEW_DELETED')
      );
      return false;
    } finally {
      controller.current = null;
      setRunning(false);
    }
  }, []);

  const stop = useCallback(() => controller.current?.abort(), []);
  // Once the blocks are sent the server commits and checks them in one
  // request, which a Stop cannot call back; from then on there is no Stop.
  const finishing = running && ['completing', 'done'].includes(progress?.phase);
  const canStop = running && !finishing;

  // Leaving the page stops a running upload, as closing the tab does (the
  // runbook says so), except once the server is committing it.
  const finishingNow = useRef(false);
  useEffect(() => {
    finishingNow.current = finishing;
  }, [finishing]);
  useEffect(
    () => () => {
      if (!finishingNow.current) controller.current?.abort();
    },
    []
  );

  return { run, stop, progress, running, error, canResume, canStop, finishing };
}
