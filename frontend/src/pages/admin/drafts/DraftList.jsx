/**
 * The left column of /admin/drafts: every draft, and every article that came
 * from Drafts and has moved on (In Review, or further), newest first. A row
 * is a button that opens the article in the editor; the stage badge says
 * where it is, and an article In Review offers Back to Drafts right here.
 */
import React from 'react';
import { Link } from 'react-router';
import { Loader2, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import { ORIGIN_LABELS, STAGE_LABELS, reviewPath } from './draftForm';

const STAGE_CLASS = {
  draft: 'border-border',
  new: 'border-border',
  in_review: 'border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300',
  live: 'border-green-400 text-green-700 dark:border-green-700 dark:text-green-300',
  past_review: 'border-amber-400 text-amber-700 dark:border-amber-600 dark:text-amber-300',
};

export function StageBadge({ stage }) {
  return (
    <Badge variant="outline" className={`shrink-0 text-xs ${STAGE_CLASS[stage] || ''}`}>
      {STAGE_LABELS[stage] || stage}
    </Badge>
  );
}

function formatUpdated(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function DraftRow({ draft, selected, busy, onSelect, onBackToDrafts }) {
  return (
    <li
      className={`rounded-lg border p-2 text-sm ${
        selected ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'hover:bg-muted/40'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(draft.id)}
        aria-current={selected ? 'true' : undefined}
        className="w-full text-left"
      >
        <span className="flex items-start justify-between gap-2">
          <span className="font-medium leading-snug line-clamp-2">{draft.title}</span>
          <StageBadge stage={draft.stage} />
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {ORIGIN_LABELS[draft.origin] || 'Written here'}
          {draft.updatedAt ? ` · ${formatUpdated(draft.updatedAt)}` : ''}
        </span>
        <TaxonomyChips item={draft} className="mt-1" />
      </button>
      {draft.stage === 'in_review' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {draft.actions?.backToDrafts && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={busy}
              onClick={() => onBackToDrafts(draft)}
              aria-label={`Back to Drafts: ${draft.title}`}
            >
              <Undo2 className="h-3 w-3" />
              Back to Drafts
            </Button>
          )}
          <Link to={reviewPath(draft.id)} className="text-xs underline">
            Open in review
          </Link>
        </div>
      )}
    </li>
  );
}

/**
 * @param {{
 *   drafts: object[],
 *   loading: boolean,
 *   selectedId: string|null,
 *   unsavedNew: boolean,
 *   busy: boolean,
 *   onSelect: (id: string) => void,
 *   onBackToDrafts: (draft: object) => void,
 * }} props
 */
export default function DraftList({
  drafts,
  loading,
  selectedId,
  unsavedNew,
  busy,
  onSelect,
  onBackToDrafts,
}) {
  const inDrafts = drafts.filter((draft) => draft.stage === 'draft').length;
  return (
    <Card className="lg:sticky lg:top-4 self-start">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Drafts{' '}
          <span className="text-sm font-normal text-muted-foreground">
            ({inDrafts} in Drafts, {drafts.length - inDrafts} moved on)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading drafts…
          </p>
        )}
        {!loading && drafts.length === 0 && !unsavedNew && (
          <p className="text-sm text-muted-foreground">
            No drafts yet. Start one with <strong>New draft</strong>, or bring in a markdown file
            with <strong>Paste or upload a markdown draft</strong>.
          </p>
        )}
        <ul className="space-y-2" aria-label="Drafts">
          {unsavedNew && (
            <li className="rounded-lg border border-primary bg-primary/5 p-2 text-sm dark:bg-primary/10">
              <span className="flex items-start justify-between gap-2">
                <span className="font-medium">New draft (not saved yet)</span>
                <StageBadge stage="new" />
              </span>
            </li>
          )}
          {drafts.map((draft) => (
            <DraftRow
              key={draft.id}
              draft={draft}
              selected={draft.id === selectedId}
              busy={busy}
              onSelect={onSelect}
              onBackToDrafts={onBackToDrafts}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
