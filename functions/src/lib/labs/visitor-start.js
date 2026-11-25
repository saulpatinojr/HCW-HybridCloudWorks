/**
 * labs/visitor-start.js — the visitor lab sessions' start route: check the
 * visitor, take the start lock, a slot and a daily start, write the record,
 * then ask Coder for the user and workspace (visitor-session.js has the header
 * that explains the sessions and builds the handlers).
 */

import { randomUUID } from 'node:crypto';
import {
  isSiteOrigin,
  LOCK_CODES,
  turnstileSecret,
  verifyTurnstileToken,
  VISITOR_TURNSTILE_ACTION,
} from './public-lock.js';
import { utcDay } from '../cloud-tools/history.js';
import { takeDailyCap } from '../daily-cap.js';
import { recordLabStart, safeLogCode } from './lab-starts.js';
import {
  DOOR_CODES,
  generateVisitorCredentials,
  holdsSlot,
  mayHoldLab,
  PROVISION_LEASE_MS,
  readVisitorMaxConcurrent,
  SESSION_CONTAINER,
  SESSION_STATUS,
  VALID_LAB_WORKSPACES,
  VISITOR_CHECK_REASONS,
  VISITOR_CLIENT_DAILY_LIMIT,
  VISITOR_DOC_TTL_SECONDS,
  VISITOR_JOB_TYPE,
  VISITOR_PENDING_DOC_TTL_SECONDS,
  VISITOR_SESSION_DURATION_MS,
} from './visitor-model.js';
import { createVisitorCoderUser, createVisitorWorkspace } from './visitor-coder.js';
import { reapExpiredVisitorSessions } from './visitor-reap.js';
import { releaseSlot, releaseStartLock, slotHolders, takeSlot, takeStartLock } from './visitor-slots.js';
import { countRefunds, DAILY_CAP_REFUND, recordRefund } from './visitor-refunds.js';
import {
  doorCheck,
  doorRefusal,
  doorShut,
  forbidden,
  isCallersActive,
  jsonResponse,
  listHolding,
  RETRY_AFTER_WINDOW,
  sameClient,
  sessionAnswer,
} from './visitor-routes.js';
import { noteUnfinishedStart } from './visitor-start-note.js';
import { errorKind } from './visitor-session.js';

const capacityFull = () => doorRefusal(DOOR_CODES.capacity_full, 503);

/** A plain refusal: a 4xx answer other than 408 (a timeout, after which the thing may exist). */
const plainRefusal = (status) => Number.isInteger(status) && status >= 400 && status < 500 && status !== 408;

export async function startSession(deps, request, context) {
  const door = doorCheck(process.env);
  if (!door.config) return doorShut(door.code, 503);
  const asked = await readStartRequest(request);
  if (asked.refusal) return asked.refusal;
  const checked = await checkVisitor(deps, request, context, asked.turnstileToken);
  if (checked.refusal) return checked.refusal;
  return startWithSlots({
    ...deps,
    context,
    config: door.config,
    labId: asked.labId,
    clientHash: checked.clientHash,
    nowMs: checked.nowMs,
    nowIso: new Date(checked.nowMs).toISOString(),
  });
}

/** The lab and the Turnstile token from a request that came from the site, or the refusal. */
async function readStartRequest(request) {
  // Origin check
  if (!isSiteOrigin(request.headers.get('origin'))) {
    return {
      refusal: jsonResponse({
        ok: false,
        code: 'ORIGIN_NOT_ALLOWED',
        reason: 'Visitor sessions are permitted only from the site.',
      }, 403),
    };
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return { refusal: jsonResponse({ ok: false, error: 'Malformed JSON body' }, 400) };
  }
  const { labId, turnstileToken } = body || {};
  if (typeof labId !== 'string' || !Object.hasOwn(VALID_LAB_WORKSPACES, labId)) {
    return { refusal: doorRefusal(DOOR_CODES.invalid_lab, 400) };
  }
  if (!turnstileToken || typeof turnstileToken !== 'string') {
    return {
      refusal: jsonResponse({
        ok: false,
        code: 'TURNSTILE_REQUIRED',
        reason: 'Turnstile verification token is required.',
      }, 403),
    };
  }
  return { labId, turnstileToken };
}

