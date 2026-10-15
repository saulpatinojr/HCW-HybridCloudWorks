/**
 * The ElevenLabs account: which plan the key is on and how many credits it
 * has left, read before a render spends any of them (#432; ADR 0029 §2a,
 * amended 2026-09-26).
 *
 * Written when the owner chose to start the podcast voice on the FREE plan:
 * 10,000 credits a month with full API access
 * (https://join.elevenlabs.io/api/developer-api, https://elevenlabs.io/pricing).
 * One 9,000-character episode is nearly the whole month, and two things
 * follow. This module holds the facts both need.
 *
 *   - **A pre-flight.** `synthesizeWithElevenLabs` reads the subscription
 *     before its first dialogue request and refuses the job outright when the
 *     credits left do not cover all of it. A render that runs dry after three
 *     of five requests has spent most of the month on audio that is thrown
 *     away. Refusing up front spends nothing.
 *   - **The plan the audio was rendered on.** The free plan "does not include
 *     a commercial license and cannot be used for any commercial purpose"
 *     (https://help.elevenlabs.io/hc/en-us/articles/13313564601361). So the
 *     podcast pipeline records the plan on the transcript, and approval refuses
 *     a free-plan render (podcast/speech-licence.js).
 *
 * ## The endpoint
 *
 * `GET https://api.elevenlabs.io/v1/user/subscription` with `xi-api-key`
 * (https://elevenlabs.io/docs/api-reference/user/subscription/get, read
 * 2026-09-26). The fields used here:
 *
 *   tier                              the plan, e.g. "free", "starter"
 *   status                            trialing | active | incomplete |
 *                                     past_due | free | free_disabled
 *   character_count                   credits used this period
 *   character_limit                   credits allowed this period
 *   next_character_count_reset_unix   when the allowance resets
 *   can_extend_character_limit        entitled to usage-based billing
 *   max_credit_limit_extension        an integer or "unlimited"; 0 means
 *                                     usage-based billing is disabled
 *
 * "Character" and "credit" are the same number under two names: "Credits
 * were previously referred to as 'characters' … the value remains
 * unchanged" (https://elevenlabs.io/docs/overview/administration/billing).
 *
 * **Permission.** A restricted key needs **User → Read** (`user_read`, one of
 * the permission names in
 * https://elevenlabs.io/docs/api-reference/service-accounts/api-keys/list) for
 * this read. ElevenLabs's reference does not say which permission each
 * endpoint checks. That this one checks `user_read` comes from clients that
 * call it, not from ElevenLabs (for example
 * https://github.com/steipete/CodexBar/blob/main/docs/elevenlabs.md). A key
 * without it is refused with 401 or 403, and the code names missing or
 * insufficient permissions (https://elevenlabs.io/docs/eleven-api/resources/errors).
 *
 * ## Credits a job needs
 *
 * Eleven v3 bills one credit per character: "1 text character equals 1
 * credit" for Multilingual v2/v3, and Flash/Turbo bill between 0.5 and 1
 * (https://elevenlabs.io/pricing). Text to Dialogue serves only v3
 * (https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue). So one
 * credit per character is exact for the default model and an upper bound for
 * any other, which is the safe direction for a figure that gates spending. A
 * Voice Library voice with a credit multiplier would bill more. A free-plan
 * key cannot use library voices through the API at all
 * (https://elevenlabs.io/docs/overview/capabilities/voices), and the voice
 * picker offers none on that plan (elevenlabs-voice-plan.js). On a paid plan the
 * owner may choose one; if it carries a multiplier this figure under-counts,
 * and the per-request out-of-credit error in elevenlabs.js is the backstop,
 * as it is for two renders racing each other.
 *
 * ## Why a failed read fails CLOSED
 *
 * If the subscription cannot be read, the render is refused with
 * `code: 'subscription_unavailable'` and nothing is sent. That covers a
 * network failure that survived its retries, a key without `user_read`, and
 * an answer without the credit figures. Proceeding blind was the alternative,
 * and it is rejected on purpose:
 *
 *   1. The check exists to protect a 10,000-credit month, and "could not
 *      check" is exactly the case where a half-spent render can happen.
 *   2. The plan is what the publish rule is decided from. Audio rendered
 *      without it would have an unknown licence.
 *   3. The failure is cheap and loud. The podcast saves a transcript-only
 *      draft whose `audioError` names the cause (podcast/generate.js), and the
 *      fix is a permission on the key, not a change to code.
 *
 * ## The cache
 *
 * A successful read is kept for `SUBSCRIPTION_CACHE_TTL_MS` per key. The
 * Audio tab, the live check and a job that start within the same few seconds
 * then read the account once. Every render drops the entry when it finishes,
 * whether or not it spent anything, so the next pre-flight sees what that
 * render cost. Two renders racing each other can both pass a pre-flight,
 * cache or no cache; the per-request out-of-credit error in elevenlabs.js is
 * the backstop there.
 *
 * ## The error vocabulary lives here too
 *
 * `ElevenLabsSpeechError`, `isQuotaExceeded` and `dialogueRefusal` serve
 * both this read and the dialogue requests in elevenlabs.js, which re-exports
 * the public ones. They sit here, not in `./index.js`, because index.js
 * imports elevenlabs.js and a cycle would leave one of them undefined at load.
 *
 * ## Cache keying
 *
 * The cache is keyed by the key string itself, in this process's memory,
 * where `process.env` already holds it. Nothing here writes it anywhere else:
 * not a log, an error message, a response or a document. An earlier draft
 * keyed it by a SHA-256 of the key, which protected nothing the environment
 * does not already expose, and CodeQL rightly read a fast hash of a
 * credential as a weak password hash (js/insufficient-password-hash).
 *
 * ## Whose words an error carries (#945)
 *
 * Every ElevenLabsSpeechError sentence is written here: the status, the
 * ElevenLabs error code, the permission a refusal names and where to set it.
 * ElevenLabs's own sentence and a raw answer body are not copied into one,
 * and neither is a socket error's text (its code is), so an admin route may
 * show the sentence whole (`authoredMessage`).
 */

