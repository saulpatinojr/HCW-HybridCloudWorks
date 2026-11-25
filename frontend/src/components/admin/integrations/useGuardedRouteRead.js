/**
 * One super_admin GET route, read once sign-in is ready and again on
 * `reload`, shared by useSecretStatus (cms/secrets) and
 * useCredentialRegister (cms/credentials).
 *
 * Race-safety, as the Newsletter Hub hardened it in #555:
 *   - every load takes a generation number, and only the newest may write
 *     state, so a slow first load cannot land over a Refresh;
 *   - unmounting bumps the generation, so nothing writes after the tab closes;
 *   - a failed load CLEARS the data it replaces, so stale data never sits
 *     beside the error.
 *
 * Returns `{ data, loading, error, reload, replace }`. `replace(answer)` takes
 * a write's answer as the newest data, winning over any load in flight.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { getJSON } from '@/lib/api';

/** A guard that is true only while `mine` is still the newest load. */
const newestOnly = (mine, generation) => () => mine === generation.current;

export default function useGuardedRouteRead(route, failureText) {
  // Every one of these routes is super_admin, so a fetch before the token
  // exists is a guaranteed 401 that renders as "could not load".
  const { authReady } = useAuthReady();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const generation = useRef(0);

  // State is only ever set in the promise callbacks, and only by the newest load.
  const fetchRoute = useCallback(
    (mine) => {
      const current = newestOnly(mine, generation);
      return getJSON(route)
        .then((response) => {
          if (current()) {
            setData(response);
            setError(null);
          }
        })
        .catch((err) => {
          if (current()) {
            setData(null);
            setError(err?.message ?? failureText);
          }
        })
        .finally(() => {
          if (current()) setLoading(false);
        });
    },
    [route, failureText]
  );

  // Refresh pressed before sign-in finishes would be that same 401, so it waits
  // for auth like the first load; the effect below loads as soon as it is ready.
  const reload = useCallback(() => {
    if (!authReady) return Promise.resolve();
    const mine = ++generation.current;
    setLoading(true);
    return fetchRoute(mine);
  }, [authReady, fetchRoute]);

  // A write's answer is the newest data: it wins over any load in flight.
  const replace = useCallback((response) => {
    generation.current += 1;
    setData(response);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!authReady) return undefined;
    fetchRoute(++generation.current);
    return () => {
      generation.current += 1;
    };
  }, [authReady, fetchRoute]);

  return { data, loading, error, reload, replace };
}
