/**
 * Labs platform RPCs — enqueueLabJob, getLabJob, getLabsSnapshot,
 * cancelLabJob. The admin Labs Hub's view of the job runner.
 *
 * The VPS agent pulls jobs with its own credentials (lib/lab-agent.js); the
 * browser never writes these containers directly — these endpoints are the
 * only writers. The server-side LAB_JOB_TYPES allowlist is the enqueue-side
 * containment: payloads are only ever substituted into the agent's
 * allowlisted command templates, so the type allowlist plus per-type payload
 * byte caps bound what reaches the host.
 *
 * Both containers are Cosmos DB (`lab_jobs`, `lab_agents`, partition `/id`),
 * and every timestamp is an ISO string written by this module or by
 * lab-agent.js; `toMs` still accepts an object with `toMillis` so a document
 * from before the store moved reads rather than breaks.
 *
 *   - Cancel is read-then-conditional-patch. The race window (job claimed
 *     between read and patch) resolves safely: the agent ignores cancellation
 *     on jobs it has already claimed, so a lost race means the job simply
 *     runs — annoying, not unsafe.
 *   - The anonymous submission path is lib/labs/public-submit.js (#672):
 *     terraform-validate only, inside ADR 0032 decision 6's bounds, closed
 *     unless LABS_PUBLIC_SUBMISSION_ENABLED is exactly "true", and locked
 *     to the site's pane by origin and Turnstile (lib/labs/public-lock.js).
 */
import { randomUUID } from 'node:crypto';
import { logFailure, errorFacts } from './http/error-response.js';

/**
 * This module's failure answer: the safe sentence and the correlation id,
 * with the door's content-free log line (logFailure, #945).
 *
 * @param {object} context - the invocation context
 * @param {string} fallbackMessage - the sentence the answer carries
 * @param {unknown} error - the failure, for the log line
 * @param {number} [status] - the HTTP status
 * @param {object} [request] - the request, for a caller's correlation header
 * @returns {{ status: number, headers: Record<string, string>, body: string }}
 */
