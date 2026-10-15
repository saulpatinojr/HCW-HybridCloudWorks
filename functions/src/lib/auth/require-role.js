/**
 * The authorization guard every admin handler must call.
 *
 * Replaces `requireAdminClaims` in `src/lib/auth-middleware.js`, which had two
 * defects in nine lines:
 *
 *   1. `requiredRoles = []` defaulted to an EMPTY array, so the check loop
 *      never executed and the function returned success. Any valid Entra token
 *      in the tenant was an admin. Site-Main defaults to 'viewer' and hard
 *      rejects a token with no admin role (`admin-auth.js:91`, `:107-112`),
 *      with a comment recording that an earlier permissive bridge had been a
 *      privilege-escalation path.
 *   2. `userRoles.includes(role)` is exact-string AND semantics, where the
 *      source is a hierarchy comparison — so `['editor']` DENIED publishers and
 *      super_admins. See roles.js `satisfiesRole`.
 *
 * There is no default here. `requireRole` takes the minimum role as a required
 * argument and throws if it is not a recognised one.
 *
 * ===========================================================================
 * WHY THIS IS ONE SHARED FUNCTION
 * ===========================================================================
 * `firestore.rules` had a default-deny catch-all — `match /{document=**}` with
 * `allow read, write: if false` — that caught every path the API forgot. Azure
 * has no such backstop, and every Function registration defaults to
 * `authLevel: 'anonymous'`. One handler that forgets the check IS the
 * vulnerability.
 *
 * So the check must be structurally unavoidable rather than copy-pasted: one
 * guard, called by every handler, plus a route-inventory test that enumerates
 * every registration and asserts each is either in an explicit public
 * allowlist or invokes this. That test is the replacement for the catch-all
 * rule, and it is the highest-value test in the port.
 */

import {
  ENTRA_ADMIN_APP_ROLE,
  ENTRA_API_DELEGATED_SCOPE,
  ROLE_CACHE_MAX_ENTRIES,
  ROLE_CACHE_TTL_MS,
  satisfiesRole,
  minimumRole,
} from './roles.js';
// Static, not `await import()` inside the handler. verify-token.js imports
// nothing from this module, so there was never a cycle to break — the dynamic
// form just put a module-map lookup and a microtask on the path every
// authenticated request takes (T-408).
import { bearerTokenFrom } from './verify-token.js';
import { errorCode } from '../http/error-response.js';

/**
 * Render a value as an RFC 7235 quoted-string body.
 *
 * This ESCAPES rather than strips. The earlier version deleted backslashes and
 * quotes, which silently changed the text and was not what its own name said —
 * and now that the client unescapes properly (`parseWwwAuthenticate` in
 * lib/api.js), escaping is the half that makes the round trip lossless.
 *
 * CR/LF are normalised to a space rather than escaped, because a quoted-string
 * cannot carry them and a newline in a header value is response splitting.
 * Nothing reaching here is attacker-supplied today — every description is a
 * literal — but that is a property of the current call sites, not of this
 * function, so it is enforced where it cannot be forgotten.
 */
const quoteString = (value) =>
  String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\"])/g, '\\$1');

/**
 * Uniform JSON error.
 *
 * FIX (A10): the previous 401/403 paths set no Content-Type, so Azure served
 * them as text/plain and a frontend calling `res.json()` on a 401 got a parse
 * error instead of the message.
 *
 * A 401 ALSO SAYS WHY (#517). Until now every 401 from this API was a bare
 * status code, so the admin portal had to guess: an expired token, a rejected
 * token and a token missing the delegated scope all looked identical, and all
 * got the same interactive re-authentication — which recovers only the first.
 *
 * The RFC 6750 error codes happen to draw exactly the line the client needs:
 *
 *   invalid_token       the credential is bad. Signing in again fixes it.
 *   insufficient_scope  the credential is fine and lacks a permission. Signing
 *                       in again returns an identically-rejected token, so the
 *                       client must NOT retry — it is a configuration problem.
 *   (omitted)           no credential was presented at all. Sign in.
 *
 * `Access-Control-Expose-Headers` in cors.js is what lets the browser read this
 * at all; without it the header is set and invisible.
 *
 * @param {number} status
 * @param {string} error              Body message, unchanged.
 * @param {{code?: string, description?: string}} [challenge]
 *   RFC 6750 parameters for the WWW-Authenticate header. 401 only.
 */
