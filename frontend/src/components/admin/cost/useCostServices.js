/**
 * The services ledger (`cms/cost/services`): the subscriptions the site pays
 * for outside Azure, read once by the Services tab, written one item at a time.
 *
 * The read is the shared race-safe one (useGuardedLoad). A write — add, edit,
 * remove — puts the server's answer straight into the list rather than
 * re-reading it, so the row the owner just saved is on screen at once with the
 * monthly equivalent and the days-until the server computed; then it calls the
 * page's `onChanged` so the Overview's totals follow.
 *
 * A refused write is handed back as the server's sentence (`error.message`),
 * which the form shows beside its buttons; nothing here rewrites it.
 */
import { useCallback, useState } from 'react';
import { useAuthReady } from '@/hooks/useAuthReady';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import {
  createCostService,
  deleteCostService,
  fetchCostServices,
  updateCostService,
} from '@/lib/cost';

const EMPTY = Object.freeze({ today: '', items: [], total: 0, suggestions: [] });
const describeError = (err) => err?.message || 'The services ledger could not be read.';

/** Items by name, the order the server lists them in and the order an edit keeps. */
const byName = (a, b) => String(a.name).localeCompare(String(b.name));

const sameVendor = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

export default function useCostServices({ onChanged } = {}) {
  const { authReady } = useAuthReady();
  const guarded = useGuardedLoad(fetchCostServices, {
    enabled: authReady,
    empty: EMPTY,
    describeError,
  });
  const { data, loaded } = guarded;

  // The list as edited since the last read: the server's items, then each
  // write's answer put in place. Follows each landed read, adjusted during
  // render the way React recommends for state that follows a prop.
  const [seen, setSeen] = useState(data);
  const [items, setItems] = useState(data.items);
  const [suggestions, setSuggestions] = useState(data.suggestions);
  if (data !== seen) {
    setSeen(data);
    setItems(data.items);
    setSuggestions(data.suggestions);
  }

  const [saving, setSaving] = useState(false);

  /** Run one write; resolve the server's answer, or throw its sentence. */
  const run = useCallback(
    async (write, apply) => {
      setSaving(true);
      try {
        const answer = await write();
        setItems((current) => apply(current, answer).sort(byName));
        onChanged?.();
        return answer;
      } finally {
        setSaving(false);
      }
    },
    [onChanged]
  );

  const add = useCallback(
    async (fields) => {
      const item = await run(
        () => createCostService(fields),
        (current, saved) => [...current.filter((row) => row.id !== saved.id), saved]
      );
      // A suggestion is a vendor not yet in the ledger; once added it goes.
      setSuggestions((list) => list.filter((s) => !sameVendor(s.vendor, item.vendor)));
      return item;
    },
    [run]
  );

  const edit = useCallback(
    (id, changes) =>
      run(
        () => updateCostService(id, changes),
        (current, item) => current.map((row) => (row.id === item.id ? item : row))
      ),
    [run]
  );

  const remove = useCallback(
    (id) =>
      run(
        () => deleteCostService(id),
        (current) => current.filter((row) => row.id !== id)
      ),
    [run]
  );

  return {
    today: data.today,
    items,
    suggestions,
    loaded,
    loading: guarded.loading,
    error: guarded.error,
    saving,
    refresh: guarded.refresh,
    add,
    edit,
    remove,
  };
}