function errorResponse(context, fallbackMessage, error, status = 500, request = null) {
  // The door's line and id: the v4 traceParent, and a caller's header only in
  // the id shape (#945). The caught error object is never handed to
  // context.error, which would log its message (CodeRabbit on #1200).
  const correlationId = logFailure(context, fallbackMessage, error, request);
  return {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-ID': correlationId,
    },
    body: JSON.stringify({
      ok: false,
      error: fallbackMessage,
      correlationId,
    }),
  };
}

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Payload encodings a job may carry (#675). `text` is the payload as one
 * file; `tar` is the base64 of a tar archive (optionally gzipped) that the
 * agent unpacks into the job's workspace for multi-file inputs such as a
 * Helm chart or a Terraform root. The byte cap applies to the encoded string
 * either way, so a `tar` payload is bounded at the same 64 KB as before.
 */
export const PAYLOAD_ENCODINGS = Object.freeze(['text', 'tar']);

/**
 * Verbatim — must stay in sync with vps-agent/lib/capabilities.js
 * (CAPABILITIES) and frontend/src/components/admin/labs/labsView.js
 * (FALLBACK_JOB_TYPES). `payloadEncodings` lists what the agent's capability
 * accepts; enqueue refuses anything else so a mismatch fails here, not on
 * the host.
 */
export const LAB_JOB_TYPES = Object.freeze({
  'shell-echo': {
    description: 'Smoke test — echoes the payload back from the sandbox.',
    maxPayloadBytes: 4 * 1024,
    payloadEncodings: ['text'],
  },
  'terraform-validate': {
    description:
      'Runs `terraform init -backend=false && terraform validate` on the payload HCL, with registry AVM sources rewritten to the vendored copies in the runner image. Text is one main.tf; tar is a whole root.',
    maxPayloadBytes: 64 * 1024,
    payloadEncodings: ['text', 'tar'],
  },
  'ansible-check': {
    description:
      'Runs `ansible-playbook --syntax-check` on the payload playbook YAML, with the ansible-core in the runner image and no collections: a module outside ansible.builtin does not resolve.',
    maxPayloadBytes: 64 * 1024,
    payloadEncodings: ['text'],
  },
  'helm-template': {
    description:
      'Runs `helm template` on a chart: the payload is the base64 of a tar of one chart directory, dependencies already under charts/. No repository, no cluster.',
    maxPayloadBytes: 64 * 1024,
    payloadEncodings: ['tar'],
  },
  kubeconform: {
    description:
      'Validates Kubernetes manifests with kubeconform -strict against the schemas bundled in the runner image. Text is one manifest file; tar is a directory of them.',
    maxPayloadBytes: 64 * 1024,
    payloadEncodings: ['text', 'tar'],
  },
});

/**
 * Every status a `lab_jobs` document can hold, in lifecycle order: enqueue
 * writes `queued`, the agent's claim writes `claimed`, its completion writes
 * one of `succeeded` / `failed` / `timeout` (AGENT_TERMINAL_STATUSES in
 * lab-agent.js), and cancelLabJob writes `cancelled` while still queued.
 * There is no `running`: the agent reports nothing between claim and
 * completion, so the status it used to name was never written and read as
 * a state the Hub kept waiting for (ADR 0033 inventory, 2026-10-03).
 */
export const JOB_STATUSES = ['queued', 'claimed', 'succeeded', 'failed', 'timeout', 'cancelled'];

const toMs = (v) => {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};
const toIsoOrNull = (v) => (toMs(v) ? new Date(toMs(v)).toISOString() : null);

/** An agent is offline after three missed 30 s heartbeats. */
export const AGENT_STALE_AFTER_MS = 90 * 1000;

/**
 * The statuses an agent writes about its own shutdown (vps-agent/index.js
 * heartbeats `stopping`, then `offline`, on SIGTERM). Neither is "online",
 * however fresh the heartbeat that carried it.
 */
export const AGENT_DOWN_STATUSES = Object.freeze(['stopping', 'offline']);

/**
 * The online rule, exported so the admin snapshot, the public estate read
 * (lib/labs/estate.js) and the public submit door (lib/labs/public-submit.js)
 * all say "online" by the same rule.
 *
 * Fresh AND not announcing its own shutdown. The `offline` heartbeat writes
 * `lastSeenAt` like any other, so freshness alone read an agent that had just
 * said goodbye as online, and held the public door open, for the 90 seconds
 * after it stopped (#1009). And not deactivated: the agent guard refuses
 * `active: false` at once (auth/require-agent.js), so for the 90 seconds its
 * last heartbeat stayed fresh the rule read a revoked runner as online and the
 * public door queued work it could not claim (review of #1018). A record
 * with no `active` at all is refused by the guard too, but it can never
 * heartbeat past it, so its freshness lapses on its own; explicit `false` is
 * the case with a fresh heartbeat behind it.
 *
 * A caller must therefore read `status` and `active` as well as `lastSeenAt`;
 * a record without `lastSeenAt` is offline.
 *
 * @param {{ lastSeenAt?: unknown, status?: unknown, active?: unknown } | null | undefined} agent
 *   `lastSeenAt` is an ISO string, a Date, or an object with toMillis()
 * @param {number} nowMs
 */
export function isAgentOnline(agent, nowMs) {
  if (agent?.active === false) return false;
  if (AGENT_DOWN_STATUSES.includes(agent?.status)) return false;
  const lastSeenMs = toMs(agent?.lastSeenAt);
  return lastSeenMs > 0 && nowMs - lastSeenMs < AGENT_STALE_AFTER_MS;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;
const isDateTime = (value) =>
  typeof value === 'string' && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value));

