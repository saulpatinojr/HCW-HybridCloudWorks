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

import { ADMIN_CONFIG_PARTITION } from './cosmos-client.js';
import { isUnresolvedReference } from './secrets-health.js';
import {
  SECRET_CATALOG,
  SECRET_SECTIONS,
  findBySecretName,
  isGeneratable,
  settingToSecret,
} from './secret-catalog.js';
import { refreshKeyVaultReferences, setVaultSecret } from './secret-vault.js';
import { errorFacts } from './http/error-response.js';

// Re-exported so the AI router has one import for the whole feature.
export { settingToSecret };

/** The single `admin_config` document holding per-secret state. */
export const SECRET_STATE_DOC_ID = 'secret_state';

/** Shortest value accepted. Every real credential in this estate is far longer. */
export const MIN_SECRET_LENGTH = 12;

/**
 * Values that are obviously not credentials.
 *
 * Required-Inputs §4.6's rule is "do not seed a placeholder to quiet a linter" — a
 * placeholder turns a gray light green while the feature stays just as broken,
 * which is strictly worse than absent because nobody looks at it again.
 */
const PLACEHOLDER_PATTERN =
  /^(changeme|change-me|placeholder|todo|tbd|test|example|your[-_]?key([-_]?here)?|xxx+|<.*>)$/i;

/*
 * THE PATTERNS BELOW NAME THEIR CODE POINTS AS NUMBERS, NEVER AS CHARACTERS.
 *
 * A file about invisible characters that contains invisible characters reads
 * as binary to git and to grep, and the one thing nobody can review is the
 * byte they cannot see. `integrations/rest-proxy.js` records the same trap
 * against its own control-character check, and made the same choice (#484).
 */

/**
 * Characters with no width, which a paste can carry and no eye can find.
 *
 * `String.prototype.trim()` is not a defence against any of these. It removes
 * U+00A0 and U+FEFF, and only at the ends; U+200B and the bidi marks it does
 * not touch even there, and nothing it does reaches the middle of a string.
 * So a key with a zero-width space in it stores clean, resolves clean, and is
 * refused upstream forever as "the key is wrong".
 *
 * U+FEFF appears here as well as in `trim`'s set because interior is exactly
 * where trim cannot help.
 */
const INVISIBLE_PATTERN =
  /[\u00ad\u200b\u200c\u200d\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/**
 * C0 and C1 control characters, and the DEL in between.
 *
 * A raw newline inside a value is the common one, and it survives `trim` when
 * it is not at an end. Anything in this range that reaches an outbound header
 * throws in `fetch` rather than being rejected by the provider, which is a
 * crash where a diagnosis should be — the measurement on 2026-09-09 caught
 * exactly that shape.
 */
 
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** The four a phone keyboard or a rich-text editor substitutes for ' and ". */
const SMART_QUOTE_PATTERN = /[\u2018\u2019\u201c\u201d]/;

/**
 * A value that arrived still wearing its quotes.
 *
 * Straight, curly and backtick, and only as a MATCHED pair — a credential is
 * allowed to contain a quote, just not to be wrapped in one. The curly pairs
 * are directional, so the opener and closer differ.
 */
const WRAPPED_IN_QUOTES = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
];

/**
 * A label that precedes a credential, pasted along with it.
 *
 * NOT called an auth-scheme pattern, and the message it produces does not say
 * "Authorization header", because only half of these come from one. `Bearer`,
 * `Basic` and `Bearer-API` are HTTP auth schemes; `token:` and `api_key:` are
 * far more often a key in a YAML file, a `.env` line or a form label. Claiming
 * a header for those would name the wrong source on a check whose entire
 * purpose is naming the right one — the same correction the whitespace message
 * needed. What is true of all of them is that they LABEL the credential
 * instead of being part of it, so that is what the sentence says.
 *
 * `Bearer-API` is listed before `Bearer` because these alternate left to
 * right: with `Bearer` first, a Publer value would match on the short one and
 * the message would quote a scheme the operator never pasted. The trailing
 * separator is required, so a credential that merely begins with these letters
 * is untouched.
 */
const CREDENTIAL_LABEL_PATTERN =
  /^(authorization\s*:|bearer-api|bearer|basic|token|api[-_]?key)[\s:]/i;

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
 * Reject a value before it reaches the vault.
 *
 * Ported from `06-seed-secret.ps1`, which refuses the same things for the same
 * reasons. A bad value written to the vault is worse than a rejected paste: it
 * shows green and fails upstream.
 *
 * @returns {string|null} the reason it is unacceptable, or null
 */
