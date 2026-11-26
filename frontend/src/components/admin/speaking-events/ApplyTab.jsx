/**
 * Future Events (#1823, ADR 0045): community events whose call for
 * speakers (the period when an event accepts talk proposals) is open, read
 * by the server from the Community Days directory, with what the owner has
 * recorded for each: a status, costs, notes, and a rough estimate of the
 * chance of acceptance.
 *
 * The browser never talks to Community Days and never holds its key: this
 * tab reads `cms/community-days/events` (useApplyEvents). Until the key is
 * set the tab says so plainly and links the Keys tab.
 *
 * THE ESTIMATE IS A GUESS AND IS LABELLED AS ONE wherever it shows. It is
 * made only when the Estimate button on a row is pressed, one event per
 * press; nothing on this tab asks for one by itself. Its reasons are shown
 * as plain text.
 *
 * EVERYTHING FROM THE DIRECTORY IS SOMEONE ELSE'S TEXT. Titles, taglines and
 * places are rendered as text (never as HTML), and a link is used only when
 * it is a plain http(s) address.
 *
 * The small calendar and the "Clash" notes on the rows share one rule
 * (applyModel.js): a clash is two things the owner cares about on the same
 * day. Those are the owner's own talks that are sent or accepted, and events
 * from this tab the owner marked Interested, Applied or Accepted. An event
 * with no status never clashes; its row says in plain grey words what its
 * dates would meet. Days are compared as calendar days in each event's own
 * local time.
 *
 * THE OWNER'S OWN IDEAS ARE LISTED TOO (owner request 2026-11-25). A
 * speaking event the owner added by hand with the status Idea, and that the
 * directory does not already list by the same name, is a row here as well
 * (manualOpportunities.js). It comes from the hub's existing read of the
 * stored events, not from a second read on this tab. Its row has the same
 * dates, days left and clash words; its notes are the entry's own
 * description, it has no estimate (the estimate reads the directory's copy
 * of an event), and Edit opens the entry's form on the Speaking hub.
 */
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle,
  CalendarClock,
  ExternalLink,
  KeyRound,
  Loader2,
  Pencil,
  Sparkles,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthReady } from '@/hooks/useAuthReady';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { tabHref as integrationsTabHref } from '@/components/admin/integrations/tabs';
import { tabHref as aiEngineTabHref } from '@/components/admin/ai-engine/tabs';
import ApplyCalendar from './ApplyCalendar';
import { Dismissible, ReadsStatus, RefreshButton } from './TabParts';
import { SectionHeading } from './EventTables';
import { httpUrl } from './eventModel';
import useApplyEvents from './useApplyEvents';
import { manualOpportunities, withManualRows } from './manualOpportunities';
import { ORIGIN_RECORD_PATHS } from '@/lib/pageLinks';
import {
  APPLY_STATUSES,
  COST_FIELDS,
  applyStatusInfo,
  attendanceCost,
  callCloseInfo,
  costTotal,
  eventRange,
  filterEvents,
  formatDay,
  formatRange,
  locationLine,
  noteForm,
  notePayload,
  ownTalks,
  todayDay,
} from './applyModel';
import { allOverlaps, firstMonth, marksForMonth } from './applyCalendarModel';

export const KEYS_HREF = integrationsTabHref('keys');
export const CARD_HREF = `${integrationsTabHref('services')}&group=content`;
export const ESTIMATE_LABEL = 'Rough estimate, not a measurement';
/** Where the estimate's switch is: the AI Engine page's AI Services tab, under its feature switches. */
export const AI_SWITCHES_HREF = aiEngineTabHref('services');
/** The server's code for "the estimate is switched off" (functions community-days/handlers.js). */
export const SWITCHED_OFF_CODE = 'ESTIMATE_SWITCHED_OFF';
export const CHANGED_ELSEWHERE =
  'What is saved for this event changed while this form was open, so the form now shows the saved values. Make your change again, then press Save.';

const CLEAR_CONFIRM = {
  title: 'Clear what you saved for this event?',
  description:
    'Its status, costs, notes and estimate are removed. The event itself stays in the list while its call is open.',
};

