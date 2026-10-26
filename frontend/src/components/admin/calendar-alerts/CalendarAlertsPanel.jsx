/**
 * The Calendar's alerts panel: every alert the owner has set for themselves,
 * with add, edit, done, snooze, delete and the filters, on the Calendar page
 * (`/admin/calendar`) under the grid that shows the same alerts on their days.
 *
 * Owner instruction 2026-10-26: "we already have a calendar in the admin
 * portal so maybe we can build off of that". There is no separate Calendar
 * Alerts page or menu entry: the grid draws an alert as an "Alert" chip on its
 * due day (calendar/calendarModel.js KIND_META), pressing a chip opens its
 * actions (ItemPreviewDialog), and this panel is the whole list. Both read
 * the same alerts; a change in either reaches the other (CalendarPage).
 *
 * The sign-in pop-up (CalendarAlertsPrompt) lists only what is due within a
 * week and links here (`/admin/calendar#alerts`).
 *
 * Alerts are private to the admin portal. "Download .ics" builds a calendar
 * file from the list in the browser and saves it to the owner's disk, so it
 * has no web address.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { BellRing, CheckCircle2, Download, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import { FILTERS, countByFilter, filterAlerts } from '@/lib/calendarAlerts';
import { buildIcs, downloadIcs } from '@/lib/calendarAlertsIcs';
import AlertForm from './AlertForm';
import { AlertBody, AlertLinkButton, SnoozeButtons } from './AlertParts';

/** The address the pop-up and an alert chip send the admin to: this panel. */
export const ALERTS_HASH = '#alerts';

/** What the load error says, in the words an admin can act on. */
function loadErrorText(error) {
  if (error?.status === 403) {
    return 'Your role cannot open calendar alerts. They need the editor role or above.';
  }
  if (error?.status === 401) return 'Your sign-in has expired. Sign in again to see your alerts.';
  return 'The calendar alerts could not be loaded. Try again in a moment.';
}

/** One row of the list: the alert, and what can be done to it. */
function AlertRow({ alert, busy, actions }) {
  const done = alert.state === 'done';
  return (
    <li className="space-y-3 rounded-lg border border-border bg-card p-4" data-state={alert.state}>
      <AlertBody alert={alert} titleAs="h3" />
      <div className="flex flex-wrap items-center gap-2">
        {done ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={`Reopen “${alert.title}”`}
            onClick={actions.reopen}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Reopen
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              aria-label={`Mark “${alert.title}” done`}
              onClick={actions.done}
            >
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Done
            </Button>
            {alert.state === 'snoozed' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                aria-label={`Bring back now: “${alert.title}”`}
                onClick={() => actions.snooze(0)}
              >
                Bring back now
              </Button>
            )}
          </>
        )}
        <AlertLinkButton alert={alert} onOpenAdmin={actions.openAdmin} />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          aria-label={`Edit “${alert.title}”`}
          onClick={actions.edit}
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
          onClick={actions.remove}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Delete
        </Button>
      </div>
      {!done && <SnoozeButtons alert={alert} busy={busy} onSnooze={actions.snooze} />}
    </li>
  );
}

/** The filter buttons, with how many alerts each would show. */
function FilterBar({ filter, counts, onChange }) {
  return (
    <div role="group" aria-label="Show alerts" className="flex flex-wrap gap-2">
      {FILTERS.map(({ id, label }) => (
        <Button
          key={id}
          type="button"
          size="sm"
          variant={filter === id ? 'default' : 'outline'}
          aria-pressed={filter === id}
          onClick={() => onChange(id)}
        >
          {label} ({counts[id]})
        </Button>
      ))}
    </div>
  );
}

