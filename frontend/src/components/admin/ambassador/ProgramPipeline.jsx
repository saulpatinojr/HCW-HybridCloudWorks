/**
 * A program's pieces in the Pipeline (#1886): what was started for it, the
 * stage each is at, "Draft a piece" to start another, and "File as evidence"
 * once a piece is live.
 *
 * Ambassador does not draft, schedule or publish anything itself: the
 * Pipeline does, through the shared hand-off (components/admin/shared/pipeline).
 * What is Ambassador's own is the last step, turning a live piece into
 * evidence for the program, and that reuses the evidence import from
 * Published content, whose ids are one per piece: filing the same piece twice
 * finds the row already there instead of making a second.
 */
import React from 'react';
import { Link } from 'react-router';
import { CheckCircle2, FileCheck2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { contentStatusInfo } from '@/lib/status';
import PipelinePieces, {
  usePipelinePieces,
} from '@/components/admin/shared/pipeline/PipelinePieces';
import SendToPipelineButton from '@/components/admin/shared/pipeline/SendToPipelineButton';

/** The nav id this Page sends work under (functions/src/lib/page-links/origin-ref.js). */
export const AMBASSADOR_PAGE = 'ambassador';

/**
 * How each piece of content stands as evidence for one program, from the
 * evidence rows the hub holds: `program` when a row files it under this
 * program, `elsewhere` when a row exists but not under this program (filed
 * generally or for another one), absent when there is no row.
 *
 * The import keeps one row per piece, so filing again for a second program
 * finds the first row and does not add the program to it (review of #1886);
 * `elsewhere` therefore points at the Evidence tab instead of offering a
 * button that would change nothing.
 */
export function evidenceStateByContent(evidenceRows, programId) {
  const states = new Map();
  for (const row of evidenceRows || []) {
    if (row?.sourceModule !== 'content' || !row.sourceId || row.softDeletedAt) continue;
    const id = String(row.sourceId);
    const here = Array.isArray(row.programIds) && row.programIds.includes(programId);
    if (here) states.set(id, 'program');
    else if (!states.has(id)) states.set(id, 'elsewhere');
  }
  return states;
}

/**
 * Whether a piece can be filed: the same test the server's import applies
 * (functions/src/lib/ambassador/import-readers.js isLiveContent), so the
 * button shows exactly when the import would accept the piece. That covers
 * an older document marked live by its `Status` (review of #1891).
 */
export function isLivePiece(piece) {
  if (!piece || ![undefined, null, '', false].includes(piece.softDeletedAt)) return false;
  return contentStatusInfo(piece).stage === 'live' || piece.Status === 'Live';
}

/** The program's reference, as the hand-off sends it. */
export const programRef = (program) => ({ page: AMBASSADOR_PAGE, id: program.id });

/** "Draft a piece" for one program, used on its card and in its details. */
export function DraftForProgramButton({ program, ...props }) {
  return (
    <SendToPipelineButton
      originRef={programRef(program)}
      recordLabel={program.name}
      ariaLabel={`Draft a piece for ${program.name}`}
      {...props}
    />
  );
}

/**
 * @param {{
 *   program: object,
 *   evidenceRows: object[]|null,
 *   onFileEvidence: (contentId: string) => Promise<unknown>,
 *   filing: string|null,
 * }} props
 */
export default function ProgramPipeline({ program, evidenceRows, onFileEvidence, filing }) {
  const pieces = usePipelinePieces(programRef(program));
  const filed = evidenceStateByContent(evidenceRows, program.id);
  const action = (piece) => {
    // Live as every Pipeline page reads it (lib/status.js), so an older
    // document marked live another way is offered too.
    if (!isLivePiece(piece)) return null;
    const state = filed.get(String(piece.id));
    if (state === 'program') {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Filed as evidence
        </span>
      );
    }
    if (state === 'elsewhere') {
      return (
        <Link to="/admin/ambassador?tab=evidence" className="text-xs underline">
          Filed, not under this program: attach it on Evidence
        </Link>
      );
    }
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={!evidenceRows || filing === piece.id}
        onClick={() => onFileEvidence(piece.id)}
      >
        {filing === piece.id ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <FileCheck2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        )}
        File as evidence
      </Button>
    );
  };
  return (
    <div className="rounded-md border border-border p-3" data-testid="program-pipeline">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          In the pipeline
        </h4>
        {program.enabled !== false && <DraftForProgramButton program={program} />}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Pieces started for this program. Each one is written, reviewed, scheduled and published in
        the Pipeline; once it is live, file it here as evidence.
      </p>
      <PipelinePieces
        pieces={pieces}
        emptyText="Nothing started for this program yet."
        renderAction={action}
      />
    </div>
  );
}
