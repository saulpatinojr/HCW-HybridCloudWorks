/**
 * Small pieces more than one Ambassador tab renders (ADR 0033 §4): labelled
 * inputs with inline errors, a label+URL list editor, the readiness panel,
 * the reads' loading and error lines, and a date in words.
 */
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Check, Copy, Plus, Trash2 } from 'lucide-react';
import { TabError, TabLoading } from '@/components/admin/integrations/TabNotice';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { daysUntil, MEMBERSHIP_STATUS, sourceLabel, todayIso } from './ambassadorModel';

export const INPUT =
  'min-w-0 w-full text-sm border border-border rounded-md px-3 py-1.5 bg-background';

export function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-rose-600">
      {message}
    </p>
  );
}

export function Field({ id, label, hint, error, className = '', children }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  error,
  className,
  min,
  max,
}) {
  return (
    <Field id={id} label={label} hint={hint} error={error} className={className}>
      <Input
        id={id}
        type={type}
        min={min}
        max={max}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
    </Field>
  );
}

export function TextAreaField({
  id,
  label,
  value,
  onChange,
  rows = 3,
  placeholder,
  hint,
  error,
  className,
  maxLength,
}) {
  const { length } = String(value || '');
  return (
    <Field
      id={id}
      label={label}
      hint={
        maxLength
          ? `${length.toLocaleString()} / ${maxLength.toLocaleString()} characters${hint ? ` · ${hint}` : ''}`
          : hint
      }
      error={error}
      className={className}
    >
      <Textarea
        id={id}
        rows={rows}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
    </Field>
  );
}

export function SelectField({ id, label, value, onChange, options, hint, error, className }) {
  return (
    <Field id={id} label={label} hint={hint} error={error} className={className}>
      <select
        id={id}
        className={INPUT}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error) || undefined}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Rows of `{ label, url }`, with add and remove. `errors` is keyed `${idPrefix}.${index}`. */
