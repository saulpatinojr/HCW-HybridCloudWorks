import React from 'react';
import { Check, XCircle } from 'lucide-react';
import { contentStatusInfo } from '@/lib/status';

/**
 * PipelineStepper — where one item is in the pipeline, as the dashboard's
 * Pipeline card draws it (ADR 0033 §1, §7): New Content → Drafts → Review →
 * Editor → Publish → Live. The stage comes from `contentStatusInfo().stage`
 * (lib/status.js), the one status vocabulary, so this and the dashboard
 * cannot disagree about which stage a status belongs to.
 *
 * Pass the content item (preferred, so `Live` is considered) or a raw
 * contentStatus string. Compact enough to mount on a list row.
 */

export const PIPELINE_STAGES = Object.freeze([
  { id: 'new', label: 'New Content' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'review', label: 'Review' },
  { id: 'editor', label: 'Editor' },
  { id: 'publish', label: 'Publish' },
  { id: 'live', label: 'Live' },
]);

const STAGE_INDEX = Object.fromEntries(PIPELINE_STAGES.map((stage, index) => [stage.id, index]));

/**
 * The current stage index (0-5) of an item or status string. A rejected or
 * archived item has left the pipeline (`stage: 'off'`); it is placed at the
 * review stage with nothing done, and the caller shows the marker.
 */
export function getPipelineStageIndex(itemOrStatus) {
  const info = contentStatusInfo(itemOrStatus);
  if (info.stage === 'off') return STAGE_INDEX.review;
  return STAGE_INDEX[info.stage] ?? STAGE_INDEX.review;
}

export function isPipelineRejected(itemOrStatus) {
  return contentStatusInfo(itemOrStatus).id === 'rejected';
}

export function isPipelineArchived(itemOrStatus) {
  return contentStatusInfo(itemOrStatus).id === 'archived';
}

export default function PipelineStepper({ item, status, className = '' }) {
  const subject = item || status || '';
  const rejected = isPipelineRejected(subject);
  const archived = isPipelineArchived(subject);
  const off = rejected || archived;
  const currentIndex = getPipelineStageIndex(subject);

  return (
    <div
      className={`flex items-center gap-1 flex-wrap ${className}`}
      role="list"
      aria-label="Publishing pipeline progress"
    >
      {PIPELINE_STAGES.map((stage, i) => {
        const isDone = !off && i < currentIndex;
        const isCurrent = !off && i === currentIndex;
        let chipClass = 'border-border text-muted-foreground/70';
        if (isCurrent) chipClass = 'border-primary bg-primary/10 text-primary';
        else if (isDone)
          chipClass =
            'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400';
        return (
          <React.Fragment key={stage.id}>
            {i > 0 && <span className="h-px w-3 bg-border shrink-0" aria-hidden="true" />}
            <span
              role="listitem"
              aria-current={isCurrent ? 'step' : undefined}
              data-stage={stage.id}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide transition-colors ${chipClass}`}
            >
              {isDone && <Check className="h-2.5 w-2.5" aria-hidden="true" />}
              {stage.label}
            </span>
          </React.Fragment>
        );
      })}
      {off && (
        <span
          role="listitem"
          aria-current="step"
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${
            rejected
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-border bg-muted text-muted-foreground'
          }`}
        >
          <XCircle className="h-2.5 w-2.5" aria-hidden="true" />{' '}
          {rejected ? 'Rejected' : 'Archived'}
        </span>
      )}
    </div>
  );
}
