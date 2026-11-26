/**
 * upkeep.js — how a held membership stands against its program's upkeep
 * rule (for example, "at least 2 pieces every quarter"), on the server.
 *
 * WHY HERE. Until #1886 this was worked out only in the browser
 * (frontend/src/components/admin/ambassador/ambassadorModel.js), so nothing
 * could remind the owner of an activity requirement not yet met: the
 * Dashboard's waiting list and
 * the Telegram reminders run on the server. The browser keeps its copy for the
 * cards; frontend/src/components/admin/ambassador/upkeepMirror.test.js runs
 * both on the same inputs and fails when they disagree.
 *
 * Pure: no I/O, every date a YYYY-MM-DD string in UTC.
 */
import { UPKEEP_PERIODS } from "./model.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

/** Whole days from `today` to `day` (both YYYY-MM-DD), or null. */
export function daysUntil(day, today) {
  if (!day || !today) return null;
  const parse = (iso) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(day) - parse(today)) / DAY_MS);
}

/**
 * The calendar quarter or year holding `day`, as the days it spans and its
 * name: `{ start: '2026-10-01', end: '2026-12-31', label: 'Q4 2026' }`.
 * `offset` -1 is the period before it.
 */
export function upkeepWindow(day, period, offset = 0) {
  const year = Number(String(day).slice(0, 4));
  if (period === "year") {
    const y = year + offset;
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
  }
  const month = Number(String(day).slice(5, 7));
  const index = year * 4 + Math.floor((month - 1) / 3) + offset;
  const y = Math.floor(index / 4);
  const quarter = index - y * 4;
  const first = quarter * 3 + 1;
  const last = first + 2;
  const lastDay = new Date(Date.UTC(y, last, 0)).getUTCDate();
  return {
    start: `${y}-${pad(first)}-01`,
    end: `${y}-${pad(last)}-${pad(lastDay)}`,
    label: `Q${quarter + 1} ${y}`,
  };
}

/**
 * How the current period stands: the evidence filed under this program by
 * name and dated inside it, against the rule's count. General evidence
 * (filed under no program) is not counted: it says nothing about this
 * program. Null when the program has no rule.
 *
 * The browser's copy (ambassadorModel.js) also tallies the period before and
 * carries the rule's note, for the cards; the server needs neither, so it
 * leaves them out. upkeepMirror.test.js holds the parts both have to agree.
 */
export function upkeepProgress(program, evidence, today) {
  const upkeep = program?.upkeep;
  if (!upkeep || !UPKEEP_PERIODS.includes(upkeep.period)) return null;
  const window = upkeepWindow(today, upkeep.period);
  const types = upkeep.evidenceTypes || [];
  const filedHere = (item) =>
    !item.softDeletedAt &&
    Array.isArray(item.programIds) &&
    item.programIds.includes(program.id) &&
    (types.length === 0 || types.includes(item.sourceModule));
  const inPeriod = (item) =>
    Boolean(item.date) && item.date >= window.start && item.date <= window.end;
  const count = (evidence || []).filter(
    (item) => filedHere(item) && inPeriod(item),
  ).length;
  return {
    minCount: upkeep.minCount,
    current: {
      ...window,
      count,
      met: count >= upkeep.minCount,
      daysLeft: daysUntil(window.end, today),
    },
  };
}
