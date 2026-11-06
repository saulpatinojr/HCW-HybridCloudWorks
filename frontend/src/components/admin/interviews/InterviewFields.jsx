/**
 * The form fields of the admin interview pages (ADR 0040, D7, D8 and D9):
 * the guest's details, the consent box, the source of the interview and the
 * optional photo. Each field is labelled, says what is wrong beside itself,
 * and points at that sentence with `aria-describedby`, so a screen reader
 * reads the problem with the field.
 */
import React, { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { CONSENT_WORDING_V1, LIMITS, todayUtc } from './interviewModel';

/** A label, the control, an optional hint and the field's problem. */
export function Field({ label, hint, problem, children }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  const describedBy = [hint ? hintId : '', problem ? problemId : ''].filter(Boolean).join(' ');
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy: describedBy || undefined, invalid: Boolean(problem) })}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {problem && (
        <p id={problemId} className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
    </div>
  );
}

/** One text control bound to `form[name]`. */
function TextField({ form, onChange, problems, name, label, hint, multiline, type, maxLength }) {
  const Control = multiline ? Textarea : Input;
  return (
    <Field label={label} hint={hint} problem={problems[name]}>
      {({ id, describedBy, invalid }) => (
        <Control
          id={id}
          type={multiline ? undefined : type || 'text'}
          value={form[name] ?? ''}
          maxLength={maxLength}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange({ [name]: event.target.value })}
        />
      )}
    </Field>
  );
}

/** Title, subtitle, date, the guest's name and role, the bio and the tags. */
export function DetailsFields({ form, onChange, problems = {} }) {
  const shared = { form, onChange, problems };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <TextField {...shared} name="guestName" label="Guest’s name" maxLength={LIMITS.MAX_SHORT} />
      <TextField
        {...shared}
        name="guestRole"
        label="Guest’s role (optional)"
        hint="For example: Cloud architect at a retailer."
        maxLength={LIMITS.MAX_SHORT}
      />
      <TextField {...shared} name="title" label="Title" maxLength={LIMITS.MAX_TITLE} />
      <TextField
        {...shared}
        name="subtitle"
        label="Subtitle (optional)"
        maxLength={LIMITS.MAX_SHORT}
      />
      <TextField {...shared} name="date" label="Interview date" type="date" />
      <TextField
        {...shared}
        name="tags"
        label="Tags (optional)"
        hint="Separated by commas, for example: azure, landing zones."
      />
      <div className="md:col-span-2">
        <TextField
          {...shared}
          name="bio"
          label="Guest’s bio (optional)"
          multiline
          maxLength={LIMITS.MAX_ANSWER}
        />
      </div>
    </div>
  );
}

/** The required consent box, with the fixed sentence and the date the guest agreed. */
export function ConsentField({ form, onChange, problem }) {
  const id = useId();
  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <legend className="px-1 text-sm font-semibold">The guest’s agreement (required)</legend>
      <div className="flex items-start gap-3">
        <input
          id={`${id}-box`}
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={Boolean(form.consentConfirmed)}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(event) => onChange({ consentConfirmed: event.target.checked })}
        />
        <label htmlFor={`${id}-box`} className="text-sm">
          {CONSENT_WORDING_V1}
        </label>
      </div>
      <div className="max-w-xs space-y-1">
        <label htmlFor={`${id}-date`} className="text-sm font-medium">
          Date the guest agreed
        </label>
        <Input
          id={`${id}-date`}
          type="date"
          max={todayUtc()}
          value={form.consentDate || ''}
          onChange={(event) => onChange({ consentDate: event.target.value })}
        />
      </div>
      {problem && (
        <p id={`${id}-problem`} className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Your name is recorded as the person who confirmed it. The record is never shown on the site.
      </p>
    </fieldset>
  );
}

/** The optional guest photo and its description. */
export function PhotoField({ form, onChange, photo, onPhoto, problems = {} }) {
  const id = useId();
  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <legend className="px-1 text-sm font-semibold">Guest photo (optional)</legend>
      <div className="space-y-1">
        <label htmlFor={`${id}-file`} className="text-sm font-medium">
          Photo file
        </label>
        <input
          id={`${id}-file`}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          className="block w-full text-sm"
          aria-invalid={problems.photo ? true : undefined}
          aria-describedby={problems.photo ? `${id}-photo-problem` : undefined}
          onChange={(event) => onPhoto(event.target.files?.[0] || null)}
        />
        {problems.photo && (
          <p id={`${id}-photo-problem`} className="text-sm text-red-700 dark:text-red-400">
            {problems.photo}
          </p>
        )}
      </div>
      {photo && (
        <TextField
          form={form}
          onChange={onChange}
          problems={problems}
          name="photoAlt"
          label="What the photo shows"
          hint="A few words for people who cannot see it, for example: Jane Doe smiling on a stage."
          maxLength={LIMITS.MAX_SHORT}
        />
      )}
    </fieldset>
  );
}
