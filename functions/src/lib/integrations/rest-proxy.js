/**
 * publerProxy, linkieProxy — authenticated pass-through to third-party REST
 * APIs (#180). A third, klaviyoProxy, was removed with Klaviyo (ADR 0030).
 *
 * All three were listed `notImplemented` while the admin UI called them, so the
 * Connections, Social Hub, Mailing List and Linkie pages were dead. They share
 * one shape: the browser sends `{ path, method, body }` and the server forwards
 * it upstream with a credential the browser must never see.
 *
 * THE CREDENTIAL IS THE WHOLE POINT, and it is also the hazard. A proxy that
 * attaches a Key Vault secret to an outbound request, with the path chosen by
 * the caller, is a confused deputy: whoever controls `path` controls where the
 * secret goes. `assertSafePath` is therefore not defensive tidiness, it is the
 * security boundary —
 *
 *   - an absolute URL would send the key to a host of the caller's choosing;
 *   - a protocol-relative `//evil.test/x` is an absolute URL that does not look
 *     like one;
 *   - `..` segments can climb out of an API's versioned prefix;
 *   - a backslash is a path separator to some servers and not to URL parsers,
 *     which is exactly the disagreement a bypass lives in.
 *
 * The role gate in front of this is `editor`, not `admin`, so "they are trusted
 * already" is not an argument that survives contact with an XSS bug in the
 * portal or a stolen editor session.
 *
 * WHAT IS NOT PROXIED: the response is returned as-is, including upstream error
 * bodies, because these pages show upstream errors to the operator and a
 * flattened "request failed" would remove the only useful information. Status
 * codes are passed through for the same reason.
 *
 * WHAT IS OBSERVED ON THE WAY THROUGH: for an integration that declared
 * `reportsKeyVerdict`, a 401/403 from upstream is also recorded against its
 * key on the API-keys page (#358), through the same `lib/key-verdict.js` the
 * AI router and the Publer timer use — so the page goes red whichever path
 * sees the rejection first. The response is not changed by it: the page that
 * made the call still gets the status and the body it always did.
 */
import { randomUUID } from 'node:crypto';
import { AuthoredError, authoredMessage, errorCode, logFailure } from '../http/error-response.js';
import { createKeyVerdictReporter, isCredentialRejected } from '../key-verdict.js';
import { readUpstreamError } from './upstream-error.js';
import { redactSecrets } from './connection-probe.js';

/**
 * Recursively redacts secrets from any strings within an object tree.
 */
export function redactDeep(value, secrets) {
  if (typeof value === 'string') {
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, secrets));
  }
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [k, v] of Object.entries(value)) {
      copy[k] = redactDeep(v, secrets);
    }
    return copy;
  }
  return value;
}

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** A proxied path the guard refuses; every sentence is written below (authored, #945). */
export class UnsafePathError extends AuthoredError {}

/**
 * The path, checked before the credential travels with it.
 *
 * @param {unknown} path - the path the admin page sent
 * @returns {string}
 * @throws {UnsafePathError} when `path` could redirect the credential off its own API.
 */
export function assertSafePath(path) {
  const value = String(path ?? '');
  if (!value.startsWith('/')) {
    throw new UnsafePathError('path must start with "/"');
  }
  // `//host` is protocol-relative and resolves to another origin.
  if (value.startsWith('//')) {
    throw new UnsafePathError('path must not be protocol-relative');
  }
  // Catches `https://`, `http:/x`, and anything else with a scheme.
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new UnsafePathError('path must not contain a scheme');
  }
  if (value.includes('..')) {
    throw new UnsafePathError('path must not contain ".." segments');
  }
  if (value.includes('\\')) {
    throw new UnsafePathError('path must not contain backslashes');
  }
  // Control characters, including a newline that could inject a second
  // request line or a header into the outbound call. Written as escapes:
  // the first version embedded the raw bytes, which works but makes the
  // file read as binary to git and grep.
   
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new UnsafePathError('path must not contain control characters');
  }
  return value;
}

/**
 * One upstream API: where it lives, how it authenticates, and which env var
 * holds its key.
 *
 * Base URLs carry no trailing slash and paths always start with one, so the
 * join is unambiguous. Publer's base is taken from the existing client rather
 * than repeated — `lib/timers/publer-sync.js` has been calling this API since
 * the port and is the one place that already knows the answer.
 */
