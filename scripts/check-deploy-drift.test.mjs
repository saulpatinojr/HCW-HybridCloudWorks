/**
 * Drift detection, at the boundaries that decide whether it is worth having.
 *
 * The two incidents this exists to catch were one commit and thirty-five, so
 * the interesting assertions are about AGE and about what counts as a commit at
 * all — not about the happy path, which is a table render.
 */
import { describe, it, expect } from 'vitest';
import {
  SERVICES,
  DEFAULT_THRESHOLD_HOURS,
  parseLastSuccessfulRun,
  parseCommitDate,
  oldestCommit,
  ageHours,
  isStale,
  formatReport,
  driftFor,
  COMMITS_PER_PAGE,
  cell,
} from './check-deploy-drift.mjs';

const NOW = Date.parse('2026-09-01T04:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const commit = (sha, date, message = 'a change') => ({
  sha,
  commit: { committer: { date }, message },
});

describe('parseLastSuccessfulRun', () => {
  it('reads the head sha of the newest successful run', () => {
    const out = parseLastSuccessfulRun({
      workflow_runs: [{ head_sha: 'abc123', run_number: 82, created_at: hoursAgo(3) }],
    });
    expect(out.sha).toBe('abc123');
    expect(out.runNumber).toBe(82);
  });

  it('returns null for a workflow that has never deployed — a fact, not an error', () => {
    expect(parseLastSuccessfulRun({ workflow_runs: [] })).toBe(null);
  });

  it('throws on a shape it cannot read, rather than reporting it as never-deployed', () => {
    // These are different facts. "Never deployed" sends someone to run a deploy;
    // an unreadable answer sends them to look at the check.
    expect(() => parseLastSuccessfulRun({})).toThrow(/workflow_runs/);
    expect(() => parseLastSuccessfulRun(null)).toThrow(/workflow_runs/);
    expect(() => parseLastSuccessfulRun({ workflow_runs: [{}] })).toThrow(/head_sha/);
  });
});

describe('parseCommitDate', () => {
  it('prefers the committer date and falls back to the author date', () => {
    expect(parseCommitDate({ commit: { committer: { date: 'A' }, author: { date: 'B' } } })).toBe(
      'A'
    );
    expect(parseCommitDate({ commit: { author: { date: 'B' } } })).toBe('B');
  });

  it('throws when neither is present', () => {
    expect(() => parseCommitDate({ commit: {} })).toThrow(/date/);
  });
});

describe('oldestCommit', () => {
  // THE ASSERTION THIS FILE EXISTS FOR. Getting this wrong reports how recently
  // someone merged instead of how long the drift has lasted — which reads as
  // healthy immediately after the merge that created it, exactly backwards.
  it('picks the oldest by date', () => {
    const out = oldestCommit([
      commit('new', hoursAgo(1), 'newest'),
      commit('mid', hoursAgo(30), 'middle'),
      commit('old', hoursAgo(50), 'oldest'),
    ]);
    expect(out.sha).toBe('old');
    expect(out.message).toBe('oldest');
  });

  // The first version took the last element, on the true-but-narrow grounds
  // that GitHub returns newest first. driftFor merges one list per declared
  // path, so the merged array is newest-first only within each segment — with
  // two paths the last element is the SECOND path's oldest, which can be far
  // newer. Found in review; the fix was to stop assuming order at all.
  it('does not care what order the list is in', () => {
    const rows = [
      commit('mid', hoursAgo(30), 'middle'),
      commit('old', hoursAgo(50), 'oldest'),
      commit('new', hoursAgo(1), 'newest'),
    ];
    expect(oldestCommit(rows).sha).toBe('old');
    expect(oldestCommit([...rows].reverse()).sha).toBe('old');
  });

  it('skips undated commits rather than treating them as epoch zero', () => {
    // Date.parse(undefined) is NaN; a naive min would make it 1970 and report
    // fifty-five years of drift.
    const out = oldestCommit([{ sha: 'undated', commit: { message: 'no date' } }, commit('old', hoursAgo(9), 'real')]);
    expect(out.sha).toBe('old');
    expect(out.message).toBe('real');
  });

  it('is null when nothing in the list has a date', () => {
    expect(oldestCommit([{ sha: 'a', commit: { message: 'x' } }])).toBe(null);
  });

  it('takes only the first line of the message', () => {
    expect(oldestCommit([commit('a', hoursAgo(1), 'subject\n\nbody')]).message).toBe('subject');
  });

  it('is null for nothing', () => {
    expect(oldestCommit([])).toBe(null);
    expect(oldestCommit(undefined)).toBe(null);
  });
});

