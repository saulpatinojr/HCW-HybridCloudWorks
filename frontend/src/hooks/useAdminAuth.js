/**
 * Modern Admin Auth Hook (v2)
 *
 * Replaces the old hardcoded environment variable approach.
 * This hook:
 * 1. Gets the current user from Entra ID (MSAL)
 * 2. Calls the backend for admin status (the admins/{oid} registry)
 * 3. Caches result and syncs with admin config
 * 4. Returns admin status for UI gating
 *
 * This is the ONLY source of truth for admin status on the frontend.
 * No more manual environment variables, no more hardcoding, no more manual syncing.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { setCachedAdminStatus } from '@/config/admin-v2';
import { authedFetch } from '@/lib/api';

// Cache admin status per-uid to prevent leaking one user's status to another
// after a sign-out/sign-in within the same tab (OWASP A01 — broken access control).
//
// One entry per uid: `{ result, time }` once the server has answered, or
// `{ pending }` while a request is in flight (AP-F12, #936). Every mounted
// instance of this hook — the guard, a page's useAuthReady, a capability
// gate — used to send its own request, each behind a forced token refresh,
// so one admin page load was several round trips to Entra and to the API
// for one answer. Now the first instance's promise is the one they all await.
const adminStatusCache = new Map(); // uid -> { result, time } | { pending }
const ADMIN_STATUS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * The three outcomes of an admin check, which used to be two.
 *
 * `UNAUTHORIZED` is an answer: the server read `admins/{oid}` and the caller is
 * not in it. `UNKNOWN` is the absence of an answer — the token could not be
 * acquired, was rejected, or the call never completed. Collapsing the second
 * into the first is what put "Access Denied — not authorized" in front of an
 * owner whose registry record was fine the whole time (#503), and it is the
 * same defect this codebase has now recorded three times: `unknown` versus
 * `disconnected` on the Recording Hub, and 401 versus 403 on Publer (#358).
 */
export const ACCESS_STATE = {
  AUTHORIZED: 'authorized',
  UNAUTHORIZED: 'unauthorized',
  UNKNOWN: 'unknown',
};

/**
 * Why a check could not run — chosen to name the ONE action that recovers it.
 *
 * `session` means authenticating again would fix it, and is the only reason
 * the hook will try to recover from on its own.
 */
export const UNKNOWN_REASON = {
  SIGNED_OUT: 'signed-out', // no session at all to renew
  SESSION: 'session', // token missing, unrenewable, or rejected by the API
  CONFIGURATION: 'configuration', // the token is fine and will be refused again
  UNAVAILABLE: 'unavailable', // the API errored, timed out, or was unreachable
};

/**
 * Classify a failure of the status call.
 *
 * `authedFetch` throws on any non-2xx and tags the error with `.status`;
 * `acquireApiToken` throws before the request is ever made and tags with
 * `.authRecovery`. A 401 is the load-bearing case: `requireUser` on the server
 * denies with 401 and nothing else, so a 401 from this route is always a
 * rejected token and never an authorization verdict.
 */
function classifyFailure(err) {
  if (err?.authRecovery === 'sign-in') return UNKNOWN_REASON.SIGNED_OUT;
  if (err?.authRecovery === 'reauthenticate') return UNKNOWN_REASON.SESSION;

  if (err?.status === 401) {
    // The API now says why (#517), and the answer decides whether retrying is
    // worth anything. `insufficient_scope` means the token verified and lacks
    // a permission — re-acquiring it returns the same scopes and the same
    // refusal, so an automatic retry is a wasted redirect at best and, without
    // the once-per-tab guard below, a loop. Anything else on a 401 is a
    // credential problem that signing in again genuinely fixes.
    //
    // This is the case #503's guard comment anticipated in so many words: "a
    // misconfigured audience, say, where the new token is rejected exactly like
    // the old one". That guard catches it after one wasted redirect. This
    // catches it before.
    const challenge = err?.wwwAuthenticate ?? {};
    if (challenge.error && challenge.error !== 'invalid_token') {
      return UNKNOWN_REASON.CONFIGURATION;
    }
    return UNKNOWN_REASON.SESSION;
  }

  return UNKNOWN_REASON.UNAVAILABLE;
}

/**
 * What the API said was wrong, when it said anything.
 *
 * Shown to the operator verbatim on the configuration card, because the whole
 * point is that the person reading it has to go and change a setting and needs
 * to know which.
 */
