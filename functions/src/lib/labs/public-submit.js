/**
 * Anonymous lab submission (#672, Phase 6 of #657): the Landing Zone
 * Builder's "Validate on the lab".
 *
 *   GET  /api/public/labs/submit        whether a submission would be taken now
 *   POST /api/public/labs/submit        queue one terraform-validate job
 *   GET  /api/public/labs/job?jobId=    that job's status and visitor report
 *
 * Four modules: the contract (public-bounds.js: the switch, the bounds, the
 * door codes, the body's checks, the job document), the lock to the site's
 * pane (public-lock.js: the origin and the Turnstile token), the job read
 * (public-job.js), and this one, which carries the door and the submission
 * pipeline and wires all three routes. Everything a caller or a test needs
 * is re-exported here.
 *
 * ===========================================================================
 * OPEN BY THE OWNER'S DECISION, AND ONLY FROM THE SITE'S PANE.
 * ===========================================================================
 * ADR 0032 decision 6 held this path Gated until the owner revised it, which
 * the owner did on 2026-09-28: open, locked to the Landing Zone Builder's
 * pane on the site by its origin and a Cloudflare Turnstile token
 * (public-lock.js), with every bound below unchanged. Three things must all
 * hold before a job is taken, and each fails closed:
 *
 *   LABS_PUBLIC_SUBMISSION_ENABLED = "true"   (infra: labs_public_submission_enabled)
 *   TURNSTILE_SECRET_KEY resolves             (Key Vault TURNSTILE-SECRET-KEY)
 *   an agent registered for the type is heartbeating
 *
 * The switch is exact: anything but "true" is closed ("false", "TRUE", "1",
 * absent). While it is off, every one of the three routes answers
 * `PUBLIC_SUBMISSION_CLOSED` before it reads the body, the caller's identity
 * or the store, so a closed path can never touch the queue. The same rule as
 * NEWSLETTER_SENDING_ENABLED in lib/newsletter/admin-handlers.js, and setting
 * the Terraform variable to false is the one-step kill switch. With the
 * switch on and no Turnstile secret, the submission and the status read
 * answer `TURNSTILE_NOT_CONFIGURED`, again before any read.
 *
 * THE LOCK COMES BEFORE ANY STORE READ OR COUNTER. A POST whose `Origin` is
 * not exactly the site's is 403 ORIGIN_NOT_ALLOWED before its body is read;
 * one without a Turnstile token is 403 TURNSTILE_REQUIRED; a client past ten
 * checks in ten minutes on this instance is 429 TURNSTILE_RATE_LIMITED; one
 * Cloudflare's siteverify does not pass for the site's hostname and the
 * `lab-validate` action is 403 TURNSTILE_FAILED; and siteverify out of reach
 * is 503 TURNSTILE_UNAVAILABLE. All five happen before the lab is read, so a
 * refused request costs the store nothing and spends no one's quota.
 *
 * ===========================================================================
 * THE BOUNDS ARE DECISION 6's, AND NO WIDER. Each one is a test.
 * ===========================================================================
 *   - Only `terraform-validate`: a body naming any other type is 400.
 *   - A 64 KB payload, measured on the encoded string, the same cap as the
 *     admin enqueue (LAB_JOB_TYPES in lib/labs.js); larger is 413. A
 *     `Content-Length` over the envelope's cap is refused before the body is
 *     read at all.
 *   - 2 submissions an hour per client, through `enforceSubmissionQuota` on
 *     the Cloudflare-verified hashed identity every anonymous route uses
 *     (auth/client-identity.js; `lab-caller:<hash>` in submission_quota); the
 *     third is 429. The window is the helper's: it opens at a client's first
 *     submission and resets an hour later, as it does for every anonymous
 *     route.
 *   - 50 a day globally, a counter `lab-public-quota:<day>` in
 *     tool_service_cache taken with a compare-and-increment (lib/daily-cap.js,
 *     the explain route's counter); the fifty-first is 503 until tomorrow, UTC.
 *   - Refused outright while more than 20 jobs are queued: 503 LAB_QUEUE_FULL.
 *   - Written with `public: true` and a one-day `ttl`.
 *
 * FAIL CLOSED WHILE NO AGENT IS ONLINE. A job is queued only when a lab
 * agent registered for `terraform-validate` has heartbeated within the
 * admin snapshot's window and has not announced its own shutdown
 * (`isAgentOnline`, lib/labs.js), so a submission never waits in a queue
 * nobody drains. No agent is 503 LAB_AGENT_OFFLINE; a
 * failed read of the agents or the queue is 503 LAB_STATUS_UNAVAILABLE,
 * never "open".
 *
 * ORDER. Switch, Turnstile configured, origin, body, identity, the Turnstile
 * token, lab, then the two counters, then the write. The first two are the
 * door for everyone and read only settings; the origin reads one header; the
 * token is checked after the identity because siteverify is given the
 * address the identity trusts. The lab check comes before the counters so a
 * visitor is never charged for a job the lab could not have run, the same
 * reason the explain route checks its provider before counting. The lab
 * check reads the status route's one-minute door first: a shut door there
 * refuses without reading the lab, so anonymous POSTs cannot drive the two
 * reads while the lab is down or full. Only a door that is open, or not
 * cached, is read live, because the queue ceiling needs a fresh count.
 *
 * WHAT IS NOT ENFORCED ATOMICALLY. The queue ceiling is a count read before
 * the write: Cosmos has no cross-document transaction here, so submissions
 * in flight at the same instant can each see 20 and each be written. The
 * overshoot is bounded by those simultaneous submissions that also pass both
 * counters, and the counters are exact, so the queue can never gain more
 * than 50 public jobs a day, nor more than 2 an hour from one client. Making
 * the ceiling exact needs a queued-count document the agent's claim
 * decrements (lib/lab-agent.js), which is a change to the agent protocol and
 * is not made here.
 *
 * THE ONE-DAY TTL. `lab_jobs` has TTL on at the container (default 30 days,
 * infra/cosmos-containers.json), so a document's own `ttl` governs it. Cosmos
 * counts it from the document's last write, so a job lives a day after it
 * finishes. The agent's claim spreads the job it replaces and its
 * completion is a patch (lib/lab-agent.js), so both keep `public` and `ttl`.
 * The job read (public-job.js) refuses a document past its day by its `_ts`.
 *
 * NOTHING REWRITES THE LEARNER'S FILES HERE. ADR 0032 decision 5: the
 * payload keeps its registry `source` and `version` lines, and the
 * `terraform-validate` capability rewrites them to the runner image's
 * vendored copies on its own tmpfs copy inside the job
 * (lab-image/bin/hcw-terraform-validate).
 */

