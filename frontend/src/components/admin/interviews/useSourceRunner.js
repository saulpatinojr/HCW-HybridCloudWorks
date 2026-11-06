/**
 * useSourceRunner — send an interview's source to the server once the
 * interview exists (ADR 0040, D7): a pasted transcript, an audio link the
 * server fetches, or a recording uploaded in blocks and then queued for
 * transcription.
 *
 *   transcript  POST cms/interviews/{id}/transcript     { text }
 *   url         POST cms/interviews/{id}/audio-from-url { url }
 *   file        lib/interviewUpload.js, then POST cms/interviews/{id}/transcribe
 *
 * A failed upload keeps its session: pressing the same button again sends
 * only the blocks the server has not acknowledged (`createAudioUpload`). The
 * form never writes a transcript or a Q&A itself; the jobs do.
 */
import { useCallback, useRef, useState } from 'react';
import { postJSON } from '@/lib/api';
import { createAudioUpload } from '@/lib/interviewUpload';

export function useSourceRunner() {
  const [progress, setProgress] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [canResume, setCanResume] = useState(false);
  const upload = useRef(null);
  const controller = useRef(null);

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
        await postJSON(route('transcript'), { text: input.transcript });
      } else if (input.source === 'url') {
        await postJSON(route('audio-from-url'), { url: String(input.url).trim() });
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

  return { run, stop, progress, running, error, canResume };
}
