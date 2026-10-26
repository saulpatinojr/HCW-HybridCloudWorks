/**
 * Schedule, or move, one content item: pick it (unless the caller already
 * did), pick a day and a time, see what else lands in that slot, confirm.
 * The keyboard route to everything drag-and-drop does on the grid, and the
 * dialog quick create opens with the day prefilled (ADR 0033 Amplify slice).
 *
 * Past instants are refused here, before the publisher RPC refuses them with
 * a 400 the owner would have to read twice.
 */
import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { SLOT_MS, browserTimeZone, combineDateTime, dayKeyOf, dateOfKey } from './calendarModel';

const titleOf = (content) => content?.Title || content?.title || 'Untitled';

/** Why the form cannot be submitted as it stands, or ''. */
export function scheduleProblem({ chosen, when, now = Date.now() }) {
  if (!chosen) return 'Pick the content to schedule.';
  if (!when) return 'Enter a time as HH:MM.';
  if (when.getTime() <= now) return 'That time has passed. Pick a time in the future.';
  return '';
}

/** The other timed items in the same quarter hour as `when`. An owner's alert publishes nothing, so it never crowds a slot. */
export function sameSlotItems(items, when, excludeId) {
  if (!when) return [];
  const slot = Math.floor(when.getTime() / SLOT_MS);
  return (items || []).filter(
    (item) =>
      !item.allDay &&
      item.kind !== 'alert' &&
      item.id !== excludeId &&
      Math.floor(Date.parse(item.start) / SLOT_MS) === slot
  );
}

function ContentSelect({ picked, choices, onPick }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="cal-content">Content</Label>
      <select
        id="cal-content"
        value={picked}
        onChange={(event) => onPick(event.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="">Choose approved content…</option>
        {choices.map((row) => (
          <option key={row.id} value={row.id}>
            {titleOf(row)}
          </option>
        ))}
      </select>
      {choices.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nothing is approved and unscheduled. Approve content on the Review Queue first.
        </p>
      )}
    </div>
  );
}

function SlotWarning({ items }) {
  if (items.length === 0) return null;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        {items.length === 1 ? 'Another item lands' : `${items.length} other items land`} in the same
        15-minute slot: {items.map((item) => item.title).join(', ')}. You can still schedule it.
      </span>
    </p>
  );
}

/** Title and lead sentence: what is being scheduled, or moved, and in which zone. */
function ScheduleHeading({ moving, chosen }) {
  return (
    <DialogHeader>
      <DialogTitle>{moving ? 'Move the publish' : 'Schedule content'}</DialogTitle>
      <DialogDescription>
        {chosen
          ? `“${titleOf(chosen)}” publishes at the time below.`
          : 'Choose approved content and when it publishes.'}{' '}
        Times are in {browserTimeZone()}.
      </DialogDescription>
    </DialogHeader>
  );
}

/** Day and time. No `min` on the day: the past is refused with a sentence, not a browser tooltip. */
function WhenFields({ day, time, onDay, onTime }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="cal-day">Day</Label>
        <Input
          id="cal-day"
          type="date"
          value={day}
          onChange={(event) => onDay(event.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cal-time">Time</Label>
        <Input
          id="cal-time"
          type="time"
          value={time}
          onChange={(event) => onTime(event.target.value)}
          required
        />
      </div>
    </div>
  );
}

/** Cancel and the submit, which waits while a write runs or while there is nothing to pick. */
function ScheduleFooter({ busy, canSubmit, moving, onClose }) {
  return (
    <DialogFooter className="gap-2 sm:gap-0">
      <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" disabled={busy || !canSubmit}>
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {moving ? 'Move' : 'Schedule'}
      </Button>
    </DialogFooter>
  );
}

export default function ScheduleDialog({
  open,
  content = null,
  choices = [],
  initialDay,
  initialTime = '09:00',
  items = [],
  excludeId = null,
  busy = false,
  mode = 'schedule',
  onSubmit,
  onClose,
}) {
  const [picked, setPicked] = useState(content?.id || '');
  const [day, setDay] = useState(dayKeyOf(initialDay || new Date()));
  const [time, setTime] = useState(initialTime);
  const [error, setError] = useState('');

  const chosen = content || choices.find((row) => row.id === picked) || null;
  const when = useMemo(() => combineDateTime(dateOfKey(day), time), [day, time]);
  const sameSlot = useMemo(() => sameSlotItems(items, when, excludeId), [items, when, excludeId]);
  const moving = mode === 'reschedule';
  const canSubmit = Boolean(content) || choices.length > 0;

  const submit = (event) => {
    event.preventDefault();
    const problem = scheduleProblem({ chosen, when });
    setError(problem);
    if (!problem) onSubmit({ content: chosen, when });
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <ScheduleHeading moving={moving} chosen={chosen} />

          {!content && <ContentSelect picked={picked} choices={choices} onPick={setPicked} />}

          <WhenFields day={day} time={time} onDay={setDay} onTime={setTime} />

          <SlotWarning items={sameSlot} />

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <ScheduleFooter busy={busy} canSubmit={canSubmit} moving={moving} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}