export function rejectSecretValue(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'no value was supplied';
  if (raw !== raw.trim()) {
    // Copying from a terminal or a PDF picks up a trailing newline or NBSP.
    // The vault stores it happily and the upstream service rejects it, which
    // presents as "the key is wrong" rather than "the key has a space on it".
    return 'the value has leading or trailing whitespace — copy it again without the surrounding space';
  }
  if (raw.startsWith('@Microsoft.KeyVault(')) {
    return 'that is a Key Vault REFERENCE, not a secret value — paste the credential itself';
  }
  if (raw.length < MIN_SECRET_LENGTH) {
    return `the value is shorter than ${MIN_SECRET_LENGTH} characters, which no credential in this estate is`;
  }
  if (PLACEHOLDER_PATTERN.test(raw)) {
    return 'that looks like a placeholder — a placeholder turns the light green while the feature stays broken';
  }

  // Everything below is #484, and it runs AFTER every check above so that a
  // placeholder still reads as a placeholder. Each names WHAT WAS FOUND: the
  // whole failure this guards against is a value that stores clean and is
  // refused upstream forever as "the key is wrong", so "invalid" here would
  // reproduce the same uselessness one layer earlier.
  //
  // Ordered most specific first. A pasted `Authorization: Bearer abc` trips
  // three of these, and the useful sentence is the one about the header, not
  // the one about a space.
  if (INVISIBLE_PATTERN.test(raw)) {
    return 'the value contains an invisible character (a zero-width space or a text-direction mark) — retype it, or paste it through a plain-text editor first';
  }
  if (CONTROL_PATTERN.test(raw)) {
    return 'the value contains a control character, such as a line break inside it — copy the credential on its own, without the line it sits on';
  }
  for (const [open, close] of WRAPPED_IN_QUOTES) {
    if (raw.length > 1 && raw.startsWith(open) && raw.endsWith(close)) {
      return 'the value is wrapped in quotes — paste the credential itself, without the quotes around it';
    }
  }
  if (SMART_QUOTE_PATTERN.test(raw)) {
    return 'the value contains a curly quote, which a phone keyboard or a rich-text editor substitutes for a straight one — retype it in a plain-text field';
  }
  const label = raw.match(CREDENTIAL_LABEL_PATTERN);
  if (label) {
    return `the value starts with "${label[1]}", which labels the credential rather than being part of it — paste only what comes after it`;
  }
  if (/\s/.test(raw)) {
    // Reached only for whitespace in the MIDDLE: the leading and trailing case
    // is caught by the trim comparison above, which gives a better sentence.
    //
    // "whitespace", not "a space", because `\s` is wider than the space bar
    // and what survives to this line is the wide part. Every ASCII whitespace
    // character is a control character and was refused above; what reaches
    // here is U+0020 and the Unicode spaces beyond it — U+00A0, U+2000-U+200A,
    // U+2028, U+3000. Calling U+2028 "a space" would name the wrong thing, on
    // a check whose entire purpose is naming the right one.
    return 'the value has whitespace inside it — a credential in this estate has none, so part of the surrounding text was copied with it';
  }
  return null;
}

/**
 * Which light one secret shows.
 *
 * Pure, so the state machine is testable without Cosmos, Azure or a clock.
 *
 * @param {{setting: string}} entry catalogue entry
 * @param {object} ctx
 * @param {Record<string, unknown>} ctx.env
 * @param {object} ctx.record per-secret state, may be empty
 * @param {number} ctx.startedAt when this worker started, epoch ms
 * @returns {'never'|'pending'|'failing'|'live'}
 */
export function computeSecretState(entry, { env = {}, record = {}, startedAt = 0 } = {}) {
  const written = Date.parse(record?.lastWriteAt ?? '');

  // A write this worker cannot yet have seen. Checked BEFORE the env read: a
  // rotation over an already-live key leaves a real value in env, and calling
  // that green would report the OLD credential as the new one's status.
  if (Number.isFinite(written) && written > startedAt) return 'pending';

  const value = env?.[entry.setting];
  if (typeof value !== 'string' || !value.trim() || isUnresolvedReference(value)) return 'never';

  const failedAt = Date.parse(record?.lastFailAt ?? '');
  if (Number.isFinite(failedAt)) {
    const okAt = Date.parse(record?.lastOkAt ?? '');
    if (!Number.isFinite(okAt) || failedAt > okAt) return 'failing';
  }
  return 'live';
}

const strOrNull = (value) => (typeof value === 'string' && value ? value : null);

/**
 * Everything the page renders for one secret — and nothing else.
 *
 * Deliberately built by naming each field rather than spreading `record`: a
 * spread would carry any field a future writer added, and the one field this
 * response must never carry is a value.
 */
export function presentSecret(entry, ctx) {
  const record = ctx.record ?? {};
  return {
    secret: entry.secret,
    setting: entry.setting,
    section: entry.section,
    label: entry.label,
    help: entry.help,
    state: computeSecretState(entry, ctx),
    generatable: isGeneratable(entry.secret),
    hasLivenessCheck: Boolean(entry.probe),
    lastWriteAt: strOrNull(record.lastWriteAt),
    lastWriteBy: strOrNull(record.lastWriteBy),
    lastOkAt: strOrNull(record.lastOkAt),
    lastFailAt: strOrNull(record.lastFailAt),
    lastFailStatus: Number.isFinite(record.lastFailStatus) ? record.lastFailStatus : null,
    // What the provider SAID, beside the number it answered with. Values are
    // still never included — this is the upstream's own error sentence, which
    // is what tells an operator whether to rotate the key or fix the request
    // (#463 item 4).
    lastFailDetail: strOrNull(record.lastFailDetail),
  };
}

