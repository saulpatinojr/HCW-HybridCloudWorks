import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DrillTableError,
  COLUMNS,
  MAX_AGE_DAYS,
  RUNBOOK,
  cells,
  drillRows,
  evaluate,
  missingEvidence,
  parseArgs,
  parseDate,
  renderMarkdown,
  todayUtc,
  verdictLine,
} from './check-drill-age.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-drill-age.mjs');

const HEADER = '| Date | RTO measured | RPO measured | Who | Applied runs | Documents | Notes |';
const SEPARATOR = '| --- | --- | --- | --- | --- | --- | --- |';
const PLACEHOLDER = '| — | — | — | — | — | — | No drill yet |';

/** A runbook whose Drills section holds the given data rows. */
function runbook(rows, { before = '', after = '' } = {}) {
  return [
    '# Cosmos restore',
    '',
    '## A regional loss',
    '',
    '| Date | not | this | table |',
    '| --- | --- | --- | --- |',
    '| 2020-01-01 | a | b | c |',
    '',
    '## Drills',
    '',
    before,
    '```text',
    '| 2026-10-20 | 03:12:45 | 21 h | someone | full | 1 | example inside a fence |',
    '```',
    '',
    '| Column | What goes in it |',
    '| --- | --- |',
    '| Date | the day |',
    '',
    HEADER,
    SEPARATOR,
    ...rows,
    '',
    after,
  ].join('\n');
}

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

describe('reading the table', () => {
  it('splits a row into trimmed cells', () => {
    expect(cells('| a | b  |c|')).toEqual(['a', 'b', 'c']);
  });

  it('reads the Date table under "## Drills", not a table elsewhere, the column legend, or a fenced example', () => {
    const rows = drillRows(runbook(['| 2026-09-01 | 01:00:00 | 5 h | x | y | 1 | z |']));
    expect(rows.map((r) => r.cells[0])).toEqual(['2026-09-01']);
  });

  it('stops at the next heading', () => {
    const text = runbook([PLACEHOLDER], { after: '## Next\n\n| 2026-01-01 | stray |' });
    expect(drillRows(text).map((r) => r.cells[0])).toEqual(['—']);
  });

  it('refuses a runbook with no Drills heading or no Date table', () => {
    expect(() => drillRows('# x\n\n## Other\n')).toThrow(DrillTableError);
    expect(() => drillRows('## Drills\n\nNothing here.\n')).toThrow(/no table/);
  });

  it('accepts only real calendar dates', () => {
    expect(parseDate('2026-10-07')).toBe(Date.UTC(2026, 9, 7));
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('7 Oct 2026')).toBeNull();
    expect(parseDate('2026-10-07 ')).toBeNull();
  });
});

