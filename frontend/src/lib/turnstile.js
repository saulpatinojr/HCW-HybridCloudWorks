/**
 * Cloudflare Turnstile, for exactly one control: the Landing Zone Builder's
 * "Validate on the lab" (ADR 0032 decision 6, revised 2026-09-28). The lab
 * takes a public job only from the builder's pane on the site, and the token
 * this widget issues is half of how the server knows it came from there; the
 * request's Origin is the other half (functions/src/lib/labs/public-lock.js).
 *
 * LOADED ON DEMAND, NOWHERE ELSE. Nothing imports Cloudflare's script at
 * build time and no page but the builder calls `loadTurnstile`, which the
 * builder does only once the server says the lab is open. So every other page
 * makes no request to challenges.cloudflare.com, and the CSP grants that
 * origin `script-src` and `frame-src` and nothing more
 * (staticwebapp.config.json, held by csp.test.js).
 *
 * THE SITE KEY IS PUBLIC. It is in the bundle by design, a build-time
 * variable read from the repository variable VITE_TURNSTILE_SITE_KEY
 * (deploy-azure-frontend.yml). The secret half is the server's, in Key Vault.
 * An empty key means this build cannot run the check, and the button says so.
 * Cloudflare publishes test site keys for local work
 * (developers.cloudflare.com/turnstile/troubleshooting/testing/); the server
 * still accepts a token only for the site's own hostnames.
 */

/** Explicit rendering: the builder decides when and where the widget appears. */
export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * The action this widget's tokens carry, which the server requires siteverify
 * to echo back (functions/src/lib/labs/public-lock.js LAB_TURNSTILE_ACTION;
 * public-lock.test.js reads this line). At most 32 letters, digits, _ and -.
 */
export const LAB_TURNSTILE_ACTION = 'lab-validate';
export const VISITOR_TURNSTILE_ACTION = 'visitor-session';

/** The build's site key, trimmed; '' when the build had none. */
export function turnstileSiteKey(env = import.meta.env) {
  return String(env?.VITE_TURNSTILE_SITE_KEY ?? '').trim();
}

let pending = null;

/**
 * Cloudflare's `turnstile` API, loading its script once per page. A failed
 * load is not cached, so a later mount can try again.
 *
 * Not given `integrity`: Cloudflare serves api.js unversioned and changes it,
 * and documents that it must be loaded from this URL, not proxied or cached.
 * The CSP is what bounds it.
 *
 * @param {{ document?: Document, window?: Window }} [scope]
 * @returns {Promise<object>} window.turnstile
 */
export function loadTurnstile({ document = globalThis.document, window = globalThis.window } = {}) {
  if (window?.turnstile) return Promise.resolve(window.turnstile);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.onload = () =>
        window.turnstile
          ? resolve(window.turnstile)
          : reject(new Error('Turnstile loaded without its API'));
      script.onerror = () => reject(new Error('Turnstile could not be loaded'));
      document.head.appendChild(script);
    }).catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

/** For tests: forget a load in flight or done. */
export function resetTurnstileLoader() {
  pending = null;
}
