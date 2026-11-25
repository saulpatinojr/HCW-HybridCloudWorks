/**
 * section-labs.js — the newsletter's "Lab this week" section (sections.js
 * holds the registry and says what a section is): the hybrid lab host's
 * week, from the day documents the labs rollup writes. sections.js exports
 * all of this again.
 */
import { readLabsWeek } from '../labs/rollup.js';
import { plainText, SITE_ORIGIN } from './section-text.js';

/**
 * Where every "Lab this week" item links: the cross-provider labs index. A
 * day document carries no provider, and the index groups every lab by its
 * provider hub (ADR 0033 §3), so it is the one page that fits every item.
 */
export const LABS_PAGE_URL = `${SITE_ORIGIN}/education/labs`;

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

/**
 * The week's job counts per type, summed over the day documents: `[{ type,
 * runs, succeeded, failed, timeout }]`, most-run first, types with no run
 * dropped. A count that is not a non-negative integer adds nothing.
 */
export function labWeekJobTotals(docs) {
  const totals = new Map();
  for (const doc of docs) {
    for (const [type, counts] of Object.entries(doc.jobsByType ?? {})) {
      const row = totals.get(type) ?? { succeeded: 0, failed: 0, timeout: 0 };
      for (const key of Object.keys(row)) {
        const n = counts?.[key];
        if (Number.isInteger(n) && n > 0) row[key] += n;
      }
      totals.set(type, row);
    }
  }
  return [...totals]
    .map(([type, c]) => ({ type, runs: c.succeeded + c.failed + c.timeout, ...c }))
    .filter((t) => t.runs > 0)
    .sort((a, b) => b.runs - a.runs || a.type.localeCompare(b.type));
}

/**
 * The section's items from a week of day documents (labs/rollup.js), in the
 * order they read: Arc, then the job types by runs, then the Coder peak.
 * Empty — and so the section is omitted — when no day was observed and no
 * job ran: an Arc line that says "0 of 0 days" is the filler the price
 * section refuses too. The Coder peak alone does not carry the section; it
 * is a footnote to a lab that was used, not a reason to write about one that
 * was not.
 *
 * @param {object[]} days - day documents, any order
 * @returns {Array<{ title: string, url: string, summary?: string, label?: string }>}
 */
export function labWeekItems(days) {
  const docs = Array.isArray(days) ? days.filter((d) => d && typeof d === 'object') : [];
  const observed = docs.filter((d) => typeof d.arcConnected === 'boolean');
  const connected = observed.filter((d) => d.arcConnected === true).length;
  const types = labWeekJobTotals(docs);

  if (observed.length === 0 && types.length === 0) return [];

  const items = [];
  if (observed.length > 0) {
    items.push({
      title: `Azure Arc: connected ${connected} of ${plural(observed.length, 'day')} observed`,
      summary:
        'Days the lab host reported Connected to Azure Arc, out of the days the estate page saw it.',
      url: LABS_PAGE_URL,
      label: 'Hybrid lab host',
    });
  }
  for (const t of types) {
    const problems = [
      t.failed > 0 ? `${t.failed} failed` : null,
      t.timeout > 0 ? `${t.timeout} timed out` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    items.push({
      title: plainText(`${t.type}: ${plural(t.runs, 'run')}, ${t.succeeded} succeeded`, 160),
      summary: problems,
      url: LABS_PAGE_URL,
      label: 'Lab jobs',
    });
  }
  const peaks = docs.map((d) => d.coderRunningMax).filter((n) => Number.isInteger(n) && n >= 0);
  if (peaks.length > 0) {
    items.push({
      title: `Peak Coder workspaces: ${Math.max(...peaks)}`,
      summary: 'The most browser lab workspaces running at once, as sampled each day.',
      url: LABS_PAGE_URL,
      label: 'Coder',
    });
  }
  return items;
}

/**
 * Lab this week (#665, Phase 5 of #656): the hybrid lab host's week, from the
 * day documents the labsWeeklyRollup timer writes (labs/rollup.js) — seven
 * point reads, never a call to Azure or Coder. Omitted from the issue when no
 * day document exists, or when none of them observed the estate or a job.
 *
 * `since` is not used: the window is the seven UTC days before the build's
 * day, which is what the rollup has written, not the issue's lookback.
 */
export const labThisWeekSection = Object.freeze({
  id: 'lab-this-week',
  title: 'Lab this week',
  async collect({ store, until }) {
    const days = await readLabsWeek({ store, until: until instanceof Date ? until : new Date() });
    return labWeekItems(days);
  },
});

