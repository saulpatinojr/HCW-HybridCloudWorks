/**
 * The Second Brain page's state, in parts: the busy line and error, the
 * note lists, the library search, the map and the selected item. Each part
 * was written inline in SecondBrainPage.jsx until the page grew too long to
 * follow.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { brainApi } from '@/lib/brainApi';

export const blank = (type = 'note', fields = {}) => ({
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
export const merge = (a, b) => [...new Map([...a, ...b].map((i) => [i.id, i])).values()];

/** The busy line and the error line, and a runner that sets both around a request. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Runs one request with the busy line shown and any error reported.
  const whileBusy = useCallback(async (work) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, setBusy, error, setError, whileBusy };
}

/** The notes list, its next-page key, the archived switch and the index status. */
export function useNotes(enabled, { setError, setBusy }) {
  const [notes, setNotes] = useState([]);
  const [after, setAfter] = useState(null);
  const [archived, setArchived] = useState(false);
  const [status, setStatus] = useState(null);
  const loadNotes = useCallback(
    async (next = '') => {
      const page = await brainApi.list({ archived, after: next });
      setNotes((old) => (next ? merge(old, page.items) : page.items));
      setAfter(page.after);
    },
    [archived]
  );
  // Loads the first page of notes and the index status, then polls the status.
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const ifAlive = (fn) => (value) => {
      if (alive) fn(value);
    };
    Promise.all([
      brainApi.list({ archived }).then(
        ifAlive((page) => {
          setNotes(page.items);
          setAfter(page.after);
        })
      ),
      brainApi.status().then(ifAlive(setStatus)),
    ])
      .catch(ifAlive((err) => setError(err.message)))
      .finally(ifAlive(() => setBusy(false)));
    const timer = setInterval(
      () =>
        brainApi
          .status()
          .then(ifAlive(setStatus))
          .catch(() => {}),
      15000
    );
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, archived, setError, setBusy]);
  async function reindex() {
    setBusy(true);
    try {
      await brainApi.reindex();
      setStatus(await brainApi.status());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return { notes, after, archived, setArchived, status, loadNotes, reindex };
}

/** The library's search box, its results and the key for the next page. */
export function useLibrary(whileBusy) {
  const [results, setResults] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [query, setQuery] = useState('');
  function search(next = null) {
    return whileBusy(async () => {
      const page = await brainApi.search({ q: query, cursor: next });
      setResults((old) => (next ? merge(old, page.items) : page.items));
      setCursor(page.cursor);
    });
  }
  return { results, cursor, query, setQuery, search };
}

/** The map's nodes and edges, filtered by type, and the key to expand it. */
export function useGraph(whileBusy) {
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [graphCursor, setGraphCursor] = useState(null);
  const [mapFilter, setMapFilter] = useState('');
  function loadGraph(next = null) {
    return whileBusy(async () => {
      const page = await brainApi.graph({ cursor: next });
      setGraph((old) =>
        next ? { nodes: merge(old.nodes, page.nodes), edges: [...old.edges, ...page.edges] } : page
      );
      setGraphCursor(page.cursor);
    });
  }
  const mapNodes = useMemo(
    () => graph.nodes.filter((n) => !mapFilter || n.type === mapFilter),
    [graph.nodes, mapFilter]
  );
  const mapEdges = useMemo(() => {
    const ids = new Set(mapNodes.map((n) => n.id));
    return graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  }, [graph.edges, mapNodes]);
  return { graphCursor, mapFilter, setMapFilter, loadGraph, mapNodes, mapEdges };
}

/**
 * The selected item, its backlinks and the editor's state. `open(id)` loads
 * an item; `openCapture(key)` starts a research note on a piece of content.
 * Both ask first when the editor has unsaved changes (`guard`).
 */
export function useSelection(guard, { setBusy, setError }) {
  const { dirtyRef, canLeave } = guard;
  const [selection, setSelection] = useState(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [backlinks, setBacklinks] = useState([]);
  // Private in-memory recovery survives a failed capability refresh. The
  // identity-keyed provider unmounts this page when accounts change.
  const [editorSnapshot, setEditorSnapshot] = useState(null);
  const openSequence = useRef(0);
  const detailRef = useRef(null);
  const selectedId = selection?.id;
  useEffect(() => {
    if (!selectedId) return;
    detailRef.current?.focus({ preventScroll: true });
    detailRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [selectedId, editorEpoch]);
  // Shows `item` as the selection with a fresh editor and no saved draft.
  const select = useCallback(
    (item, links) => {
      setEditorSnapshot(null);
      dirtyRef.current = false;
      setSelection(item);
      setBacklinks(links);
    },
    [dirtyRef]
  );
  const open = useCallback(
    async (id) => {
      if (!(await canLeave())) return;
      const seq = ++openSequence.current;
      setBusy(true);
      setError('');
      try {
        const data = await brainApi.get(id);
        if (seq === openSequence.current) {
          setEditorEpoch((value) => value + 1);
          select(data.item, data.backlinks);
        }
      } catch (err) {
        if (seq === openSequence.current) setError(err.message);
      } finally {
        if (seq === openSequence.current) setBusy(false);
      }
    },
    [canLeave, select, setBusy, setError]
  );
  // A new research note linked to the content `capture` names. Stale capture
  // answers and errors are dropped once `openSequence` has moved on (#1547).
  const openCapture = useCallback(
    (capture) => {
      const seq = ++openSequence.current;
      const current = () => seq === openSequence.current;
      canLeave()
        .then((leave) => {
          if (!leave) return null;
          setError('');
          return brainApi.context(capture);
        })
        .then((data) => {
          if (data && current()) {
            select(blank('note', { title: 'Content research', links: [data.sourceId] }), []);
          }
        })
        .catch((err) => (current() ? setError(err.message) : undefined));
    },
    [canLeave, select, setError]
  );
  const saved = (item) => {
    setEditorSnapshot(null);
    setSelection(item);
    dirtyRef.current = false;
  };
  return {
    selection,
    editorEpoch,
    backlinks,
    editorSnapshot,
    setEditorSnapshot,
    detailRef,
    select,
    open,
    openCapture,
    saved,
  };
}