import { randomUUID } from 'node:crypto';
import { CACHE_CONTAINER, utcDay } from '../cloud-tools/history.js';
import { takeDailyCap } from '../daily-cap.js';
import { isAgentOnline } from '../labs.js';
import { enforceSubmissionQuota } from '../submissions.js';
import { createMinuteCache, jsonResponse, MINUTE_CACHE_SECONDS } from './minute-cache.js';
import {
  CLOSED_DOOR,
  DOOR_CODES,
  LIMIT_CODES,
  LIMIT_REASONS,
  PUBLIC_BOUNDS,
  PUBLIC_LAB_JOB_TYPE,
  PUBLIC_MAX_BODY_BYTES,
  PUBLIC_PER_CLIENT_PER_HOUR,
  PUBLIC_PER_DAY,
  PUBLIC_QUEUE_CEILING,
  PUBLIC_QUOTA_TTL_SECONDS,
  UNCONFIGURED_DOOR,
  publicJobDocument,
  publicQuotaId,
  publicSubmissionEnabled,
  shutDoor,
  validatePublicSubmission,
} from './public-bounds.js';
import { getPublicJob } from './public-job.js';
import {
  CHECK_WINDOW_MS,
  LOCK_CODES,
  LOCK_REASONS,
  createCheckLimiter,
  isSiteOrigin,
  turnstileConfigured,
  turnstileSecret,
  verifyTurnstileToken,
} from './public-lock.js';
import { LAB_JOBS_CONTAINER } from './rollup.js';
import { errorFacts } from '../http/error-response.js';

export * from './public-bounds.js';
export * from './public-lock.js';
export { getPublicJob, isLivePublicJob, projectPublicJob } from './public-job.js';

/**
 * The door every visitor meets before any store read: the switch, then the
 * Turnstile secret. Null when both are in place and the lab itself decides.
 */
