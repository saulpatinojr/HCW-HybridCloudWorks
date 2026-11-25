/**
 * labs/canary-run.js — one run of the lab canary (canary.js has the header
 * that explains it): settle the job a previous run left, reserve the record,
 * enqueue one shell-echo job, follow it to the end, clean it up and record
 * the result. Every write decided from a read is under that read's ETag.
 * `deps` is `{ store, now, sleep, uuid, log }` from createLabCanary.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { isAgentOnline } from '../labs.js';
import { CLAIM_LEASE_MS } from '../lab-agent.js';
import {
  CANARY_ABANDON_GRACE_MS,
  CANARY_JOB_TYPE,
  CANARY_POLL_MS,
  CANARY_REQUESTER,
  CANARY_RUN_HOLD_MS,
  CANARY_WAIT_MS,
  LAB_CANARY_DOC_ID,
  LAB_CANARY_DOC_TYPE,
  PK,
  TERMINAL,
  WRITE_ATTEMPTS,
  canaryJob,
  canaryPayload,
  isRace,
  judgeJob,
  msOf,
  seconds,
} from './canary-model.js';

const readState = (deps) => deps.store.readDoc('admin_config', LAB_CANARY_DOC_ID, ADMIN_CONFIG_PARTITION);

/** Another run's live hold on the record, or null. `ownJobId` is this run's reservation, if any. */
function heldElsewhere(deps, state, ownJobId) {
  const hold = state?.activeRun;
  if (!hold?.jobId || hold.jobId === ownJobId) return null;
  const since = msOf(hold.since);
  return since !== null && deps.now().getTime() - since < CANARY_RUN_HOLD_MS ? hold : null;
}

