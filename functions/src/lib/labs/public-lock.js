/**
 * The lock on the public lab submission: "Validate on the lab" is taken only
 * from the Landing Zone Builder's pane on the site.
 *
 * Owner decision 2026-09-28, recorded as the amendment to ADR 0032 decision
 * 6: "The lab should only be accessible through 'panes' from my site, lock to
 * that." Two proofs, both checked before anything reads the store or moves a
 * counter (the order is public-submit.js's), and neither widens a bound:
 *
 *   1. THE ORIGIN. The request's `Origin` must be exactly one of the site's
 *      own, `PRODUCTION_ORIGINS` in auth/cors.js: the apex and www, both of
 *      which serve the site. Not the Static Web App's preview hostname (a
 *      break-glass path, not the pane), not `EXTRA_ALLOWED_ORIGINS`, not
 *      localhost. A missing Origin is refused too. That is the reverse of
 *      cors.js, which lets a missing Origin through because CORS is not an
 *      authorization control; here the Origin IS the claim being checked.
 *      On its own it stops only browsers on other sites: curl can send any
 *      header. Hence the second proof.
 *
 *   2. A CLOUDFLARE TURNSTILE TOKEN. The widget on the builder's pane issues
 *      a token for the action `lab-validate`, and the body carries it as
 *      `turnstileToken`. This module sends it to Cloudflare's siteverify with
 *      the secret key and the caller's address, and accepts only
 *      `success: true` for one of the site's hostnames and exactly that
 *      action. Tokens are single use and live five minutes, so a replayed
 *      one fails at siteverify (`timeout-or-duplicate`) and a token minted
 *      for another action or on another site is refused here.
 *
 * A FLOOD OF JUNK TOKENS IS DAMPED BEFORE CLOUDFLARE IS ASKED. The per-client
 * quota needs the store, so it sits after the lock; before siteverify, an
 * in-memory limiter per Function App instance (`createCheckLimiter`) allows
 * one client key ten checks in ten minutes and answers the eleventh 429
 * TURNSTILE_RATE_LIMITED, still without a store read.
 *
 * FAIL CLOSED. No secret (unset, or a Key Vault reference the platform did
 * not resolve, which `resolvedSetting` reads as unset) closes the door for
 * everyone, before the body is read: the status read and the POST both say
 * TURNSTILE_NOT_CONFIGURED. Siteverify unreachable, slow past five seconds,
 * answering non-2xx or non-JSON, or refusing the secret itself, is 503
 * TURNSTILE_UNAVAILABLE: never a pass. A token Cloudflare rejects, or one
 * whose hostname or action is not ours, is 403 TURNSTILE_FAILED.
 *
 * WHAT GOES TO CLOUDFLARE, AND WHAT IS LOGGED. Siteverify receives the
 * secret, the token and `remoteip`, the address auth/client-identity.js
 * trusts (`trustedClientIp`: `CF-Connecting-IP`, and only on a request that
 * carried the origin secret; omitted otherwise, since the field is
 * optional). A refusal logs why, with Cloudflare's error codes, the hostname
 * and the action it reported, and never the token, the address or the
 * secret.
 *
 * THE WIDGET IS NOT TERRAFORM'S. The pinned cloudflare provider (5.25) has
 * `cloudflare_turnstile_widget`, and its `secret` is a read-only attribute,
 * so managing the widget would put this secret in HCP Terraform state, which
 * docs/standards/variables-and-secrets.md forbids. The owner creates the
 * widget in the Cloudflare dashboard, the site key reaches the build as the
 * repository variable VITE_TURNSTILE_SITE_KEY (public by construction), and
 * the secret goes into Key Vault as TURNSTILE-SECRET-KEY through the API-keys
 * page. `infra/frontend.tf` records the same reasoning where a reader of the
 * Cloudflare resources would look for it.
 */

import { PRODUCTION_ORIGINS } from '../auth/cors.js';
import { resolvedSetting } from '../auth/client-identity.js';
import { TURNSTILE_TOKEN_MAX_CHARS } from './public-bounds.js';

/** The site's own origins, the only ones the lab takes a job from. */
export const LAB_SITE_ORIGINS = PRODUCTION_ORIGINS;
/** The hostnames a Turnstile token may have been solved on: the same two. */
export const LAB_SITE_HOSTNAMES = Object.freeze(LAB_SITE_ORIGINS.map((origin) => new URL(origin).hostname));

