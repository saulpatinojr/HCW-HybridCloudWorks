/**
 * "In the pipeline" for one record on a Page (#1886): the pieces that Page
 * started for the record, the stage each is at, and "Draft a piece" to start
 * another. A Page with nothing of its own to add to a piece (Speaking,
 * Certifications) uses this box as it is; Ambassador, which files a live piece
 * as evidence, builds its own around the same two parts.
 *
 * Render it outside any <form>: the button's dialog has a form of its own,
 * and React passes a submit up through the component tree, portal or not.
 */
import React from 'react';
import PipelinePieces, { usePipelinePieces } from './PipelinePieces';
import SendToPipelineButton from './SendToPipelineButton';

/**
 * @param {{
 *   originRef: { page: string, id: string },
 *   recordLabel: string,
 *   intro: string,
 *   emptyText: string,
 * }} props
 */
export default function RecordPipeline({ originRef, recordLabel, intro, emptyText }) {
  const pieces = usePipelinePieces(originRef);
  return (
    <section
      className="rounded-md border border-border p-3"
      data-testid="record-pipeline"
      aria-label="In the pipeline"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          In the pipeline
        </h4>
        <SendToPipelineButton
          originRef={originRef}
          recordLabel={recordLabel}
          ariaLabel={`Draft a piece for ${recordLabel}`}
        />
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{intro}</p>
      <PipelinePieces pieces={pieces} emptyText={emptyText} />
    </section>
  );
}
