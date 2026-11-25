/**
 * The Second Brain page's views (Inbox and Topics, Library, Map) and the
 * pieces around them: the item list, the page header, the panel for the
 * selected item and the "workspace unavailable" screen. They lived inside
 * SecondBrainPage.jsx until it grew too long to follow; the page now holds
 * only the state and passes it down.
 */
import React, { useState } from 'react';
import { Link } from 'react-router';
import { Brain, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { reauthenticateForApi } from '@/lib/entraAuth';
import BrainMap from './BrainMap';
import NoteEditor, { Markdown } from './NoteEditor';
import { nodeHeading } from './mapPreferences';

export function ItemList({
  items,
  onSelect,
  empty = 'Nothing here yet. Capture an idea to get started.',
}) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => onSelect(item.id)}
            className="w-full rounded-xl border bg-card p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2"
          >
            <span className="block text-[11px] uppercase tracking-widest text-muted-foreground">
              {item.type} {item.status ? `· ${item.status}` : ''}
            </span>
            <span className="mt-1 block font-medium">{nodeHeading(item)}</span>
            {nodeHeading(item) !== item.title && (
              <span className="mt-1 line-clamp-1 block text-xs text-muted-foreground">
                {item.title}
              </span>
            )}
            {item.excerpt && (
              <span className="mt-2 line-clamp-2 block text-sm text-muted-foreground">
                {item.excerpt}
              </span>
            )}
            <span className="mt-2 block text-xs text-muted-foreground">
              {(item.tags || []).join(' · ')}
            </span>
          </button>
        </li>
      ))}
      {!items.length && (
        <li className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {empty}
        </li>
      )}
    </ul>
  );
}

function ReferencePreview({ item, backlinks, onSelect, onClose, onCapture }) {
  return (
    <section className="space-y-4 rounded-xl border p-5">
      <div className="flex justify-between gap-3">
        <h2 className="text-lg font-semibold">{item.title}</h2>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Reference copy · Edit through the existing HCW workflow
      </p>
      {item.truncated && (
        <p className="text-sm text-muted-foreground">
          This reference is shortened. Open the source tool for the full item.
        </p>
      )}
      <Link className="inline-block underline" to={item.href}>
        Open source tool
      </Link>
      <Button variant="outline" onClick={onCapture}>
        Capture linked research
      </Button>
      <Markdown>{item.body}</Markdown>
      <h3 className="font-semibold">Linked research</h3>
      <ItemList items={backlinks} onSelect={onSelect} empty="No linked notes yet." />
    </section>
  );
}

export function WorkspaceUnavailable({ access }) {
  const [error, setError] = useState('');
  const needsRenewal =
    access.errorStatus === 401 && access.wwwAuthenticate?.error === 'invalid_token';
  async function renew() {
    try {
      await reauthenticateForApi();
    } catch (err) {
      setError(err.message || 'Could not renew your session.');
    }
  }
  return (
    <div className="rounded-xl border p-8">
      <h1 className="text-2xl font-semibold">Second Brain</h1>
      <p className="mt-3">
        This private workspace is unavailable for this account or has not been enabled.
      </p>
      {access.accountLabel && (
        <p className="mt-2 text-sm text-muted-foreground">Signed in as {access.accountLabel}</p>
      )}
      {needsRenewal && (
        <p className="mt-2 text-sm">Your HCW website session needs to be renewed.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {needsRenewal && (
        <Button className="mt-4 mr-4" onClick={renew}>
          Renew website session
        </Button>
      )}
      <Button className="mt-4 mr-4" variant="outline" onClick={access.refresh}>
        Check access again
      </Button>
      <Link className="mt-4 inline-block underline" to="/admin">
        Return to admin
      </Link>
    </div>
  );
}

/** The page's title band, with the "Capture an idea" button. */
export function WorkspaceHeader({ onCapture }) {
  return (
    <header className="rounded-2xl border bg-gradient-to-br from-primary/10 via-background to-muted/40 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">
            <Brain className="h-4 w-4" aria-hidden="true" />
            Your private creator workspace
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Second Brain</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Capture what matters. Connect what you know. Create what comes next.
          </p>
        </div>
        <Button onClick={onCapture}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          Capture an idea
        </Button>
      </div>
    </header>
  );
}

/** The error line and the "Loading workspace…" line under the view buttons. */
export function WorkspaceNotices({ error, busy }) {
  return (
    <>
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading workspace…
        </p>
      )}
    </>
  );
}

