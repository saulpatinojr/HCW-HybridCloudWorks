/**
 * delivery-monitor-messages.js — the fixed names, the reading of GitHub's run
 * list, and the words of the messages for the delivery monitor watch
 * (delivery-monitor-watch.js, which says why and exports all of this again).
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { REPO_NAME, REPO_OWNER } from '../cms/repo-draft.js';

const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;

export const DELIVERY_WATCH_DOC_ID = 'delivery_monitor_watch';
export const DELIVERY_WATCH_DOC_TYPE = 'delivery_monitor_watch';
export const CONTAINER = 'admin_config';
export const PK = { partitionKey: ADMIN_CONFIG_PARTITION };

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
export const MAX_JOB_NAMES = 5;
/** Job names kept with one alert. The monitor has a handful of jobs; this only bounds the record. */
export const MAX_ALERTED_JOBS = 20;

export const GITHUB_JSON = 'application/vnd.github+json';
export const FAILED = new Set(['failure', 'timed_out']);
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

export const msOf = (value) => {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return Number.NaN;
  return Date.parse(value);
};

const runUrl = (id) => `https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/runs/${id}`;
export const WORKFLOW_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WATCHED_WORKFLOW}`;

/** A job name as the message carries it: printable, one line, short. */
export const plainName = (value) =>
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

/**
 * The job names stored with an alert, or null when the record has none (one
 * written before #1666): null means "not known", which is not the same as an
 * empty list.
 */
export function storedJobs(value) {
  if (!Array.isArray(value)) return null;
  // Keep the newest, as the union in decide() does.
  return value.filter((name) => typeof name === 'string' && name).slice(-MAX_ALERTED_JOBS);
}

/**
 * The "red" message. `jobs` are the names of the jobs that failed; may be
 * empty. `newJobs`, when given, are the ones no earlier message in this red
 * stretch named.
 */
export function redMessage({ run, jobs = [], newJobs = [], reminder = false, redForHours = 0 }) {
  const which = jobs.length
    ? `Failed: ${jobs.join('; ')}.`
    : 'GitHub did not say which job failed; the run page does.';
  let lead = 'The "Monitor delivery health" check failed.';
  if (reminder) lead = `STILL RED, ${redForHours} hours after the last alert. Nothing has fixed it yet.`;
  else if (newJobs.length) {
    lead = `The "Monitor delivery health" check is still red, and another job has now failed too: ${newJobs.join('; ')}.`;
  }
  return {
    title: reminder ? 'DELIVERY MONITOR STILL RED' : 'DELIVERY MONITOR RED',
    message:
      `${lead} It goes red when a deploy has waited too long behind main, or a workflow keeps failing.\n` +
      `${which}\n` +
      `Run${run.number ? ` #${run.number}` : ''}${run.completedAt ? ` finished ${run.completedAt}` : ''}: ${runUrl(run.id)}\n` +
      'A merge that changes frontend/ deploys the site on its own; the functions deploy is started by hand, and Terraform is confirmed in HCP Terraform. ' +
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

