/**
 * The Health Hub's stored results and the pulse's heartbeat, kept current
 * while the page is open (#1010, #1011).
 *
 * Read on mount, then again every `pollMs` (a minute) while the tab is
 * visible, so a result the server's pulse records appears without a reload.
 * A hidden tab stops polling — nothing is looking — and reads once the moment
 * it is shown again. Every read goes through one generation counter, as the
 * ops snapshot's does (useOpsSnapshot.js): a slow read that resolves after a
 * newer one is dropped, and an unmount supersedes whatever is in flight.
 *
 * A failed read keeps the results already on screen. Unlike the snapshot's
 * counts, these carry their own times, so an old result shows its age (and
 * turns unknown past its window) rather than passing for a fresh one; wiping
 * them would put the hub back to "Not tested yet" for every probe, which is
 * the reset to defaults this store exists to end.
 *
 * `now` advances with each poll, so "checked 12 min ago" and a result going
 * stale move on screen without anything else changing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  newestResult,
  readCache,
  readProbeResults,
  recordProbeResult,
  writeCache,
} from './probeStore';

export const POLL_MS = 60 * 1000;

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Calls `tick` every `pollMs` while the tab is visible: polling stops when
 * the tab is hidden, and a tick runs at once when it shows again. Returns
 * the function that stops it all.
 */
function pollWhileVisible(tick, pollMs) {
  let timer = null;
  const start = () => {
    if (timer === null) timer = setInterval(tick, pollMs);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (isHidden()) {
      stop();
      return;
    }
    tick();
    start();
  };
  if (!isHidden()) start();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export default function useStoredResults(authReady, { pollMs = POLL_MS } = {}) {
  const [stored, setStored] = useState(readCache);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);

  // State is set only after the await, and only by the newest read, so the
  // effect below can start a read without a synchronous setState in its body.
  const read = useCallback(async (mine) => {
    const current = () => mine === generation.current;
    try {
      const answer = await readProbeResults();
      if (current()) {
        setStored(answer);
        writeCache(answer);
        setLoaded(true);
        setError('');
      }
    } catch (err) {
      if (current()) setError(err?.message || 'The stored probe results could not be read.');
    } finally {
      if (current()) setNow(Date.now());
    }
  }, []);

  const refresh = useCallback(() => read(++generation.current), [read]);

  useEffect(() => {
    if (!authReady) return undefined;
    const tick = () => read(++generation.current);
    tick();
    const stopPolling = pollWhileVisible(tick, pollMs);
    return () => {
      stopPolling();
      // Supersede the read in flight: its result is dropped.
      generation.current += 1;
    };
  }, [authReady, pollMs, read]);

  /**
   * Record a result this browser produced, and keep the server's copy (its
   * time is the server's clock) once it lands. Never throws.
   */
  const record = useCallback(async (probeId, result, durationMs) => {
    const saved = await recordProbeResult(probeId, result, durationMs);
    if (saved) {
      setStored((previous) => ({
        ...previous,
        results: {
          ...previous.results,
          [probeId]: newestResult(previous.results[probeId], saved),
        },
      }));
    }
    return saved || null;
  }, []);

  return {
    results: stored.results,
    pulse: stored.pulse,
    loaded,
    error,
    now,
    refresh,
    record,
  };
}
