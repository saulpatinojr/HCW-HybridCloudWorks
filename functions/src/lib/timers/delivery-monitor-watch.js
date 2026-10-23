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
 *          jobs that failed and linking the run. Still red a day later, the
 *          same message goes again, marked as a reminder, so one missed
 *          notification does not mean silence for good.
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
 * first and this one leaves it. A second instance cannot double-send either:
 * the notifier's own per-source claim refuses it. A send that did not go is
 * not recorded, so the next hourly read tries again. A failed GitHub read is
 * recorded and logged at warn with its code only, never thrown.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { API_ORIGIN, API_PATH_PREFIX, REPO_NAME, REPO_OWNER, REPO_REF } from '../cms/repo-draft.js';
import {
  GITHUB_FETCH_TIMEOUT_MS,
  MAX_API_BYTES,
  RepoSourceError,
  fetchPinned,
} from '../cms/repo-draft-source.js';
import { isAuthoredError, storedFailure } from '../http/error-response.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const DELIVERY_WATCH_DOC_ID = 'delivery_monitor_watch';
export const DELIVERY_WATCH_DOC_TYPE = 'delivery_monitor_watch';
const CONTAINER = 'admin_config';
const PK = { partitionKey: ADMIN_CONFIG_PARTITION };

/** The workflow file this watches, by the name GitHub's runs endpoint takes. */
export const WATCHED_WORKFLOW = 'monitor-deploy-drift.yml';

/** Their own notifier sources, so "red" never holds back the "green" that ends it. */
export const DELIVERY_RED_SOURCE = 'delivery_monitor_red';
export const DELIVERY_GREEN_SOURCE = 'delivery_monitor_green';
export const DELIVERY_BLIND_SOURCE = 'delivery_monitor_blind';

/** Failed reads in a row (about a day of hourly reads) before the owner is told the watch is blind. */
export const BLIND_AFTER_READS = 24;

/** A little under an hour, so a five-minute timer that starts late does not slip to sixty-five. */
export const WATCH_INTERVAL_MS = 55 * MINUTE_MS;

/** Still red this long after the owner was told: say so again. */
export const REMINDER_AFTER_MS = 24 * HOUR_MS;

/** Runs asked for; enough to get past a few cancelled ones to a verdict. */
export const RUNS_PER_READ = 10;
const MAX_JOB_NAME_LENGTH = 80;
const MAX_JOB_NAMES = 5;

const GITHUB_JSON = 'application/vnd.github+json';
const FAILED = new Set(['failure', 'timed_out']);
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

const msOf = (value) => {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return Number.NaN;
  return Date.parse(value);
};

