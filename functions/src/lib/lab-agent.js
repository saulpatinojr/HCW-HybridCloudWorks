/**
 * The Labs agent API — the four operations the VPS agent is allowed to
 * perform, and nothing else.
 *
 * This replaces the agent's direct Cosmos access (T-401). The reasoning for the
 * credential model is in `auth/require-agent.js`; this file is what that model
 * buys. The blast radius of a credential stolen off the VPS is these four
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
import { AGENT_DOWN_STATUSES } from './labs.js';
import {
  MAX_CLOCK_SKEW_MS,
  createCoderAutomationReporter,
  parseIsoDateTime,
} from './labs/coder-automation.js';
import {
  BACK_ONLINE_SENT,
  OFFLINE_NOTIFY_AFTER_MS,
  outageMinutes,
  tellOwnerAgentBack,
} from './timers/agent-health.js';

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
      context.error('claimLabJob write failed:', err?.message);
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
 * A shutdown the agent announces itself, and the first normal heartbeat
 * after one.
 *
 * A `systemctl stop` sends SIGTERM and the agent heartbeats `stopping`, then
 * `offline` (vps-agent/index.js). That heartbeat marks it offline here, at
 * once, so the online rule (lib/labs.js) closes the public door without
 * waiting for the 90 s of silence the health timer measures. It does NOT
 * tell the owner any more: until 2026-10-08 it sent a critical "Lab agent
 * offline" on the spot, and that morning's 04:30 reboot, back in 43 seconds,
 * left the owner with a red alert and no word that it was over (#1009). The
 * health timer now says "offline" once an outage has lasted
 * OFFLINE_NOTIFY_AFTER_MS, and records that it did on the agent's document
 * (`offlineNotifiedAt`).
 *
 * The first normal heartbeat after such an outage owes the owner its end:
 * it stamps `backOnlineAt`, sends "Lab agent back online after N min", and
 * clears both fields once the message has gone. When it does not go (the
 * notifier's cooldown, Telegram down) the fields stay, and the health timer
 * sends it on its next run (lib/timers/agent-health.js). Best effort either
 * way: the heartbeat is recorded whether or not a message goes.
 *
 * An agent that drops again while the owner is still owed the end of an
 * outage keeps that outage's start (`offlineSince`), and the unsent "back
 * online" is cancelled: to the owner it is one outage.
 */
function outageUpdates(agent, updates) {
  const goingOffline = updates.status === 'offline' && agent.status !== 'offline';
  const comingBack = agent.status === 'offline' && !AGENT_DOWN_STATUSES.includes(updates.status);
  const owesBack = comingBack && Boolean(agent.offlineNotifiedAt);
  const extra = {};
  if (goingOffline) {
    if (!(agent.offlineNotifiedAt && agent.offlineSince)) extra.offlineSince = updates.lastSeenAt;
    if (agent.backOnlineAt) extra.backOnlineAt = null;
  }
  if (owesBack) extra.backOnlineAt = updates.lastSeenAt;
  return { goingOffline, comingBack, owesBack, extra };
}

/**
 * The warn lines a transition writes, and the "back online" it may owe.
 *
 * Content-free: Warning is the level host.json ingests, so these name the
 * transition and never the agent's document id. The registry holds one agent
 * per host, and the owner's message, which is not telemetry, names it.
 */
