/**
 * The agent's active jobs, and what happens to them when the host stops.
 *
 * index.js starts the agent on import, so nothing in it can be unit-tested;
 * the shutdown path lived there, and its one flaw stayed invisible until a
 * read-only review of #1178 (LAB-13, #959): on SIGTERM the agent sent a
 * `stopping` heartbeat, waited up to 210 s for its jobs to finish, then
 * exited with the container still running and nothing terminal written
 * server-side, so the job sat `claimed` until the fifteen-minute lease
 * lapsed (functions/src/lib/lab-agent.js, CLAIM_LEASE_MS) and was re-run
 * beside the orphan. The issue's own acceptance was a terminal status within
 * five seconds.
 *
 * What this module does instead, in the order it happens:
 *
 *  1. Every running job holds an AbortController. On SIGTERM or SIGINT all
 *     of them are aborted at once, before any network call: the runner
 *     kills its `docker run` child, starts removing the container by name
 *     through the socket proxy (lib/docker-runner.js), and resolves
 *     `aborted` without waiting for that removal.
 *  2. `execute` reports an aborted job as `failed`, exit -1, with
 *     INTERRUPTED_OUTPUT. In visitor language: a public lab page may show
 *     a job's result, so the sentence names no vendor, tool or admin-side
 *     state (the repository's rule for public pages).
 *  3. The `stopping` heartbeat closes the public door while those reports
 *     travel. The agent waits for them for at most LABS_AGENT_SHUTDOWN_TIMEOUT_MS
 *     (DEFAULT_SHUTDOWN_TIMEOUT_MS), then sends `offline` and exits. Both
 *     shutdown heartbeats carry SHUTDOWN_HEARTBEAT_TIMEOUT_MS rather than
 *     the client's 20 s default: twice that was most of the old stop budget.
 *
 * A claim still in flight at the signal is waited for inside the same
 * budget (index.js passes its count as `claimsInFlight`). A job it brings
 * back after the signal is never started, because no abort would reach
 * its container before the exit; it is reported interrupted like the rest.
 * A claim that outlasts the budget is the lease's to recover, as before.
 *
 * The unit's TimeoutStopSec (roles/labs_agent, labs_agent_timeout_stop_sec)
 * covers the budget plus both heartbeats with margin, and
 * scripts/lab-job-limits.test.mjs holds that arithmetic. KillMode=mixed
 * there is what makes step 1 the agent's decision: with the default
 * control-group mode systemd sent SIGTERM to the docker CLI children at the
 * same instant, and a job survived only because the proxy refused the
 * forwarded kill.
 *
 * The report window is this module's; the containers are not. A removal
 * may take REMOVE_TIMEOUT_MS (10 s), longer than the default budget, and a
 * crash removes nothing, so the unit sweeps every container carrying the
 * job label as root after this process exits and before the next one
 * starts (roles/labs_agent/files/hcw-labjob-sweep, CodeRabbit on #1188).
 * The report therefore never waits on the removal: each has its own bound,
 * the report this budget and the container the sweep. The removal the
 * runner starts is the fast path; the sweep is the guarantee.
 *
 * Everything the module touches is injected, so lib/shutdown.test.js runs a
 * shutdown against fake jobs, a fake API and a fake exit with no Docker, no
 * network and no signal.
 */

import { runInDocker as runInDockerDefault } from './docker-runner.js';

/** The drain budget when LABS_AGENT_SHUTDOWN_TIMEOUT_MS names none or something unusable. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

/** The client timeout of the `stopping` and `offline` heartbeats. */
export const SHUTDOWN_HEARTBEAT_TIMEOUT_MS = 5000;

/** How often the drain looks again: a report is noticed at most this long after it lands. */
const DRAIN_TICK_MS = 20;

/** What an interrupted job's result says. Visitor language: no vendor, tool or admin-side state. */
export const INTERRUPTED_OUTPUT =
  'The lab host was restarting and this job was interrupted. Submit it again.';

/** The runner's result for a job claimed after the signal, which never reaches `docker run`. */
const NOT_STARTED = Object.freeze({ exitCode: -1, output: '', truncated: false, timedOut: false, aborted: true });

/**
 * The drain budget from the environment: a positive whole number of
 * milliseconds, or the default. Validated the way lib/docker-runner.js
 * validates its numbers, because `Number('abc')` is NaN and a NaN deadline
 * made the old drain zero (review of #1178). A safe integer, so `1e20`,
 * which `Number` reads as a whole number, is refused too.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
export function shutdownTimeoutMs(env = process.env) {
  const requested = Number(env.LABS_AGENT_SHUTDOWN_TIMEOUT_MS);
  return Number.isSafeInteger(requested) && requested > 0 ? requested : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/**
 * @param {object} deps
 * @param {{ completeJob: Function }} deps.api        lib/api.js
 * @param {{ info: Function, error: Function, fault: Function }} deps.log  lib/log.js
 * @param {(status?: string, options?: { timeoutMs?: number }) => Promise<void>} deps.sendHeartbeat
 *   index.js's heartbeat, which never throws and reads `active()` for its count
 * @param {Record<string, object>} deps.capabilities  lib/capabilities.js
 * @param {object} deps.limits                         the job limits from config
 * @param {() => number} [deps.claimsInFlight]          index.js's claims not yet answered
 * @param {typeof runInDockerDefault} [deps.runInDocker]  tests only
 * @param {(code: number) => void} [deps.exit]            tests only
 * @param {Record<string, string|undefined>} [deps.env]   tests only
 */
