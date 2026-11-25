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
import { CheckCircle2, FileCheck2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PipelinePieces, {
  usePipelinePieces,
} from '@/components/admin/shared/pipeline/PipelinePieces';
import SendToPipelineButton from '@/components/admin/shared/pipeline/SendToPipelineButton';

/** The nav id this Page sends work under (functions/src/lib/page-links/origin-ref.js). */
export const AMBASSADOR_PAGE = 'ambassador';

/** The content ids already filed as evidence, from the evidence rows the hub holds. */
export function filedContentIds(evidenceRows) {
  return new Set(
    (evidenceRows || [])
      .filter((row) => row?.sourceModule === 'content' && row.sourceId)
      .map((row) => String(row.sourceId))
  );
}

/** The program's reference, as the hand-off sends it. */
export const programRef = (program) => ({ page: AMBASSADOR_PAGE, id: program.id });

/** "Draft a piece" for one program, used on its card and in its details. */
export function DraftForProgramButton({ program, ...props }) {
  return (
    <SendToPipelineButton originRef={programRef(program)} recordLabel={program.name} {...props} />
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
  const filed = filedContentIds(evidenceRows);
  const action = (piece) => {
    if (piece.Live !== true) return null;
    if (filed.has(String(piece.id))) {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Filed as evidence
        </span>
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
        <DraftForProgramButton program={program} />
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