export function createIntegration({
  name,
  baseUrl,
  keyEnv,
  headers,
  extraEnv = [],
  allowedPaths = null,
  // Optional per-integration METHOD allowlist, a subset of ALLOWED_METHODS.
  // Publer's admin UI sends GET, POST and DELETE and nothing else; a key that
  // can also PUT and PATCH posts, accounts and workspace settings is scope the
  // page never needs (AP-B3, #938). Null keeps every method ALLOWED_METHODS
  // names, which is what an integration without the row gets today.
  allowedMethods = null,
  // Opt-in, not default: a verdict turns a light red on the API-keys page, and
  // the catalogue promises a probe only where one is wired (`secret-catalog.js`
  // and its test hold the two in step). Publer's 401/403 semantics are known;
  // Linkie's have not been read, and a scope-limited key that
  // answers 403 on one endpoint and 200 on the next would flap the light.
  reportsKeyVerdict = false,
  // Which setting a rejection blames, from the upstream status. Defaults to
  // the key, which is what every integration but Publer means. Publer needs
  // the choice because a 401 there blames the WORKSPACE ID and a 403 the key
  // — measured, and the opposite of what its documentation says (#358).
  verdictSettingForStatus = null,
}) {
  return {
    name,
    baseUrl,
    keyEnv,
    headers,
    extraEnv,
    allowedPaths,
    allowedMethods: normalizeAllowedMethods(name, allowedMethods),
    reportsKeyVerdict,
    verdictSettingForStatus: verdictSettingForStatus || (() => keyEnv),
  };
}

/**
 * A method allowlist is a subset of ALLOWED_METHODS or a developer error. An
 * integration is repository code, so a typo here fails at module load, where
 * it is read, rather than at the first request, where it would read as the
 * upstream refusing.
 *
 * @param {string} name
 * @param {string[]|null} allowedMethods
 * @returns {readonly string[]|null}
 */
function normalizeAllowedMethods(name, allowedMethods) {
  if (allowedMethods === null || allowedMethods === undefined) return null;
  const methods = allowedMethods.map((method) => String(method).toUpperCase());
  const unknown = methods.filter((method) => !ALLOWED_METHODS.includes(method));
  if (unknown.length > 0) {
    throw new Error(`${name}: allowedMethods must be a subset of ${ALLOWED_METHODS.join(', ')}; got ${unknown.join(', ')}`);
  }
  return Object.freeze(methods);
}

/**
 * The audit row every non-GET proxy call leaves (AP-B3, #938).
 *
 * Shape and best-effort rule shared with the platform-settings and
 * integrations writers: the row names the actor, the integration, the method,
 * the path as sent (query included, since a `DELETE /posts?post_ids[]=…` is
 * the whole story) and the outcome. A refused call is recorded too: an editor
 * session reaching for `/workspaces` with a DELETE is tamper evidence, and a
 * trail that holds only the calls that went through cannot show it.
 *
 * @param {{ upsertDoc: Function, now?: () => string, uuid?: () => string }} deps
 * @returns {(entry: object) => Promise<void>} the writer `createRestProxy` takes as `audit`
 */
export function createProxyAuditWriter({
  upsertDoc,
  now = () => new Date().toISOString(),
  uuid = () => randomUUID(),
}) {
  return async ({ integration, method, path, pathTruncated = false, outcome, status, user, role }) => {
    await upsertDoc('admin_audit_logs', {
      id: uuid(),
      action: `${integration.toLowerCase()}_proxy_${method.toLowerCase()}`,
      userId: user?.oid || user?.sub || null,
      userName: user?.name || null,
      userEmail: user?.email || user?.preferred_username || null,
      timestamp: now(),
      details: {
        integration,
        method,
        path,
        outcome,
        status,
        role,
        ...(pathTruncated ? { pathTruncated: true } : {}),
      },
    });
  };
}

/**
 * The longest path an audit row keeps whole. A `DELETE /posts?post_ids[]=…`
 * names every post it removes, so the row keeps the path as sent; this is
 * the ceiling past which the row says it was cut rather than growing
 * without bound. No page sends a path near it, and the request body
 * validator bounds the whole request at 120 KB.
 */
export const AUDIT_PATH_MAX = 4096;

/**
 * Record one non-GET call, whatever happened to it. Best effort, like the
 * other audit writers: the proxied call has been answered (or refused) on its
 * own terms, and a failed audit row must not turn that into a 500 the page
 * reads as the upstream failing.
 */
