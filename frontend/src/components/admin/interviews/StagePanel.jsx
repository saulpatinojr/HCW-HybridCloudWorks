/**
 * Where an interview is in its making (ADR 0040, D7): the stage in words,
 * the window or drafting pass being worked on, the reason a stage stopped,
 * an upload's progress, and the two buttons that run a step again.
 */
import React from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { STAGE_LABELS, isInFlight, stageDetail, stageOf } from './interviewModel';

const PHASE_WORDS = {
  hashing: 'Checking the file',
  uploading: 'Uploading',
  completing: 'Finishing the upload',
  done: 'Upload complete',
};

/** `Uploading 37%`, from the upload helper's progress. */
export function UploadProgress({ progress }) {
  if (!progress) return null;
  const percent = progress.total > 0 ? Math.floor((progress.done / progress.total) * 100) : 0;
  const label = `${PHASE_WORDS[progress.phase] || 'Uploading'} ${percent}%`;
  return (
    <div className="space-y-1">
      <p role="status" className="text-sm">
        {label}
      </p>
      <div
        role="progressbar"
        aria-label={PHASE_WORDS[progress.phase] || 'Uploading'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 w-full overflow-hidden rounded bg-muted"
      >
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** What the panel shows, read once from the document. */
function panelState(doc) {
  const transcription = doc?.transcription || {};
  return {
    stage: stageOf(doc),
    working: isInFlight(doc),
    detail: stageDetail(doc),
    error: doc?.interview?.error,
    hasAudio: Boolean(doc?.provenance?.audio?.path),
    hasTranscript:
      Number.isInteger(transcription.version) &&
      ['done', 'provided'].includes(transcription.status),
    hasQa: Array.isArray(doc?.qa) && doc.qa.length > 0,
  };
}

/**
 * @param {object} props
 * @param {object} props.doc - the interview document
 * @param {string} props.busy - the action running, if any
 * @param {boolean} [props.blocked] - unsaved edits on the page: a new
 *   transcript or draft would replace what the editor holds, so both wait
 * @param {() => void} props.onTranscribe
 * @param {() => void} props.onDraft
 */
export default function StagePanel({ doc, busy, blocked = false, onTranscribe, onDraft }) {
  const { stage, working, detail, error, hasAudio, hasTranscript, hasQa } = panelState(doc);
  const locked = working || Boolean(busy) || blocked;
  return (
    <section aria-labelledby="interview-stage" className="space-y-3 rounded-md border p-4">
      <h2 id="interview-stage" className="text-base font-semibold">
        Progress
      </h2>
      <p role="status" className="flex items-center gap-2 text-sm font-medium">
        {working && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        <span data-testid="interview-stage">{STAGE_LABELS[stage] || stage}</span>
      </p>
      {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
      {stage === 'failed' && error && (
        <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100">
          {error}
        </p>
      )}
      {working && (
        <p className="text-xs text-muted-foreground">
          This page checks again every few seconds. You can leave it and come back.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {hasAudio && (
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={onTranscribe}
            className="gap-1"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Transcribe again
          </Button>
        )}
        {hasTranscript && (
          <Button size="sm" variant="outline" disabled={locked} onClick={onDraft} className="gap-1">
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Draft again
          </Button>
        )}
      </div>
      {blocked && (hasAudio || hasTranscript) && (
        <p className="text-xs text-muted-foreground">
          A step can run again once your changes are saved or undone, as it replaces them.
        </p>
      )}
      {hasTranscript && hasQa && (
        <p className="text-xs text-muted-foreground">
          Draft again replaces the questions and answers below with a new draft.
        </p>
      )}
    </section>
  );
}