function deny(status, error, challenge) {
  const headers = { 'Content-Type': 'application/json' };

  if (status === 401) {
    const parts = ['realm=""'];
    if (challenge?.code) parts.push(`error="${quoteString(challenge.code)}"`);
    if (challenge?.description) {
      parts.push(`error_description="${quoteString(challenge.description)}"`);
    }
    headers['WWW-Authenticate'] = `Bearer ${parts.join(', ')}`;
  }

  return {
    status,
    headers,
    body: JSON.stringify({ ok: false, error }),
  };
}

/**
 * Create the guard.
 *
 * Dependencies are injected rather than imported so the whole thing is
 * testable without a tenant or a database — see DECISION 5 in verify-token.js.
 *
 * @param {object} deps
 * @param {{ verify(token: string): Promise<object> }} deps.verifier
 * @param {(oid: string) => Promise<{role: string, active: boolean}|null>} deps.lookupAdmin
 *        Point-read of `admins/{oid}`. Must resolve null when absent.
 * @param {(entry: object) => void} [deps.auditDenial] Called on every denial.
 * @param {() => number} [deps.now]
 * @returns {{ requireRole: Function, requireUser: Function, clearCache: Function }}
 */
export function createRoleGuard({ verifier, lookupAdmin, auditDenial, now = Date.now }) {
  if (!verifier) throw new Error('createRoleGuard requires a verifier');
  if (!lookupAdmin) throw new Error('createRoleGuard requires lookupAdmin');

  /** @type {Map<string, {value: object|null, expiresAt: number}>} */
  const cache = new Map();

  // FIX (A12): the replaced code logged nothing on the 403 path. Site-Main
  // logs every denial with uid and attempted role and writes admin_audit_logs
  // (`admin-auth.js:109`, `:124-126`, `:405-411`).
  //
  // The sink is injected, and `default-guard.js` supplies the real one — an
  // `admin_audit_logs` upsert. This comment used to end "the container exists
  // on the Azure side with no writer", which was true when it was written and
  // is what T-406 recorded; the writer landed with the guard's
  // production composition.
  const audit = (entry) => {
    try {
      auditDenial?.(entry);
    } catch {
      // An audit sink failure must never turn a clean 403 into a 500.
    }
  };

  /**
   * Drop expired entries, then the oldest, until the map is within bounds.
   *
   * The cache is keyed by object id and only reached after a token verifies,
   * so it cannot be grown by an anonymous caller — but it had no eviction at
   * all, so on a long-lived instance it grew monotonically with every distinct
   * principal that ever signed in (T-408). Sweeping on write keeps it
   * O(1) amortised without a timer.
   */
  function evict() {
    if (cache.size <= ROLE_CACHE_MAX_ENTRIES) return;

    const currentMs = now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= currentMs) cache.delete(key);
    }
    // Map iterates in insertion order, so the first keys are the oldest
    // writes. Still over budget after dropping the expired ones means every
    // entry is live, and the oldest is the least likely to be needed next.
    for (const key of cache.keys()) {
      if (cache.size <= ROLE_CACHE_MAX_ENTRIES) break;
      cache.delete(key);
    }
  }

  async function resolveAdmin(oid) {
    const cached = cache.get(oid);
    if (cached && cached.expiresAt > now()) return cached.value;

    // Deliberately NOT wrapped in try/catch. A lookup failure must propagate
    // and become a 500, never a fallback to the token's claim — falling back
    // would reinstate the stale-role window the hybrid model exists to close.
    const record = await lookupAdmin(oid);
    cache.set(oid, { value: record ?? null, expiresAt: now() + ROLE_CACHE_TTL_MS });
    evict();
    return record ?? null;
  }

  /**
   * Authenticate, then require at least `required`.
   *
   * @param {object} request Azure Functions HttpRequest
   * @param {string|string[]} required minimum role, e.g. 'editor'
   * @returns {Promise<{user: object|null, role: string|null, error: object|null}>}
   */
  async function requireRole(request, required) {
    const minimum = minimumRole(required);
    // A typo in a handler ("publishor") must fail loudly at the call, not
    // silently open the endpoint.
    if (!minimum) throw new Error(`requireRole: unknown role requirement ${JSON.stringify(required)}`);

    const auth = await authenticate(request);
    if (auth.error) return auth;

    const { user } = auth;
    const oid = user.oid ?? user.sub;

    // Gate 1: the coarse Entra App Role. No directory assignment means we do
    // not even read the database — a stolen non-admin token cannot cause a
    // lookup.
    const claimRoles = Array.isArray(user.roles) ? user.roles : [];
    if (!claimRoles.includes(ENTRA_ADMIN_APP_ROLE)) {
      audit({ outcome: 'denied', reason: 'missing-app-role', oid, required: minimum });
      return { user: null, role: null, error: deny(403, 'Admin access required') };
    }

    // Gate 2: the authoritative record.
    const record = await resolveAdmin(oid);
    if (!record) {
      audit({ outcome: 'denied', reason: 'no-admin-record', oid, required: minimum });
      return { user: null, role: null, error: deny(403, 'Admin access required') };
    }
    if (record.active !== true) {
      audit({ outcome: 'denied', reason: 'inactive', oid, required: minimum });
      return { user: null, role: null, error: deny(403, 'Admin access required') };
    }

    // Gate 3: the hierarchy.
    if (!satisfiesRole(record.role, minimum)) {
      audit({ outcome: 'denied', reason: 'insufficient-role', oid, required: minimum, actual: record.role });
      return { user: null, role: null, error: deny(403, `Requires ${minimum} or higher`) };
    }

    return { user, role: record.role, error: null };
  }

  /**
   * Authenticate only — no role requirement. For endpoints that need a known
   * caller but not an admin (saveToolWorkspace, exportToolReport).
   */
  async function authenticate(request) {
    const token = bearerTokenFrom(request);

    if (!token) {
      // A BARE CHALLENGE. RFC 6750 §3: when the request includes no
      // authentication credentials at all, the response "SHOULD NOT include an
      // error code or other error information" — there is no failed attempt to
      // describe, and saying so would only tell an unauthenticated caller how
      // this endpoint behaves. The client reads the absent error code as
      // "sign in", which is exactly right.
      return { user: null, role: null, error: deny(401, 'Authentication required', {}) };
    }

    let user;
    try {
      user = await verifier.verify(token);
    } catch (err) {
      // The verifier's code, not its sentence: the row is stored (#945).
      audit({ outcome: 'denied', reason: 'invalid-token', detail: errorCode(err) });
      // A FIXED DESCRIPTION, NOT `err.message`.
      //
      // verify-token.js says of its own assertions that the detail "lands in
      // admin_audit_logs and never reaches the client", and echoing it here
      // would have broken that the moment the header became readable. The
      // verifier's messages distinguish an expired token from a bad signature
      // from a wrong tenant, which is a free oracle for anyone probing, and
      // `jwt audience invalid. expected: …` names configuration outright.
      //
      // The client does not need the difference: every one of them means the
      // same thing to it — sign in again. The audit row above keeps the reason
      // for whoever is actually debugging.
      return {
        user: null,
        role: null,
        error: deny(401, 'Authentication required', {
          code: 'invalid_token',
          description: 'The access token could not be verified.',
        }),
      };
    }

    // THE SCOPE GATE. An ID token is not an access token (#515).
    //
    // It lives here, in authenticate(), rather than in requireRole below, so
    // that requireUser inherits it — getAuthExpectations and
    // bootstrapCurrentUserAdmin are reached that way, and they are the thinnest
    // surface in the system.
    //
    // See ENTRA_API_DELEGATED_SCOPE in roles.js for why `scp` is the claim that
    // works and `roles` is not. Agent callers do not come through here at all:
    // require-agent.js runs its own client-credentials path, which has `roles`
    // and no `scp` by construction.
    const scopes = typeof user.scp === 'string' ? user.scp.split(' ').filter(Boolean) : [];
    if (!scopes.includes(ENTRA_API_DELEGATED_SCOPE)) {
      audit({
        outcome: 'denied',
        reason: 'missing-scope',
        oid: user.oid ?? user.sub,
        required: ENTRA_API_DELEGATED_SCOPE,
      });
      // insufficient_scope, not invalid_token: the token verified. Re-acquiring
      // it returns the same scopes and the same rejection, so the client must
      // show this rather than silently retry.
      return {
        user: null,
        role: null,
        error: deny(401, 'Authentication required', {
          code: 'insufficient_scope',
          description: `The access token is missing the ${ENTRA_API_DELEGATED_SCOPE} scope.`,
        }),
      };
    }

    return { user, role: null, error: null };
  }

  return {
    requireRole,
    requireUser: authenticate,
    /** Drop cached roles. For tests, and for use immediately after a role change. */
    clearCache: () => cache.clear(),
  };
}
