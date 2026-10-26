/**
 * What the Calendar's preview dialog shows for an item of kind `alert`: the
 * alert's day and note, and its actions. The dialog's own header already names
 * the alert and says "Alert · <date>", and its status badge says open,
 * snoozed or done.
 *
 * Done or Reopen, Snooze (1 day, 3 days, next week), Open link, Edit and
 * Delete, each as on the alerts panel. Every change is reported through
 * `onDone`, which is the Calendar's refetch (and, on the Calendar page, a
 * reload of the panel). The actions are the alerts API in lib/calendarAlerts.js; nothing here touches
 * content, scheduling or social.
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import { CheckCircle2, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import ConfirmModal from '@/components/admin/ConfirmModal';
import {
  alertFromCalendarItem,
  deleteCalendarAlert,
  updateCalendarAlert,
} from '@/lib/calendarAlerts';
import AlertForm from './AlertForm';
import { AlertLinkButton, DueText, SnoozeButtons } from './AlertParts';

export default function AlertPreviewBody({ item, onDone, onClose }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const alert = alertFromCalendarItem(item);
  const done = alert.state === 'done';

  /** Run one change, say what happened, and tell the Calendar to read again. */
  async function run(work, success) {
    setBusy(true);
    try {
      await work();
      toast({ title: success });
      onDone();
    } catch (error) {
      toast({
        title: 'That change was not saved',
        description: error?.message || 'Try again in a moment.',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  if (editing) {
    return (
      <AlertForm
        alert={alert}
        today={new Date().toISOString().slice(0, 10)}
        onCancel={() => setEditing(false)}
        // A refusal goes back to the form, which shows the server's sentence.
        onSubmit={async (payload) => {
          await updateCalendarAlert(alert.id, payload);
          toast({ title: 'Alert saved' });
          onDone();
        }}
      />
    );
  }

  return (
    <div className="space-y-3">
      <DueText alert={alert} />
      {alert.note && (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {alert.note}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {done ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={`Reopen “${alert.title}”`}
            onClick={() => run(() => updateCalendarAlert(alert.id, { done: false }), 'Reopened')}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Reopen
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            aria-label={`Mark “${alert.title}” done`}
            onClick={() => run(() => updateCalendarAlert(alert.id, { done: true }), 'Marked done')}
          >
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Done
          </Button>
        )}
        <AlertLinkButton
          alert={alert}
          onOpenAdmin={(href) => {
            onClose();
            navigate(href);
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          aria-label={`Edit “${alert.title}”`}
          onClick={() => setEditing(true)}
        >
          <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Edit
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          aria-label={`Delete “${alert.title}”`}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Delete
        </Button>
      </div>
      {!done && (
        <SnoozeButtons
          alert={alert}
          busy={busy}
          onSnooze={(days) =>
            run(
              () => updateCalendarAlert(alert.id, { snoozeDays: days }),
              days === 0 ? 'Brought back' : 'Snoozed'
            )
          }
        />
      )}
      <ConfirmModal
        open={confirmDelete}
        title="Delete this alert?"
        description={`“${alert.title}” will be removed. This cannot be undone.`}
        confirmLabel="Delete alert"
        busy={busy}
        busyLabel="Deleting…"
        onConfirm={() => run(() => deleteCalendarAlert(alert.id), 'Alert deleted')}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
