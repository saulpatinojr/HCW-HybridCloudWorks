/**
 * GET /api/public/labs/coder-status — the server-side Coder status proxy
 * (#680, Phase 2 of #659; ADR 0032 decision 4).
 *
 * The public labs page shows which Coder templates exist and how many
 * workspaces are running, without the browser ever calling Coder: the SPA's
 * `connect-src` stays closed (frontend/staticwebapp.config.json) and the
 * read-only token never leaves the Function App. The route is anonymous, so
 * it is bounded the way the pricing read is — one document in
 * `tool_service_cache`, refreshed at most once a minute however many visitors
 * open the page (minute-cache.js).
 *
 * THE PANES OPEN ON THIS READ. `/education/labs/<id>` shows a lab's pane only
 * when this answers configured and reachable (LabPanePage.jsx), so those two
 * depend on nothing but Coder's address and Coder answering. Before the lab
 * launcher (2026-09-28) both also needed the status token: the owner's first
 * sign-in could not happen in a pane, because the token that opened the
 * panes was made from that sign-in, and the token's one-year expiry would
 * have closed every pane on the day it lapsed. The token now adds the
 * card's templates and running count, and nothing else.
 *
 * Four answers, all 200, the last three cached for a minute:
 *
 *   { configured: false }
 *       CODER_URL is absent, not an https URL, or still the unresolved
 *       `@Microsoft.KeyVault(…)` literal an unseeded reference arrives as. The
 *       card reads "not yet provisioned". No store read, no network.
 *   { configured: true, reachable: false, templates: [], capacity: { running: null, max }, asOf }
 *       `GET /api/v2/buildinfo` refused, timed out, or answered something
 *       that was not the documented shape.
 *   { configured: true, reachable: true, templates: [], capacity: { running: null, max }, asOf }
 *       Coder answers, and the detail is unknown: CODER_STATUS_TOKEN is
 *       absent or unresolved, Coder refused it (401 or 403, an expired or
 *       revoked token), or the detail calls failed. A warning names the
 *       setting, never its value.
 *   { configured: true, reachable: true, templates: [{ name, activeVersion }], capacity: { running, max }, asOf }
 *
 * `running: null` on a reachable answer is how the card tells "detail
 * unknown" from "no templates yet": with the token working, `running` is
 * always a number (readDetail throws on a missing count). An unknown count is
 * reported as unknown, never as zero.
 *
 * A FAILURE IS CACHED TOO, and it replaces whatever healthy entry was there.
 * A stale-but-healthy document served through a Coder outage would show
 * numbers that are no longer true, so the card says "unreachable" until the
 * next minute's attempt succeeds.
 *
 * Coder endpoints, from https://coder.com/docs/reference/api (retrieved
 * 2026-09-25) and Coder v2.37.3's router (coderd/coderd.go, read
 * 2026-09-28):
 *
 *   GET /api/v2/buildinfo
 *       Unauthenticated (registered outside the API-key middleware), and so
 *       sent with no token at all. `version` is a string.
 *
 * The detail calls carry the `Coder-Session-Token` header, which is how the
 * reference authenticates each of them:
 *
 *   GET /api/v2/templates
 *       codersdk.Template[] — `name`, `active_version_id`, … ; deprecated
 *       templates are omitted unless asked for, which is what the card wants.
 *   GET /api/v2/templateversions/{templateversion}
 *       codersdk.TemplateVersion — `name` is the version a reader recognises;
 *       the template row carries only the version's uuid.
 *   GET /api/v2/workspaces?q=status:running
 *       { count, workspaces[] } — `q` is documented as `key:value` search with
 *       `status` among its keys; `count` is the number matching.
 *
 * What the response carries and what it does not: template names are the
 * slugs the labs card lists, and version names are what an operator would
 * say aloud. No URL, no workspace name, no owner, no id —
 * nothing that describes the deployment beyond those names and two numbers.
 *
 * A REFUSED TOKEN IS RAISED, NOT ONLY ABSORBED (#1009). From 2026-10-06T01:25Z
 * Coder refused the status token for about 32 hours, and the only sign was
 * a card that said "unknown". Now every read that reaches Coder with the
 * token records Coder's answer in admin_config/coder_status_token
 * (recordTokenAnswer): when it last accepted the token, when it last refused
 * it and with which status, and since when it has been refusing. The health
 * pulse raises a refusal newer than the last acceptance as the `coder-token`
 * probe, critical (labs/lab-checks.js). And a 401 writes one warning-level
 * line that starts with TOKEN_REFUSED_401_LOG, content-free (the setting's
 * name and a status, never the token or Coder's address), for a log alert
 * to match. Neither is in the public answer, which says what it always said.
 *
 * EVIDENCE IS KEPT PER OPERATION (CodeRabbit, #1056). The token is used for
 * two different things: the labs status read (`status`: templates and
 * running workspaces, which need template:read and workspace:read) and the
 * Integrations card's expiry read (`expiry`: the token's own key record).
 * Each has its own answer in the record, and a refusal is cleared only by an
 * acceptance of the same operation, so an editor opening Integrations cannot
 * clear a status read's 403 by reading a record the token can still read.
 *
 * THE SCHEDULED CHECK DOES NOT GO THROUGH THE CACHE (CodeRabbit, #1056).
 * Anonymous visitors keep the one-minute cache warm, and a read that finds
 * it warm never asks Coder, so a check riding on that read could go hours
 * without seeing a refusal. `checkToken` asks Coder directly, with the
 * status read's two calls, records the answer, and leaves the cache alone.
 * `checkTokenIfDue` runs it when the status operation's newest answer is an
 * hour old, and checkAgentHealth, which is armed and runs every five
 * minutes, calls that, so the check needs no flag of its own and does not
 * depend on the lab canary being armed (CodeRabbit, #1056).
 */

