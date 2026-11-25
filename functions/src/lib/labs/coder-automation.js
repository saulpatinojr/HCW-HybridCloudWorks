/**
 * Coder automation, the site's half (owner approval 2026-10-08): the lab
 * host renews the Coder status token itself, and reports how its Coder
 * upkeep went, through the lab agent's credential.
 *
 * Until now the token was renewed by hand once a year (lab-host/README.md,
 * "The status token for the site"): mint it in a pane, carry it to Admin →
 * Integrations → Keys, paste. The host can mint it unattended; what it
 * cannot do is store it, and that is on purpose.
 *
 * WHY THROUGH THE AGENT, AND NOT KEY VAULT. The vault's firewall denies the
 * host (`default_action = "Deny"`; the Function App reaches it from the
 * integration subnet), and a vault identity on the host would put a second
 * writer of secrets on a machine outside the trust boundary
 * (auth/require-agent.js). The host already holds one credential: the
 * agent's Entra certificate, whose whole reach is the agent routes. This
 * adds one route to that reach, and narrows it to one secret by name,
 * CODER-STATUS-TOKEN, and to a value Coder itself vouches for: a working key
 * of the status user, scoped to reading. A stolen certificate can therefore
 * replace the status token with another read-only key of that same user and
 * nothing else, and the site's only use of it is the labs card's counts.
 *
 * ===========================================================================
 * POST /api/agent/reportCoderAutomation (lib/lab-agent.js composes it)
 * ===========================================================================
 * Guarded by `requireAgent` exactly as the heartbeat is: the body's
 * `agentId` bound to the token's object id, active agents only. The body:
 *
 *   { agentId, statusToken?, report: { checkedAt, statusTokenExpiresAt?,
 *     statusTokenRotatedAt?, rotationTokenExpiresAt?, templatePushedAt?,
 *     templateVersion?, templateDigest?, templateSourceDigest?, lastError? } }
 *
 * Every date an ISO 8601 date-time with seconds and a zone; `templateVersion`
 * at most 64 characters, `lastError` at most 300; the two digests 64
 * lower-case hex characters (#1009): `templateDigest` is the host's
 * template_digest of what it last published, `templateSourceDigest` the same
 * digest of its checkout at report time, and labs/lab-checks.js raises a
 * pair that differs. An unknown key, a wrong
 * type, a date that is not one, or a string too long is a 400 with a
 * sentence, before any store call, any Coder call, or any vault call.
 * Validation runs after the guard, so a caller without a credential learns
 * nothing about the shape.
 *
 * THE HOST'S CLOCK IS CHECKED, NOT TRUSTED (review of #1030). `checkedAt`,
 * `statusTokenRotatedAt` and `templatePushedAt` say when something already
 * happened, so one more than MAX_CLOCK_SKEW_MS ahead of the site's clock is a
 * 400 naming the host's clock; nothing is clamped silently. The card judges
 * how fresh a report is by `reportedAt`, the site's own time of receipt,
 * never by `checkedAt`: a host whose clock read 2099 would otherwise have
 * kept the card from ever saying it had gone quiet.
 *
 * VERIFY, THEN STORE. A `statusToken` must be a Coder API key in shape
 * (CODER_API_KEY_PATTERN, from Coder v2.38's source), and then pass the three
 * checks of coder-status.js's verifyStatusToken, each a read made with it
 * that must answer exactly 200: it works (the card's own running-workspaces
 * read answers an integer `count`), it is the status user's (`/users/me`
 * names CODER_STATUS_USER, default hcw-status), and it can only read (its
 * own key record lists the read scopes and nothing more; an unscoped key is
 * refused). Only then is it written, through `writeCatalogSecret`, the same
 * writer the Keys tab's PUT uses (admin-secrets.js), so the Keys row goes
 * amber and then green as it does for a paste, and there is no second Key
 * Vault client. A token that fails a check is not stored: 422 with a
 * sentence naming the check, and the report is still recorded, with that
 * sentence as its `lastError`. A vault refusal is 502 on the same terms. A
 * stored token earns one `admin_audit_logs` row,
 * `coder_status_token_rotated`, that names the agent and the secret and
 * never the value.
 *
 * ONCE THE VAULT HAS THE TOKEN, THE ANSWER SAYS SO. The writer reports
 * `vaultWritten` and never throws past the vault write, so a failure after it
 * (recording the write on the Keys tab's state document) is not a failed
 * renewal: the token is live, the answer is 200 `{ ok: true, stored: true }`,
 * and the follow-up failure is the report's `lastError`. A host told
 * otherwise would mint and hand over yet another token.
 *
 * Answers 200 `{ ok: true, stored }`.
 *
 * ===========================================================================
 * ONE DOCUMENT: admin_config/coder_automation
 * ===========================================================================
 *   { id: 'coder_automation', configScope: 'admin_config',
 *     docType: 'coder_automation', agentId, reportedAt, checkedAt,
 *     statusTokenExpiresAt, statusTokenRotatedAt, rotationTokenExpiresAt,
 *     templatePushedAt, templateVersion, templateDigest,
 *     templateSourceDigest, lastError }
 *
 * A MERGE, under the document's ETag. The event fields (the four dates after
 * checkedAt, templateVersion and templateDigest) say when something last
 * happened, or what, so a report that does not mention one keeps the stored
 * value: a daily check that published nothing must not erase when the
 * template was last published. `checkedAt`, `templateSourceDigest`,
 * `lastError`, `reportedAt` and `agentId` describe THIS report and are always
 * replaced; a report with no `lastError` clears the last one, because the
 * check it describes went well, and one with no `templateSourceDigest` leaves
 * none, because a digest of an earlier checkout is not this one's.
 *
 * Two fields the server decides rather than records. When it stores a token,
 * `statusTokenRotatedAt` is the server's time of the store, whatever the
 * report said. When it refuses one, the report's `statusTokenRotatedAt` and
 * `statusTokenExpiresAt` are dropped: they describe a token the site does
 * not hold, and the card must not say it was renewed.
 *
 * `lastError` is the host's own sentence, shown on an admin page. Anything in
 * it shaped like a Coder API key is replaced before it is stored, so a host
 * error that quotes a token cannot put one in a document every editor reads.
 *
 * Last write wins between reports: the host runs one check at a time, and
 * the ETag is what keeps two writes in the same second from losing a field.
 *
 * ===========================================================================
 * GET /api/cms/labs/coder-automation (editor), for the Integrations card
 * ===========================================================================
 * `{ report: null | { … the fields above, by name … }, warningDays }`, never
 * cached, never the token: the document never held one.
 *
 * TELEMETRY is content-free (.github/pull_request_template.md): a warning or
 * error line names what happened and a status, never the token, the agent's
 * id or a document id.
 */

