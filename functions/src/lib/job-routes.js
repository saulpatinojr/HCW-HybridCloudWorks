/**
 * job-routes.js — the two HTTP routes of the platform jobs (jobs.js):
 * enqueue a job, and read one back. jobs.js wires them into
 * createJobHandlers beside the queue worker.
 */
import { roleLevel } from './auth/roles.js';
import { errorResponse, errorFacts } from './http/error-response.js';
import {
  JOBS_CONTAINER,
  JOB_READ_FLOOR,
  json,
  newJobDoc,
  publicJob,
  serialisableObject,
} from './job-model.js';

/**
 * POST /api/enqueueJob — editor (or the type's own role).
 * @param {object} request
 * @param {object} context
 * @param {{ enqueue: (message: {jobId: string, type: string}) => void }} io - the queue output
 */
export async function enqueueJob({ guard, store, now, uuid, types }, request, context, { enqueue } = {}) {
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
}

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
export async function getJob({ guard, store, types }, request, context) {
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
}