/**
 * The commit an agent's host last converged from, when its registry document
 * holds a whole record of it, or null (#1009). lib/lab-agent.js writes
 * `applied` from the heartbeat; the drift check (labs/drift.js) and the
 * snapshot below read it through this, so a half-written or hand-edited
 * record is no record, said the same way everywhere.
 *
 * @returns {{ commit: string, committedAt: string, appliedAt: string } | null}
 */
export function appliedOf(agent) {
  const applied = agent?.applied;
  if (!applied || typeof applied !== 'object') return null;
  if (typeof applied.commit !== 'string' || !COMMIT_SHA.test(applied.commit)) return null;
  if (!isDateTime(applied.committedAt) || !isDateTime(applied.appliedAt)) return null;
  return applied;
}

/**
 * The lab recurrence checks for the snapshot (labs/lab-checks.js), imported
 * when a snapshot is built rather than with this module: this module is the
 * online rule, which the browser-side tests load through
 * health/pulse-checks.js, and the checks bring the Cosmos and Key Vault
 * clients with them.
 */
const readLabChecksLazily = async (...args) =>
  (await import('./labs/lab-checks.js')).readLabChecks(...args);

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {(store: object, nowMs: number, agentRows: object[]) => Promise<{checks: object, drift: object}>} [deps.readChecks]
 *   the lab recurrence checks (labs/lab-checks.js readLabChecks); tests only
 */
export function createLabHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  readChecks = readLabChecksLazily,
}) {
  const deps = { guard, store, now, uuid, readChecks };
  return {
    enqueueLabJob: (request, context) => enqueueLabJob(deps, request, context),
    getLabJob: (request, context) => getLabJob(deps, request, context),
    getLabsSnapshot: (request, context) => getLabsSnapshot(deps, request, context),
    cancelLabJob: (request, context) => cancelLabJob(deps, request, context),
  };
}

/** What refuses an enqueue body, in this order: the type, the payload's type, its encoding, its size. The response, or null. */
function enqueueRefusal({ type, payload, payloadEncoding }) {
  const spec = LAB_JOB_TYPES[type];
  if (!spec) {
    return json(400, {
      error: `Unknown job type. Allowed: ${Object.keys(LAB_JOB_TYPES).join(', ')}`,
    });
  }
  if (typeof payload !== 'string') {
    return json(400, { error: 'payload must be a string' });
  }
  return payloadRefusal(spec, { type, payload, payloadEncoding });
}

/** The encoding and size checks on a string payload: the response, or null. */
function payloadRefusal(spec, { type, payload, payloadEncoding }) {
  if (!spec.payloadEncodings.includes(payloadEncoding)) {
    return json(400, {
      error: `payloadEncoding must be one of ${spec.payloadEncodings.join(', ')} for ${type}`,
    });
  }
  if (payloadEncoding === 'tar' && !/^[A-Za-z0-9+/=\s]*$/.test(payload)) {
    return json(400, { error: 'a tar payload must be base64' });
  }
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > spec.maxPayloadBytes) {
    return json(413, {
      error: `Payload too large (${payloadBytes} bytes; max ${spec.maxPayloadBytes} for ${type})`,
    });
  }
  return null;
}

/** The job id a getLabJob request names: the query on a GET, the body otherwise. */
async function requestedJobId(request) {
  if (String(request.method).toUpperCase() === 'GET') {
    return String(request.query.get('jobId') || '').trim();
  }
  const body = await request.json().catch(() => null);
  return String(body?.jobId || '').trim();
}