/** The filter buttons and the list under them, or the reason there is no list. */
function AlertList({ state, filter, onFilter, actionsFor }) {
  const { alerts, status, error } = state;
  const counts = useMemo(() => countByFilter(alerts), [alerts]);
  const shown = useMemo(() => filterAlerts(alerts, filter), [alerts, filter]);

  if (status === 'error') {
    return <EmptyState variant="error" title={loadErrorText(error)} onRetry={state.reload} />;
  }
  if (status !== 'ready') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading your alerts…
      </p>
    );
  }
  const none = alerts.length === 0;
  return (
    <>
      <FilterBar filter={filter} counts={counts} onChange={onFilter} />
      {shown.length === 0 ? (
        <EmptyState
          compact
          variant={none ? 'empty' : 'filtered'}
          title={none ? 'No alerts yet' : 'Nothing matches this filter'}
          description={
            none
              ? 'Press Add alert to set a note to yourself with a day on it.'
              : 'Choose another filter above, or press All to see every alert.'
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="Calendar alerts">
          {shown.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              busy={state.busyIds.has(alert.id)}
              actions={actionsFor(alert)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * @param {{ state: ReturnType<typeof import('./useCalendarAlerts').default> }} props
 *   the alerts the Calendar page holds; the panel changes them through it
 */
export default function CalendarAlertsPanel({ state }) {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const { toast } = useToast();
  const [filter, setFilter] = useState('open');
  const [editing, setEditing] = useState(null); // null, 'new' or an alert id
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const { alerts, today, status } = state;
  const editingAlert = editing && editing !== 'new' ? alerts.find((a) => a.id === editing) : null;
  const openCount = alerts.filter((alert) => alert.state !== 'done').length;

  // The pop-up's "All alerts" arrives with #alerts: bring the panel into view.
  useEffect(() => {
    if (hash === ALERTS_HASH && status === 'ready') {
      document.getElementById('alerts')?.scrollIntoView?.({ block: 'start' });
    }
  }, [hash, status]);

  /** Run one change; say what happened in a toast either way. */
  async function run(work, success) {
    try {
      await work();
      if (success) toast({ title: success });
      return true;
    } catch (caught) {
      toast({
        title: 'That change was not saved',
        description: caught?.message || 'Try again in a moment.',
        variant: 'destructive',
      });
      return false;
    }
  }

  const actionsFor = (alert) => ({
    done: () => run(() => state.markDone(alert.id), 'Marked done'),
    reopen: () => run(() => state.reopen(alert.id), 'Reopened'),
    snooze: (days) =>
      run(() => state.snooze(alert.id, days), days === 0 ? 'Brought back' : 'Snoozed'),
    edit: () => setEditing(alert.id),
    remove: () => setPendingDelete(alert),
    openAdmin: (href) => navigate(href),
  });

  async function submitForm(payload) {
    if (editingAlert) await state.edit(editingAlert.id, payload);
    else await state.create(payload);
    toast({ title: editingAlert ? 'Alert saved' : 'Alert added' });
    setEditing(null);
  }

  async function confirmDelete() {
    setDeleting(true);
    await run(() => state.remove(pendingDelete.id), 'Alert deleted');
    setDeleting(false);
    setPendingDelete(null);
  }

  /** Build and save the calendar file; a failure is said, not thrown from a click. */
  function downloadCalendarFile() {
    try {
      downloadIcs(buildIcs(alerts));
    } catch {
      toast({
        title: 'The calendar file could not be made',
        description: 'Reload the page and try again.',
        variant: 'destructive',
      });
    }
  }

  return (
    <section id="alerts" aria-labelledby="calendar-alerts-heading" className="scroll-mt-4">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1">
            <CardTitle id="calendar-alerts-heading" className="flex items-center gap-2 text-base">
              <BellRing className="h-4 w-4" aria-hidden="true" />
              Calendar alerts
            </CardTitle>
            <CardDescription>
              Notes to yourself with a day on them. They show on the calendar above as Alert, and
              any that are overdue or due within 7 days pop up when you sign in (at most once per
              session and per day). Days and times are UTC. Alerts are private to signed-in editors
              and above; nothing here is published.
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={openCount === 0}
              onClick={downloadCalendarFile}
            >
              <Download className="mr-1 h-4 w-4" aria-hidden="true" />
              Download .ics
            </Button>
            <Button type="button" onClick={() => setEditing('new')} disabled={editing !== null}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              Add alert
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            “Download .ics” saves your open alerts as a calendar file for your own calendar. It is
            made in your browser and saved to your computer; it has no web address. If you import it
            into an online calendar, the alerts in it are then held by that calendar and no longer
            private to this portal.
          </p>

          {editing !== null && (editing === 'new' || editingAlert) && (
            <AlertForm
              key={editing}
              alert={editingAlert}
              today={today}
              onSubmit={submitForm}
              onCancel={() => setEditing(null)}
            />
          )}

          <AlertList state={state} filter={filter} onFilter={setFilter} actionsFor={actionsFor} />
        </CardContent>
      </Card>

      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete this alert?"
        description={
          pendingDelete
            ? `“${pendingDelete.title}” will be removed. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete alert"
        busy={deleting}
        busyLabel="Deleting…"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