function failureDetail(err) {
  const description = err?.wwwAuthenticate?.error_description;
  return typeof description === 'string' && description.trim() ? description.trim() : null;
}

/**
 * Fetch admin status from backend.
 * The backend answers from the authoritative admins/{oid} registry.
 *
 * `freshToken` forces the token refresh. It is asked for on an explicit
 * re-check only: the token carries the Entra App Role (the guard's gate 1),
 * so someone pressing Try again after being granted it wants a token newer
 * than the cache holds. A page load takes the cached token, which MSAL
 * renews itself once it has expired (AP-F12, #936).
 *
 * @returns {Promise<{state: string, status?: Object, reason?: string, message?: string}>}
 */
async function fetchAdminStatusFromBackend({ freshToken = false } = {}) {
  try {
    // Call backend function to get current user's admin status. A resolved
    // response is necessarily a 2xx — authedFetch throws on everything else —
    // so reaching here means the registry was actually read.
    const response = await authedFetch('getCurrentAdminStatus', {
      method: 'GET',
      freshToken,
    });

    const status = await response.json();
    return {
      state: status?.isAdmin === true ? ACCESS_STATE.AUTHORIZED : ACCESS_STATE.UNAUTHORIZED,
      status,
    };
  } catch (err) {
    const reason = classifyFailure(err);
    console.warn(`Admin status check could not complete (${reason}):`, err?.message);
    return {
      state: ACCESS_STATE.UNKNOWN,
      reason,
      message: failureDetail(err) || err?.message || 'Unknown error',
    };
  }
}

/**
 * Get cached or fetch admin status with TTL, keyed by uid.
 *
 * An `unknown` result is NEVER cached. Caching it would hold a transient
 * network blip in front of the admin portal for five minutes, and the retry
 * button would do nothing for the first four of them.
 *
 * ONE REQUEST IN FLIGHT PER USER (AP-F12, #936). The promise is cached
 * before it settles, so an instance that mounts while the first is still
 * running awaits the same request. When it settles, only its own entry is
 * replaced: a sign-out (clearAdminStatusCache) during the flight dropped it,
 * and a late answer for a user no longer signed in must not put it back.
 *
 * A FORCED READ DOES NOT JOIN AN UNFORCED ONE. The explicit re-check (Try
 * again) asks for a fresh token because the Entra app role is a token claim:
 * a role granted a minute ago is in a new token and not in the cached one.
 * Joining a request already flying on the cached token would answer the
 * re-check with the old role, so a forced read starts its own request and
 * takes over the entry; the earlier request still answers whoever awaits it,
 * and its late settle finds the entry no longer its own and caches nothing.
 * A forced read in flight is joined by anything, forced or not: it is the
 * freshest answer there is (CodeRabbit on #1182).
 */
async function getAdminStatus(uid, { force = false } = {}) {
  if (!uid) return fetchAdminStatusFromBackend();

  const now = Date.now();
  const entry = adminStatusCache.get(uid);

  if (entry?.pending && (!force || entry.forced)) return entry.pending;

  // Return cached if still valid
  if (!force && entry?.result && now - entry.time < ADMIN_STATUS_CACHE_TTL) {
    return entry.result;
  }

  // Fetch fresh
  const pending = fetchAdminStatusFromBackend({ freshToken: force }).then(
    (result) => {
      if (adminStatusCache.get(uid)?.pending === pending) {
        if (result.state === ACCESS_STATE.UNKNOWN) {
          adminStatusCache.delete(uid);
        } else {
          adminStatusCache.set(uid, { result, time: now });
        }
      }
      return result;
    },
    (err) => {
      // fetchAdminStatusFromBackend answers `unknown` rather than throwing;
      // should that ever change, a rejection must not stay cached either.
      if (adminStatusCache.get(uid)?.pending === pending) adminStatusCache.delete(uid);
      throw err;
    }
  );
  adminStatusCache.set(uid, { pending, forced: force });

  return pending;
}

/**
 * One automatic interactive re-acquisition per browser session, and no more.
 *
 * The owner's ask is that an expired session sends them to authenticate rather
 * than to a denial screen, so a `session` failure redirects to Entra without
 * anyone clicking anything. The danger is the case where authenticating does
 * not help — a misconfigured audience, say, where the new token is rejected
 * exactly like the old one. Without a guard that is an infinite redirect loop
 * with no screen to read and no way out; a per-tab flag turns it into one
 * redirect followed by an honest "could not verify" card.
 *
 * `sessionStorage` rather than a module variable because the redirect reloads
 * the page, which is precisely when a module variable resets.
 */
