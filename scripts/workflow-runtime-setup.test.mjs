/**
 * Every workflow job that runs Node.js or Python chooses its version (#1707).
 *
 * A job that runs `node`, `npm`, `npx`, `python3` or `pip` without
 * actions/setup-node or actions/setup-python gets whatever the runner image
 * ships: on ubuntu-26.04 that was Node.js 24 and Python 3.14 in November 2026,
 * both below the floors in scripts/version-floors.json (Node.js 26, Python
 * 3.15). Nothing else would notice, because the floors test reads only the
 * versions a file names, and a job that names none has nothing to read. Six
 * jobs were found that way on 2026-11-12.
 *
 * A command counts when it is in command position on a line of a `run:` step
 * (at the start, or after `$(`, `|`, `&&`, `||` or `;`), not when the word
 * appears inside a string, a heredoc's text or a `docker run` argument. The
 * set-up step must come before the first such step. A job that runs in a
 * `container:` uses that image's runtime and is not checked.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');

/**
 * Jobs that use the runner's own interpreter on purpose, each with its reason.
 * A new entry needs a reason a reviewer can check.
 */
const RUNNER_DEFAULT_ALLOWED = {
  'repository-policy.yml > validate-structure > python':
    "the redaction gate is standard-library Python only, so the runner's python3 is enough (the comment above its step says so)",
};

const COMMAND = {
  node: /(?:^|\$\(\s*|[|;&]\s*)(?:node|npm|npx)(?=\s|$)/,
  python: /(?:^|\$\(\s*|[|;&]\s*)(?:python3?|pip3?)(?=\s|$)/,
};
const SETUP = { node: /^actions\/setup-node@/, python: /^(?:actions\/setup-python|astral-sh\/setup-uv)@/ };

/** True when a run step calls the runtime in command position on a line that is not a comment. */
export function runsRuntime(run, kind) {
  return String(run ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .some((line) => COMMAND[kind].test(line));
}

/** The jobs of one workflow that run a runtime before (or without) setting it up: "file > job > kind". */
export function unsetJobs(file, workflow) {
  const found = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    if (!Array.isArray(job?.steps) || job.container) continue;
    for (const kind of Object.keys(COMMAND)) {
      const first = job.steps.findIndex((step) => runsRuntime(step.run, kind));
      if (first === -1) continue;
      const setup = job.steps.findIndex((step) => SETUP[kind].test(String(step.uses ?? '')));
      if (setup === -1 || setup > first) found.push(`${file} > ${name} > ${kind}`);
    }
  }
  return found;
}

describe('runsRuntime and unsetJobs', () => {
  it('finds node and python in command position, not inside strings or arguments', () => {
    expect(runsRuntime('token=$(node scripts/github-app-token.mjs)', 'node')).toBe(true);
    expect(runsRuntime('npm ci --no-audit', 'node')).toBe(true);
    expect(runsRuntime('cat x | python3 -I check.py', 'python')).toBe(true);
    expect(runsRuntime('echo "run `node scripts/x.mjs` by hand"', 'node')).toBe(false);
    expect(runsRuntime('docker run --rm img python -c "import azure"', 'python')).toBe(false);
    expect(runsRuntime('/opt/az/bin/python3 -Im pip check', 'python')).toBe(false);
    expect(runsRuntime('# node is not run here', 'node')).toBe(false);
    expect(runsRuntime('for node in items["nodes"]:', 'node')).toBe(false);
  });

  it('flags a job that sets the runtime up after first using it, or not at all', () => {
    const wf = {
      jobs: {
        late: { steps: [{ run: 'node a.mjs' }, { uses: 'actions/setup-node@abc' }] },
        none: { steps: [{ run: 'python3 b.py' }] },
        good: { steps: [{ uses: 'actions/setup-node@abc' }, { run: 'node a.mjs' }] },
        boxed: { container: 'node:26', steps: [{ run: 'node a.mjs' }] },
      },
    };
    expect(unsetJobs('x.yml', wf)).toEqual(['x.yml > late > node', 'x.yml > none > python']);
  });
});

describe('.github/workflows', () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  const unset = files.flatMap((file) => unsetJobs(file, parse(readFileSync(join(WORKFLOWS, file), 'utf8'))));

  it('every job that runs Node.js or Python sets its version up first, so the runner image never chooses it', () => {
    expect(unset.filter((entry) => !(entry in RUNNER_DEFAULT_ALLOWED))).toEqual([]);
  });

  it('every allowed exception still exists, so the list cannot hide a job that has since changed', () => {
    for (const entry of Object.keys(RUNNER_DEFAULT_ALLOWED)) expect(unset, entry).toContain(entry);
  });
});