/**
 * The action the builder's widget sets and siteverify must echo back. At most
 * 32 characters of letters, digits, `_` and `-` (Cloudflare's rule). The
 * frontend spells it in frontend/src/lib/turnstile.js, and
 * public-lock.test.js holds the two together.
 */
export const LAB_TURNSTILE_ACTION = 'lab-validate';

/** The app setting holding the secret key: a Key Vault reference to TURNSTILE-SECRET-KEY. */
export const TURNSTILE_SECRET_SETTING = 'TURNSTILE_SECRET_KEY';

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Past this, siteverify is treated as unreachable rather than waited on. */
export const SITEVERIFY_TIMEOUT_MS = 5000;

/**
 * Siteverify calls one client may cause, per Function App instance, in a
 * ten-minute window (security review of this change, 2026-09-28). The
 * per-client quota of two jobs an hour needs the store, so it comes after
 * the lock; without this, a script sending the site's Origin and junk tokens
 * could make one Cloudflare call, and up to five seconds of function time,
 * per request. Held in memory, not in the store, so the lock still reads
 * nothing before it decides. Ten is well above what a person pressing the
 * button needs; per instance, so the fleet-wide ceiling is this times the
 * instance count, which bounds a flood rather than metering a visitor.
 */
export const CHECK_ATTEMPTS_PER_WINDOW = 10;
export const CHECK_WINDOW_MS = 10 * 60 * 1000;
/** Clients tracked at once; past this, expired windows go first, then the oldest. */
export const CHECK_LIMITER_MAX_KEYS = 5000;

/** The lock's refusals, as the codes a response carries. */
export const LOCK_CODES = Object.freeze({
  origin: 'ORIGIN_NOT_ALLOWED',
  required: 'TURNSTILE_REQUIRED',
  attempts: 'TURNSTILE_RATE_LIMITED',
  failed: 'TURNSTILE_FAILED',
  unavailable: 'TURNSTILE_UNAVAILABLE',
});

/**
 * The visitor's sentence for each (owner direction 2026-09-28: public text
 * names no vendor and no setting). The builder maps the code to its own copy
 * of these words; the log line keeps the detail (`verdict.detail`).
 */
export const LOCK_REASONS = Object.freeze({
  [LOCK_CODES.origin]:
    'Validate on the lab works only from the Landing Zone Builder on hybridcloudworks.com.',
  [LOCK_CODES.required]:
    "The browser check didn't finish, so the lab didn't take the job. Reload the page and try again.",
  [LOCK_CODES.attempts]:
    'Too many attempts from this browser in the last few minutes. Try again in about ten minutes.',
  [LOCK_CODES.failed]: "The browser check didn't pass, so the lab didn't take the job. Try again.",
  [LOCK_CODES.unavailable]:
    "The browser check couldn't be completed just now. Try again in a minute.",
});

/**
 * Siteverify error codes that are this estate's fault or Cloudflare's, not
 * the visitor's: the secret is wrong or absent, the request was malformed, or
 * Cloudflare failed. Each is 503, so a misconfiguration never reads as a
 * visitor who failed the check.
 */
const OUR_SIDE = new Set(['missing-input-secret', 'invalid-input-secret', 'bad-request', 'internal-error']);

/** The secret key, or '' when it is unset or an unresolved Key Vault reference. Read per request. */
export function turnstileSecret(env) {
  return resolvedSetting(env?.[TURNSTILE_SECRET_SETTING]);
}

export function turnstileConfigured(env) {
  return turnstileSecret(env) !== '';
}

/** Whether an `Origin` header is exactly one of the site's own. Null and '' are not. */
export function isSiteOrigin(origin) {
  return typeof origin === 'string' && LAB_SITE_ORIGINS.includes(origin);
}

/**
 * The per-instance limit on siteverify calls: `take(key, nowMs)` is true
 * while `key` (the hashed client key) is under `limit` in its current window,
 * and counts the call. A fixed window per key, opened at the key's first
 * call. Memory is bounded: when a new key would pass `maxKeys`, expired
 * windows are dropped first, then the oldest keys.
 */
