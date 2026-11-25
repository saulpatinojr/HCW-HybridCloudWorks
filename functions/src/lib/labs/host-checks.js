/**
 * host-checks.js — what the lab host's own checks saw, one document for all
 * of them (2026-10-19, #1282).
 *
 * The first is `portainer`: hcw-portainer-check (lab-host/ansible/roles/
 * portainer) reads Portainer on the host's loopback every fifteen minutes
 * with the owner's access token and sends what it saw through the lab
 * agent's credential, exactly as the Coder upkeep sends its daily report
 * (coder-automation.js): POST /api/agent/reportHostCheck, guarded by
 * `requireAgent`, called through vps-agent/bin/report-host-check.js. The
 * Health Hub's Portainer card and the Labs snapshot read the document
 * (lab-checks.js portainerVerdict), and the pulse records that verdict every
 * five minutes (health/pulse.js), so the card has a value while nobody is
 * looking.
 *
 * ===========================================================================
 * POST /api/agent/reportHostCheck (lib/lab-agent.js composes it)
 * ===========================================================================
 *   { agentId, check: 'portainer', report: { checkedAt, up, version?,
 *     edition?, licenseValid, licenseExpiresAt, environmentName,
 *     environmentUp, containers: { total, running, unhealthy, restarting,
 *     exited }, imagesChecked, imagesOutdated, error } }
 *
 * BOUNDED, NOT NAMELESS. The report is a closed set of counts, states, a
 * version and an environment name, and three bounded strings: `version`
 * (a version's characters only), `environmentName` (64 printable
 * characters) and `error` (300 printable characters, the host's own
 * sentence about what failed, which the card shows). No container name,
 * image name or digest has a field of its own, but an active agent can put
 * 300 characters of text on the card through `error`; that is the accepted
 * blast radius of an agent credential, admin-visible and reversible by
 * deactivating the agent. Control characters and line breaks are refused
 * everywhere, so no field can forge a second line. An unknown key anywhere,
 * a wrong type, a negative count, counts that contradict each other
 * (`running` above `total`, `imagesOutdated` above `imagesChecked`), a date
 * that is not one or a string too long is a 400 with a sentence that names
 * the field and the rule, never the value or the key the caller sent (it
 * came from outside), before any store call. Validation runs after the
 * guard, so a caller without a credential learns nothing about the shape.
 * The entry records the agent the guard verified (`agentId`, from the
 * registry, never the body's raw value), so a second active agent can never
 * replace this host's evidence unnoticed.
 *
 * THE HOST'S CLOCK IS CHECKED, NOT TRUSTED, on both sides (the rule
 * coder-automation.js applies to the future alone). `checkedAt` more than
 * MAX_CLOCK_SKEW_MS ahead of the site's clock is a host clock that is fast;
 * more than that behind it is a reading that is stale, or a clock that is
 * slow, and either way it is refused, because the verdict judges freshness
 * by `receivedAt`, the site's own time of receipt, and a late delivery of an
 * old reading would otherwise look current.
 *
 * ===========================================================================
 * ONE DOCUMENT: admin_config/host_checks
 * ===========================================================================
 *   { id: 'host_checks', configScope: 'admin_config', docType: 'host_checks',
 *     checks: { portainer: { ...the report, receivedAt } } }
 *
 * One entry per check, replaced whole by each report of that check and kept
 * whole for the others, under the document's ETag: `createDoc` for the first
 * report, `replaceDocIfMatch` after, retried on 409 and 412 as
 * coder-automation.js does and for as many attempts (REPORT_WRITE_ATTEMPTS).
 *
 * NO AUDIT ROW. The report arrives every fifteen minutes, from a machine,
 * and changes nothing but its own document; admin_audit_logs records what
 * owners and editors do, and the one machine action that stores a secret
 * (the Coder token's rotation, coder-automation.js). Ninety-six rows a day
 * saying "the host reported" would bury the rows that matter.
 *
 * TELEMETRY is content-free (.github/pull_request_template.md): a warning or
 * error line names what happened and a code, never a value from the report,
 * the agent's id or a document id.
 */

import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { REPORT_WRITE_ATTEMPTS } from './coder-automation.js';
import { parsePortainerReport } from './portainer-report.js';

export {
  CONTAINER_COUNT_FIELDS,
  CONTROL_CHARACTERS,
  MAX_ENVIRONMENT_NAME_LENGTH,
  MAX_ERROR_LENGTH,
  MAX_VERSION_LENGTH,
  PORTAINER_EDITIONS,
  PORTAINER_OPTIONAL_FIELDS,
  PORTAINER_REPORT_FIELDS,
  VERSION_SHAPE,
} from './portainer-report.js';

export const HOST_CHECKS_DOC_ID = 'host_checks';
export const HOST_CHECKS_DOC_TYPE = 'host_checks';

/** The checks this route records, by the name the body's `check` carries. */
export const HOST_CHECK_IDS = Object.freeze(['portainer']);

/** The body's keys. Anything else is refused. */
export const BODY_FIELDS = Object.freeze(['agentId', 'check', 'report']);

