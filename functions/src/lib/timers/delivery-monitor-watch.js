/**
 * delivery-monitor-watch.js — tells the owner on Telegram when the repository's
 * "Monitor delivery health" check goes red, and again when it is green.
 *
 * That check (.github/workflows/monitor-deploy-drift.yml) fails when a deploy
 * has been waiting too long behind main. Its only voice was GitHub's own
 * failure email, which sat among other mail: it ran red for a day before
 * anyone looked (2026-10-22, the frontend one commit behind).
 *
 * WHY THIS LIVES HERE AND NOT IN THE WORKFLOW. A workflow that posted to
 * Telegram would need the bot token stored a second time, as a GitHub secret.
 * The token already sits in Key Vault for the notifier, and the repository is
 * public, so the run history is readable with no token at all. This reads it
 * the way labs/drift.js reads main's commits: GitHub's public REST API,
 * through the same pinned, redirect-refusing, size-capped fetch, once an hour,
 * from checkAgentHealth (which is armed and already holds the notifier). No
 * new secret, no new timer to arm.
 *
 * THE COST, said plainly. When Azure is down this cannot speak, where a
 * workflow could. GitHub's failure email still goes out in that case, and
 * nothing here replaces it.
 *
 * WHAT IT SAYS, AND WHEN
 *   RED    The newest run that reached a verdict (success, failure or timed
 *          out; cancelled and skipped runs say nothing) failed, and the owner
 *          has not been told about this red stretch. One message, titled
 *          "DELIVERY MONITOR RED", a title no other message uses, naming the
 *          jobs that failed and linking the run. Still red a day after the
 *          last message about it, the same message goes again, marked as a
 *          reminder, so one missed notification does not mean silence for good.
 *   NEW    Still red, and a job is failing that no message in this red
 *          stretch has named yet (#1666). The stretch might have begun with one
 *          finding and a second, unrelated one arrives hours later: the owner
 *          hears of it on the next hourly read, not with the day's reminder.
 *          The jobs named so far are kept with the alert (`alertedJobs`, the
 *          union for the whole stretch), so a job that recovers and fails
 *          again in the same stretch is not news, and a set that shrinks
 *          says nothing.
 *   GREEN  A run succeeded after the owner was told. One "back to green"
 *          message, then the record is cleared.
 *
 * The message carries the run's number and link, built here from the run's
 * integer id, and job names cut to a short plain string: nothing else from
 * GitHub's answer is repeated, so a hostile workflow name cannot write the
 * owner's message.
 *
 * A READ, THEN A WRITE DECIDED FROM IT, so the record is ETag-guarded exactly
 * as labs/drift.js guards its own: a 412 or 409 means another instance wrote
 * first and this one leaves it. Two instances reading at the same moment are
 * unlikely (the timer runs on one instance at a time), and the notifier's own
 * per-source claim refuses a second send within its cooldown; at worst the
 * same alert goes once more an hour later. A send that did not go is
 * not recorded, so the next hourly read tries again. A failed GitHub read is
 * recorded and logged at warn with its code only, never thrown.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { API_ORIGIN, API_PATH_PREFIX, REPO_REF } from '../cms/repo-draft.js';
import {
  GITHUB_FETCH_TIMEOUT_MS,
  MAX_API_BYTES,
  RepoSourceError,
  fetchPinned,
} from '../cms/repo-draft-source.js';
import { errorCode, isAuthoredError, storedFailure } from '../http/error-response.js';
import {
  BLIND_AFTER_READS,
  blindMessage,
  CONTAINER,
  DELIVERY_WATCH_DOC_ID,
  DELIVERY_WATCH_DOC_TYPE,
  FAILED,
  GITHUB_JSON,
  greenMessage,
  HOUR_MS,
  latestVerdictRun,
  MAX_ALERTED_JOBS,
  MAX_JOB_NAMES,
  msOf,
  PK,
  plainName,
  redMessage,
  REMINDER_AFTER_MS,
  RUNS_PER_READ,
  storedJobs,
  WATCH_INTERVAL_MS,
  WATCHED_WORKFLOW,
} from './delivery-monitor-messages.js';

// The fixed names and the messages live in delivery-monitor-messages.js; they
// are exported again here so callers keep importing from this file.
export {
  BLIND_AFTER_READS,
  blindMessage,
  DELIVERY_BLIND_SOURCE,
  DELIVERY_GREEN_SOURCE,
  DELIVERY_RED_SOURCE,
  DELIVERY_WATCH_DOC_ID,
  DELIVERY_WATCH_DOC_TYPE,
  greenMessage,
  latestVerdictRun,
  MAX_ALERTED_JOBS,
  redMessage,
  REMINDER_AFTER_MS,
  RUNS_PER_READ,
  storedJobs,
  WATCH_INTERVAL_MS,
  WATCHED_WORKFLOW,
  WORKFLOW_URL,
} from './delivery-monitor-messages.js';

/**
 * What a failed read stores and shows: a RepoSourceError's `CODE: sentence`,
 * written in this repository, or a fixed sentence for anything else.
 */
