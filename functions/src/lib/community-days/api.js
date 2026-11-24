/**
 * community-days/api.js — the Community Days API's address, the two paths
 * this site reads, and the sentences for its refusals (#1823, ADR 0045).
 *
 * THIS IS THE ONLY SOURCE FILE THAT NAMES THE API'S HOST, and it has no
 * imports and sends nothing: it is constants and one function that turns an
 * HTTP status into a sentence. The client (client.js) makes the calls, and
 * the Integrations Test button (integrations/connection-probe.js) reads its
 * one URL from here. only-read-calls.test.js holds all three to "two GET
 * calls and nothing else", which matters because the key is not read-only at
 * the vendor.
 *
 * It is kept apart from the client so that a module which only needs a name
 * or a sentence does not load the client's network code with it.
 */

/** The app setting the key arrives in (a Key Vault reference, infra/functionapp.tf). */
export const API_KEY_SETTING = 'COMMUNITY_DAYS_API_KEY';

export const API_BASE = 'https://api.communitydays.org/v1';

/** The only paths this site may call, each with GET. */
export const EVENTS_PATH = '/published-events';
export const TALKS_PATH = '/profile/talks';
export const ALLOWED_PATHS = Object.freeze([EVENTS_PATH, TALKS_PATH]);

/** The Test button's call (integrations/connection-probe.js): one public event, the cheapest read that needs the key. */
export const PROBE_URL = `${API_BASE}${EVENTS_PATH}?per_page=1`;

/**
 * The sentence for one HTTP status, written for the owner. Shared with the
 * Test button so the page and the card say the same thing.
 *
 * @param {number|undefined} status - the API's HTTP status, or undefined when there was no answer
 * @returns {string}
 */
export function sentenceForStatus(status) {
  if (status === 401) {
    return 'Community Days did not accept the key: it is missing, wrong, deleted or expired. Paste a current key on Integrations → Keys';
  }
  if (status === 403) {
    return 'Community Days answered that API access is not approved for this account yet, or the account is blocked. Nothing is wrong with this site; the approval is given on the Community Days developers page';
  }
  if (status === 429) {
    return 'Community Days is limiting how often this site may ask. Wait a while and try again';
  }
  if (Number.isInteger(status) && status >= 500) return 'The Community Days service failed on its side';
  if (Number.isInteger(status)) return 'Community Days refused the request';
  return 'Community Days could not be reached';
}

