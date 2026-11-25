/**
 * secret-state.js — the per-secret state behind the Keys tab's lights: which
 * light a secret shows, what the page may see of it, and the conditional
 * writes to the one `admin_config` document that records writes and
 * verdicts. Split out of admin-secrets.js, which re-exports these names so
 * callers and tests import what they always did.
 */
import { ADMIN_CONFIG_PARTITION } from './cosmos-client.js';
import { isUnresolvedReference } from './secrets-health.js';
import { findBySecretName, isGeneratable } from './secret-catalog.js';

/** The single `admin_config` document holding per-secret state. */
export const SECRET_STATE_DOC_ID = 'secret_state';

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

export async function readState(store) {
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
