/**
 * The Labs agent API — the five operations the VPS agent is allowed to
 * perform, and nothing else.
 *
 * This replaces the agent's direct Cosmos access (T-401). The reasoning for the
 * credential model is in `auth/require-agent.js`; this file is what that model
 * buys. The blast radius of a credential stolen off the VPS is these five
 * handlers, under the constraints written into them, rather than read/write
 * over two containers:
 *
 *   claimLabJob      — take at most one queued job, only of a type the agent
 *                      is registered for, only if nobody else took it first
 *   heartbeatAgent   — write liveness for *this* agent only
 *   completeLabJob   — write a terminal result, only for a job this agent
 *                      currently holds, fenced with the ETag of the read
 *                      that found it held
 *   reportCoderAutomation
 *                    — record how the host's Coder upkeep went, and hand
 *                      over a renewed Coder status token: one secret, by
 *                      name, stored only after Coder accepts it
 *                      (labs/coder-automation.js, 2026-10-08)
 *   reportHostCheck  — record what a check the host runs on itself saw, by
 *                      the check's name and under a closed set of counts and
 *                      states, in one admin_config document and nowhere
 *                      else (labs/host-checks.js, 2026-10-19, #1282)
 *
 * The API owns the job claim and completion rules. The standalone `vps-agent/`
 * process only polls these handlers with its scoped Entra credential; it never
 * receives a Cosmos or database credential.
 */

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

import { randomUUID } from 'node:crypto';
import { createCoderAutomationReporter } from './labs/coder-automation.js';
import { createHostCheckRecorder } from './labs/host-checks.js';
import { errorFacts } from './http/error-response.js';
import { recordHeartbeat } from './lab-agent-heartbeat.js';

export { parseAppliedRecord } from './lab-agent-heartbeat.js';

/**
 * Statuses a completing agent may report.
 *
 * Deliberately not the whole of `JOB_STATUSES` from labs.js. `queued` and
 * `claimed` are not terminal, and `cancelled` belongs to the admin
 * `cancelLabJob` path — an agent reporting `cancelled` would let a compromised
 * VPS silently discard work and make it look like an operator decision.
 */
export const AGENT_TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'timeout']);

/** Matches the source agent's OUTPUT_CAP_BYTES (lib/docker-runner.js). */
export const OUTPUT_CAP_BYTES = 64 * 1024;

/** How long a claimed job may sit before another agent may take it over. */
export const CLAIM_LEASE_MS = 15 * 60 * 1000;

/** Bounded scan for claimable work. */
const CLAIM_SCAN_LIMIT = 20;

const clampOutput = (value) => String(value ?? '').slice(0, OUTPUT_CAP_BYTES);

/**
 * Every agent request's first two steps, in this order: the body must be
 * JSON (400 otherwise), then `requireAgent` checks the credential against
 * the agent the body names. The body and the registry record on success,
 * the response on refusal.
 */
async function authenticatedAgentBody(guard, request) {
  let body;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return { error: json(400, { ok: false, error: 'Body must be valid JSON' }) };
  }

  const auth = await guard.requireAgent(request, body.agentId);
  if (auth.error) return { error: auth.error };
  return { body, agent: auth.agent };
}

/**
 * The claimable jobs for these capabilities, oldest first.
 *
 * Two claimable shapes: never claimed, or claimed by an agent that has since
 * gone away. Without the second, a host that dies mid-claim strands its jobs
 * permanently, as jobs stuck in 'claimed' forever.
 *
 * FIFO in the query itself (ADR 0033 inventory): without ORDER BY, TOP 20
 * was whichever 20 candidates Cosmos returned, so with more than twenty
 * queued the oldest could wait behind newer ones indefinitely. Every
 * lab_jobs document carries createdAt (enqueueLabJob and the public submit
 * both write it), so the sort drops nothing.
 */
async function claimCandidates(store, capabilities, now) {
  const staleBefore = new Date(now().getTime() - CLAIM_LEASE_MS).toISOString();
  const candidates = await store.queryDocs(
    'lab_jobs',
    `SELECT TOP @limit * FROM c
        WHERE ARRAY_CONTAINS(@types, c.type)
          AND (c.status = 'queued'
               OR (c.status = 'claimed' AND (NOT IS_DEFINED(c.claimedAt) OR c.claimedAt < @staleBefore)))
        ORDER BY c.createdAt ASC`,
    [
      { name: '@limit', value: CLAIM_SCAN_LIMIT },
      { name: '@types', value: capabilities },
      { name: '@staleBefore', value: staleBefore },
    ]
  );

  // Oldest first, again in memory, so a store that ignores ORDER BY (a test
  // double, a future mirror) still hands out the oldest.
  return [...candidates].sort((a, b) =>
    String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
  );
}

