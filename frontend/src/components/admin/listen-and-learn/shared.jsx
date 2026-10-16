/**
 * The parts the Review tab needs: choosing a book, and rendering the
 * chapters of the chosen one. Kept apart from the tab so the list can be
 * tested without the page's job polling (#588).
 */
import React from 'react';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import EpisodeCard from './EpisodeCard';

/** The books, as one button each. `null` selection selects nothing. */
export function SetPicker({ sets, selected, onOpen }) {
  if (sets.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing in the library yet.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {sets.map((set) => (
        <Button
          key={set.id}
          size="sm"
          variant={
            selected?.examCode === set.examCode && selected?.platform === set.provider
              ? 'default'
              : 'outline'
          }
          onClick={() => onOpen(set.provider, set.examCode)}
        >
          {set.kind === 'course' ? set.examCode : set.title}
          <span className="ml-1.5 text-xs opacity-70">{set.provider}</span>
        </Button>
      ))}
    </div>
  );
}

/**
 * The chosen book's chapters, or the reason there are none to show.
 */
export function EpisodeList({
  loading,
  episodes,
  busySlugs,
  onReview,
  onRetry,
  onKeepCurrent,
  emptyLabel,
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading chapters…
      </p>
    );
  }
  if (episodes.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-3">
      {episodes.map((episode) => (
        <EpisodeCard
          key={episode.id}
          episode={episode}
          busy={busySlugs.has(episode.id)}
          onReview={onReview}
          onRetry={onRetry}
          onKeepCurrent={onKeepCurrent}
        />
      ))}
    </div>
  );
}

/** "3 published · 2 draft · 0 failed" for the chosen book. */
export function CountsLine({ counts }) {
  return (
    <span className="text-xs font-normal text-muted-foreground">
      {counts.published || 0} published · {counts.draft || 0} draft · {counts.failed || 0} failed
      {counts.archived ? ` · ${counts.archived} archived` : ''}
    </span>
  );
}