const SESSION_RECOVERY_KEY = 'hcw.admin.session-recovery-attempted';

function hasAttemptedSessionRecovery() {
  try {
    return window.sessionStorage.getItem(SESSION_RECOVERY_KEY) === '1';
  } catch {
    // Storage blocked (private mode, third-party cookie policy). Treat it as
    // "already attempted": refusing the automatic redirect degrades to a
    // button, while assuming it is safe would restore the loop.
    return true;
  }
}

function markSessionRecoveryAttempted(attempted) {
  try {
    if (attempted) window.sessionStorage.setItem(SESSION_RECOVERY_KEY, '1');
    else window.sessionStorage.removeItem(SESSION_RECOVERY_KEY);
  } catch {
    // Nothing to do; hasAttemptedSessionRecovery already fails safe.
  }
}

/**
 * Clear cached admin status (call on logout). Pass a uid to clear only that
 * user; omit to clear the whole cache. A request in flight is dropped with
 * it: whoever awaits it still gets its answer, and the answer is not cached.
 */
export function clearAdminStatusCache(uid) {
  if (uid) {
    adminStatusCache.delete(uid);
  } else {
    adminStatusCache.clear();
  }
}

// ============================================================================
// HOOK: useAdminAuth
// ============================================================================

/**
 * Hook to get current user's admin status.
 *
 * @returns {Object} {
 *   authReady: boolean - True when the auth state has been resolved
 *   isLoading: boolean - True while fetching admin status
 *   user: Object|null - Current user ({uid, email, displayName})
 *   adminStatus: Object|null - Admin status (isAdmin, role, permissions, etc)
 *   accessState: string - ACCESS_STATE.AUTHORIZED | UNAUTHORIZED | UNKNOWN
 *   unknownReason: string|null - UNKNOWN_REASON.* when accessState is UNKNOWN
 *   error: string|null - Error message if fetch failed
 *   recheck: () => Promise<void> - Re-run the check, ignoring the cache
 *   hasPermission: (permission) => boolean - Check if user has permission
 *   hasRole: (role) => boolean - Check if user has role
 * }
 */
