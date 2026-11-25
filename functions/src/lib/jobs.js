/**
 * jobs.js — in-platform asynchronous jobs (T-322).
 *
 * Flex Consumption caps an HTTP response at 230 seconds at the load balancer,
 * and nothing in host.json can raise it. Six Site-Main handlers declare
 * longer timeouts and make the browser wait (generateListenAndLearn 540 s,
 * refreshToolServiceCache 300 s, forgeArticle 300 s, fetchRssFeedsManual
 * 300 s, generateWeeklyDigest 300 s, batchInspect 300 s). On Azure each of
 * them becomes a JOB: the HTTP call returns 202 with a job id in well under a
 * second, a queue-triggered worker does the work with the non-HTTP timeout
 * (30 minutes on Flex), and the client polls `getJob` until a terminal state.
 *
 * Why not `lab_jobs`: that flow hands jobs to the external VPS agent, which
 * polls, claims and reports back over its own App Role. These jobs run
 * INSIDE the Function App, on the Storage Queue the host already owns
 * (AzureWebJobsStorage, identity-based; the app's managed identity holds
 * Queue Data Contributor on it), so no new credential and no new service.
 *
 * Flow
 *   POST /api/enqueueJob {type, payload}
 *     → 202 {jobId}                      (document 'queued' + queue message)
 *   queue 'platform-jobs' → runJob(message)
 *     → claim with an etag-conditioned replace ('queued' → 'running'), so a
 *       duplicate delivery — queues are at-least-once — is a no-op;
 *     → run the registered worker under the type's own timeout;
 *     → 'succeeded' | 'failed' | 'timeout', with result or error.
 *   GET|POST /api/getJob?jobId=…
 *     → the document, minus Cosmos system fields.
 *
 * Worker contract: `worker(payload, { context, job, now })` returns a small,
 * JSON-serialisable result (the document is the record; large outputs belong
 * in their own container or in blob storage, with the id in the result). A
 * thrown error becomes `failed` with its message; it is NOT retried — the
 * document is the source of truth and an operator re-enqueues deliberately.
 *
 * The document is written before the queue message is sent by the output
 * binding, so a binding that fails after the write leaves the job 'queued'
 * with no message behind it. That gap was left open on purpose at first and
 * is now closed: `createJobSweeper` below re-enqueues stale 'queued' jobs, run
 * every 15 minutes by `platformJobSweeper` (functions/jobs-sweeper.js) when
 * the `PLATFORM_JOB_SWEEPER` timer is armed. `noop` is here so the whole path
 * can be exercised end to end.
 */
import { randomUUID } from 'node:crypto';
import { ROLE_NAMES, roleLevel } from './auth/roles.js';
import { runAsJob } from './job-context.js';
import { buildJobSweeper } from './job-sweeper.js';
import { AuthoredError, errorResponse, logFailure, storedFailure, errorFacts } from './http/error-response.js';

export const JOBS_CONTAINER = 'jobs';
export const JOBS_QUEUE = 'platform-jobs';

export const JOB_STATUSES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'failed',
  'timeout',
  'cancelled',
]);
export const TERMINAL_JOB_STATUSES = Object.freeze(['succeeded', 'failed', 'timeout', 'cancelled']);

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ERROR_CHARS = 2000;

/**
 * The role a job is read under when its type is no longer registered (a type
 * renamed or removed since the job was queued): the enqueue floor, editor.
 * Nobody below it could have queued the job, so nobody below it reads its
 * payload and result (#945).
 */
export const JOB_READ_FLOOR = 'editor';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * A hook's result as a plain, JSON-round-tripped object, or `{}`.
 *
 * Throws on anything JSON.stringify refuses (BigInt, a cycle), so the caller's
 * try/catch sees it BEFORE the response is built rather than json() seeing it
 * after the job is queued. A Promise throws too: the hook is synchronous by
 * contract, and a thenable would otherwise stringify to `{}` and hide the
 * author's mistake without a word. Anything else that is not a plain object
 * — an array, a string, null — is `{}`: spreading those into a body is never
 * intended.
 */