/** Delete a job under the ETag it was read with. True when it is gone. */
async function remove(deps, job) {
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
async function withdraw(deps, job) {
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
async function settleLeftover(deps, jobId) {
  if (!jobId) return { inFlight: false };
  const job = await deps.store.readDoc('lab_jobs', jobId, jobId);
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
async function precondition(deps, nowMs) {
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
async function waitFor(deps, jobId, deadlineMs) {
  let job = null;
  for (;;) {
    job = await deps.store.readDoc('lab_jobs', jobId, jobId);
    if (!job || TERMINAL.includes(job.status)) return job;
    if (deps.now().getTime() >= deadlineMs) return job;
    await deps.sleep(CANARY_POLL_MS);
  }
}

/** The run's verdict on a job that did not finish in time, and whether it is still in flight. */
async function giveUp(deps, job) {
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

/**
 * Write the job's id to the record as `pendingJobId`, and this run as its
 * owner (`activeRun`), before the job exists, under the record's ETag. False
 * when another run holds the record, and then nothing is enqueued. Throws
 * when it cannot write: a job whose id is not recorded is one no later run
 * can find.
 */
async function reserve(deps, jobId) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const current = await readState(deps);
    if (heldElsewhere(deps, current, jobId)) return false;
    const next = {
      ...(current ?? {
        id: LAB_CANARY_DOC_ID,
        configScope: ADMIN_CONFIG_PARTITION,
        docType: LAB_CANARY_DOC_TYPE,
        jobType: CANARY_JOB_TYPE,
      }),
      pendingJobId: jobId,
      activeRun: { jobId, since: deps.now().toISOString() },
    };
    try {
      if (current) await deps.store.replaceDocIfMatch('admin_config', { ...next, _etag: current._etag }, PK);
      else await deps.store.createDoc('admin_config', next);
      return true;
    } catch (error) {
      if (error?.code !== 412 && error?.code !== 409) throw error;
    }
  }
  throw Object.assign(new Error('The lab canary record kept changing while it was reserved'), {
    code: 'CONFLICT',
  });
}

/** What a run that finds the record held by another reports. Nothing is written. */
const overlap = () => ({
  result: {
    ok: false,
    outcome: 'overlap',
    reason: 'another canary run holds the record; this run left it alone',
  },
  pendingJobId: null,
  ownJobId: null,
  unrecorded: true,
});

/** Reserve, enqueue, wait, judge, clean up: `{ result, pendingJobId, ownJobId }`. */
async function runJob(deps, startedMs) {
  const jobId = deps.uuid();
  if (!(await reserve(deps, jobId))) return overlap();
  await deps.store.createDoc('lab_jobs', canaryJob(jobId, new Date(startedMs).toISOString()));
  const outcome = await runReserved(deps, jobId, startedMs);
  return { ...outcome, ownJobId: jobId };
}

/** The job exists: follow it to the end, keeping its id whatever fails. */
async function runReserved(deps, jobId, startedMs) {
  // From here the job exists, so whatever fails while it is followed, its id
  // must reach the record: the next run settles it, and enqueues nothing new
  // while it may still be queued or running (CodeRabbit, #1055).
  try {
    return await followJob(deps, jobId, startedMs);
  } catch (error) {
    deps.log.warn?.(
      `[labCanary] the canary job could not be followed after it was created (${error?.code ?? 'error'}); the next run settles it`
    );
    return {
      result: {
        ok: false,
        outcome: 'error',
        reason: 'the job could not be read or cleaned up after it was created; the next run settles it',
        totalMs: deps.now().getTime() - startedMs,
      },
      pendingJobId: jobId,
    };
  }
}

/** Wait for a created job, judge it, clean it up: `{ result, pendingJobId }`. May throw. */
async function followJob(deps, jobId, startedMs) {
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

/**
 * The state after this run: the last result, the streak, and any job still
 * in flight. Another run's live hold, and the job it reserved, are kept as
 * they are; this run's own hold, or a dead one, is cleared.
 */
function nextState(deps, current, result, pendingJobId, atIso, ownJobId) {
  const ok = result.ok === true;
  const foreign = heldElsewhere(deps, current, ownJobId);
  return {
    id: LAB_CANARY_DOC_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    docType: LAB_CANARY_DOC_TYPE,
    jobType: CANARY_JOB_TYPE,
    lastRunAt: atIso,
    lastResult: { ...result, finishedAt: deps.now().toISOString() },
    lastSuccessAt: ok ? atIso : (current?.lastSuccessAt ?? null),
    lastFailureAt: ok ? (current?.lastFailureAt ?? null) : atIso,
    consecutiveFailures: ok ? 0 : (Number(current?.consecutiveFailures) || 0) + 1,
    pendingJobId: foreign ? (current.pendingJobId ?? null) : (pendingJobId ?? null),
    activeRun: foreign ? current.activeRun : null,
  };
}

/** Read, merge, write under the ETag; another writer in between means read again. */
async function record(deps, result, pendingJobId, atIso, ownJobId) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const current = await readState(deps);
    const next = nextState(deps, current, result, pendingJobId, atIso, ownJobId);
    try {
      if (current) await deps.store.replaceDocIfMatch('admin_config', { ...next, _etag: current._etag }, PK);
      else await deps.store.createDoc('admin_config', next);
      return next;
    } catch (error) {
      if (error?.code !== 412 && error?.code !== 409) throw error;
    }
  }
  throw Object.assign(new Error('The lab canary record kept changing while it was written'), {
    code: 'CONFLICT',
  });
}

export async function runCanary(deps) {
  const started = deps.now();
  const startedMs = started.getTime();
  const atIso = started.toISOString();
  const state = await readState(deps);
  if (heldElsewhere(deps, state, null)) {
    deps.log.warn?.('[labCanary] another canary run holds the record; this run left it alone');
    return { ok: false, outcome: 'overlap', claimSeconds: null, runSeconds: null, jobLeftInFlight: false };
  }

  const leftover = await settleLeftover(deps, state?.pendingJobId);
  let outcome;
  if (leftover.inFlight) {
    outcome = {
      result: {
        ok: false,
        outcome: 'previous-in-flight',
        reason: `the previous canary job has been in flight since ${leftover.since ?? 'an unknown time'}; nothing new was enqueued`,
      },
      pendingJobId: state.pendingJobId,
    };
  } else {
    const refusal = await precondition(deps, startedMs);
    outcome = refusal ? { result: refusal, pendingJobId: null } : await runJob(deps, startedMs);
  }

  if (outcome.unrecorded) {
    deps.log.warn?.('[labCanary] another canary run holds the record; this run left it alone');
    return { ok: false, outcome: 'overlap', claimSeconds: null, runSeconds: null, jobLeftInFlight: false };
  }
  const recorded = await record(deps, outcome.result, outcome.pendingJobId, atIso, outcome.ownJobId ?? null);

  const { result } = outcome;
  if (!result.ok) {
    deps.log.warn?.(
      `[labCanary] the end-to-end lab job did not pass (${result.outcome}); ${recorded.consecutiveFailures} run(s) in a row`
    );
  }
  return {
    ok: result.ok === true,
    outcome: result.outcome,
    claimSeconds: Number.isFinite(result.timings?.claimMs) ? seconds(result.timings.claimMs) : null,
    runSeconds: Number.isFinite(result.timings?.runMs) ? seconds(result.timings.runMs) : null,
    jobLeftInFlight: Boolean(outcome.pendingJobId),
  };
}
