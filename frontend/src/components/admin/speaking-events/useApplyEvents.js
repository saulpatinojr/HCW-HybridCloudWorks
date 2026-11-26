/**
 * The "Future Events" tab's read and its three writes (#1823, ADR 0045).
 *
 * THE READ is one route, `cms/community-days/events`, through the shared
 * `useGuardedLoad` (ADR 0033 §2): every read takes a generation number and
 * only the newest may set state. Refresh uses the same guard but asks the
 * server to read the outside list again (`cms/community-days/refresh`); the
 * browser never talks to the outside service and never sees its key.
 *
 * THE WRITES (save a note, clear it, ask for an estimate) each claim the
 * event's id first (`useWriteGuard`), so a second click while the first is
 * out is ignored, not sent twice. A save sends the version (`etag`) the row
 * was read at; when the server answers that the note changed somewhere else
 * (HTTP 409), the list is read again so the row shows the latest, and the
 * server's sentence is shown. The open form then puts the stored values back
 * (ApplyTab's NoteEditor), so a second Save cannot send the old form over the
 * other change. After any write the list is re-read; rows stay on screen
 * while it is. `writeErrorCode` is the server's code for the refusal, when it
 * gave one, so the page can add a link for the ones it knows.
 *
 * NOTHING HERE ASKS FOR AN ESTIMATE BY ITSELF. `estimate` is only ever
 * called from the row's button.
 */
import { useCallback, useState } from 'react';
import { getJSON, sendJSON } from '@/lib/api';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import useWriteGuard from '@/components/admin/shared/useWriteGuard';

export const EVENTS_ROUTE = 'cms/community-days/events';
export const REFRESH_ROUTE = 'cms/community-days/refresh';
export const eventRoute = (eventId) => `${EVENTS_ROUTE}/${encodeURIComponent(eventId)}`;
export const estimateRoute = (eventId) => `${eventRoute(eventId)}/estimate`;

export const EMPTY_LIST = Object.freeze({
  status: 'loading',
  keySet: false,
  events: Object.freeze([]),
  saved: Object.freeze([]),
  fetchedAt: null,
  total: null,
  truncated: false,
  error: null,
  notice: null,
  topics: Object.freeze({ count: 0, hasBio: false, from: Object.freeze([]) }),
});

// Names the directory: the owner's own events come from the stored events and
// still show under this message.
const describeRead = (err) => `The Community Days events could not be loaded: ${err?.message}`;

/** One loader per hook: `forceNext()` makes the next read a Refresh. */
function makeLoader() {
  let force = false;
  return {
    forceNext: () => {
      force = true;
    },
    load: async () => {
      const refresh = force;
      force = false;
      const answer = refresh ? await sendJSON(REFRESH_ROUTE, 'POST') : await getJSON(EVENTS_ROUTE);
      return { ...EMPTY_LIST, ...answer };
    },
  };
}

export default function useApplyEvents(authReady) {
  // Made once per mount: useState's initialiser runs a single time.
  const [loader] = useState(makeLoader);
  const read = useGuardedLoad(loader.load, {
    enabled: authReady,
    empty: EMPTY_LIST,
    describeError: describeRead,
  });
  const { busyIds, claim, release } = useWriteGuard();
  const [writeError, setWriteError] = useState('');
  const [writeErrorCode, setWriteErrorCode] = useState('');
  // Which kind of write each busy event has out: 'save', 'clear' or 'estimate'.
  const [kinds, setKinds] = useState({});
  const { refresh } = read;

  const refreshNow = useCallback(() => {
    loader.forceNext();
    return refresh();
  }, [loader, refresh]);

  /**
   * Run one guarded write for an event; true when it landed. One write per
   * event at a time, whatever its kind: a save and an estimate for the same
   * event would otherwise race for the same stored note. `kind` is only what
   * the row shows as busy.
   */
  const write = useCallback(
    async (eventId, kind, send) => {
      if (!claim(eventId)) return false;
      setWriteError('');
      setWriteErrorCode('');
      setKinds((current) => ({ ...current, [eventId]: kind }));
      let landed = false;
      try {
        await send();
        landed = true;
      } catch (err) {
        setWriteError(err?.message || 'The change could not be saved.');
        setWriteErrorCode(typeof err?.code === 'string' ? err.code : '');
      } finally {
        // Re-read either way: after a refusal the row must show what is stored.
        await refresh();
        release(eventId);
        setKinds((current) => {
          const { [eventId]: _done, ...rest } = current;
          return rest;
        });
      }
      return landed;
    },
    [claim, release, refresh]
  );

  const save = useCallback(
    (eventId, payload, etag) =>
      write(eventId, 'save', () =>
        sendJSON(eventRoute(eventId), 'PUT', etag ? { ...payload, etag } : payload)
      ),
    [write]
  );
  const clear = useCallback(
    (eventId, etag) =>
      write(eventId, 'clear', () =>
        sendJSON(eventRoute(eventId), 'DELETE', undefined, { headers: { 'If-Match': etag } })
      ),
    [write]
  );
  const estimate = useCallback(
    (eventId) => write(eventId, 'estimate', () => sendJSON(estimateRoute(eventId), 'POST')),
    [write]
  );

  return {
    read,
    refreshNow,
    save,
    clear,
    estimate,
    busyIds,
    kinds,
    writeError,
    writeErrorCode,
    clearWriteError: () => {
      setWriteError('');
      setWriteErrorCode('');
    },
  };
}
