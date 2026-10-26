/**
 * The visitor-session sweep, run on its own by a timer (#1403, item 1).
 *
 * `reapExpiredVisitorSessions` (lib/labs/visitor-session.js) ends visitor lab
 * sessions past their hour and retries the clean-ups Coder has not yet
 * confirmed. Until this timer, only a visitor reading the lab's status or
 * starting a session ran it, so with no visitors, or with
 * `LABS_VISITOR_SESSIONS_ENABLED` off (the status route answers before it
 * sweeps), a session waiting for its clean-up waited: a Coder user and a host
 * workspace slot stayed behind until someone came by. This is that sweep on a
 * schedule. The registration, the schedule and the gate are in
 * functions/src/functions/visitor-session-sweep.js; this file is what one run
 * does, kept apart from the host so a test can drive it with a fake store and a
 * fake Coder.
 *
 * WHAT ONE RUN DOES. It reads the broker's Coder settings, and with them runs
 * the sweep once with the real store and `fetch`. The sweep takes up at most
 * MAX_SWEEP_SESSIONS sessions, every Coder call carries its own timeout
 * (CODER_CALL_TIMEOUT_MS), and it claims a session with a conditional write
 * before it calls Coder, so a timer run that overlaps an in-request sweep, or
 * another run, cannot make a second set of Coder calls for the same session.
 *
 * WHAT IT NEVER DOES. It never creates a session or a Coder user: the store it
 * is given has the three verbs the sweep uses and no `createDoc`, and the sweep
 * has no code that provisions. It does not read `LABS_VISITOR_SESSIONS_ENABLED`
 * either, on purpose: that switch closes the door to new visitors, and turning
 * it off while sessions exist must not strand their Coder users and workspaces.
 *
 * WHEN CODER IS NOT SET UP it does nothing at all, not even a query. "Set up"
 * means `CODER_URL` AND a resolved `CODER_BROKER_TOKEN` (`readBrokerConfig`
 * returns null otherwise; it does not fall back to the read-only status token,
 * which cannot delete anything, so every try with it would be refused and
 * spent). The sweep given no usable Coder settings would still spend a try on
 * each session that has something there to delete, and five tries end a
 * session as `cleanup_failed`; the five tries come at about 0, 2, 6, 12 and 20
 * minutes in the best case (each wait is the base times the try number, and a
 * run that starts late in its tick can push a retry one tick later), so a timer
 * running every two minutes against a missing setting would give up on every
 * waiting session in roughly twenty to thirty minutes.
 *
 * THE COST OF UNATTENDED TRIES. Before the timer, tries were spent only when a
 * visitor arrived, so a quiet site waited out a Coder or token outage. Now they
 * are spent on the clock, and an outage that lasts longer than the tries do
 * (about twenty to thirty minutes) leaves the waiting sessions as
 * `cleanup_failed`, for a person (docs/runbooks/labs-host.md says how). No alert
 * reads these lines yet: that is in #1403.
 *
 * WHAT IT LOGS: counts and kinds, never a session id, a Coder id or user name,
 * or any text Coder or Cosmos sent. The sweep's own lines are already that (its
 * `log` is given `context.warn`, so they reach Log Analytics, which the status
 * route's background sweep could not do); the summary adds four numbers. It
 * never throws: a failure is one Warning line naming only the kind of error,
 * and the next tick tries again (the timer trigger does not retry a failed run,
 * Microsoft Learn: "Timer trigger for Azure Functions", Retry behavior).
 */
import { errorKind, readBrokerConfig, reapExpiredVisitorSessions } from '../labs/visitor-session.js';

export const SWEEP_NAME = 'sweepVisitorSessions';

/**
 * Whether the unconfigured-Coder warning has been given since the last time the
 * sweep ran with Coder set up. The first is a Warning, which ships to Log
 * Analytics; later ones drop to Information, so a Coder that is deliberately
 * not set up does not raise a Warning every two minutes (the same
 * once-per-restart rule as flag-gate.js's logDisabledSkip). A run that finds
 * Coder set up re-arms it, so a second loss of the settings is a Warning too.
 */
let unconfiguredWarned = false;

/**
 * Write one line at a level without letting the logging fail the run. The
 * method is looked up inside the guard, so a context that is null, has no such
 * method, or has one that throws is all the same to the caller.
 */
function say(context, level, line) {
  try {
    context[level]?.(line);
  } catch {
    // Nothing more can be done with a context that will not take a line.
  }
}

/**
 * @param {object} deps
 * @param {{ queryDocs: Function, readDoc: Function, replaceDocIfMatch: Function }} deps.store -
 *   only the verbs the sweep uses; no `createDoc`, so it cannot create anything
 * @param {Function} [deps.fetchImpl] - Coder's HTTP client; the global `fetch` when omitted
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [deps.env]
 * @param {() => number} [deps.now] - epoch ms
 */
export function createVisitorSessionSweep({
  store,
  fetchImpl = (...args) => globalThis.fetch(...args),
  env = process.env,
  now = () => Date.now(),
}) {
  return {
    /**
     * One run. Never throws.
     *
     * @param {{ log?: Function, warn?: Function } | null | undefined} context - the invocation's
     * @returns {Promise<{ swept: boolean, reason?: 'unconfigured' | 'error', reaped?: number, finished?: number, pending?: number, failed?: number }>}
     */
    async run(context) {
      const tag = `[${SWEEP_NAME}]`;
      try {
        // Coder's address and the resolved broker token; null when either is missing.
        const config = readBrokerConfig(env);
        if (!config) {
          say(
            context,
            unconfiguredWarned ? 'log' : 'warn',
            `${tag} Coder is not set up (CODER_URL and CODER_BROKER_TOKEN): nothing swept, and no clean-up try spent`
          );
          unconfiguredWarned = true;
          return { swept: false, reason: 'unconfigured' };
        }
        unconfiguredWarned = false;

        const tally = await reapExpiredVisitorSessions(store, fetchImpl, config, {
          nowIso: new Date(now()).toISOString(),
          log: (line) => say(context, 'warn', line),
        });

        const busy = tally.reaped + tally.finished + tally.pending + tally.failed > 0;
        say(
          context,
          busy ? 'warn' : 'log',
          `${tag} reaped=${tally.reaped} finished=${tally.finished} pending=${tally.pending} failed=${tally.failed}`
        );
        return { swept: true, ...tally };
      } catch (error) {
        say(context, 'warn', `${tag} the sweep could not run (${errorKind(error)})`);
        return { swept: false, reason: 'error' };
      }
    },
  };
}

/** Test seam: the once-per-process memory of the unconfigured warning. */
export function resetUnconfiguredWarning() {
  unconfiguredWarned = false;
}
