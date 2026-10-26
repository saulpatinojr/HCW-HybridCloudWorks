import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { brainApi } from '@/lib/brainApi';
import ConfirmModal from '@/components/admin/ConfirmModal';
import DraftFromNote from './DraftFromNote';
import { useUnsavedGuard } from '../drafts/useUnsavedGuard';

export const noteFields = (item) => ({
  id: item.id,
  type: item.type,
  title: item.title,
  body: item.body || '',
  tags: item.tags || [],
  links: item.links || [],
  collections: item.collections || [],
  urls: item.urls || [],
  properties: item.properties || {},
  archived: item.archived === true,
  inbox: item.inbox !== false,
  ...(item.type === 'conflict' && { conflictOf: item.conflictOf }),
});
export function Markdown({ children }) {
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}>
        {children || '*No text yet.*'}
      </ReactMarkdown>
    </div>
  );
}
const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';
export default function NoteEditor({
  item,
  collections,
  candidates,
  backlinks,
  onSaved,
  onSelect,
  onClose,
  onDirty,
}) {
  const [form, setForm] = useState(() => noteFields(item));
  const [tagText, setTagText] = useState((item.tags || []).join(', '));
  const [version, setVersion] = useState(item.version || 0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyBefore, setHistoryBefore] = useState(null);
  const [mutation, setMutation] = useState(() => crypto.randomUUID());
  const dirty = JSON.stringify(form) !== JSON.stringify(noteFields(item));
  useEffect(() => {
    onDirty?.(dirty);
    return () => onDirty?.(false);
  }, [dirty, onDirty]);
  const leave = useUnsavedGuard(dirty);
  async function loadHistory(before = null) {
    try {
      const page = await brainApi.history(item.id, before);
      setHistory((old) => (before ? [...old, ...page.items] : page.items));
      setHistoryBefore(page.before);
    } catch (err) {
      setError(err.message);
    }
  }
  const change = (key, value) => {
    setForm((old) => ({ ...old, [key]: value }));
    setMutation(crypto.randomUUID());
  };
  async function save(next = form) {
    setBusy(true);
    setError('');
    try {
      const saved = await brainApi.save(next, version, mutation);
      setVersion(saved.item.version);
      setForm(noteFields(saved.item));
      setMutation(crypto.randomUUID());
      onSaved(saved.item);
      if (saved.indexPending)
        setError('Saved. Search indexing will catch up during reconciliation.');
    } catch (err) {
      setError(
        `${err.message} Your text is still here. Use History or save a recovery copy before loading another item.`
      );
    } finally {
      setBusy(false);
    }
  }
  async function recover() {
    setBusy(true);
    try {
      const result = await brainApi.save(
        {
          ...form,
          id: crypto.randomUUID(),
          type: 'conflict',
          conflictOf: item.id,
          title: `Recovery: ${form.title}`,
          archived: false,
        },
        0,
        crypto.randomUUID()
      );
      onSaved(result.item);
      setError('Recovery copy saved. Your original item remains unchanged.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const dismiss = onClose;
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5" aria-label="Note editor">
      <ConfirmModal
        open={leave.leaving}
        title="Leave this note?"
        description="Your changes have not been saved."
        confirmLabel="Leave without saving"
        onConfirm={leave.confirmLeave}
        onCancel={leave.cancelLeave}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          {form.type} · Version {version}
          {dirty ? ' · Unsaved changes' : ''}
        </span>
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Close
        </Button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-amber-500/40 p-3 text-sm">
          {error}
        </p>
      )}
      <label className="block space-y-1 text-sm">
        <span>Title</span>
        <input
          className={inputClass}
          maxLength={300}
          value={form.title}
          onChange={(e) => change('title', e.target.value)}
        />
      </label>
      {/\[\[|%%|```(?:dataview|tasks|query)/i.test(form.body) && (
        <p className="rounded-lg border p-3 text-sm text-muted-foreground">
          Obsidian-specific markup is preserved. Use linked items below to navigate connections in
          HCW.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={!preview ? 'default' : 'outline'}
          onClick={() => setPreview(false)}
        >
          Write
        </Button>
        <Button
          size="sm"
          variant={preview ? 'default' : 'outline'}
          onClick={() => setPreview(true)}
        >
          Preview
        </Button>
      </div>
      {preview ? (
        <Markdown>{form.body}</Markdown>
      ) : (
        <label className="block space-y-1 text-sm">
          <span>Markdown</span>
          <textarea
            className={`${inputClass} min-h-72 font-mono`}
            value={form.body}
            onChange={(e) => change('body', e.target.value)}
          />
        </label>
      )}
      <label className="block space-y-1 text-sm">
        <span>Tags, separated by commas</span>
        <input
          className={inputClass}
          value={tagText}
          onChange={(e) => {
            setTagText(e.target.value);
            change(
              'tags',
              e.target.value
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            );
          }}
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Source URLs, one per line</span>
        <textarea
          className={inputClass}
          value={form.urls.join('\n')}
          onChange={(e) =>
            change(
              'urls',
              e.target.value
                .split('\n')
                .map((t) => t.trim())
                .filter(Boolean)
            )
          }
        />
      </label>
      <fieldset className="space-y-2 rounded-lg border p-3">
        <legend className="px-1 text-sm">Topics & projects</legend>
        {collections
          .filter((c) => c.id !== item.id && !c.archived)
          .map((c) => (
            <label className="mr-4 inline-flex items-center gap-2 text-sm" key={c.id}>
              <input
                type="checkbox"
                checked={form.collections.includes(c.id)}
                onChange={(e) =>
                  change(
                    'collections',
                    e.target.checked
                      ? [...form.collections, c.id]
                      : form.collections.filter((id) => id !== c.id)
                  )
                }
              />
              {c.title}
            </label>
          ))}
        {!collections.length && (
          <p className="text-sm text-muted-foreground">
            Create a topic or project to group your work.
          </p>
        )}
      </fieldset>
      <label className="block space-y-1 text-sm">
        <span>Link a note or content item from the loaded library</span>
        <select
          className={inputClass}
          value=""
          onChange={(e) => {
            if (e.target.value && !form.links.includes(e.target.value))
              change('links', [...form.links, e.target.value]);
          }}
        >
          <option value="">Choose an item…</option>
          {candidates
            .filter((c) => c.id !== item.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
        </select>
      </label>
      <ul className="space-y-1">
        {form.links.map((id) => (
          <li key={id} className="flex items-center gap-3 text-sm">
            <button type="button" className="underline" onClick={() => onSelect(id)}>
              {candidates.find((c) => c.id === id)?.title || id}
            </button>
            <button
              type="button"
              aria-label={`Remove link ${id}`}
              onClick={() =>
                change(
                  'links',
                  form.links.filter((v) => v !== id)
                )
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.inbox}
          onChange={(e) => change('inbox', e.target.checked)}
        />
        Keep in Inbox
      </label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => save()}>
          {busy ? 'Working…' : 'Save note'}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => save({ ...form, archived: !form.archived })}
        >
          {form.archived ? 'Restore' : 'Archive'}
        </Button>
        <Button variant="outline" disabled={busy} onClick={recover}>
          Save recovery copy
        </Button>
        <Button variant="outline" disabled={busy || !version} onClick={() => loadHistory()}>
          History
        </Button>
      </div>
      <div aria-live="polite">
        {historyBefore && (
          <Button variant="outline" size="sm" onClick={() => loadHistory(historyBefore)}>
            Older versions
          </Button>
        )}
        {history.map((entry) => (
          <details className="rounded-lg border p-3" key={entry.id}>
            <summary className="cursor-pointer text-sm">
              Version {entry.result.version} · {new Date(entry.result.updatedAt).toLocaleString()}
            </summary>
            <Markdown>{entry.result.body}</Markdown>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setForm(noteFields(entry.result));
                setTagText((entry.result.tags || []).join(', '));
                setMutation(crypto.randomUUID());
              }}
            >
              Load into editor for review
            </Button>
          </details>
        ))}
      </div>
      <div>
        <h3 className="text-sm font-semibold">Linked from</h3>
        <ul>
          {backlinks.map((n) => (
            <li key={n.id}>
              <button type="button" className="text-sm underline" onClick={() => onSelect(n.id)}>
                {n.title}
              </button>
            </li>
          ))}
        </ul>
        {!backlinks.length && <p className="text-sm text-muted-foreground">No backlinks yet.</p>}
      </div>
      {form.type !== 'topic' && form.type !== 'project' && !form.archived && (
        <DraftFromNote item={item} form={form} version={version} dirty={dirty} />
      )}
    </section>
  );
}