import { createMinuteCache, jsonResponse } from './minute-cache.js';
import { errorFacts } from '../http/error-response.js';
import {
  CODER_STATUS_CACHE_ID,
  CODER_STATUS_CACHE_SECONDS,
  CODER_TIMEOUT_MS,
  DEFAULT_CODER_STATUS_USER,
  SCOPE_REFUSAL_STATUSES,
  TOKEN_RENEW_WARNING_DAYS,
  TOKEN_STATE_DOC_ID,
  TOKEN_STATE_REFRESH_MS,
  coderGet,
  hasCoderUrl,
  privateJson,
  readCoderConfig,
  statusScopeProblem,
  tokenKeyId,
} from './coder-api.js';
import { readDetailOrUnknown, readReachable, warnRefusal } from './coder-detail.js';
import { readTokenExpiry, recordTokenAnswer } from './coder-token-state.js';

export {
  CODER_API_KEY_PATTERN,
  CODER_STATUS_CACHE_ID,
  CODER_STATUS_CACHE_SECONDS,
  CODER_TIMEOUT_MS,
  DEFAULT_CODER_MAX_WORKSPACES,
  DEFAULT_CODER_STATUS_USER,
  MAX_TEMPLATES,
  SCOPE_REFUSAL_STATUSES,
  STATUS_TOKEN_EXTRA_SCOPES,
  STATUS_TOKEN_SCOPES,
  TOKEN_OPERATIONS,
  TOKEN_REFUSED_401_LOG,
  TOKEN_RENEW_WARNING_DAYS,
  TOKEN_SCOPE_FOR_EXPIRY,
  TOKEN_STATE_DOC_ID,
  TOKEN_STATE_DOC_TYPE,
  TOKEN_STATE_REFRESH_MS,
  UNSCOPED_SCOPES,
  readCoderConfig,
  readMaxWorkspaces,
  readSetting,
  readStatusUser,
  statusScopeProblem,
  tokenKeyId,
} from './coder-api.js';
export {
  TOKEN_STATE_WRITE_ATTEMPTS,
  isRefusing,
  nextTokenState,
  readTokenExpiry,
  recordTokenAnswer,
} from './coder-token-state.js';

const RUNNING_READ = 'the running-workspaces read';

/**
 * Whether a candidate status token may become CODER-STATUS-TOKEN, before
 * anything stores it (Coder automation, 2026-10-08; review of #1030). Three
 * checks, each a read made with the candidate's header through the same
 * guarded GET as every other call here (https only, no redirect, five
 * seconds), and each required to answer exactly 200:
 *
 *   works   `GET /api/v2/workspaces?q=status:running` answers an integer
 *           `count`. The token is live and serves the card.
 *   user    `GET /api/v2/users/me` names `expectedUser` (CODER_STATUS_USER,
 *           default hcw-status). A working key of the owner's, or of anyone
 *           else, is not the status token, however well it reads.
 *   scopes  `GET /api/v2/users/me/keys/{id}` lists `scopes` that hold every
 *           one of STATUS_TOKEN_SCOPES and nothing beyond them and
 *           STATUS_TOKEN_EXTRA_SCOPES. An unscoped key (`coder:all`, or the
 *           deprecated `scope` saying `all`) of a Template Admin can change
 *           and delete templates (the table in lab-host/README.md), and
 *           storing one would quietly undo the least privilege the status
 *           token exists for (secret-catalog.js: "Read-only in Coder").
 *
 * `{ ok: true, running }`, or `{ ok: false, check, reason }` with `check`
 * one of `works`, `user`, `scopes` and `reason` a sentence naming the check
 * and a status or a cause: never the token, never Coder's address, and
 * never the name of a user the token turned out to belong to. Never throws.
 */
