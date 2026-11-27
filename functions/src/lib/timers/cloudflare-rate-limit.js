/**
 * cloudflare-rate-limit.js — `checkCloudflareRateLimit`, daily at 12:40 UTC
 * (#1918): is the API rate limit rule still on?
 *
 * The rule lives only in Cloudflare (#1903), and the Health page's probe for
 * it (#1909) checks only when someone opens the page and presses Test. This
 * is the same check on a clock, so a rule deleted or switched off in the
 * Cloudflare dashboard on a Saturday is heard of within a day.
 *
 * EACH RUN
 *   1. Reads the site zone's `http_ratelimit` phase with the admin token
 *      (the Cloudflare page's own client, read only) and judges it with the
 *      rule the browser uses (cloudflare/rate-limit.js). No token or zone id
 *      yet is "not checked", grey, and says nothing on Telegram.
 *   2. Records the answer as the Health card's result
 *      (health/probe-results.js, `checkedBy: 'timer'`), so the card shows the
 *      daily answer and, through `statusSince`, how long it has held.
 *   3. Speaks on Telegram only when the answer crosses the line: once when it
 *      goes amber (rule off) or red (Cloudflare refused or did not answer)
 *      from anything else, once more if it moves from one of those to the
 *      other, and once when it is green again after that. Nothing while it
 *      stays the same. A failed read has the status the browser's probe gives
 *      the same failure (health/status-model.js classifyFailure: offline for
 *      a gateway status or an unreachable server, critical otherwise). What the owner was last told is kept
 *      in its own document (`cloudflare_rate_limit_watch`), not read from the
 *      Health card, because a Test pressed on the Health page rewrites the
 *      card and must not make the timer say the same thing twice.
 *
 * The watch document is written read, decide, write-if-unchanged, as the
 * delivery monitor's is (delivery-monitor-watch.js): replaced under the ETag
 * it was read with, or created when there was none, and a 412 or 409 means
 * another run wrote first, so this one leaves it. The message goes before
 * the write, and a message that did not go is not recorded, so the next day
 * tries again. Two runs at once are unlikely (a daily timer), and the
 * notifier's per-source cooldown refuses a second send within 15 minutes.
 *
 * A Cloudflare refusal is a RESULT, not a failure of the timer: the run
 * records it, says it once and succeeds. The timer throws only when it cannot
 * run at all (Cosmos refusing the Health result), so the host and
 * alert-timer-overdue see that.
 *
 * Log lines are content-free: the timer's name, a state word and an error
 * code, never a rule, an expression, a zone id or the token.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { authoredMessage, errorCode, isAuthoredError } from '../http/error-response.js';
import { notConfiguredMessage } from '../cloudflare/prerequisites.js';
import {
  RATE_LIMIT_PHASE,
  RATE_LIMIT_PROBE_ID,
  failedVerdict,
  notCheckedVerdict,
  rateLimitVerdict,
} from '../cloudflare/rate-limit.js';
import { healthProbe } from '../health/probe-catalogue.js';
import { classifyFailure } from '../health/status-model.js';
import { MAX_SUMMARY_LENGTH, recordProbeResult } from '../health/probe-results.js';

export const TIMER_NAME = 'checkCloudflareRateLimit';
/** The notifier source for both messages: its cooldown is per source. */
export const RATE_LIMIT_SOURCE = 'cloudflare-rate-limit';
export const WATCH_DOC_ID = 'cloudflare_rate_limit_watch';
export const WATCH_DOC_TYPE = 'cloudflare_rate_limit_watch';
const CONTAINER = 'admin_config';
const PK = { partitionKey: ADMIN_CONFIG_PARTITION };

export const RULES_PAGE = 'https://hybridcloudworks.com/admin/cloudflare?tab=rules';
export const HEALTH_PAGE = 'https://hybridcloudworks.com/admin/health';
export const RUNBOOK_PART_4 =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/cloudflare-admin.md#part-4-making-the-api-rate-limit-rule';

/** What the Cloudflare page's route answers for a failure that is not Cloudflare's (handlers.js answerError). */
const ROUTE_FAILED = 'The Cloudflare request failed.';
const ROUTE_FAILURE = Object.freeze({ status: 500, message: ROUTE_FAILED });

/** Statuses the owner is told about: amber and red. */
const ALARMING = new Set(['degraded', 'critical', 'offline']);

/** The verdict for this run. Never throws: a failed read is a verdict too. */
async function judge(d) {
  try {
    const { client, missing } = d.connect();
    if (!client) return notCheckedVerdict(notConfiguredMessage(missing));
    return rateLimitVerdict({ ruleset: await client.getPhase(RATE_LIMIT_PHASE) });
  } catch (error) {
    d.log.warn?.(`[${TIMER_NAME}] the rate limiting phase could not be read (${errorCode(error)})`);
    // The sentence and the status the browser's probe would show for the same
    // failure: a CloudflareError carries the status the Cloudflare page's
    // route answers with (502 when Cloudflare could not be reached or refused
    // the token, which the browser reads as offline), and anything else is the
    // route's 500 "The Cloudflare request failed." (critical).
    const failure = isAuthoredError(error) ? error : ROUTE_FAILURE;
    return failedVerdict(authoredMessage(error, ROUTE_FAILED), classifyFailure(failure));
  }
}