/** The verified caller and the time, or the refusal. */
async function checkVisitor(deps, request, context, turnstileToken) {
  const caller = deps.identify(request, context);
  if (!caller) return { refusal: forbidden() };
  const { clientHash, clientIp } = caller;
  const nowMs = deps.clock();

  // At most CHECK_ATTEMPTS_PER_WINDOW calls to Cloudflare per visitor per
  // instance, before any is made (#1400, item 2; public-submit.js does the same).
  if (!deps.checkLimiter.take(clientHash, nowMs)) {
    context?.warn?.('visitor-session: refused a start: too many human verification checks from one visitor');
    return {
      refusal: jsonResponse(
        { ok: false, code: LOCK_CODES.attempts, reason: VISITOR_CHECK_REASONS[LOCK_CODES.attempts] },
        429,
        RETRY_AFTER_WINDOW
      ),
    };
  }

  // Verify Turnstile
  const verification = await verifyTurnstileToken({
    fetch: deps.fetchImpl,
    secret: turnstileSecret(process.env),
    token: turnstileToken,
    remoteIp: clientIp,
    action: VISITOR_TURNSTILE_ACTION,
  });
  if (!verification.ok) return { refusal: verificationRefusal(verification, context) };
  return { clientHash, nowMs };
}

function verificationRefusal(verification, context) {
  // Why goes to the log; the visitor gets a plain sentence of their own. The detail
  // can carry Cloudflare's error codes, such as `missing-input-secret`,
  // which tell an anonymous caller how the site is set up (#1400, item 3).
  context?.warn?.(`visitor-session: refused a start by the human verification check: ${verification.detail}`);
  const unavailable = verification.kind === 'unavailable';
  const code = unavailable ? LOCK_CODES.unavailable : LOCK_CODES.failed;
  return jsonResponse(
    { ok: false, code, reason: VISITOR_CHECK_REASONS[code] },
    unavailable ? 503 : 403,
    unavailable ? { 'Retry-After': '60' } : {}
  );
}

/**
 * The records that may hold a lab, after the sweep has reclaimed capacity
 * from expired sessions (and, on the way, retried any clean-up Coder has not
 * confirmed). Waited for only when a session is past its hour, so its log
 * lines can be written; a retry alone runs behind the answer, without a log,
 * as the status route's does.
 */
async function holdingAfterSweep(start) {
  const { store, fetchImpl, config, nowMs, nowIso, context } = start;
  const holding = await listHolding(store);
  const expired = holding.filter((s) => s.status === SESSION_STATUS.active && s.expiresAt <= nowIso);
  if (!start.sweep.due(nowMs)) return holding;
  start.sweep.ran(nowMs);
  if (expired.length === 0) {
    reapExpiredVisitorSessions(store, fetchImpl, config, { nowIso }).catch(() => {});
    return holding;
  }
  await reapExpiredVisitorSessions(store, fetchImpl, config, {
    nowIso,
    log: (line) => context?.warn?.(line),
  }).catch(() => {});
  // The sweep changed what holds a lab: a session whose delete Coder
  // refused is now waiting, and still holds one, so the list is read
  // again rather than trusted from before the sweep (#1464 review, finding B).
  return listHolding(store);
}

async function startWithSlots(start) {
  const holding = await holdingAfterSweep(start);

  // The caller's own running session is handed back, and costs nothing:
  // a reload and a second press of start are the same visitor's one lab
  // (#1400, item 1).
  const slots = holding.filter((s) => holdsSlot(s, start.nowIso));
  const existing = slots.find((s) => isCallersActive(s, start.clientHash));
  if (existing) return sessionAnswer(existing);

  const maxConcurrent = readVisitorMaxConcurrent(process.env);
  if (slots.length >= maxConcurrent) return capacityFull();

  // From here a new lab may be made, and two requests could get here at
  // the same moment, each having read the same list. Two creates that
  // Cosmos refuses with 409 when the id is taken make it safe (#1464
  // review, finding A): the visitor's start lock (one start at a time per
  // visitor) and a slot (one per lab the visitors may hold at once).
  const sessionId = randomUUID();
  const lock = await takeStartLock(start.store, start.clientHash, sessionId, start.nowMs);
  if (!lock) return doorRefusal(DOOR_CODES.start_in_progress, 409, { 'Retry-After': '30' });
  try {
    return await startHoldingLock({ ...start, maxConcurrent, sessionId });
  } finally {
    await releaseStartLock(start.store, lock, start.clock());
  }
}

