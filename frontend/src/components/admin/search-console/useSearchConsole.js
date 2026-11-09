/**
 * The Search Console report and the Run now button's request.
 *
 * The report is read once (`GET cms/search-console`) and handed to every tab,
 * through the shared race-safe read (components/admin/shared/useGuardedLoad):
 * only the newest read may set state, and a failed read empties the report
 * rather than leaving old figures beside an error.
 *
 * Run now (`POST cms/search-console/run`) only queues a run; the server
 * answers 202 at once and the run takes a few minutes. So after a queued run
 * the report is read again every 30 seconds, for up to 15 minutes, until it
 * shows a newer run, and then the page has the new figures without a reload.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { useToast } from '@/components/ui/use-toast';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { authedFetch, getJSON } from '@/lib/api';
import {
  SEARCH_CONSOLE_ROUTE,
  SEARCH_CONSOLE_RUN_ROUTE,
  normalizeReport,
} from '@/lib/searchConsole';

/** How often, and for how long, the page re-reads after Run now. */
export const POLL_EVERY_MS = 30_000;
export const POLL_FOR_MS = 15 * 60_000;

const describeError = (err) => err?.message || 'The Search Console report could not be read.';

const loadReport = async () => normalizeReport(await getJSON(SEARCH_CONSOLE_ROUTE));

/** Which run a report shows, so the page can tell when a newer one has landed. */
const runStamp = (report) => report?.run?.finishedAt ?? report?.generatedAt ?? null;

/** The toast for each answer to Run now. Exported for the tests. */
export function runNowToast(outcome) {
  if (outcome.ok) {
    return {
      title: 'Run queued',
      description: 'Queued; the page updates when the run finishes, usually a few minutes.',
    };
  }
  const { error } = outcome;
  const notConfigured =
    error?.status === 409 &&
    (error.code === 'not_configured' || /not[_ ]configured/i.test(error.message ?? ''));
  if (notConfigured) {
    return {
      title: 'Google sign-in is not set up yet',
      description:
        'The site cannot ask Google until the owner finishes the Google setup in the Search Console runbook. Nothing was run.',
      variant: 'destructive',
    };
  }
  return {
    title: 'The run could not be started',
    description: `${error?.message || 'The request failed.'} Try again in a minute; if it keeps failing, check the Health page.`,
    variant: 'destructive',
  };
}

export default function useSearchConsole() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const guarded = useGuardedLoad(loadReport, { enabled: authReady, empty: null, describeError });
  const { refresh } = guarded;
  const [starting, setStarting] = useState(false);
  // Set while the page waits for a queued run: the run it is waiting to replace.
  const [waiting, setWaiting] = useState(null);
  const reportRef = useRef(guarded.data);
  useEffect(() => {
    reportRef.current = guarded.data;
  }, [guarded.data]);

  // Re-read on a timer while waiting; stop when a newer run shows or time is up.
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => {
      if (Date.now() - waiting.since > POLL_FOR_MS) {
        setWaiting(null);
        return;
      }
      refresh();
    }, POLL_EVERY_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const currentStamp = runStamp(guarded.data);
  if (waiting && currentStamp && currentStamp !== waiting.stamp) {
    setWaiting(null);
  }

  const runNow = useCallback(async () => {
    setStarting(true);
    let outcome;
    try {
      // authedFetch rather than postJSON: a 202 may carry no body to parse.
      await authedFetch(SEARCH_CONSOLE_RUN_ROUTE, { method: 'POST', body: '{}' });
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      setStarting(false);
    }
    toast(runNowToast(outcome));
    if (outcome.ok) setWaiting({ since: Date.now(), stamp: runStamp(reportRef.current) });
    return outcome.ok;
  }, [toast]);

  return {
    report: guarded.data,
    pending: guarded.pending,
    error: guarded.error,
    refresh,
    runNow,
    starting,
    waiting: Boolean(waiting),
  };
}
