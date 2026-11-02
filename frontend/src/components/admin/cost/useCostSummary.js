/**
 * One read of the cost snapshot (`GET cms/cost/summary`), held by the page and
 * handed to every tab, so switching tabs never re-reads Azure.
 *
 * Built on the shared race-safe read (components/admin/shared/useGuardedLoad):
 * only the newest read may set state, and a failed read empties the snapshot
 * rather than leaving yesterday's figures beside an error.
 *
 * `refresh(force)`: a plain refresh re-reads the server's cached snapshot;
 * `refresh(true)` asks the server to read Azure, the AI ledger and ElevenLabs
 * again now (`?refresh=1`). The server may refuse one within five minutes of
 * the last; it then answers the cached snapshot with `refreshed: false` and
 * `nextRefreshAt`, and this hook says so in a toast rather than letting the
 * button look as if nothing happened.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { useToast } from '@/components/ui/use-toast';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { fetchCostSummary } from '@/lib/cost';

const describeError = (err) => err?.message || 'The cost snapshot could not be read.';

/** "Try again after 14:07" from an ISO instant, in the viewer's own clock. */
export function refusedRefreshText(nextRefreshAt) {
  const at = new Date(nextRefreshAt ?? '');
  if (Number.isNaN(at.getTime())) {
    return 'Azure was read less than five minutes ago, so the saved figures were shown instead.';
  }
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    at
  );
  return `Azure was read less than five minutes ago, so the saved figures were shown instead. Try again after ${time}.`;
}

export default function useCostSummary() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  // The toast function lives in a ref so `load` stays stable: useGuardedLoad
  // restarts its read whenever `load` changes, and a toast function that is
  // new on every render would make that a loop.
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);
  // Whether the next read asks the server for a fresh Azure read. Set by
  // refresh(true) just before it starts the read, and cleared by the read.
  const forceNext = useRef(false);

  const load = useCallback(async () => {
    const force = forceNext.current;
    forceNext.current = false;
    const snapshot = await fetchCostSummary({ refresh: force });
    if (force && snapshot.refreshed === false) {
      toastRef.current?.({
        title: 'Not refreshed',
        description: refusedRefreshText(snapshot.nextRefreshAt),
      });
    }
    return snapshot;
  }, []);

  const guarded = useGuardedLoad(load, { enabled: authReady, empty: null, describeError });
  const { refresh: guardedRefresh } = guarded;

  const refresh = useCallback(
    (force = false) => {
      forceNext.current = Boolean(force);
      return guardedRefresh();
    },
    [guardedRefresh]
  );

  return {
    summary: guarded.data,
    pending: guarded.pending,
    loading: guarded.loading,
    loadedAt: guarded.loadedAt,
    error: guarded.error,
    refresh,
  };
}