export async function verifyStatusToken({
  fetchImpl,
  config,
  token,
  expectedUser = DEFAULT_CODER_STATUS_USER,
}) {
  const running = new URLSearchParams({ q: 'status:running' });
  const works = await verifiedRead(fetchImpl, config, `/api/v2/workspaces?${running}`, token);
  if (works.error) return failed('works', runningReadFailure(works.error));
  if (!Number.isInteger(works.body?.count)) {
    return failed('works', `Coder answered ${RUNNING_READ} without a count`);
  }

  const me = await verifiedRead(fetchImpl, config, '/api/v2/users/me', token);
  if (me.error) {
    return failed('user', `User check: ${identityReadFailure(me.error, 'its own user', 'user:read')}`);
  }
  if (me.body?.username !== expectedUser) {
    return failed('user', `User check: the token does not belong to ${expectedUser}`);
  }

  const keyPath = `/api/v2/users/me/keys/${encodeURIComponent(tokenKeyId(token))}`;
  const key = await verifiedRead(fetchImpl, config, keyPath, token);
  if (key.error) {
    return failed(
      'scopes',
      `Scope check: ${identityReadFailure(key.error, 'its own key record', 'api_key:read and user:read')}`
    );
  }
  const problem = statusScopeProblem(key.body);
  if (problem) return failed('scopes', `Scope check: ${problem}`);

  // The key's own expiry, read from the record the scope check already
  // fetched: the card shows the stored token's date from this, never the
  // previous token's (CodeRabbit review of #1030). Null when Coder gave none.
  // An ISO date-time only (Date.parse reads "42" as the year 2042), and
  // Coder writes nanoseconds, so Date.parse is given milliseconds at most.
  const raw = key.body?.expires_at;
  const expires =
    typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw)
      ? Date.parse(raw.replace(/(\.\d{3})\d+/, '$1'))
      : Number.NaN;
  return {
    ok: true,
    running: works.body.count,
    expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
  };
}

const failed = (check, reason) => ({ ok: false, check, reason });

/** One exactly-200 read: `{ body }` or `{ error }`. */
async function verifiedRead(fetchImpl, config, path, token) {
  try {
    return { body: await coderGet(fetchImpl, config, path, token, { exactly200: true }) };
  } catch (error) {
    return { error };
  }
}

/** Why the running-workspaces read failed, in words that carry no token and no URL. */
function runningReadFailure(error) {
  if (error?.status === 401 || error?.status === 403) {
    return `Coder refused the token (HTTP ${error.status})`;
  }
  if (Number.isInteger(error?.status)) return `Coder answered HTTP ${error.status} to ${RUNNING_READ}`;
  return transportFailure(error);
}

/**
 * Why an identity read failed. 403 and 404 are how Coder refuses a token the
 * scope that read needs (it counts an authorization failure as not found;
 * see SCOPE_REFUSAL_STATUSES), so they name the scope.
 */
function identityReadFailure(error, what, scope) {
  if (error?.status === 401) return 'Coder refused the token (HTTP 401)';
  if (SCOPE_REFUSAL_STATUSES.includes(error?.status)) {
    return `Coder would not show the token ${what} (HTTP ${error.status}), which it refuses a token without ${scope}`;
  }
  if (Number.isInteger(error?.status)) {
    return `Coder answered HTTP ${error.status} when the token asked for ${what}`;
  }
  return transportFailure(error);
}

function transportFailure(error) {
  if (error?.code === 'FETCH_TIMEOUT') return `Coder did not answer within ${CODER_TIMEOUT_MS / 1000} s`;
  if (error instanceof SyntaxError) return 'Coder answered with something that is not JSON';
  return 'Coder could not be reached';
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function }} deps.store
 * @param {{ requireRole: Function }} [deps.guard] - needed only by the admin token read
 * @param {Function} [deps.fetchImpl]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {() => number} [deps.now] - epoch ms
 */