import { AuthoredError, errorCode as failureCode } from '../../http/error-response.js';

export const SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';

/** The permission a restricted key needs for the read above. */
export const SUBSCRIPTION_PERMISSION = 'user_read';

/** Where keys are created and their permissions and credit limits set. */
export const API_KEYS_PAGE = 'https://elevenlabs.io/app/developers/api-keys';

/** Seconds, not minutes: long enough to share one read, short enough to stay true. */
export const SUBSCRIPTION_CACHE_TTL_MS = 15_000;

/** Eleven v3's rate, and the ceiling for every other model (see the header). */
export const CREDITS_PER_CHARACTER = 1;

/** `code` for a subscription that could not be read. */
export const SUBSCRIPTION_UNAVAILABLE = 'subscription_unavailable';

/**
 * `code` for a job the account cannot pay for. The same code the per-request
 * out-of-credit error carries, so anything that recognises one recognises the
 * other. The pre-flight flavour is told apart by `details.preflight`.
 */
export const QUOTA_EXCEEDED = 'quota_exceeded';

/**
 * `code` for a 402 that is about the plan, not the credit: a free-plan key
 * asking for a Voice Library voice ("Free users cannot use library voices via
 * the API", https://elevenlabs.io/docs/overview/capabilities/voices).
 */
export const PAID_PLAN_REQUIRED = 'paid_plan_required';

/**
 * Where the owner picks the podcast voices (#725). A 402 `paid_plan_required`
 * names it, because the fix for a paid-only voice is choosing another one.
 */
export const VOICE_PICKER_PAGE = 'https://hybridcloudworks.com/admin/platform-settings?tab=audio';

const FREE_TIER = 'free';
const FREE_STATUSES = new Set(['free', 'free_disabled']);
const PERMISSION_CODES = new Set(['missing_permissions', 'insufficient_permissions']);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Whether a refusal is about the key's permissions rather than the key: a
 * named permission code, or a 403 that carries no code at all. Shared with
 * the voice listing in elevenlabs-voices.js, which needs `voices_read`.
 */
export function isPermissionRefusal(status, code) {
  return PERMISSION_CODES.has(code) || (status === 403 && !code);
}

/** Statuses a retry can change: rate limits and server faults. */
export const isRetryableStatus = (status) => RETRYABLE_STATUSES.has(status);
const MAX_ATTEMPTS = 3;
const NOTHING_SENT = 'nothing was sent, so no credits were spent';

const numberFormat = new Intl.NumberFormat('en-US');

/**
 * The error every ElevenLabs failure is reported with.
 *
 * Defined here rather than in `./index.js`, which imports elevenlabs.js: a
 * cycle would make one of the two undefined at load. elevenlabs.js imports it
 * from here. `name`, `provider`, `status` and `code` are what callers key off,
 * and `name` is 'SpeechError' so they need not know which module threw.
 */
