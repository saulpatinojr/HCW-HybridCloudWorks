/**
 * "Paste a document" and "Edit": one form for both. Title, category, tags, an
 * optional link and the text, which can be plain text or markdown and up to
 * 256 KB. Pasting a document whose title and category are already in the vault
 * does not make a second copy: it becomes that document's newest version, and
 * the form says so before the owner presses Add.
 */
import React from 'react';
import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  CATEGORIES,
  KEPT_VERSIONS,
  MAX_BODY_BYTES,
  MAX_TAGS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
  byteLength,
  formatBytes,
} from './docVaultModel';

const SELECT_CLASS =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

function Field({ id, label, hint, children }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * @param {{
 *   mode: 'paste'|'edit',
 *   form: { title: string, category: string, tags: string, body: string, relatedLink: string },
 *   onChange: (field: string, value: string) => void,
 *   onSubmit: () => void,
 *   onCancel: () => void,
 *   busy: boolean,
 *   dirty: boolean,
 *   problem: string|null,
 * }} props
 */
export default function DocForm({
  mode,
  form,
  onChange,
  onSubmit,
  onCancel,
  busy,
  dirty,
  problem,
}) {
  const editing = mode === 'edit';
  const bytes = byteLength(form.body);
  const over = bytes > MAX_BODY_BYTES;
  const field = (name) => (event) => onChange(name, event.target.value);

  return (
    <Card aria-labelledby="doc-form-heading" role="region">
      <CardHeader className="pb-3">
        <CardTitle id="doc-form-heading" className="text-base">
          {editing ? 'Edit this document' : 'Paste a document'}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {editing
            ? `Saving keeps the text it replaces in History (the newest ${KEPT_VERSIONS} versions are kept).`
            : 'If a document with the same title and category is already in the vault, this becomes its newest version instead of a second copy, and the earlier text stays in History.'}
        </p>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="grid gap-4 md:grid-cols-[1fr_12rem]">
            <Field id="doc-form-title" label="Title">
              <Input
                id="doc-form-title"
                value={form.title}
                onChange={field('title')}
                maxLength={MAX_TITLE_CHARS}
                required
                autoComplete="off"
              />
            </Field>
            <Field id="doc-form-category" label="Category">
              <select
                id="doc-form-category"
                className={SELECT_CLASS}
                value={form.category}
                onChange={field('category')}
              >
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              id="doc-form-tags"
              label="Tags (optional)"
              hint={`Separate with commas. Up to ${MAX_TAGS}, each up to ${MAX_TAG_CHARS} characters.`}
            >
              <Input
                id="doc-form-tags"
                value={form.tags}
                onChange={field('tags')}
                aria-describedby="doc-form-tags-hint"
                autoComplete="off"
              />
            </Field>
            <Field
              id="doc-form-link"
              label="Related link (optional)"
              hint="An https address, or a page of this admin that starts with /admin/."
            >
              <Input
                id="doc-form-link"
                value={form.relatedLink}
                onChange={field('relatedLink')}
                aria-describedby="doc-form-link-hint"
                inputMode="url"
                autoComplete="off"
              />
            </Field>
          </div>
          <Field
            id="doc-form-body"
            label="Text"
            hint="Plain text or markdown. It is shown exactly as written, never turned into a web page."
          >
            <Textarea
              id="doc-form-body"
              value={form.body}
              onChange={field('body')}
              rows={16}
              spellCheck={false}
              className="font-mono text-sm"
              aria-describedby="doc-form-body-hint doc-form-body-size"
            />
            <p
              id="doc-form-body-size"
              className={`text-xs ${over ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {formatBytes(bytes)} of {MAX_BODY_BYTES / 1024} KB
            </p>
          </Field>

          {dirty && problem && (
            <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
              {problem}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !dirty || Boolean(problem)} className="gap-1">
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" aria-hidden="true" />
              )}
              {editing ? 'Save changes' : 'Add to the vault'}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