async function recordProxyAudit(audit, context, { integration, auth, method, body, outcome, status = null }) {
  if (!audit || method === 'GET') return;
  const sent = String(body?.path ?? '');
  try {
    await audit({
      integration: integration.name,
      method,
      // Whole, not a prefix (review on #1167): the ids a delete names are
      // the audit-identifying part, and they sit at the end.
      path: sent.length > AUDIT_PATH_MAX ? sent.slice(0, AUDIT_PATH_MAX) : sent,
      pathTruncated: sent.length > AUDIT_PATH_MAX,
      outcome,
      status,
      user: auth?.user || null,
      role: auth?.role || null,
    });
  } catch (error) {
    context.warn?.(
      `${integration.name}Proxy ${method} was answered but its audit row failed: ${error?.message || error}`
    );
  }
}

/**
 * Optional per-integration ALLOWLIST, on top of assertSafePath.
 *
 * assertSafePath is a denylist: it rejects shapes that could redirect the
 * credential somewhere else. An allowlist is strictly stronger — it names the
 * handful of endpoints the admin UI actually calls and refuses everything
 * else, so a caller cannot reach an unrelated part of the upstream API with a
 * key that has broader scope than the page needs.
 *
 * Applied where the set of endpoints is small and known. Site-Main did exactly
 * this for Linkie and not for Publer, whose admin pages construct
 * paths freely; narrowing those would break screens without an enumeration of
 * every path they can build.
 *
 * An entry may bind its METHODS too (review on #1167): a bare string or
 * RegExp allows every method the integration allows, while
 * `{ path, methods }` or `{ pattern, methods }` allows only those on that
 * path. Publer's five endpoints each answer a known verb, and allowing the
 * cross-product (`DELETE /posts/schedule`, say) assumed Publer refuses what
 * the Social Hub never sends.
 *
 * @param {{paths?: Array<string|{path: string, methods: string[]}>, patterns?: Array<RegExp|{pattern: RegExp, methods: string[]}>}} allowed
 * @param {string} pathOnly the path without its query string
 * @param {string} [method] the request method; omitted, only the path is judged
 * @returns {boolean}
 */