function describeReadError(error) {
  const sentence = storedFailure(error, "The delivery monitor's runs could not be read.").slice(0, 300);
  return isAuthoredError(error) && error.code ? `${error.code}: ${sentence}` : sentence;
}

async function getJson(fetchImpl, path, timeoutMs) {
  const bytes = await fetchPinned(fetchImpl, `${API_ORIGIN}${API_PATH_PREFIX}${path}`, {
    accept: GITHUB_JSON,
    maxBytes: MAX_API_BYTES,
    timeoutMs,
  });
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new RepoSourceError('GitHub answered with something that is not JSON.', { code: 'UPSTREAM_SHAPE' });
  }
}

async function latestRun(d) {
  const query = new URLSearchParams({ branch: REPO_REF, status: 'completed', per_page: String(RUNS_PER_READ) });
  const body = await getJson(d.fetchImpl, `actions/workflows/${WATCHED_WORKFLOW}/runs?${query}`, d.timeoutMs);
  if (!Array.isArray(body?.workflow_runs)) {
    throw new RepoSourceError('The run list is not a list.', { code: 'UPSTREAM_SHAPE' });
  }
  return latestVerdictRun(body.workflow_runs);
}

/** The names of the jobs that failed in a run. Best effort: never fails the alert. */
async function failedJobs(d, runId) {
  try {
    const body = await getJson(d.fetchImpl, `actions/runs/${runId}/jobs?per_page=20`, d.timeoutMs);
    const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
    return jobs
      .filter((job) => FAILED.has(job?.conclusion))
      .map((job) => plainName(job?.name))
      .filter(Boolean)
      .slice(0, MAX_JOB_NAMES);
  } catch (error) {
    d.log.warn?.(`[delivery-watch] could not read the failed jobs (${error?.code ?? 'error'}); the alert goes without them`);
    return [];
  }
}

/** True only when the notifier says the message went. Never throws. */
async function say(d, message) {
  if (!d.notifier?.notifyTelegram) return false;
  try {
    const result = await d.notifier.notifyTelegram(message);
    if (result?.sent === true) return true;
    d.log.warn?.(`[delivery-watch] message not sent (${result?.reason || 'no reason given'}); the next hourly read tries again`);
  } catch (error) {
    d.log.warn?.(`[delivery-watch] notification failed (${errorCode(error)}); the next hourly read tries again`);
  }
  return false;
}

/** The alert fields when a red message went now. */
const alertedNow = (run, atMs, jobs) => ({ alertedRunId: run.id, alertedAt: new Date(atMs).toISOString(), alertedJobs: jobs });

/**
 * Already told about this red stretch. Read the jobs on every hourly read,
 * so a job that starts failing is heard of now, not with the reminder.
 */
async function decideStillRed(d, run, current, atMs) {
  const alertedAtMs = msOf(current?.alertedAt);
  const jobs = await failedJobs(d, run.id);
  const known = storedJobs(current?.alertedJobs);
  // The jobs named so far plus today's, newest last, so the cap drops the oldest.
  const seen = [...(known ?? []), ...jobs.filter((name) => !(known ?? []).includes(name))].slice(-MAX_ALERTED_JOBS);
  // A new job goes first, even when the reminder is due on the same read: it
  // leads with the new job and restarts the 24-hour clock, so the reminder
  // waits a day rather than hide the news in its "Failed:" list (Copilot
  // review of #1669). A record from before the jobs were kept names nothing new.
  const added = known === null ? [] : jobs.filter((name) => !known.includes(name));
  if (added.length) {
    return (await say(d, redMessage({ run, jobs, newJobs: added }))) ? alertedNow(run, atMs, seen) : null;
  }
  if (Number.isFinite(alertedAtMs) && atMs - alertedAtMs >= REMINDER_AFTER_MS) {
    const redForHours = Math.floor((atMs - alertedAtMs) / HOUR_MS);
    const sent = await say(d, redMessage({ run, jobs, reminder: true, redForHours }));
    // An old record with an unreadable job list stays "not known" (null),
    // not "known empty", or the next read would call every job new.
    return sent ? alertedNow(run, atMs, known === null && !jobs.length ? null : seen) : null;
  }
  // A record from before the jobs were kept does not know what the owner was
  // told: adopt today's set without a message rather than call every job new.
  // An empty read (the jobs could not be read) adds nothing, so says nothing.
  if (known === null && jobs.length) return { alertedJobs: jobs, quiet: true };
  return null;
}

/**
 * Decide from the newest verdict and the record. Returns the fields to
 * store, or null to leave the alert state as it is. `quiet: true` among
 * them means fields changed but no message went.
 */
async function decide(d, run, current, atMs) {
  const told = Number.isSafeInteger(current?.alertedRunId);
  if (run.conclusion === 'success') {
    if (!told) return null;
    return (await say(d, greenMessage({ run }))) ? { alertedRunId: null, alertedAt: null, alertedJobs: null } : null;
  }
  if (!told) {
    const jobs = await failedJobs(d, run.id);
    return (await say(d, redMessage({ run, jobs }))) ? alertedNow(run, atMs, jobs) : null;
  }
  return decideStillRed(d, run, current, atMs);
}