/** "Inbox" and "Topics & Projects": a list of notes, with the archived switch. */
export function CollectionsView({
  view,
  archived,
  onArchived,
  items,
  onSelect,
  onNew,
  after,
  busy,
  onLoadMore,
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{view}</h2>
        <label className="text-sm">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => onArchived(e.target.checked)}
            className="mr-2"
          />
          Show archived
        </label>
        {view === 'Topics & Projects' && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onNew('topic')}>
              New topic
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNew('project')}>
              New project
            </Button>
          </div>
        )}
      </div>
      <ItemList items={items} onSelect={onSelect} />
      {after && (
        <Button variant="outline" disabled={busy} onClick={onLoadMore}>
          Load more notes
        </Button>
      )}
    </>
  );
}

/** "Library": keyword search across the indexed notes and content. */
export function LibraryView({ query, onQuery, onSearch, busy, results, cursor, onSelect }) {
  return (
    <>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch();
        }}
      >
        <label className="sr-only" htmlFor="brain-search">
          Search your notes and creator content
        </label>
        <input
          id="brain-search"
          className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2"
          maxLength={300}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search notes, drafts, sources, and topics…"
        />
        <Button type="submit" disabled={busy}>
          <Search className="mr-2 h-4 w-4" aria-hidden="true" />
          Search
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Keyword search across indexed titles, text, and tags. Source records are checked before
        results are shown.
      </p>
      <ItemList
        items={results}
        onSelect={onSelect}
        empty="No matching indexed material. Try another phrase or index your creator content from Home."
      />
      {cursor && (
        <Button variant="outline" disabled={busy} onClick={() => onSearch(cursor)}>
          Load more results
        </Button>
      )}
    </>
  );
}

const MAP_TYPES = ['note', 'topic', 'project', 'reference', 'conflict'];

/** "Map": the connected-knowledge graph, with a type filter. */
export function MapView({ filter, onFilter, nodes, edges, onSelect, cursor, busy, onExpand }) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Your connected knowledge</h2>
        <label className="text-sm">
          Show
          <select
            className="ml-2 rounded-md border bg-background p-2"
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
          >
            <option value="">All types</option>
            {MAP_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      </div>
      <BrainMap nodes={nodes} edges={edges} onSelect={onSelect} />
      {cursor && (
        <Button variant="outline" disabled={busy} onClick={() => onExpand(cursor)}>
          Expand map
        </Button>
      )}
    </>
  );
}

/**
 * The selected item beside the view: a read-only preview for a reference,
 * the editor for anything else. `editor` carries the editor's own props.
 */
export function SelectionPanel({
  panelRef,
  selection,
  backlinks,
  onSelect,
  onClose,
  onNew,
  editor,
}) {
  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-label="Selected item"
      className="min-w-0 focus:outline-none"
    >
      {selection.type === 'reference' ? (
        <ReferencePreview
          item={selection}
          backlinks={backlinks}
          onSelect={onSelect}
          onClose={onClose}
          onCapture={() =>
            onNew('note', {
              title: `Research: ${selection.title}`.slice(0, 300),
              links: [selection.id],
            })
          }
        />
      ) : (
        <NoteEditor
          key={`${selection.id}:${editor.epoch}`}
          item={selection}
          collections={editor.collections}
          candidates={editor.candidates}
          backlinks={backlinks}
          onSaved={editor.onSaved}
          onSelect={onSelect}
          onClose={onClose}
          onDirty={editor.onDirty}
          snapshot={editor.snapshot}
          onSnapshot={editor.onSnapshot}
        />
      )}
    </aside>
  );
}
