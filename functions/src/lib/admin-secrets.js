/**
 * The API-keys page: seed a credential from the admin portal, never read one back.
 *
 * ## The problem
 *
 * Rotating a key meant opening a Key Vault firewall window for your own IP,
 * running `scripts/cutover/06-seed-secret.ps1` from a desktop with the Azure CLI
 * signed in, and closing the window again. Three steps, one of which leaves the
 * production vault open to the internet if the operator walks away — a mistake
 * this repository has already made once. The app itself has none of that
 * problem: it is inside the integration subnet, so the vault's `default_action
 * = "Deny"` already admits it. It needed permission, not a network change.
 *
 * ## What this will not do
 *
 * **Return a secret's value, ever.** Not masked, not the last four characters,
 * not once. `secret-vault.js` has no read function and the app's custom vault
 * role has no `getSecret` action, so a future change that tries would get a 403
 * rather than a value. `admin-secrets.test.js` asserts the responses cannot
 * contain a seeded value even by accident.
 *
 * **Write a name Terraform does not reference.** `secret-catalog.js` is checked
 * against the `infra/` module in CI. A secret with no app setting pointing at it is
 * unreachable by application code, so seeding one creates a live credential
 * that nothing consumes and nobody owns.
 *
 * ## The four lights
 *
 * The owner asked for three — green, red, gray. The platform forces a fourth,
 * and leaving it out would make the page lie:
 *
 * - **gray / `never`** — `process.env` holds the literal `@Microsoft.KeyVault(…)`
 *   reference, or nothing. Never seeded, or the reference is not resolving.
 * - **amber / `pending`** — written AFTER this worker started. Environment
 *   variables are materialised at process start, so this worker's value cannot
 *   be the new one yet. Not a guess: a strict fact about when the write landed.
 * - **red / `failing`** — resolved to a real value, and the upstream service
 *   rejected it more recently than it accepted it. The one state
 *   `secrets-health.js` says it cannot see: "a setting whose reference resolves
 *   to the WRONG secret … only the upstream service can say it is wrong."
 * - **green / `live`** — resolved, and nothing has reported it broken.
 *
 * Amber clears when the worker answering the request started after the write.
 * On Flex Consumption workers recycle often, and the refresh call in
 * `secret-vault.js` makes the new value available to each new worker
 * immediately instead of on the 24-hour reference cache. Two workers can
 * therefore disagree for a few minutes, and the honest answer is the one the
 * answering worker can see.
 */

import { randomBytes } from 'node:crypto';

import {
  SECRET_CATALOG,
  SECRET_SECTIONS,
  findBySecretName,
  isGeneratable,
  settingToSecret,
} from './secret-catalog.js';
import { refreshKeyVaultReferences, setVaultSecret } from './secret-vault.js';
import { errorFacts } from './http/error-response.js';
import { presentSecret, readState, updateSecretRecord } from './secret-state.js';
import { rejectSecretValue } from './secret-value-rules.js';

export {
  SECRET_STATE_DOC_ID,
  SECRET_STATE_WRITE_ATTEMPTS,
  computeSecretState,
  presentSecret,
  recordSecretVerdict,
  updateSecretRecord,
} from './secret-state.js';
export { MIN_SECRET_LENGTH, rejectSecretValue } from './secret-value-rules.js';

// Re-exported so the AI router has one import for the whole feature.
export { settingToSecret };

/** Roles allowed to see or change credentials. Nothing below the top. */
export const SECRETS_ROLE = 'super_admin';

/**
 * When this worker process started, in epoch ms.
 *
 * `process.uptime()` rather than a module-load timestamp: a module imported
 * lazily would otherwise report a start time later than the environment it is
 * reasoning about, and amber would clear a moment too early.
 */
export function processStartedAt(now = Date.now(), uptimeSeconds = process.uptime()) {
  return now - Math.round(uptimeSeconds * 1000);
}