const STATE_CONTAINER = 'admin_config';
const STATE_PK = { partitionKey: ADMIN_CONFIG_PARTITION };

/** Read → change → write-if-unchanged attempts on the state document before a write gives up. */
export const SECRET_STATE_WRITE_ATTEMPTS = 6;

const secretsOf = (doc) => (doc?.secrets && typeof doc.secrets === 'object' ? doc.secrets : {});

async function readState(store) {
  return secretsOf(await store.readDoc(STATE_CONTAINER, SECRET_STATE_DOC_ID, ADMIN_CONFIG_PARTITION));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Change ONE secret's record in the state document, and nothing else in it.
 *
 * Three writers share `secret_state`: the Keys tab's PUT, the lab agent's
 * renewal of the Coder status token, and every key verdict the AI router and
 * the Publer clients report (key-verdict.js). Until the review of #1030 each
 * read the document and upserted the whole `secrets` map, so two writes in
 * the same moment kept only the later one's view of everything: a verdict
 * landing during a renewal could put the old record back over the new
 * write, and the Keys row would show green for a token nothing had checked.
 *
 * Now each write is conditional on the ETag it read (`createDoc` for the
 * first, which has a loser too), and a writer that loses reads again and
 * applies its change to what is there now: the probe-results pattern
 * (lib/health/probe-results.js). `change(record)` gets this secret's current
 * record and returns its next one. Resolves to that record; throws with
 * `code: 'CONFLICT'` when every attempt lost, and with no id or name in the
 * message, which a caller may log.
 */
export async function updateSecretRecord(
  store,
  name,
  change,
  { attempts = SECRET_STATE_WRITE_ATTEMPTS, sleep = defaultSleep } = {}
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(20 * 2 ** Math.min(attempt, 5) + Math.random() * 20);
    const current = await store.readDoc(STATE_CONTAINER, SECRET_STATE_DOC_ID, ADMIN_CONFIG_PARTITION);
    const secrets = secretsOf(current);
    const record = change({ ...(secrets[name] ?? {}) });
    const next = {
      id: SECRET_STATE_DOC_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      secrets: { ...secrets, [name]: record },
    };
    try {
      if (current) {
        await store.replaceDocIfMatch(STATE_CONTAINER, { ...next, _etag: current._etag }, STATE_PK);
      } else {
        await store.createDoc(STATE_CONTAINER, next);
      }
      return record;
    } catch (error) {
      // 412: replaced since our read. 409: created since our read found
      // nothing. Either way, read again and change again.
      if (error?.code !== 412 && error?.code !== 409) throw error;
    }
  }
  throw Object.assign(new Error('The secret state kept changing while it was written'), {
    code: 'CONFLICT',
  });
}

/**
 * Record how an upstream service answered for a credential.
 *
 * This is what turns a light red, and back green again. Called from the AI
 * router, which already distinguishes "the key was rejected" (401/403) from
 * "the request was bad" — see `isProviderUnusable`.
 */
export async function recordSecretVerdict(
  store,
  secretName,
  { ok, status = null, detail = '', now = () => new Date().toISOString() },
  options = {}
) {
  if (!store || !findBySecretName(secretName)) return;
  await updateSecretRecord(
    store,
    secretName,
    (previous) =>
      ok
        ? { ...previous, lastOkAt: now() }
        : {
            ...previous,
            lastFailAt: now(),
            lastFailStatus: Number.isFinite(status) ? status : null,
            // Overwritten on every failure, including with `''` when the provider
            // gave no reason — a stale sentence from a previous rejection beside a
            // fresh status is worse than no sentence at all.
            lastFailDetail: typeof detail === 'string' ? detail.slice(0, 300) : '',
          },
    options
  );
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
  const workerStartedAt = () => startedAt ?? processStartedAt();

  /** Every secret and its light. Values are never included. */
  async function getSecretStatus(request, context) {
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

  /** Seed or rotate one secret. */
  async function putSecret(request, context) {
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

    let value = typeof body?.value === 'string' ? body.value : '';
    if (body?.generate === true) {
      if (!isGeneratable(name)) {
        return bad(
          400,
          `${name} is issued by an upstream service — a generated value would be wrong, not weak`
        );
      }
      value = randomSecret();
    }

    const written = await writeCatalogSecret(
      { store, env, now, vault, log },
      { name, value, actor: auth.user?.oid ?? auth.user?.preferred_username ?? 'unknown' }
    );
    if (!written.vaultWritten) return bad(written.status, written.error);
    const { refresh } = written;
    if (written.recorded && afterSecretWrite) {
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

  return { getSecretStatus, putSecret };
}

function bad(status, message) {
  return { status, jsonBody: { success: false, error: message } };
}

/** 48 random bytes, base64url. Used only for values this estate invents. */
function defaultRandomSecret() {
  return randomBytes(48).toString('base64url');
}
