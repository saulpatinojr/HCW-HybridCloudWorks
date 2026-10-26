/**
 * The form that adds a calendar alert or edits one. Used by the Calendar
 * Alerts page; the pop-up does not edit.
 *
 * It checks what the server checks, in the same words where it can, so a typo
 * is named beside its field before the round trip; the server still refuses
 * anything this lets through, and its sentence is shown if it does. The day is
 * a UTC day and the time is UTC (the labels say so), because the server and
 * the daily pop-up both count days in UTC.
 */
import React, { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { safeAlertLink } from '@/lib/calendarAlerts';

export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTE_LENGTH = 500;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The fields as the form holds them, from an alert or from nothing. */
export function initialFields(alert, today) {
  return {
    title: alert?.title ?? '',
    dueDate: alert?.dueDate ?? today ?? '',
    dueTime: alert?.dueTime ?? '',
    link: alert?.link ?? '',
    note: alert?.note ?? '',
  };
}

/** What is wrong with the fields, by field name; empty when nothing is. */
export function fieldProblems(fields) {
  const problems = {};
  const title = fields.title.trim();
  if (!title) problems.title = 'Give the alert a title.';
  else if (title.length > MAX_TITLE_LENGTH) {
    problems.title = `The title is longer than ${MAX_TITLE_LENGTH} characters.`;
  }
  if (!DAY.test(fields.dueDate)) problems.dueDate = 'Choose the day the alert is due.';
  const link = fields.link.trim();
  if (link && !safeAlertLink(link)) {
    problems.link =
      'Use a web address that starts with https://, or a page in this portal such as /admin/health.';
  }
  if (fields.note.trim().length > MAX_NOTE_LENGTH) {
    problems.note = `The note is longer than ${MAX_NOTE_LENGTH} characters.`;
  }
  return problems;
}

/** The request body: blank optional fields are sent empty so editing can clear them. */
export const toPayload = (fields) => ({
  title: fields.title.trim(),
  dueDate: fields.dueDate,
  dueTime: fields.dueTime || null,
  link: fields.link.trim(),
  note: fields.note.trim(),
});

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );
}

/**
 * @param {{
 *   alert?: object | null,
 *   today: string | null,
 *   onSubmit: (payload: object) => Promise<unknown>,
 *   onCancel: () => void,
 * }} props `onSubmit` rejects with the server's sentence; the form shows it
 */
export default function AlertForm({ alert = null, today, onSubmit, onCancel }) {
  const uid = useId();
  const [fields, setFields] = useState(() => initialFields(alert, today));
  const [problems, setProblems] = useState({});
  const [serverError, setServerError] = useState('');
  const [saving, setSaving] = useState(false);
  const editing = Boolean(alert);
  const idleLabel = editing ? 'Save changes' : 'Add alert';
  const submitLabel = saving ? 'Saving…' : idleLabel;

  const set = (name) => (event) => {
    setFields((current) => ({ ...current, [name]: event.target.value }));
  };
  const id = (name) => `${uid}-${name}`;

  async function submit(event) {
    event.preventDefault();
    const found = fieldProblems(fields);
    setProblems(found);
    setServerError('');
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      await onSubmit(toPayload(fields));
    } catch (error) {
      setServerError(error?.message || 'The alert could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={editing ? 'Edit alert' : 'Add alert'}
      className="space-y-4 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="text-base font-semibold">{editing ? 'Edit alert' : 'Add an alert'}</h2>

      <div className="space-y-1.5">
        <Label htmlFor={id('title')}>Title</Label>
        <Input
          id={id('title')}
          value={fields.title}
          onChange={set('title')}
          maxLength={MAX_TITLE_LENGTH + 50}
          required
          aria-invalid={Boolean(problems.title)}
          aria-describedby={problems.title ? id('title-error') : undefined}
        />
        <FieldError id={id('title-error')} message={problems.title} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={id('date')}>Due date (UTC day)</Label>
          <Input
            id={id('date')}
            type="date"
            value={fields.dueDate}
            onChange={set('dueDate')}
            required
            aria-invalid={Boolean(problems.dueDate)}
            aria-describedby={problems.dueDate ? id('date-error') : undefined}
          />
          <FieldError id={id('date-error')} message={problems.dueDate} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id('time')}>Time (optional, UTC)</Label>
          <Input id={id('time')} type="time" value={fields.dueTime} onChange={set('dueTime')} />
          <p className="text-xs text-muted-foreground">Leave empty for an all-day alert.</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={id('link')}>Link (optional)</Label>
        <Input
          id={id('link')}
          value={fields.link}
          onChange={set('link')}
          inputMode="url"
          autoComplete="off"
          aria-invalid={Boolean(problems.link)}
          aria-describedby={`${id('link-hint')}${problems.link ? ` ${id('link-error')}` : ''}`}
        />
        <p id={id('link-hint')} className="text-xs text-muted-foreground">
          A web address starting with https://, or a page in this portal such as /admin/health.
        </p>
        <FieldError id={id('link-error')} message={problems.link} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={id('note')}>Note (optional)</Label>
        <Textarea
          id={id('note')}
          value={fields.note}
          onChange={set('note')}
          rows={3}
          aria-invalid={Boolean(problems.note)}
          aria-describedby={`${id('note-count')}${problems.note ? ` ${id('note-error')}` : ''}`}
        />
        <p id={id('note-count')} className="text-xs text-muted-foreground">
          {fields.note.length} of {MAX_NOTE_LENGTH} characters. Keep it short; do not put passwords
          or keys in it.
        </p>
        <FieldError id={id('note-error')} message={problems.note} />
      </div>

      {serverError && (
        <p role="alert" className="text-sm text-destructive">
          {serverError}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving}>
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