export function createShutdown({
  api,
  log,
  sendHeartbeat,
  capabilities,
  limits,
  claimsInFlight = () => 0,
  runInDocker = runInDockerDefault,
  exit = (code) => process.exit(code),
  env = process.env,
}) {
  const timeoutMs = shutdownTimeoutMs(env);
  /** One AbortController per job this process is running. */
  const active = new Set();
  let stopping = false;

  /**
   * Runs one claimed job and reports its terminal status: refused when no
   * local recipe matches its type, `failed` with INTERRUPTED_OUTPUT when a
   * shutdown aborted it or its claim came back after the signal, otherwise
   * the container's own result. Never throws; a report that cannot be sent
   * is logged and left to the claim lease.
   *
   * @param {{ id: string, claimId: string, type: string }} job  as lib/api.js claimJob returns it
   * @returns {Promise<void>}
   */
  async function execute(job) {
    const capability = capabilities[job.type];

    // Defence in depth. The server already restricts claims to the agent's
    // registered capabilities, but this process is the thing that would
    // actually run the command, so it refuses anything it has no allowlisted
    // recipe for rather than trusting the response.
    if (!capability) {
      log.error(`refusing a job: no local capability for type ${job.type}`);
      log.info(`refused job ${job.id} (${job.type})`);
      await api
        .completeJob({
          jobId: job.id,
          claimId: job.claimId,
          status: 'failed',
          exitCode: -1,
          output: `agent has no capability for job type ${job.type}`,
        })
        .catch((err) => log.fault('error', 'could not report a refusal', err, `job ${job.id}`));
      return;
    }

    // Tracked before the first await, so index.js's concurrency guard sees
    // the slot taken the moment its claim hands over (T-744), and the drain
    // sees a job whose claim came back after the signal.
    const controller = new AbortController();
    active.add(controller);
    const lateClaim = stopping;
    log.info(lateClaim ? `not starting job ${job.id} (${job.type}): stopping` : `running job ${job.id} (${job.type})`);

    try {
      // The whole claimed job goes in: its id becomes the container's
      // hcw.lab-job label and its payloadEncoding selects how the payload is
      // staged (lib/docker-runner.js).
      const result = lateClaim
        ? NOT_STARTED
        : await runInDocker(capability, job, limits, { signal: controller.signal });
      const status = result.aborted
        ? 'failed'
        : result.timedOut
          ? 'timeout'
          : result.exitCode === 0
            ? 'succeeded'
            : 'failed';

      await api.completeJob({
        jobId: job.id,
        claimId: job.claimId,
        status,
        exitCode: result.aborted ? -1 : result.exitCode,
        output: result.aborted ? INTERRUPTED_OUTPUT : result.output,
      });
      // A failed or timed-out job is the learner's result, not the agent's
      // fault, so it is information; an interrupted one is the host's doing
      // and says so here, on the host's journal.
      log.info(
        `job ${job.id} -> ${status} (exit ${result.exitCode})${result.aborted ? '; interrupted by shutdown' : ''}`
      );
    } catch (err) {
      log.fault('error', 'job errored', err, `job ${job.id}`);
      // Best effort: if this also fails the job's claim lease expires
      // server-side and another agent picks it up, which is why the lease
      // exists.
      await api
        .completeJob({
          jobId: job.id,
          claimId: job.claimId,
          status: 'failed',
          exitCode: -1,
          output: `agent error: ${err.message}`,
        })
        .catch((reportErr) => log.fault('error', 'could not report a failure', reportErr, `job ${job.id}`));
    } finally {
      active.delete(controller);
      // Not while stopping: the shutdown's own `offline` is the last word,
      // and a `stopping` beat from a finishing job could land after it.
      if (!stopping) sendHeartbeat();
    }
  }

  /**
   * Resolves true once no job is running and no claim is unanswered, false
   * at the budget. It looks again every DRAIN_TICK_MS rather than awaiting
   * a fixed list, because a claim that comes back during the drain adds a
   * job to report after the drain began.
   */
  async function drain() {
    const deadline = Date.now() + timeoutMs;
    while (active.size > 0 || claimsInFlight() > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(DRAIN_TICK_MS, left)));
    }
    return true;
  }

  /**
   * The stop, once however many signals arrive: abort every job, send
   * `stopping` beside their reports, wait for them within the budget, send
   * `offline`, exit 0. Containers the drain did not see removed are the
   * unit's sweep's (the module comment says why).
   *
   * @param {string} signal  the signal's name, for the journal line
   * @returns {Promise<void>}
   */
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received; interrupting ${active.size} active job(s), ${timeoutMs} ms to report them`);

    // Abort first, before any round trip: the containers start dying and
    // the terminal reports start travelling at t=0, which is what the
    // five-second acceptance measures.
    for (const controller of active) controller.abort();

    // The `stopping` beat closes the public door. It travels beside the
    // reports rather than ahead of them, so a slow API cannot spend the
    // job's budget on a heartbeat.
    const stoppingBeat = sendHeartbeat('stopping', { timeoutMs: SHUTDOWN_HEARTBEAT_TIMEOUT_MS });
    const reported = await drain();
    await stoppingBeat;

    if (!reported) {
      // Collected (lib/log.js): what happened and two counts, no
      // identifiers. What is left is the lease's to recover.
      log.error(
        `shutdown budget of ${timeoutMs} ms exceeded with ${active.size} job(s) unreported and ${claimsInFlight()} claim(s) unanswered, exiting`
      );
    }

    await sendHeartbeat('offline', { timeoutMs: SHUTDOWN_HEARTBEAT_TIMEOUT_MS });
    exit(0);
  }

  return {
    execute,
    /** How many jobs are running, for the heartbeat and the concurrency guard. */
    active: () => active.size,
    /** True from the first signal on; the poll loop and the heartbeat default read it. */
    get stopping() {
      return stopping;
    },
    shutdown,
    timeoutMs,
  };
}