function settingsDoor(env) {
  if (!publicSubmissionEnabled(env)) return CLOSED_DOOR;
  if (!turnstileConfigured(env)) return UNCONFIGURED_DOOR;
  return null;
}

/** The door, cached a minute for the page's status read and the POST's first look. */
export const PUBLIC_STATUS_CACHE_ID = 'labs:public-submit';

/**
 * Whether a lab agent could run a public job now, and how deep the queue
 * is: the two reads getLabsSnapshot makes (lib/labs.js), plus the agent's
 * registered capabilities, because an online agent that is not registered
 * for terraform-validate would never claim one. A count that is not a
 * number throws, so an unreadable queue is "unavailable", never "empty".
 */
async function readReadiness({ store, now }) {
  const [agents, queued] = await Promise.all([
    // `status` and `active` as well as `lastSeenAt`: the online rule reads all three (#1009, #1018).
    store.queryDocs('lab_agents', 'SELECT TOP 200 c.lastSeenAt, c.status, c.active, c.capabilities FROM c', []),
    store.queryDocs(LAB_JOBS_CONTAINER, "SELECT VALUE COUNT(1) FROM c WHERE c.status = 'queued'", []),
  ]);
  const count = Number(Array.isArray(queued) ? queued[0] : Number.NaN);
  if (!Number.isFinite(count)) throw new Error('the queued-job count was not a number');
  const nowMs = now();
  const canRun = (agent) =>
    isAgentOnline(agent, nowMs) &&
    Array.isArray(agent?.capabilities) &&
    agent.capabilities.includes(PUBLIC_LAB_JOB_TYPE);
  return { online: (Array.isArray(agents) ? agents : []).some(canRun), queued: count };
}

/** The door, read live. The switch is checked by the caller first. */
async function readDoor(deps, context) {
  let readiness;
  try {
    readiness = await readReadiness(deps);
  } catch (error) {
    context?.warn?.(`labs public submit: readiness read failed: ${errorFacts(error)}`);
    return shutDoor(DOOR_CODES.unavailable);
  }
  if (!readiness.online) return { ...shutDoor(DOOR_CODES.offline), queued: readiness.queued };
  if (readiness.queued > PUBLIC_QUEUE_CEILING) {
    return { ...shutDoor(DOOR_CODES.full), queued: readiness.queued };
  }
  return { configured: true, open: true, code: null, reason: null, queued: readiness.queued };
}

/** The door from the minute cache, else live (and then cached). */
async function cachedDoor(deps, context) {
  let door = await deps.cache.read(context);
  if (!door) {
    door = await readDoor(deps, context);
    await deps.cache.write(door, context);
  }
  return door;
}

const reply = (status, body, headers = {}) => ({ status, body, headers });
const toResponse = ({ status, body, headers }) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const refusal = (status, code, error, headers) => reply(status, { ok: false, code, error }, headers);