import { randomUUID } from 'node:crypto';

import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { writeCatalogSecret } from '../admin-secrets.js';
import { refreshKeyVaultReferences, setVaultSecret } from '../secret-vault.js';
import {
  TOKEN_RENEW_WARNING_DAYS,
  readCoderConfig,
  readStatusUser,
  verifyStatusToken,
} from './coder-status.js';
import { MAX_LAST_ERROR_LENGTH, parseAutomationBody } from './automation-body.js';

export {
  BODY_FIELDS,
  MAX_CLOCK_SKEW_MS,
  MAX_LAST_ERROR_LENGTH,
  MAX_TEMPLATE_VERSION_LENGTH,
  PAST_EVENT_FIELDS,
  REDACTED_KEY,
  REPORT_FIELDS,
  parseAutomationBody,
  parseIsoDateTime,
} from './automation-body.js';

export const CODER_AUTOMATION_DOC_ID = 'coder_automation';
export const CODER_AUTOMATION_DOC_TYPE = 'coder_automation';
/** The one secret this route may write. */
export const CODER_STATUS_SECRET = 'CODER-STATUS-TOKEN';
/** Read → merge → write-if-unchanged attempts before the report is given up. */
export const REPORT_WRITE_ATTEMPTS = 4;

/** The fields a report keeps until a later report mentions them (see the header). */
export const EVENT_FIELDS = Object.freeze([
  'statusTokenExpiresAt',
  'statusTokenRotatedAt',
  'rotationTokenExpiresAt',
  'templatePushedAt',
  'templateVersion',
  'templateDigest',
]);

/** Everything the document carries besides its identity, and everything the read answers. */
export const STORED_FIELDS = Object.freeze([
  'agentId',
  'reportedAt',
  'checkedAt',
  ...EVENT_FIELDS,
  'templateSourceDigest',
  'lastError',
]);

const CONTAINER = 'admin_config';
const PK = { partitionKey: ADMIN_CONFIG_PARTITION };

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** As `json`, for the editor read: an authenticated answer no cache may keep. */
const privateJson = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

/**
 * The document after this report: the stored event fields, overwritten by
 * the ones this report names; this report's own fields always replaced.
 */
