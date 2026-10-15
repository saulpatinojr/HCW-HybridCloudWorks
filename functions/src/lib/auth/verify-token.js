/**
 * Entra ID token verification.
 *
 * Replaces the verification half of `src/lib/auth-middleware.js`, which had
 * three defects that together were a full admin bypass for any tenant member.
 * Each fix is annotated with the finding it closes.
 *
 * ===========================================================================
 * DECISION 3 — app registration topology: TWO registrations
 * ===========================================================================
 * A public-client SPA registration, and a separate API registration exposing
 * `api://<api-client-id>`. The API validates `aud` against its OWN identifier.
 *
 * With a single registration, an ID token minted for the SPA carries
 * `aud = <client-id>` — indistinguishable from an access token for the API. So
 * a token the browser was never meant to send to an API is accepted by it.
 * Two registrations make the audience meaningful.
 *
 * `ENTRA_API_AUDIENCE` is therefore REQUIRED and has no default.
 *
 * AMENDED 2026-09-12 (#515, then #522). This paragraph described a topology
 * the tenant did not have: the former `scripts/cutover/01-entra-spa.ps1` put an
 * SPA platform on the API registration, so the hazard above was live rather
 * than hypothetical. #522 split them — `01-entra-api.ps1` owns the resource,
 * `02-entra-spa-client.ps1` owns the client — so the text is true again.
 *
 * It was also wrong about the remedy. This text used to end "and let us
 * additionally reject anything without a `scp`/`roles` claim" — but Entra emits
 * assigned app roles in ID tokens too, so a `roles` check separates nothing.
 * `scp` does, and only `scp`: it appears in delegated access tokens and never
 * in ID tokens. `require-role.js` enforces it in `authenticate()`, which closes
 * the hazard independently of how many registrations exist and keeps working
 * after they are split (#522).
 *
 * The topology was worth fixing for the reason Microsoft actually gives — a
 * public client should not share a service principal with the resource it
 * calls — rather than because the API cannot defend itself. The scope check is
 * what makes that a hygiene change rather than an emergency, and it stays: it
 * costs nothing and it is what holds if the two are ever merged again.
 *
 * ===========================================================================
 * DECISION 5 — JWKS must be injectable
 * ===========================================================================
 * `createTokenVerifier()` is a factory, not a module-scope singleton. The
 * previous module built its `jwksClient` at import time against a hardcoded
 * URI, which made it untestable without a live tenant — and retrofitting that
 * after eleven handlers exist means touching all eleven.
 *
 * Tests generate an RSA keypair, serve a local JWKS document, and point the
 * verifier at it. That is the direct analogue of Site-Main's
 * `roleUserContext(role)` emulator helper, and it is the only way to exercise
 * the role hierarchy without a directory.
 */

import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

/** Only RS256. See "algorithm pinning" below. */
const ALLOWED_ALGORITHMS = ['RS256'];

/**
 * Seconds of clock skew tolerated on `exp`/`nbf`.
 *
 * Entra sets `nbf` to approximately now, so with zero tolerance a freshly
 * issued token is intermittently rejected on a host with a slightly fast
 * clock. Kept small — tolerance is added token lifetime.
 */
const CLOCK_TOLERANCE_SECONDS = 60;

/**
 * Build a token verifier.
 *
 * @param {object} config
 * @param {string} config.tenantId  Entra tenant GUID. REQUIRED — no 'common'.
 * @param {string} config.audience  The API's application ID URI or client id.
 * @param {string} [config.jwksUri] Override for tests.
 * @returns {{ verify: (token: string) => Promise<object> }}
 */
/**
 * The only access-token version this API accepts.
 *
 * Stated once and exported because `getAuthExpectations` reports it to the
 * configuration review page (#519): a page that compares a live token against a
 * frontend constant only proves the frontend agrees with itself.
 *
 * It is `2.0` because the app registration sets `requestedAccessTokenVersion =
 * 2`, which is also why `ENTRA_API_AUDIENCE` is a bare GUID rather than the
 * `api://` App ID URI. The two move together — see infra/variables.tf.
 */
export const ENTRA_REQUIRED_TOKEN_VERSION = '2.0';

