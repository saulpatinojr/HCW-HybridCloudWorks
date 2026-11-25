/**
 * canary.js — `labCanary`, one real lab job an hour, run end to end (#1009,
 * "PR 2: prevent recurrence", item 2).
 *
 * From 2026-10-07T04:35Z no lab job ran for days and nothing said so: the
 * admin Labs probe enqueues a job and cancels it, so it passes with no agent
 * at all, and the LAB-5 job path had never run a real job in production. This
 * runs one: a `shell-echo` job with a fixed, tiny payload, enqueued exactly as
 * enqueueLabJob writes one, then waited for until the agent has claimed it,
 * run it in its sandbox and reported the result. The output must be the
 * payload, byte for byte, or the run failed.
 *
 * Behind its own flag, FEATURE_FLAG_LAB_CANARY, armed by adding LAB_CANARY to
 * the `enabled_timers` workspace variable, as every timer is
 * (functions/schedulers.js). It is a real job on the owner's host every hour,
 * so it runs only once the owner has said so.
 *
 * NEVER LEAVES A JOB BEHIND. The job is deleted once it has a terminal status,
 * under the ETag of the read that saw it terminal. One still queued at the
 * deadline is cancelled and deleted, each under its ETag; if the agent claims
 * it in between, the 412 says so and it is left to finish. One claimed but
 * not finished is left alone (the agent holds it, and a job pulled from under
 * a running agent only turns into agent errors), its id kept as
 * `pendingJobId`; the next run deletes it once it has finished, or, past the
 * claim lease and a grace, cancels and deletes it, since no agent is then
 * coming back for it. While it is still legitimately running, the next run
 * enqueues nothing and says so. So the Labs job list holds at most one canary
 * job at a time, and only while it is in flight.
 *
 * THE ID IS RESERVED BEFORE THE JOB EXISTS (CodeRabbit, #1055). A run writes
 * the new job's id to the record as `pendingJobId`, under the record's ETag,
 * and only then creates the job; the run's last write clears it or keeps it.
 * So an invocation that dies, or a record that cannot be written, after the
 * create still leaves the id where the next run looks, and that run settles
 * the job before it enqueues anything. A reservation for a job that was never
 * created is read as gone, and costs nothing.
 *
 * ONE RUN HOLDS THE RECORD AT A TIME (CodeRabbit, #1056). The ETag on the
 * record does not fence runs from each other: each write re-reads first, so
 * a second invocation that read the first's reservation could replace it
 * with its own, and its last write could then clear it, losing a job. So the
 * reservation also names its owner, `activeRun: { jobId, since }`. A run
 * that finds another run's `activeRun` younger than CANARY_RUN_HOLD_MS
 * touches nothing (no settling, no reservation, no record) and says so; a
 * run's last write clears `activeRun` only when it is its own, and keeps
 * another run's `activeRun` and `pendingJobId` as they are. An `activeRun`
 * older than the hold is a run that died, and the next run takes over,
 * settling its job through `pendingJobId` as above. The Functions host runs
 * a timer as a singleton, so two runs at once are not expected; this holds
 * if they ever are (a manual run, a second deployment slot).
 *
 * NOT ENQUEUED INTO A VOID. With no active agent registered for `shell-echo`,
 * or none online, the run records that (a registry or an outage, which the
 * lab-agents probe already reports) and enqueues nothing, so a host that is
 * down does not collect a queue of canaries to run when it returns.
 *
 * WHAT IT RECORDS. One document, admin_config/lab_canary: the last run's
 * outcome with its timings (claim latency, run time, total), the last
 * success, the last failure, how many failed in a row, and any job still in
 * flight. Written read-merge-write under the document's ETag. The Health
 * Hub's `lab-canary` probe judges it (labs/lab-checks.js), recorded by the
 * pulse every five minutes; failure is raised there, not healed here.
 *
 * Telemetry is content-free: a warn line names the outcome, never the job's
 * id, the agent's or the payload.
 */
import { randomUUID } from 'node:crypto';

import { runCanary } from './canary-run.js';

export {
  CANARY_ABANDON_GRACE_MS,
  CANARY_JOB_TYPE,
  CANARY_POLL_MS,
  CANARY_REQUESTER,
  CANARY_RUN_HOLD_MS,
  CANARY_WAIT_MS,
  LAB_CANARY_DOC_ID,
  LAB_CANARY_DOC_TYPE,
  UNREACHED_OUTCOMES,
  canaryJob,
  canaryPayload,
  judgeJob,
} from './canary-model.js';

/**
 * @param {object} deps
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function,
 *   deleteDocIfMatch: Function, queryDocs: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => string} [deps.uuid]
 * @param {object} [deps.log] the invocation context
 */
export function createLabCanary({
  store,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  uuid = randomUUID,
  log = {},
}) {
  const deps = { store, now, sleep, uuid, log };
  return { run: () => runCanary(deps) };
}
