/**
 * Reminders — the owner's dated things not to forget, said on Telegram.
 *
 *   Reminders   admin_config/reminders   read by timers/reminders.js, daily
 *
 * Owner request 2026-10-06: a token expiry, a re-verification date and the
 * like had been living in notes rather than anywhere the platform could act
 * on. The daily check says each one on Telegram once within its lead days,
 * once on the day, then weekly while overdue, until it is marked done.
 *
 * Owner request the same evening, on seeing the first cut: a form at the top
 * to add ONE reminder, and on Save it lands in a pane below listing every
 * reminder with its details and a red circle X to cancel it. And from the
 * brief that followed (#917): an Edit action on every reminder, opening it
 * into the same form, saving instantly and updating the pane in place; and a
 * Test Telegram button at the top that proves the channel through the
 * production notifier and shows Telegram's own reason when it refuses.
 *
 * Owner request 2026-10-07: the bot's QR code on the page, for re-pairing a
 * phone that loses the bot. TelegramReconnectPanel holds it, wrapped around
 * the test button so the scan and its proof sit together.
 *
 * So the tab is: the QR panel with the test button; the form, which saves the list with the new
 * row appended and then clears; and the list, where each row can be edited
 * (the same form, in place), marked done, or cancelled (removed), each a
 * save of its own. One delivery method exists, so the form says "Delivered
 * by Telegram" rather than offering a choice of one. Cancel asks once,
 * inline, before it removes.
 *
 * The `notified` stamps the timer writes ride along on every save unchanged
 * and the server merges any stamp written while the page was open, so saving
 * from here never makes a reminder fire twice.
 */

import React, { useMemo, useState } from 'react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  BellRing,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  Send,
  X,
  XCircle,
} from 'lucide-react';
import { postJSON } from '@/lib/api';
import { LINK_PARAMS } from '@/lib/itemLinks';
import useLinkedItem from '@/hooks/useLinkedItem';
import IntegrationBadge from '@/components/admin/shared/IntegrationBadge';
import TelegramReconnectPanel from './TelegramReconnectPanel';
import {
  MAX_LEAD_DAYS,
  TELEGRAM_TEST_ROUTE,
  TONE_CLASS,
  describeDue,
  describeNotified,
  describeTestResult,
  displayOrder,
  newReminder,
  plural,
  rowProblem,
  todayIso,
} from './remindersModel';
import { SETTING_LABELS, SettingSection, StoredState, useSetting } from './settingShared';

// The plain rules live in remindersModel.js; these were exported from here
// before, so they still are.
export {
  DEFAULT_LEAD_DAYS,
  MAX_LEAD_DAYS,
  TELEGRAM_TEST_ROUTE,
  todayIso,
  daysUntil,
  describeDue,
  newReminder,
  rowProblem,
  displayOrder,
  describeNotified,
  describeTestResult,
} from './remindersModel';