describe('ageHours', () => {
  it('floors to whole hours', () => {
    expect(ageHours(hoursAgo(2), NOW)).toBe(2);
    expect(ageHours(new Date(NOW - 2.9 * 3_600_000).toISOString(), NOW)).toBe(2);
  });

  it('never goes negative for a commit dated in the future', () => {
    // Clock skew between the runner and GitHub is real and a negative age would
    // render as a healthy service.
    expect(ageHours(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe(0);
  });

  it('throws on a value that is not a date', () => {
    expect(() => ageHours('not-a-date', NOW)).toThrow();
  });
});

describe('isStale', () => {
  it('fires AT the threshold, not after it', () => {
    expect(isStale(24, 24)).toBe(true);
    expect(isStale(23, 24)).toBe(false);
    expect(isStale(25, 24)).toBe(true);
  });
});

describe('formatReport', () => {
  it('passes a service that is behind but inside the threshold', () => {
    const { failed, text } = formatReport(
      [{ name: 'Function App', count: 1, oldest: { message: 'x' }, hours: 3 }],
      DEFAULT_THRESHOLD_HOURS
    );
    expect(failed).toBe(false);
    expect(text).toContain('✅');
  });

  // The manifest 404: ONE commit, two days old. A count-based check cannot
  // distinguish this from an ordinary merge; an age-based one does.
  it('fails one commit that is older than the threshold', () => {
    const { failed, text } = formatReport(
      [{ name: 'Function App', count: 1, oldest: { message: 'add the route' }, hours: 49 }],
      DEFAULT_THRESHOLD_HOURS
    );
    expect(failed).toBe(true);
    expect(text).toContain('49h');
  });

  it('passes thirty-five commits merged in the last hour', () => {
    const { failed } = formatReport(
      [{ name: 'Static Web App', count: 35, oldest: { message: 'x' }, hours: 0 }],
      DEFAULT_THRESHOLD_HOURS
    );
    expect(failed).toBe(false);
  });

  it('fails a service that has never deployed', () => {
    const { failed, text } = formatReport([{ name: 'X', neverDeployed: true }], 24);
    expect(failed).toBe(true);
    expect(text).toContain('never deployed');
  });

  it('fails an unreadable service, and marks it differently from drift', () => {
    const { failed, text } = formatReport([{ name: 'X', error: 'GitHub answered 403' }], 24);
    expect(failed).toBe(true);
    expect(text).toContain('⚠️');
    expect(text).toContain('403');
    // A broken check and a stale deploy send someone to different places.
    expect(text).toContain('could not read the answer');
  });

  it('is green when nothing is behind', () => {
    const { failed, text } = formatReport([{ name: 'X', count: 0, oldest: null, hours: 0 }], 24);
    expect(failed).toBe(false);
    expect(text).toContain('within the threshold');
  });
});

describe('driftFor', () => {
  const stub = (map) => async (url) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    if (!key) throw new Error(`unstubbed: ${url}`);
    return { ok: true, status: 200, json: async () => map[key] };
  };

  it('excludes the deployed commit itself from the drift', async () => {
    // `since` is inclusive, so the deployed commit comes back in the list when
    // it touched this path. Counting it would make a service report itself one
    // commit behind seconds after a successful deploy.
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({
        '/runs?status=success': { workflow_runs: [{ head_sha: 'deployed', run_number: 1 }] },
        '/commits/deployed': { commit: { committer: { date: hoursAgo(5) } } },
        '/commits?sha=main': [commit('deployed', hoursAgo(5), 'the deployed one')],
      }),
    });
    expect(out.count).toBe(0);
    expect(out.oldest).toBe(null);
    expect(out.hours).toBe(0);
  });

  it('reports the age of the oldest undeployed commit', async () => {
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: stub({
        '/runs?status=success': { workflow_runs: [{ head_sha: 'deployed', run_number: 1 }] },
        '/commits/deployed': { commit: { committer: { date: hoursAgo(60) } } },
        '/commits?sha=main': [
          commit('new', hoursAgo(2), 'recent'),
          commit('old', hoursAgo(49), 'add the manifest route'),
        ],
      }),
    });
    expect(out.count).toBe(2);
    expect(out.hours).toBe(49);
    expect(out.oldest.message).toBe('add the manifest route');
  });

  it('paginates past the first page', async () => {
    // Drift matters most when it is large, so stopping at 100 under-reports
    // exactly the case this exists for: it would return a too-recent oldest and
    // therefore a healthier age than the truth.
    const pageOne = Array.from({ length: COMMITS_PER_PAGE }, (_, i) =>
      commit(`p1-${i}`, hoursAgo(10), 'recent')
    );
    const pageTwo = [commit('ancient', hoursAgo(200), 'the forgotten one')];
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: async (url) => {
        if (url.includes('/runs?status=success'))
          return { ok: true, json: async () => ({ workflow_runs: [{ head_sha: 'deployed' }] }) };
        if (url.includes('/commits/deployed'))
          return { ok: true, json: async () => ({ commit: { committer: { date: hoursAgo(300) } } }) };
        // `&page=`, not `page=` — `per_page=100` contains `page=100`, which
        // contains `page=1`, so the loose form matched every page and this test
        // failed against correct code. A stub that lies is worse than no stub.
        if (url.includes('&page=1')) return { ok: true, json: async () => pageOne };
        if (url.includes('&page=2')) return { ok: true, json: async () => pageTwo };
        return { ok: true, json: async () => [] };
      },
    });
    expect(out.count).toBe(COMMITS_PER_PAGE + 1);
    expect(out.hours).toBe(200);
    expect(out.oldest.message).toBe('the forgotten one');
  });

  it('de-duplicates a commit that touches two of a service multiple declared paths', async () => {
    const shared = commit('both', hoursAgo(40), 'touches both paths');
    const out = await driftFor(
      { name: 'Two paths', workflow: 'w.yml', paths: ['a', 'b'] },
      {
        token: 't',
        owner: 'o',
        repo: 'r',
        nowMs: NOW,
        fetchImpl: async (url) => {
          if (url.includes('/runs?status=success'))
            return { ok: true, json: async () => ({ workflow_runs: [{ head_sha: 'deployed' }] }) };
          if (url.includes('/commits/deployed'))
            return { ok: true, json: async () => ({ commit: { committer: { date: hoursAgo(99) } } }) };
          return { ok: true, json: async () => [shared] };
        },
      }
    );
    expect(out.count).toBe(1);
  });

  it('reports undated commits as an error rather than as zero drift', async () => {
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: async (url) => {
        if (url.includes('/runs?status=success'))
          return { ok: true, json: async () => ({ workflow_runs: [{ head_sha: 'deployed' }] }) };
        if (url.includes('/commits/deployed'))
          return { ok: true, json: async () => ({ commit: { committer: { date: hoursAgo(99) } } }) };
        return { ok: true, json: async () => [{ sha: 'x', commit: { message: 'no date' } }] };
      },
    });
    expect(out.error).toContain('none with a readable date');
    expect(out.hours).toBeUndefined();
  });

  it('treats a non-array commits payload as unreadable, not as no drift', async () => {
    // Defaulting to [] here would report the service up to date — the same
    // healthier-than-reality direction as every other defect found in this
    // file. A ⚠️ says "could not read"; a ✅ says "nothing to deploy", and only
    // one of those is honest about an unrecognised payload.
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: async (url) => {
        if (url.includes('/runs?status=success'))
          return { ok: true, json: async () => ({ workflow_runs: [{ head_sha: 'deployed' }] }) };
        if (url.includes('/commits/deployed'))
          return { ok: true, json: async () => ({ commit: { committer: { date: hoursAgo(99) } } }) };
        return { ok: true, json: async () => ({ message: 'not an array' }) };
      },
    });
    expect(out.error).toContain('non-array commits payload');
    expect(out.count).toBeUndefined();
    expect(formatReport([out], 24).failed).toBe(true);
  });

  it('returns the failure as a row instead of throwing, so one service cannot hide the others', async () => {
    const out = await driftFor(SERVICES[0], {
      token: 't',
      owner: 'o',
      repo: 'r',
      nowMs: NOW,
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    expect(out.error).toContain('403');
  });
});

