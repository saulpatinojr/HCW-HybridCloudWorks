/**
 * The ElevenLabs card's reads: the status (plan, credits, last render and
 * sample) and the live check. ElevenLabsCard.jsx re-exports what it shared.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/ui/use-toast';
import { getJSON, postJSON } from '@/lib/api';

export const ELEVENLABS_STATUS_ROUTE = 'cms/podcast/elevenlabs';
export const ELEVENLABS_SAMPLE_ROUTE = 'cms/podcast/elevenlabs/sample';

/** A whole number as the card shows it, or a dash when there is none. */
export const count = (n) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—';

/**
 * The status read. Race-safe the way `useSetting` is: a load only writes
 * state while it is the newest, so a slow first load cannot land over a
 * retry and an unmounted card's load writes nothing.
 */
function useElevenLabsStatus(authReady) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    if (!authReady) return undefined;
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    getJSON(ELEVENLABS_STATUS_ROUTE)
      .then((response) => {
        if (current()) {
          setStatus(response ?? null);
          setError(null);
        }
      })
      .catch((err) => {
        if (current()) {
          setStatus(null);
          setError(err?.message ?? 'Could not load the ElevenLabs status.');
        }
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      if (current()) generation.current += 1;
    };
  }, [authReady, attempt]);

  const reload = useCallback(() => {
    generation.current += 1;
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { status, loading, error, reload };
}

/**
 * The live check, run on a click and never on load, because it spends
 * credits. A second click while one is running sends nothing. `onRendered`
 * re-reads the status so the figures above show the spend.
 */
function useLiveCheck(onRendered) {
  const [sample, setSample] = useState(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const { toast } = useToast();

  const runSample = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const result = await postJSON(ELEVENLABS_SAMPLE_ROUTE, {});
      setSample(result ?? null);
      toast({
        title: 'Live check rendered',
        description: `${count(result?.charactersBilled)} characters billed; ${count(result?.creditsLeft)} credits left.`,
      });
      onRendered();
    } catch (err) {
      const message = err?.message ?? 'The live check failed.';
      setSample({ error: message, code: err?.code ?? null });
      toast({ title: 'Live check not rendered', description: message, variant: 'destructive' });
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [onRendered, toast]);

  return { sample, running, runSample };
}

/** The status read and the live check, for the card. */
export function useElevenLabs(authReady) {
  const status = useElevenLabsStatus(authReady);
  const check = useLiveCheck(status.reload);
  return { ...status, ...check };
}
