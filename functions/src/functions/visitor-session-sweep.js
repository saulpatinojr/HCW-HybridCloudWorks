/**
 * visitor-session-sweep.js — the visitor lab session sweep, on a timer (#1403, item 1).
 *
 * Every two minutes, end the visitor lab sessions that are past their hour and
 * retry the Coder clean-ups that Coder has not yet confirmed
 * (`reapExpiredVisitorSessions`, lib/labs/visitor-session.js). What one run does
 * and what it never does are in lib/timers/visitor-session-sweep.js. The sweep
 * used to run only when a visitor read the lab's status or started a session,
 * so a session waiting for its clean-up, and the Coder user and host workspace
 * slot it held, waited for the next visitor.
 *
 * WHY EVERY TWO MINUTES. The numbers it has to fit are in visitor-session.js: a
 * clean-up Coder refuses is tried again after 2, 4, 6 and 8 minutes
 * (CLEANUP_RETRY_BASE_MS), a claim whose holder died is taken over after 5
 * (CLEANUP_LEASE_MS), and a session lasts 60. Two minutes is the retry base, so
 * each of those lands within about one tick of when it is due (a retry waits
 * one tick longer when the next run starts a moment before its time). Five
 * minutes would turn the 2-minute retry into a 5-minute one and the 5-minute
 * takeover into up to 10; one minute would double the runs for no gain, because
 * the in-request sweep (at most once a minute per worker) already covers the
 * moments when visitors are about. The cost of a run with nothing to do is
 * two queries on `lab_jobs` (expired active sessions; then, in one query,
 * every record whose next try is due), so 720 runs a day are about 1,440
 * queries and no Coder call. Not measured against the live account (request units per query are
 * Cosmos's to say); the bound is structural.
 *
 * OVERLAP. The Functions host runs one instance of a timer across all scaled-out
 * instances and does not fire it again while an invocation is still running
 * (Microsoft Learn, "Timer trigger for Azure Functions", Scale-out). A run
 * longer than two minutes is possible only against a Coder that answers slowly
 * (a hung Coder ends each session's chain at its first 10-second call, about
 * 100 seconds for ten sessions), and then ticks are skipped rather than
 * stacked. That is not relied on: the sweep claims a session with a conditional
 * write before it calls Coder, so a timer run that meets an in-request sweep on
 * another worker, or a duplicate run, makes no second set of Coder calls. The
 * in-request sweep stays, with its once-a-minute throttle: it frees a session
 * the moment a visitor is about and it is the only sweep while this timer is
 * off.
 *
 * Gated like every timer (lib/timers/flag-gate.js): the master
 * `FEATURE_FLAG_SCHEDULERS` must not be "false" AND
 * `FEATURE_FLAG_SWEEP_VISITOR_SESSIONS` must be "true". The flag is in
 * `local.timer_catalogue` (infra/functionapp.tf), arms through `enabled_timers`
 * and is off until the owner adds `SWEEP_VISITOR_SESSIONS`. It does NOT depend
 * on LABS_VISITOR_SESSIONS_ENABLED: see lib/timers/visitor-session-sweep.js.
 * The app clock is UTC (#416), but a schedule with no hour in it has no
 * time-zone dependence.
 *
 * Never throws out of the handler: a failed run is one Warning line with the
 * kind of error, and the next tick tries again.
 */
import { app } from '@azure/functions';
import { queryDocs, readDoc, replaceDocIfMatch } from '../lib/cosmos-client.js';
import { logDisabledSkip, timerEnabled } from '../lib/timers/flag-gate.js';
import { createVisitorSessionSweep } from '../lib/timers/visitor-session-sweep.js';

export const TIMER_NAME = 'sweepVisitorSessions';
export const TIMER_FLAG = 'SWEEP_VISITOR_SESSIONS';
/** Every two minutes, on the even minute. */
export const TIMER_SCHEDULE = '0 */2 * * * *';

/**
 * The store the sweep is given: the three verbs it uses and nothing that
 * creates a document, so a timer that runs on its own cannot create a session.
 * A test holds this list to exactly these names.
 */
export const SWEEP_STORE = Object.freeze({ queryDocs, readDoc, replaceDocIfMatch });

/** "true" arms it; the schedulers master switch still holds it off. */
export const sweepEnabled = (env = process.env) => timerEnabled(TIMER_FLAG, env);

const sweep = createVisitorSessionSweep({ store: SWEEP_STORE });

app.timer(TIMER_NAME, {
  schedule: TIMER_SCHEDULE,
  handler: async (_timer, context) => {
    try {
      if (!sweepEnabled()) {
        logDisabledSkip(context, TIMER_NAME);
        return;
      }
      await sweep.run(context);
    } catch {
      // sweep.run does not throw, but the gate can: its skip line is written
      // through the invocation's context, which may refuse it. This is the last
      // wall, so that nothing can escape the handler and fail the run.
    }
  },
});