export class ElevenLabsSpeechError extends AuthoredError {
  /**
   * @param {string} message - the authored sentence
   * @param {{ status?: number|null, code?: string|null, details?: object|null }} [options]
   */
  constructor(message, { status = null, code = null, details = null } = {}) {
    super(message);
    this.name = 'SpeechError';
    this.status = status;
    this.provider = 'elevenlabs';
    this.code = code;
    if (details) this.details = details;
  }
}

/**
 * The code in an ElevenLabs error body, lowercased, or ''.
 *
 * `detail.code` is the current field; `detail.status` is "a legacy field that
 * is no longer used" but older answers still carry it
 * (https://elevenlabs.io/docs/eleven-api/resources/errors). Read as text
 * first, so a non-JSON error page cannot throw here.
 */
export function errorCode(bodyText) {
  try {
    const detail = JSON.parse(bodyText)?.detail;
    return String(detail?.code || detail?.status || '').toLowerCase();
  } catch {
    return '';
  }
}

/** An ElevenLabs key as it appears in text (`sk_` and its hex or base62 body). */
const KEY_PATTERN = /sk_[A-Za-z0-9]{8,}/g;

/**
 * ElevenLabs's own sentence for a refusal (`detail.message`), on one line,
 * capped at 300 characters, with anything shaped like a key replaced. The
 * sentence is what names the missing permission: on 2026-09-26 the voice
 * listing answered a key without Voices → Read with `401` and code
 * `unauthorized`, which alone read as a rejected key.
 */
export function errorMessage(bodyText) {
  try {
    const message = JSON.parse(bodyText)?.detail?.message;
    if (typeof message !== 'string') return '';
    return message.replace(KEY_PATTERN, '[key]').replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Whether a refusal body is about the key's permissions: a permission code
 * in either `detail.code` or the legacy `detail.status` (an answer can carry
 * `code: unauthorized` beside `status: missing_permissions`), a 403 with no
 * code, or a 401/403 whose own sentence names a permission.
 */
export function isPermissionAnswer(status, bodyText) {
  let detail = null;
  try {
    detail = JSON.parse(bodyText)?.detail ?? null;
  } catch {
    detail = null;
  }
  const codes = [detail?.code, detail?.status].map((value) => String(value || '').toLowerCase());
  if (codes.some((value) => PERMISSION_CODES.has(value))) return true;
  if (isPermissionRefusal(status, errorCode(bodyText))) return true;
  return (status === 401 || status === 403) && /\bpermission/i.test(errorMessage(bodyText));
}

/**
 * Whether a non-2xx response is the out-of-credit state.
 *
 * The documented shapes are 401 + `detail.status: "quota_exceeded"` and 402
 * `insufficient_credits`. The body is JSON but is read as text first so a
 * non-JSON error page cannot throw here. A 402 is out of credit unless its
 * code says it is about the plan (`paid_plan_required`), which is not.
 */
export function isQuotaExceeded(status, bodyText) {
  if (status === 402) return errorCode(bodyText) !== PAID_PLAN_REQUIRED;
  if (status !== 401) return false;
  try {
    const detail = JSON.parse(bodyText)?.detail;
    return String(detail?.status || detail?.code || '').toLowerCase() === QUOTA_EXCEEDED;
  } catch {
    return /quota_exceeded/i.test(String(bodyText || ''));
  }
}

/**
 * What a non-2xx Text to Dialogue answer means, and whether a retry could
 * change it. Out of credit and a paid-only voice or feature are named and
 * never retried, since a retry cannot add credit or change the plan. 429 and
 * 5xx are retried. Anything else is reported as the API said it.
 *
 * @returns {{ error: ElevenLabsSpeechError, retryable: boolean }}
 */
export function dialogueRefusal(status, bodyText) {
  if (isQuotaExceeded(status, bodyText)) {
    return {
      retryable: false,
      error: new ElevenLabsSpeechError(
        `ElevenLabs is out of credit (HTTP ${status} quota_exceeded). Add credit or wait for the plan to renew.`,
        { status, code: QUOTA_EXCEEDED }
      ),
    };
  }
  if (status === 402) {
    // The fix comes first and the raw body last: on the free plan this is
    // almost always a Voice Library voice, and the answer is a different
    // voice, chosen where the voices are listed with what the plan allows.
    return {
      retryable: false,
      error: new ElevenLabsSpeechError(
        `ElevenLabs refused this on the current plan (HTTP 402 ${PAID_PLAN_REQUIRED}): a voice or feature it needs is paid-only. ` +
          `Choose voices your plan allows under Podcast voices at ${VOICE_PICKER_PAGE}.`,
        { status, code: PAID_PLAN_REQUIRED }
      ),
    };
  }
  const code = errorCode(bodyText);
  return {
    retryable: isRetryableStatus(status),
    error: new ElevenLabsSpeechError(`ElevenLabs answered HTTP ${status}${code ? ` ${code}` : ''}.`, {
      status,
    }),
  };
}

/** Whether a plan is the free one, from what the subscription says. */
export function isFreePlan({ tier, status } = {}) {
  return (
    String(tier || '').toLowerCase() === FREE_TIER ||
    FREE_STATUSES.has(String(status || '').toLowerCase())
  );
}

const unavailable = (reason, status = null) =>
  new ElevenLabsSpeechError(`Could not read the ElevenLabs subscription (${reason}); ${NOTHING_SENT}.`, {
    status,
    code: SUBSCRIPTION_UNAVAILABLE,
  });

/** The sentence for a non-2xx subscription answer. */
function refusalFor(status, text) {
  const code = errorCode(text);
  const label = `HTTP ${status}${code ? ` ${code}` : ''}`;
  if (isPermissionAnswer(status, text)) {
    return unavailable(
      `${label}: the key needs the User → Read permission (${SUBSCRIPTION_PERMISSION}), set at ${API_KEYS_PAGE}`,
      status
    );
  }
  if (status === 401) return unavailable(`${label}: ElevenLabs rejected the key`, status);
  return unavailable(label, status);
}

/**
 * The subscription answer, retried on 429, 5xx and no answer; throws an
 * ElevenLabsSpeechError whose sentence carries no ElevenLabs text (#945).
 *
 * @param {{ key: string, fetchImpl: Function, sleep: Function }} args
 * @returns {Promise<object>}
 */
async function fetchSubscription({ key, fetchImpl, sleep }) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(SUBSCRIPTION_URL, {
        method: 'GET',
        headers: { 'xi-api-key': key, Accept: 'application/json' },
      });
    } catch (err) {
      lastError = unavailable(`could not reach ElevenLabs (${failureCode(err?.cause ?? err)})`);
      if (attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(attempt * 500);
      continue;
    }

    const text = await response.text().catch(() => '');
    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw unavailable('the answer was not JSON', response.status);
      }
    }
    lastError = refusalFor(response.status, text);
    if (!isRetryableStatus(response.status) || attempt === MAX_ATTEMPTS) throw lastError;
    await sleep(attempt * 500);
  }

  throw lastError;
}