export function createCoderStatusHandlers({
  store,
  guard = null,
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => Date.now(),
}) {
  const cache = createMinuteCache({
    store,
    id: CODER_STATUS_CACHE_ID,
    kind: 'labs-coder-status',
    now,
    seconds: CODER_STATUS_CACHE_SECONDS,
  });

  /** Coder's answer to the token for one operation, recorded for the health pulse (#1009). Never throws. */
  const onTokenAnswer = (operation, context) => (refusedStatus) =>
    recordTokenAnswer({ store, operation, refusedStatus, now, context });

  /**
   * The status body — the same object the route returns, for the estate read
   * (estate.js) to fold in without a second Coder call or a second cache.
   */
  async function readStatus(context) {
    const config = readCoderConfig(env);
    if (!config) {
      if (hasCoderUrl(env)) {
        context?.warn?.('coder-status: CODER_URL is not an https URL; reporting unconfigured');
      }
      return { configured: false };
    }

    const cached = await cache.read(context);
    if (cached) return cached;

    const asOf = new Date(now()).toISOString();
    let body;
    try {
      await readReachable(fetchImpl, config);
      const detail = await readDetailOrUnknown({
        fetchImpl,
        config,
        context,
        onTokenAnswer: onTokenAnswer('status', context),
      });
      body = { configured: true, reachable: true, ...detail, asOf };
    } catch (error) {
      context?.warn?.(`coder-status: Coder unreachable: ${errorFacts(error)}`);
      body = {
        configured: true,
        reachable: false,
        templates: [],
        capacity: { running: null, max: config.max },
        asOf,
      };
    }

    await cache.write(body, context);
    return body;
  }

  /**
   * The scheduled token check: the status read's two calls (templates, and
   * running workspaces), asked of Coder directly, never through the minute
   * cache, and recorded as the `status` operation's answer. Writes the same
   * warning a status read does. Leaves the cache alone, so it neither hides
   * behind a warm one nor changes what a visitor sees. Resolves
   * `{ checked, refusedStatus }`; never throws.
   */
  async function checkToken(context) {
    const config = readCoderConfig(env);
    if (!config?.token) return { checked: false, reason: config ? 'unset' : 'unconfigured' };
    const running = new URLSearchParams({ q: 'status:running' });
    try {
      await Promise.all([
        coderGet(fetchImpl, config, '/api/v2/templates', config.token),
        coderGet(fetchImpl, config, `/api/v2/workspaces?${running}`, config.token),
      ]);
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        warnRefusal(context, error.status, 'the scheduled check found it');
        await onTokenAnswer('status', context)(error.status);
        return { checked: true, refusedStatus: error.status };
      }
      context?.warn?.(
        `coder-status: the scheduled token check could not reach a verdict (${Number.isInteger(error?.status) ? `Coder answered ${error.status}` : 'no answer'})`
      );
      return { checked: false, reason: 'error' };
    }
    await onTokenAnswer('status', context)(null);
    return { checked: true, refusedStatus: null };
  }

  /**
   * `checkToken`, at most once per TOKEN_STATE_REFRESH_MS: due when the
   * status operation's newest recorded answer is that old, or when there is
   * none or it cannot be read (failing toward asking). Without
   * CODER_STATUS_TOKEN it asks nothing. Never throws.
   */
  async function checkTokenIfDue(context) {
    let entry = null;
    try {
      entry = (await store.readDoc('admin_config', TOKEN_STATE_DOC_ID, 'admin_config'))?.operations?.status ?? null;
    } catch {
      entry = null;
    }
    const answers = [entry?.lastAcceptedAt, entry?.lastRefusedAt]
      .map((iso) => Date.parse(String(iso ?? '')))
      .filter(Number.isFinite);
    if (answers.length && now() - Math.max(...answers) < TOKEN_STATE_REFRESH_MS) {
      return { checked: false, reason: 'not due' };
    }
    return checkToken(context);
  }

  return {
    readStatus,
    checkToken,
    checkTokenIfDue,

    /**
     * GET /api/cms/labs/coder-token — editor. When the status token expires,
     * for the Integrations card (#763). Not cached: it is read on demand.
     */
    async getCoderToken(request, context) {
      if (!guard) return privateJson(500, { error: 'The token read is not wired with a guard' });
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const config = readCoderConfig(env);
      if (!config) return privateJson(200, { configured: false });
      try {
        const token = await readTokenExpiry({ fetchImpl, config, context, now });
        // Coder's own answer to the token, for the health pulse: a 401 here is
        // as much a refusal as one on the public read (#1009).
        if (token.reason === 'refused') await onTokenAnswer('expiry', context)(401);
        else if (token.known) await onTokenAnswer('expiry', context)(null);
        return privateJson(200, { configured: true, token, warningDays: TOKEN_RENEW_WARNING_DAYS });
      } catch (error) {
        context.error('cmsLabsCoderToken failed:', errorFacts(error));
        return privateJson(500, { error: 'Failed to read the Coder status token' });
      }
    },

    /** GET /api/public/labs/coder-status */
    async getCoderStatus(request, context) {
      try {
        const body = await readStatus(context);
        return jsonResponse(200, body, body.configured ? CODER_STATUS_CACHE_SECONDS : 0);
      } catch (error) {
        context.error('publicGetLabsCoderStatus failed:', errorFacts(error));
        return jsonResponse(500, { error: 'Failed to read Coder status' });
      }
    },
  };
}