/** The claimed job as the agent receives it. */
function claimedJobBody(claimed) {
  return {
    id: claimed.id,
    claimId: claimed.claimId || null,
    type: claimed.type,
    payload: typeof claimed.payload === 'string' ? claimed.payload : '',
    // Written by enqueueLabJob from its allowlist; a document from
    // before #675 has none and is a text payload.
    payloadEncoding: claimed.payloadEncoding === 'tar' ? 'tar' : 'text',
  };
}

/**
 * The first candidate this agent wins. The contended write is a single
 * document, so an ETag-guarded replace is the whole of the locking: two
 * agents racing for the same job produce one 412, and the loser simply
 * tries the next candidate.
 */
async function claimFirstAvailable({ store, now, uuid = randomUUID }, context, agentId, ordered) {
  for (const job of ordered) {
    try {
      const claimId = uuid();
      const claimed = await store.replaceDocIfMatch('lab_jobs', {
        ...job,
        status: 'claimed',
        agentId,
        claimId,
        claimedAt: now().toISOString(),
      });
      return json(200, { ok: true, job: claimedJobBody(claimed) });
    } catch (err) {
      // 412: someone else claimed it between our read and our write. Try the
      // next candidate rather than failing the poll.
      if (err?.code === 412) continue;
      context.error('claimLabJob write failed:', errorFacts(err));
      return json(500, { ok: false, error: 'Failed to claim job' });
    }
  }
  return json(200, { ok: true, job: null });
}

/**
 * Claim one queued job.
 *
 * Capabilities come from the registry record, NOT from the request. The
 * source agent sent its own capability list and filtered client-side; an
 * agent that can name its own capabilities can claim any job type, which
 * makes the enqueue-side `LAB_JOB_TYPES` allowlist decorative.
 */
async function claimLabJob(ctx, request, context) {
  const parsed = await authenticatedAgentBody(ctx.guard, request);
  if (parsed.error) return parsed.error;
  const { agent } = parsed;

  const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : [];
  if (capabilities.length === 0) {
    // Not an error: an agent registered with no capabilities has nothing to
    // do, and should keep heartbeating rather than crash-loop.
    return json(200, { ok: true, job: null });
  }

  const ordered = await claimCandidates(ctx.store, capabilities, ctx.now);
  return claimFirstAvailable(ctx, context, agent.agentId, ordered);
}

/**
 * Record liveness for this agent.
 *
 * Writes `lastSeenAt`. The stub agent wrote `lastPing` while `labs.js:188`
 * read `lastSeenAt`, so the Labs "connected" indicator could never be true
 * (T-401). Fixing it here rather than in the agent is deliberate:
 * the field name is now the server's business, and no future agent can get
 * it wrong.
 *
 * `capabilities` and `oid` are NOT writable through this path — they are
 * the registry's authorization inputs, and an endpoint the VPS can reach
 * must not be able to grant the VPS new job types or rebind its identity.
 * `applied`, the commit the host converged from, is (parseAppliedRecord).
 */
async function heartbeatAgent({ guard, store, now, notifier }, request, context) {
  const parsed = await authenticatedAgentBody(guard, request);
  if (parsed.error) return parsed.error;
  return recordHeartbeat({ store, now, notifier }, parsed, context);
}

/** The 400s a completion body earns before any read: no jobId, or a status an agent may not report. */
function completionRefusal(jobId, status) {
  if (!jobId) return json(400, { ok: false, error: 'jobId is required' });
  if (!AGENT_TERMINAL_STATUSES.includes(status)) {
    return json(400, {
      ok: false,
      error: `status must be one of ${AGENT_TERMINAL_STATUSES.join(', ')}`,
    });
  }
  return null;
}

/**
 * Why this agent may not complete this job, or null when it may.
 *
 * The ownership check is the point. Without it a compromised VPS could
 * overwrite any job's output — including jobs run by other agents — which
 * turns the results surface into an arbitrary write.
 */
function heldJobRefusal(job, jobId, agent, context, claimId = undefined) {
  if (!job) return json(404, { ok: false, error: 'Job not found' });

  if (job.agentId !== agent.agentId) {
    context.warn?.(`agent ${agent.agentId} tried to complete a job it does not hold`);
    return json(403, { ok: false, error: 'Job is not held by this agent' });
  }

  // A job the operator cancelled, or one already reported, must not be
  // reopened by a late-arriving result. `claimed` is the only state a held
  // job is ever in: the agent reports nothing between claim and completion
  // (JOB_STATUSES in labs.js).
  if (job.status !== 'claimed') {
    return json(409, { ok: false, error: `Job is ${job.status}` });
  }

  // If the agent sent a claimId and the job records one, verify they match.
  // Fences against the same agent reclaiming a job after lease expiry and a late
  // result from the first claim landing against the second (#1094).
  if (claimId && job.claimId && claimId !== job.claimId) {
    context.warn?.('lab-agent: claimId mismatch on completion');
    return json(409, { ok: false, error: 'Job was claimed under a different claimId' });
  }

  return null;
}