/**
 * The watch cannot read GitHub, and has not for BLIND_AFTER_READS reads in a
 * row: say so once, because a watch that has stopped reading looks exactly
 * like a monitor that is green (CodeRabbit, #1332). Returns the field to
 * store when the message went, or null (too soon, already said, or not sent:
 * an unsent notice is tried again on the next failed read).
 */
async function tellBlind(d, { current, unread, code, atMs }) {
  if (unread < BLIND_AFTER_READS || current?.blindAlertedAt) return null;
  return (await say(d, blindMessage({ unread, code }))) ? { blindAlertedAt: new Date(atMs).toISOString() } : null;
}

/** The record's fields carried over from the last read, with this attempt's time. */
function baseRecord(current, at) {
  return {
    id: DELIVERY_WATCH_DOC_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    docType: DELIVERY_WATCH_DOC_TYPE,
    workflow: WATCHED_WORKFLOW,
    alertedRunId: current?.alertedRunId ?? null,
    alertedAt: current?.alertedAt ?? null,
    alertedJobs: storedJobs(current?.alertedJobs),
    lastRunId: current?.lastRunId ?? null,
    lastSuccessAt: current?.lastSuccessAt ?? null,
    consecutiveUnread: current?.consecutiveUnread ?? 0,
    blindAlertedAt: current?.blindAlertedAt ?? null,
    lastAttemptAt: at.toISOString(),
  };
}

/** A read that got an answer, whatever the answer: the watch can see. */
const SEEING = Object.freeze({ consecutiveUnread: 0, blindAlertedAt: null });

/** The record and outcome after GitHub answered with a run list. */
async function readRecord(d, base, current, at) {
  const run = await latestRun(d);
  if (!run) {
    return { next: { ...base, ...SEEING, lastError: null, lastVerdict: 'none' }, outcome: { checked: true, verdict: 'none', told: false } };
  }
  const { quiet = false, ...changes } = (await decide(d, run, current, at.getTime())) ?? { quiet: true };
  const next = {
    ...base,
    ...SEEING,
    ...changes,
    lastError: null,
    lastVerdict: run.conclusion === 'success' ? 'green' : 'red',
    lastRunId: run.id,
    lastSuccessAt: at.toISOString(),
  };
  return { next, outcome: { checked: true, verdict: next.lastVerdict, told: !quiet } };
}

/** The record and outcome after a failed GitHub read. */
async function unreadRecord(d, base, current, failure, atMs) {
  const unread = (Number.isSafeInteger(current?.consecutiveUnread) ? current.consecutiveUnread : 0) + 1;
  const code = /^[A-Z_]{2,40}$/.test(String(failure?.code)) ? failure.code : 'error';
  const blind = await tellBlind(d, { current, unread, code, atMs });
  const next = {
    ...base,
    consecutiveUnread: unread,
    ...(blind ?? {}),
    lastError: describeReadError(failure),
    lastVerdict: current?.lastVerdict ?? null,
  };
  d.log.warn?.(`[delivery-watch] the monitor's runs could not be read (${code}); the next hourly read tries again`);
  return { next, outcome: { checked: true, verdict: 'unread', told: blind !== null } };
}

/** Write the record under the ETag it was read with. False when another instance wrote first. */
async function writeRecord(d, current, next) {
  try {
    if (current) await d.store.replaceDocIfMatch(CONTAINER, { ...next, _etag: current._etag }, PK);
    else await d.store.createDoc(CONTAINER, next);
  } catch (error) {
    if (error?.code === 412 || error?.code === 409) return false;
    throw error;
  }
  return true;
}

/**
 * Read the monitor's runs, at most once per WATCH_INTERVAL_MS, and speak if
 * the colour changed. Never throws on a failed GitHub read.
 *
 * @returns {Promise<{ checked: boolean, reason?: string, verdict?: string, told?: boolean }>}
 */
async function checkIfDue(d) {
  const at = d.now();
  const atMs = at.getTime();
  const current = await d.store.readDoc(CONTAINER, DELIVERY_WATCH_DOC_ID, ADMIN_CONFIG_PARTITION);
  const lastAttemptMs = msOf(current?.lastAttemptAt);
  if (Number.isFinite(lastAttemptMs) && atMs - lastAttemptMs < WATCH_INTERVAL_MS) {
    return { checked: false, reason: 'not due' };
  }
  const base = baseRecord(current, at);
  let read;
  try {
    read = await readRecord(d, base, current, at);
  } catch (error) {
    read = await unreadRecord(d, base, current, error, atMs);
  }
  const written = await writeRecord(d, current, read.next);
  return { ...read.outcome, written };
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {{ notifyTelegram: Function }|null} [deps.notifier]
 * @param {typeof fetch} [deps.fetch]
 * @param {() => Date} [deps.now]
 * @param {object} [deps.log]
 * @param {number} [deps.timeoutMs]
 */
export function createDeliveryMonitorWatch({
  store,
  notifier = null,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  log = {},
  timeoutMs = GITHUB_FETCH_TIMEOUT_MS,
}) {
  const d = { store, notifier, fetchImpl, now, log, timeoutMs };
  return { checkIfDue: () => checkIfDue(d) };
}
