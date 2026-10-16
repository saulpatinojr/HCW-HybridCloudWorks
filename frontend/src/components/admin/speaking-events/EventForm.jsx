/**
 * The override form (#573, ADR 0033 Spotlight slice). A Sessionize event
 * takes only what Sessionize does not provide; a manual entry also takes its
 * name and date. Both take the hub's own fields: status, CFP deadline,
 * audience, topic, attendance, feedback, the sessions given and the evidence
 * kept. Rendered by whichever tab is open while an edit is.
 *
 * It is a real <form>: the URL inputs validate on submit, Enter saves, and
 * Cancel goes through the editor's unsaved-changes guard.
 */

import React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Check, Loader2, Plus, Trash2, X } from 'lucide-react';
import {
  EMPTY_EVIDENCE,
  EMPTY_SESSION,
  SPEAKING_STATUSES,
  formatShortDate,
  speakingStatusInfo,
} from './eventModel';

const INPUT = 'w-full text-sm border border-border rounded-md px-3 py-1.5 bg-background';

function Field({ id, label, hint, className = 'space-y-1', children }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TextField({ id, label, type = 'text', placeholder, value, onChange, hint, min }) {
  return (
    <Field id={id} label={label} hint={hint}>
      <input
        type={type}
        className={INPUT}
        placeholder={placeholder}
        id={id}
        value={value}
        min={min}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/**
 * An override enriches a Sessionize row, so it says so only when one is attached.
 * A manual entry has none; editing an existing document without its Sessionize
 * row cannot tell which it is, so that heading stays neutral.
 */
export function formTitle(editingId, editingEvent) {
  const isNew = editingId === 'new';
  if (editingEvent) return isNew ? 'New Override' : 'Edit Override';
  return isNew ? 'New Manual Entry' : 'Edit Event';
}

function FormHeading({ editingId, editingEvent, onClose }) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <h3 className="font-semibold text-sm">{formTitle(editingId, editingEvent)}</h3>
        {editingEvent && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Sessionize #{editingEvent.id} · {editingEvent.name}
            {editingEvent.date && <> · {formatShortDate(editingEvent.date)}</>}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close editor"
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function ManualFields({ form, set }) {
  return (
    <>
      <TextField
        id="speaking-event-name"
        label="Event Name *"
        placeholder="Event name as shown on site"
        value={form._manualName || ''}
        onChange={set('_manualName')}
      />
      <TextField
        id="speaking-event-date"
        label="Date"
        type="date"
        value={form._manualDate || ''}
        onChange={set('_manualDate')}
      />
    </>
  );
}

function StatusField({ form, set }) {
  const info = speakingStatusInfo(form.status);
  return (
    <Field id="speaking-event-status" label="Status" hint={info.help}>
      <select
        id="speaking-event-status"
        className={INPUT}
        value={form.status}
        onChange={(e) => set('status')(e.target.value)}
      >
        {SPEAKING_STATUSES.map((status) => (
          <option key={status} value={status}>
            {speakingStatusInfo(status).label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function OverrideFields({ form, set }) {
  return (
    <>
      <Field
        id="speaking-event-description"
        label="Description"
        className="space-y-1 md:col-span-2"
      >
        <textarea
          rows={3}
          className={`${INPUT} resize-none`}
          placeholder="Override the Sessionize description, or add one if missing"
          id="speaking-event-description"
          value={form.description}
          onChange={(e) => set('description')(e.target.value)}
        />
      </Field>
      <StatusField form={form} set={set} />
      <TextField
        id="speaking-event-cfp"
        label="CFP deadline"
        type="date"
        value={form.cfpDeadline}
        onChange={set('cfpDeadline')}
        hint="When the call for papers closes; the Calendar reads it."
      />
      <TextField
        id="speaking-event-location"
        label="Location override"
        placeholder="e.g. Chicago, IL or Virtual"
        value={form.location}
        onChange={set('location')}
      />
      <TextField
        id="speaking-event-topic"
        label="Topic"
        placeholder="e.g. Azure landing zones"
        value={form.topic}
        onChange={set('topic')}
      />
      <TextField
        id="speaking-event-audience"
        label="Audience"
        placeholder="e.g. platform engineers, 200 seats"
        value={form.audience}
        onChange={set('audience')}
      />
      <TextField
        id="speaking-event-attendance"
        label="Attendance"
        type="number"
        min="0"
        placeholder="People in the room or on the stream"
        value={form.attendance}
        onChange={set('attendance')}
      />
      <TextField
        id="speaking-event-url"
        label="Event URL override"
        type="url"
        placeholder="https://..."
        value={form.eventUrl}
        onChange={set('eventUrl')}
      />
      <TextField
        id="speaking-event-presentation-url"
        label="Presentation URL"
        type="url"
        placeholder="https://..."
        value={form.presentationUrl}
        onChange={set('presentationUrl')}
      />
      <TextField
        id="speaking-event-image-url"
        label="Event Image URL"
        type="url"
        placeholder="https://example.com/event-image.jpg"
        value={form.eventImageUrl}
        onChange={set('eventImageUrl')}
      />
      <Field id="speaking-event-feedback" label="Feedback" className="space-y-1 md:col-span-2">
        <textarea
          rows={2}
          className={`${INPUT} resize-none`}
          placeholder="What the room said; ratings, quotes, what to change next time"
          id="speaking-event-feedback"
          value={form.feedback}
          onChange={(e) => set('feedback')(e.target.value)}
        />
      </Field>
      <div className="flex items-center gap-2 self-end">
        <input
          type="checkbox"
          id="display-toggle"
          checked={form.display}
          onChange={(e) => set('display')(e.target.checked)}
          className="h-4 w-4"
        />
        <label htmlFor="display-toggle" className="text-sm">
          Show on site
        </label>
      </div>
    </>
  );
}

/** A list of small records with add and remove; `fields` names each column. */
function ListEditor({ idPrefix, title, hint, rows, empty, fields, onChange }) {
  const update = (index, key, value) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  const remove = (index) => onChange(rows.filter((_, i) => i !== index));
  return (
    <fieldset className="md:col-span-2 space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">{title}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {rows.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      {rows.map((row, index) => (
        <div key={index} className="grid gap-2 md:grid-cols-[1fr_1fr_auto] items-end">
          {fields.map((field) => (
            <Field
              key={field.key}
              id={`${idPrefix}-${index}-${field.key}`}
              label={field.label}
              className={`space-y-1 ${field.wide ? 'md:col-span-2' : ''}`}
            >
              {field.multiline ? (
                <textarea
                  id={`${idPrefix}-${index}-${field.key}`}
                  rows={2}
                  className={`${INPUT} resize-none`}
                  value={row[field.key] || ''}
                  onChange={(e) => update(index, field.key, e.target.value)}
                />
              ) : (
                <input
                  id={`${idPrefix}-${index}-${field.key}`}
                  type={field.type || 'text'}
                  className={INPUT}
                  placeholder={field.placeholder}
                  value={row[field.key] || ''}
                  onChange={(e) => update(index, field.key, e.target.value)}
                />
              )}
            </Field>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-destructive"
            onClick={() => remove(index)}
            aria-label={`Remove ${title.toLowerCase()} ${index + 1}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={() => onChange([...rows, empty])}>
        <Plus className="h-3.5 w-3.5 mr-1" /> Add
      </Button>
    </fieldset>
  );
}

const SESSION_FIELDS = [
  { key: 'title', label: 'Session title', wide: true },
  { key: 'abstract', label: 'Abstract', wide: true, multiline: true },
  { key: 'slidesUrl', label: 'Slides URL', type: 'url', placeholder: 'https://...' },
  { key: 'videoUrl', label: 'Recording URL', type: 'url', placeholder: 'https://...' },
];

const EVIDENCE_FIELDS = [
  { key: 'label', label: 'Label', placeholder: 'Photos, attendee list, organiser email…' },
  { key: 'url', label: 'URL', type: 'url', placeholder: 'https://...' },
];

export default function EventForm({ editor }) {
  const { editingId, editingEvent, form, setForm, saving, save, requestClose, dirty } = editor;
  const isManual = !editingEvent;
  const canSave = isManual ? Boolean((form._manualName || '').trim()) : true;
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Card className="border-2 border-slate-blue/30">
      <CardContent className="pt-5">
        <form
          className="space-y-4"
          aria-label={formTitle(editingId, editingEvent)}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <FormHeading editingId={editingId} editingEvent={editingEvent} onClose={requestClose} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {isManual && <ManualFields form={form} set={set} />}
            <OverrideFields form={form} set={set} />
            <ListEditor
              idPrefix="speaking-session"
              title="Sessions"
              hint="Each talk given at this event, with its slides and recording once delivered."
              rows={form.sessions}
              empty={EMPTY_SESSION}
              fields={SESSION_FIELDS}
              onChange={set('sessions')}
            />
            <ListEditor
              idPrefix="speaking-evidence"
              title="Evidence"
              hint="Links that prove the engagement — the Ambassador hub imports them."
              rows={form.evidence}
              empty={EMPTY_EVIDENCE}
              fields={EVIDENCE_FIELDS}
              onChange={set('evidence')}
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" type="submit" disabled={Boolean(saving) || !canSave}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Check className="h-4 w-4 mr-1" />
              )}
              Save
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={requestClose}>
              Cancel
            </Button>
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
