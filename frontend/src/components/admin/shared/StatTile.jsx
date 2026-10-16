/**
 * StatTile: one number, what it counts, and the page it opens.
 *
 *   [icon]                     >
 *   56
 *   Blogs
 *   6 to review                  <- the note line, reserved when empty
 *
 * EVERY TILE IS THE SAME HEIGHT. The label and the note each own exactly one
 * line, and the note line is held open (a non-breaking space) when a tile has
 * no note, so a tile that does have one never stretches its row (the
 * dashboard's Rejected tile did, 2026-10-08). Text that would not fit is cut
 * with the whole of it in `title` rather than wrapping into a second line.
 *
 * Spans, not paragraphs: nothing here should inherit the `p` default margin
 * in index.css, which is what left about 16 px of dead space under every
 * dashboard label.
 *
 * The parent sizes the grid; the tile fills its cell (`h-full`), so a grid
 * with `auto-rows-fr` gets equal tiles across every row.
 */
import React from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * @param {{
 *   to: string,
 *   value: React.ReactNode,
 *   label: string,
 *   note?: string | null,
 *   icon?: React.ComponentType<{ className?: string }>,
 *   iconClassName?: string,
 *   noteClassName?: string,
 *   ariaLabel?: string,
 *   className?: string,
 * }} props
 */
export default function StatTile({
  to,
  value,
  label,
  note = null,
  icon: Icon,
  iconClassName,
  noteClassName,
  ariaLabel,
  className,
}) {
  return (
    <Link
      to={to}
      aria-label={ariaLabel}
      data-testid="stat-tile"
      className={cn(
        'group flex h-full min-w-0 flex-col rounded-xl border p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      <span className="flex h-4 items-center justify-between" aria-hidden="true">
        {Icon ? <Icon className={cn('h-4 w-4', iconClassName)} /> : <span />}
        <ChevronRight className="h-3 w-3 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground" />
      </span>
      <span className="mt-2 text-2xl font-bold leading-8 tabular-nums">{value}</span>
      <span className="truncate text-xs font-medium leading-4 text-muted-foreground" title={label}>
        {label}
      </span>
      {note ? (
        <span
          className={cn(
            'mt-0.5 truncate text-xs leading-4',
            noteClassName ?? 'text-muted-foreground'
          )}
          title={note}
          data-testid="stat-tile-note"
        >
          {note}
        </span>
      ) : (
        <span className="mt-0.5 text-xs leading-4" aria-hidden="true" data-testid="stat-tile-note">
          &nbsp;
        </span>
      )}
    </Link>
  );
}