/** Entra tenant ids are GUIDs. Anything else did not come from a directory. */
const TENANT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The claim checks jsonwebtoken does not make for us (#515).
 *
 * Throws a plain Error naming the claim. Both guards already wrap
 * `verifier.verify()` in try/catch, audit `{reason:'invalid-token', detail:
 * err.message}` and return a flat 401 — so the message lands in
 * `admin_audit_logs` and never reaches the caller.
 *
 * @param {object} payload  A verified token payload.
 * @param {string} tenantId The configured Entra tenant GUID.
 */
function assertEntraClaims(payload, tenantId) {
  const tid = typeof payload?.tid === 'string' ? payload.tid : '';

  // Microsoft's guidance makes the GUID SHAPE part of the check, not just
  // equality — a `tid` that is not a GUID did not come from a directory at all.
  if (!TENANT_GUID.test(tid)) {
    throw new Error('Token tid claim is missing or not a GUID');
  }

  if (tid.toLowerCase() !== String(tenantId).toLowerCase()) {
    throw new Error('Token tid claim does not match the configured tenant');
  }

  // A TAUTOLOGY TODAY, AND KEPT ANYWAY.
  //
  // With a single pinned issuer above and `tid === tenantId` asserted, this
  // cannot fail independently. It is here so that re-adding an entry to the
  // issuer list fails closed instead of silently reopening the cross-tenant
  // path — which is the chain of trust Microsoft describes: tie the tenant back
  // to the issuer, and the issuer back to the scope of the signing key.
  const expectedIssuer = `https://login.microsoftonline.com/${tid}/v2.0`;
  if (String(payload?.iss ?? '').toLowerCase() !== expectedIssuer.toLowerCase()) {
    throw new Error('Token iss claim does not match its own tid claim');
  }

  // Made explicit rather than implied by the audience shape. See the issuer
  // comment in createTokenVerifier for why v1 is not accepted.
  if (String(payload?.ver ?? '') !== ENTRA_REQUIRED_TOKEN_VERSION) {
    throw new Error(`Token ver claim is not ${ENTRA_REQUIRED_TOKEN_VERSION}`);
  }
}

export function createTokenVerifier({ tenantId, audience, jwksUri } = {}) {
  // FIX (A1): fail fast on missing configuration.
  //
  // The previous code read `process.env.ENTRA_CLIENT_ID` with no validation and
  // passed it straight to `jwt.verify` as `audience`. jsonwebtoken only applies
  // the audience check when the option is truthy, so an unset or misspelled app
  // setting did not throw — it SKIPPED audience validation entirely and
  // successfully verified any Microsoft-signed token whose issuer matched the
  // tenant. A Graph token. A token for any other app in the directory.
  if (!tenantId) throw new Error('ENTRA_TENANT_ID is required — refusing to start without it');
  if (!audience) throw new Error('ENTRA_API_AUDIENCE is required — refusing to start without it');

  // FIX (A4): no 'common' fallback.
  //
  // `tenantId || 'common'` pointed JWKS at the common endpoint, which serves
  // signing keys for every tenant on earth, leaving the issuer string as the
  // only barrier to cross-tenant token acceptance. It also produced issuer
  // values no real token carries, so it failed closed into a total lockout that
  // reads as "auth is broken" — the state in which someone loosens the check.
  //
  // ONE ISSUER, v2 ONLY (#515). The v1 form `https://sts.windows.net/{tid}/`
  // used to sit beside this one and could never pass: the registration sets
  // `requestedAccessTokenVersion = 2`, so `aud` is the bare client-id GUID,
  // while a v1 token carries `api://<guid>` and fails the audience check first.
  // It was dead, but latently dangerous — infra/variables.tf documents the
  // `api://` audience as a supported alternative, and the day someone takes
  // that option the v1 issuer would go live with no `ver` gate behind it.
  // Microsoft's rule is that a v1 token is validated against v1 metadata and a
  // v2 token against v2 metadata; one issuer list against one audience and one
  // JWKS endpoint was not that. Restoring it requires a `ver` gate.
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;

  const client = jwksClient({
    jwksUri: jwksUri ?? `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    cache: true,
    // FIX (A8): Microsoft typically publishes 6–8 signing keys. A cache of 5
    // guarantees eviction thrash during normal rotation.
    cacheMaxEntries: 16,
    cacheMaxAge: 600_000,
    // FIX (A8): without rate limiting, an unauthenticated caller sending tokens
    // with random `kid` values forces one JWKS round trip per unique kid — a
    // pre-auth outbound amplification path that also injects latency into every
    // admin request.
    rateLimit: true,
    jwksRequestsPerMinute: 30,
  });

  const getKey = (header, callback) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err) return callback(err, null);
      callback(null, key.publicKey || key.rsaPublicKey);
    });
  };

  return {
    /**
     * Prewarm the JWKS cache by eagerly fetching signing keys.
     * Reduces latency on the first token verification call.
     *
     * @returns {Promise<Array<object>|null>}
     */
    async prewarm() {
      if (typeof client.getSigningKeys === 'function') {
        const keys = await client.getSigningKeys();
        if (Array.isArray(keys)) {
          for (const key of keys) {
            if (key?.kid) {
              await new Promise((resolve) => {
                client.getSigningKey(key.kid, () => resolve());
              });
            }
          }
        }
        return keys;
      }
      return null;
    },

    /**
     * Verify a raw bearer token.
     * Resolves the decoded payload, or rejects with an Error.
     *
     * @param {string} token
     * @returns {Promise<object>}
     */
    verify(token) {
      return new Promise((resolve, reject) => {
        jwt.verify(
          token,
          getKey,
          {
            audience,
            issuer,
            // FIX (A3): pin the algorithm.
            //
            // The previous code omitted this and was safe only as a property of
            // the installed dependency — jsonwebtoken 9.x derives permitted
            // algorithms from the key type, defeating `alg: none` and HS256 key
            // confusion. package.json pins `^9.0.3`, a RANGE. Do not depend on a
            // transitive default for the classic JWT bypass.
            algorithms: ALLOWED_ALGORITHMS,
            clockTolerance: CLOCK_TOLERANCE_SECONDS, // FIX (A7)
          },
          (err, decoded) => {
            if (err) return reject(err);
            // Claim assertions run HERE, after the signature has been checked,
            // never before. Every value read below is one Microsoft minted, so
            // `tid` reaching an audit row is not attacker-controlled input.
            try {
              assertEntraClaims(decoded, tenantId);
            } catch (claimError) {
              return reject(claimError);
            }
            return resolve(decoded);
          }
        );
      });
    },
  };
}

/**
 * Extract a bearer token from a request.
 *
 * FIX (A11): matched case-insensitively and sliced rather than split. The
 * previous `split('Bearer ')[1]` also mangles any token containing the literal
 * substring "Bearer ". Site-Main used `/^Bearer (.+)$/i`; this matches it.
 *
 * @param {{ headers: { get(name: string): string|null } }} request
 * @returns {string|null}
 */
export function bearerTokenFrom(request) {
  const header = request?.headers?.get?.('authorization');
  if (!header) return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || null : null;
}
