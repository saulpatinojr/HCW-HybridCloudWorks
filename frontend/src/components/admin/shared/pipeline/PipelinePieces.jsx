/**
 * "In the pipeline" — every piece this Page sent into the Pipeline for one
 * record, with the stage it is at now and a link to where it is worked
 * (#1886). The stage and the link come from the same tables the Pipeline
 * pages use (lib/status.js, lib/itemLinks.js), so a piece reads the same here
 * as it does there.
 *
 * `renderAction(piece)` lets the Page add its own next step to a row: on
 * Ambassador, "File as evidence" once a piece is live.
 */
import React, { useCallback } from 'react';
import { Link } from 'react-router';
import { Loader2 } from 'lucide-react';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { contentItemHref } from '@/lib/itemLinks';
import { contentStatusInfo } from '@/lib/status';
import { MAX_PIECES, draftPath, loadPiecesFor } from './pipelineHandoff';

const NO_PIECES = Object.freeze([]);
const describeError = (err) => `Could not read the pipeline: ${err?.message || 'unknown error'}`;

/**
 * Where a piece opens: a draft opens itself on Drafts (the shared stage table
 * opens the Drafts list, because the Dashboard's links have no draft to name);
 * every other stage opens where the Pipeline pages open it.
 */
export const pieceHref = (piece) =>
  contentStatusInfo(piece).stage === 'drafts' ? draftPath(piece.id) : contentItemHref(piece);

export const pieceTitle = (piece) =>
  String(piece?.Title || piece?.title || '').trim() || 'Untitled draft';

/** The pieces for one record, read when `enabled`; `refresh` re-reads. */
export function usePipelinePieces({ page, id }, { enabled = true } = {}) {
  const load = useCallback(() => loadPiecesFor({ page, id }), [page, id]);
  return useGuardedLoad(load, {
    enabled: Boolean(enabled && page && id),
    empty: NO_PIECES,
    describeError,
  });
}

/**
 * @param {{
 *   pieces: ReturnType<typeof usePipelinePieces>,
 *   emptyText?: string,
 *   renderAction?: (piece: object) => React.ReactNode,
 * }} props
 */
export default function PipelinePieces({
  pieces,
  emptyText = 'Nothing in the pipeline for this yet.',
  renderAction,
}) {
  if (pieces.loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Reading the pipeline…
      </p>
    );
  }
  if (pieces.error) return <p className="text-sm text-destructive">{pieces.error}</p>;
  // A piece removed from the Pipeline (soft-deleted) no longer counts as one.
  const shown = pieces.data.filter((piece) => !piece.softDeletedAt);
  if (shown.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <>
      {pieces.data.length >= MAX_PIECES && (
        <p className="mb-2 text-xs text-muted-foreground" role="status">
          Showing the {MAX_PIECES} most recently changed pieces; older ones are on the Pipeline
          pages.
        </p>
      )}
      <ul className="space-y-2" data-testid="pipeline-pieces">
        {shown.map((piece) => {
          return (
            <li
              key={piece.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2"
            >
              <span className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-2">
                <Link
                  to={pieceHref(piece)}
                  className="min-w-0 truncate text-sm font-medium underline"
                >
                  {pieceTitle(piece)}
                </Link>
                <StatusBadge size="xs" content={piece} />
              </span>
              {renderAction?.(piece)}
            </li>
          );
        })}
      </ul>
    </>
  );
}