const CONTAINER = 'admin_config';
const PK = { partitionKey: ADMIN_CONFIG_PARTITION };

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ok = (value) => ({ value });
const refuse = (error) => ({ error });

/** Why the body is not a host check report this route reads (before the report is checked), or null. */
function bodyShapeRefusal(body) {
  if (!isPlainObject(body)) return 'The body must be a JSON object';
  if (Object.keys(body).some((key) => !BODY_FIELDS.includes(key))) {
    return `The body carries a field this route does not read: it holds ${BODY_FIELDS.join(', ')} only`;
  }
  if (typeof body.check !== 'string' || !HOST_CHECK_IDS.includes(body.check)) {
    return `check must name a host check this route records: ${HOST_CHECK_IDS.join(', ')}`;
  }
  return body.report === undefined ? 'report is required' : null;
}

/**
 * The body, checked: `{ value: { check, report } }` or `{ error }`, the error
 * a sentence for the 400 that names a field of this contract and never a
 * value or a key the caller sent. Pure given `nowMs`, the site's clock.
 */
export function parseHostCheckBody(body, nowMs = Date.now()) {
  const shape = bodyShapeRefusal(body);
  if (shape) return refuse(shape);
  const parsed = parsePortainerReport(body.report, nowMs);
  if (parsed.error) return parsed;
  return ok({ check: body.check, report: parsed.value });
}

/**
 * The document after this report: the other checks' entries as stored, this
 * check's replaced whole. Built from named fields only, so a stray field on
 * the stored document, or a check this version does not know, is dropped
 * rather than carried.
 */
export function mergeHostCheck(current, check, entry) {
  const checks = {};
  for (const id of HOST_CHECK_IDS) {
    if (isPlainObject(current?.checks?.[id])) checks[id] = current.checks[id];
  }
  checks[check] = entry;
  return {
    id: HOST_CHECKS_DOC_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    docType: HOST_CHECKS_DOC_TYPE,
    checks,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replace the document under the ETag of the read, or create it when the read found none. */
const writeHostChecks = (store, current, next) =>
  current
    ? store.replaceDocIfMatch(CONTAINER, { ...next, _etag: current._etag }, PK)
    : store.createDoc(CONTAINER, next);

/**
 * Record one check's report: read → merge → write-if-unchanged, retried
 * while another writer gets there first, the loop coder-automation.js's
 * recordAutomationReport runs. `createDoc` for the first report, so two
 * first reports racing have a loser that reads again; `replaceDocIfMatch`
 * after that. Resolves to the stored document; throws with
 * `code: 'CONFLICT'` when every attempt lost.
 *
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} store
 * @param {{ check: string, report: object }} parsed parseHostCheckBody's value
 * @param {number} nowMs the site's clock, stamped on the entry as `receivedAt`
 * @param {object} [options]
 * @param {string} [options.agentId] the agent the guard verified, stamped on
 *        the entry so the card's evidence names the host that gave it
 */
export async function recordHostCheck(
  store,
  { check, report },
  nowMs,
  { agentId = null, attempts = REPORT_WRITE_ATTEMPTS, sleep = defaultSleep } = {}
) {
  const entry = { ...report, agentId, receivedAt: new Date(nowMs).toISOString() };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(20 * 2 ** Math.min(attempt, 5) + Math.random() * 20);
    const current = await store.readDoc(CONTAINER, HOST_CHECKS_DOC_ID, ADMIN_CONFIG_PARTITION);
    const next = mergeHostCheck(current, check, entry);
    try {
      return await writeHostChecks(store, current, next);
    } catch (error) {
      // 412: replaced since our read. 409: created since our read found
      // nothing. Either way, read again and merge again.
      if (error?.code !== 412 && error?.code !== 409) throw error;
    }
  }
  throw Object.assign(new Error('The host check report kept changing while it was written'), {
    code: 'CONFLICT',
  });
}

/**
 * The agent's report, after `requireAgent` has bound the body to an agent
 * (lib/lab-agent.js). Separate from the HTTP shape so lab-agent.js owns the
 * guard order, as it does for its other handlers. The agent's identity IS
 * written, from the guard's registry record and never from the body: the
 * registry holds one agent per host today, and when a second one is active
 * (a rehearsal host, a stolen credential) the entry says which host spoke
 * instead of letting the last writer win unnoticed.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {() => Date} [deps.now]
 */
export function createHostCheckRecorder({ store, now = () => new Date() }) {
  return async function reportHostCheck({ body, agent }, context) {
    const received = now();
    const parsed = parseHostCheckBody(body, received.getTime());
    if (parsed.error) return json(400, { ok: false, error: parsed.error });
    try {
      await recordHostCheck(store, parsed.value, received.getTime(), { agentId: agent?.agentId ?? null });
    } catch (error) {
      context.error?.(`reportHostCheck: the report could not be recorded (${error?.code ?? 'error'})`);
      return json(500, { ok: false, error: 'The report could not be recorded' });
    }
    return json(200, { ok: true });
  };
}
