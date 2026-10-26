import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Brain, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { useBrainAccess } from '@/hooks/useBrainAccess';
import { brainApi } from '@/lib/brainApi';
import BrainMap from './brain/BrainMap';
import AskPanel from './brain/AskPanel';
import WorkspaceHome from './brain/WorkspaceHome';
import NoteEditor, { Markdown } from './brain/NoteEditor';

const VIEWS = ['Home', 'Inbox', 'Library', 'Topics & Projects', 'Map', 'Ask'];
const blank = (type = 'note', fields = {}) => ({
  id: crypto.randomUUID(),
  type,
  title: type === 'note' ? 'New idea' : `New ${type}`,
  body: '',
  tags: [],
  links: [],
  collections: [],
  urls: [],
  version: 0,
  inbox: type === 'note',
  archived: false,
  ...fields,
});
const merge = (a, b) => [...new Map([...a, ...b].map((i) => [i.id, i])).values()];

function ItemList({
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
            <span className="mt-1 block font-medium">{item.title}</span>
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

const workspaceClass = (selection) =>
  selection ? 'grid items-start gap-6 xl:grid-cols-[minmax(20rem,1fr)_minmax(28rem,1fr)]' : '';

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

function WorkspaceUnavailable({ access }) {
  return (
    <div className="rounded-xl border p-8">
      <h1 className="text-2xl font-semibold">Second Brain</h1>
      <p className="mt-3">
        This private workspace is unavailable for this account or has not been enabled.
      </p>
      {access.accountLabel && (
        <p className="mt-2 text-sm text-muted-foreground">Signed in as {access.accountLabel}</p>
      )}
      {access.errorStatus === 401 && (
        <p className="mt-2 text-sm">Your HCW website session needs to be renewed.</p>
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

export default function SecondBrainPage() {
  const access = useBrainAccess();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState('Home');
  const [notes, setNotes] = useState([]);
  const [after, setAfter] = useState(null);
  const [archived, setArchived] = useState(false);
  const [results, setResults] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [query, setQuery] = useState('');
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [graphCursor, setGraphCursor] = useState(null);
  const [mapFilter, setMapFilter] = useState('');
  const [selection, setSelection] = useState(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [backlinks, setBacklinks] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const detailRef = useRef(null);
  const selectedId = selection?.id;
  useEffect(() => {
    if (!selectedId) return;
    detailRef.current?.focus({ preventScroll: true });
    detailRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [selectedId, editorEpoch]);
  const openSequence = useRef(0);
  const initialLink = useRef(false);
  const dirtyRef = useRef(false);
  const reportDirty = useCallback((value) => {
    dirtyRef.current = value;
  }, []);
  const [leavePending, setLeavePending] = useState(false);
  const leaveAnswer = useRef(null);
  const canLeave = useCallback(() => {
    if (!dirtyRef.current) return Promise.resolve(true);
    return new Promise((resolve) => {
      leaveAnswer.current = resolve;
      setLeavePending(true);
    });
  }, []);
  const loadNotes = useCallback(
    async (next = '') => {
      const page = await brainApi.list({ archived, after: next });
      setNotes((old) => (next ? merge(old, page.items) : page.items));
      setAfter(page.after);
    },
    [archived]
  );
  useEffect(() => {
    if (!access.enabled) return undefined;
    let alive = true;
    Promise.all([
      brainApi.list({ archived }).then((page) => {
        if (alive) {
          setNotes(page.items);
          setAfter(page.after);
        }
      }),
      brainApi.status().then((s) => {
        if (alive) setStatus(s);
      }),
    ])
      .catch((err) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    const timer = setInterval(
      () =>
        brainApi
          .status()
          .then((s) => {
            if (alive) setStatus(s);
          })
          .catch(() => {}),
      15000
    );
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [access.enabled, archived]);
  const open = useCallback(
    async (id) => {
      if (!(await canLeave())) return;
      const seq = ++openSequence.current;
      setBusy(true);
      setError('');
      try {
        const data = await brainApi.get(id);
        if (seq === openSequence.current) {
          setSelection(data.item);
          setEditorEpoch((value) => value + 1);
          dirtyRef.current = false;
          setBacklinks(data.backlinks);
        }
      } catch (err) {
        if (seq === openSequence.current) setError(err.message);
      } finally {
        if (seq === openSequence.current) setBusy(false);
      }
    },
    [canLeave]
  );
  useEffect(() => {
    if (!access.enabled || initialLink.current) return;
    initialLink.current = true;
    if (params.get('item')) Promise.resolve().then(() => open(params.get('item')));
    else if (params.get('capture')) {
      brainApi
        .context(params.get('capture'))
        .then((data) => {
          setSelection(blank('note', { title: 'Content research', links: [data.sourceId] }));
          setBacklinks([]);
        })
        .catch((err) => setError(err.message));
    }
  }, [access.enabled, params, open]);
  async function search(next = null) {
    setBusy(true);
    setError('');
    try {
      const page = await brainApi.search({ q: query, cursor: next });
      setResults((old) => (next ? merge(old, page.items) : page.items));
      setCursor(page.cursor);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function loadGraph(next = null) {
    setBusy(true);
    setError('');
    try {
      const page = await brainApi.graph({ cursor: next });
      setGraph((old) =>
        next ? { nodes: merge(old.nodes, page.nodes), edges: [...old.edges, ...page.edges] } : page
      );
      setGraphCursor(page.cursor);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const chooseView = (next) => {
    setView(next);
    if (next === 'Library') search();
    if (next === 'Map') loadGraph();
  };
  const newItem = async (type = 'note', fields = {}) => {
    if (!(await canLeave())) return;
    dirtyRef.current = false;
    setSelection(blank(type, fields));
    setBacklinks([]);
  };
  const saved = (item) => {
    setSelection(item);
    dirtyRef.current = false;
    loadNotes().catch((err) => setError(err.message));
  };
  const close = async () => {
    if (!(await canLeave())) return;
    setSelection(null);
    setBacklinks([]);
    setParams({}, { replace: true });
  };
  const statusData = status || access;
  const collections = notes.filter((n) => ['topic', 'project'].includes(n.type));
  const mapNodes = graph.nodes.filter((n) => !mapFilter || n.type === mapFilter);

  if (access.loading) return <p role="status">Checking workspace access…</p>;
  if (!access.enabled) return <WorkspaceUnavailable access={access} />;
  return (
    <div className="max-w-[100rem] space-y-6">
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
          <Button onClick={() => newItem()}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Capture an idea
          </Button>
        </div>
      </header>
      <ConfirmModal
        open={leavePending}
        title="Leave this note?"
        description="Your changes have not been saved."
        confirmLabel="Leave without saving"
        onConfirm={() => {
          setLeavePending(false);
          dirtyRef.current = false;
          leaveAnswer.current?.(true);
        }}
        onCancel={() => {
          setLeavePending(false);
          leaveAnswer.current?.(false);
        }}
      />
      <nav aria-label="Second Brain views" className="flex flex-wrap gap-2 border-b pb-3">
        {VIEWS.map((name) => (
          <Button
            key={name}
            variant={view === name ? 'default' : 'ghost'}
            aria-pressed={view === name}
            onClick={() => chooseView(name)}
          >
            {name}
          </Button>
        ))}
      </nav>
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
      <div className={workspaceClass(selection)}>
        <section aria-label="Workspace view" className="min-w-0 space-y-5">
          {view === 'Home' && (
            <WorkspaceHome
              notes={notes}
              collections={collections}
              status={statusData}
              busy={busy}
              onRefresh={() => loadNotes().catch((err) => setError(err.message))}
              onReindex={async () => {
                setBusy(true);
                try {
                  await brainApi.reindex();
                  setStatus(await brainApi.status());
                } catch (err) {
                  setError(err.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ItemList
                items={[...notes]
                  .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
                  .slice(0, 8)}
                onSelect={open}
              />
            </WorkspaceHome>
          )}
          {(view === 'Inbox' || view === 'Topics & Projects') && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">{view}</h2>
                <label className="text-sm">
                  <input
                    type="checkbox"
                    checked={archived}
                    onChange={(e) => setArchived(e.target.checked)}
                    className="mr-2"
                  />
                  Show archived
                </label>
                {view === 'Topics & Projects' && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => newItem('topic')}>
                      New topic
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => newItem('project')}>
                      New project
                    </Button>
                  </div>
                )}
              </div>
              <ItemList
                items={
                  view === 'Inbox'
                    ? notes.filter((n) => n.inbox || n.type === 'conflict')
                    : collections
                }
                onSelect={open}
              />
              {after && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => loadNotes(after).catch((err) => setError(err.message))}
                >
                  Load more notes
                </Button>
              )}
            </>
          )}
          {view === 'Library' && (
            <>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  search();
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
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search notes, drafts, sources, and topics…"
                />
                <Button type="submit" disabled={busy}>
                  <Search className="mr-2 h-4 w-4" aria-hidden="true" />
                  Search
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">
                Keyword search across indexed titles, text, and tags. Source records are checked
                before results are shown.
              </p>
              <ItemList
                items={results}
                onSelect={open}
                empty="No matching indexed material. Try another phrase or index your creator content from Home."
              />
              {cursor && (
                <Button variant="outline" disabled={busy} onClick={() => search(cursor)}>
                  Load more results
                </Button>
              )}
            </>
          )}
          {view === 'Map' && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Your connected knowledge</h2>
                <label className="text-sm">
                  Show
                  <select
                    className="ml-2 rounded-md border bg-background p-2"
                    value={mapFilter}
                    onChange={(e) => setMapFilter(e.target.value)}
                  >
                    <option value="">All types</option>
                    {['note', 'topic', 'project', 'reference', 'conflict'].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
              </div>
              <BrainMap
                nodes={mapNodes}
                edges={graph.edges.filter(
                  (e) =>
                    mapNodes.some((n) => n.id === e.from) && mapNodes.some((n) => n.id === e.to)
                )}
                onSelect={open}
              />
              {graphCursor && (
                <Button variant="outline" disabled={busy} onClick={() => loadGraph(graphCursor)}>
                  Expand map
                </Button>
              )}
            </>
          )}
          {view === 'Ask' && (
            <AskPanel
              context={selection}
              enabled={statusData.aiEnabled}
              onSaveNote={(fields) => newItem('note', fields)}
            />
          )}
        </section>
        {selection && (
          <aside
            ref={detailRef}
            tabIndex={-1}
            aria-label="Selected item"
            className="min-w-0 focus:outline-none"
          >
            {selection.type === 'reference' ? (
              <ReferencePreview
                item={selection}
                backlinks={backlinks}
                onSelect={open}
                onClose={close}
                onCapture={() =>
                  newItem('note', {
                    title: `Research: ${selection.title}`.slice(0, 300),
                    links: [selection.id],
                  })
                }
              />
            ) : (
              <NoteEditor
                key={`${selection.id}:${editorEpoch}`}
                item={selection}
                collections={collections}
                candidates={merge(notes, results)}
                backlinks={backlinks}
                onSaved={saved}
                onSelect={open}
                onClose={close}
                onDirty={reportDirty}
              />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