describe('the verdict', () => {
  it('has no drill when only the placeholder row is present', () => {
    expect(evaluate(runbook([PLACEHOLDER]), { today: '2026-10-07' })).toEqual({
      status: 'none',
      newest: null,
      ageDays: null,
      drills: 0,
    });
  });

  it('is current at exactly the limit and stale one day past it', () => {
    const text = runbook([PLACEHOLDER, '| 2026-07-01 | 03:00:00 | 20 h | x | y | 1 | z |']);
    expect(evaluate(text, { today: '2026-10-09' })).toMatchObject({ status: 'current', ageDays: 100 });
    expect(evaluate(text, { today: '2026-10-10' })).toMatchObject({ status: 'stale', ageDays: 101 });
  });

  it('takes the newest row whatever the order', () => {
    const text = runbook([
      '| 2026-10-01 | 02:00:00 | 10 h | x | y | 1 | newest |',
      '| 2026-01-15 | 05:00:00 | 22 h | x | y | 1 | older |',
    ]);
    expect(evaluate(text, { today: '2026-10-07' })).toMatchObject({ status: 'current', newest: '2026-10-01', ageDays: 6, drills: 2 });
  });

  it('honours a different limit', () => {
    const text = runbook(['| 2026-10-01 | 02:00:00 | 10 h | x | y | 1 | z |']);
    expect(evaluate(text, { today: '2026-10-07', maxAgeDays: 5 }).status).toBe('stale');
  });

  it('cannot evaluate a dated row without its evidence, so a date alone never turns the check green', () => {
    expect(() => evaluate(runbook(['| 2026-10-07 |']), { today: '2026-10-07' })).toThrow(/1 cell\(s\) where 7/);
    expect(() =>
      evaluate(runbook(['| 2026-10-07 | — | 20 h | x | y | 1 | z |']), { today: '2026-10-07' })
    ).toThrow(/no RTO measured/);
    expect(() =>
      evaluate(runbook(['| 2026-10-07 | 01:00:00 |  | | y | 1 | z |']), { today: '2026-10-07' })
    ).toThrow(/no RPO measured, no Who/);
    // Notes is the one cell a drill may leave empty.
    expect(evaluate(runbook(['| 2026-10-07 | 01:00:00 | 20 h | x | y | 1 | |']), { today: '2026-10-07' }).status).toBe(
      'current'
    );
    expect(missingEvidence(['2026-10-07', '01:00:00', '20 h', 'x', 'y', '1', ''])).toEqual([]);
  });

  it('refuses a Drills table whose columns are not the runbook\'s', () => {
    const text = runbook([]).replace(HEADER, '| Date | Elapsed | Notes |').replace(SEPARATOR, '| --- | --- | --- |');
    expect(() => evaluate(text, { today: '2026-10-07' })).toThrow(/columns are "Date \| Elapsed \| Notes"/);
    expect(HEADER).toBe(`| ${COLUMNS.join(' | ')} |`);
  });

  it('cannot evaluate a typo or a future date, rather than reading either as no drill', () => {
    expect(() => evaluate(runbook(['| 20/10/2026 | x | x | x | x | x | x |']), { today: '2026-10-21' })).toThrow(
      /not a YYYY-MM-DD/
    );
    expect(() => evaluate(runbook(['| 2026-11-01 | x | x | x | x | x | x |']), { today: '2026-10-21' })).toThrow(
      /after today/
    );
    expect(() => evaluate(runbook([PLACEHOLDER]), { today: 'today' })).toThrow(/--today/);
  });

  it('says what to do when the drill is due', () => {
    const none = { status: 'none', newest: null, ageDays: null, drills: 0 };
    expect(verdictLine(none)).toContain('No restore drill is recorded');
    expect(renderMarkdown(none)).toContain('"The drill"');
    const current = { status: 'current', newest: '2026-10-01', ageDays: 6, drills: 1 };
    expect(verdictLine(current)).toBe(`Last drill: 2026-10-01, 6 day(s) ago, within ${MAX_AGE_DAYS}.`);
    expect(renderMarkdown(current)).not.toContain('"The drill"');
  });
});

describe('the committed runbook', () => {
  it('has a Drills table this script can read', () => {
    // The check runs against this file every week; a runbook edit that
    // breaks its shape must fail here, in the pull request, not on Monday.
    // Today's real date: a fixed day read the first drill's row (2026-10-13)
    // as one from the future, once the table held a real row.
    const result = evaluate(readFileSync(RUNBOOK, 'utf8'), { today: todayUtc() });
    expect(['none', 'current', 'stale']).toContain(result.status);
  });
});

describe('the command line', () => {
  it('parses its flags and refuses unknown ones', () => {
    expect(parseArgs(['--today', '2026-10-07', '--max-age-days', '30'])).toMatchObject({ today: '2026-10-07', maxAgeDays: 30 });
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--max-age-days', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--today'])).toThrow(/needs a value/);
  });

  it('exits 0 for --help, 0 current, 1 stale or none, 2 unreadable, and writes the summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drill-age-'));
    const fresh = join(dir, 'fresh.md');
    const empty = join(dir, 'empty.md');
    const broken = join(dir, 'broken.md');
    const summary = join(dir, 'summary.md');
    writeFileSync(fresh, runbook(['| 2026-10-01 | 02:00:00 | 10 h | x | y | 1 | z |']));
    writeFileSync(empty, runbook([PLACEHOLDER]));
    writeFileSync(broken, '# nothing\n');

    expect(run(['--help']).code).toBe(0);
    expect(run(['--runbook', fresh, '--today', '2026-10-07']).code).toBe(0);

    const stale = run(['--runbook', fresh, '--today', '2027-03-01', '--summary', summary]);
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain('overdue');
    expect(readFileSync(summary, 'utf8')).toContain('"The drill"');

    expect(run(['--runbook', empty, '--today', '2026-10-07']).code).toBe(1);

    const unreadable = run(['--runbook', broken, '--today', '2026-10-07']);
    expect(unreadable.code).toBe(2);
    expect(unreadable.stderr).toContain('Cannot evaluate');

    expect(run(['--bogus']).code).toBe(2);
  });
});
