/**
 * The Health Hub's one observed read: `getOpsHealthSnapshot`, shared by the
 * Overview and Alerts tabs.
 *
 * It lives at page level, above the tabs, so switching tabs never refetches.
 * And every read — the first, a refresh after a smoke action, a refresh after
 * answering an alert, a "Try again" — goes through one generation counter, as
 * the Newsletter Hub hardened it in #555 (and as the Integrations Hub's
 * `useSecretStatus` does):
 *
 * - a slow first load that resolves after a newer refresh is dropped instead
 *   of painting older numbers over newer ones (last to resolve would win);
 * - unmounting supersedes whatever is in flight, so nothing lands on a page
 *   that has gone;
 * - a FAILED read empties the snapshot rather than leaving the previous
 *   numbers beside an error. The error says the counts could not be read, and
 *   stale counts under it would claim otherwise.
 *
 * `refresh` never throws: it resolves true when its read landed, false when it
 * failed or was superseded, and the failure itself is in `error`. The action
 * that asked for the refresh did happen either way, so its caller reports the
 * action and leaves the snapshot's failure to the tabs that show the snapshot.
 *
 * The API keeps the snapshot for 30 s (#946). The page's first read takes the
 * cached one; `refresh`, which runs after an action (a digest, an RSS fetch,
 * a probe, an alert answered) or a "Try again", sends `{ refresh: true }` and
 * gets a build that started after it, so the action's effect is on screen at
 * once rather than up to 30 s later. The flag rides in the body: a query
 * string in the route name would miss the client's per-route timeout and
 * retry tables (lib/api.js).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { postJSON } from '@/lib/api';

export const EMPTY_SNAPSHOT = Object.freeze({ readiness: null, digest: null, alerts: [] });

/** The body of a read that may be served from the API's cache. */
const CACHED_READ = Object.freeze({});
/** The body of a read that must reflect what has just been done. */
const FRESH_READ = Object.freeze({ refresh: true });

/**
 * The Health Hub's ops snapshot, its loading and error state, and `refresh`.
 *
 * @param {boolean} authReady whether a token can be had yet; nothing is read before
 * @returns {{ snapshot: object, loaded: boolean, loading: boolean, error: string, refresh: () => Promise<boolean> }}
 */
export default function useOpsSnapshot(authReady) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loaded, setLoaded] = useState(false);
  // True from the start: until auth is ready the first read has not begun,
  // and that is still "not loaded yet" rather than "nothing to show".
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);

  // State is only ever set after the await, and only by the newest read. The
  // first read's "pending, no error" is the initial state, so the effect below
  // starts it without a synchronous setState (react-hooks/set-state-in-effect).
  const read = useCallback(async (mine, body) => {
    const current = () => mine === generation.current;
    let landed = false;
    try {
      const result = await postJSON('getOpsHealthSnapshot', body);
      if (current()) {
        setSnapshot(result || EMPTY_SNAPSHOT);
        setLoaded(true);
        landed = true;
      }
    } catch (err) {
      if (current()) {
        setSnapshot(EMPTY_SNAPSHOT);
        setLoaded(false);
        setError(err?.message || 'Failed to load ops health snapshot.');
      }
    } finally {
      if (current()) setPending(false);
    }
    return landed;
  }, []);

  // Takes no arguments on purpose: "Try again" passes it straight to onClick,
  // and the click event must not become the request.
  const refresh = useCallback(() => {
    const mine = ++generation.current;
    setPending(true);
    setError('');
    return read(mine, FRESH_READ);
  }, [read]);

  useEffect(() => {
    if (!authReady) return undefined;
    read(++generation.current, CACHED_READ);
    return () => {
      // Supersede the read in flight: its result, success or failure, is dropped.
      generation.current += 1;
    };
  }, [authReady, read]);

  return {
    snapshot,
    loaded,
    // Loading is "no numbers yet and a read under way". A refresh over numbers
    // already on screen keeps them there rather than flashing a spinner.
    loading: pending && !loaded,
    error,
    refresh,
  };
}
