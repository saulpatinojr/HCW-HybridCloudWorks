/**
 * The Stats tab's one read (#1115): `cms/podcast/host/stats?range=…`.
 *
 * Its own hook rather than a field of useRecordingHub, because nothing else
 * on the page shares it: the transcripts and the overview are two views of
 * one list, and this is the show's statistics, which no other tab shows.
 *
 * Race-safe the way the hub's reads are: every read carries a generation, so
 * a range change or a Refresh that answers after a later one paints nothing;
 * unmounting supersedes whatever is in flight; a failed read leaves the error
 * and no figures, never stale figures beside "could not read". A range change
 * clears the figures before reading, so 30 days' numbers are never shown
 * under a 90-day button; a Refresh keeps them while it reads.
 *
 * The hook only holds state; the read is a module-level function over a state
 * bag, started a tick after the effect so the render commits before state
 * moves — the shape useRecordingHub documents, for the same lint and the same
 * reason.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getJSON } from '@/lib/api';

const IDLE = Object.freeze({ data: null, loading: false, error: '' });

/** One GET of the statistics, as `{ data }` or `{ error }` — never throws. */
async function fetchHostStats(range, refresh) {
  let outcome;
  try {
    const res = await getJSON(
      `cms/podcast/host/stats?range=${encodeURIComponent(range)}${refresh ? '&refresh=1' : ''}`
    );
    outcome = { data: res && typeof res === 'object' ? res : {} };
  } catch (error) {
    outcome = { error: error?.message || 'Could not read Podbean' };
  }
  return outcome;
}

/** Read `range` as generation `mine`; a superseded read paints nothing. */
async function readStats(state, range, { refresh = false } = {}) {
  const mine = ++state.generation.current;
  state.set((prev) => ({ data: refresh ? prev.data : null, loading: true, error: '' }));
  const outcome = await fetchHostStats(range, refresh);
  if (mine !== state.generation.current || !state.alive.current) return;
  state.set(
    outcome.error
      ? { data: null, loading: false, error: outcome.error }
      : { data: outcome.data, loading: false, error: '' }
  );
}

/** The read for a range, deferred so the first render commits before state moves. */
function startStatsRead(state, range) {
  const timer = setTimeout(() => readStats(state, range), 0);
  return () => clearTimeout(timer);
}

export default function useHostStats(ready, range) {
  const [value, set] = useState(IDLE);
  const generation = useRef(0);
  const alive = useRef(true);
  const state = useMemo(() => ({ set, generation, alive }), []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
    };
  }, []);

  // A new range is a new read; the cleanup cancels one not yet started.
  useEffect(() => (ready ? startStatsRead(state, range) : undefined), [ready, range, state]);

  return {
    ...value,
    refresh: useCallback(() => readStats(state, range, { refresh: true }), [state, range]),
  };
}