function serialisableObject(value) {
  if (typeof value?.then === 'function') {
    throw new Error('acceptedDetails returned a Promise; the hook must be synchronous');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = JSON.parse(JSON.stringify(value));
  return clean && typeof clean === 'object' && !Array.isArray(clean) ? clean : {};
}

// ---------------------------------------------------------------------------
// Type registry
// ---------------------------------------------------------------------------

const registry = new Map();

/**
 * Register a job type. Called at module load by the feature that owns the
 * worker; the registry is process-wide because the HTTP function (enqueue)
 * and the queue function (run) are the same process.
 *
 * @param {string} type
 * @param {object} spec
 * @param {(payload: any, ctx: {context: object, job: object, now: () => Date}) => Promise<any>} spec.worker
 * @param {string} [spec.description]
 * @param {number} [spec.maxPayloadBytes] - JSON bytes of `payload`; default 64 KiB
 * @param {number} [spec.timeoutMs] - worker budget; default 10 minutes
 * @param {string} spec.role - role required to enqueue. REQUIRED and explicit:
 *   a job type is a second door onto whatever its worker does, and the worker
 *   calls the underlying pipeline directly, below the HTTP route's guard. When
 *   this defaulted to 'editor', `publish-content` silently inherited it and an
 *   editor could publish live past the `publisher` gate on POST
 *   /api/publishContent (T-701). Declare the role of the HTTP route that
 *   performs the same action; `jobs.roles.test.js` asserts the pairing.
 * @param {(info: {job: object, status: string, result: any, error: string|null},
 *          ctx: {context: object, now: () => Date}) => Promise<void>} [spec.onComplete]
 *   Called after the terminal status is written (succeeded/failed/timeout).
 *   Best effort: a throw is logged and never changes the job's outcome. Added
 *   for failure-only Telegram notifications (T-607) — successes already ride
 *   the forge_ready rising edge, so hooks should stay quiet on success.
 * @param {(payload: any) => object|null|undefined} [spec.acceptedDetails]
 *   Extra fields merged into the 202 body, computed BEFORE the job runs.
 *   Exists so a caller can be told what a run is expected to cost at the
 *   moment it asks for one (ADR 0029 §2a: Listen & Learn states its speech
 *   spend before starting rather than in the usage table afterwards). The
 *   argument is the RAW `body.payload`: at that point it has passed the role
 *   check, is JSON-serialisable and is under `maxPayloadBytes`, and nothing
 *   else — no per-type validation has run (the worker does that). Hook
 *   authors treat every field as untrusted: read shapes defensively, never
 *   echo values back, and never let a field choose a path. Best effort and
 *   synchronous: a throw is logged and the job is still enqueued, and the
 *   base fields (`ok`, `jobId`, …) always win over anything returned.
 */
export function registerJobType(type, spec) {
  if (typeof type !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(type)) {
    throw new Error(`job type must be kebab-case: got ${JSON.stringify(type)}`);
  }
  if (!spec || typeof spec.worker !== 'function') {
    throw new Error(`job type ${type}: spec.worker must be a function`);
  }
  // No default. An omitted role used to mean 'editor', which is the wrong
  // answer for anything a publisher-gated route performs — and being the
  // wrong answer silently is what made T-701 a privilege escalation rather
  // than a bug someone noticed.
  // Identity conflicts before spec validity: re-registering a name is about
  // the registry, not about this spec's fields, and the clearer error wins.
  if (registry.has(type)) throw new Error(`job type ${type} is already registered`);
  if (!ROLE_NAMES.includes(spec.role)) {
    throw new Error(
      `job type ${type}: spec.role must be one of ${ROLE_NAMES.join(', ')} — ` +
        `declare the role of the HTTP route that performs the same action`
    );
  }
  registry.set(
    type,
    Object.freeze({
      description: '',
      maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...spec,
      type,
    })
  );
  return registry.get(type);
}

export function getJobType(type) {
  return registry.get(type) ?? null;
}

export function listJobTypes() {
  return [...registry.values()].map(({ type, description, maxPayloadBytes, timeoutMs, role }) => ({
    type,
    description,
    maxPayloadBytes,
    timeoutMs,
    role,
  }));
}

/** Test seam. Production never calls this. */
export function resetJobTypes() {
  registry.clear();
  registerBuiltins();
}

function registerBuiltins() {
  // Exists so the enqueue → queue → worker → poll path can be proven on a
  // deployed app before any real worker lands. Echoes the payload; optional
  // `delayMs` (≤ 20 s) lets a poll loop be watched.
  registerJobType('noop', {
    // Echoes a payload and touches nothing; editor is the enqueue floor.
    role: 'editor',
    description: 'Smoke test — echoes the payload after an optional delayMs (max 20000).',
    maxPayloadBytes: 1024,
    timeoutMs: 30_000,
    /** Echo the payload; the delay ends with the job's signal, like every worker's wait. */
    worker: async (payload, { signal } = {}) => {
      const delay = Math.min(Math.max(Number(payload?.delayMs) || 0, 0), 20_000);
      if (delay) await waitUnlessAborted(delay, signal);
      return { echoed: payload ?? null, delayedMs: delay };
    },
  });
}

/**
 * Resolve after `ms`, or reject with the signal's reason as soon as it fires,
 * so a wait does not hold a job that is already over (#942 follow-up).
 *
 * @param {number} ms
 * @param {AbortSignal|null|undefined} signal
 * @returns {Promise<void>}
 */
function waitUnlessAborted(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

registerBuiltins();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYSTEM_FIELDS = new Set(['_rid', '_self', '_etag', '_attachments', '_ts']);

/**
 * A payload's size as a job document stores it: its JSON, in UTF-8 bytes.
 * An absent payload is MEASURED as `null` (4 bytes), because
 * `JSON.stringify(undefined)` is not JSON. It is not stored as `null`:
 * newJobDoc keeps the payload as given, so an undefined payload leaves the
 * field out of the stored document and the worker receives undefined.
 *
 * @param {any} payload
 * @returns {number}
 */
export function jobPayloadBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
}

/**
 * A job document over its type's payload bound. The sentence is written in
 * newJobDoc from the size, the bound and the type, so an admin route may
 * show it (authored, #945); a route that wants a visitor-safe sentence (the
 * Listen & Learn queue) keys on the code instead.
 */
export class JobPayloadTooLargeError extends AuthoredError {}

/**
 * A worker's own sentence for why its job failed: a payload it refuses, or
 * the outcome a pipeline already reported in a storable sentence. runJob
 * stores it as written; any other throw is stored as the safe sentence with
 * its code and correlation id (#945).
 */
export class JobFailedError extends AuthoredError {}

/**
 * A fresh `queued` job document. One shape, shared by `enqueueJob` and every
 * route, timer and command that enqueues a job of its own (cms/podcast,
 * Listen & Learn, the Forge Studio queue, the Cosmos export scheduler, the
 * Telegram /approve command), so the worker's claim, the sweeper and
 * `getJob` read the same fields wherever the job came from.
 *
 * It is also where every job document's payload bound is enforced (#942
 * follow-up). enqueueJob answers an oversized payload with a 413 before it
 * gets here, but the other writers did not check at all, and the sweeper
 * reads whole job documents (#1198) on the strength of that bound. Every
 * writer builds its document here, and jobs.payload-bound.test.js fails a
 * write to the jobs container that does not. The limit is `maxPayloadBytes`
 * when given (enqueueJob passes its type's), else the registered type's, else
 * the 64 KiB default for a type this process has not registered.
 *
 * @param {{ id: string, type: string, payload: any, requestedBy?: {oid?: string, email?: string}|null, createdAt: string, maxPayloadBytes?: number }} fields
 * @throws {JobPayloadTooLargeError} code `JOB_PAYLOAD_TOO_LARGE`, status 413, for a payload over the limit
 */
export function newJobDoc({ id, type, payload, requestedBy, createdAt, maxPayloadBytes }) {
  const limit = maxPayloadBytes ?? registry.get(type)?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const bytes = jobPayloadBytes(payload);
  if (bytes > limit) {
    throw new JobPayloadTooLargeError(`Payload too large (${bytes} bytes; max ${limit} for ${type})`, {
      code: 'JOB_PAYLOAD_TOO_LARGE',
      status: 413,
    });
  }
  return {
    id,
    type,
    payload,
    status: 'queued',
    createdAt,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    requestedBy: {
      oid: requestedBy?.oid ?? null,
      email: requestedBy?.email ?? null,
    },
    result: null,
    error: null,
  };
}

function maskEmail(value) {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return '***';
  return `${value[0]}***@${value.slice(at + 1)}`;
}

/** The document as a client sees it. */
export function publicJob(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (!SYSTEM_FIELDS.has(k)) out[k] = v;
  if (out.requestedBy && typeof out.requestedBy === 'object') {
    out.requestedBy = {
      ...out.requestedBy,
      email: out.requestedBy.email ? maskEmail(out.requestedBy.email) : null,
    };
  }
  return out;
}

function truncate(text, max = MAX_ERROR_CHARS) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function isPreconditionFailure(err) {
  const code = err?.code ?? err?.statusCode;
  return code === 412 || code === 'PreconditionFailed';
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function, patchDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {Map<string, object>} [deps.types] - test seam; defaults to the module registry
 */
export function createJobHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  types = registry,
}) {
  return {
    /**
     * POST /api/enqueueJob — editor (or the type's own role).
     * @param {object} request
     * @param {object} context
     * @param {{ enqueue: (message: {jobId: string, type: string}) => void }} io - the queue output
     */
    async enqueueJob(request, context, { enqueue } = {}) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;

      let body;
      try {
        body = await request.json();
      } catch {
        return json(400, { ok: false, error: 'Body must be JSON' });
      }
      const type = typeof body?.type === 'string' ? body.type.trim() : '';
      const spec = types.get(type);
      if (!spec) {
        return json(400, {
          ok: false,
          error: `Unknown job type. Allowed: ${[...types.keys()].join(', ')}`,
        });
      }
      // Escalate to the type's own role whenever it outranks the floor above.
      // Compared by hierarchy level, not string inequality: the old
      // `spec.role !== 'editor'` test skipped the check for every type that
      // had silently defaulted to 'editor', which is precisely how
      // publish-content reached processPublishContent without a publisher
      // token (T-701).
      if (roleLevel(spec.role) > roleLevel('editor')) {
        const stricter = await guard.requireRole(request, spec.role);
        if (stricter.error) return stricter.error;
      }

      const payload = body.payload === undefined ? {} : body.payload;
      let payloadBytes;
      try {
        payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      } catch {
        return json(400, {
          ok: false,
          error: 'payload must be JSON-serialisable',
        });
      }
      if (payloadBytes > spec.maxPayloadBytes) {
        return json(413, {
          ok: false,
          error: `Payload too large (${payloadBytes} bytes; max ${spec.maxPayloadBytes} for ${type})`,
        });
      }
      if (typeof enqueue !== 'function') {
        // Misconfigured route, not a client error: say so loudly rather than
        // writing a document nothing will ever pick up.
        context.error?.('enqueueJob: no queue output wired');
        return json(500, { ok: false, error: 'Job queue is not configured' });
      }

      const jobId = uuid();
      // The size was checked above against this type's limit, and answered
      // with a 413; newJobDoc holds the same limit for every other writer.
      const doc = newJobDoc({
        id: jobId,
        type,
        payload,
        requestedBy: auth.user,
        maxPayloadBytes: spec.maxPayloadBytes,
        createdAt: now().toISOString(),
      });
      // Computed before the write so a hook that throws is logged against a
      // job that does not exist yet, and never against one already queued.
      // Serialised HERE as well, not in json() below: json() runs after the
      // document is written and the message sent, so a BigInt or a cycle in
      // the hook's result would answer 500 for a job that IS queued and invite
      // a duplicate on retry. Bookkeeping must not be able to report the work
      // it is bookkeeping as failed — the same rule as recordAiUsage's header.
      let details = {};
      if (typeof spec.acceptedDetails === 'function') {
        try {
          details = serialisableObject(spec.acceptedDetails(payload));
        } catch (error) {
          context.warn?.('enqueueJob: acceptedDetails failed for', type, errorFacts(error));
          details = {};
        }
      }
      try {
        await store.upsertDoc(JOBS_CONTAINER, doc);
        enqueue({ jobId, type });
        context.log?.('enqueueJob', type, `${payloadBytes}B`);
        return json(202, {
          ...details,
          ok: true,
          jobId,
          type,
          status: 'queued',
          poll: `getJob?jobId=${jobId}`,
        });
      } catch (error) {
        context.error?.('enqueueJob failed:', errorFacts(error));
        return json(500, { ok: false, error: 'Failed to enqueue job' });
      }
    },

    /**
     * GET|POST /api/getJob — the job type's own role. `jobId` from the query
     * string or the body.
     *
     * A viewer passes the first gate only so a missing id can be answered;
     * the job itself is read under its type's role, because the payload and
     * result are the type's (a forge-from-url job carries its source URL and
     * brief). A job whose type is no longer registered is held at
     * JOB_READ_FLOOR, so it cannot fall through to the viewer gate (#945).
     *
     * @param {object} request - the HTTP request
     * @param {object} context - the invocation context
     * @returns {Promise<{ status: number, headers: object, body: string }>}
     */
    async getJob(request, context) {
      const auth = await guard.requireRole(request, 'viewer');
      if (auth.error) return auth.error;

      let jobId = '';
      try {
        jobId = request.query?.get?.('jobId') || '';
        if (!jobId && request.method !== 'GET') {
          const body = await request.json().catch(() => ({}));
          jobId = typeof body?.jobId === 'string' ? body.jobId : '';
        }
      } catch {
        jobId = '';
      }
      jobId = String(jobId).trim();
      if (!jobId) return json(400, { ok: false, error: 'jobId is required' });

      try {
        const doc = await store.readDoc(JOBS_CONTAINER, jobId, jobId);
        if (!doc) return json(404, { ok: false, error: 'Job not found' });

        const requiredRole = types.get(doc.type)?.role ?? JOB_READ_FLOOR;
        const stricter = await guard.requireRole(request, requiredRole);
        if (stricter.error) return stricter.error;

        return json(200, { ok: true, job: publicJob(doc) });
      } catch (error) {
        return errorResponse(context, 'Failed to read job', error, 500, request);
      }
    },

    /**
     * Queue worker. Never throws for a job-level failure: the document is the
     * record, and a rethrow would only make the queue redeliver the same
     * message up to the poison threshold.
     *
     * @param {{jobId?: string}} message - the parsed queue message
     * @param {object} context
     * @returns {Promise<{jobId: string|null, outcome: string}>}
     */
    async runJob(message, context) {
      const jobId = typeof message?.jobId === 'string' ? message.jobId : '';
      if (!jobId) {
        context.warn?.('runJob: message without jobId', message);
        return { jobId: null, outcome: 'ignored' };
      }

      const doc = await store.readDoc(JOBS_CONTAINER, jobId, jobId);
      if (!doc) {
        context.warn?.('runJob: a queued job has no document');
        return { jobId, outcome: 'missing' };
      }
      if (doc.status !== 'queued') {
        // Duplicate delivery, or an operator cancelled it while it waited.
        // No job id in these lines: they reach Log Analytics (#1635), and an id is a document id.
        context.log?.(`runJob: a ${doc.type} job is ${doc.status}; skipping`);
        return { jobId, outcome: 'skipped' };
      }

      const spec = types.get(doc.type);
      const startedAt = now().toISOString();
      if (!spec) {
        await store.patchDoc(JOBS_CONTAINER, jobId, {
          status: 'failed',
          startedAt,
          finishedAt: startedAt,
          error: `Unknown job type ${doc.type} (not registered in this deployment)`,
        });
        return { jobId, outcome: 'failed' };
      }

      // Claim. The etag makes two deliveries race safely: the loser gets 412.
      let claimed;
      try {
        claimed = await store.replaceDocIfMatch(JOBS_CONTAINER, {
          ...doc,
          status: 'running',
          startedAt,
          attempts: (doc.attempts || 0) + 1,
        });
      } catch (error) {
        if (isPreconditionFailure(error)) {
          context.log?.(`runJob: a ${doc.type} job was claimed elsewhere`);
          return { jobId, outcome: 'skipped' };
        }
        throw error;
      }

      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort(
              Object.assign(new Error('job timed out'), {
                code: 'JOB_TIMEOUT',
              })
            );
            reject(
              Object.assign(new Error('job timed out'), {
                code: 'JOB_TIMEOUT',
              })
            );
          },
          spec.timeoutMs
        );
      });
      // Best effort, after the terminal write: a hook failure is logged, never
      // re-thrown — it must not turn a finished job into a poisoned message.
      const invokeOnComplete = async (info) => {
        if (typeof spec.onComplete !== 'function') return;
        try {
          await spec.onComplete(info, { context, now });
        } catch (hookError) {
          context.warn?.(
            `runJob: onComplete for ${doc.type} failed: ${errorFacts(hookError)}`
          );
        }
      };

      try {
        const result = await Promise.race([
          // Inside the job's context, the shared Cosmos and Blob clients
          // refuse a write that starts after the timeout (job-context.js).
          // This code, and the hooks below, run outside it.
          runAsJob(controller.signal, () =>
            spec.worker(doc.payload, {
              context,
              job: claimed,
              now,
              signal: controller.signal,
              abortSignal: controller.signal,
            })
          ),
          timeout,
          // The deadline is the worker's, so it is disarmed the moment the
          // race settles: a worker that finished just inside it must not have
          // its signal fire during the terminal write or the hook below.
        ]).finally(() => clearTimeout(timer));
        await store.patchDoc(JOBS_CONTAINER, jobId, {
          status: 'succeeded',
          finishedAt: now().toISOString(),
          result: result === undefined ? null : result,
          error: null,
        });
        context.log?.(`runJob: a ${doc.type} job succeeded`);
        await invokeOnComplete({
          job: claimed,
          status: 'succeeded',
          result: result === undefined ? null : result,
          error: null,
        });
        return { jobId, outcome: 'succeeded' };
      } catch (error) {
        const timedOut = error?.code === 'JOB_TIMEOUT';
        // getJob serves this document to the type's role, so it stores the
        // worker's authored sentence, or a fixed one with the error's code
        // and the log line's correlation id: never a provider's, the
        // store's or a socket's own words (#945). The log line is
        // content-free and carries the same id.
        const correlationId = logFailure(
          context,
          `runJob: ${doc.type} ${timedOut ? 'timed out' : 'failed'}`,
          error
        );
        const errorText = truncate(
          storedFailure(error, timedOut ? 'The job ran out of time.' : 'The job failed.', {
            correlationId,
          })
        );
        await store.patchDoc(JOBS_CONTAINER, jobId, {
          status: timedOut ? 'timeout' : 'failed',
          finishedAt: now().toISOString(),
          error: errorText,
        });
        await invokeOnComplete({
          job: claimed,
          status: timedOut ? 'timeout' : 'failed',
          result: null,
          error: errorText,
        });
        return { jobId, outcome: timedOut ? 'timeout' : 'failed' };
      } finally {
        // Already cleared when the race settled; this covers a worker that
        // threw before the race was entered.
        clearTimeout(timer);
      }
    },
  };
}

// ── Stale-queued sweeper (job-sweeper.js) ───────────────────────────────────

export {
  MAX_REQUEUE_COUNT,
  RUNNING_GRACE_MS,
  STALE_QUEUED_MS,
  SWEEP_BATCH,
} from './job-sweeper.js';

/**
 * The stale-queued and abandoned-job sweeper (job-sweeper.js), over this
 * module's container and registry.
 *
 * @param {object} [deps] store, now, log, and a registry for tests
 */
export function createJobSweeper(deps = {}) {
  return buildJobSweeper(deps, {
    container: JOBS_CONTAINER,
    registry,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  });
}