/** The button at the top: one test through the production notifier, and what came back. */
export function TestTelegramButton({ send = () => postJSON(TELEGRAM_TEST_ROUTE, {}) }) {
  const [state, setState] = useState({ phase: 'idle' });
  const run = async () => {
    setState({ phase: 'sending' });
    try {
      const result = await send();
      setState({ phase: 'done', ...describeTestResult(result) });
    } catch (error) {
      setState({ phase: 'done', ok: false, text: error?.message || 'The request failed.' });
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/30 p-3">
      <Button type="button" size="sm" disabled={state.phase === 'sending'} onClick={run}>
        {state.phase === 'sending' ? (
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Send className="mr-2 h-3.5 w-3.5" />
        )}
        Test Telegram
      </Button>
      <span className="text-xs text-muted-foreground">
        Sends one message through the same path the reminders use.
      </span>
      {state.phase === 'done' ? (
        <p
          role="status"
          className={`flex w-full items-start gap-2 text-sm ${state.ok ? '' : 'text-destructive'}`}
        >
          {state.ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span>{state.text}</span>
        </p>
      ) : null}
    </div>
  );
}

/** The one delivery method there is, named rather than offered as a choice of one. */
const DeliveredBy = () => <IntegrationBadge id="telegram" prefix="Delivered by" size="xs" />;

/**
 * The form, for a new reminder or an existing one. `initial` is the row it
 * edits; `onSubmit` receives the trimmed row and resolves true when the save
 * took, which clears a new form or closes an edit. Submit is held back until
 * the row would pass the server, and the reason is shown.
 */
export function ReminderForm({
  initial,
  heading,
  submitLabel,
  showDone = false,
  saving,
  onSubmit,
  onCancel = null,
}) {
  const [draft, setDraft] = useState(initial);
  const problem = rowProblem(draft);
  const edit = (patch) => setDraft((current) => ({ ...current, ...patch }));

  const submit = async (event) => {
    event.preventDefault();
    if (problem) return;
    const taken = await onSubmit({
      ...draft,
      title: draft.title.trim(),
      leadDays: Number(draft.leadDays),
      notes: draft.notes.trim(),
      url: draft.url.trim(),
    });
    if (taken && !onCancel) setDraft(newReminder());
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-md border border-border p-3"
      aria-label={heading}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{heading}</p>
        <DeliveredBy />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Title"
          value={draft.title}
          disabled={saving}
          placeholder="What must not be forgotten"
          onChange={(event) => edit({ title: event.target.value })}
          className="w-full sm:w-80"
        />
        <Input
          aria-label="Due date"
          type="date"
          value={draft.dueDate}
          disabled={saving}
          onChange={(event) => edit({ dueDate: event.target.value })}
          className="w-44"
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Days before</span>
          <Input
            aria-label="Days before"
            type="number"
            min={0}
            max={MAX_LEAD_DAYS}
            step={1}
            value={draft.leadDays}
            disabled={saving}
            onChange={(event) => edit({ leadDays: event.target.value })}
            className="w-20"
          />
        </label>
        {showDone ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Done"
              checked={Boolean(draft.done)}
              disabled={saving}
              onChange={(event) => edit({ done: event.target.checked })}
              className="h-4 w-4"
            />
            Done (no more messages)
          </label>
        ) : null}
      </div>
      <Input
        aria-label="Link"
        value={draft.url}
        disabled={saving}
        spellCheck={false}
        placeholder="https:// where to go when it fires (optional)"
        onChange={(event) => edit({ url: event.target.value })}
        className="font-mono text-xs"
      />
      <Textarea
        aria-label="Notes"
        value={draft.notes}
        disabled={saving}
        rows={2}
        placeholder="What to do, in a line or two (optional; sent with the message)"
        onChange={(event) => edit({ notes: event.target.value })}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {problem ?? 'Telegram says it once in the window, once on the day, weekly while overdue.'}
        </span>
        <span className="flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
              Keep as it was
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={saving || Boolean(problem)}>
            {onCancel ? (
              <Pencil className="mr-2 h-3.5 w-3.5" />
            ) : (
              <Plus className="mr-2 h-3.5 w-3.5" />
            )}
            {submitLabel}
          </Button>
        </span>
      </div>
    </form>
  );
}

/** The top form: adds one reminder and clears when the save took. */
export function NewReminderForm({ saving, onAdd }) {
  return (
    <ReminderForm
      initial={newReminder()}
      heading="New reminder"
      submitLabel="Add reminder"
      saving={saving}
      onSubmit={onAdd}
    />
  );
}

/**
 * The rows another part of the platform keeps on this sheet, by their
 * reserved id prefix, read-only here (#1026, #1886). The server keeps them as
 * stored whatever a save sends (functions/src/lib/reminders/settings.js,
 * PROVIDED_ROWS and mergeStoredStamps; review of #1039), so offering Edit,
 * Done or the X on one would offer a change that is silently undone.
 * remindersKeepers.test.js holds this list to the server's.
 */
export const CREDENTIAL_ROW_PREFIX = 'credential-';
export const CREDENTIALS_TAB_HREF = '/admin/integrations?tab=credentials';
export const ROW_KEEPERS = Object.freeze([
  Object.freeze({
    prefix: CREDENTIAL_ROW_PREFIX,
    label: 'Integrations → Credentials',
    href: CREDENTIALS_TAB_HREF,
    how: 'Record the rotation there to move it',
  }),
  Object.freeze({
    prefix: 'ambassador-',
    label: 'Ambassador',
    href: '/admin/ambassador',
    how: 'It moves with the deadline, and goes once the period’s activity requirement is met',
  }),
]);

/** Who keeps a row, or null for one of the owner's own. */
export const keeperOf = (reminder) =>
  (typeof reminder?.id === 'string' &&
    ROW_KEEPERS.find(({ prefix }) => reminder.id.startsWith(prefix))) ||
  null;
export const isRegisterRow = (reminder) => keeperOf(reminder) !== null;

/** In place of the controls on a kept row: who keeps it, and how it moves. */
function ManagedNote({ keeper }) {
  return (
    <p className="max-w-xs text-xs text-muted-foreground">
      Managed by{' '}
      <a href={keeper.href} className="underline">
        {keeper.label}
      </a>
      . {keeper.how}; it cannot be edited, marked done or removed here.
    </p>
  );
}

/** One listed reminder: its details, Edit, Done, and the red X that cancels it after one confirmation. */
function ReminderItem({ reminder, today, saving, onEdit, onToggleDone, onCancel }) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const keeper = keeperOf(reminder);
  const managed = keeper !== null;
  // `?reminder=<id>` (the dashboard's Decision Center) scrolls to this one and rings it.
  const { ref, linkedProps, linkedClassName } = useLinkedItem(LINK_PARAMS.reminder, reminder.id);
  const due = describeDue(reminder, today);
  const said = describeNotified(reminder.notified);

  if (editing) {
    return (
      <li>
        <ReminderForm
          initial={reminder}
          heading={`Edit reminder: ${reminder.title}`}
          submitLabel="Save changes"
          showDone
          saving={saving}
          onSubmit={async (row) => {
            const taken = await onEdit(row);
            if (taken) setEditing(false);
            return taken;
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li
      ref={ref}
      {...linkedProps}
      className={`flex flex-wrap items-start gap-3 rounded-md border border-border p-3 ${linkedClassName}`}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`font-medium ${reminder.done ? 'text-muted-foreground line-through' : ''}`}
          >
            {reminder.title}
          </span>
          <span className={`rounded-full border px-2 py-0.5 text-xs ${TONE_CLASS[due.tone]}`}>
            {due.label}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Due {reminder.dueDate} · {plural(Number(reminder.leadDays) || 0, 'day')} before
          {reminder.url ? (
            <>
              {' · '}
              <a
                href={reminder.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline"
              >
                Link <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </>
          ) : null}
        </p>
        {reminder.notes ? <p className="whitespace-pre-wrap text-sm">{reminder.notes}</p> : null}
        <p className="text-xs text-muted-foreground">
          {said ?? 'Telegram has not said this one yet.'}
        </p>
      </div>
      {managed ? (
        <ManagedNote keeper={keeper} />
      ) : (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            aria-label={`Edit reminder: ${reminder.title}`}
            onClick={() => setEditing(true)}
          >
            <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label={`Done: ${reminder.title}`}
              checked={Boolean(reminder.done)}
              disabled={saving}
              onChange={(event) => onToggleDone(event.target.checked)}
              className="h-4 w-4"
            />
            Done
          </label>
          {confirming ? (
            <span className="flex items-center gap-2 text-xs">
              <span className="text-destructive">Cancel this reminder?</span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={saving}
                onClick={onCancel}
              >
                Yes, cancel
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => setConfirming(false)}
              >
                Keep
              </Button>
            </span>
          ) : (
            <button
              type="button"
              aria-label={`Cancel reminder: ${reminder.title}`}
              title="Cancel this reminder"
              disabled={saving}
              onClick={() => setConfirming(true)}
              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** The pane: every reminder, undated first, then open by date, then done. */
export function ReminderList({ reminders, today, saving, onEdit, onToggleDone, onCancel }) {
  const order = useMemo(() => displayOrder(reminders), [reminders]);
  const open = reminders.filter((reminder) => !reminder.done).length;
  return (
    <section aria-label="Your reminders" className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Your reminders</p>
        <p className="text-xs text-muted-foreground">
          {reminders.length === 0
            ? '0 reminders.'
            : `${plural(open, 'open reminder')}${reminders.length - open > 0 ? `, ${reminders.length - open} done` : ''}.`}
        </p>
      </div>
      {reminders.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          Nothing here yet. Add the first one above; it appears here when saved.
        </p>
      ) : (
        <ul className="space-y-2">
          {order.map((index) => (
            <ReminderItem
              key={reminders[index].id}
              reminder={reminders[index]}
              today={today}
              saving={saving}
              onEdit={(row) => onEdit(index, row)}
              onToggleDone={(done) => onToggleDone(index, done)}
              onCancel={() => onCancel(index)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The card: test button, form on top, list below, one stored document. Every
 * action is its own save of the whole list — append, replace, flip done,
 * remove — and `onSave` resolves true when the server took it.
 */
export function RemindersCard({ value, onSave, saving, meta, today = todayIso(), sendTest }) {
  const reminders = useMemo(() => value?.reminders ?? [], [value]);
  const saveList = (next) => onSave({ reminders: next });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <BellRing className="h-5 w-5" /> Reminders <IntegrationBadge id="telegram" />
        </CardTitle>
        <CardDescription>
          Dated things not to forget: a token that expires, a renewal, a date to re-check something.
          Each one is said on Telegram once within its days-before window, once on the day, and
          weekly after that until it is marked done. The check runs once a day, in the morning
          Central time. Notes and the link travel with the message, so write them for your phone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-0">
        <TelegramReconnectPanel>
          <TestTelegramButton {...(sendTest ? { send: sendTest } : {})} />
        </TelegramReconnectPanel>
        <StoredState meta={meta} />
        <NewReminderForm saving={saving} onAdd={(reminder) => saveList([...reminders, reminder])} />
        <ReminderList
          reminders={reminders}
          today={today}
          saving={saving}
          onEdit={(index, row) =>
            saveList(reminders.map((current, i) => (i === index ? row : current)))
          }
          onToggleDone={(index, done) =>
            saveList(reminders.map((row, i) => (i === index ? { ...row, done } : row)))
          }
          onCancel={(index) => saveList(reminders.filter((_row, i) => i !== index))}
        />
      </CardContent>
    </Card>
  );
}

export default function RemindersTab() {
  const { authReady } = useAuthReady();
  const setting = useSetting('reminders', authReady);
  return (
    <div className="space-y-6">
      <SettingSection
        setting={setting}
        label={SETTING_LABELS.reminders}
        render={(s) => (
          <RemindersCard value={s.value} meta={s.meta} saving={s.saving} onSave={s.save} />
        )}
      />
    </div>
  );
}
