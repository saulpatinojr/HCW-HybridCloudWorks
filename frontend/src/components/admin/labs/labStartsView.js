/**
 * What the Labs hub Dashboard's "Lab sessions started" card says (the read is
 * `cms/labs/starts`, functions/src/lib/labs/lab-starts.js).
 *
 * The numbers are the server's; this file only turns them into words. Two rules
 * decide the wording, both written down because a report or letter will quote it:
 *
 *   - It counts SESSIONS, not people. The counter keeps no identifier, so a
 *     person who starts two sessions counts twice, and the sentence for a
 *     letter says "lab sessions", never "learners".
 *   - It says where the count begins. There is no earlier record to count from
 *     (the visitor session records are deleted about two hours after their last update), so the
 *     sentence names the first day counted and says nothing earlier is in it.
 *
 * The sentence names no vendor, host or product: it is meant to be pasted into
 * a letter to a third party.
 */
import { labById } from '@/data/labs/catalogue';

export const LAB_STARTS_ROUTE = 'cms/labs/starts';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026-10-26` as `26 October 2026`; '' for anything that is not a day. */
export function formatDay(day) {
  const match = typeof day === 'string' ? day.match(DAY) : null;
  if (!match) return '';
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : '';
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const COUNT_KEYS = ['today', 'last7', 'last30', 'total'];

/** The read when it has the shape the card relies on; otherwise null. */
export function readLabStarts(read) {
  const counts = read?.counts;
  if (!formatDay(read?.since) || !formatDay(read?.today) || !counts) return null;
  if (!COUNT_KEYS.every((key) => isCount(counts[key]))) return null;
  const perLab = Array.isArray(read.perLab) ? read.perLab : [];
  return { since: read.since, today: read.today, counts, perLab };
}

/** A lab's title from the catalogue, else its id (a lab since removed from the list). */
export function labTitle(labId) {
  return labById(labId)?.title ?? labId;
}

const sessions = (n) => (n === 1 ? 'lab session' : 'lab sessions');

/** The first clause: how many sessions, and how many of them were recent. */
function startedClause(counts) {
  if (counts.total === 0) {
    return 'no lab sessions were started for visitors through the Hybrid Cloud Works website';
  }
  const verb = counts.total === 1 ? 'was' : 'were';
  return (
    `${counts.total} ${sessions(counts.total)} ${verb} started for visitors through the ` +
    `Hybrid Cloud Works website, ${counts.last7} of them in the last 7 days and ` +
    `${counts.last30} in the last 30 days`
  );
}

/**
 * The sentence for a letter: plain words, the real numbers and the date range.
 * Returns '' when the read cannot be trusted, so a button never copies a guess.
 */
export function letterSentence(read) {
  const view = readLabStarts(read);
  if (!view) return '';
  const { since, today, counts } = view;
  const sinceText = formatDay(since);
  const range = since === today ? `On ${sinceText}` : `From ${sinceText} to ${formatDay(today)}`;
  return (
    `${range}, ${startedClause(counts)}. ` +
    `Counting began on ${sinceText}, so nothing earlier is included. ` +
    `Each new visitor lab session is counted once; the count is of sessions, not of people, ` +
    `so a person who starts two sessions is counted twice. Days are UTC days.`
  );
}

const rowIsUsable = (row) =>
  typeof row?.labId === 'string' && COUNT_KEYS.every((key) => isCount(row[key]));

/**
 * The card's view of one answer, or null when the answer is not usable.
 *
 * @returns {null | {
 *   sinceText: string, todayText: string,
 *   stats: { id: string, label: string, value: number }[],
 *   rows: { labId: string, title: string, today: number, last7: number, last30: number, total: number }[],
 *   sentence: string,
 * }}
 */
export function describeLabStarts(read) {
  const view = readLabStarts(read);
  if (!view) return null;
  const { counts } = view;
  return {
    sinceText: formatDay(view.since),
    todayText: formatDay(view.today),
    stats: [
      { id: 'today', label: 'Today', value: counts.today },
      { id: 'last7', label: 'Last 7 days', value: counts.last7 },
      { id: 'last30', label: 'Last 30 days', value: counts.last30 },
      { id: 'total', label: 'Total', value: counts.total },
    ],
    rows: view.perLab.filter(rowIsUsable).map((row) => ({
      labId: row.labId,
      title: labTitle(row.labId),
      today: row.today,
      last7: row.last7,
      last30: row.last30,
      total: row.total,
    })),
    sentence: letterSentence(read),
  };
}