/** The verdict as the Health card's stored result, under the probe's own id. */
function recordResult(d, verdict, durationMs) {
  const entry = healthProbe(RATE_LIMIT_PROBE_ID);
  return recordProbeResult(d.store, {
    probeId: RATE_LIMIT_PROBE_ID,
    kind: entry.kind,
    writeRole: entry.writeRole,
    status: verdict.status,
    summary: verdict.sentence.slice(0, MAX_SUMMARY_LENGTH),
    detail: null,
    durationMs,
    checkedAt: d.now().toISOString(),
    checkedBy: 'timer',
    recordedBy: TIMER_NAME,
  });
}

/** The alarm message: amber (rule off) or red (could not read). */
function alarmMessage(verdict) {
  const off = verdict.state === 'off';
  return {
    title: off ? 'Cloudflare API rate limit is off' : 'Cloudflare API rate limit could not be checked',
    severity: off ? 'warning' : 'critical',
    source: RATE_LIMIT_SOURCE,
    message: off
      ? `${verdict.sentence} Make the rule, or switch it back on, on the Cloudflare page's Rules tab: ${RULES_PAGE} (the values are in Part 4 of the runbook: ${RUNBOOK_PART_4}). Nothing more is said while it stays off.`
      : `${verdict.sentence} The daily check could not tell whether the rule is on. The Health page shows the answer: ${HEALTH_PAGE}. Nothing more is said until the rule reads as on again.`,
  };
}

const recoveredMessage = (verdict) => ({
  title: 'Cloudflare API rate limit is on again',
  severity: 'info',
  source: RATE_LIMIT_SOURCE,
  message: `${verdict.sentence} The daily check reads the rule as on again.`,
});

/**
 * What to say and what to remember, or null when nothing changes for the
 * owner. The kind of alarm the owner was told about is kept (`state`: off or
 * failed), so a rule that was off and now cannot be read, or the other way
 * round, is said once more; the same kind again says nothing.
 */
export function nextStep(verdict, current) {
  const told = current?.alerted === true;
  if (ALARMING.has(verdict.status) && !(told && current.state === verdict.state)) {
    return { alerted: true, alert: alarmMessage(verdict) };
  }
  if (verdict.status === 'healthy' && told) return { alerted: false, alert: recoveredMessage(verdict) };
  return null;
}

/** True only when the notifier says the message went. Never throws. */
async function sent(d, alert) {
  try {
    const result = await d.notifier?.notifyTelegram?.(alert);
    if (result?.sent === true) return true;
    d.log.warn?.(`[${TIMER_NAME}] message not sent (${result?.reason || 'no notifier'}); the next run tries again`);
  } catch (error) {
    d.log.warn?.(`[${TIMER_NAME}] notification failed (${errorCode(error)}); the next run tries again`);
  }
  return false;
}

/** Write what the owner was told, under the ETag it was read with. False when another run wrote first. */
async function writeWatch(d, current, fields) {
  const next = {
    id: WATCH_DOC_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    docType: WATCH_DOC_TYPE,
    ...fields,
  };
  try {
    if (current) await d.store.replaceDocIfMatch(CONTAINER, { ...next, _etag: current._etag }, PK);
    else await d.store.createDoc(CONTAINER, next);
    return true;
  } catch (error) {
    if (error?.code === 412 || error?.code === 409) return false;
    throw error;
  }
}

/** Tell the owner when the answer crossed the line, and remember that it did. */
async function tellIfChanged(d, verdict) {
  const current = await d.store.readDoc(CONTAINER, WATCH_DOC_ID, ADMIN_CONFIG_PARTITION);
  const step = nextStep(verdict, current);
  if (!step) return { told: false };
  if (!(await sent(d, step.alert))) return { told: false };
  const fields = { alerted: step.alerted, state: verdict.state, changedAt: d.now().toISOString() };
  const written = await writeWatch(d, current, fields);
  if (!written) d.log.warn?.(`[${TIMER_NAME}] another run recorded the alert first; left as it is`);
  return { told: true, written };
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {() => { client: { getPhase: Function }|null, missing: string[] }} deps.connect
 *   the site zone's Cloudflare client (cloudflare/handlers.js siteZoneClient)
 * @param {{ notifyTelegram: Function }|null} [deps.notifier]
 * @param {object} [deps.log] the invocation context
 * @param {() => Date} [deps.now]
 * @param {() => number} [deps.clock] milliseconds, for the duration
 */
export function createRateLimitWatch({ store, connect, notifier = null, log = {}, now = () => new Date(), clock = Date.now }) {
  const d = { store, connect, notifier, log, now };
  async function run() {
    const started = clock();
    const verdict = await judge(d);
    const { written: recorded } = await recordResult(d, verdict, Math.max(0, clock() - started));
    const { told } = await tellIfChanged(d, verdict);
    return { state: verdict.state, status: verdict.status, recorded, told };
  }
  return { run };
}