/**
 * What a render and the Audio tab need from the subscription body.
 *
 * `overageCredits` is how far past the allowance the account may go under
 * usage-based billing: 0 when it is not entitled or the extension is 0, a
 * number, or 'unlimited'. The free plan is never entitled.
 *
 * @param {object} body the JSON ElevenLabs returned
 * @returns {{ tier: string|null, status: string|null, freePlan: boolean,
 *   creditsUsed: number, creditLimit: number, creditsLeft: number,
 *   overageCredits: number|'unlimited', resetAt: string|null }}
 */
export function normalizeSubscription(body) {
  const used = Number(body?.character_count);
  const limit = Number(body?.character_limit);
  if (
    body?.character_count === null ||
    body?.character_limit === null ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit)
  ) {
    throw unavailable('the answer carried no credit figures');
  }

  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const tier = text(body.tier);
  const status = text(body.status);

  const resetUnix = Number(body.next_character_count_reset_unix);
  const resetAt =
    body.next_character_count_reset_unix !== null && Number.isFinite(resetUnix) && resetUnix > 0
      ? new Date(resetUnix * 1000).toISOString()
      : null;

  // `max_character_limit_extension` is the deprecated spelling of the same
  // figure; read it only when the current one is absent.
  const extension = body.max_credit_limit_extension ?? body.max_character_limit_extension ?? 0;
  let overageCredits = 0;
  if (body.can_extend_character_limit === true) {
    overageCredits = extension === 'unlimited' ? 'unlimited' : Math.max(0, Number(extension) || 0);
  }

  return {
    tier,
    status,
    freePlan: isFreePlan({ tier, status }),
    creditsUsed: used,
    creditLimit: limit,
    creditsLeft: Math.max(0, limit - used),
    overageCredits,
    resetAt,
  };
}