/** One agent as the Labs snapshot shows it. */
function agentView(data, nowMs, labChecks) {
    const lastSeenMs = toMs(data.lastSeenAt);
    const applied = appliedOf(data);
    return {
      agentId: data.id,
      hostname: data.hostname || null,
      version: data.version || null,
      certificateExpiresAt: toIsoOrNull(data.certificateExpiresAt),
      capabilities: data.capabilities || [],
      status: data.status || 'unknown',
      lastSeenAt: lastSeenMs ? new Date(lastSeenMs).toISOString() : null,
      online: isAgentOnline(data, nowMs),
      // The registry half of the document (#740): whether the agent
      // guard admits it, and which service principal it is bound to.
      // The Agents tab's Activate/Deactivate reads the first; the second
      // is an object id, an identifier the go-live script prints, and
      // it is how an operator tells "bound to another principal" apart
      // from the other two ways the guard says "Agent access required".
      active: data.active === true,
      oid: typeof data.oid === 'string' ? data.oid : null,
      registeredAt: toIsoOrNull(data.registeredAt),
      // The commit the host last converged from, as its heartbeat
      // reported it, and the drift verdict for this agent (#1009).
      applied: applied
        ? {
            commit: applied.commit,
            committedAt: applied.committedAt,
            appliedAt: applied.appliedAt,
          }
        : null,
      drift: labChecks.drift.agents?.[data.id] ?? null,
    };
}

/** Why a job cannot be cancelled (gone, or no longer queued): the response, or null. */
function cancelRefusal(job) {
  if (!job) return json(404, { error: 'Job not found' });
  if (job.status !== 'queued') {
    return json(409, { error: 'Job is no longer queued and cannot be cancelled' });
  }
  return null;
}

/** POST /api/enqueueLabJob — editor; allowlisted type + payload cap. */
async function enqueueLabJob({ guard, store, now, uuid }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const { user } = auth;

  try {
    const body = (await request.json().catch(() => null)) || {};
    const { type, payload = '', payloadEncoding = 'text' } = body;
    const refused = enqueueRefusal({ type, payload, payloadEncoding });
    if (refused) return refused;

    const jobId = uuid();
    await store.upsertDoc('lab_jobs', {
      id: jobId,
      type,
      payload,
      payloadEncoding,
      status: 'queued',
      requestedBy: user.oid ?? user.sub,
      requestedByEmail: user.email || user.preferred_username || null,
      createdAt: now().toISOString(),
      claimedAt: null,
      finishedAt: null,
      agentId: null,
      exitCode: null,
      output: null,
    });

    context.log('enqueueLabJob', type);
    return json(200, { jobId, type, status: 'queued' });
  } catch (error) {
    return errorResponse(context, 'Failed to enqueue job', error, 500, request);
  }
}

/**
 * GET|POST /api/getLabJob — viewer; one job with its output. The console
 * tab polls it for the job it just enqueued; output is agent-written
 * text, returned only to authenticated viewers.
 */
async function getLabJob({ guard, store }, request, context) {
  const auth = await guard.requireRole(request, 'viewer');
  if (auth.error) return auth.error;

  try {
    const jobId = await requestedJobId(request);
    if (!jobId) return json(400, { error: 'jobId required' });

    const data = await store.readDoc('lab_jobs', jobId, jobId);
    if (!data) return json(404, { error: `job ${jobId} not found` });

    return json(200, {
      job: {
        id: data.id,
        type: data.type,
        status: data.status,
        output: data.output ?? null,
        exitCode: data.exitCode ?? null,
        agentId: data.agentId || null,
        requestedByEmail: data.requestedByEmail || null,
        createdAt: toIsoOrNull(data.createdAt),
        claimedAt: toIsoOrNull(data.claimedAt),
        finishedAt: toIsoOrNull(data.finishedAt),
      },
    });
  } catch (error) {
    context.error('getLabJob failed:', errorFacts(error));
    return json(500, { error: 'Failed to get lab job' });
  }
}

