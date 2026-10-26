/**
 * The Calendar's one read: GET cms/calendar for the view's window, through
 * the shared `useGuardedLoad` so a slow older window never paints over a
 * newer one and every mutation can `refresh()` — the bug the old page had
 * was never refetching after a schedule (ADR 0033 §1 Amplify).
 */
import { useCallback, useMemo } from 'react';
import { getJSON } from '@/lib/api';
import useGuardedLoad from '@/components/admin/speaking-events/useGuardedLoad';
import { rangeFor } from './calendarModel';

const EMPTY = Object.freeze({ items: [], warnings: [] });
const describeError = (err) => err?.message || 'The calendar could not be read.';

export function calendarRoute(from, to, kinds) {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (kinds?.length) params.set('kinds', kinds.join(','));
  return `cms/calendar?${params.toString()}`;
}

/**
 * @param {{ view: string, cursor: Date, kinds?: string[], enabled?: boolean }} args
 *   `kinds` narrows the SERVER read (the Newsletter Hub embeds the calendar
 *   filtered to its own kind); the toolbar's filters narrow client-side.
 *   `refreshToken` is any value that changes when something outside the grid
 *   changed what it shows (the alerts panel): a new value reads again, through
 *   the same race-safe path as a change of window.
 */
export default function useCalendarItems({
  view,
  cursor,
  kinds = null,
  enabled = true,
  refreshToken = 0,
}) {
  // A new refreshToken is a new range object, so the load function below is
  // new too and the guarded load reads again, by the same path as a change of
  // window.
  const range = useMemo(
    () => ({ ...rangeFor(view, cursor), refreshToken }),
    [view, cursor, refreshToken]
  );
  const { from, to } = range;
  const kindsKey = kinds ? kinds.join(',') : '';
  const load = useCallback(async () => {
    const res = await getJSON(
      calendarRoute(range.from, range.to, kindsKey ? kindsKey.split(',') : null)
    );
    return {
      items: Array.isArray(res?.items) ? res.items : [],
      warnings: Array.isArray(res?.warnings) ? res.warnings : [],
    };
  }, [range, kindsKey]);
  const state = useGuardedLoad(load, { enabled, empty: EMPTY, describeError });
  return { ...state, from, to, items: state.data.items, warnings: state.data.warnings };
}