export function mergeReport(current, fields) {
  const kept = {};
  for (const key of EVENT_FIELDS) {
    if (current?.[key] !== undefined) kept[key] = current[key];
  }
  return {
    id: CODER_AUTOMATION_DOC_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    docType: CODER_AUTOMATION_DOC_TYPE,
    ...kept,
    ...fields,
    lastError: fields.lastError || null,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record one report: read → merge → write-if-unchanged, retried while
 * another writer gets there first (the probe-results pattern,
 * lib/health/probe-results.js). `createDoc` for the first report, so two
 * first reports racing have a loser that reads again; `replaceDocIfMatch`
 * after that. Throws with `code: 'CONFLICT'` when every attempt lost.
 */
export async function recordAutomationReport(
  store,
  fields,
  { attempts = REPORT_WRITE_ATTEMPTS, sleep = defaultSleep } = {}
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(20 * 2 ** Math.min(attempt, 5) + Math.random() * 20);
    const current = await store.readDoc(CONTAINER, CODER_AUTOMATION_DOC_ID, ADMIN_CONFIG_PARTITION);
    const next = mergeReport(current, fields);
    try {
      return current
        ? await store.replaceDocIfMatch(CONTAINER, { ...next, _etag: current._etag }, PK)
        : await store.createDoc(CONTAINER, next);
    } catch (error) {
      // 412: replaced since our read. 409: created since our read found
      // nothing. Either way, read again and merge again.
      if (error?.code !== 412 && error?.code !== 409) throw error;
    }
  }
  throw Object.assign(new Error('The Coder automation report kept changing while it was written'), {
    code: 'CONFLICT',
  });
}

/** The read's answer for one document: the stored fields by name, null when absent. */
export function presentAutomation(doc) {
  if (!doc) return null;
  const out = {};
  for (const key of STORED_FIELDS) {
    const value = doc[key];
    out[key] = typeof value === 'string' && value ? value : null;
  }
  return out;
}

const refused = (status, error) => ({ stored: false, refusal: { status, error }, followUp: null });

/**
 * What happened to a renewed token: `{ stored, refusal, followUp }`.
 *
 *   stored    the vault holds it now. True even when something after the
 *             vault write failed, because the token is live either way, and
 *             the host must hear that it need not mint another.
 *   refusal   `{ status, error }` when it was not stored: 422 for a check it
 *             failed, 502 when Key Vault refused it.
 *   followUp  the sentence for what failed after the vault took it, or null.
 *
 * Every sentence here can reach the host's journal and the card, so none
 * carries the token; Coder's reasons name a check and a status or a cause
 * only (coder-status.js verifyStatusToken).
 */
async function storeVerifiedToken(deps, { token, agent, at }, context) {
  const config = readCoderConfig(deps.env);
  if (!config) {
    context.warn?.(
      'reportCoderAutomation: a renewed status token arrived while CODER_URL is not set; it could not be verified and was not stored'
    );
    return refused(422, 'CODER_URL is not set on the site, so the token could not be verified; it was not stored');
  }

  const verdict = await verifyStatusToken({
    fetchImpl: deps.fetchImpl,
    config,
    token,
    expectedUser: readStatusUser(deps.env),
  });
  if (!verdict.ok) {
    context.warn?.(
      `reportCoderAutomation: a renewed status token failed the ${verdict.check} check (${verdict.reason}); it was not stored`
    );
    return refused(422, `${verdict.reason}; the token was not stored`);
  }

  let written;
  try {
    written = await writeCatalogSecret(
      { store: deps.store, env: deps.env, now: () => at, vault: deps.vault, log: context },
      { name: CODER_STATUS_SECRET, value: token, actor: `lab-agent:${agent.agentId}` }
    );
  } catch (error) {
    // writeCatalogSecret never throws (admin-secrets.js), so this is a bug
    // in it; and since which step threw is unknown, so is whether the vault
    // has the token. The answer says exactly that rather than guessing.
    context.error?.(
      `reportCoderAutomation: the status token write threw (${error?.code ?? 'error'}); whether it was stored is unknown`
    );
    return refused(500, 'The token write ended in an error, so whether it was stored is unknown');
  }

  return writeOutcome(written, verdict, context);
}

/** What the vault write's answer means for the host: refused, stored with a follow-up, or stored. */
function writeOutcome(written, verdict, context) {
  if (!written.vaultWritten) {
    context.warn?.(`reportCoderAutomation: a verified status token was not stored (${written.status})`);
    return refused(written.status === 502 ? 502 : 422, written.error);
  }
  if (!written.ok) {
    context.warn?.(
      `reportCoderAutomation: the status token was stored, but a step after the vault write failed (${written.status})`
    );
    return { stored: true, expiresAt: verdict.expiresAt, refusal: null, followUp: `The token was stored, but ${written.error}` };
  }
  return { stored: true, expiresAt: verdict.expiresAt, refusal: null, followUp: null };
}

/**
 * The audit row for a stored token, the agent-registry shape. Best effort:
 * the token is already in the vault, so a failed row must not turn the
 * renewal into a reported failure the host would retry.
 */
async function auditRotation(deps, { agent, at }, context) {
  try {
    await deps.store.upsertDoc('admin_audit_logs', {
      id: deps.uuid(),
      action: 'coder_status_token_rotated',
      userId: agent.oid ?? null,
      userName: `lab agent ${agent.agentId}`,
      userEmail: null,
      timestamp: at,
      details: { agentId: agent.agentId, secret: CODER_STATUS_SECRET, verifiedAgainst: 'coder' },
      userAgent: null,
      compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
    });
  } catch (error) {
    context.warn?.(
      `reportCoderAutomation: the status token was stored but its audit row failed (${error?.code ?? 'error'})`
    );
  }
}

/** The site's sentence first, then the host's, within the field's length. */
const joinErrors = (site, host) =>
  [site, host].filter(Boolean).join(' — ').slice(0, MAX_LAST_ERROR_LENGTH);

/** What this report writes to the document, given what happened to its token. */
function reportFields(report, { agent, at, outcome }) {
  const fields = { ...report, agentId: agent.agentId, reportedAt: at };
  if (outcome.refusal) {
    delete fields.statusTokenRotatedAt;
    delete fields.statusTokenExpiresAt;
    fields.lastError = joinErrors(outcome.refusal.error, report.lastError);
  }
  if (outcome.stored) {
    fields.statusTokenRotatedAt = at;
    // The stored key's own expiry, as Coder reported it to the site's check,
    // not the report's and never the previous token's kept value: null when
    // Coder gave none (CodeRabbit review of #1030).
    fields.statusTokenExpiresAt = outcome.expiresAt ?? null;
  }
  if (outcome.followUp) fields.lastError = joinErrors(outcome.followUp, report.lastError);
  return fields;
}

const NO_TOKEN = Object.freeze({ stored: false, refusal: null, followUp: null });

/**
 * The agent's report, after `requireAgent` has bound the body to an agent
 * (lib/lab-agent.js). Separate from the HTTP shape so lab-agent.js owns the
 * guard order, as it does for its three other handlers.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function, upsertDoc: Function }} deps.store
 * @param {Record<string, string|undefined>} deps.env
 * @param {Function} deps.fetchImpl
 * @param {{ setVaultSecret: Function, refreshKeyVaultReferences: Function }} deps.vault
 * @param {() => Date} deps.now
 * @param {() => string} deps.uuid
 */
export function createCoderAutomationReporter({
  store,
  env = process.env,
  fetchImpl = globalThis.fetch,
  vault = { setVaultSecret, refreshKeyVaultReferences },
  now = () => new Date(),
  uuid = randomUUID,
}) {
  const deps = { store, env, fetchImpl, vault, now, uuid };

  return async function reportCoderAutomation({ body, agent }, context) {
    const received = now();
    const parsed = parseAutomationBody(body, received.getTime());
    if (parsed.error) return json(400, { ok: false, error: parsed.error });
    const { statusToken, report } = parsed.value;
    const at = received.toISOString();

    let outcome = NO_TOKEN;
    if (statusToken) {
      outcome = await storeVerifiedToken(deps, { token: statusToken, agent, at }, context);
      if (outcome.stored) await auditRotation(deps, { agent, at }, context);
    }
    const { stored, refusal } = outcome;

    try {
      await recordAutomationReport(store, reportFields(report, { agent, at, outcome }));
    } catch (error) {
      context.error?.(
        `reportCoderAutomation: the report could not be recorded (${error?.code ?? 'error'})${stored ? '; the token it carried was stored' : ''}`
      );
      // Once the vault has the token the answer says so, even here: the CLI
      // turns any non-2xx into a bare HTTP status, and a host told 500 would
      // mint and hand over yet another token while this one stays live
      // (CodeRabbit review of #1030). The failure is in the site's log.
      if (stored) return json(200, { ok: true, stored: true });
      return json(500, { ok: false, stored: false, error: 'The report could not be recorded' });
    }

    if (refusal) return json(refusal.status, { ok: false, stored: false, error: refusal.error });
    return json(200, { ok: true, stored });
  };
}

/**
 * GET /api/cms/labs/coder-automation — editor, the role of the token read
 * beside it (cms/labs/coder-token). What the Integrations Hybrid Lab card
 * shows under Coder; `warningDays` is the same window the token read uses.
 *
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function }} deps.store
 */
export function createCoderAutomationReadHandler({ guard, store }) {
  return async function getCoderAutomation(request, context) {
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;
    try {
      const doc = await store.readDoc(CONTAINER, CODER_AUTOMATION_DOC_ID, ADMIN_CONFIG_PARTITION);
      return privateJson(200, {
        report: presentAutomation(doc),
        warningDays: TOKEN_RENEW_WARNING_DAYS,
      });
    } catch (error) {
      context.error?.(`cmsLabsCoderAutomation failed (${error?.code ?? 'error'})`);
      return privateJson(500, { error: 'Failed to read the Coder automation report' });
    }
  };
}
