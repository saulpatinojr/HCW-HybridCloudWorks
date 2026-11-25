/**
 * labs/coder-token-state.js — Coder's answers to the status token, kept for
 * the health pulse (#1009), and the token's own expiry for the Integrations
 * card (#763). coder-status.js has the header that explains both and
 * re-exports what callers use. Never carries the token.
 */
import {
  SCOPE_REFUSAL_STATUSES,
  TOKEN_OPERATIONS,
  TOKEN_REFUSED_401_LOG,
  TOKEN_RENEW_WARNING_DAYS,
  TOKEN_SCOPE_FOR_EXPIRY,
  TOKEN_STATE_DOC_ID,
  TOKEN_STATE_DOC_TYPE,
  TOKEN_STATE_REFRESH_MS,
  coderGet,
  tokenKeyId,
} from './coder-api.js';

const isPast = (iso, nowMs, ageMs) => {
  const ms = Date.parse(String(iso ?? ''));
  return !Number.isFinite(ms) || nowMs - ms >= ageMs;
};

/**
 * Whether one operation's answers say Coder is refusing the token now: a
 * refusal newer than that same operation's last acceptance.
 */
export function isRefusing(entry) {
  const refused = Date.parse(String(entry?.lastRefusedAt ?? ''));
  if (!Number.isFinite(refused)) return false;
  const accepted = Date.parse(String(entry?.lastAcceptedAt ?? ''));
  return !Number.isFinite(accepted) || refused > accepted;
}

/** One operation's answers after this one: `refusedStatus` null for an acceptance, or Coder's 401 or 403. */
function nextEntry(current, refusedStatus, atIso) {
  const base = {
    lastAcceptedAt: current?.lastAcceptedAt ?? null,
    lastRefusedAt: current?.lastRefusedAt ?? null,
    lastRefusedStatus: current?.lastRefusedStatus ?? null,
    refusingSince: null,
  };
  if (refusedStatus === null) return { ...base, lastAcceptedAt: atIso };
  return {
    ...base,
    lastRefusedAt: atIso,
    lastRefusedStatus: refusedStatus,
    // One outage keeps its start however often it is seen again.
    refusingSince: isRefusing(current) ? (current.refusingSince ?? current.lastRefusedAt) : atIso,
  };
}

/**
 * The record after this answer, for this operation only: the other
 * operation's answers are kept exactly as read. Pure.
 */
export function nextTokenState(current, operation, refusedStatus, atIso) {
  const operations = { ...(current?.operations ?? {}) };
  operations[operation] = nextEntry(operations[operation], refusedStatus, atIso);
  return {
    id: TOKEN_STATE_DOC_ID,
    configScope: 'admin_config',
    docType: TOKEN_STATE_DOC_TYPE,
    operations,
  };
}

/** Whether this answer is news for its operation: a change of verdict or status, or the same answer gone an hour unwritten. */
function worthWriting(entry, refusedStatus, nowMs) {
  if (!entry) return true;
  if (refusedStatus === null) {
    return isRefusing(entry) || isPast(entry.lastAcceptedAt, nowMs, TOKEN_STATE_REFRESH_MS);
  }
  if (!isRefusing(entry) || entry.lastRefusedStatus !== refusedStatus) return true;
  return isPast(entry.lastRefusedAt, nowMs, TOKEN_STATE_REFRESH_MS);
}

/** Read, merge, write attempts before an answer is given up (the probe-results and credential-register pattern). */
export const TOKEN_STATE_WRITE_ATTEMPTS = 4;

/** The time of an operation's newest stored answer, epoch ms, or NaN when it has none. */
function newestAnswerMs(entry) {
  const answers = [entry?.lastAcceptedAt, entry?.lastRefusedAt]
    .map((iso) => Date.parse(String(iso ?? '')))
    .filter(Number.isFinite);
  return answers.length ? Math.max(...answers) : Number.NaN;
}

/**
 * Whether a stored entry already holds this exact answer, observed at or
 * after this one: the same verdict and, for a refusal, the same status. Only
 * then may a competing write stand in for this one.
 */
function alreadyHolds(entry, refusedStatus, nowMs) {
  if (refusedStatus === null) {
    return !isRefusing(entry) && Date.parse(String(entry?.lastAcceptedAt ?? '')) >= nowMs;
  }
  return (
    isRefusing(entry) &&
    entry.lastRefusedStatus === refusedStatus &&
    Date.parse(String(entry?.lastRefusedAt ?? '')) >= nowMs
  );
}

/**
 * Record Coder's answer to the status token for one operation (`status` or
 * `expiry`, TOKEN_OPERATIONS): `refusedStatus` null when it accepted it, 401
 * or 403 when it refused. Best effort and never throws: the read it rides on
 * must answer whatever happens here. A store without the conditional writes
 * (a read-only test double) records nothing. Resolves true when it wrote.
 *
 * Read, merge, write under the ETag (`replaceDocIfMatch`, or `createDoc` for
 * the first answer), and on a 412 or 409 read and merge again, up to
 * TOKEN_STATE_WRITE_ATTEMPTS times. Both operations share the one document,
 * so the write that got in first may be the other operation's, which knows
 * nothing of this answer; it is merged onto, never taken as having recorded
 * it (CodeRabbit, #1056). It stands in for this answer only when it holds
 * the same answer for the same operation, observed no earlier. Observation
 * order is kept: an answer older than the newest one already stored for its
 * operation is not written over it.
 */
