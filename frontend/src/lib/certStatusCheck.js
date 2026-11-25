/**
 * The catalogue checks: the stored statuses that their own dates already
 * contradict, and the ones that will within a few days. The data tests run
 * these so a stale row is a red build. Split out of certStatus.js, which
 * re-exports everything here.
 */
import { isIsoDate, isPastDate, todayIso, utcDay } from './certDates.js';
import { CERT_STATUSES } from './certStatusRules.js';

/**
 * Every field on a catalogue row that holds a `YYYY-MM-DD`. This is the one
 * list: `findStaleStatuses` validates each of them, and the catalogue tests
 * import it so a field added to the data cannot be missed by the check —
 * `registrationOpens` (the AWS upcoming rows) was, once (#465 review).
 */
export const CERT_DATE_FIELDS = Object.freeze([
  'expiryDate',
  'betaEndDate',
  'betaStartDate',
  'gaDate',
  'availableDate',
  'registrationOpens',
  'retiredDate',
  'statusReadDate',
]);

/**
 * The stored statuses that contradict their own dates on `today` — the check
 * the data test runs so the next drift is a red build rather than a stale
 * page. Returns one line per offender, empty when the file is consistent.
 * Also names a status outside `CERT_STATUSES`, a dated field that is not
 * `YYYY-MM-DD`, and an `expiring` row with no `expiryDate`, since each of
 * those is a claim `deriveStatus` cannot check.
 *
 * @param {Array<{code?: string, id?: string}>} entries
 * @param {string} today
 * @returns {string[]}
 */
export function findStaleStatuses(entries, today = todayIso()) {
  const problems = [];
  for (const entry of entries || []) {
    const label = entry.code || entry.id || entry.slug || '(unnamed)';
    if (entry.status !== undefined && !CERT_STATUSES.includes(entry.status)) {
      problems.push(`${label}: unknown status '${entry.status}'`);
      continue;
    }
    problems.push(...shapeProblems(entry, label), ...dateProblems(entry, label, today));
  }
  return problems;
}

/**
 * The rows `findStaleStatuses` will name within the next `days` days, and the
 * day each one starts — the early warning for the alarm above (#818).
 *
 * The alarm is a real-clock test, so on the day a stored status goes stale
 * every branch's build goes red until the row is re-verified; #770 was that
 * day for three rows at once. This asks the same question of each day ahead
 * rather than restating the rule, so the warning and the alarm cannot
 * disagree: a row appears here exactly when, and only when, the alarm will
 * fire for it. Rows already stale today are left out — the alarm is red for
 * those already.
 *
 * @param {Array<{code?: string, id?: string}>} entries
 * @param {string} today `YYYY-MM-DD`
 * @param {number} days how far ahead to look, 1 or more
 * @returns {Array<{due: string, problem: string}>} soonest first
 */
export function findStatusesDueWithin(entries, today, days) {
  if (!isIsoDate(today) || !Number.isInteger(days) || days < 1) return [];
  const seen = new Set(findStaleStatuses(entries, today));
  const due = [];
  for (let ahead = 1; ahead <= days; ahead += 1) {
    const day = new Date(utcDay(today) + ahead * 86400000).toISOString().slice(0, 10);
    for (const problem of findStaleStatuses(entries, day)) {
      if (seen.has(problem)) continue;
      seen.add(problem);
      due.push({ due: day, problem });
    }
  }
  return due;
}

/** Fields that are present but not a calendar day, and a dateless `expiring`. */
function shapeProblems(entry, label) {
  const problems = [];
  for (const field of CERT_DATE_FIELDS) {
    const value = entry[field];
    if (value !== undefined && value !== null && !isIsoDate(value)) {
      problems.push(`${label}: ${field} '${value}' is not YYYY-MM-DD`);
    }
  }
  if (
    entry.status === 'expiring' &&
    (entry.expiryDate === undefined || entry.expiryDate === null)
  ) {
    problems.push(`${label}: status 'expiring' but no expiryDate`);
  }
  return problems;
}

/** A stored status that `today` has already moved past. */
function dateProblems(entry, label, today) {
  const problems = [];
  const reached = (iso) => isIsoDate(iso) && isIsoDate(today) && iso <= today;
  switch (entry.status) {
    case 'expiring':
    case 'active':
      if (isPastDate(entry.expiryDate, today)) {
        problems.push(
          `${label}: status '${entry.status}' but expiryDate ${entry.expiryDate} has passed`
        );
      }
      break;
    case 'beta':
      if (isPastDate(entry.betaEndDate, today)) {
        problems.push(`${label}: status 'beta' but betaEndDate ${entry.betaEndDate} has passed`);
      } else if (reached(entry.gaDate)) {
        problems.push(`${label}: status 'beta' but gaDate ${entry.gaDate} has been reached`);
      }
      break;
    case 'upcoming':
      if (reached(entry.availableDate)) {
        problems.push(
          `${label}: status 'upcoming' but availableDate ${entry.availableDate} has been reached`
        );
      }
      break;
    default:
      break;
  }
  return problems;
}
