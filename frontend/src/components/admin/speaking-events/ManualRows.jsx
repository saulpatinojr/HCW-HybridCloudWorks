/**
 * The owner's own speaking events on the Future Events tab (owner request
 * 2026-11-25): the row for one entry, its Edit button, "Add an event", and
 * the hub's form when it is open on this tab. Which entries are listed is
 * decided in manualOpportunities.js; this file only draws them.
 *
 * Edit opens the stored entry's own form (the hub's shared editor,
 * useEventEditor), never this tab's status and costs: those are stored per
 * directory event. Without an editor (the tab drawn on its own) Edit is a
 * link to the entry's form on the hub.
 */
import React from 'react';
import { Link } from 'react-router';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ORIGIN_RECORD_PATHS } from '@/lib/pageLinks';
import EventForm from './EventForm';
import { Dismissible } from './TabParts';
import { CLOSE_TONES, Overlap, RowHeader } from './ApplyRowParts';
import { callCloseInfo, eventRange, formatRange, locationLine } from './applyModel';

/** Where Edit on a manual row links when the tab has no editor: the entry's form on the hub. */
export const manualEditHref = (row) => ORIGIN_RECORD_PATHS.speaking({ id: row.docId });
/** The badge on the owner's own rows, in place of the tab's status. */
export const MANUAL_BADGE = {
  id: 'manual',
  label: 'Added by you',
  tone: 'muted',
  help: 'A speaking event you entered on the Speaking hub, with the status Idea.',
};
export const MANUAL_NO_ESTIMATE =
  'Not available for an event you added yourself: the estimate reads the directory’s copy of an event.';

/** Edit on a manual row: the hub's own form for the entry, or a link to it. */
function ManualEdit({ event, onEdit }) {
  const label = `Edit ${event.title}`;
  if (onEdit) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={onEdit}
        aria-label={label}
      >
        <Pencil className="mr-1 h-3 w-3" /> Edit event
      </Button>
    );
  }
  return (
    <Button asChild size="sm" variant="outline" className="h-7 text-xs">
      <Link to={manualEditHref(event)} aria-label={label}>
        <Pencil className="mr-1 h-3 w-3" /> Edit event
      </Link>
    </Button>
  );
}

/**
 * A speaking event the owner added by hand (status Idea). The same dates,
 * days left and clash words as a directory row; its notes and its form are
 * the stored entry's own, so Edit opens that entry rather than this tab's
 * status and costs (those belong to directory events).
 */
export function ManualRow({ event, overlap, today, onEdit }) {
  const close = callCloseInfo(event.callCloses, today);
  return (
    <li className="space-y-2 rounded-xl border border-border p-4" data-event={event.id}>
      <RowHeader event={event} badge={MANUAL_BADGE} />
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">Where</dt>
        <dd>{locationLine(event)}</dd>
        <dt className="text-muted-foreground">When</dt>
        <dd>{formatRange(eventRange(event))}</dd>
        <dt className="text-muted-foreground">Call for speakers</dt>
        <dd className={CLOSE_TONES[close.tone]}>{close.label}</dd>
        {event.entryNotes && (
          <>
            <dt className="text-muted-foreground">Your notes</dt>
            <dd className="whitespace-pre-wrap break-words">{event.entryNotes}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Estimate</dt>
        <dd className="text-muted-foreground">{MANUAL_NO_ESTIMATE}</dd>
      </dl>
      <Overlap overlap={overlap} />
      <div className="flex flex-wrap gap-2">
        <ManualEdit event={event} onEdit={onEdit} />
      </div>
    </li>
  );
}

/**
 * What Edit on a manual row does with the hub's editor: open the stored
 * entry's own form. Null without an editor, so the row links to the hub
 * instead. An entry that has gone from the hub's copy (deleted on another
 * tab a moment ago) opens nothing rather than an empty form.
 */
export function manualEditAction(editor, manualEntries) {
  if (!editor) return () => null;
  return (row) => {
    const entry = (manualEntries ?? []).find((stored) => stored._docId === row.docId);
    return entry ? () => editor.openEditManual(entry) : null;
  };
}

/** "Add an event", beside Refresh: the hub's form for a new entry with the status Idea. */
export function AddEventButton({ editor }) {
  if (!editor) return null;
  return (
    <Button
      size="sm"
      onClick={editor.openNewIdea}
      title="An event you found yourself: saved on the Speaking hub with the status Idea"
    >
      <Plus className="mr-1 h-4 w-4" /> Add an event
    </Button>
  );
}

/** "Add an event", and the hub's form when it is open on this tab. */
export function ManualEditor({ editor }) {
  if (!editor) return null;
  return (
    <>
      {editor.error && <Dismissible onDismiss={editor.clearError}>{editor.error}</Dismissible>}
      {editor.isOpen && <EventForm editor={editor} />}
    </>
  );
}