/**
 * Store one catalogue secret and record the write: the ONE path from a value
 * to the vault.
 *
 * Two callers since 2026-10-08. The Keys tab's PUT below, for a value the
 * owner pasted or generated; and the lab agent's renewal of the Coder status
 * token (lib/labs/coder-automation.js), for a value the lab host minted and
 * the API has already checked against Coder. Both get the same refusals, the
 * same set-only vault write, the same best-effort refresh and the same state
 * record, so a renewal from the host turns the Keys row amber and then green
 * exactly as a paste does, and there is no second Key Vault client to keep
 * honest. The value reaches `setVaultSecret` and nothing else: not the state
 * document, not the answer, not a log line.
 *
 * NEVER THROWS, AND NEVER HIDES THAT THE VAULT TOOK THE VALUE (review of
 * #1030). Every answer carries `vaultWritten`:
 *
 *   `{ ok: false, vaultWritten: false, status, error }`
 *       400 for a name the catalogue does not declare or a value
 *       `rejectSecretValue` refuses; 502 when Key Vault refuses the write.
 *       Nothing changed, so nothing was recorded.
 *   `{ ok: true, vaultWritten: true, recorded: true, entry, record, refresh }`
 *   `{ ok: false, vaultWritten: true, recorded: false, status: 500, error,
 *     entry, record, refresh }`
 *       The vault has the value and a step after it failed: the state
 *       record could not be written. `record` is the record it would have
 *       written and `error` a clause ("the Keys tab could not record…") a
 *       caller can put after "Stored, but". A caller that read this as
 *       "not stored" would have someone paste, or a host mint, again.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {Record<string, unknown>} deps.env
 * @param {() => string} deps.now ISO time of the write
 * @param {{ setVaultSecret: Function, refreshKeyVaultReferences: Function }} deps.vault
 * @param {{ error?: Function }} [deps.log]
 * @param {{ name: string, value: string, actor: string }} write
 * @param {{ attempts?: number, sleep?: Function }} [stateOptions] updateSecretRecord's
 */
export async function writeCatalogSecret(
  { store, env, now, vault, log },
  { name, value, actor },
  stateOptions = {}
) {
  const notWritten = (status, error) => ({ ok: false, vaultWritten: false, status, error });
  const entry = findBySecretName(name);
  if (!entry) return notWritten(400, `${name || 'that name'} is not a secret this estate declares`);
  const rejection = rejectSecretValue(value);
  if (rejection) return notWritten(400, rejection);

  let version = null;
  try {
    ({ version } = await vault.setVaultSecret(name, value, { env }));
  } catch (error) {
    // The message names the secret and the HTTP status, never the body.
    log?.error?.(`[admin-secrets] could not set ${name}: ${errorFacts(error)}`);
    return notWritten(502, `Key Vault refused the write for ${name}. The value was not stored.`);
  }

  // The secret is safely in the vault from here on, and nothing below may
  // throw past this line. The refresh is best-effort by design
  // (secret-vault.js), and an injected one that throws counts as not done.
  let refresh;
  try {
    refresh = await vault.refreshKeyVaultReferences({ env });
  } catch {
    refresh = { refreshed: false, reason: 'refresh call failed' };
  }

  let fresh = null;
  try {
    fresh = {
      lastWriteAt: now(),
      lastWriteBy: actor || 'unknown',
      lastWriteVersion: version,
      // A rotation makes any previous verdict meaningless: the old key's 401
      // says nothing about the new one.
      lastOkAt: null,
      lastFailAt: null,
      lastFailStatus: null,
    };
    const record = await updateSecretRecord(store, name, (previous) => ({ ...previous, ...fresh }), stateOptions);
    return { ok: true, vaultWritten: true, recorded: true, entry, record, refresh };
  } catch (error) {
    log?.error?.(`[admin-secrets] ${name} is stored, but its state record failed (${error?.code ?? 'error'})`);
    return {
      ok: false,
      vaultWritten: true,
      recorded: false,
      status: 500,
      error: `the Keys tab could not record the write (${error?.code ?? 'error'}), so its light may lag`,
      entry,
      record: fresh,
      refresh,
    };
  }
}

/**
 * @param {object} deps
 * @param {{requireRole: Function}} deps.guard
 * @param {object} deps.store readDoc/createDoc/replaceDocIfMatch over Cosmos
 *        (the state document is written under its ETag; see updateSecretRecord)
 */