async function reportOutage({ store, notifier }, context, agent, outage, atMs) {
  const id = agent.agentId;
  if (outage.goingOffline) {
    context.warn?.(
      `heartbeatAgent: an agent reported its own shutdown and is marked offline; the owner is told only if it stays offline ${OFFLINE_NOTIFY_AFTER_MS / 60_000} minutes`
    );
  }
  if (!outage.comingBack) return;
  const minutes = outageMinutes(agent.offlineSince, atMs);
  context.warn?.(
    `heartbeatAgent: an agent is back online${minutes ? ` after ${minutes} min` : ''}${outage.owesBack ? '; the owner was told it was offline' : ''}`
  );
  if (!outage.owesBack) return;
  const sent = await tellOwnerAgentBack({
    notifier,
    agent,
    backAtMs: atMs,
    log: context,
    label: 'heartbeatAgent:',
  });
  if (!sent) return;
  try {
    await store.patchDoc('lab_agents', id, BACK_ONLINE_SENT, { partitionKey: id });
    context.warn?.('heartbeatAgent: back-online message sent');
  } catch (err) {
    // The message went; the next health run would send it again, which is
    // the lesser fault than claiming here that it did not.
    context.warn?.(`heartbeatAgent: back-online message sent, but clearing the debt failed: ${err?.message}`);
  }
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The commit the agent's host last converged from, as a heartbeat carries it
 * (`applied`, vps-agent/lib/applied-commit.js; #1009), checked: a full
 * lower-case sha and two ISO 8601 date-times with a zone, normalised to UTC.
 * Null for anything else, and for a date more than MAX_CLOCK_SKEW_MS ahead of
 * the site's clock: both say when something already happened, and the host's
 * clock is checked, not trusted (labs/coder-automation.js has the same rule).
 *
 * Not an authorization input, unlike `capabilities` and `oid`: it is the
 * host's own account of itself, which is all the drift check
 * (labs/drift.js) can have, and a host that lies about it only hides its own
 * lag from its owner.
 *
 * @returns {{ commit: string, committedAt: string, appliedAt: string } | null}
 */
export function parseAppliedRecord(raw, nowMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.commit !== 'string' || !COMMIT_SHA.test(raw.commit)) return null;
  const committedAt = parseIsoDateTime(raw.committedAt);
  const appliedAt = parseIsoDateTime(raw.appliedAt);
  if (!committedAt || !appliedAt) return null;
  const ahead = (iso) => Date.parse(iso) - nowMs > MAX_CLOCK_SKEW_MS;
  if (ahead(committedAt) || ahead(appliedAt)) return null;
  return { commit: raw.commit, committedAt, appliedAt };
}

/** True when the stored record already says exactly this. */
const sameApplied = (stored, next) =>
  stored?.commit === next.commit &&
  stored?.committedAt === next.committedAt &&
  stored?.appliedAt === next.appliedAt;

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
  const { body, agent } = parsed;

  const activeJobs =
    Number.isInteger(body.activeJobs) && body.activeJobs >= 0 ? body.activeJobs : 0;
  const status = ['idle', 'busy', 'stopping', 'offline'].includes(body.status)
    ? body.status
    : 'idle';

  // Built conditionally, not with `undefined` placeholders: patchDoc treats
  // an undefined value as a field DELETION, so spreading absent optionals
  // would wipe the stored hostname and version on every heartbeat — and
  // would route each one through the read-modify-write path, turning a
  // 30-second poll into two round trips instead of one.
  // Both shutdown statuses win over the job-derived `busy`. The agent sends
  // `stopping` while it drains its jobs and `offline` with activeJobs > 0
  // when its shutdown deadline expires with work still running; rewriting
  // either to `busy` read a departing agent as online and let the public
  // door queue work its poller will never claim (review of #1018).
  let effective = status;
  if (!AGENT_DOWN_STATUSES.includes(status) && activeJobs > 0) effective = 'busy';
  const at = now();
  const updates = {
    status: effective,
    activeJobs,
    lastSeenAt: at.toISOString(),
  };
  if (typeof body.hostname === 'string') updates.hostname = body.hostname.slice(0, 255);
  if (typeof body.version === 'string') updates.version = body.version.slice(0, 64);

  // The host's applied commit (#1009), one patch operation as one object, and
  // only when it changed: it moves once per bootstrap.sh run, not per beat.
  // An absent or refused record leaves the stored one as it was; the drift
  // verdict judges its age, so a host that stops reporting is not hidden.
  const applied = parseAppliedRecord(body.applied, at.getTime());
  if (applied && !sameApplied(agent.applied, applied)) updates.applied = applied;

  // The transitions the health timer would otherwise have to find: the
  // record said the agent was up and this heartbeat says it has gone, or
  // the record said offline and this one is normal.
  const outage = outageUpdates(agent, updates);
  Object.assign(updates, outage.extra);

  try {
    await store.patchDoc('lab_agents', agent.agentId, updates, {
      partitionKey: agent.agentId,
    });
  } catch (err) {
    context.error('heartbeatAgent failed:', err?.message);
    return json(500, { ok: false, error: 'Failed to record heartbeat' });
  }

  await reportOutage(
    { store, notifier },
    context,
    { ...agent, hostname: updates.hostname ?? agent.hostname },
    outage,
    at.getTime()
  );

  return json(200, { ok: true });
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
    context.warn?.(`agent ${agent.agentId} tried to complete job ${jobId} it does not hold`);
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
    const job = await store.readDoc('lab_jobs', jobId, jobId);
    const notHeld = heldJobRefusal(job, jobId, agent, context, claimId);
    if (notHeld) return notHeld;

    try {
      await store.replaceDocIfMatch('lab_jobs', { ...job, ...result }, { partitionKey: jobId });
      return json(200, { ok: true });
    } catch (err) {
      if (err?.code === 412) continue;
      context.error('completeLabJob failed:', err?.message);
      return json(500, { ok: false, error: 'Failed to record result' });
    }
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
 * @param {object} deps
 * @param {{ requireAgent: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, patchDoc: Function, replaceDocIfMatch: Function, createDoc?: Function, upsertDoc?: Function }} deps.store
 *        createDoc and upsertDoc are the Coder automation report's: the
 *        first write of its document and of the secret state (both
 *        ETag-guarded, replaceDocIfMatch after), and the audit row
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
  const ctx = { guard, store, now, uuid, notifier, reportAutomation };
  return {
    claimLabJob: (request, context) => claimLabJob(ctx, request, context),
    heartbeatAgent: (request, context) => heartbeatAgent(ctx, request, context),
    completeLabJob: (request, context) => completeLabJob(ctx, request, context),
    reportCoderAutomation: (request, context) => reportCoderAutomation(ctx, request, context),
  };
}
