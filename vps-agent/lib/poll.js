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
 * The tick also answers the hold (CodeRabbit's second round on #1191).
 * While it is in force and nothing is in flight or running, the tick writes
 * the acknowledgement the reboot script waits for; while it is in force and
 * anything is, or once it lifts, the tick withdraws it. A tick is the only
 * place that changes either count's direction towards work (claims start
 * here and nowhere else), so an acknowledgement written here stays true
 * until a tick says otherwise.
 *
 * Everything it touches is injected, so lib/poll.test.js runs it against a
 * fake API, a fake supervisor, a fake hold and a fake acknowledger.
 */

/** No hold, and nothing to acknowledge: the defaults for a poller built without them. */
const NO_HOLD = () => ({ held: false, expiry: null });
const NO_ACK = Object.freeze({ acknowledge() {}, withdraw() {} });

/**
 * @param {object} deps
 * @param {{ claimJob: () => Promise<object|null> }} deps.api           lib/api.js
 * @param {{ stopping: boolean, active: () => number, execute: (job: object) => Promise<void> }} deps.supervisor
 *   lib/shutdown.js
 * @param {{ fault: Function }} deps.log                                 lib/log.js
 * @param {number} deps.maxConcurrentJobs                                LABS_AGENT_MAX_CONCURRENT
 * @param {() => { held: boolean, expiry: string|null }} [deps.hold]
 *   lib/maintenance-hold.js's gate: whether the host's hold is in force, and its expiry
 * @param {{ acknowledge: (expiry: string) => void, withdraw: () => void }} [deps.ack]
 *   lib/maintenance-hold.js's acknowledger
 * @returns {{ poll: () => Promise<void>, inFlight: () => number }}
 */
export function createPoller({ api, supervisor, log, maxConcurrentJobs, hold = NO_HOLD, ack = NO_ACK }) {
  // Claims in flight: decided on, not yet owned by the supervisor's execute.
  // Counted separately from its active count so the concurrency guard cannot
  // be raced by a slow claim (T-744).
  let pendingClaims = 0;

  /**
   * One tick: answer the hold, then make one claim attempt, refused while
   * stopping, while the hold is in force, or with every slot taken or
   * promised.
   *
   * @returns {Promise<void>}
   */
  async function poll() {
    if (supervisor.stopping) {
      ack.withdraw();
      return;
    }

    // The hold is read first, on every tick and whatever the slots say, so
    // an acknowledgement is withdrawn the tick anything is in flight or
    // running. Everything from here to the reservation below is synchronous:
    // no await sits between the guard and the reservation (T-744).
    const now = hold();
    const idle = pendingClaims === 0 && supervisor.active() === 0;
    if (now.held) {
      // A hold with no readable expiry cannot be answered; the script then
      // waits out its bound and defers, which is the safe way to be wrong.
      if (idle && now.expiry) ack.acknowledge(now.expiry);
      else ack.withdraw();
      return;
    }
    ack.withdraw();

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
    if (supervisor.active() + pendingClaims >= maxConcurrentJobs) return;

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
