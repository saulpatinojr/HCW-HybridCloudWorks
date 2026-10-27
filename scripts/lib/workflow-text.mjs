/**
 * Reads the parts of a GitHub Actions workflow file that the tests in this
 * folder need, as plain text (#1428, #1429).
 *
 * A real YAML parser is not a dependency of this package, and the workflow
 * files here are written in a regular shape, so jobs, steps and matrix rows are
 * cut out by their indentation. This is shared by
 * `ci-workflow-steps.test.mjs` and `codeql-iac-workflow-steps.test.mjs`, which
 * both take a change-detection step's shell out of a workflow and run it.
 *
 * It reads only what those tests ask of it. A shape it does not know is simply
 * absent from the answer, so a test that depends on a thing it did not find
 * says so in its own words instead of passing on nothing.
 */
import { spawnSync } from 'node:child_process';

/** A YAML scalar written plain or in single quotes (the only quoting these workflows use). */
export function scalar(raw) {
  const text = raw.trim();
  const quoted = text.match(/^'(.*)'$/s);
  return quoted ? quoted[1].replace(/''/g, "'") : text;
}

/** The jobs of a workflow: their key, their own lines and their steps. */
export function parseJobs(text) {
  const start = text.indexOf('\njobs:\n');
  if (start === -1) throw new Error('the workflow has no top-level jobs: block');
  const jobs = [];
  for (const line of text.slice(start + '\njobs:\n'.length).split('\n')) {
    const key = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (key) jobs.push({ key: key[1], lines: [] });
    else jobs.at(-1)?.lines.push(line);
  }
  return jobs.map((job) => ({ ...job, steps: parseSteps(job.lines) }));
}

export function parseSteps(lines) {
  const from = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (from === -1) return [];
  const raw = [];
  for (const line of lines.slice(from + 1)) {
    if (/^ {6}- /.test(line)) raw.push([line]);
    else if (/^ {4}\S/.test(line) && !/^ {4}#/.test(line)) break;
    else raw.at(-1)?.push(line);
  }
  return raw.map(parseStep);
}

/** One step: its name, `if`, `env`, `run` (dedented) and other single-line keys. */
export function parseStep(raw) {
  const lines = raw.map((line, i) => (i === 0 ? line.replace(/^( {6})- /, '$1  ') : line));
  const step = { env: {}, lines };
  for (let i = 0; i < lines.length; i++) {
    const found = lines[i].match(/^ {8}([A-Za-z_-]+):\s*(.*)$/);
    if (!found) continue;
    const [, key, value] = found;
    if (key === 'env') {
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || /^ {10}/.test(lines[j])); j++) {
        const entry = lines[j].match(/^ {10}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
        if (entry) step.env[entry[1]] = scalar(entry[2]);
      }
    } else if (key === 'run' && value.trim() === '|') {
      const body = [];
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || /^ {10}/.test(lines[j])); j++) body.push(lines[j].slice(10));
      while (body.length && body.at(-1).trim() === '') body.pop();
      step.run = body.join('\n');
    } else if (key === 'run') {
      step.run = scalar(value);
    } else {
      step[key] = scalar(value);
    }
  }
  return step;
}

/** The matrix rows of a job, each with its single-line keys (name, dir, filter, test, language ...). */
export function parseMatrixRows(lines) {
  const rows = [];
  for (const line of lines) {
    const first = line.match(/^ {10}- ([A-Za-z-]+):\s*(.*)$/);
    const more = line.match(/^ {12}([A-Za-z-]+):\s*(.*)$/);
    if (first) rows.push({ [first[1]]: scalar(first[2]) });
    else if (more && rows.length) rows.at(-1)[more[1]] = scalar(more[2]);
    else if (/^ {4}(defaults|steps):/.test(line)) break;
  }
  return rows;
}

/**
 * Whether the tests that run a step's shell can run here: bash, git and grep
 * on the path, and a bash that is not the Windows Subsystem for Linux
 * launcher (its paths and environment are not the ones the tests use).
 */
export function findBashTools() {
  const probe = spawnSync('bash', ['-c', 'command -v git >/dev/null && command -v grep >/dev/null && echo ready; uname -r'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return { ready: false, why: 'bash did not run' };
  const [answer, kernel = ''] = probe.stdout.trim().split(/\r?\n/);
  if (answer !== 'ready') return { ready: false, why: 'git or grep is not on the path of bash' };
  if (/microsoft|wsl/i.test(kernel)) return { ready: false, why: 'bash is the Windows Subsystem for Linux, not Git Bash' };
  return { ready: true, why: '' };
}

/**
 * The `-c` settings every test git command runs with, so a developer's own
 * git configuration (signing commits or tags, converting line endings, no
 * name or address) cannot change what the throwaway repositories do.
 */
export const GIT_TEST_CONFIG = [
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'user.email=test@example.invalid',
  '-c', 'user.name=test',
];

/**
 * Whether one trimmed line of shell decides with `grep`: it starts `if`,
 * `elif`, `while` or `until` and has `grep`, `egrep` or `fgrep` on it. The
 * scan over every workflow and the check that the scan can see the shapes it
 * is meant to find both use this one function.
 */
export function isIfGrepLine(line) {
  return /^(?:if|elif|while|until)\s/.test(line) && /\b(?:grep|egrep|fgrep)\b/.test(line);
}
