/**
 * The agent's claim loop: one claim attempt per tick of index.js's poll
 * timer.
 *
 * It lived in index.js, which starts the agent on import, so nothing about
 * it could be tested. It moved here when it gained a third reason to refuse
 * a claim (LAB-13, #959): the host's maintenance hold, which
 * hcw-reboot-when-idle writes before its second look at an idle host
 * (lib/maintenance-hold.js says why). The two older reasons are unchanged:
 * the agent is stopping (lib/shutdown.js), or every job slot is taken or
 * promised to a claim still in flight (T-744).
 *
 * Everything it touches is injected, so lib/poll.test.js runs it against a
 * fake API, a fake supervisor and a fake hold.
 */

/**
 * @param {object} deps
 * @param {{ claimJob: () => Promise<object|null> }} deps.api           lib/api.js
 * @param {{ stopping: boolean, active: () => number, execute: (job: object) => Promise<void> }} deps.supervisor
 *   lib/shutdown.js
 * @param {{ fault: Function }} deps.log                                 lib/log.js
 * @param {number} deps.maxConcurrentJobs                                LABS_AGENT_MAX_CONCURRENT
 * @param {() => boolean} [deps.held]  lib/maintenance-hold.js's gate: true while the host's hold is in force
 * @returns {{ poll: () => Promise<void>, inFlight: () => number }}
 */
export function createPoller({ api, supervisor, log, maxConcurrentJobs, held = () => false }) {
  // Claims in flight: decided on, not yet owned by the supervisor's execute.
  // Counted separately from its active count so the concurrency guard cannot
  // be raced by a slow claim (T-744).
  let pendingClaims = 0;

  /**
   * One claim attempt, refused while stopping, with every slot taken or
   * promised, or while the host's maintenance hold is in force.
   *
   * @returns {Promise<void>}
   */
  async function poll() {
    // The slot is reserved BEFORE the await, not after (T-744). The active
    // count only moves inside the supervisor's execute, which runs after
    // claimJob resolves — and claimJob's timeout (20s) is longer than the poll
    // interval (15s), so a slow claim let a second poll pass this guard with
    // the counter still at its old value. With the documented
    // LABS_AGENT_MAX_CONCURRENT=1 and a 512 MB / 0.5 CPU budget per job, two
    // concurrent Terraform containers is a real resource-exhaustion path on a
    // small VPS.
    //
    // pendingClaims covers exactly the window between "we decided to claim" and
    // "execute owns the slot", so the guard reflects work already committed
    // to rather than only work already started.
    if (supervisor.stopping || supervisor.active() + pendingClaims >= maxConcurrentJobs) return;

    // The hold is read synchronously, so no await sits between the guard
    // above and the reservation below. A claim this check lets through
    // before the hold appears is the one the reboot script's settle wait
    // exists for.
    if (held()) return;

    pendingClaims += 1;
    try {
      const job = await api.claimJob();
      if (!job) return;
      supervisor.execute(job); // intentionally not awaited — the poll interval continues
    } catch (err) {
      log.fault('warn', 'claim failed', err);
    } finally {
      // Released in every path. On the path that takes a slot, execute tracks
      // the job with no await in front of it, so the handoff from
      // pendingClaims to the active count has no gap. Its one earlier await is
      // in the "no capability for this job type" branch, which returns without
      // taking a slot — nothing to hand over there.
      pendingClaims -= 1;
    }
  }

  return {
    poll,
    /** Claims sent and not yet answered, for the shutdown's drain (lib/shutdown.js, claimsInFlight). */
    inFlight: () => pendingClaims,
  };
}
