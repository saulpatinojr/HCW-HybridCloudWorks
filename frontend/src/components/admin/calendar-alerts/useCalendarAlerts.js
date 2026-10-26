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
 * which is how the Calendar page makes its grid read again.
 *
 * Every read takes a generation number and only the newest may set state, so
 * a slow older answer never paints over a newer one (the same rule as
 * components/admin/shared/useGuardedLoad.js).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  compareAlerts,
  createCalendarAlert,
  deleteCalendarAlert,
  fetchCalendarAlerts,
  updateCalendarAlert,
} from '@/lib/calendarAlerts';

export default function useCalendarAlerts({ enabled = true, onLoaded, onChanged } = {}) {
  const [alerts, setAlerts] = useState([]);
  const [today, setToday] = useState(null);
  const [status, setStatus] = useState(enabled ? 'loading' : 'idle');
  const [error, setError] = useState(null);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const generation = useRef(0);
  const mounted = useRef(true);
  const loaded = useRef(onLoaded);
  const changed = useRef(onChanged);

  useEffect(() => {
    loaded.current = onLoaded;
    changed.current = onChanged;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async (mine) => {
    try {
      const result = await fetchCalendarAlerts();
      if (mine !== generation.current) return null;
      const sorted = result.alerts.slice().sort(compareAlerts);
      setAlerts(sorted);
      setToday(result.today);
      setError(null);
      setStatus('ready');
      loaded.current?.({ alerts: sorted, today: result.today });
      return result;
    } catch (caught) {
      if (mine !== generation.current) return null;
      setError(caught);
      setStatus('error');
      return null;
    }
  }, []);

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

  /** Mark an id busy while `work` runs, so its buttons cannot be pressed twice. */
  const whileBusy = useCallback(async (id, work) => {
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
  }, []);

  const replace = useCallback((saved) => {
    setAlerts((current) =>
      current.some((alert) => alert.id === saved.id)
        ? current.map((alert) => (alert.id === saved.id ? saved : alert)).sort(compareAlerts)
        : [...current, saved].sort(compareAlerts)
    );
  }, []);

  /** Each action resolves to the saved alert, or rejects with the server's sentence. */
  const update = useCallback(
    (id, changes) =>
      whileBusy(id, async () => {
        const saved = await updateCalendarAlert(id, changes);
        if (mounted.current) replace(saved);
        changed.current?.();
        return saved;
      }),
    [replace, whileBusy]
  );

  const create = useCallback(
    async (fields) => {
      const saved = await createCalendarAlert(fields);
      if (mounted.current) replace(saved);
      changed.current?.();
      return saved;
    },
    [replace]
  );

  const remove = useCallback(
    (id) =>
      whileBusy(id, async () => {
        await deleteCalendarAlert(id);
        if (mounted.current) setAlerts((current) => current.filter((alert) => alert.id !== id));
        changed.current?.();
      }),
    [whileBusy]
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