export function LinkList({ idPrefix, title, hint, rows, onChange, errors = {} }) {
  const update = (index, key, value) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-medium">{title}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {rows.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      {rows.map((row, index) => (
        <div
          key={index}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
        >
          <TextField
            id={`${idPrefix}-${index}-label`}
            className="col-span-2 sm:col-span-1"
            label="Label"
            value={row.label}
            onChange={(v) => update(index, 'label', v)}
          />
          <TextField
            id={`${idPrefix}-${index}-url`}
            label="URL"
            type="url"
            placeholder="https://..."
            value={row.url}
            onChange={(v) => update(index, 'url', v)}
            error={errors[`${idPrefix}.${index}`]}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mt-5 h-8 px-2 text-destructive"
            aria-label={`Remove ${title.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...rows, { label: '', url: '' }])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" /> Add {title.toLowerCase()}
      </Button>
    </fieldset>
  );
}

/**
 * Puts `value` on the clipboard. Where the clipboard is unavailable (an
 * insecure origin, a refused permission) the button says so, so the text can
 * be selected by hand instead. `label` is the accessible name; the visible
 * text is `children`, "Copy" by default.
 */
export function CopyButton({ value, label, disabled = false, children = 'Copy', className = '' }) {
  const [state, setState] = useState('idle');
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('No clipboard');
      await navigator.clipboard.writeText(String(value ?? ''));
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  const text = { idle: children, copied: 'Copied', failed: 'Copy failed' }[state];
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={`h-7 gap-1 px-2 text-xs ${className}`}
      onClick={copy}
      disabled={disabled}
      aria-label={label}
      title={
        state === 'failed'
          ? 'The clipboard is not available here; select the text instead.'
          : undefined
      }
    >
      {state === 'copied' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {text}
    </Button>
  );
}

/**
 * "Counts for": checkboxes over the programs an import's rows should name;
 * none ticked means the rows count for every program. Shared by the import
 * dialogs so the wording and the toggle are written once.
 */
export function ProgramsFieldset({ programs, value, onChange }) {
  const toggle = (id) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium">Counts for</legend>
      <p className="text-xs text-muted-foreground">Leave clear to count for every program.</p>
      <div className="flex flex-wrap gap-2">
        {programs.map((p) => (
          <label key={p.id} className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={value.includes(p.id)} onChange={() => toggle(p.id)} />
            {p.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Checkboxes over the evidence sources. */
export function SourcePicker({ idPrefix, value, onChange, sources }) {
  const toggle = (source) =>
    onChange(value.includes(source) ? value.filter((s) => s !== source) : [...value, source]);
  return (
    <div className="flex flex-wrap gap-2">
      {sources.map((source) => (
        <label key={source} className="flex items-center gap-1.5 text-xs">
          <input
            id={`${idPrefix}-${source}`}
            type="checkbox"
            checked={value.includes(source)}
            onChange={() => toggle(source)}
          />
          {sourceLabel(source)}
        </label>
      ))}
    </div>
  );
}

/** The loading line or the error panel for a set of reads, or null once all landed. */
export function ReadsStatus({ reads, label }) {
  const failed = reads.filter((read) => read.error);
  if (failed.length > 0) {
    return (
      <div className="space-y-2">
        {failed.map((read, index) => (
          <TabError key={`${index}-${read.error}`} message={read.error} onRetry={read.refresh} />
        ))}
      </div>
    );
  }
  if (reads.some((read) => read.loading)) return <TabLoading>Loading {label}…</TabLoading>;
  return null;
}

export const allLanded = (reads) => reads.every((read) => read.loaded && !read.error);

/** A calendar day in words with how far off it is: "15 Jan 2027 · in 104 days". */
export function whenText(day, today = todayIso()) {
  if (!day) return 'No date';
  const left = daysUntil(day, today);
  const [y, m, d] = day.split('-').map(Number);
  const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  if (left === null) return label;
  if (left === 0) return `${label} · today`;
  if (left > 0) return `${label} · in ${left} day${left === 1 ? '' : 's'}`;
  return `${label} · ${-left} day${left === -1 ? '' : 's'} ago`;
}

/**
 * The readiness panel: the score, the sentence that explains it, each
 * requirement met or not with its count, and what is missing. Says in its
 * own words that acceptance is the program's decision.
 */
export function ReadinessPanel({ readiness, compact = false }) {
  if (!readiness) return null;
  return (
    <div className="space-y-3" aria-label="Readiness">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-3xl font-bold tabular-nums">{readiness.score}%</span>
        <StatusBadge
          status={{
            id: readiness.score >= 100 ? 'ready' : 'in-progress',
            label: readiness.score >= 100 ? 'All requirements met' : 'Requirements open',
            tone: readiness.score >= 100 ? 'ok' : 'warn',
            help: readiness.explanation,
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{readiness.explanation}</p>
      {readiness.gate?.gated && !readiness.gate.unlocked && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="readiness-gate">
          Additional to {readiness.gate.parent?.name || 'another program'}: opens when that
          membership is Active (now{' '}
          {MEMBERSHIP_STATUS[readiness.gate.parent?.membershipStatus]?.label || 'None'}).
        </p>
      )}
      <ul className="space-y-1.5">
        {readiness.requirements.map((req) => (
          <li key={req.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2">
              <StatusBadge
                size="xs"
                status={{
                  id: req.met ? 'met' : 'open',
                  label: req.met ? 'Met' : 'Open',
                  tone: req.met ? 'ok' : 'warn',
                  help: `${req.count} of ${req.minCount} needed (weight ${req.weight})`,
                }}
              />
              {req.label}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {req.count} / {req.minCount}
            </span>
          </li>
        ))}
      </ul>
      {!compact && readiness.expiring?.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {readiness.expiring.length} evidence item{readiness.expiring.length === 1 ? '' : 's'} will
          leave the twelve-month window within sixty days.
        </p>
      )}
    </div>
  );
}
