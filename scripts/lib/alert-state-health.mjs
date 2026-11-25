/** What a log search rule's Resource Health says about whether it can run (verify-alert-state.mjs). */
import { redact } from './plan-report.mjs';

/** Minutes in an ISO 8601 duration such as PT15M, PT1H or P1D; null when it is not one. */
export function durationMinutes(text) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(text ?? ''));
  if (!m || text === 'P' || text === 'PT') return null;
  const [days, hours, minutes, seconds] = m.slice(1).map((part) => Number(part ?? 0));
  return days * 1440 + hours * 60 + minutes + seconds / 60;
}

/**
 * The longest evaluation frequency Resource Health reports on, in minutes.
 * Microsoft's "Monitor the health of log search alert rules": health is
 * "supported only for rules with a frequency of 15 minutes or lower", and a
 * less frequent rule reads Unknown, or, the same page also says,
 * "Unavailable for unknown reason". Measured on 2026-10-15: both daily Cosmos
 * export rules read `Unknown`.
 */
export const HEALTH_MAX_FREQUENCY_MINUTES = 15;

/**
 * Titles that carry no reason, which a rule beyond that frequency is given:
 * "Unknown", "Unknown reason", "Unavailable for unknown reason", "Degraded
 * due to unknown reason" (the titles that page lists).
 */
const REASONLESS_TITLE = /^(?:\w+\s+(?:for|due to)\s+(?:an\s+)?)?unknown(?:\s+reason)?$/i;

/**
 * What one rule's Resource Health means for its verdict.
 *
 * @returns {{shown: string, problem: [string, string]|null, note: string|null}}
 *   `shown` for the report's Health column; `problem` a failing [state,
 *   text]; `note` a non-failing remark.
 */
export function healthVerdict(health, found, subscription) {
  if (!health || health.status !== 'ok') {
    return { shown: 'unread', problem: ['HEALTH UNREADABLE', healthUnreadReason(health, subscription)], note: null };
  }
  const state = health.state;
  const title = redact(String(health.title ?? '')).slice(0, 120);
  const summary = redact(String(health.summary ?? '')).slice(0, 200);
  const frequency = durationMinutes(found?.evaluationFrequency);
  const reported = frequency === null || frequency <= HEALTH_MAX_FREQUENCY_MINUTES;
  if (state === 'Available') return { shown: 'Available', problem: null, note: null };
  if (state === 'Unknown') return { shown: 'Unknown', problem: null, note: unknownHealthNote(title, reported) };
  if (state === 'Unavailable' || state === 'Degraded') return unhealthyVerdict({ state, title, summary, reported });
  return {
    shown: 'unread',
    problem: ['HEALTH UNREADABLE', `Resource Health answered with an availabilityState this check does not know: ${redact(String(state)).slice(0, 40)}`],
    note: null,
  };
}

/** The remark for an Unknown state: its title, or why a rule evaluated less often reads Unknown. */
function unknownHealthNote(title, reported) {
  if (!reported) {
    return `Resource Health: Unknown, as Microsoft documents for a rule evaluated less often than every ${HEALTH_MAX_FREQUENCY_MINUTES} minutes`;
  }
  return `Resource Health: Unknown${title && title !== 'Unknown' ? ` (${title})` : ''}`;
}

/**
 * Unavailable or Degraded: a finding, unless the rule is evaluated less often
 * than Resource Health reports on and the title gives no reason.
 */
function unhealthyVerdict({ state, title, summary, reported }) {
  if (!reported && (!title || REASONLESS_TITLE.test(title))) {
    return {
      shown: state,
      problem: null,
      note:
        `Resource Health: ${state}${title ? `, "${title}"` : ''}, which Microsoft documents for a rule evaluated less ` +
        `often than every ${HEALTH_MAX_FREQUENCY_MINUTES} minutes; not a finding`,
    };
  }
  const text = `${title || state} (Resource Health: ${state})${summary ? `. ${summary}` : ''}`;
  return { shown: state, problem: ['UNHEALTHY', text], note: null };
}

/** Why a rule's Resource Health could not be read, in words the owner can act on. */
function healthUnreadReason(read, subscription) {
  const where = '"Resource Health" in docs/runbooks/alerting-and-support.md';
  const reason = read?.reason ?? 'not read';
  if (read?.status === 'not-registered') {
    return (
      `Resource Health could not be read: the Microsoft.ResourceHealth provider is not registered in ${subscription}, ` +
      `so whether this rule can evaluate is unknown, not healthy. The owner registers it once (${where}). (${reason})`
    );
  }
  if (read?.status === 'denied' || read?.status === 'unauthenticated') {
    return (
      'Resource Health could not be read: this identity may not read it. HCW Alert Rule Reader carries ' +
      `Microsoft.ResourceHealth/availabilityStatuses/read once the owner updates the role (${where}). (${reason})`
    );
  }
  return `Resource Health could not be read, so whether this rule can evaluate is unknown. (${reason})`;
}
