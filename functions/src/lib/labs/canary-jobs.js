/**
 * labs/canary-jobs.js — the canary's job in lab_jobs (canary-run.js runs
 * the canary; canary.js has the header that explains it): whether an agent
 * could take one, following it to the end, and withdrawing or deleting it,
 * each write under the ETag it was read with. `deps` is the run's
 * `{ store, now, sleep, uuid, log }`.
 */
import { isAgentOnline } from '../labs.js';
import { CLAIM_LEASE_MS } from '../lab-agent.js';
import {
  CANARY_ABANDON_GRACE_MS,
  CANARY_JOB_TYPE,
  CANARY_POLL_MS,
  CANARY_REQUESTER,
  CANARY_WAIT_MS,
  TERMINAL,
  canaryPayload,
  isRace,
  judgeJob,
  msOf,
} from './canary-model.js';

/** Delete a job under the ETag it was read with. True when it is gone. */
export async function remove(deps, job) {
  try {
    await deps.store.deleteDocIfMatch('lab_jobs', job.id, job._etag, job.id);
    return true;
  } catch (error) {
    if (error?.code === 404) return true;
    if (error?.code === 412) return false;
    throw error;
  }
}

/** Cancel a queued job, then delete it, each under its ETag. True when it is gone. */
export async function withdraw(deps, job) {
  let cancelled;
  try {
    cancelled = await deps.store.replaceDocIfMatch(
      'lab_jobs',
      { ...job, status: 'cancelled', finishedAt: deps.now().toISOString(), cancelledBy: CANARY_REQUESTER },
      { partitionKey: job.id }
    );
  } catch (error) {
    if (isRace(error)) return false;
    throw error;
  }
  return remove(deps, cancelled ?? job);
}

/**
 * The job a previous run could not delete: gone, deleted now, or still in
 * flight (`{ inFlight: true }`), which stops this run enqueueing another.
 */
export async function settleLeftover(deps, jobId) {
  const job = jobId ? await deps.store.readDoc('lab_jobs', jobId, jobId) : null;
  if (!job) return { inFlight: false };
  if (TERMINAL.includes(job.status)) return { inFlight: !(await remove(deps, job)) };
  if (job.status === 'queued') return { inFlight: !(await withdraw(deps, job)) };
  // Claimed. Past the lease and a grace, no agent is finishing it (a live one
  // would have, and a dead one's claim is what the lease is for), so it is
  // withdrawn; within it, it is still running and is left alone.
  const claimedMs = msOf(job.claimedAt) ?? msOf(job.createdAt) ?? 0;
  if (deps.now().getTime() - claimedMs > CLAIM_LEASE_MS + CANARY_ABANDON_GRACE_MS) {
    return { inFlight: !(await withdraw(deps, job)) };
  }
  return { inFlight: true, since: job.claimedAt ?? job.createdAt };
}

/** Why no job should be enqueued now, as an outcome; null when one should. */
export async function precondition(deps, nowMs) {
  const agents = await deps.store.queryDocs(
    'lab_agents',
    'SELECT TOP 200 c.id, c.active, c.capabilities, c.status, c.lastSeenAt FROM c',
    []
  );
  const able = (agents || []).filter(
    (agent) =>
      agent?.active === true &&
      Array.isArray(agent.capabilities) &&
      agent.capabilities.includes(CANARY_JOB_TYPE)
  );
  if (able.length === 0) {
    return {
      ok: false,
      outcome: 'no-capability',
      reason: `no active agent is registered for ${CANARY_JOB_TYPE}, so nothing could claim the job; nothing was enqueued`,
    };
  }
  if (!able.some((agent) => isAgentOnline(agent, nowMs))) {
    return {
      ok: false,
      outcome: 'no-agent',
      reason: `no agent registered for ${CANARY_JOB_TYPE} is online; nothing was enqueued`,
    };
  }
  return null;
}

/** Poll the job until it is terminal or the deadline passes. The last read either way. */
export async function waitFor(deps, jobId, deadlineMs) {
  let job = null;
  for (;;) {
    job = await deps.store.readDoc('lab_jobs', jobId, jobId);
    if (!job || TERMINAL.includes(job.status)) return job;
    if (deps.now().getTime() >= deadlineMs) return job;
    await deps.sleep(CANARY_POLL_MS);
  }
}

/** The run's verdict on a job that did not finish in time, and whether it is still in flight. */
export async function giveUp(deps, job) {
  if (job?.status === 'queued' && (await withdraw(deps, job))) {
    return {
      result: {
        ok: false,
        outcome: 'not-claimed',
        reason: `no agent claimed it within ${CANARY_WAIT_MS / 1000} s; it was cancelled and deleted`,
      },
      pendingJobId: null,
    };
  }
  return {
    result: {
      ok: false,
      outcome: 'not-completed',
      reason: `an agent claimed it but did not finish it within ${CANARY_WAIT_MS / 1000} s; the next run deletes it once it ends`,
    },
    pendingJobId: job?.id ?? null,
  };
}

/** Wait for a created job, judge it, clean it up: `{ result, pendingJobId }`. May throw. */
export async function followJob(deps, jobId, startedMs) {
  const payload = canaryPayload(jobId);
  const job = await waitFor(deps, jobId, startedMs + CANARY_WAIT_MS);
  const totalMs = deps.now().getTime() - startedMs;
  if (!job) {
    return {
      result: { ok: false, outcome: 'error', reason: 'the job disappeared before it finished', totalMs },
      pendingJobId: null,
    };
  }
  if (!TERMINAL.includes(job.status)) {
    const { result, pendingJobId } = await giveUp(deps, job);
    return { result: { ...result, totalMs }, pendingJobId };
  }
  const deleted = await remove(deps, job);
  return {
    result: { ...judgeJob(job, payload), totalMs, jobStatus: job.status },
    pendingJobId: deleted ? null : job.id,
  };
}
