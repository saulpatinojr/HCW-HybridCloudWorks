/**
 * The right column of /admin/drafts: the front-matter fields the repository
 * drafts carry (docs/content/blog-template.md, "Front matter"), the markdown
 * body, and a live preview through the renderer the published article uses
 * (RichTextBody: react-markdown + remark-gfm + the code and embed components,
 * styled with ARTICLE_PROSE_CLASS like BlogDetailTemplate).
 *
 * An article that is In Review or further on is shown read-only: it is saved
 * from the review board now, and Back to Drafts is how it comes back here.
 */
import React, { useDeferredValue } from 'react';
import { Link } from 'react-router';
import { Loader2, Save, Send, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import RichTextBody from '@/components/shared/RichTextBody';
import TaxonomyPicker from '@/components/admin/shared/TaxonomyPicker';
import { ARTICLE_PROSE_CLASS } from '@/lib/articleStyles';
import { StageBadge } from './DraftList';
import { TRACK_SUGGESTIONS, reviewPath } from './draftForm';

const SAVE_STATE_CLASS = {
  saved: 'text-green-700 dark:text-green-300',
  new: 'text-muted-foreground',
  unsaved: 'text-amber-700 dark:text-amber-300',
  saving: 'text-muted-foreground',
  error: 'text-destructive',
};

/**
 * The note above an article that has left the Drafts stage: where it is now and
 * how to bring it back, since it is read-only here.
 */
function StageNote({ draft }) {
  if (draft.stage === 'in_review') {
    return (
      <p className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
        In Review on the Review Queue, where the provider is set and it goes on to the Publish
        Queue. It is read-only here; use <strong>Back to Drafts</strong> to edit it again.{' '}
        <Link to={reviewPath(draft.id)} className="underline">
          Open it in review
        </Link>
        .
      </p>
    );
  }
  if (draft.stage === 'live') {
    return (
      <p className="rounded-md border border-green-400 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200">
        Live on the site. A published article is never changed or deleted from Drafts.
      </p>
    );
  }
  if (draft.stage === 'past_review') {
    return (
      <p className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
        Past review ({draft.contentStatus}). It is edited from the review board now, not here.
      </p>
    );
  }
  return null;
}

function Field({ id, label, hint, children }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Save, Send to In Review, Back to Drafts and Delete, as the stage allows.
 * Delete stays visible on a live or past-review article so pressing it can
 * say why it is refused, rather than the button silently not being there.
 */
function ActionBar({ draft, dirty, busy, onSave, onSendToReview, onDelete, onBackToDrafts }) {
  const actions = draft.actions || {};
  const canSend = Boolean(draft.id && actions.sendToReview);
  const showDelete = actions.delete || draft.stage === 'live' || draft.stage === 'past_review';
  const icon = (name, Icon) =>
    busy === name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {actions.save && (
          <Button size="sm" onClick={onSave} disabled={Boolean(busy) || !dirty} className="gap-1">
            {icon('save', Save)}
            Save
          </Button>
        )}
        {canSend && (
          <Button
            size="sm"
            variant="outline"
            onClick={onSendToReview}
            disabled={Boolean(busy) || dirty}
            title={dirty ? 'Save your changes first' : undefined}
            className="gap-1"
          >
            {icon('send', Send)}
            Send to In Review
          </Button>
        )}
        {actions.backToDrafts && (
          <Button
            size="sm"
            variant="outline"
            onClick={onBackToDrafts}
            disabled={Boolean(busy)}
            className="gap-1"
          >
            {icon('back', Undo2)}
            Back to Drafts
          </Button>
        )}
        {showDelete && (
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={Boolean(busy)}
            className="gap-1 text-destructive hover:text-destructive"
          >
            {icon('delete', Trash2)}
            Delete
          </Button>
        )}
      </div>
      {canSend && dirty && (
        <p className="text-xs text-muted-foreground">
          Save your changes first; Send to In Review sends the saved version.
        </p>
      )}
    </>
  );
}

/**
 * @param {{
 *   draft: object,                 the API view, or a new draft's stand-in
 *   form: Record<string, string>,
 *   onChange: (key: string, value: string) => void,
 *   saveState: { key: string, label: string },
 *   dirty: boolean,
 *   busy: string|null,             'save' | 'send' | 'delete' | 'back' while one runs
 *   onSave: () => void,
 *   onSendToReview: () => void,
 *   onDelete: () => void,
 *   onBackToDrafts: () => void,
 * }} props
 */
export default function DraftEditor({
  draft,
  form,
  onChange,
  saveState,
  dirty,
  busy,
  onSave,
  onSendToReview,
  onDelete,
  onBackToDrafts,
}) {
  const actions = draft.actions || {};
  const readOnly = !actions.edit;
  const previewBody = useDeferredValue(form.body);
  const input = (key) => ({
    id: `draft-${key}`,
    value: form[key],
    onChange: (event) => onChange(key, event.target.value),
    disabled: readOnly,
  });

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <StageBadge stage={draft.id ? draft.stage : 'new'} />
            <span className="truncate text-sm text-muted-foreground">
              {draft.id ? `id ${draft.id}` : 'New draft'}
            </span>
          </div>
          {!readOnly && (
            <span
              role="status"
              aria-live="polite"
              data-save-state={saveState.key}
              className={`text-sm font-medium ${SAVE_STATE_CLASS[saveState.key] || ''}`}
            >
              {saveState.label}
            </span>
          )}
        </div>

        <StageNote draft={draft} />

        <ActionBar
          draft={draft}
          dirty={dirty}
          busy={busy}
          onSave={onSave}
          onSendToReview={onSendToReview}
          onDelete={onDelete}
          onBackToDrafts={onBackToDrafts}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field id="draft-title" label="Title" hint="A claim or a number, not a topic.">
              <Input {...input('title')} maxLength={300} required />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field id="draft-subtitle" label="Subtitle">
              <Input {...input('subtitle')} maxLength={500} />
            </Field>
          </div>
          <Field id="draft-date" label="Date">
            <Input {...input('date')} type="date" />
          </Field>
          <Field id="draft-track" label="Track" hint="how-to or build-log">
            <Input {...input('track')} list="draft-track-options" maxLength={40} />
            <datalist id="draft-track-options">
              {TRACK_SUGGESTIONS.map((track) => (
                <option key={track} value={track} />
              ))}
            </datalist>
          </Field>
          <Field id="draft-part" label="Part" hint="n of N">
            <Input {...input('part')} maxLength={20} />
          </Field>
          <Field id="draft-reading" label="Reading (minutes)">
            <Input {...input('reading')} type="number" min={1} max={999} step={1} />
          </Field>
          <div className="sm:col-span-2">
            <Field id="draft-tags" label="Tags" hint="Comma-separated: azure, terraform, docker">
              <Input {...input('tags')} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <TaxonomyPicker
              kind={form.kind}
              ideaOrigin={form.ideaOrigin}
              disabled={readOnly}
              onChange={(next) => {
                if (next.kind !== form.kind) onChange('kind', next.kind);
                if (next.ideaOrigin !== form.ideaOrigin) onChange('ideaOrigin', next.ideaOrigin);
              }}
            />
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Field id="draft-body" label="Body (markdown)">
            <Textarea
              {...input('body')}
              rows={28}
              spellCheck
              className="min-h-96 font-mono text-sm"
            />
          </Field>
          <section aria-label="Preview" className="space-y-1">
            <p className="text-sm font-medium">Preview</p>
            <div className="min-h-96 overflow-auto rounded-md border bg-background p-4">
              {form.title && <h1 className="mb-2 text-2xl font-bold">{form.title}</h1>}
              {form.subtitle && <p className="mb-4 text-muted-foreground">{form.subtitle}</p>}
              {previewBody.trim() ? (
                <RichTextBody value={previewBody} className={ARTICLE_PROSE_CLASS} />
              ) : (
                <p className="text-sm text-muted-foreground">The rendered article appears here.</p>
              )}
            </div>
          </section>
        </div>
      </CardContent>
    </Card>
  );
}
