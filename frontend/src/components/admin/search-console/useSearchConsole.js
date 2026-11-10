/**
 * The Search Console report and the Run now button's request.
 *
 * The report is read once (`GET cms/search-console`) and handed to every tab,
 * through the shared race-safe read (components/admin/shared/useGuardedLoad):
 * only the newest read may set state, and a failed read empties the report
 * rather than leaving old figures beside an error.
 *
 * Run now (`POST cms/search-console/run`) only queues a run; the server
 * answers 202 at once and the run takes about ten minutes (about 400 pages,
 * each one a separate question to Google; the first real run on 2026-11-10
 * took 8 minutes 47 seconds). So after a queued run the report is read again
 * every 30 seconds, for up to 60 minutes, until it shows a newer run, and
 * then the page has the new figures without a reload. The hour counts from
 * the press and covers the slowest path: the jobs sweeper (functions
 * jobs-sweeper.js, every 15 minutes) re-sends a queued message only once it
 * is 10 minutes old (lib/jobs.js STALE_QUEUED_MS), so a job pressed just
 * after a sweep can wait about 25 minutes to start, and it then has its
 * whole 28-minute budget (SYNC_JOB_TIMEOUT_MS in the functions'
 * lib/search-console/handlers.js): about 53 minutes. A read every 30 seconds
 * is one small document, so the longer wait costs little. At 15 minutes the
 * page often stopped looking before an ordinary run had landed.
 * Those background reads are quiet: one that fails leaves the report on
 * screen as it was and the next one tries again, because a dropped poll is
 * not a reason to blank a page the owner is reading.
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
export const POLL_FOR_MS = 60 * 60_000;

const describeError = (err) => err?.message || 'The Search Console report could not be read.';

const loadReport = async () => normalizeReport(await getJSON(SEARCH_CONSOLE_ROUTE));

/** Which run a report shows, so the page can tell when a newer one has landed. */
const runStamp = (report) => report?.run?.finishedAt ?? report?.generatedAt ?? null;

/** The server's sentence after "error — ", as lib/api.js joins them, or null. */
const serverSentence = (error) => {
  const text = String(error?.message ?? '');
  const at = text.indexOf(' — ');
  return at >= 0 ? text.slice(at + 3).trim() || null : null;
};

/** The toast for each answer to Run now. Exported for the tests. */
export function runNowToast(outcome) {
  if (outcome.ok) {
    if (outcome.alreadyRunning || outcome.alreadyQueued) {
      return {
        title: 'A run is already going',
        description:
          'Another run started first, so no second one was queued. The page updates when it finishes.',
      };
    }
    return {
      title: 'Run queued',
      description: 'Queued; the page updates when the run finishes, usually in about ten minutes.',
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
  if (error?.status === 429) {
    return {
      title: 'Today’s Google inspections are used up',
      description:
        serverSentence(error) ??
        'The app’s daily allowance of Google page inspections is used up. It starts again at midnight Pacific time.',
    };
  }
  return {
    title: 'The run could not be started',
    description: `${error?.message || 'The request failed.'} Try again in a minute; if it keeps failing, check the Health page.`,
    variant: 'destructive',
  };
}

/** The 202's body, or {} when it has none or it is not JSON. */
async function readAnswer(response) {
  try {
    const body = await response?.json?.();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

export default function useSearchConsole() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const guarded = useGuardedLoad(loadReport, { enabled: authReady, empty: null, describeError });
  const { refresh } = guarded;
  const [starting, setStarting] = useState(false);
  // Set while the page waits for a queued run: the run it is waiting to replace.
  const [waiting, setWaiting] = useState(null);
  // The newest report a background read brought, and when it landed.
  const [polled, setPolled] = useState(null);

  // A background read's report wins only over an older guarded one, so a
  // later "Try again" or refresh still shows what it read.
  const guardedAt = guarded.loadedAt ? guarded.loadedAt.getTime() : 0;
  const report = polled && polled.at > guardedAt ? polled.report : guarded.data;

  const reportRef = useRef(report);
  useEffect(() => {
    reportRef.current = report;
  }, [report]);

  // Re-read on a timer while waiting; stop when a newer run shows or time is up.
  useEffect(() => {
    if (!waiting) return undefined;
    let live = true;
    const timer = setInterval(async () => {
      if (Date.now() - waiting.since > POLL_FOR_MS) {
        setWaiting(null);
        return;
      }
      try {
        const next = await loadReport();
        if (live) setPolled({ report: next, at: Date.now() });
      } catch {
        // Quiet on purpose: keep what is on screen; the next tick tries again.
      }
    }, POLL_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [waiting]);

  const currentStamp = runStamp(report);
  if (waiting && currentStamp && currentStamp !== waiting.stamp) {
    setWaiting(null);
  }

  const runNow = useCallback(async () => {
    setStarting(true);
    let outcome;
    try {
      // authedFetch rather than postJSON: the 202's body is read only if it has one.
      const response = await authedFetch(SEARCH_CONSOLE_RUN_ROUTE, { method: 'POST', body: '{}' });
      const answer = await readAnswer(response);
      outcome = {
        ok: true,
        alreadyRunning: answer.alreadyRunning === true,
        alreadyQueued: answer.alreadyQueued === true,
      };
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
    report,
    pending: guarded.pending,
    error: guarded.error,
    refresh,
    runNow,
    starting,
    waiting: Boolean(waiting),
  };
}
