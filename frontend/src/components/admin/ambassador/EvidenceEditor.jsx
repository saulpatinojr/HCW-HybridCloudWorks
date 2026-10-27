/**
 * Add or edit one evidence item by hand (ADR 0033 §4): what happened, when,
 * where it can be seen, which programs it counts for, its reach, and whether
 * it has been verified. Imported items are edited here too; their snapshot
 * (what the source said at import) is shown but not editable.
 */
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { EVIDENCE_SOURCES, sourceLabel } from './ambassadorModel';
import { Field, LinkList, SelectField, TextAreaField, TextField } from './Parts';

const isHttpUrl = (value) => /^https?:\/\/\S+$/i.test(String(value || '').trim());

/** The reach numbers as the form holds them: each as typed, or empty when unset. */
const metricsForm = (metrics) => ({
  reach: metrics?.reach ?? '',
  attendees: metrics?.attendees ?? '',
  views: metrics?.views ?? '',
  credits: metrics?.credits ?? '',
});

export function evidenceForm(item) {
  const e = item || {};
  return {
    title: e.title || '',
    description: e.description || '',
    date: e.date || '',
    sourceModule: e.sourceModule || 'manual',
    url: e.url || '',
    technology: (e.technology || []).join(', '),
    tags: (e.tags || []).join(', '),
    programIds: e.programIds || [],
    verificationStatus: e.verificationStatus || 'unverified',
    metrics: metricsForm(e.metrics),
    links: (e.files || []).map((f) => ({ label: f.name || '', url: f.url || '' })),
    notes: e.notes || '',
  };
}

export function validateEvidenceForm(form) {
  const errors = {};
  if (!form.title.trim()) errors.title = 'Title is required.';
  if (!form.date) errors.date = 'Date is required.';
  if (form.url.trim() && !isHttpUrl(form.url)) errors.url = 'Must start with http:// or https://.';
  form.links.forEach((l, index) => {
    if (l.url.trim() && !isHttpUrl(l.url))
      errors[`evidence-link.${index}`] = 'Must start with http:// or https://.';
  });
  return errors;
}

const list = (text) =>
  String(text || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
const num = (v) =>
  v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

export function evidencePayload(form) {
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    date: form.date,
    sourceModule: form.sourceModule,
    url: form.url.trim() || null,
    technology: list(form.technology),
    tags: list(form.tags),
    programIds: form.programIds,
    verificationStatus: form.verificationStatus,
    metrics: {
      reach: num(form.metrics.reach),
      attendees: num(form.metrics.attendees),
      views: num(form.metrics.views),
      credits: num(form.metrics.credits),
    },
    files: form.links
      .filter((l) => isHttpUrl(l.url))
      .map((l) => ({
        name: l.label.trim() || l.url.trim(),
        url: l.url.trim(),
        bytes: null,
        uploadedAt: null,
      })),
    notes: form.notes.trim(),
  };
}

/**
 * @param {object} props
 * @param {object|null} props.item the evidence to edit, or null for a new one
 * @param {object} [props.prefill] for a new item, the fields to start from (the guide's Add
 *   opens the editor on the source and program that would count)
 */