/** Everything a start does while it holds the visitor's lock. */
async function startHoldingLock(start) {
  const { store, sessionId, nowIso, clientHash } = start;
  // Read again now that no other start of this visitor's can run (#1464
  // review, round 2): a start that finished between the first read and
  // this lock has made the caller's session, which is handed back.
  const fresh = await listHolding(store);
  const mineNow = fresh.find(
    (s) => s.status === SESSION_STATUS.active && s.expiresAt > nowIso && sameClient(s.clientHash, clientHash)
  );
  if (mineNow) return sessionAnswer(mineNow);

  const slot = await takeSlots(start, fresh);
  if (slot === null) return capacityFull();
  const letSlotGo = () => releaseSlot(store, { id: sessionId, slot }, start.clock());

  const quota = await takeDailyStart(start, letSlotGo);
  if (!quota) {
    await letSlotGo();
    return doorRefusal(DOOR_CODES.client_rate_limited, 429);
  }

  // The record comes first, before Coder is asked for anything, so that
  // whatever Coder makes has a record the sweep can find (#1403, item 2).
  const creds = generateVisitorCredentials();
  const provisioning = provisioningRecord(start, { creds, slot, quota });
  const held = await recordStart(start, provisioning, letSlotGo);
  if (!held) return doorRefusal(DOOR_CODES.coder_unavailable, 503);
  return provisionLab(start, { held, creds, slot, quota });
}

/**
 * A slot for this start, or null when the lab is full.
 *
 * The limit holds because every holder owns one of the `max` slot
 * documents, and a slot is taken only by a create or a conditional
 * replace that one request can win (#1464 review, rounds 2 and 3).
 * A holder is a record that may still hold a lab (`mayHoldLab`: past
 * its hour included, until its clean-up is confirmed), or a start that
 * has taken its slot and not yet written its record (a young slot
 * whose holder cannot be seen, which `slotIsFree` never takes over).
 *
 * Every holding record counts, whatever slot it has or has not.
 */
async function takeSlots(start, fresh) {
  const { store, maxConcurrent, nowMs } = start;
  const holders = fresh.filter(mayHoldLab);
  if (holders.length >= maxConcurrent) return null;
  // A holding record that no slot names (one saved before slots
  // existed, or one whose slot was lost) gets one first. Only then does
  // this start take its own, so it can never use a slot a record is
  // still counting on, at any index. If one cannot be given a slot,
  // the lab is full.
  const named = await slotHolders(store, maxConcurrent);
  for (const holder of holders) {
    if (named.has(holder.id)) continue;
    if ((await takeSlot(store, holder.id, maxConcurrent, nowMs)) === null) return null;
    named.add(holder.id);
  }
  return takeSlot(store, start.sessionId, maxConcurrent, nowMs);
}

/**
 * Only now is a new lab really going to be made, so only now is one of
 * the visitor's daily starts taken (#1400, item 1). A start that then
 * fails gives it back with a refund document, which raises the limit
 * by one for that counter (`recordRefund`, `countRefunds`). The quota's
 * name, or null when the day's starts are used up.
 */
async function takeDailyStart(start, letSlotGo) {
  const { store, nowMs, nowIso } = start;
  const day = utcDay(nowMs);
  const quota = { container: 'submission_quota', id: `visitor-quota:${start.clientHash}:${day}` };
  try {
    const refunds = await countRefunds(store, quota.id);
    const allowed = await takeDailyCap(store, {
      ...quota,
      kind: 'visitor_session_daily',
      day,
      nowIso,
      limit: VISITOR_CLIENT_DAILY_LIMIT + refunds,
      ttlSeconds: 86400 * 2,
    });
    return allowed ? quota : null;
  } catch (error) {
    await letSlotGo();
    throw error;
  }
}

function provisioningRecord(start, { creds, slot, quota }) {
  const { sessionId, clientHash, labId, nowIso, nowMs } = start;
  return {
    id: sessionId,
    type: VISITOR_JOB_TYPE,
    status: SESSION_STATUS.provisioning,
    endStatus: SESSION_STATUS.ended,
    clientHash,
    labId,
    coderUsername: creds.username,
    workspaceName: VALID_LAB_WORKSPACES[labId],
    slot,
    dailyCap: quota,
    dailyCapRefund: DAILY_CAP_REFUND.pending,
    createdAt: nowIso,
    cleanupAttempts: 0,
    workspaceGone: false,
    userGone: false,
    retryAt: new Date(nowMs + PROVISION_LEASE_MS).toISOString(),
    ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
  };
}

/** The record as written, or null when it could not be (the start then answers 503). */
async function recordStart(start, provisioning, letSlotGo) {
  const { store, context } = start;
  try {
    return (await store.createDoc(SESSION_CONTAINER, provisioning)) ?? provisioning;
  } catch (error) {
    // Nothing was asked of Coder, so there is nothing to clean up, and
    // the start is given back. The refund is one document per session,
    // so if the record was written after all (a timeout, a 5xx), the
    // sweep's own give-back for it finds this refund and adds none. The
    // slot is let go only when the store plainly refused the write (a
    // 4xx other than 408); otherwise the record may hold it, and a slot
    // whose record never appears is taken over after its lease.
    context?.error?.(`visitor-session: a start could not be recorded (${errorKind(error)})`);
    await recordRefund(store, provisioning, start.nowMs, (line) => context?.error?.(line));
    if (plainRefusal(Number(error?.code ?? error?.statusCode))) await letSlotGo();
    return null;
  }
}

