/**
 * Where Entra sends the browser back to after a sign-in (#520).
 *
 * ===========================================================================
 * WHY THIS PAGE EXISTS AT ALL
 * ===========================================================================
 * `msalConfig.js` used to set `redirectUri: window.location.origin`, so Entra
 * returned the user to `/` — the PUBLIC home page. Nothing there had ever
 * touched MSAL, because `AdminAuthGuard` is lazy-loaded and mounted only under
 * `/admin`. So the authorization code sat in the fragment and nothing consumed
 * it.
 *
 * The fix at the time was `useAuthRedirectLanding`, a hook mounted from
 * `App.jsx` on EVERY route — including every anonymous visit to a provider news
 * page — whose whole job was to run a regex against `window.location.hash` and,
 * on the rare occasion it matched, dynamically import MSAL and finish the job.
 *
 * A dedicated redirect route is what Microsoft recommends and what removes the
 * need for any of that: the fragment lands here, on a page whose only purpose
 * is to consume it, and the public site goes back to knowing nothing about
 * authentication.
 *
 * ===========================================================================
 * WHY IT NEEDS ALMOST NO CODE
 * ===========================================================================
 * `initializeAuth()` calls `handleRedirectPromise()`, which consumes the
 * fragment and completes the token exchange. MSAL's `navigateToLoginRequestUrl`
 * defaults to `true`, so it then returns the browser to whichever page started
 * the sign-in — which is the mechanism `redirectUri: origin` was working
 * around rather than using.
 *
 * ===========================================================================
 * THE 2026-08-23 INCIDENT, CARRIED OVER SO IT IS NOT LOST
 * ===========================================================================
 * Observed on www.hybridcloudworks.com: sign-in returned to
 * `https://www.hybridcloudworks.com/#code=1.AUYA…&state=…` with
 * `interactionType: "popup"`, rendered the home page, and sat there. MSAL
 * normally has the OPENER poll the popup and read the hash out of it, so the
 * popup page need not run MSAL at all — and that only works while the opener
 * holds a live handle to it. It breaks when the browser opens a top-level
 * window instead of a child popup, which is the same failure that made mobile
 * sign-in hang and is why `signIn()` is redirect-only.
 *
 * A failure here must never be thrown. It is rendered, with a way out, because
 * a stack trace on a blank page is the one thing a signed-out admin cannot act
 * on. `initializeAuth()` already clears a stale fragment for the recoverable
 * cases (see RECOVERABLE_INIT_ERRORS in entraAuth.js); this catches the rest.
 */
import React, { useEffect, useState } from 'react';

import { AUTH_REDIRECT_PATH } from '@/lib/authRoutes';
import { hardReplace } from '@/lib/hardNavigate';

/**
 * What of a failed sign-in goes on screen (AP-F8, #932).
 *
 * The CODE is rendered: MSAL's `errorCode` (`endpoints_resolution_error`,
 * `interaction_in_progress`, an `AADSTS` number inside `errorMessage`), or
 * the part of a plain message before its first colon. Entra error codes are
 * not secrets, and a phone cannot open the console that used to hold the
 * only detail. The MESSAGE stays off the screen, because MSAL's messages
 * name the authority and the client id and this page answers to anyone with
 * the URL; it goes to the console, and to the clipboard on Copy, where the
 * person asking for help can paste it.
 *
 * @param {unknown} err
 * @returns {{ code: string, message: string }}
 */
export function describeAuthFailure(err) {
  const message = String(err?.errorMessage ?? err?.message ?? err ?? '').trim();
  const fromCode = typeof err?.errorCode === 'string' ? err.errorCode.trim() : '';
  const fromMessage = message.split(':')[0].trim();
  const code = (fromCode || fromMessage || 'unknown_error').slice(0, 80);
  return { code, message };
}

/** Finishes the redirect sign-in, or shows the failure's code with a way to copy the detail. */
export default function AuthCallbackPage() {
  const [failure, setFailure] = useState(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    let cancelled = false;

    /**
     * Drop the auth fragment, whatever happened.
     *
     * `initializeAuth()` already does this for the errors it recognises as
     * recoverable. This covers the rest: a fragment left in the address bar is
     * re-processed on every reload, so the same failure reproduces forever and
     * reads as permanent — the behaviour #196 and the 2026-08-23 incident both
     * turned on. It is also an authorization code sitting in history, and in
     * whatever the user pastes when they ask someone what went wrong.
     */
    const clearFragment = () => {
      const hash = window.location.hash || '';
      // Only an auth response, matching `clearAuthFragment()` in entraAuth.js.
      // Stripping any hash would eat a legitimate in-page anchor if this route
      // ever gains one, and the narrower rule is the one already established.
      if (!/[#&](code|error|state|id_token|access_token)=/.test(hash)) return;
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch {
        // A browser that refuses replaceState is not worth failing sign-in over.
      }
    };

    import('@/lib/entraAuth')
      .then(({ initializeAuth }) => initializeAuth())
      .then(() => {
        if (cancelled) return;
        clearFragment();

        // ONLY IF MSAL DID NOT ALREADY TAKE US SOMEWHERE.
        //
        // `navigateToLoginRequestUrl` defaults to true, so MSAL returns the
        // browser to whichever page started sign-in — `/admin/queue`, say. That
        // is a client-side history navigation, so this `.then()` still runs
        // afterwards, and an unconditional replace would overwrite the
        // destination the user actually asked for with the portal root.
        //
        // Still on the callback path means MSAL had nowhere to send us: the
        // sign-in had no request URL, or somebody opened this page directly.
        // `/admin` is the right answer only then.
        if (window.location.pathname === AUTH_REDIRECT_PATH) {
          // A full page load, not a router navigation, and not reachable with
          // Back — see hardNavigate.js for both reasons.
          hardReplace('/admin');
        }
      })
      .catch((err) => {
        // The detail goes to the console, not to the page. MSAL's messages name
        // the authority, the client id and the failure mode, and this page is
        // reachable by anyone with the URL. The same reasoning as the 401
        // descriptions in require-role.js (#517): the reader cannot act on the
        // difference, and every one of them means the same thing here.
        console.error('[auth-callback] sign-in could not be completed:', err);
        if (cancelled) return;
        clearFragment();
        setFailure(describeAuthFailure(err));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /** Put the code and the full message on the clipboard; the message is not rendered. */
  const copyDetail = async () => {
    const text = `${failure.code}: ${failure.message}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied.');
    } catch {
      // No clipboard (an in-app browser, a denied permission): the code is on
      // screen and can be read out.
      setCopied('Copy is not available here; the code above is the detail.');
    }
  };

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      {failure ? (
        <>
          <h1 className="text-lg font-semibold">Sign-in could not be completed</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            Try signing in again. If it keeps happening, send this code with your question.
          </p>
          <p className="text-sm" data-testid="auth-error-code">
            Error code:{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{failure.code}</code>
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={copyDetail}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Copy the detail
            </button>
            <a href="/admin" className="text-sm underline underline-offset-2">
              Back to the admin portal
            </a>
          </div>
          {copied && (
            <p role="status" className="text-xs text-muted-foreground">
              {copied}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="h-10 w-10 animate-spin rounded-full border-t-2 border-b-2 border-slate-blue" />
          <p className="text-sm text-muted-foreground">Completing sign-in…</p>
        </>
      )}
    </div>
  );
}