export async function recordTokenAnswer({
  store,
  operation,
  refusedStatus,
  now = () => Date.now(),
  context,
  attempts = TOKEN_STATE_WRITE_ATTEMPTS,
}) {
  if (!TOKEN_OPERATIONS.includes(operation)) return false;
  if (!store?.readDoc || !store?.createDoc || !store?.replaceDocIfMatch) return false;
  const nowMs = now();
  const atIso = new Date(nowMs).toISOString();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const current = await store.readDoc('admin_config', TOKEN_STATE_DOC_ID, 'admin_config');
      const entry = current?.operations?.[operation];
      if (attempt > 0 && alreadyHolds(entry, refusedStatus, nowMs)) return false;
      if (newestAnswerMs(entry) > nowMs) return false;
      if (!worthWriting(entry, refusedStatus, nowMs)) return false;
      const next = nextTokenState(current, operation, refusedStatus, atIso);
      if (current) {
        await store.replaceDocIfMatch('admin_config', { ...next, _etag: current._etag }, { partitionKey: 'admin_config' });
      } else {
        await store.createDoc('admin_config', next);
      }
      return true;
    } catch (error) {
      // 412: replaced since our read. 409: created since our read found
      // nothing. Either way, read again and merge again.
      if (error?.code === 412 || error?.code === 409) continue;
      context?.warn?.(`coder-status: Coder's answer to the status token could not be recorded (${error?.code ?? 'error'})`);
      return false;
    }
  }
  context?.warn?.("coder-status: Coder's answer to the status token could not be recorded (conflict)");
  return false;
}

/**
 * When CODER_STATUS_TOKEN expires, from Coder itself (#763). The token's
 * one-year lifetime is set at creation and nothing renews it; until this,
 * the only reminder was a calendar. Reads the token's own record; answers
 * `{ known: true, expiresAt, daysLeft, renewSoon, tokenName, scopes }`, or
 * `{ known: false, reason }` with `reason` one of `unset`, `shape` (not a
 * Coder key, or a record without a date), `scope` (403 or 404: the token
 * lacks TOKEN_SCOPE_FOR_EXPIRY), `refused` (401: expired or revoked) or
 * `error`. Never throws, never carries the token.
 */
export async function readTokenExpiry({ fetchImpl, config, context, now = () => Date.now() }) {
  const keyId = tokenKeyId(config?.token);
  if (!config?.token || !keyId) return unknownExpiry(config?.token ? 'shape' : 'unset');
  let key;
  try {
    key = await coderGet(
      fetchImpl,
      config,
      `/api/v2/users/me/keys/${encodeURIComponent(keyId)}`,
      config.token
    );
  } catch (error) {
    return unknownExpiry(reasonForRefusal(error, context));
  }
  return expiryFromRecord(key, now());
}

/** `{ known: false, reason }`, naming the scope to add when that is the reason. */
function unknownExpiry(reason) {
  return reason === 'scope'
    ? { known: false, reason, scope: TOKEN_SCOPE_FOR_EXPIRY }
    : { known: false, reason };
}

/**
 * Why Coder would not give the record: the scope (403, or 404 from v2.38;
 * see TOKEN_SCOPE_FOR_EXPIRY), the token (401), or something else — logged
 * as a status only, never the message, which carries the request path and
 * with it the key id.
 */
function reasonForRefusal(error, context) {
  if (SCOPE_REFUSAL_STATUSES.includes(error?.status)) {
    context?.warn?.(
      `coder-status: Coder would not show CODER_STATUS_TOKEN its own record (${error.status}), which is how it refuses a token without the ${TOKEN_SCOPE_FOR_EXPIRY} scope; re-issue the token with ${TOKEN_SCOPE_FOR_EXPIRY} added (lab-host/README.md, "The status token for the site") and the expiry becomes readable`
    );
    return 'scope';
  }
  if (error?.status === 401) {
    context?.warn?.(`${TOKEN_REFUSED_401_LOG}: it has expired or been revoked; its expiry cannot be read`);
    return 'refused';
  }
  const status = Number.isInteger(error?.status) ? `Coder answered ${error.status}` : 'no answer';
  context?.warn?.(`coder-status: the token's own record could not be read (${status})`);
  return 'error';
}

/** The record's expiry as the card's answer, or `shape` when it carries no usable date. */
function expiryFromRecord(key, nowMs) {
  const ms = Date.parse(typeof key?.expires_at === 'string' ? key.expires_at : '');
  if (!Number.isFinite(ms)) return unknownExpiry('shape');
  const daysLeft = Math.floor((ms - nowMs) / 86_400_000);
  return {
    known: true,
    expiresAt: new Date(ms).toISOString(),
    daysLeft,
    renewSoon: daysLeft <= TOKEN_RENEW_WARNING_DAYS,
    tokenName: typeof key.token_name === 'string' ? key.token_name : null,
    scopes: Array.isArray(key.scopes) ? key.scopes.filter((s) => typeof s === 'string') : [],
  };
}