/** GET|POST /api/getLabsSnapshot — viewer; agents + jobs + queue depth. */
async function getLabsSnapshot({ guard, store, now, readChecks }, request, context) {
  const auth = await guard.requireRole(request, 'viewer');
  if (auth.error) return auth.error;

  try {
    const nowMs = now().getTime();

    // Newest first in the query itself: without ORDER BY, TOP 100 was
    // whichever 100 documents Cosmos returned, and the 25 shown were
    // the newest of those, not of the container (ADR 0033 inventory).
    // Every lab_jobs document carries createdAt (enqueue and the public
    // submit both write it), so the sort drops nothing.
    const [agentRows, jobRows, queuedCount] = await Promise.all([
      store.queryDocs('lab_agents', 'SELECT TOP 200 * FROM c', []),
      store.queryDocs('lab_jobs', 'SELECT TOP 100 * FROM c ORDER BY c.createdAt DESC', []),
      store.queryDocs('lab_jobs', "SELECT VALUE COUNT(1) FROM c WHERE c.status = 'queued'", []),
    ]);

    // The recurrence checks (#1009): whether each host runs main and
    // whether Coder serves its template, judged by the same functions the
    // health pulse records them with (labs/lab-checks.js). Each failed read
    // is that check's `unknown`, and even the checks failing to load at
    // all leaves the snapshot standing, without them; never a 500.
    const labChecks = await readChecks(store, nowMs, agentRows).catch((error) => {
      context.warn?.(`getLabsSnapshot: the lab checks could not be read (${error?.code ?? 'error'})`);
      return { checks: {}, drift: { agents: {} } };
    });

    const agents = agentRows.map((data) => agentView(data, nowMs, labChecks));

    // Sorted again in memory, so a store that ignores ORDER BY (a test
    // double, a future mirror) still shows the newest 25.
    const jobs = [...jobRows]
      .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
      .slice(0, 25)
      .map((data) => ({
        id: data.id,
        type: data.type,
        status: data.status,
        requestedByEmail: data.requestedByEmail || null,
        agentId: data.agentId || null,
        exitCode: data.exitCode ?? null,
        createdAt: toIsoOrNull(data.createdAt),
        claimedAt: toIsoOrNull(data.claimedAt),
        finishedAt: toIsoOrNull(data.finishedAt),
      }));

    return json(200, {
      agents,
      jobs,
      queueDepth: Number(queuedCount[0]) || 0,
      jobTypes: Object.entries(LAB_JOB_TYPES).map(([type, spec]) => ({
        type,
        description: spec.description,
        maxPayloadBytes: spec.maxPayloadBytes,
        payloadEncodings: spec.payloadEncodings,
      })),
      statuses: JOB_STATUSES,
      // By Health Hub probe id: the browser's run of each lab check reads
      // its verdict here (probeRunners.js runLabCheck).
      checks: labChecks.checks,
      generatedAt: now().toISOString(),
    });
  } catch (error) {
    return errorResponse(context, 'Failed to build labs snapshot', error, 500, request);
  }
}

/** POST /api/cancelLabJob — editor; only while still queued. */
async function cancelLabJob({ guard, store, now }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const { user } = auth;

  try {
    const body = (await request.json().catch(() => null)) || {};
    const jobId = String(body.jobId || '').trim();
    if (!jobId) return json(400, { error: 'jobId is required' });

    const job = await store.readDoc('lab_jobs', jobId, jobId);
    const refused = cancelRefusal(job);
    if (refused) return refused;

    // The write carries the ETag (the version stamp the read came back
    // with), so it only lands if the job is still as it was read. Without
    // it, an agent claiming the job between the read and this write would
    // be overwritten with `cancelled` while it runs the job.
    await store.patchDoc(
      'lab_jobs',
      jobId,
      {
        status: 'cancelled',
        finishedAt: now().toISOString(),
        cancelledBy: user.oid ?? user.sub,
      },
      { ifMatch: job._etag }
    );

    context.log('cancelLabJob');
    return json(200, { jobId, status: 'cancelled' });
  } catch (error) {
    // 412: the job changed between the read and the write, so nothing was
    // written. Answered 409 like the agent's side (completeLabJob).
    if (error?.code === 412) {
      return json(409, { error: 'Job changed while it was being cancelled; nothing was cancelled' });
    }
    return errorResponse(context, 'Cancel failed', error, 500, request);
  }
}
