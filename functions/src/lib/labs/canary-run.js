/**
 * labs/canary-run.js — one run of the lab canary (canary.js has the header
 * that explains it): settle the job a previous run left, reserve the record,
 * enqueue one shell-echo job, follow it to the end, clean it up and record
 * the result. Every write decided from a read is under that read's ETag.
 * `deps` is `{ store, now, sleep, uuid, log }` from createLabCanary.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { followJob, precondition, settleLeftover } from './canary-jobs.js';
import {
  CANARY_JOB_TYPE,
  CANARY_RUN_HOLD_MS,
  LAB_CANARY_DOC_ID,
  LAB_CANARY_DOC_TYPE,
  PK,
  WRITE_ATTEMPTS,
  canaryJob,
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

/**
 * The state after this run: the last result, the streak, and any job still
 * in flight. Another run's live hold, and the job it reserved, are kept as
 * they are; this run's own hold, or a dead one, is cleared.
 */
function nextState(deps, current, { result, pendingJobId, atIso, ownJobId }) {
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
async function record(deps, outcome) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const current = await readState(deps);
    const next = nextState(deps, current, outcome);
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
  const recorded = await record(deps, {
    result: outcome.result,
    pendingJobId: outcome.pendingJobId,
    atIso,
    ownJobId: outcome.ownJobId ?? null,
  });

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