export function isAllowedPath(allowed, pathOnly, method = null) {
  if (!allowed) return true;
  const methodOk = (methods) => !methods || method === null || methods.includes(method);
  const pathHit = (allowed.paths || []).some((entry) =>
    typeof entry === 'string' ? entry === pathOnly : entry.path === pathOnly && methodOk(entry.methods)
  );
  if (pathHit) return true;
  return (allowed.patterns || []).some((entry) =>
    entry instanceof RegExp ? entry.test(pathOnly) : entry.pattern.test(pathOnly) && methodOk(entry.methods)
  );
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetch]
 * @param {(env: string) => string} deps.readKey
 * @param {Function|null} [deps.onKeyVerdict] The API-keys page's verdict
 *   writer, in the shape `createAiRouter` takes it. Consulted only for an
 *   integration that declared `reportsKeyVerdict`.
 * @param {Function|null} [deps.audit] The audit writer `createProxyAuditWriter`
 *   builds. Called once per non-GET call with the actor, method, path and
 *   outcome (AP-B3, #938); null writes nothing, which is how the tests that
 *   are not about auditing build the proxy.
 */
export function createRestProxy({
  guard,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  readKey,
  onKeyVerdict = null,
  audit = null,
}) {
  /** @returns {Function} an Azure Functions handler for one integration. */
  return function handlerFor(integration) {
    return async function handler(request, context) {
      // Per request so a failed write warns into this invocation's log. The
      // once-per-worker rule for successes lives in the process-wide writer,
      // not here.
      const reportVerdict = createKeyVerdictReporter({
        onKeyVerdict: integration.reportsKeyVerdict ? onKeyVerdict : null,
        log: context,
        source: `${integration.name}Proxy`,
      });
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;

      const apiKey = readKey(env, integration.keyEnv);
      if (!apiKey) {
        // Named, and 200-with-ok:false rather than 5xx: an unseeded key is a
        // configuration state the Connections page renders as "not connected",
        // not a fault to page anyone about.
        return json(200, {
          ok: false,
          error: `${integration.name} is not configured: ${integration.keyEnv} is not set`,
          code: 'INTEGRATION_NOT_CONFIGURED',
        });
      }
      for (const name of integration.extraEnv) {
        if (!readKey(env, name)) {
          return json(200, {
            ok: false,
            error: `${integration.name} is not configured: ${name} is not set`,
            code: 'INTEGRATION_NOT_CONFIGURED',
          });
        }
      }

      const body = await request.json().catch(() => null);
      const method = String(body?.method || 'GET').toUpperCase();
      // Every non-GET call leaves an audit row with its actor, path and
      // outcome, refused ones included (AP-B3, #938).
      const record = (outcome, extra = {}) =>
        recordProxyAudit(audit, context, { integration, auth, method, body, outcome, ...extra });
      if (!ALLOWED_METHODS.includes(method)) {
        await record('refused_method');
        return json(400, { ok: false, error: `method must be one of ${ALLOWED_METHODS.join(', ')}` });
      }
      if (integration.allowedMethods && !integration.allowedMethods.includes(method)) {
        context.error?.(`${integration.name}Proxy refused a method the admin UI never sends`, {
          method,
        });
        await record('refused_method');
        return json(400, {
          ok: false,
          error: `${method} is not an allowed ${integration.name} method`,
        });
      }

      let path;
      try {
        path = assertSafePath(body?.path);
      } catch (error) {
        // Logged at error, not warn: a caller reaching for another origin
        // through a credentialed proxy is worth seeing in telemetry whether it
        // was a bug or an attempt.
        context.error?.(`${integration.name}Proxy rejected path (${errorCode(error)})`);
        await record('refused_path');
        return json(400, { ok: false, error: authoredMessage(error, 'The path was refused.') });
      }

      // The allowlist is checked against the path WITHOUT its query string, so a
      // query cannot be used to disguise an endpoint as an allowed one.
      const pathOnly = path.split('?')[0];
      if (!isAllowedPath(integration.allowedPaths, pathOnly, method)) {
        context.error?.(`${integration.name}Proxy blocked a path outside the allowlist`, {
          path: pathOnly.slice(0, 200),
        });
        await record('refused_path');
        return json(400, {
          ok: false,
          error: `${pathOnly} is not an allowed ${integration.name} endpoint`,
        });
      }

      const options = {
        method,
        headers: { 'Content-Type': 'application/json', ...integration.headers({ apiKey, env, readKey }) },
      };
      if (body?.body !== undefined && !['GET', 'HEAD'].includes(method)) {
        options.body = JSON.stringify(body.body);
      }

      try {
        const response = await fetchImpl(`${integration.baseUrl}${path}`, options);
        const rawText = await response.text();
        const secretsToRedact = [
          apiKey,
          ...integration.extraEnv.map((name) => readKey(env, name)).filter(Boolean),
        ];
        const text = redactSecrets(rawText, secretsToRedact);
        let data = null;
        try {
          const parsed = text ? JSON.parse(text) : null;
          data = redactDeep(parsed, secretsToRedact);
        } catch {
          // Not every upstream error is JSON. Returning the raw text is more
          // use to an operator than discarding it.
          data = { raw: redactSecrets(text.slice(0, 2000), secretsToRedact) };
        }
        // The body is read BEFORE the verdict, which is the only reason the
        // verdict can carry a reason. It used to be judged on the status
        // alone, so the API-keys page could say a key was rejected but never
        // why — and "Missing or invalid Authorization header" (our request is
        // malformed) and a revoked key are the same red light with different
        // fixes (#463 item 4).
        if (response.ok) {
          // The key AND everything that travelled with it. A rejection can now
          // blame a setting other than the key (Publer's 401 blames the
          // workspace id), so clearing only `keyEnv` would leave whichever
          // other light that rejection lit stuck red through every subsequent
          // success. The timer's client clears the pair for the same reason;
          // these two must agree or the page flickers between them.
          for (const setting of [integration.keyEnv, ...integration.extraEnv]) {
            await reportVerdict(setting, { ok: true });
          }
        } else if (isCredentialRejected(response.status)) {
          await reportVerdict(integration.verdictSettingForStatus(response.status), {
            ok: false,
            status: response.status,
            detail: readUpstreamError(data),
          });
        }
        await record('upstream', { status: response.status });
        return json(200, { ok: response.ok, status: response.status, data });
      } catch (error) {
        // No answer came back, so there is no upstream sentence to relay: the
        // transport's own text (a socket error quoting its target) stays out
        // of the body and the log (#945). The code says which failure it was.
        const correlationId = logFailure(context, `${integration.name}Proxy request failed`, error, request);
        await record('failed');
        return json(200, {
          ok: false,
          // "could not be reached" is the phrase the page reads as offline (frontend lib/status.js).
          error: `${integration.name} could not be reached (${errorCode(error?.cause ?? error)}).`,
          correlationId,
        });
      }
    };
  };
}