const FILTERS = [
  { id: 'open', label: 'Hide Declined and Not going' },
  { id: 'all', label: 'All events' },
  ...APPLY_STATUSES.map((status) => ({ id: status, label: applyStatusInfo(status).label })),
];

function NoKey() {
  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/30"
    >
      <KeyRound
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          The Community Days key is not set yet, so there are no events to show.
        </p>
        <p className="text-muted-foreground">
          Community Days has to approve API access for your account first. When it has, make a key
          on its developers page, paste it on{' '}
          <Link to={KEYS_HREF} className="underline">
            Integrations → Keys
          </Link>{' '}
          (the row named “Community Days — API key”), then press Test on the{' '}
          <Link to={CARD_HREF} className="underline">
            Community Days card
          </Link>
          . Nothing is called until then.
        </p>
      </div>
    </div>
  );
}

/** The estimate, or the reason there is none yet. Always labelled a rough estimate. */
function Estimate({ estimate }) {
  if (!estimate) {
    return (
      <p className="text-xs text-muted-foreground">
        No estimate yet. Press Estimate to ask for one.
      </p>
    );
  }
  return (
    <div className="space-y-1 text-xs">
      <p>
        <span className="text-base font-semibold" data-testid="estimate-percent">
          {estimate.percent}%
        </span>{' '}
        <span className="text-muted-foreground">chance of acceptance. {ESTIMATE_LABEL}.</span>
      </p>
      {estimate.reasons.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
          {estimate.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground">
        Made {estimate.madeAt ? formatDay(estimate.madeAt.slice(0, 10)) : 'at an unknown time'} by a
        model reading the event’s page
        {estimate.topicsFrom.length > 0 ? ` against: ${estimate.topicsFrom.join('; ')}` : ''}.
      </p>
    </div>
  );
}

/** The inline form for one event's status, costs and notes. */
function NoteEditor({ event, note, busy, onSave, onClose, onClear }) {
  const [form, setForm] = useState(() => noteForm(note));
  const [invalid, setInvalid] = useState('');
  // The version (ETag) of the note this form was filled from. When the row
  // is read again and the version is a different one, someone changed or
  // cleared the note while the form was open: another tab, or the change
  // that made the server refuse this Save with a 409. Saving the old form
  // under the new version would quietly overwrite that change, so the form
  // goes back to the saved values and says so; the owner makes the change
  // again on top of what is really stored.
  const version = note?.etag ?? '';
  const [filledFrom, setFilledFrom] = useState(version);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  if (version !== filledFrom) {
    setFilledFrom(version);
    setForm(noteForm(note));
    setInvalid('');
    setChangedElsewhere(true);
  }
  const id = `apply-${event.id}`;
  const total = costTotal(form.costs);
  const submit = async (e) => {
    e.preventDefault();
    const built = notePayload(form);
    if (built.invalid) {
      setInvalid(built.invalid);
      return;
    }
    setInvalid('');
    if (await onSave(built.payload)) onClose();
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-border bg-muted/30 p-3"
      aria-label={`Your notes for ${event.title}`}
    >
      <div className="flex flex-wrap gap-3">
        <div>
          <Label className="text-xs" htmlFor={`${id}-status`}>
            Your status
          </Label>
          <select
            id={`${id}-status`}
            className="mt-1 block h-8 w-40 rounded-md border border-input bg-background px-2 text-xs"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          >
            {APPLY_STATUSES.map((status) => (
              <option key={status || 'none'} value={status}>
                {applyStatusInfo(status).label}
              </option>
            ))}
          </select>
        </div>
        {COST_FIELDS.map((field) => (
          <div key={field.id}>
            <Label className="text-xs" htmlFor={`${id}-${field.id}`}>
              {field.label}
            </Label>
            <Input
              id={`${id}-${field.id}`}
              className="mt-1 h-8 w-28 text-xs"
              inputMode="decimal"
              placeholder="0"
              value={form.costs[field.id]}
              onChange={(e) =>
                setForm({ ...form, costs: { ...form.costs, [field.id]: e.target.value } })
              }
            />
          </div>
        ))}
        <div className="self-end pb-1 text-xs" aria-live="polite">
          Total: <span className="font-semibold">{total === null ? '—' : total}</span>
          <span className="text-muted-foreground"> (your own figures, no currency)</span>
        </div>
      </div>
      <div>
        <Label className="text-xs" htmlFor={`${id}-notes`}>
          Notes
        </Label>
        <textarea
          id={`${id}-notes`}
          className="mt-1 block min-h-20 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          maxLength={4000}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </div>
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          {invalid}
        </p>
      )}
      {changedElsewhere && (
        <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">
          {CHANGED_ELSEWHERE}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Save
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {note?.etag && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onClear}
            disabled={busy}
          >
            Clear what is saved
          </Button>
        )}
      </div>
    </form>
  );
}

