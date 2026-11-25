/**
 * The Forge Studio Queue's reads and writes (owner request 2026-10-06), held
 * at page level so Start can add to it and the Queue tab can work it:
 *
 *   GET  cms/forge/queue          the entries
 *   POST cms/forge/queue          { urls }            add
 *   POST cms/forge/queue/update   { ids, fields }     apply fields; { ids, remove: true } removes
 *   POST cms/forge/queue/forge    { ids }             start a forge-from-url job per entry
 *
 * Every answer carries the whole list, so the state is always the server's.
 * While any entry is forging the list is re-read every REFRESH_MS: the job's
 * onComplete writes the outcome server-side, and the tab shows it without a
 * reload.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getJSON, postJSON } from '@/lib/api';

export const REFRESH_MS = 20000;

/** The queue after a mutation's delta: changed entries replace or join, removed ids leave; newest first. */
export function mergeDelta(items, changed = [], removed = []) {
  const gone = new Set(removed || []);
  const byId = new Map((items || []).filter((e) => !gone.has(e.id)).map((e) => [e.id, e]));
  for (const entry of changed || []) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

const EMPTY = Object.freeze({
  status: 'idle',
  items: [],
  total: 0,
  max: 200,
  error: null,
  busy: null,
});

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
 * The state after a server answer: a list answer (`items`) replaces the
 * queue; a mutation answer (`changed`, `removed`) is merged into it.
 */
function withAnswer(current, answer) {
  const items = Array.isArray(answer.items)
    ? answer.items
    : mergeDelta(current.items, answer.changed, answer.removed);
  return {
    ...current,
    status: 'ready',
    items,
    total: items.length,
    max: answer.max ?? current.max,
    error: null,
  };
}

/** The body of useForgeQueue's `run` (see there). */
async function runQueueCall(call, { begin, onError }, { setState, mounted, take }) {
  setState((current) => ({ ...current, ...begin(current), error: null }));
  try {
    const answer = await call();
    return mounted.current ? take(answer) : answer;
  } catch (err) {
    if (mounted.current) setState((current) => ({ ...current, ...onError(err) }));
    return null;
  } finally {
    if (mounted.current) setState((current) => ({ ...current, busy: null }));
  }
}

/** Call `load` every REFRESH_MS while `active`. Returns the effect cleanup. */
function pollWhile(active, load) {
  if (!active) return undefined;
  const timer = setInterval(load, REFRESH_MS);
  return () => clearInterval(timer);
}

export function useForgeQueue({ enabled = true } = {}) {
  const [state, setState] = useState(EMPTY);
  const mounted = useMountedRef();

  /**
   * The server's answer becomes the state: a list answer (`items`) replaces
   * the queue; a mutation answer (`changed`, `removed`) is merged into it, so
   * a Save on two entries never brings five thousand back. A refused answer
   * is an error.
   */
  const take = useCallback((answer) => {
    if (!answer?.ok) throw new Error(answer?.error || 'The queue did not answer.');
    setState((current) => withAnswer(current, answer));
    return answer;
  }, []);

  /**
   * One call against the queue: `begin` is what the state shows while it
   * runs, `onError` what a failure leaves on it. Resolves to the answer, or
   * null when it failed; nothing is written after unmount.
   */
  const run = useCallback(
    (call, steps) => runQueueCall(call, steps, { setState, mounted, take }),
    [mounted, take]
  );

  const load = useCallback(
    () =>
      run(() => getJSON('cms/forge/queue'), {
        begin: (current) => ({ status: current.status === 'idle' ? 'loading' : current.status }),
        onError: (err) => ({
          status: 'error',
          error: err?.message || 'The queue could not be read.',
        }),
      }),
    [run]
  );

  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  // Re-read while a job is running, so forged/failed arrive on their own.
  const forging = state.items.some((item) => item.status === 'forging');
  useEffect(() => pollWhile(enabled && forging, load), [enabled, forging, load]);

  /** One write: `busy` names it, the answer replaces the list, an error lands on the state. */
  const write = useCallback(
    (busy, call) =>
      run(call, {
        begin: () => ({ busy }),
        onError: (err) => ({ error: err?.message || 'The queue write failed.' }),
      }),
    [run]
  );

  const add = useCallback(
    (urls) => write('add', () => postJSON('cms/forge/queue', { urls })),
    [write]
  );
  const update = useCallback(
    (ids, fields) => write('update', () => postJSON('cms/forge/queue/update', { ids, fields })),
    [write]
  );
  const remove = useCallback(
    (ids) => write('remove', () => postJSON('cms/forge/queue/update', { ids, remove: true })),
    [write]
  );
  const forge = useCallback(
    (ids) => write('forge', () => postJSON('cms/forge/queue/forge', { ids })),
    [write]
  );
  const clearError = useCallback(() => setState((current) => ({ ...current, error: null })), []);

  return { ...state, load, add, update, remove, forge, clearError };
}