const runUrl = (id) => `https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/runs/${id}`;
export const WORKFLOW_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WATCHED_WORKFLOW}`;

/** A job name as the message carries it: printable, one line, short. */
const plainName = (value) =>
  String(value ?? '')
    .replace(/[^\p{L}\p{N} ?!.,:;'()/_-]/gu, '')
    .trim()
    .slice(0, MAX_JOB_NAME_LENGTH);

/**
 * One run of GitHub's list as this module keeps it, or null when it is not
 * one. The id must be a positive integer: it is spliced into a URL.
 */
function toRun(row) {
  const id = row?.id;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const completedAt = Number.isFinite(msOf(row?.updated_at)) ? new Date(msOf(row.updated_at)).toISOString() : null;
  const number = Number.isSafeInteger(row?.run_number) ? row.run_number : null;
  return { id, number, conclusion: typeof row?.conclusion === 'string' ? row.conclusion : null, completedAt };
}

/** The newest run that reached a verdict, or null. The list is newest first. */
export function latestVerdictRun(rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const run = toRun(row);
    if (run && (run.conclusion === 'success' || FAILED.has(run.conclusion))) return run;
  }
  return null;
}

/** The "red" message. `jobs` are the names of the jobs that failed; may be empty. */
export function redMessage({ run, jobs = [], reminder = false, redForHours = 0 }) {
  const which = jobs.length
    ? `Failed: ${jobs.join('; ')}.`
    : 'GitHub did not say which job failed; the run page does.';
  const lead = reminder
    ? `STILL RED, ${redForHours} hours after the first alert. Nothing has fixed it yet.`
    : 'The "Monitor delivery health" check failed.';
  return {
    title: reminder ? 'DELIVERY MONITOR STILL RED' : 'DELIVERY MONITOR RED',
    message:
      `${lead} It goes red when a deploy has waited too long behind main, or a workflow keeps failing.\n` +
      `${which}\n` +
      `Run${run.number ? ` #${run.number}` : ''}${run.completedAt ? ` finished ${run.completedAt}` : ''}: ${runUrl(run.id)}\n` +
      'The frontend and functions deploys are started by hand and Terraform is confirmed in HCP Terraform, so merging ships none of them. ' +
      'The run page has a table with a red mark on each service that is behind.',
    severity: 'critical',
    source: DELIVERY_RED_SOURCE,
  };
}

/**
 * The "blind" message: the watch has not been able to read GitHub. It carries
 * the count and an error code from this repository's own list (never GitHub's
 * words), and says what still protects the owner meanwhile.
 */
export function blindMessage({ unread, code = 'error' }) {
  return {
    title: 'DELIVERY MONITOR WATCH IS BLIND',
    message:
      `The bot has failed to read the "Monitor delivery health" runs from GitHub ${unread} times in a row (error: ${code}), about ${unread} hours. ` +
      'If that check goes red now, there will be no Telegram message about it. GitHub\'s own failure email still goes out.\n' +
      `Check the runs yourself: ${WORKFLOW_URL}`,
    severity: 'warning',
    source: DELIVERY_BLIND_SOURCE,
  };
}

/** The "green" message that ends a red stretch the owner was told about. */
export function greenMessage({ run }) {
  return {
    title: 'DELIVERY MONITOR back to green',
    message: `The "Monitor delivery health" check passed again${run.completedAt ? ` at ${run.completedAt}` : ''}: ${runUrl(run.id)}`,
    severity: 'info',
    source: DELIVERY_GREEN_SOURCE,
  };
}

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
  async function latestRun() {
    const query = new URLSearchParams({ branch: REPO_REF, status: 'completed', per_page: String(RUNS_PER_READ) });
    const body = await getJson(fetchImpl, `actions/workflows/${WATCHED_WORKFLOW}/runs?${query}`, timeoutMs);
    if (!Array.isArray(body?.workflow_runs)) {
      throw new RepoSourceError('The run list is not a list.', { code: 'UPSTREAM_SHAPE' });
    }
    return latestVerdictRun(body.workflow_runs);
  }

  /** The names of the jobs that failed in a run. Best effort: never fails the alert. */
  async function failedJobs(runId) {
    try {
      const body = await getJson(fetchImpl, `actions/runs/${runId}/jobs?per_page=20`, timeoutMs);
      const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
      return jobs
        .filter((job) => FAILED.has(job?.conclusion))
        .map((job) => plainName(job?.name))
        .filter(Boolean)
        .slice(0, MAX_JOB_NAMES);
    } catch (error) {
      log.warn?.(`[delivery-watch] could not read the failed jobs (${error?.code ?? 'error'}); the alert goes without them`);
      return [];
    }
  }

  /** True only when the notifier says the message went. Never throws. */
  async function say(message) {
    if (!notifier?.notifyTelegram) return false;
    try {
      const result = await notifier.notifyTelegram(message);
      if (result?.sent === true) return true;
      log.warn?.(`[delivery-watch] message not sent (${result?.reason || 'no reason given'}); the next hourly read tries again`);
    } catch (error) {
      log.warn?.(`[delivery-watch] notification failed: ${error?.message || error}`);
    }
    return false;
  }

  /**
   * Decide from the newest verdict and the record. Returns the fields to
   * store, or null to leave the alert state as it is.
   */
  async function decide(run, current, atMs) {
    const alertedAtMs = msOf(current?.alertedAt);
    const told = Number.isSafeInteger(current?.alertedRunId);
    if (run.conclusion === 'success') {
      if (!told) return null;
      return (await say(greenMessage({ run }))) ? { alertedRunId: null, alertedAt: null } : null;
    }
    if (!told) {
      const jobs = await failedJobs(run.id);
      return (await say(redMessage({ run, jobs })))
        ? { alertedRunId: run.id, alertedAt: new Date(atMs).toISOString() }
        : null;
    }
    if (Number.isFinite(alertedAtMs) && atMs - alertedAtMs >= REMINDER_AFTER_MS) {
      const jobs = await failedJobs(run.id);
      const redForHours = Math.floor((atMs - alertedAtMs) / HOUR_MS);
      const sent = await say(redMessage({ run, jobs, reminder: true, redForHours }));
      return sent ? { alertedRunId: run.id, alertedAt: new Date(atMs).toISOString() } : null;
    }
    return null;
  }

  /**
   * The watch cannot read GitHub, and has not for BLIND_AFTER_READS reads in a
   * row: say so once, because a watch that has stopped reading looks exactly
   * like a monitor that is green (CodeRabbit, #1332). Returns the field to
   * store when the message went, or null (too soon, already said, or not sent:
   * an unsent notice is tried again on the next failed read).
   */
  async function tellBlind({ current, unread, code, atMs }) {
    if (unread < BLIND_AFTER_READS || current?.blindAlertedAt) return null;
    return (await say(blindMessage({ unread, code }))) ? { blindAlertedAt: new Date(atMs).toISOString() } : null;
  }

  /**
   * Read the monitor's runs, at most once per WATCH_INTERVAL_MS, and speak if
   * the colour changed. Never throws on a failed GitHub read.
   *
   * @returns {Promise<{ checked: boolean, reason?: string, verdict?: string, told?: boolean }>}
   */
  async function checkIfDue() {
    const at = now();
    const atMs = at.getTime();
    const current = await store.readDoc(CONTAINER, DELIVERY_WATCH_DOC_ID, ADMIN_CONFIG_PARTITION);
    const lastAttemptMs = msOf(current?.lastAttemptAt);
    if (Number.isFinite(lastAttemptMs) && atMs - lastAttemptMs < WATCH_INTERVAL_MS) {
      return { checked: false, reason: 'not due' };
    }

    const base = {
      id: DELIVERY_WATCH_DOC_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      docType: DELIVERY_WATCH_DOC_TYPE,
      workflow: WATCHED_WORKFLOW,
      alertedRunId: current?.alertedRunId ?? null,
      alertedAt: current?.alertedAt ?? null,
      lastRunId: current?.lastRunId ?? null,
      lastSuccessAt: current?.lastSuccessAt ?? null,
      consecutiveUnread: current?.consecutiveUnread ?? 0,
      blindAlertedAt: current?.blindAlertedAt ?? null,
      lastAttemptAt: at.toISOString(),
    };
    // A read that got an answer, whatever the answer: the watch can see.
    const seeing = { consecutiveUnread: 0, blindAlertedAt: null };
    let next;
    let outcome;
    try {
      const run = await latestRun();
      if (!run) {
        next = { ...base, ...seeing, lastError: null, lastVerdict: 'none' };
        outcome = { checked: true, verdict: 'none', told: false };
      } else {
        const changes = await decide(run, current, atMs);
        next = {
          ...base,
          ...seeing,
          ...(changes ?? {}),
          lastError: null,
          lastVerdict: run.conclusion === 'success' ? 'green' : 'red',
          lastRunId: run.id,
          lastSuccessAt: at.toISOString(),
        };
        outcome = { checked: true, verdict: next.lastVerdict, told: changes !== null };
      }
    } catch (error) {
      const unread = (Number.isSafeInteger(current?.consecutiveUnread) ? current.consecutiveUnread : 0) + 1;
      const code = /^[A-Z_]{2,40}$/.test(String(error?.code)) ? error.code : 'error';
      const blind = await tellBlind({ current, unread, code, atMs });
      next = {
        ...base,
        consecutiveUnread: unread,
        ...(blind ?? {}),
        lastError: describeReadError(error),
        lastVerdict: current?.lastVerdict ?? null,
      };
      outcome = { checked: true, verdict: 'unread', told: blind !== null };
      log.warn?.(`[delivery-watch] the monitor's runs could not be read (${code}); the next hourly read tries again`);
    }

    try {
      if (current) await store.replaceDocIfMatch(CONTAINER, { ...next, _etag: current._etag }, PK);
      else await store.createDoc(CONTAINER, next);
    } catch (error) {
      if (error?.code === 412 || error?.code === 409) return { ...outcome, written: false };
      throw error;
    }
    return { ...outcome, written: true };
  }

  return { checkIfDue };
}