/** "Clash" and "already speaking here", in words and with an icon. */
function Overlap({ overlap }) {
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

const CLOSE_TONES = {
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

/** The title (a link to the event's page when there is one), tagline and badges. */
function RowHeader({ event }) {
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
        <StatusBadge status={event.manual ? MANUAL_BADGE : applyStatusInfo(event.note?.status)} />
      </div>
    </div>
  );
}

/** The owner's cost boxes that hold a number, and their total, in words. */
function costsLine(note) {
  const total = costTotal(note?.costs);
  if (total === null) return 'None entered';
  const parts = COST_FIELDS.filter((field) => typeof note.costs[field.id] === 'number').map(
    (field) => `${field.label} ${note.costs[field.id]}`
  );
  return `${parts.join(', ')} · total ${total}`;
}

/** Where, when, the call's closing day, costs, notes and the estimate. */
function RowFacts({ event, today }) {
  const { note } = event;
  const close = callCloseInfo(event.callCloses, today);
  const callUrl = httpUrl(event.callUrl);
  const off = event.cancelled || event.postponed;
  return (
    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
      <dt className="text-muted-foreground">Where</dt>
      <dd>{locationLine(event)}</dd>
      <dt className="text-muted-foreground">When</dt>
      <dd>
        {formatRange(eventRange(event))}
        {off ? ' (not on the calendar: its dates no longer hold)' : ''}
      </dd>
      <dt className="text-muted-foreground">Call for speakers</dt>
      <dd className={CLOSE_TONES[close.tone]}>
        {close.label}
        {callUrl && (
          <>
            {' · '}
            <a
              href={callUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              aria-label={`Apply to ${event.title} (opens in a new tab)`}
            >
              Apply
            </a>
          </>
        )}
      </dd>
      <dt className="text-muted-foreground">Cost to attend</dt>
      <dd>{attendanceCost(event.costTiers)}</dd>
      <dt className="text-muted-foreground">Your costs</dt>
      <dd>{costsLine(note)}</dd>
      {note?.notes && (
        <>
          <dt className="text-muted-foreground">Your notes</dt>
          <dd className="whitespace-pre-wrap break-words">{note.notes}</dd>
        </>
      )}
      <dt className="text-muted-foreground">Estimate</dt>
      <dd>
        <Estimate estimate={note?.estimate ?? null} />
      </dd>
    </dl>
  );
}

/** Edit and Estimate. Estimate is the only thing on this tab that asks a model. */
function RowActions({ event, busy, estimating, canEstimate, onEdit, onEstimate }) {
  const { note } = event;
  // Each button's spoken name starts with the words it shows and adds the
  // event, so two rows' buttons are told apart without seeing the row.
  const editLabel = note ? 'Edit status, costs and notes' : 'Add status, costs and notes';
  const estimateLabel = note?.estimate ? 'Estimate again' : 'Estimate';
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={onEdit}
        disabled={busy}
        aria-label={`${editLabel} for ${event.title}`}
      >
        <Pencil className="mr-1 h-3 w-3" /> {editLabel}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={onEstimate}
        disabled={busy || !canEstimate || event.cancelled}
        aria-label={`${estimateLabel} the chance of acceptance at ${event.title}`}
        title={
          canEstimate
            ? 'Asks a model once, for this event only'
            : 'Add talk topics on the Speaking hub first'
        }
      >
        {estimating ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Sparkles className="mr-1 h-3 w-3" />
        )}
        {estimateLabel}
      </Button>
    </div>
  );
}

