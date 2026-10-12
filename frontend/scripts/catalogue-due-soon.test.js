/**
 * The early warning ahead of the catalogue alarm (#818).
 *
 * Fixture catalogues, not the real ones, for every assertion about which rows
 * appear: the real rows change as vendors publish dates, and a test pinned to
 * them would itself be the kind of time bomb this script exists to defuse.
 * The one test that reads the real catalogues asserts only that the warning
 * and the alarm agree.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findStaleStatuses } from '../src/lib/certStatus.js';
import { CATALOGUES } from '../src/data/catalogues.js';
import { REPORT_MARKER, findDue, main, parseArgs, renderReport } from './catalogue-due-soon.mjs';

const TODAY = '2026-10-26';

const fixtures = {
  aws: {
    DATA_SOURCE: { url: 'https://aws.example/cert' },
    certifications: [
      { code: 'OLD-C02', status: 'expiring', expiryDate: '2026-11-10' },
      { code: 'NEW-C03', status: 'upcoming', availableDate: '2026-11-17' },
      { code: 'FAR-C01', status: 'expiring', expiryDate: '2027-06-30' },
    ],
  },
  azure: {
    DATA_SOURCE: { url: 'https://learn.example/browse' },
    certifications: [{ code: 'MS-102', status: 'expiring', expiryDate: '2026-11-01' }],
    appliedSkills: [{ id: 'skill-a', status: 'expiring', expiryDate: '2026-10-30' }],
  },
  empty: { certifications: [] },
};

describe('findDue', () => {
  it('lists every row the alarm will name in the window, soonest first, with its source', () => {
    expect(findDue({ catalogues: fixtures, today: TODAY, days: 21 })).toEqual([
      {
        due: '2026-10-31',
        catalogue: 'azure',
        problem: "skill-a: status 'expiring' but expiryDate 2026-10-30 has passed",
        source: 'https://learn.example/browse',
      },
      {
        due: '2026-11-02',
        catalogue: 'azure',
        problem: "MS-102: status 'expiring' but expiryDate 2026-11-01 has passed",
        source: 'https://learn.example/browse',
      },
      {
        due: '2026-11-11',
        catalogue: 'aws',
        problem: "OLD-C02: status 'expiring' but expiryDate 2026-11-10 has passed",
        source: 'https://aws.example/cert',
      },
    ]);
  });

  it('checks applied skills as well as certifications, as the Azure alarm does', () => {
    // NEW-C03 (fires 2026-11-17) and FAR-C01 fall outside a 21-day window.
    const due = findDue({ catalogues: fixtures, today: TODAY, days: 5 });
    expect(due.map((d) => d.problem)).toEqual([expect.stringMatching(/^skill-a:/)]);
  });

  it('agrees with the real alarm on the real catalogues: each row fires on its due day, not before', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const { due, catalogue, problem } of findDue({ today, days: 60 })) {
      const mod = CATALOGUES[catalogue];
      const lists = [mod.certifications, mod.appliedSkills].filter(Array.isArray);
      const onDue = lists.flatMap((list) => findStaleStatuses(list, due));
      const stillFine = lists.flatMap((list) => findStaleStatuses(list, today));
      expect(onDue, `${catalogue} on ${due}`).toContain(problem);
      expect(stillFine, `${catalogue} today`).not.toContain(problem);
    }
  });
});

describe('renderReport', () => {
  it('starts with the marker the workflow finds its issue by', () => {
    expect(renderReport({ due: [], today: TODAY }).startsWith(REPORT_MARKER)).toBe(true);
    const due = findDue({ catalogues: fixtures, today: TODAY, days: 21 });
    expect(renderReport({ due, today: TODAY }).startsWith(REPORT_MARKER)).toBe(true);
  });

  it('says plainly when nothing is due', () => {
    expect(renderReport({ due: [], today: TODAY, days: 21 })).toContain(
      'No catalogue row goes stale in the 21 days from 2026-10-26.'
    );
  });

  it('gives one table row per due row, with the day, the catalogue, the alarm text and the source', () => {
    const due = findDue({ catalogues: fixtures, today: TODAY, days: 21 });
    const report = renderReport({ due, today: TODAY, days: 21 });
    expect(report).toContain('3 catalogue rows go stale in the 21 days from 2026-10-26.');
    expect(report).toContain(
      "| 2026-11-11 | aws | OLD-C02: status 'expiring' but expiryDate 2026-11-10 has passed | https://aws.example/cert |"
    );
    expect(report.match(/^\| 20\d\d-/gm)).toHaveLength(3);
  });

  it('offers an early re-read only where deriveStatus holds one, and not for a beta (#1091)', () => {
    const due = findDue({ catalogues: fixtures, today: TODAY, days: 21 });
    const report = renderReport({ due, today: TODAY, days: 21 });
    expect(report).toContain('with `statusReadDate` set to the day you read the vendor');
    expect(report).toContain(
      'An `upcoming` row due on its `availableDate`, or a row due on its `expiryDate`'
    );
    expect(report).toContain('A `beta` row cannot be held that way, so re-read it on its date.');
  });

  it('escapes a pipe, so a row cannot break the table', () => {
    const report = renderReport({
      due: [{ due: '2026-11-01', catalogue: 'x', problem: 'A|B: odd', source: null }],
      today: TODAY,
    });
    expect(report).toContain('| 2026-11-01 | x | A\\|B: odd | — |');
  });
});

describe('the command line', () => {
  it('defaults to 21 days from today (UTC)', () => {
    const options = parseArgs([]);
    expect(options.days).toBe(21);
    expect(options.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(options.out).toBeNull();
  });

  it('refuses a malformed day, window or argument instead of guessing', () => {
    expect(() => parseArgs(['--today', '2026-9-1'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--days', '0'])).toThrow(/whole number/);
    expect(() => parseArgs(['--days', 'three'])).toThrow(/whole number/);
    expect(() => parseArgs(['--out'])).toThrow(/needs a path/);
    expect(() => parseArgs(['--label', 'x'])).toThrow(/Unknown argument/);
  });

  it('writes the report and the count the workflow reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalogue-due-'));
    const out = join(dir, 'report.md');
    const githubOutput = join(dir, 'github-output');
    const count = main(['--today', TODAY, '--days', '400', '--out', out], {
      GITHUB_OUTPUT: githubOutput,
    });

    expect(readFileSync(out, 'utf8').startsWith(REPORT_MARKER)).toBe(true);
    expect(readFileSync(githubOutput, 'utf8')).toBe(`count=${count}\n`);
  });
});