describe('SERVICES', () => {
  it('covers both dispatch-only deploys and terraform infra plan check', () => {
    expect(SERVICES.map((s) => s.workflow).sort()).toEqual([
      'deploy-azure-frontend.yml',
      'deploy-functions.yml',
      'tfc-plan-check.yml',
    ]);
  });

  it('gives every service at least one path, or drift would always be zero', () => {
    for (const s of SERVICES) expect(s.paths.length).toBeGreaterThan(0);
  });
});

describe('cell', () => {
  // Commit subjects and error text are not ours to constrain. A `|` ends the
  // cell early, the row grows a column, and the table stops being a table —
  // in the one artefact an operator reads to decide whether to deploy.
  it('escapes a pipe', () => {
    expect(cell('fix: handle a | b')).toBe('fix: handle a \\| b');
  });

  it('escapes a backslash, so it survives as a backslash', () => {
    expect(cell('use C:\\path')).toBe('use C:\\\\path');
  });

  // The ordering case. Escape only `|` and the subject below becomes
  // `a \\| b`: Markdown renders the doubled backslash as one literal
  // backslash and then reads the pipe as a live column break — the escape
  // is what breaks the table. Escaping `\` first is what makes the pipe
  // stay escaped.
  it('keeps a pipe escaped even when the subject already contains a backslash', () => {
    expect(cell('a \\| b')).toBe('a \\\\\\| b');
  });

  it('folds newlines, which break a row as thoroughly as a pipe', () => {
    expect(cell('line one\nline two')).toBe('line one line two');
    expect(cell('crlf\r\nhere')).toBe('crlf here');
  });

  it('is empty for null and undefined rather than printing the words', () => {
    expect(cell(null)).toBe('');
    expect(cell(undefined)).toBe('');
  });

  it('leaves ordinary text alone', () => {
    expect(cell('add the manifest route')).toBe('add the manifest route');
  });
});

describe('formatReport escaping', () => {
  it('keeps the row a single row when a commit subject contains a pipe', () => {
    const { text } = formatReport(
      [{ name: 'Function App', count: 1, oldest: { message: 'feat: a | b' }, hours: 50 }],
      24
    );
    const row = text.split('\n').find((l) => l.startsWith('| Function App'));
    // Three cells means three unescaped separators plus the leading and
    // trailing ones. An unescaped pipe in the subject would make it more.
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(4);
    expect(row).toContain('a \\| b');
  });

  it('escapes error text too, which comes from anywhere', () => {
    const { text } = formatReport([{ name: 'X', error: 'boom | bang' }], 24);
    expect(text).toContain('boom \\| bang');
  });
});
