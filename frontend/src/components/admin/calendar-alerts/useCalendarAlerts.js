/**
 * useCalendarAlerts — the owner's alerts, read once and changed in place.
 *
 * The sign-in pop-up and the Calendar page's alerts panel both use it. A change goes
 * to the server and the alert the server answers replaces the one held, so
 * the page shows exactly what was saved (including the `state` and
 * `daysUntilDue` the server works out) and no second read is needed.
 *
 * `enabled` false reads nothing: a viewer, who the server would refuse, never
 * asks. A failed read leaves `status` at 'error' with the error kept for the
 * caller to word; it throws nothing, so it can never break the page around it.
 * `onLoaded({ alerts, today })` runs after each read that lands, which is how
 * the pop-up decides whether to open without setting state inside an effect.
 * `onChanged()` runs after each create, update or delete that the server took,
 * which is how the Calendar page makes its grid read again. A change made
 * through ANY copy of this hook (the pop-up's, the page's) is announced, and
 * the other copies read again and run their own `onChanged`, so the pop-up and
 * the Calendar page never disagree about an alert.
 *
 * Every read takes a generation number and only the newest may set state, so
 * a slow older answer never paints over a newer one (the same rule as
 * components/admin/shared/useGuardedLoad.js).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  announceAlertsChanged,
  compareAlerts,
  createCalendarAlert,
  deleteCalendarAlert,
  fetchCalendarAlerts,
  onAlertsChanged,
  updateCalendarAlert,
} from '@/lib/calendarAlerts';

/** A ref that is true while the component is mounted. */
function useMountedRef() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/**
 * Fetch the alerts and hand the answer to `landed` (or the error to
 * `failed`), unless a newer read has started meanwhile. Resolves to the
 * answer, or null when it failed or was overtaken.
 */
async function readIfNewest(mine, generation, { landed, failed }) {
  try {
    const result = await fetchCalendarAlerts();
    if (mine !== generation.current) return null;
    landed(result);
    return result;
  } catch (caught) {
    if (mine === generation.current) failed(caught);
    return null;
  }
}

/** Mark an id busy while `work` runs, so its buttons cannot be pressed twice. */
async function runWhileBusy(id, work, setBusyIds, mounted) {
  setBusyIds((current) => new Set(current).add(id));
  try {
    return await work();
  } finally {
    if (mounted.current) {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }
}

export default function useCalendarAlerts({ enabled = true, onLoaded, onChanged } = {}) {
  const [alerts, setAlerts] = useState([]);
  const [today, setToday] = useState(null);
  const [status, setStatus] = useState(enabled ? 'loading' : 'idle');
  const [error, setError] = useState(null);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const generation = useRef(0);
  const mounted = useMountedRef();
  const self = useRef(Symbol('calendar-alerts'));
  const isEnabled = useRef(enabled);
  const loaded = useRef(onLoaded);
  const changed = useRef(onChanged);

  useEffect(() => {
    loaded.current = onLoaded;
    changed.current = onChanged;
    isEnabled.current = enabled;
  });

  const read = useCallback(
    (mine) =>
      readIfNewest(mine, generation, {
        landed: (result) => {
          const sorted = result.alerts.slice().sort(compareAlerts);
          setAlerts(sorted);
          setToday(result.today);
          setError(null);
          setStatus('ready');
          loaded.current?.({ alerts: sorted, today: result.today });
        },
        failed: (caught) => {
          setError(caught);
          setStatus('error');
        },
      }),
    []
  );

  useEffect(() => {
    if (enabled) read(++generation.current);
    // A read in flight when this goes away must not land on whatever replaced it.
    return () => {
      generation.current += 1;
    };
  }, [enabled, read]);

  /**
   * Read again (a Try again button, or a change made elsewhere). A list already
   * on screen stays there while it reads; only a missing or failed one shows
   * as loading. Resolves to the answer, or null when it failed.
   */
  const reload = useCallback(() => {
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    setError(null);
    return read(++generation.current);
  }, [read]);

  // Another copy of this hook changed an alert: read again, and let the owner of
  // this copy (the Calendar page's grid, say) know.
  useEffect(
    () =>
      onAlertsChanged((source) => {
        const fromElsewhere = source !== self.current;
        if (fromElsewhere && isEnabled.current && mounted.current) {
          read(++generation.current);
          changed.current?.();
        }
      }),
    [mounted, read]
  );

  /** Mark an id busy while `work` runs, so its buttons cannot be pressed twice. */
  const whileBusy = useCallback(
    (id, work) => runWhileBusy(id, work, setBusyIds, mounted),
    [mounted]
  );

  const replace = useCallback((saved) => {
    setAlerts((current) =>
      current.some((alert) => alert.id === saved.id)
        ? current.map((alert) => (alert.id === saved.id ? saved : alert)).sort(compareAlerts)
        : [...current, saved].sort(compareAlerts)
    );
  }, []);

  /**
   * Run a save, hold the alert the server answers, and tell this copy's
   * owner and the other copies. Resolves to the saved alert.
   */
  const saveWith = useCallback(
    async (work) => {
      const saved = await work();
      if (mounted.current) replace(saved);
      changed.current?.();
      announceAlertsChanged(self.current);
      return saved;
    },
    [mounted, replace]
  );

  /** Each action resolves to the saved alert, or rejects with the server's sentence. */
  const update = useCallback(
    (id, changes) => whileBusy(id, () => saveWith(() => updateCalendarAlert(id, changes))),
    [saveWith, whileBusy]
  );

  const create = useCallback((fields) => saveWith(() => createCalendarAlert(fields)), [saveWith]);

  const remove = useCallback(
    (id) =>
      whileBusy(id, async () => {
        await deleteCalendarAlert(id);
        if (mounted.current) setAlerts((current) => current.filter((alert) => alert.id !== id));
        changed.current?.();
        announceAlertsChanged(self.current);
      }),
    [mounted, whileBusy]
  );

  return {
    alerts,
    today,
    status,
    error,
    busyIds,
    reload,
    create,
    remove,
    markDone: (id) => update(id, { done: true }),
    reopen: (id) => update(id, { done: false }),
    snooze: (id, days) => update(id, { snoozeDays: days }),
    edit: update,
  };
}