/** A start that failed after its record was written: noted for the sweep, and answered 502. */
async function startFailed(start, held, step, error, { user, workspaceId, noWorkspace, noUser } = {}) {
  const { context } = start;
  // The step and the kind only: never Coder's text (#1403, item 9).
  context?.error?.(`visitor-session: a start failed at ${step} (${errorKind(error)})`);
  await noteUnfinishedStart(start.store, held, {
    user,
    workspaceId,
    noWorkspace,
    noUser,
    nowMs: start.clock(),
    context,
    saveOver: start.saveOver,
  });
  return doorRefusal(DOOR_CODES.coder_unavailable, 502);
}

/** Provision the ephemeral Coder user and workspace, then save the session as active. */
async function provisionLab(start, { held, creds, slot, quota }) {
  const { store, fetchImpl, config, labId, sessionId } = start;
  const workspaceName = VALID_LAB_WORKSPACES[labId];
  let user;
  try {
    user = await createVisitorCoderUser(fetchImpl, config, creds);
  } catch (error) {
    // The workspace is asked for only once the user exists, so there is
    // none. A plain refusal (a 4xx answer) made no user either, so the
    // name is never looked up: it may be someone else's (finding F).
    // No answer, a 5xx, or a 408 (Coder timed the request out, and may
    // have made the user anyway; round 2) may have made one, so it is
    // looked up.
    return startFailed(start, held, 'the Coder user', error, {
      noWorkspace: true,
      noUser: plainRefusal(error?.statusCode),
    });
  }
  let workspaceInfo;
  try {
    workspaceInfo = await createVisitorWorkspace(fetchImpl, config, {
      userId: user.id,
      username: user.username,
      workspaceName,
      labId,
    });
  } catch (error) {
    return startFailed(start, held, 'the workspace', error, { user });
  }

  const expiresAtIso = new Date(start.nowMs + VISITOR_SESSION_DURATION_MS).toISOString();
  const doc = activeRecord(start, { held, user, workspaceInfo, slot, quota, expiresAtIso });
  try {
    await start.saveOver(store, doc);
  } catch (error) {
    // Both Coder calls worked and the session could not be saved: the
    // visitor is told nothing ran, and the note gives the sweep both ids
    // (#1403, item 2). A 412 means the sweep has already taken the record
    // (the lease ran out), and the note is refused the same way; either
    // way the sweep has what it needs.
    return startFailed(start, held, 'saving the session', error, { user, workspaceId: workspaceInfo.workspace?.id });
  }
  await countLabStart(start);
  return jsonResponse({
    ok: true,
    sessionId,
    labId,
    accessUrl: workspaceInfo.accessUrl,
    expiresAt: expiresAtIso,
  }, 201);
}

function activeRecord(start, { held, user, workspaceInfo, slot, quota, expiresAtIso }) {
  const { sessionId, clientHash, labId, nowIso } = start;
  return {
    id: sessionId,
    type: VISITOR_JOB_TYPE,
    status: SESSION_STATUS.active,
    clientHash,
    labId,
    coderUserId: user.id,
    coderUsername: user.username,
    workspaceId: workspaceInfo.workspace.id,
    workspaceName: VALID_LAB_WORKSPACES[labId],
    accessUrl: workspaceInfo.accessUrl,
    slot,
    dailyCap: quota,
    dailyCapRefund: DAILY_CAP_REFUND.spent,
    createdAt: nowIso,
    expiresAt: expiresAtIso,
    ttl: VISITOR_DOC_TTL_SECONDS,
    ...(held?._etag ? { _etag: held._etag } : {}),
  };
}

/**
 * The start is real from here: count it, once, as plain per-lab-per-day
 * numbers (lab-starts.js). The day is read from a fresh clock reading,
 * not from `nowMs`: Turnstile and the Coder calls took time, and a
 * start that finished after UTC midnight belongs to the new day. The
 * session's own timestamps stay as they were. A counter fault is logged
 * by code only and never reaches the visitor, whose session already
 * exists.
 */
async function countLabStart(start) {
  const { context } = start;
  try {
    const counted = await recordLabStart(start.store, { labId: start.labId, nowMs: start.clock() });
    if (!counted.counted) {
      context?.error?.(`visitor-session: lab start not counted (${counted.reason})`);
    }
  } catch (err) {
    context?.error?.(`visitor-session: lab start not counted (${safeLogCode(err)})`);
  }
}
