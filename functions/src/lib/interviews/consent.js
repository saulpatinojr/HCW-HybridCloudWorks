/**
 * consent.js — the guest's agreement to be published (ADR 0040, D9).
 *
 * The admin form shows one fixed sentence and a checkbox with a date. The
 * sentence lives here, in code, under a version name: if the wording ever
 * changes it gets a new version, so a stored record always says which words
 * the guest agreed to. The record also says who confirmed it, taken from the
 * signed-in administrator's token and never from the form.
 *
 * Nothing here is ever public: the public interview routes list their fields
 * by name (lib/public-reads.js) and `consent` is not on either list.
 */
import { AuthoredError } from '../http/error-response.js';

/** The version name stored on every record that agreed to the sentence below. */
export const CONSENT_WORDING_VERSION = 'v1';

/** The sentence the form shows. A change to it is a new version, never an edit. */
export const CONSENT_WORDING_V1 =
  'The guest has agreed that this interview may be published on hybridcloudworks.com, ' +
  'and knows the recording is kept privately for the site’s records.';

/** The code a refusal carries, on create and at publish. */
export const CONSENT_REQUIRED = 'CONSENT_REQUIRED';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A consent the create or the publish refuses; the message is for the editor. */
export class ConsentError extends AuthoredError {
  /** @param {string} message - the refusal, in plain words */
  constructor(message) {
    super(message);
    this.status = 422;
    this.code = CONSENT_REQUIRED;
  }
}

/** `YYYY-MM-DD` when it names a real calendar day, else null. */
function realDate(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const real = new Date(Date.UTC(year, month - 1, day));
  const ok =
    real.getUTCFullYear() === year &&
    real.getUTCMonth() === month - 1 &&
    real.getUTCDate() === day;
  return ok ? value.trim() : null;
}

/** Today as `YYYY-MM-DD` in UTC, from the clock the caller injects. */
export const todayOf = (now) => now().toISOString().slice(0, 10);

/**
 * The consent block the form sent, checked.
 *
 * @param {unknown} input - `{ confirmed, date }` from the request body
 * @param {{ now: () => Date }} clock
 * @returns {{ confirmed: true, date: string, wording: string }}
 * @throws {ConsentError}
 */
export function validateConsent(input, { now }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConsentError('Tick the consent box and give the date the guest agreed.');
  }
  if (input.confirmed !== true) {
    throw new ConsentError('The guest’s agreement to publish must be confirmed before saving.');
  }
  const date = realDate(input.date);
  if (!date) {
    throw new ConsentError('The consent date must be a real date written YYYY-MM-DD.');
  }
  if (date > todayOf(now)) {
    throw new ConsentError('The consent date cannot be in the future.');
  }
  return { confirmed: true, date, wording: CONSENT_WORDING_VERSION };
}

/**
 * The stored record: the checked consent plus who confirmed it and when.
 * `confirmedBy` comes from the token's claims, not the form.
 *
 * @param {{ confirmed: true, date: string, wording: string }} consent
 * @param {{ oid?: string, sub?: string, email?: string, preferred_username?: string }} user
 * @param {string} nowIso
 */
export function attributeConsent(consent, user = {}, nowIso) {
  return {
    ...consent,
    confirmedBy: {
      oid: user.oid || user.sub || null,
      email: user.email || user.preferred_username || null,
    },
    confirmedAt: nowIso,
  };
}

/**
 * Why a stored interview may not be published on the strength of its consent
 * record, as `{ code, error }`, or null when the record is in order: present,
 * confirmed, carrying a real date that is not in the future, attributed to a
 * signed-in administrator (`confirmedBy.oid`) and agreeing to the wording
 * version this code knows. A record missing the attribution did not come
 * from POST cms/interviews, whatever else it says.
 *
 * @param {object} doc - the content document
 * @param {{ now: () => Date }} clock
 */
export function consentRefusal(doc = {}, { now }) {
  const consent = doc?.consent;
  const refuse = (error) => ({ code: CONSENT_REQUIRED, error });
  if (!consent || typeof consent !== 'object') {
    return refuse('This interview has no consent record; confirm the guest’s agreement first.');
  }
  if (consent.confirmed !== true) {
    return refuse('The guest’s agreement to publish has not been confirmed.');
  }
  const date = realDate(consent.date);
  if (!date) return refuse('The consent record has no valid date.');
  if (date > todayOf(now)) return refuse('The consent date is in the future.');
  if (consent.wording !== CONSENT_WORDING_VERSION) {
    return refuse('The consent record does not name the wording the guest agreed to.');
  }
  const oid = consent.confirmedBy?.oid;
  if (typeof oid !== 'string' || !oid.trim()) {
    return refuse('The consent record was not confirmed by a signed-in administrator.');
  }
  return null;
}