/**
 * How many times a completion reads the job and tries its fenced write. A 412
 * means the job changed after the read; each attempt reads it again, so this
 * bounds only a job that keeps changing while its result is reported.
 */
const COMPLETION_ATTEMPTS = 3;

/**
 * One fenced attempt at recording a result: the answer to give (refused,
 * written, or failed), or null when the job moved since the read (412) and
 * the caller should read it again.
 */
async function tryRecordResult(store, { jobId, claimId, agent, result }, context) {
  const job = await store.readDoc('lab_jobs', jobId, jobId);
  const notHeld = heldJobRefusal(job, jobId, agent, context, claimId);
  if (notHeld) return notHeld;

  try {
    await store.replaceDocIfMatch('lab_jobs', { ...job, ...result }, { partitionKey: jobId });
    return json(200, { ok: true });
  } catch (err) {
    if (err?.code === 412) return null;
    context.error('completeLabJob failed:', errorFacts(err));
    return json(500, { ok: false, error: 'Failed to record result' });
  }
}

/**
 * Write a terminal result for a job this agent holds.
 *
 * The write is fenced with the ETag of the read that decided ownership
 * (#1057). Between that read and the write an operator can cancel the job,
 * the canary can withdraw an overdue one, or another agent can claim it once
 * the lease lapses (CLAIM_LEASE_MS). An unfenced patch landed the stale
 * agent's result over whichever of those happened. On a 412 the job is read
 * again and `heldJobRefusal` decides again: still held and `claimed`, the
 * write is retried; otherwise the agent is refused and the job is left as it
 * now is.
 */
async function completeLabJob({ guard, store, now }, request, context) {
  const parsed = await authenticatedAgentBody(guard, request);
  if (parsed.error) return parsed.error;
  const { body, agent } = parsed;

  const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
  const claimId = typeof body.claimId === 'string' ? body.claimId.trim() : undefined;
  const refused = completionRefusal(jobId, body.status);
  if (refused) return refused;

  const result = {
    status: body.status,
    exitCode: Number.isInteger(body.exitCode) ? body.exitCode : -1,
    output: clampOutput(body.output),
    finishedAt: now().toISOString(),
  };

  for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt += 1) {
    const answer = await tryRecordResult(store, { jobId, claimId, agent, result }, context);
    if (answer) return answer;
  }

  // Content-free: no job or agent id in the text. The Functions host already
  // ties the line to this invocation, which is the correlation it needs.
  context.warn?.('completeLabJob: the job changed on every attempt to record its result; nothing was written');
  return json(409, { ok: false, error: 'Job changed while its result was being recorded' });
}

/**
 * The Coder automation report: the same two first steps as every handler
 * here (JSON, then requireAgent on the body's agentId), then
 * labs/coder-automation.js, which validates, verifies any token against
 * Coder, stores it and records the report.
 */
async function reportCoderAutomation(ctx, request, context) {
  const parsed = await authenticatedAgentBody(ctx.guard, request);
  if (parsed.error) return parsed.error;
  return ctx.reportAutomation(parsed, context);
}

/**
 * A host check's report (#1282): the same two first steps, then
 * labs/host-checks.js, which validates the closed set of fields and records
 * the entry under admin_config/host_checks. No token, no vault, no audit
 * row: the report is counts and states, every fifteen minutes.
 */
async function reportHostCheck(ctx, request, context) {
  const parsed = await authenticatedAgentBody(ctx.guard, request);
  if (parsed.error) return parsed.error;
  return ctx.recordHostCheck(parsed, context);
}

/**
 * @param {object} deps
 * @param {{ requireAgent: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, patchDoc: Function, replaceDocIfMatch: Function, createDoc?: Function, upsertDoc?: Function }} deps.store
 *        createDoc and upsertDoc are the Coder automation report's: the
 *        first write of its document and of the secret state (both
 *        ETag-guarded, replaceDocIfMatch after), and the audit row.
 *        createDoc is also the host check report's first write
 *        (labs/host-checks.js), replaceDocIfMatch after
 * @param {() => Date} [deps.now]
 * @param {object} [deps.coderAutomation] env, fetchImpl, vault and uuid for
 *        the report (labs/coder-automation.js); production defaults otherwise
 */
export function createLabAgentHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  notifier = null,
  coderAutomation = {},
}) {
  const reportAutomation = createCoderAutomationReporter({ store, now, ...coderAutomation });
  const recordHostCheck = createHostCheckRecorder({ store, now });
  const ctx = { guard, store, now, uuid, notifier, reportAutomation, recordHostCheck };
  return {
    claimLabJob: (request, context) => claimLabJob(ctx, request, context),
    heartbeatAgent: (request, context) => heartbeatAgent(ctx, request, context),
    completeLabJob: (request, context) => completeLabJob(ctx, request, context),
    reportCoderAutomation: (request, context) => reportCoderAutomation(ctx, request, context),
    reportHostCheck: (request, context) => reportHostCheck(ctx, request, context),
  };
}
