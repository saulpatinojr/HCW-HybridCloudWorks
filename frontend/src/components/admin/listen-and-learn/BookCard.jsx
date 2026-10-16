/**
 * One book or course in the Library grid (ADR 0033 §4): cover, kind, title,
 * author, and the counts that say how much of it is finished and live.
 * The whole card is one button that opens the book.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { BookOpen, GraduationCap } from 'lucide-react';
import { resolveMediaUrl } from '@/lib/functionsBase';
import { BOOK_KIND_LABEL, bookSummary } from './episodeView';

export default function BookCard({ book, onOpen }) {
  const Icon = book.kind === 'course' ? GraduationCap : BookOpen;
  const counts = book.counts || {};
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(book)}
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open ${book.title}`}
      >
        {book.coverImageUrl ? (
          <img
            src={resolveMediaUrl(book.coverImageUrl)}
            alt=""
            loading="lazy"
            className="aspect-[16/9] w-full object-cover"
          />
        ) : (
          <div className="flex aspect-[16/9] w-full items-center justify-center bg-muted text-muted-foreground">
            <Icon className="h-8 w-8" aria-hidden="true" />
          </div>
        )}
        <div className="flex flex-1 flex-col gap-1.5 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-xs">
              {BOOK_KIND_LABEL[book.kind] || book.kind}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {book.provider}
            </Badge>
            {book.examCode && book.kind === 'course' && (
              <Badge variant="secondary" className="text-xs uppercase">
                {book.examCode}
              </Badge>
            )}
            {book.archivedAt && (
              <Badge variant="outline" className="text-xs">
                Archived
              </Badge>
            )}
          </div>
          <p className="line-clamp-2 text-sm font-semibold">{book.title}</p>
          {book.author && <p className="text-xs text-muted-foreground">{book.author}</p>}
          <p className="mt-auto text-xs text-muted-foreground">{bookSummary(book)}</p>
          {counts.failed > 0 && <p className="text-xs text-destructive">{counts.failed} failed</p>}
        </div>
      </button>
    </li>
  );
}
