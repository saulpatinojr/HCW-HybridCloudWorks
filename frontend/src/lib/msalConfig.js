import { LogLevel } from '@azure/msal-browser';
// One string, one module, imported by both sides — see authRoutes.js for why it
// cannot live here (#520).
import { AUTH_REDIRECT_PATH } from '@/lib/authRoutes';

/**
 * MSAL configuration — values only, no instance and no window access at
 * module scope (the singleton lives in entraAuth.js so importing this file
 * stays safe in tests and SSR-ish tooling).
 *
 * Env (see Required-Inputs §4.2):
 *   VITE_ENTRA_CLIENT_ID  — the SPA app registration's client id
 *   VITE_ENTRA_TENANT_ID  — directory (tenant) id
 *   VITE_ENTRA_API_SCOPE  — the API scope to request for backend calls,
 *     e.g. "api://<api-app-id>/access_as_admin". This is what makes the
 *     token's audience match ENTRA_API_AUDIENCE on the Functions side —
 *     a Graph scope like User.Read produces a token the backend rejects.
 */

/**
 * The authority when the tenant is missing — a GUID that is never a real
 * tenant, so MSAL fails loudly at authority resolution (#516).
 *
 * This used to be `common`, which was worse than it looks. `common` was never a
 * path to backend access: the API pins one tenant by issuer, so nothing from
 * another directory could ever have been authorized. What it produced was a SPA
 * that accepted a sign-in from ANY tenant or a personal Microsoft account,
 * stored that identity in localStorage, rendered signed-in UI, and then 401'd on
 * every call — a confusing partial success in place of an unambiguous failure.
 *
 * A throw here would be the obvious alternative and is the wrong shape: this
 * module is imported at module scope by `entraAuth.js` and transitively by
 * several test files that do not mock it, and it would turn a build-time
 * configuration problem into a runtime crash on a path that already has a
 * working failure mode. `initializeAuth()` does not list the resulting error in
 * RECOVERABLE_INIT_ERRORS, so it rethrows, `onAuthStateChanged` reports null,
 * and the sign-in card renders. That is the honest outcome.
 *
 * `vite.config.js` refuses to build a DEPLOY bundle that would need this, so in
 * production it is unreachable by construction.
 */
const NO_TENANT_CONFIGURED = '00000000-0000-0000-0000-000000000000';

export const msalConfig = {
  auth: {
    clientId: import.meta.env.VITE_ENTRA_CLIENT_ID || '',
    authority: `https://login.microsoftonline.com/${
      import.meta.env.VITE_ENTRA_TENANT_ID || NO_TENANT_CONFIGURED
    }`,
    // A DEDICATED CALLBACK ROUTE, NOT THE BARE ORIGIN (#520).
    //
    // This was `window.location.origin`, which sent Entra's response to the
    // PUBLIC home page — a page that had never touched MSAL, because
    // AdminAuthGuard is lazy and mounted only under /admin. Nothing consumed
    // the authorization code, so `useAuthRedirectLanding` was mounted on every
    // route in the application to watch for a fragment that appears on one.
    //
    // `/auth/callback` is a page whose only job is to consume it. MSAL's
    // `navigateToLoginRequestUrl` defaults to true and returns the user to
    // wherever sign-in started, which is the mechanism the bare origin was
    // working around.
    //
    // THE PATH MUST BE A ROUTE THE ROUTER DECLARES AND A URI THE APP
    // REGISTRATION LISTS. The first is now structural — App.jsx imports the
    // same constant from authRoutes.js. The second is not checkable from here
    // at all, and breaks sign-in in production and nowhere else.
    redirectUri:
      typeof window !== 'undefined'
        ? `${window.location.origin}${AUTH_REDIRECT_PATH}`
        : AUTH_REDIRECT_PATH,
  },
  system: {
    /**
     * Production diagnostics, at Warning (#520).
     *
     * There were none at all. The three failures this codebase's comments are
     * built around — `endpoints_resolution_error`, `interaction_in_progress`,
     * `no_token_request_cache_error` — surface at Warning, so Error alone would
     * have shown nothing new on any of the days they cost. Volume at Warning on
     * an admin-only route is negligible.
     *
     * PII is dropped rather than trusted to a log level: `containsPii` is
     * MSAL's own flag on messages carrying a username or a token, and this
     * returns before any of them reach the console.
     */
    loggerOptions: {
      logLevel: import.meta.env.DEV ? LogLevel.Verbose : LogLevel.Warning,
      piiLoggingEnabled: false,
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        if (level === LogLevel.Error) console.error('[msal]', message);
        else console.warn('[msal]', message);
      },
    },
  },
  cache: {
    // sessionStorage, MSAL's own default for a single-page app, since #935
    // (AP-F11). This was localStorage, chosen so a redirect sign-in would
    // survive the round trip in strict browsers — the old Firebase guard had a
    // whole error path for state lost in sessionStorage.
    //
    // WHAT CHANGED, AND WHY. In localStorage the token pair outlived the tab:
    // it sat readable by any script on the origin for as long as the refresh
    // token lived, so a DOM XSS or a compromised dependency could lift a pair
    // that then worked from anywhere, for its lifetime, against the API.
    // sessionStorage is one tab's and is gone when that tab closes. It does
    // survive a same-tab navigation away and back, which is the redirect flow
    // this app uses (entraAuth.js, signIn): the browser goes to Entra and
    // returns to the same tab with the request still cached.
    //
    // THE KNOWN RISK. An in-app browser that opens the identity provider in a
    // separate web view, or one that drops session storage on the way back,
    // returns to a page with no request in progress and the sign-in starts
    // over — a loop at worst, never a wrong sign-in. The verification is the
    // owner signing in on an iPhone after the deploy. The rollback is this
    // one line back to 'localStorage'.
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
};

/** The scope the backend audience-checks. Empty until the env var is set. */
export const API_SCOPE = import.meta.env.VITE_ENTRA_API_SCOPE || '';

/** Interactive sign-in request: identity claims + the API scope. */
export const loginRequest = {
  scopes: ['openid', 'profile', 'email', ...(API_SCOPE ? [API_SCOPE] : [])],
  // Sign-out is local (entraAuth.js signOutUser calls clearCache), matching what
  // Firebase's signOut did: this application's session ends, the identity
  // provider's does not. Without this the next sign-in would silently reuse the
  // surviving Entra session and there would be no way to change account from the
  // portal at all. Firebase's Google popup showed the chooser by default, so
  // this is the behaviour being migrated from, not a new prompt.
  prompt: 'select_account',
};

/** Silent token request for backend calls — the API scope only. */
export const apiTokenRequest = {
  scopes: API_SCOPE ? [API_SCOPE] : ['openid'],
};
