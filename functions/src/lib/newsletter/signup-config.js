/**
 * signup-config.js — GET /api/public/newsletter/signup-config (#557): where
 * the public newsletter signup box appears and what it says.
 *
 * Anonymous, because every visitor's footer asks. Safe, because the answer is
 * a projection of exactly three fields — `{ placement, heading, blurb }` —
 * built by naming them, never by copying the settings document and deleting
 * what should not show. The same document holds the postal address and the
 * reply-to inbox, and neither can reach this response.
 *
 * It never fails the site. A store error, a missing document or a document
 * that does not validate all answer 200 with the defaults, which are exactly
 * the box the site showed before this setting existed, so a settings outage
 * can only ever put the box back, never take it away. Why the defaults were
 * served is written to the log, not to the response.
 *
 * Same posture as the public reads in lib/public-reads.js: no rate limit (the
 * answer is one point read of a small document, and cached), and a short
 * public Cache-Control so an owner's change reaches visitors within minutes.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { presentSetting } from '../platform-settings.js';
import { DEFAULT_NEWSLETTER_SETTINGS, NEWSLETTER_SETTINGS_CONFIG_ID } from './settings.js';
import { errorFacts } from '../http/error-response.js';

/** Five minutes: long enough to absorb a busy page, short enough for an edit to show. */
export const SIGNUP_CONFIG_CACHE_SECONDS = 300;

/** The only three things this route may say, from a normalized settings value. */
export const signupConfigFrom = (settings) => ({
  placement: settings.signupPlacement,
  heading: settings.signupHeading,
  blurb: settings.signupBlurb,
});

export const DEFAULT_SIGNUP_CONFIG = Object.freeze(signupConfigFrom(DEFAULT_NEWSLETTER_SETTINGS));

const answer = (config) => ({
  status: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': `public, max-age=${SIGNUP_CONFIG_CACHE_SECONDS}`,
  },
  body: JSON.stringify(config),
});

/**
 * @param {object} deps
 * @param {{ readDoc: Function }} deps.store
 */
export function createSignupConfigHandler({ store }) {
  /** GET /api/public/newsletter/signup-config */
  return async function getSignupConfig(_request, context) {
    let presented;
    try {
      const doc = await store.readDoc(
        'admin_config',
        NEWSLETTER_SETTINGS_CONFIG_ID,
        ADMIN_CONFIG_PARTITION
      );
      presented = presentSetting('newsletter-settings', doc);
    } catch (error) {
      context?.warn?.(
        `getSignupConfig: settings read failed, serving the default signup box: ${errorFacts(error)}`
      );
      return answer({ ...DEFAULT_SIGNUP_CONFIG });
    }
    if (presented.stored === 'invalid') {
      // The problem names a field, never a stored value, so it is safe to log.
      context?.warn?.(
        `getSignupConfig: stored newsletter settings do not validate, serving the default signup box: ${presented.problem}`
      );
    }
    return answer(signupConfigFrom(presented.value));
  };
}
