/**
 * The note editor's fields and lists, one component each. They lived inside
 * NoteEditor.jsx until it grew too long to follow; the editor keeps the
 * state and passes each part what it shows and how to change it.
 */
import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';

export const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

export function Markdown({ children }) {
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}>
        {children || '*No text yet.*'}
      </ReactMarkdown>
    </div>
  );
}

/** Splits text on `separator` and keeps the non-empty, trimmed parts. */
const splitList = (text, separator) =>
  text
    .split(separator)
    .map((t) => t.trim())
    .filter(Boolean);

export function HeadingField({ heading, invalid, helpId, onChange }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>Short heading (1–4 words)</span>
      <input
        className={inputClass}
        maxLength={80}
        value={heading}
        aria-label="Short heading (1–4 words)"
        aria-describedby={helpId}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
      />
      <span id={helpId} className="block text-xs text-muted-foreground">
        Used on the map and synced as the Markdown heading property.
      </span>
      {invalid && <span className="block text-xs text-destructive">Use 1–4 words.</span>}
    </label>
  );
}

/** The Write / Preview switch and the body, as Markdown text or rendered. */
export function BodyField({ body, onChange }) {
  const [preview, setPreview] = useState(false);
  return (
    <>
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
        <Markdown>{body}</Markdown>
      ) : (
        <label className="block space-y-1 text-sm">
          <span>Markdown</span>
          <textarea
            className={`${inputClass} min-h-72 font-mono`}
            value={body}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      )}
    </>
  );
}

/** Tags as comma-separated text; the editor keeps the text and the list. */
export function TagsField({ tagText, onText, onTags }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>Tags, separated by commas</span>
      <input
        className={inputClass}
        value={tagText}
        onChange={(e) => {
          onText(e.target.value);
          onTags(splitList(e.target.value, ','));
        }}
      />
    </label>
  );
}

export function UrlsField({ urls, onChange }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>Source URLs, one per line</span>
      <textarea
        className={inputClass}
        value={urls.join('\n')}
        onChange={(e) => onChange(splitList(e.target.value, '\n'))}
      />
    </label>
  );
}

/** The topics and projects this note belongs to, as checkboxes. */
export function CollectionsField({ collections, itemId, chosen, onChange }) {
  return (
    <fieldset className="space-y-2 rounded-lg border p-3">
      <legend className="px-1 text-sm">Topics & projects</legend>
      {collections
        .filter((c) => c.id !== itemId && !c.archived)
        .map((c) => (
          <label className="mr-4 inline-flex items-center gap-2 text-sm" key={c.id}>
            <input
              type="checkbox"
              checked={chosen.includes(c.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...chosen, c.id] : chosen.filter((id) => id !== c.id))
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
  );
}

/** The picker that links another item, and the list of linked items. */
export function LinksField({ links, candidates, itemId, onChange, onSelect }) {
  return (
    <>
      <label className="block space-y-1 text-sm">
        <span>Link a note or content item from the loaded library</span>
        <select
          className={inputClass}
          value=""
          onChange={(e) => {
            if (e.target.value && !links.includes(e.target.value))
              onChange([...links, e.target.value]);
          }}
        >
          <option value="">Choose an item…</option>
          {candidates
            .filter((c) => c.id !== itemId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
        </select>
      </label>
      <ul className="space-y-1">
        {links.map((id) => (
          <li key={id} className="flex items-center gap-3 text-sm">
            <button type="button" className="underline" onClick={() => onSelect(id)}>
              {candidates.find((c) => c.id === id)?.title || id}
            </button>
            <button
              type="button"
              aria-label={`Remove link ${id}`}
              onClick={() => onChange(links.filter((v) => v !== id))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Save, Archive or Restore, Save recovery copy and History. */
export function EditorActions({ busy, invalidHeading, archived, version, actions }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || invalidHeading} onClick={actions.save}>
        {busy ? 'Working…' : 'Save note'}
      </Button>
      <Button variant="outline" disabled={busy} onClick={actions.toggleArchive}>
        {archived ? 'Restore' : 'Archive'}
      </Button>
      <Button variant="outline" disabled={busy} onClick={actions.recover}>
        Save recovery copy
      </Button>
      <Button variant="outline" disabled={busy || !version} onClick={actions.history}>
        History
      </Button>
    </div>
  );
}

/** Earlier versions, newest first, each with a button to load it for review. */
export function HistoryList({ history, before, onOlder, onLoad }) {
  return (
    <div aria-live="polite">
      {before && (
        <Button variant="outline" size="sm" onClick={() => onOlder(before)}>
          Older versions
        </Button>
      )}
      {history.map((entry) => (
        <details className="rounded-lg border p-3" key={entry.id}>
          <summary className="cursor-pointer text-sm">
            Version {entry.result.version} · {new Date(entry.result.updatedAt).toLocaleString()}
          </summary>
          <Markdown>{entry.result.body}</Markdown>
          <Button size="sm" variant="outline" onClick={() => onLoad(entry.result)}>
            Load into editor for review
          </Button>
        </details>
      ))}
    </div>
  );
}

export function BacklinksList({ backlinks, onSelect }) {
  return (
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
  );
}