function EventRow({ event, overlap, today, apply, canEstimate, editing, setEditing, askClear }) {
  const { note } = event;
  const busy = apply.busyIds.has(event.id);
  return (
    <li className="space-y-2 rounded-xl border border-border p-4" data-event={event.id}>
      <RowHeader event={event} />
      <RowFacts event={event} today={today} />
      <Overlap overlap={overlap} />
      {editing ? (
        <NoteEditor
          event={event}
          note={note}
          busy={busy}
          onSave={(payload) => apply.save(event.id, payload, note?.etag ?? '')}
          onClose={() => setEditing(null)}
          onClear={() => askClear(event)}
        />
      ) : (
        <RowActions
          event={event}
          busy={busy}
          estimating={apply.kinds[event.id] === 'estimate'}
          canEstimate={canEstimate}
          onEdit={() => setEditing(event.id)}
          onEstimate={() => apply.estimate(event.id)}
        />
      )}
    </li>
  );
}

/** Where Edit on a manual row goes: the entry's own form on the Speaking hub. */
export const manualEditHref = (row) => ORIGIN_RECORD_PATHS.speaking({ id: row.docId });
export const MANUAL_BADGE = {
  id: 'manual',
  label: 'Added by you',
  tone: 'muted',
  help: 'A speaking event you entered on the Speaking hub, with the status Idea.',
};
export const MANUAL_NO_ESTIMATE =
  'Not available for an event you added yourself: the estimate reads the directory’s copy of an event.';

/**
 * A speaking event the owner added by hand (status Idea). The same dates,
 * days left and clash words as a directory row; its notes and its form are
 * the stored entry's own, so Edit opens that entry rather than this tab's
 * status and costs (those belong to directory events).
 */
function ManualRow({ event, overlap, today }) {
  const close = callCloseInfo(event.callCloses, today);
  return (
    <li className="space-y-2 rounded-xl border border-border p-4" data-event={event.id}>
      <RowHeader event={event} />
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
        <Button asChild size="sm" variant="outline" className="h-7 text-xs">
          <Link to={manualEditHref(event)} aria-label={`Edit ${event.title} on the Speaking hub`}>
            <Pencil className="mr-1 h-3 w-3" /> Edit on the Speaking hub
          </Link>
        </Button>
      </div>
    </li>
  );
}

/**
 * Notes kept for events whose call has closed, so they no longer come from
 * the directory. A closed call is exactly when the answer arrives (Applied
 * becomes Accepted or Declined) and when the costs are known, so each row
 * can be edited with the same form as a listed row, not only cleared.
 */
function SavedList({ saved, overlaps, apply, editing, setEditing, askClear }) {
  if (saved.length === 0) return null;
  return (
    <section>
      <SectionHeading>Saved, no longer listed ({saved.length})</SectionHeading>
      <p className="mb-2 text-xs text-muted-foreground">
        These events are not in the directory’s list any more (their call for speakers closed, or
        the event was withdrawn). What you saved is kept, can still be changed, and still counts on
        the calendar.
      </p>
      <ul className="space-y-2" aria-label="Saved events that are no longer listed">
        {saved.map((note) => (
          <SavedRow
            key={note.eventId}
            note={note}
            overlap={overlaps.get(note.eventId)}
            apply={apply}
            editing={editing === note.eventId}
            setEditing={setEditing}
            askClear={askClear}
          />
        ))}
      </ul>
    </section>
  );
}

function SavedRow({ note, overlap, apply, editing, setEditing, askClear }) {
  const page = httpUrl(note.event?.url);
  const { title } = note.event;
  const busy = apply.busyIds.has(note.eventId);
  const clear = () => askClear({ id: note.eventId, title, note });
  return (
    <li className="space-y-1 rounded-xl border border-border p-3 text-xs" data-event={note.eventId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {page ? (
            <a href={page} target="_blank" rel="noopener noreferrer" className="underline">
              {title}
            </a>
          ) : (
            title
          )}
        </span>
        <StatusBadge status={applyStatusInfo(note.status)} />
      </div>
      <p className="text-muted-foreground">
        {formatRange(eventRange(note.event))} · {locationLine(note.event)}
      </p>
      <p>
        <span className="text-muted-foreground">Your costs:</span> {costsLine(note)}
      </p>
      {note.notes && <p className="whitespace-pre-wrap break-words">{note.notes}</p>}
      <Overlap overlap={overlap} />
      {editing ? (
        <NoteEditor
          event={{ id: note.eventId, title }}
          note={note}
          busy={busy}
          onSave={(payload) => apply.save(note.eventId, payload, note.etag ?? '')}
          onClose={() => setEditing(null)}
          onClear={clear}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setEditing(note.eventId)}
            disabled={busy}
            aria-label={`Edit status, costs and notes for ${title}`}
          >
            <Pencil className="mr-1 h-3 w-3" /> Edit status, costs and notes
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
            onClick={clear}
            disabled={busy}
            aria-label={`Clear what is saved for ${title}`}
          >
            <X className="mr-1 h-3 w-3" /> Clear
          </Button>
        </div>
      )}
    </li>
  );
}