export default function EvidenceEditor({ item, prefill, programs, onClose, onSave, saving }) {
  const [form, setForm] = useState(() => evidenceForm(item || prefill));
  const [errors, setErrors] = useState({});
  const set = (key) => (value) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };
  const isNew = !item?.id;
  const imported = Boolean(item?.sourceId);

  const submit = async (event) => {
    event.preventDefault();
    const next = validateEvidenceForm(form);
    setErrors(next);
    if (Object.keys(next).length) return;
    const payload = evidencePayload(form);
    // The source is fixed by the import; a hand-made item keeps whatever was chosen.
    if (imported) delete payload.sourceModule;
    if (await onSave(payload)) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="w-[calc(100%-2rem)] min-w-0 [&>*]:min-w-0 max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form className="space-y-4" noValidate onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{isNew ? 'Add evidence' : 'Edit evidence'}</DialogTitle>
            <DialogDescription>
              Something that happened and can be shown. Evidence naming no program counts for every
              program.
            </DialogDescription>
          </DialogHeader>
          {imported && item.snapshot && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Imported from {sourceLabel(item.sourceModule)} on{' '}
              {item.snapshot.capturedAt?.slice(0, 10)}: “{item.snapshot.title}”{' '}
              {item.snapshot.date ? `(${item.snapshot.date})` : ''}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              id="evidence-title"
              label="Title *"
              value={form.title}
              onChange={set('title')}
              error={errors.title}
              className="md:col-span-2"
            />
            <TextField
              id="evidence-date"
              label="Date *"
              type="date"
              value={form.date}
              onChange={set('date')}
              error={errors.date}
            />
            <SelectField
              id="evidence-source"
              label="Source"
              value={form.sourceModule}
              onChange={set('sourceModule')}
              options={EVIDENCE_SOURCES.map((s) => ({ value: s, label: sourceLabel(s) }))}
              hint={imported ? 'Fixed by the import.' : undefined}
            />
            <TextField
              id="evidence-url"
              label="URL"
              type="url"
              placeholder="https://..."
              value={form.url}
              onChange={set('url')}
              error={errors.url}
              className="md:col-span-2"
            />
            <TextAreaField
              id="evidence-description"
              label="Description"
              value={form.description}
              onChange={set('description')}
              className="md:col-span-2"
            />
            <TextField
              id="evidence-technology"
              label="Technology"
              placeholder="Azure, Terraform (comma separated)"
              value={form.technology}
              onChange={set('technology')}
            />
            <TextField
              id="evidence-tags"
              label="Tags"
              placeholder="keynote, workshop (comma separated)"
              value={form.tags}
              onChange={set('tags')}
            />
            <TextField
              id="evidence-reach"
              label="Reach"
              type="number"
              min="0"
              value={form.metrics.reach}
              onChange={(v) => setForm((f) => ({ ...f, metrics: { ...f.metrics, reach: v } }))}
            />
            <TextField
              id="evidence-attendees"
              label="Attendees"
              type="number"
              min="0"
              value={form.metrics.attendees}
              onChange={(v) => setForm((f) => ({ ...f, metrics: { ...f.metrics, attendees: v } }))}
            />
            <TextField
              id="evidence-views"
              label="Views"
              type="number"
              min="0"
              value={form.metrics.views}
              onChange={(v) => setForm((f) => ({ ...f, metrics: { ...f.metrics, views: v } }))}
            />
            <TextField
              id="evidence-credits"
              label="Credits"
              type="number"
              min="0"
              value={form.metrics.credits}
              onChange={(v) => setForm((f) => ({ ...f, metrics: { ...f.metrics, credits: v } }))}
              hint="For a program scored in credits; readiness sums them."
            />
            <SelectField
              id="evidence-verification"
              label="Verification"
              value={form.verificationStatus}
              onChange={set('verificationStatus')}
              options={[
                { value: 'unverified', label: 'Unverified' },
                { value: 'verified', label: 'Verified' },
              ]}
              hint="Verified means a reviewer could confirm it from the URL or files."
            />
            <Field
              id="evidence-programs"
              label="Counts for"
              className="md:col-span-2"
              hint="Leave every box clear to count for all programs."
            >
              <div className="flex flex-wrap gap-2">
                {programs.map((p) => (
                  <label key={p.id} className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={form.programIds.includes(p.id)}
                      onChange={() =>
                        set('programIds')(
                          form.programIds.includes(p.id)
                            ? form.programIds.filter((id) => id !== p.id)
                            : [...form.programIds, p.id]
                        )
                      }
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </Field>
            <div className="md:col-span-2">
              <LinkList
                idPrefix="evidence-link"
                title="Files"
                hint="Links to recordings, photos, decks."
                rows={form.links}
                onChange={set('links')}
                errors={errors}
              />
            </div>
            <TextAreaField
              id="evidence-notes"
              label="Notes"
              value={form.notes}
              onChange={set('notes')}
              className="md:col-span-2"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isNew ? 'Add' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
