#!/usr/bin/env node
/**
 * Which Learn catalogue rows go stale in the next few weeks (#818).
 *
 * The catalogue alarm (`src/data/education-catalogues.test.js`, and Azure's
 * own `src/data/azure/certifications.test.js` for its applied skills) runs on
 * the real clock: the day a stored status is overtaken by its own dates, every
 * branch's build goes red until the row is re-verified with the vendor and
 * updated. #770 was that day for three rows at once, and until this existed
 * the only warning was a hand-filed issue.
 *
 * This prints the rows the alarm will name within `--days` (21 by default),
 * with the day each one fires, from the same `findStatusesDueWithin` rule, so
 * the list and the alarm cannot disagree. The Monday `warn-catalogue-due.yml`
 * run turns the report into one issue on the board.
 *
 * Usage:
 *   node scripts/catalogue-due-soon.mjs [--days 21] [--today YYYY-MM-DD] [--out report.md]
 *
 * Prints the report to stdout, or writes it to `--out`. When GITHUB_OUTPUT is
 * set, also writes `count=<n>` there for the workflow. Always exits 0 on a
 * clean run: a row coming due is news, not a failure.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { CATALOGUES } from '../src/data/catalogues.js';
import { findStatusesDueWithin, isIsoDate } from '../src/lib/certStatus.js';

/** The marker the workflow finds its own issue by. */
export const REPORT_MARKER = '<!-- catalogue-due-soon -->';

export const DEFAULT_DAYS = 21;

/** Every list a real-clock alarm checks: certifications, and applied skills where a catalogue has them. */
function checkedLists(mod) {
  return [mod.certifications, mod.appliedSkills].filter(Array.isArray);
}

/**
 * @param {{ catalogues?: Record<string, object>, today: string, days?: number }} options
 * @returns {Array<{ due: string, catalogue: string, problem: string, source: string|null }>}
 */
export function findDue({ catalogues = CATALOGUES, today, days = DEFAULT_DAYS }) {
  const rows = [];
  for (const [catalogue, mod] of Object.entries(catalogues)) {
    for (const list of checkedLists(mod)) {
      for (const { due, problem } of findStatusesDueWithin(list, today, days)) {
        rows.push({ due, catalogue, problem, source: mod.DATA_SOURCE?.url ?? null });
      }
    }
  }
  return rows.sort((a, b) => a.due.localeCompare(b.due) || a.catalogue.localeCompare(b.catalogue));
}

/** Markdown table cells cannot hold a raw pipe. */
const cell = (text) => String(text).replaceAll('|', '\\|');

export function renderReport({ due, today, days = DEFAULT_DAYS }) {
  const lines = [REPORT_MARKER, ''];
  if (due.length === 0) {
    lines.push(`No catalogue row goes stale in the ${days} days from ${today}.`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `${due.length === 1 ? 'One catalogue row goes' : `${due.length} catalogue rows go`} stale in the ${days} days from ${today}.`,
    '',
    'On each date below, `frontend/src/data/education-catalogues.test.js` (or `azure/certifications.test.js`) fails on **every branch** until the row is re-read against the vendor and updated. Re-verify it before then: store the status the row takes on that date with `statusReadDate` set to the day you read the vendor (the badge keeps its current status until the date, rule 2 of `deriveStatus`), cite the page in the catalogue header, and update any test that pins the old status.',
    '',
    '| Fires on | Catalogue | What the alarm will say | Check against |',
    '|---|---|---|---|'
  );
  for (const row of due) {
    lines.push(
      `| ${row.due} | ${cell(row.catalogue)} | ${cell(row.problem)} | ${row.source ?? '—'} |`
    );
  }
  lines.push(
    '',
    'Kept by `warn-catalogue-due.yml` every Monday from `frontend/scripts/catalogue-due-soon.mjs`. The next run refreshes this list, and closes the issue once nothing is due.'
  );
  return `${lines.join('\n')}\n`;
}

const USAGE =
  'Usage: node scripts/catalogue-due-soon.mjs [--days 21] [--today YYYY-MM-DD] [--out report.md]';

const refuse = (message) => {
  throw new Error(`${message}\n${USAGE}`);
};

/** Every flag takes one value; each entry checks it and sets its option. */
const FLAGS = {
  '--days': (options, value) => {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1)
      refuse('--days needs a whole number of days, 1 or more');
    options.days = days;
  },
  '--today': (options, value) => {
    if (!isIsoDate(value)) refuse('--today needs YYYY-MM-DD');
    options.today = value;
  },
  '--out': (options, value) => {
    if (!value) refuse('--out needs a path');
    options.out = value;
  },
};

export function parseArgs(argv) {
  const options = { days: DEFAULT_DAYS, today: new Date().toISOString().slice(0, 10), out: null };
  for (let i = 0; i < argv.length; i += 2) {
    const apply = FLAGS[argv[i]];
    if (!apply) refuse(`Unknown argument: ${argv[i]}`);
    apply(options, argv[i + 1]);
  }
  return options;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { days, today, out } = parseArgs(argv);
  const due = findDue({ today, days });
  const report = renderReport({ due, today, days });
  if (out) writeFileSync(out, report);
  else process.stdout.write(report);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `count=${due.length}\n`);
  return due.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