function ListNotices({ list }) {
  return (
    <>
      {list.error && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/30"
        >
          {list.status === 'stale' ? 'Showing the last copy that was read. ' : ''}
          {list.error}
        </div>
      )}
      {list.notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {list.notice}
        </p>
      )}
      {list.truncated && (
        <p role="status" className="text-xs text-muted-foreground">
          The directory lists more events than this page reads at once ({list.total ?? 'many'}); the
          soonest are shown.
        </p>
      )}
    </>
  );
}

/** The search box and the Show filter. */
function Filters({ search, setSearch, status, setStatus }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-48 flex-1">
        <Label className="text-xs" htmlFor="apply-search">
          Search events
        </Label>
        <Input
          id="apply-search"
          className="mt-1 h-8 text-xs"
          placeholder="Name, city, country, kind…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div>
        <Label className="text-xs" htmlFor="apply-status">
          Show
        </Label>
        <select
          id="apply-status"
          className="mt-1 block h-8 w-56 rounded-md border border-input bg-background px-2 text-xs"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {FILTERS.map((filter) => (
            <option key={filter.id || 'none'} value={filter.id}>
              {filter.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** What an estimate is compared with, or why the button is off. */
function TopicsLine({ topics, canEstimate }) {
  const count = `${topics.count} talk topic${topics.count === 1 ? '' : 's'}`;
  return (
    <p className="text-xs text-muted-foreground" data-testid="topics-line">
      {canEstimate
        ? `An estimate compares an event’s page with your ${count}${topics.hasBio ? ' and your bio' : ''} (from: ${topics.from.join('; ')}). ${ESTIMATE_LABEL}; it is made only when you press Estimate.`
        : 'No talk topics were found, so Estimate is off. Add a topic or session titles to an event on the Upcoming tab (Enrich), or a bio on the Settings tab.'}
    </p>
  );
}

/** The rows, or what to do when there are none. */
function EventList({ list, shown, children }) {
  // `list.events` here is every row the tab could show: the directory's and
  // the owner's own ideas (ApplyTab passes the merged list).
  if (shown.length > 0) {
    return (
      <ul className="space-y-3" aria-label="Future Events">
        {children}
      </ul>
    );
  }
  if (list.status === 'error') return null;
  const filtered = list.events.length > 0;
  return (
    <EmptyState
      compact
      variant={filtered ? 'filtered' : 'empty'}
      title={filtered ? 'No events match these filters.' : 'No open calls for speakers right now.'}
      description={
        filtered
          ? 'Clear the search or choose another option under Show.'
          : 'Events appear here while their call for speakers is open. Press Refresh to read the list again.'
      }
    />
  );
}

/** The sentence above the list, with when the copy was read. */
function Intro({ fetchedAt }) {
  return (
    <div className="max-w-2xl space-y-1 text-sm text-muted-foreground">
      <p>
        Community events with an open call for speakers, read from the Community Days directory.
        Record a status, your costs and notes for each, and see where its dates meet talks you
        already have. Speaking events you added yourself with the status Idea are listed here too,
        marked “Added by you”.
      </p>
      {fetchedAt && (
        <p className="text-xs">
          <CalendarClock className="mr-1 inline h-3 w-3" aria-hidden="true" />
          List read {new Date(fetchedAt).toLocaleString()}. It is read again when it is six hours
          old, or when you press Refresh.
        </p>
      )}
    </div>
  );
}

/** True when the page's own reads of the owner's talks have not both settled. */
const talksNotReady = (data) =>
  !(data.stored.loaded && (data.sessionize.loaded || Boolean(data.sessionize.error)));

export default function ApplyTab({ data }) {
  const { authReady } = useAuthReady();
  const apply = useApplyEvents(authReady);
  const { read } = apply;
  const list = read.data;
  const today = todayDay();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('open');
  const [editing, setEditing] = useState(null);
  const [pendingClear, setPendingClear] = useState(null);
  const [month, setMonth] = useState(null);

  const talks = useMemo(() => ownTalks(data.rows), [data.rows]);
  // The directory's rows with the owner's own ideas slotted in by date. The
  // clash rule, the calendar and the filters all read this one list.
  const manual = useMemo(
    () => manualOpportunities(data.rows?.manualEntries, { events: list.events, saved: list.saved }),
    [data.rows, list.events, list.saved]
  );
  const events = useMemo(() => withManualRows(list.events, manual), [list.events, manual]);
  const overlaps = useMemo(
    () => allOverlaps({ events, saved: list.saved, talks }),
    [events, list.saved, talks]
  );
  const shownMonth = month ?? firstMonth(events, today);
  const marks = marksForMonth(shownMonth, { events, saved: list.saved, talks });
  const shown = filterEvents(events, { search, status });
  const canEstimate = list.topics.count > 0 || list.topics.hasBio;
  const askClear = (target) =>
    setPendingClear({ id: target.id, title: target.title, note: target.note });

  const confirmClear = async () => {
    const target = pendingClear;
    setPendingClear(null);
    if (target?.note?.etag) {
      await apply.clear(target.id, target.note.etag);
      setEditing(null);
    }
  };

  return (
    <div className="space-y-6 pt-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Intro fetchedAt={list.fetchedAt} />
        <RefreshButton onClick={apply.refreshNow} busy={read.pending} disabled={!list.keySet}>
          Refresh
        </RefreshButton>
      </div>

      {apply.writeError && (
        <Dismissible onDismiss={apply.clearWriteError}>
          {apply.writeError}
          {apply.writeErrorCode === SWITCHED_OFF_CODE && (
            <>
              {' '}
              <Link to={AI_SWITCHES_HREF} className="underline">
                Open AI Engine → AI Services
              </Link>
            </>
          )}
        </Dismissible>
      )}
      <ReadsStatus reads={[read]} label="events to apply to" />

      {read.loaded && !list.keySet && <NoKey />}
      {read.loaded && <ListNotices list={list} />}

      {read.loaded && (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="order-2 space-y-4 lg:order-1">
            {(list.keySet || manual.length > 0) && (
              <>
                <Filters
                  search={search}
                  setSearch={setSearch}
                  status={status}
                  setStatus={setStatus}
                />
                {/* About the estimate, which only directory events have. */}
                {list.keySet && <TopicsLine topics={list.topics} canEstimate={canEstimate} />}
                <EventList list={{ ...list, events }} shown={shown}>
                  {shown.map((event) =>
                    event.manual ? (
                      <ManualRow
                        key={event.id}
                        event={event}
                        overlap={overlaps.get(event.id)}
                        today={today}
                      />
                    ) : (
                      <EventRow
                        key={event.id}
                        event={event}
                        overlap={overlaps.get(event.id)}
                        today={today}
                        apply={apply}
                        canEstimate={canEstimate}
                        editing={editing === event.id}
                        setEditing={setEditing}
                        askClear={askClear}
                      />
                    )
                  )}
                </EventList>
              </>
            )}
            <SavedList
              saved={list.saved}
              overlaps={overlaps}
              apply={apply}
              editing={editing}
              setEditing={setEditing}
              askClear={askClear}
            />
          </div>

          <div className="order-1 space-y-2 lg:order-2">
            <ApplyCalendar month={shownMonth} onMonth={setMonth} marks={marks} today={today} />
            {talksNotReady(data) && (
              <p role="status" className="text-xs text-muted-foreground">
                Your own talks are still loading, or could not be read, so clashes with them may be
                missing.
              </p>
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        open={Boolean(pendingClear)}
        title={CLEAR_CONFIRM.title}
        description={CLEAR_CONFIRM.description}
        confirmLabel="Clear"
        onConfirm={confirmClear}
        onCancel={() => setPendingClear(null)}
      />
    </div>
  );
}