export function useAdminAuth() {
  const [authReady, setAuthReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [user, setUser] = useState(null);
  const [adminStatus, setAdminStatus] = useState(null);
  const [accessState, setAccessState] = useState(ACCESS_STATE.UNKNOWN);
  const [unknownReason, setUnknownReason] = useState(null);
  const [error, setError] = useState(null);

  // Listen for Entra (MSAL) auth state changes.
  //
  // `onAuthStateChanged` is imported dynamically (T-736). A static import put
  // `@azure/msal-browser` — 236 kB — into the chunk of every module that
  // imports this hook, including `useGenerateCuratedImages`, which runs on the
  // public `/:provider/news` route. The hook's role gate stopped it *calling*
  // anything; it could not stop the bundler resolving the import, because that
  // happens before any gate runs.
  // Apply one check result to state. Capability caches only ever see a
  // definitive answer: `unknown` publishes `isAdmin: false` so nothing
  // elsewhere in the app renders an admin control off an unverified session,
  // while THIS hook still reports `unknown` so the guard can say so out loud.
  const applyResult = useCallback((result) => {
    setAccessState(result.state);
    if (result.state === ACCESS_STATE.UNKNOWN) {
      setUnknownReason(result.reason);
      setError(result.message || null);
      setAdminStatus(null);
      setCachedAdminStatus({ isAdmin: false });
      return;
    }
    setUnknownReason(null);
    setError(null);
    setAdminStatus(result.status);
    setCachedAdminStatus(result.status);
    // A definitive answer means the session works. Re-arm the one automatic
    // recovery so the NEXT expiry is handled as quietly as this one was.
    markSessionRecoveryAttempted(false);
  }, []);

  const runCheck = useCallback(
    async (entraUser, { force = false } = {}) => {
      if (!entraUser) return;
      setIsLoading(true);
      try {
        const result = await getAdminStatus(entraUser.uid, { force });

        // The owner's ask: an expired session leads to authenticating, not to
        // a denial. Redirect once per tab; the guard below renders the honest
        // card if coming back still does not produce a usable token.
        if (
          result.state === ACCESS_STATE.UNKNOWN &&
          result.reason === UNKNOWN_REASON.SESSION &&
          !hasAttemptedSessionRecovery()
        ) {
          markSessionRecoveryAttempted(true);
          const { reauthenticateForApi } = await import('@/lib/entraAuth');
          await reauthenticateForApi(); // navigates away
          return;
        }

        applyResult(result);
      } catch (err) {
        // getAdminStatus catches its own failures, so this is a bug or a
        // failed dynamic import — unknown, not unauthorized.
        console.error('Error fetching admin status:', err);
        applyResult({
          state: ACCESS_STATE.UNKNOWN,
          reason: UNKNOWN_REASON.UNAVAILABLE,
          message: err?.message,
        });
      } finally {
        setIsLoading(false);
        setAuthReady(true);
      }
    },
    [applyResult]
  );

  // `runCheck` through a ref so the subscription effect keeps its empty deps —
  // re-subscribing to MSAL on every render would re-fire the whole auth flow.
  // Seeded at construction so the subscription below — which may fire its
  // callback synchronously — never reads an empty ref; kept current in an
  // effect rather than during render, which React forbids.
  const runCheckRef = useRef(runCheck);
  useEffect(() => {
    runCheckRef.current = runCheck;
  }, [runCheck]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = null;

    const onUser = async (entraUser) => {
      setUser(entraUser);
      setError(null);

      if (!entraUser) {
        // User logged out
        setAdminStatus(null);
        setAccessState(ACCESS_STATE.UNKNOWN);
        setUnknownReason(UNKNOWN_REASON.SIGNED_OUT);
        setCachedAdminStatus({ isAdmin: false });
        clearAdminStatusCache();
        markSessionRecoveryAttempted(false);
        setAuthReady(true);
        return;
      }

      await runCheckRef.current(entraUser);
    };

    import('@/lib/entraAuth')
      .then(({ onAuthStateChanged }) => {
        // The effect may have been torn down while the chunk was in flight;
        // subscribing then would leak a listener with no unsubscribe path.
        if (cancelled) return;
        unsubscribe = onAuthStateChanged(onUser);
      })
      .catch((err) => {
        // Failing to load the auth module is not "signed out" — it is
        // "unknown", and since #503 the hook can say so: capability gates
        // still read `hasRole` and still get false, so nothing opens, while
        // the guard shows a page that admits the check never ran instead of
        // one that claims the user was refused.
        console.error('Failed to load auth module:', err);
        if (!cancelled) {
          setAccessState(ACCESS_STATE.UNKNOWN);
          setUnknownReason(UNKNOWN_REASON.UNAVAILABLE);
          setError(err.message);
          setAuthReady(true);
        }
      });

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Helper functions
  const hasPermission = useCallback(
    (permission) => {
      if (!adminStatus?.permissions || !Array.isArray(adminStatus.permissions)) {
        return false;
      }
      return adminStatus.permissions.includes(permission);
    },
    [adminStatus]
  );

  const hasRole = useCallback(
    (role) => {
      if (!adminStatus?.role) return false;
      const ADMIN_ROLES = {
        viewer: 1,
        editor: 2,
        publisher: 3,
        super_admin: 4,
      };
      const userLevel = ADMIN_ROLES[adminStatus.role] || 0;
      const requiredLevel = ADMIN_ROLES[role] || 999;
      return userLevel >= requiredLevel;
    },
    [adminStatus]
  );

  /** Re-run the check, ignoring the five-minute cache. The retry button. */
  const recheck = useCallback(() => runCheck(user, { force: true }), [runCheck, user]);

  return {
    authReady,
    isLoading,
    user,
    adminStatus,
    accessState,
    unknownReason,
    error,
    // Unchanged contract for every existing caller: only a registry answer of
    // `isAdmin: true` is admin. `unknown` clears adminStatus, so it is false
    // here exactly as it was before — the difference is that the guard can
    // now tell the two falses apart.
    isAdmin: adminStatus?.isAdmin === true,
    recheck,
    hasPermission,
    hasRole,
  };
}

// ============================================================================
// HOOK: useAuthReady (backward compat - DEPRECATED)
// ============================================================================

/**
 * DEPRECATED: Use useAdminAuth() instead.
 *
 * This hook is provided for backward compatibility only.
 * All new code should use useAdminAuth().
 */
export function useAuthReady() {
  const { authReady, user, isAdmin } = useAdminAuth();

  return {
    authReady,
    user,
    isAdmin,
  };
}