/** key → { value, expiresAt }. One entry per key; a process holds one key. */
const cache = new Map();

/**
 * The account behind `key`, normalised. Throws an `ElevenLabsSpeechError`
 * with `code: 'subscription_unavailable'` when it cannot be read.
 *
 * 429 and 5xx are retried, as the dialogue requests are; a refused key or a
 * missing permission is not, because a retry cannot change it.
 *
 * @param {object} params
 * @param {string} params.key the ElevenLabs API key
 * @param {Function} [params.fetchImpl]
 * @param {(ms: number) => Promise<void>} [params.sleep]
 * @param {() => number} [params.now] epoch milliseconds, for the cache
 * @param {boolean} [params.useCache] false forces a fresh read
 */
export async function readSubscription({
  key,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  useCache = true,
} = {}) {
  if (!key) throw unavailable('ELEVENLABS_API_KEY is not configured');

  if (useCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.value;
  }

  const value = normalizeSubscription(await fetchSubscription({ key, fetchImpl, sleep }));
  cache.set(key, { value, expiresAt: now() + SUBSCRIPTION_CACHE_TTL_MS });
  return value;
}

/** Drop the cached read for one key, so the next read sees what a render spent. */
export function invalidateSubscription(key) {
  if (key) cache.delete(key);
}

/** Drop every cached read. For tests, which must not see each other's accounts. */
export function clearSubscriptionCache() {
  cache.clear();
}

/** Credits a job of `characters` code points will be charged, rounded up. */
export function creditsNeeded(characters) {
  return Math.ceil(Math.max(0, Number(characters) || 0) * CREDITS_PER_CHARACTER);
}

/**
 * Null when the account can pay for `needed` credits, else what it is short.
 *
 * Usage-based billing counts as headroom, but only when the account is
 * entitled to it AND an admin has set an extension above 0. That is an opt-in
 * made in ElevenLabs's own settings. The free plan has neither, so on it this
 * compares the allowance left with the job.
 *
 * @param {ReturnType<typeof normalizeSubscription>} subscription
 * @param {number} needed credits
 */
export function creditShortfall(subscription, needed) {
  const overage =
    subscription.overageCredits === 'unlimited'
      ? Number.POSITIVE_INFINITY
      : Number(subscription.overageCredits) || 0;
  const available = subscription.creditLimit - subscription.creditsUsed + overage;
  if (needed <= available) return null;
  return {
    needed,
    left: subscription.creditsLeft,
    limit: subscription.creditLimit,
    overage,
    resetAt: subscription.resetAt,
    tier: subscription.tier,
  };
}

/**
 * "ElevenLabs has 1,000 credits left of 10,000, this episode needs 9,000; the
 * allowance resets on 2026-10-26 (UTC). Nothing was sent, …"
 */
export function describeShortfall({ needed, left, limit, overage, resetAt }) {
  const extra = overage > 0 ? ` (plus ${numberFormat.format(overage)} of usage-based billing)` : '';
  const reset = resetAt
    ? `the allowance resets on ${resetAt.slice(0, 10)} (UTC)`
    : 'ElevenLabs did not say when the allowance resets';
  return (
    `ElevenLabs has ${numberFormat.format(left)} credits left of ${numberFormat.format(limit)}${extra}, ` +
    `this episode needs ${numberFormat.format(needed)}; ${reset}. ` +
    `Nothing was sent, so no credits were spent.`
  );
}

/**
 * The pre-flight, in one call: read the account and refuse a job it cannot
 * pay for in full. Returns the subscription the job was cleared against.
 *
 * @param {object} params
 * @param {string} params.key
 * @param {number} params.characters code points the job will post
 * @param {Function} [params.fetchImpl]
 * @param {(ms: number) => Promise<void>} [params.sleep]
 * @returns {Promise<ReturnType<typeof normalizeSubscription>>}
 */
export async function assertCreditsCover({ key, characters, fetchImpl, sleep }) {
  const subscription = await readSubscription({ key, fetchImpl, sleep });
  const needed = creditsNeeded(characters);
  const shortfall = creditShortfall(subscription, needed);
  if (shortfall) {
    throw new ElevenLabsSpeechError(describeShortfall(shortfall), {
      status: null,
      code: QUOTA_EXCEEDED,
      details: { preflight: true, ...shortfall },
    });
  }
  return subscription;
}
