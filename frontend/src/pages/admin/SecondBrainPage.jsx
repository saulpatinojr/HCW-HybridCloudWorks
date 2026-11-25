import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { useBrainAccess } from '@/hooks/useBrainAccess';
import AskPanel from './brain/AskPanel';
import WorkspaceHome from './brain/WorkspaceHome';
import { useLeaveGuard } from './brain/useLeaveGuard';
import {
  blank,
  merge,
  useBusy,
  useGraph,
  useLibrary,
  useNotes,
  useSelection,
} from './brain/useWorkspace';
import {
  CollectionsView,
  ItemList,
  LibraryView,
  MapView,
  SelectionPanel,
  WorkspaceHeader,
  WorkspaceNotices,
  WorkspaceUnavailable,
} from './brain/WorkspaceViews';

const VIEWS = ['Home', 'Inbox', 'Library', 'Topics & Projects', 'Map', 'Ask'];

const workspaceClass = (selection, view) =>
  selection && view !== 'Map'
    ? 'grid items-start gap-6 xl:grid-cols-[minmax(20rem,1fr)_minmax(28rem,1fr)]'
    : '';

const byNewest = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
const inInbox = (n) => n.inbox || n.type === 'conflict';

// Follow `?item=` and `?capture=` on every navigation, not only on mount
// (#1408); `handledLink` is the router key acted on.
function useFollowLinks(enabled, { open, openCapture }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const handledLink = useRef('');
  useEffect(() => {
    if (!enabled || handledLink.current === location.key) return;
    handledLink.current = location.key;
    const item = params.get('item');
    const capture = params.get('capture');
    if (item) Promise.resolve().then(() => open(item));
    else if (capture) openCapture(capture);
  }, [enabled, location.key, params, open, openCapture]);
}

/** The view picked with the buttons along the top: one of VIEWS. */
function ActiveView({ view, page }) {
  const { notes, library, graph, collections, open, newItem, busy } = page;
  if (view === 'Home') {
    return (
      <WorkspaceHome
        notes={notes.notes}
        collections={collections}
        status={page.statusData}
        busy={busy}
        onRefresh={() => notes.loadNotes().catch(page.reportError)}
        onReindex={notes.reindex}
      >
        <ItemList items={[...notes.notes].sort(byNewest).slice(0, 8)} onSelect={open} />
      </WorkspaceHome>
    );
  }
  if (view === 'Library') {
    return (
      <LibraryView
        query={library.query}
        onQuery={library.setQuery}
        onSearch={library.search}
        busy={busy}
        results={library.results}
        cursor={library.cursor}
        onSelect={open}
      />
    );
  }
  if (view === 'Map') {
    return (
      <MapView
        filter={graph.mapFilter}
        onFilter={graph.setMapFilter}
        nodes={graph.mapNodes}
        edges={graph.mapEdges}
        onSelect={open}
        cursor={graph.graphCursor}
        busy={busy}
        onExpand={graph.loadGraph}
      />
    );
  }
  if (view === 'Ask') {
    return (
      <AskPanel
        context={page.selection}
        enabled={page.statusData.aiEnabled}
        onSaveNote={async (fields) => {
          if (await newItem('note', fields)) page.setView('Inbox');
        }}
      />
    );
  }
  // 'Inbox' and 'Topics & Projects'
  return (
    <CollectionsView
      view={view}
      archived={notes.archived}
      onArchived={notes.setArchived}
      items={view === 'Inbox' ? notes.notes.filter(inInbox) : collections}
      onSelect={open}
      onNew={newItem}
      after={notes.after}
      busy={busy}
      onLoadMore={() => notes.loadNotes(notes.after).catch(page.reportError)}
    />
  );
}

export default function SecondBrainPage() {
  const access = useBrainAccess();
  const [, setParams] = useSearchParams();
  const [view, setView] = useState('Home');
  const { busy, setBusy, error, setError, whileBusy } = useBusy();
  const guard = useLeaveGuard();
  const notes = useNotes(access.enabled, { setError, setBusy });
  const library = useLibrary(whileBusy);
  const graph = useGraph(whileBusy);
  const picked = useSelection(guard, { setBusy, setError });
  useFollowLinks(access.enabled, picked);
  const reportError = (err) => setError(err.message);
  const chooseView = (next) => {
    setView(next);
    if (next === 'Library') library.search();
    if (next === 'Map') graph.loadGraph();
  };
  // Starts a new item, once any unsaved changes may be left. Resolves true
  // when it did, and undefined when the writer chose to stay.
  const newItem = async (type = 'note', fields = {}) => {
    const leave = await guard.canLeave();
    if (leave) picked.select(blank(type, fields), []);
    return leave || undefined;
  };
  const saved = (item) => {
    picked.saved(item);
    notes.loadNotes().catch(reportError);
  };
  const close = async () => {
    if (await guard.canLeave()) {
      picked.select(null, []);
      setParams({}, { replace: true });
    }
  };
  const statusData = notes.status || access;
  const collections = notes.notes.filter((n) => ['topic', 'project'].includes(n.type));

  if (access.loading) return <p role="status">Checking workspace access…</p>;
  if (!access.enabled) return <WorkspaceUnavailable access={access} />;
  const { selection } = picked;
  const page = {
    notes,
    library,
    graph,
    collections,
    open: picked.open,
    newItem,
    busy,
    statusData,
    selection,
    setView,
    reportError,
  };
  return (
    <div className="max-w-[100rem] space-y-6">
      <WorkspaceHeader onCapture={() => newItem()} />
      <ConfirmModal
        open={guard.leavePending}
        title="Leave this note?"
        description="Your changes have not been saved."
        confirmLabel="Leave without saving"
        onConfirm={() => guard.answerLeave(true)}
        onCancel={() => guard.answerLeave(false)}
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
      <WorkspaceNotices error={error} busy={busy} />
      <div className={workspaceClass(selection, view)}>
        <section aria-label="Workspace view" className="min-w-0 space-y-5">
          <ActiveView view={view} page={page} />
        </section>
        {selection && (
          <SelectionPanel
            panelRef={picked.detailRef}
            selection={selection}
            backlinks={picked.backlinks}
            onSelect={picked.open}
            onClose={close}
            onNew={newItem}
            editor={{
              epoch: picked.editorEpoch,
              collections,
              candidates: merge(notes.notes, library.results),
              onSaved: saved,
              onDirty: guard.reportDirty,
              snapshot: picked.editorSnapshot,
              onSnapshot: picked.setEditorSnapshot,
            }}
          />
        )}
      </div>
    </div>
  );
}
