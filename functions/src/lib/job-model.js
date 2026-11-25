/**
 * job-model.js — what a platform job is (jobs.js): the containers and
 * statuses, the type registry every feature registers its worker in, and
 * the shape of a job document as it is stored and as a client reads it.
 * jobs.js re-exports every public name, so callers and tests import from
 * jobs.js as they always did.
 */
import { ROLE_NAMES } from './auth/roles.js';
import { AuthoredError } from './http/error-response.js';

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

export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The role a job is read under when its type is no longer registered (a type
 * renamed or removed since the job was queued): the enqueue floor, editor.
 * Nobody below it could have queued the job, so nobody below it reads its
 * payload and result (#945).
 */
export const JOB_READ_FLOOR = 'editor';

export const json = (status, body) => ({
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
export function serialisableObject(value) {
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

/** Every registered job type, by name: process-wide (jobs.js reads it). */
export const registry = new Map();

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