/** `Content-Length` as a number, or 0 when absent or unparseable (admin-uploads.js's reading). */
function readContentLength(request) {
  const parsed = Number.parseInt(String(request?.headers?.get?.('content-length') ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The submission pipeline, one module-scope step per bound, in the order
 * the header gives. Each `(deps, state)` either answers (returns a reply) or
 * fills in what the next needs (returns null).
 */

/**
 * The switch, then the Turnstile secret: a shut door for everyone, from
 * settings alone. The visitor reads the door's sentence; which setting shut it
 * is the code, and the log line says it in words for whoever fixes it.
 */
async function checkSettings({ env }, state) {
  const shut = settingsDoor(env);
  if (!shut) return null;
  state.context.warn?.(
    `labs public submit refused: ${shut.code === DOOR_CODES.closed ? 'the public submission switch is off' : 'the Turnstile secret is not configured'}`
  );
  return reply(503, { ok: false, configured: false, code: shut.code, error: shut.reason });
}

/** Exactly the site's origin, from its pane. One header, before the body is read. */
async function checkOrigin(_deps, state) {
  const origin = state.request?.headers?.get?.('origin') ?? null;
  if (isSiteOrigin(origin)) return null;
  state.context.warn?.(`labs public submit refused: ${origin ? 'an origin that is not the site' : 'no Origin header'}`);
  return refusal(403, LOCK_CODES.origin, LOCK_REASONS[LOCK_CODES.origin]);
}

/** The raw body, bounded twice: by its declared length, then by what arrived. */
async function readBoundedBody(request) {
  const tooLarge = { error: `Body must be at most ${PUBLIC_MAX_BODY_BYTES} bytes` };
  if (readContentLength(request) > PUBLIC_MAX_BODY_BYTES) return tooLarge;
  const raw = String((await request.text().catch(() => '')) ?? '');
  return Buffer.byteLength(raw, 'utf8') > PUBLIC_MAX_BODY_BYTES ? tooLarge : { raw };
}

async function readRequest(_deps, state) {
  const read = await readBoundedBody(state.request);
  if (read.error) return refusal(413, 'PAYLOAD_TOO_LARGE', read.error);
  let body;
  try {
    body = JSON.parse(read.raw);
  } catch {
    return refusal(400, 'INVALID_BODY', 'Body must be valid JSON');
  }
  const validated = validatePublicSubmission(body);
  if (!validated.error) {
    state.value = validated.value;
    // The lock's, not the job's: checked by checkTurnstile, never written.
    state.turnstileToken = body.turnstileToken;
    return null;
  }
  const code = validated.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY';
  return refusal(validated.status, code, validated.error);
}

async function checkIdentity({ identity }, state) {
  try {
    state.clientKey = identity.anonymousKey(state.request).key;
    state.remoteIp = identity.trustedClientIp?.(state.request) ?? null;
    return null;
  } catch {
    state.context.warn?.('labs public submit rejected: unverified origin');
    return refusal(403, 'FORBIDDEN', 'Forbidden');
  }
}

/**
 * The Turnstile token, checked with Cloudflare. Before the lab, so no store
 * read and no quota counter; the only count is the in-memory check limiter,
 * which caps how many siteverify calls one client can cause.
 */
async function checkTurnstile({ env, fetch, now, checkLimiter }, state) {
  const token = state.turnstileToken;
  if (typeof token !== 'string' || !token.trim()) {
    return refusal(403, LOCK_CODES.required, LOCK_REASONS[LOCK_CODES.required]);
  }
  if (!checkLimiter.take(state.clientKey, now())) {
    state.context.warn?.('labs public submit refused: too many Turnstile checks from one client');
    return refusal(429, LOCK_CODES.attempts, LOCK_REASONS[LOCK_CODES.attempts], {
      'Retry-After': String(CHECK_WINDOW_MS / 1000),
    });
  }
  const verdict = await verifyTurnstileToken({
    fetch,
    secret: turnstileSecret(env),
    token,
    remoteIp: state.remoteIp,
  });
  if (verdict.ok) return null;
  state.context.warn?.(`labs public submit refused by the Turnstile check: ${verdict.detail}`);
  if (verdict.kind === 'unavailable') {
    return refusal(503, LOCK_CODES.unavailable, LOCK_REASONS[LOCK_CODES.unavailable], { 'Retry-After': '60' });
  }
  return refusal(403, LOCK_CODES.failed, LOCK_REASONS[LOCK_CODES.failed]);
}

async function checkLab(deps, state) {
  const cached = await deps.cache.read(state.context);
  const door = cached && !cached.open ? cached : await readDoor(deps, state.context);
  if (door !== cached) await deps.cache.write(door, state.context);
  if (door.open) return null;
  const headers = door.code === DOOR_CODES.full ? { 'Retry-After': '300' } : {};
  return refusal(503, door.code, door.reason, headers);
}

async function checkClientQuota({ store, now }, state) {
  try {
    await enforceSubmissionQuota(store, `lab-caller:${state.clientKey}`, {
      now: now(),
      limit: PUBLIC_PER_CLIENT_PER_HOUR,
    });
    return null;
  } catch (error) {
    if (error?.code !== 'SUBMISSION_RATE_LIMIT') throw error;
    return refusal(429, LIMIT_CODES.client, LIMIT_REASONS[LIMIT_CODES.client], {
      'Retry-After': '3600',
    });
  }
}

async function checkDailyCap({ store, now }, state) {
  state.nowIso = new Date(now()).toISOString();
  const day = utcDay(state.nowIso);
  const allowed = await takeDailyCap(store, {
    container: CACHE_CONTAINER,
    id: publicQuotaId(day),
    kind: 'lab-public-quota',
    day,
    nowIso: state.nowIso,
    limit: PUBLIC_PER_DAY,
    ttlSeconds: PUBLIC_QUOTA_TTL_SECONDS,
  });
  if (allowed) return null;
  state.context.warn?.(
    `labs public submit refused: today's ${PUBLIC_PER_DAY} public jobs are used`
  );
  return refusal(503, LIMIT_CODES.daily, LIMIT_REASONS[LIMIT_CODES.daily]);
}

async function enqueue({ store, uuid }, state) {
  const jobId = uuid();
  await store.createDoc(LAB_JOBS_CONTAINER, publicJobDocument(jobId, state.value, state.nowIso));
  state.context.log?.('labs public submit queued', jobId);
  return reply(202, { ok: true, jobId, type: PUBLIC_LAB_JOB_TYPE, status: 'queued' });
}

const SUBMIT_STEPS = Object.freeze([
  checkSettings,
  checkOrigin,
  readRequest,
  checkIdentity,
  checkTurnstile,
  checkLab,
  checkClientQuota,
  checkDailyCap,
  enqueue,
]);

/** POST public/labs/submit: the pipeline above. */
async function submitJob(deps, request, context) {
  const state = { request, context };
  try {
    for (const step of SUBMIT_STEPS) {
      const outcome = await step(deps, state);
      if (outcome) return toResponse(outcome);
    }
    // `enqueue` always replies; reaching here is a programming error.
    throw new Error('labs public submit pipeline ended without a reply');
  } catch (error) {
    context.error?.('publicLabsSubmit failed:', errorFacts(error));
    return toResponse(reply(500, { ok: false, error: 'Failed to submit the lab job' }));
  }
}

/**
 * GET public/labs/submit: the door, and the bounds behind it. It says why a
 * shut door is shut: switched off (PUBLIC_SUBMISSION_CLOSED), no Turnstile
 * secret (TURNSTILE_NOT_CONFIGURED), no agent (LAB_AGENT_OFFLINE), the queue
 * full, or the lab unreadable. No store read for the first two.
 */
async function getSubmissionStatus(deps, _request, context) {
  try {
    const door = settingsDoor(deps.env) ?? (await cachedDoor(deps, context));
    return jsonResponse(200, { ...door, bounds: PUBLIC_BOUNDS }, MINUTE_CACHE_SECONDS);
  } catch (error) {
    context.error?.('publicLabsSubmit status failed:', errorFacts(error));
    return jsonResponse(500, { error: 'Failed to read the lab submission status' });
  }
}

/**
 * @param {object} deps
 * @param {{ anonymousKey: Function, trustedClientIp: Function }} deps.identity - auth/client-identity.js
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, createDoc: Function, incrementIf: Function, replaceDocIfMatch: Function }} deps.store
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [deps.env] - read per request
 * @param {() => number} [deps.now] - epoch ms
 * @param {() => string} [deps.uuid]
 * @param {typeof fetch} [deps.fetch] - for Turnstile's siteverify (public-lock.js)
 */
export function createPublicSubmitHandlers({
  identity,
  store,
  env = process.env,
  now = () => Date.now(),
  uuid = randomUUID,
  fetch = globalThis.fetch,
}) {
  const cache = createMinuteCache({
    store,
    id: PUBLIC_STATUS_CACHE_ID,
    kind: 'labs-public-submit',
    now,
    seconds: MINUTE_CACHE_SECONDS,
  });
  // One per handler set, which is one per worker process (labs-public-http.js
  // builds the handlers once), so the limit is per instance.
  const checkLimiter = createCheckLimiter();
  const deps = { identity, store, env, now, uuid, cache, fetch, checkLimiter };

  return {
    getSubmissionStatus: (request, context) => getSubmissionStatus(deps, request, context),
    submitJob: (request, context) => submitJob(deps, request, context),
    getJob: (request, context) => getPublicJob(deps, request, context),
    /** The one registration for public/labs/submit: GET is the door, POST submits. */
    submitRoute: (request, context) =>
      String(request.method).toUpperCase() === 'POST'
        ? submitJob(deps, request, context)
        : getSubmissionStatus(deps, request, context),
  };
}