export function createCheckLimiter({
  limit = CHECK_ATTEMPTS_PER_WINDOW,
  windowMs = CHECK_WINDOW_MS,
  maxKeys = CHECK_LIMITER_MAX_KEYS,
} = {}) {
  const windows = new Map();
  const expired = (window, nowMs) => nowMs - window.start >= windowMs;
  const makeRoom = (nowMs) => {
    for (const [key, window] of windows) if (expired(window, nowMs)) windows.delete(key);
    // Map iterates in insertion order, so what is left goes oldest first.
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) break;
      windows.delete(key);
    }
  };
  return {
    take(key, nowMs) {
      let window = windows.get(key);
      if (!window || expired(window, nowMs)) {
        if (!window && windows.size >= maxKeys) makeRoom(nowMs);
        window = { start: nowMs, count: 0 };
        windows.set(key, window);
      }
      if (window.count >= limit) return false;
      window.count += 1;
      return true;
    },
    size: () => windows.size,
  };
}

const failed = (detail) => ({ ok: false, kind: 'failed', detail });
const unavailable = (detail) => ({ ok: false, kind: 'unavailable', detail });
/** A value from Cloudflare's answer, short and quoted, for a log line. */
const quoted = (value) => JSON.stringify(String(value ?? '').slice(0, 100));

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const errorCodes = (answer) =>
  Array.isArray(answer['error-codes']) ? answer['error-codes'].map(String) : [];
const listedCodes = (answer) => errorCodes(answer).join(', ') || 'none';

export const VISITOR_TURNSTILE_ACTION = 'visitor-session';

/**
 * What a siteverify answer means for the job: `{ ok: true }`, or
 * `{ ok: false, kind: 'failed' | 'unavailable', detail }` where `detail` is
 * the log line (Cloudflare's codes, hostname and action; nothing the visitor
 * sent). Pure, so each rule is a test.
 *
 * @param {unknown} answer the parsed JSON siteverify returned
 * @param {string} [expectedAction] action to expect, defaults to LAB_TURNSTILE_ACTION
 */
export function judgeSiteverify(answer, expectedAction = LAB_TURNSTILE_ACTION) {
  const rules = [
    (ans) =>
      isObject(ans) ? null : unavailable('siteverify answered with something other than a JSON object'),
    (ans) =>
      errorCodes(ans).some((code) => OUR_SIDE.has(code))
        ? unavailable(`siteverify refused the request itself (error codes: ${listedCodes(ans)})`)
        : null,
    (ans) =>
      ans.success === true ? null : failed(`siteverify said no (error codes: ${listedCodes(ans)})`),
    (ans) =>
      LAB_SITE_HOSTNAMES.includes(ans.hostname)
        ? null
        : failed(`the token was solved on ${quoted(ans.hostname)}, not on the site`),
    (ans) =>
      ans.action === expectedAction
        ? null
        : failed(`the token is for the action ${quoted(ans.action)}, not ${expectedAction}`),
  ];
  for (const rule of rules) {
    const verdict = rule(answer);
    if (verdict) return verdict;
  }
  return { ok: true };
}

/**
 * Check a token with Cloudflare: one POST to siteverify, never retried (a
 * token is single use, so a retry of a request that reached Cloudflare would
 * fail as a duplicate anyway).
 *
 * @param {object} args
 * @param {typeof fetch} args.fetch
 * @param {string} args.secret  from turnstileSecret(); the caller has checked it is set
 * @param {string} args.token
 * @param {string|null} [args.remoteIp]  identity.trustedClientIp(); omitted when null
 * @param {number} [args.timeoutMs]
 * @param {string} [args.action]
 * @returns {Promise<{ ok: true } | { ok: false, kind: 'failed'|'unavailable', detail: string }>}
 */
export async function verifyTurnstileToken({
  fetch,
  secret,
  token,
  remoteIp = null,
  timeoutMs = SITEVERIFY_TIMEOUT_MS,
  action = LAB_TURNSTILE_ACTION,
}) {
  if (token.length > TURNSTILE_TOKEN_MAX_CHARS) {
    return failed(`the token is ${token.length} characters, longer than Turnstile issues`);
  }
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set('remoteip', remoteIp);
  let response;
  try {
    response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return unavailable(`siteverify was not reached (${error?.name ?? 'error'})`);
  }
  if (!response?.ok) {
    return unavailable(`siteverify answered HTTP ${response?.status ?? '(no response)'}`);
  }
  let answer;
  try {
    answer = await response.json();
  } catch {
    return unavailable('siteverify answered with something other than JSON');
  }
  return judgeSiteverify(answer, action);
}
