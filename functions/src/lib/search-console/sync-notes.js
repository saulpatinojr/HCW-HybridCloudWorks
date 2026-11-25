/**
 * sync-notes.js — the sentences one Search Console run (sync.js) stores about
 * a failure, and the checks that sort a failure into "stop the run", "quota"
 * or "not sent". Built from the failure's kind and HTTP status only, never
 * from Google's own words.
 */
import { GoogleAuthError } from './google-auth.js';
import { SearchConsoleError } from './client.js';
import { NOT_INSPECTED_BUDGET } from './sync-constants.js';

const AUTH_HOPS = { entra: 'hop 1 (Entra token)', sts: 'hop 2 (Google token exchange)', impersonation: 'hop 3 (service account token)' };

function describeAuth(kind, status) {
  const hop = AUTH_HOPS[kind] ?? 'an unknown hop';
  return `Google sign-in failed at ${hop}${status === null ? '' : ` with HTTP ${status}`}. The runbook's setup steps say what each hop needs.`;
}

/** Sentences chosen by the failure's reason, before its status is looked at. */
const BY_REASON = new Map([
  ['unreadable', (kind) => `Search Console ${kind} sent an answer that is not what Google documents, so it was not used.`],
  ['not_sent', () => NOT_INSPECTED_BUDGET],
]);

/** Sentences chosen by the failure's HTTP status. */
const BY_STATUS = new Map([
  [403, () => 'Google answered 403: the service account is not a Full user on the Search Console property.'],
  [
    404,
    () =>
      "Google answered 404: it has no Search Console property at the address in the GSC_SITE_URL setting, or the service account cannot see it. Check the setting against the property's name in Search Console.",
  ],
  [429, (kind) => `Search Console ${kind} hit Google's quota (HTTP 429).`],
  [null, (kind) => `Search Console ${kind} could not be reached.`],
]);

function describeCall(kind, status, reason) {
  const sentence = BY_REASON.get(reason) ?? BY_STATUS.get(status);
  return sentence ? sentence(kind) : `Search Console ${kind} failed with HTTP ${status}.`;
}

/**
 * A sentence about a failure for the page, built from the failure's kind and
 * HTTP status only. An AuthoredError from client.js or google-auth.js
 * already has a sentence of this file's family; anything else gets a fixed one.
 */
export function failureNote(failure, fallback) {
  if (failure instanceof GoogleAuthError || failure instanceof SearchConsoleError) {
    const status = Number.isInteger(failure.status) ? failure.status : null;
    if (failure instanceof GoogleAuthError) return describeAuth(failure.kind, status);
    return describeCall(failure.kind, status, failure.reason ?? null);
  }
  return fallback;
}

/**
 * Is this failure one that every later call would hit too? Then the run
 * stops. 401 and 403: Google will not let the service account read the
 * property. 404: Google has no property at GSC_SITE_URL, or the service
 * account cannot see it, so every call would get the same answer.
 */
export function isFatal(failure) {
  if (failure instanceof GoogleAuthError) return true;
  return failure instanceof SearchConsoleError && [401, 403, 404].includes(failure.status);
}

/** A request client.js held back because the day's inspections are used up. */
export const isNotSent = (failure) => failure instanceof SearchConsoleError && failure.reason === 'not_sent';

/** Google's quota answer (HTTP 429), still there after client.js's retries. */
export const isQuota = (failure) => failure instanceof SearchConsoleError && failure.status === 429;
