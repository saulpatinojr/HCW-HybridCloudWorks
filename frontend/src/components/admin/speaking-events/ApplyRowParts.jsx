/**
 * The pieces every Future Events row shares, whoever's event it is: the
 * title line with its badges, and the words about what an event's dates
 * meet ("Clash", "If you go, these dates meet", "already speaking here").
 * Used by the directory rows (ApplyTab.jsx) and by the owner's own entries
 * (ManualRows.jsx); kept apart so neither file has to import the other.
 */
import React from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { httpUrl } from './eventModel';

export const CLOSE_TONES = {
  bad: 'text-rose-700 dark:text-rose-400',
  warn: 'text-amber-700 dark:text-amber-400',
  muted: 'text-muted-foreground',
};
const CANCELLED = {
  id: 'cancelled',
  label: 'Cancelled',
  tone: 'bad',
  help: 'The organizers cancelled this event.',
};
const POSTPONED = {
  id: 'postponed',
  label: 'Postponed',
  tone: 'warn',
  help: 'The organizers postponed this event; its dates may change.',
};

/**
 * The title (a link to the event's page when there is one), tagline and
 * badges. `badge` is the row's own status badge: the tab's status for a
 * directory event, "Added by you" for one of the owner's own entries.
 */
export function RowHeader({ event, badge }) {
  const page = httpUrl(event.url) || httpUrl(event.website);
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">
          {page ? (
            <a
              href={page}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              aria-label={`${event.title} (opens the event’s page in a new tab)`}
            >
              {event.title}
              <ExternalLink className="ml-1 inline h-3 w-3" aria-hidden="true" />
            </a>
          ) : (
            event.title
          )}
        </h3>
        {event.tagline && <p className="text-xs text-muted-foreground">{event.tagline}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {event.cancelled && <StatusBadge status={CANCELLED} />}
        {event.postponed && <StatusBadge status={POSTPONED} />}
        <StatusBadge status={badge} />
      </div>
    </div>
  );
}

/** "Clash" and "already speaking here", in words and with an icon. */
export function Overlap({ overlap }) {
  if (!overlap) return null;
  const { clashes, wouldMeet = [], speakingHere } = overlap;
  if (clashes.length === 0 && wouldMeet.length === 0 && !speakingHere) return null;
  return (
    <div className="space-y-1 text-xs">
      {wouldMeet.length > 0 && (
        // Not a clash: the owner has not marked this event. Plain grey words,
        // no warning sign, so a long list of unmarked events stays calm.
        <p className="text-muted-foreground" data-testid="would-meet">
          If you go, these dates meet{' '}
          {wouldMeet.map((entry, index) => (
            <span key={`${entry.kind}-${entry.name}`}>
              {index > 0 ? '; ' : ''}
              {entry.name} ({entry.detail})
            </span>
          ))}
          .
        </p>
      )}
      {overlap.speakingHere && (
        <p className="text-emerald-700 dark:text-emerald-400">
          You already have a talk at this event ({overlap.speakingHere}).
        </p>
      )}
      {overlap.clashes.length > 0 && (
        <div
          role="note"
          className="flex items-start gap-1.5 rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
          data-testid="clash"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <div>
            <span className="font-semibold">Clash:</span> these dates meet{' '}
            {overlap.clashes.map((clash, index) => (
              <span key={`${clash.kind}-${clash.name}`}>
                {index > 0 ? '; ' : ''}
                {clash.name} ({clash.detail})
              </span>
            ))}
            .
          </div>
        </div>
      )}
    </div>
  );
}