export function createAdminSecretHandlers({
  guard,
  store,
  env = process.env,
  now = () => new Date().toISOString(),
  startedAt = null,
  vault = { setVaultSecret, refreshKeyVaultReferences },
  randomSecret = defaultRandomSecret,
  log = console,
  // Run after a write is recorded: the credential register's reminder sync
  // (admin-secrets-http.js). A sync that read the state before this write
  // either commits first, and this one corrects it, or loses its ETag to this
  // one and re-reads, so a rotation never leaves a stale due date on the
  // sheet (review of #1039). Best effort: it never changes the answer.
  afterSecretWrite = null,
}) {
  const deps = {
    guard,
    store,
    env,
    now,
    vault,
    randomSecret,
    log,
    afterSecretWrite,
    workerStartedAt: () => startedAt ?? processStartedAt(),
  };
  return {
    getSecretStatus: (request, context) => getSecretStatus(deps, request, context),
    putSecret: (request, context) => putSecret(deps, request, context),
  };
}

/** Every secret and its light. Values are never included. */
async function getSecretStatus({ guard, store, env, workerStartedAt }, request, _context) {
  const auth = await guard.requireRole(request, SECRETS_ROLE);
  if (auth.error) return auth.error;

  const secrets = await readState(store);
  const ctx = { env, startedAt: workerStartedAt() };

  return {
    status: 200,
    jsonBody: {
      success: true,
      sections: SECRET_SECTIONS,
      secrets: SECRET_CATALOG.map((entry) =>
        presentSecret(entry, { ...ctx, record: secrets[entry.secret] ?? {} })
      ),
    },
  };
}

/**
 * The value a PUT stores: the one pasted, or a generated one when asked for
 * and the secret is one this estate invents. `{ value }`, or `{ error }`
 * holding the refusal.
 */
function valueToStore(body, name, randomSecret) {
  if (body?.generate !== true) {
    return { value: typeof body?.value === 'string' ? body.value : '' };
  }
  if (!isGeneratable(name)) {
    return {
      error: bad(
        400,
        `${name} is issued by an upstream service — a generated value would be wrong, not weak`
      ),
    };
  }
  return { value: randomSecret() };
}

/** Run the follow-up after a recorded write. Best effort: a failure is logged, never answered. */
async function runAfterSecretWrite(afterSecretWrite, log) {
  try {
    await afterSecretWrite();
  } catch (error) {
    // A stable code only, never the error's message: a failed Cosmos
    // call's message can carry request details, and telemetry is
    // content-free (review of #1039). No secret name either: a log line
    // keyed on it is an inventory of what was rotated when.
    const code = error?.code ?? error?.statusCode ?? error?.name ?? 'Error';
    log.warn?.(`[putSecret] the follow-up after a recorded write failed (${code})`);
  }
}

/** Seed or rotate one secret. */
async function putSecret(deps, request, _context) {
  const { guard, store, env, now, vault, randomSecret, log, afterSecretWrite, workerStartedAt } = deps;
  const auth = await guard.requireRole(request, SECRETS_ROLE);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({}));
  const name = String(body?.secret ?? '');
  const entry = findBySecretName(name);

  if (!entry) {
    // Named, because the catalogue is not sensitive — it is derived from
    // Terraform, which is in the repository.
    return bad(400, `${name || 'that name'} is not a secret this estate declares`);
  }

  const chosen = valueToStore(body, name, randomSecret);
  if (chosen.error) return chosen.error;

  const written = await writeCatalogSecret(
    { store, env, now, vault, log },
    { name, value: chosen.value, actor: auth.user?.oid ?? auth.user?.preferred_username ?? 'unknown' }
  );
  if (!written.vaultWritten) return bad(written.status, written.error);
  const { refresh } = written;
  if (written.recorded && afterSecretWrite) await runAfterSecretWrite(afterSecretWrite, log);

  // What the operator should expect, in the words of what actually happened.
  const live = refresh.refreshed
    ? 'New workers pick it up immediately; this one keeps the old value until it recycles.'
    : `It goes live within 24 hours or at the next deploy (${refresh.reason}).`;
  return {
    status: 200,
    jsonBody: {
      success: true,
      secret: presentSecret(entry, {
        env,
        record: written.record,
        startedAt: workerStartedAt(),
      }),
      refreshed: refresh.refreshed,
      // Stored is stored: a state record that failed after the vault took
      // the value is said, not reported as a failed write, which would
      // have the operator paste the key again.
      message: written.recorded ? `Stored. ${live}` : `Stored, but ${written.error}. ${live}`,
    },
  };
}


function bad(status, message) {
  return { status, jsonBody: { success: false, error: message } };
}

/** 48 random bytes, base64url. Used only for values this estate invents. */
function defaultRandomSecret() {
  return randomBytes(48).toString('base64url');
}
