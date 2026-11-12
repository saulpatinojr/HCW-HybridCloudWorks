/**
 * Every workflow job that runs Node.js or Python chooses its version (#1707).
 *
 * A job that runs `node`, `npm`, `npx`, `python3`, `pip`, `uv` or `uvx`
 * without actions/setup-node or actions/setup-python gets whatever the runner
 * image ships: on ubuntu-26.04 that was Node.js 24 and Python 3.14 in November 2026,
 * both below the floors in scripts/version-floors.json (Node.js 26, Python
 * 3.15). Nothing else would notice, because the floors test reads only the
 * versions a file names, and a job that names none has nothing to read. Six
 * jobs were found that way on 2026-11-12. `uv` and `uvx` count as Python,
 * because uv runs the interpreter it finds, the runner's own unless one was
 * set up; so astral-sh/setup-uv counts as setting Python up only when it is
 * given a `python-version` at or above the floor in version-floors.json.
 *
 * A command counts when it is in command position on a line of a `run:` step:
 * at the start, after `$(`, `<(`, a backtick, `(`, `{`, `|`, `&&`, `||` or `;`, after
 * leading `NAME=value` assignments (the value plain text, a quoted string, or
 * both run together), or after a word that runs the next one
 * (`env`, `sudo`, `xargs`, `exec`, `time`, `!`, `if`, `then`, `do` and the
 * like). It does not count inside a string, a heredoc's text or a
 * `docker run` argument. The set-up step must come before the first such
 * step. Limits, on purpose: a job that runs in a `container:` uses that
 * image's runtime and is not checked; a script a step calls (a `.ps1` or
 * `.sh` file) is not read.
 *
 * A set-up step with its own `if:` covers a later step only when that step's
 * condition makes the set-up's true: the same condition, or one of the terms
 * the set-up's condition joins with a top-level `||`. Otherwise the set-up
 * could be skipped while the command still runs (Copilot on
 * HCW-NetworkEyes_AddOn#100). A set-up step with no `if:` covers every later
 * step whose condition does not test the job's status.
 *
 * The job's status is compared on its own. Without `always()`, `failure()`,
 * `cancelled()` or `success()` in it, a step's condition includes an
 * unwritten `success()`, so a set-up step with no `if:` is skipped once an
 * earlier step has failed, while a later `if: always()`, `failure()` or
 * `!cancelled()` step still runs (Copilot on HCW-CloudCrawler_AddOn#73 and
 * HCW-CloudAssessor_App#97). So the statuses a later step can run under
 * (after success, after a failure, after a cancel) must all be ones its set-up
 * step runs under too, and the rule above is applied to the conditions with
 * their status-only `&&` terms taken out.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import floors from './version-floors.json' with { type: 'json' };

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');

/**
 * Steps that use the runner's own interpreter on purpose, each with its
 * reason, keyed by file, job, step name and runtime. Keyed by step, not job,
 * so a new step in the same job is still checked. A new entry needs a reason
 * a reviewer can check.
 */
const RUNNER_DEFAULT_ALLOWED = {
  'repository-policy.yml > validate-structure > Redaction gate over the whole tree > python':
    "the redaction gate is standard-library Python only, so the runner's python3 is enough (the comment above its step says so)",
};

// Where a command may start: the line's start or an opening/joining
// character, then any `NAME=value` assignments (the value plain text, a
// quoted string, or both run together: `FOO="a b"`) and words that run the
// next word (`env FOO=1 node`, `sudo node`, `if node …; then`).
const ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])*\s+`;
const START = String.raw`(?:^|[$<]\(\s*|[\x60({|;&]\s*)(?:${ASSIGNMENT}|(?:env|sudo|xargs|exec|time|nice|command|if|then|else|elif|do|while|until|!)\s+)*`;
const COMMAND = {
  node: new RegExp(`${START}(?:node|npm|npx)(?=\\s|$)`),
  python: new RegExp(`${START}(?:python(?:3(?:\\.\\d+)?)?|pip3?|uvx?)(?=\\s|$)`),
};
const SETUP = { node: /^actions\/setup-node@/, python: /^actions\/setup-python@/ };
// astral-sh/setup-uv sets Python up only when given a `python-version` at or above the floor (see `setsUp`).
const SETUP_UV = /^astral-sh\/setup-uv@/;
const PYTHON_FLOOR = floors.kinds.python.floor.split('.').map(Number);

// The job statuses a step can run after, and the status functions that name them.
const STATUSES = ['success', 'failure', 'cancelled'];
const STATUS_CALL = /(!?)\s*\b(always|failure|cancelled|success)\(\s*\)/g;

/**
 * A line with the text of its quoted strings taken out, so words in a message
 * (`echo "…; if pip named it…"`) do not count. A double-quoted string that
 * runs a command (`"$(node x)"`) is kept.
 */
const withoutQuotedText = (line) =>
  line
    .replace(/\\`/g, '') // an escaped backtick is a literal character, not a command
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, (q) => (/[$<]\(|`/.test(q) ? q : '""'));

/** True when a run step calls the runtime in command position on a line that is not a comment. */
export function runsRuntime(run, kind) {
  return String(run ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .some((line) => COMMAND[kind].test(withoutQuotedText(line)));
}

/** A step's `if:` as one comparable expression: no `${{ }}` around it, whitespace collapsed; '' when it has none. */
export const condition = (step) =>
  String(step?.if ?? '')
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** Strips one pair of parentheses that wraps the whole expression. */
const unwrap = (text) => {
  if (!text.startsWith('(') || !text.endsWith(')')) return text;
  let depth = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    if (depth === 0) return text; // the opening parenthesis closes before the end
  }
  return text.slice(1, -1).trim();
};

/** The terms a condition joins with `||` (or `&&`) at its top level (outside parentheses and quotes). */
export function orTerms(text, operator = '||', unwrapEach = true) {
  const terms = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && text.startsWith(operator, i)) {
      terms.push(text.slice(start, i).trim());
      start = i + operator.length;
      i += operator.length - 1;
    }
  }
  terms.push(text.slice(start).trim());
  return unwrapEach ? terms.map(unwrap) : terms;
}

/**
 * The job statuses a step with this condition can run after: `success` alone when it names no status function (the
 * unwritten `success()`), all three for `always()`, `success` and `failure` for `!cancelled()`, and so on.
 */
export function statuses(text) {
  const found = [...text.matchAll(STATUS_CALL)];
  if (!found.length) return new Set(['success']);
  const named = new Set();
  for (const [, negated, call] of found) {
    const meant = call === 'always' ? STATUSES : [call];
    for (const status of STATUSES) if (meant.includes(status) !== Boolean(negated)) named.add(status);
  }
  return named;
}

/** The condition without its top-level `&&` terms that test only the job's status (`always()`, `!cancelled()`). */
const withoutStatus = (text) => {
  const terms = orTerms(text, '&&', false);
  const kept = terms.filter((term) => term.replace(STATUS_CALL, '').replace(/[\s!()&|]/g, ''));
  return kept.length === terms.length ? text : kept.join(' && ');
};

/** True when a set-up step with condition `setup` is sure to have run before a step with condition `step`. */
export const setupCovers = (setup, step) => {
  const given = statuses(setup);
  if (![...statuses(step)].every((status) => given.has(status))) return false;
  const [rest, wanted] = [withoutStatus(setup), withoutStatus(step)];
  return rest === '' || rest === wanted || orTerms(rest).includes(unwrap(wanted));
};

/** True when a line-only version (`3.15`) or an exact one (`3.15.2`) is at or above the Python floor. */
const meetsPythonFloor = (version) => {
  const found = String(version).trim().match(/^v?(\d+(?:\.\d+)*)/);
  if (!found) return false;
  const numbers = found[1].split('.').map(Number).slice(0, 3);
  for (let i = 0; i < numbers.length; i++) if (numbers[i] !== PYTHON_FLOOR[i]) return numbers[i] > PYTHON_FLOOR[i];
  return true;
};

/**
 * True when the step chooses the runtime for the steps after it: actions/setup-node or actions/setup-python, or, for
 * Python, astral-sh/setup-uv given a literal `python-version` at or above the floor (without one, uv uses the
 * runner's Python; scripts/version-floors.test.mjs reads the pins themselves).
 */
export function setsUp(step, kind) {
  const uses = String(step?.uses ?? '');
  if (kind === 'python' && SETUP_UV.test(uses)) {
    const version = step.with?.['python-version'];
    return version !== undefined && meetsPythonFloor(version);
  }
  return SETUP[kind].test(uses);
}

/** The steps of one workflow that run a runtime before (or without) setting it up: "file > job > step > kind". */
export function unsetJobs(file, workflow) {
  const found = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    if (!Array.isArray(job?.steps) || job.container) continue;
    for (const kind of Object.keys(COMMAND)) {
      job.steps.forEach((step, i) => {
        if (!runsRuntime(step.run, kind)) return;
        // Covered by an earlier set-up step that always runs, or that runs under the same condition as this step.
        const covered = job.steps.slice(0, i).some((earlier) => setsUp(earlier, kind) && setupCovers(condition(earlier), condition(step)));
        if (!covered) found.push(`${file} > ${name} > ${step.name ?? `step ${i + 1}`} > ${kind}`);
      });
    }
  }
  return found;
}

describe('runsRuntime and unsetJobs', () => {
  it('finds node and python in command position, not inside strings or arguments', () => {
    expect(runsRuntime('token=$(node scripts/github-app-token.mjs)', 'node')).toBe(true);
    expect(runsRuntime('npm ci --no-audit', 'node')).toBe(true);
    expect(runsRuntime('cat x | python3 -I check.py', 'python')).toBe(true);
    // Escaped backticks print as text (a Markdown summary line); unescaped ones run a command.
    expect(runsRuntime('echo "run \\`node scripts/x.mjs\\` by hand"', 'node')).toBe(false);
    expect(runsRuntime('docker run --rm img python -c "import azure"', 'python')).toBe(false);
    expect(runsRuntime('/opt/az/bin/python3 -Im pip check', 'python')).toBe(false);
    expect(runsRuntime('# node is not run here', 'node')).toBe(false);
    expect(runsRuntime('for node in items["nodes"]:', 'node')).toBe(false);
    // The forms a pre-PR review found the first version missed.
    for (const line of ['FOO=1 node x', 'env FOO=1 node x', 'sudo node x', 'xargs node x', 'diff a <(node x)', '(node x)', 'if node x; then', '! node x', 'time node x', 'exec node x', 'cd y && npm ci']) {
      expect(runsRuntime(line, 'node'), line).toBe(true);
    }
    expect(runsRuntime('python3.15 -I x.py', 'python')).toBe(true);
    expect(runsRuntime('uv sync --frozen', 'python')).toBe(true);
    // Backtick command substitution, bare and inside double quotes; single quotes stay literal.
    expect(runsRuntime('version=`python3 scripts/check.py`', 'python')).toBe(true);
    expect(runsRuntime('echo "`node --version`"', 'node')).toBe(true);
    expect(runsRuntime("echo 'literal `python3` text'", 'python')).toBe(false);
    expect(runsRuntime('uvicorn app:main', 'python')).toBe(false);
    expect(runsRuntime('echo "$NODE_VERSION"', 'node')).toBe(false);
    expect(runsRuntime('nodes=3 nodejs-check', 'node')).toBe(false);
    expect(runsRuntime('echo "the stage is wrong; if pip named the file differently, look"', 'python')).toBe(false);
    expect(runsRuntime('token="$(node scripts/github-app-token.mjs)"', 'node')).toBe(true);
    // An assignment's value may be quoted (Copilot on HCW-MigrateOrchestrator_AddOn#72), and uv runs Python.
    expect(runsRuntime('FOO="bar baz" python3 check.py', 'python')).toBe(true);
    expect(runsRuntime("env FOO='bar baz' node x.js", 'node')).toBe(true);
    expect(runsRuntime('STAMP="$(date +%s) run" python3 check.py', 'python')).toBe(true);
    expect(runsRuntime('FOO="python3 x" true', 'python')).toBe(false);
    expect(runsRuntime('uv run python scripts/check.py', 'python')).toBe(true);
    expect(runsRuntime('uvx zizmor .github', 'python')).toBe(true);
  });

  it('flags a job that sets the runtime up after first using it, or not at all', () => {
    const wf = {
      jobs: {
        late: { steps: [{ name: 'Early', run: 'node a.mjs' }, { uses: 'actions/setup-node@abc' }] },
        none: { steps: [{ run: 'python3 b.py' }] },
        uvOnly: { steps: [{ uses: 'astral-sh/setup-uv@abc' }, { name: 'Run', run: 'python3 c.py' }] },
        uvNew: { steps: [{ uses: 'astral-sh/setup-uv@abc', with: { 'python-version': '3.15' } }, { name: 'Run', run: 'uv run pytest' }] },
        uvOld: { steps: [{ uses: 'astral-sh/setup-uv@abc', with: { 'python-version': '3.14' } }, { name: 'Run', run: 'uv run pytest' }] },
        good: { steps: [{ uses: 'actions/setup-node@abc' }, { run: 'node a.mjs' }] },
        boxed: { container: 'node:26', steps: [{ run: 'node a.mjs' }] },
      },
    };
    expect(unsetJobs('x.yml', wf)).toEqual(['x.yml > late > Early > node', 'x.yml > none > step 1 > python', 'x.yml > uvOnly > Run > python', 'x.yml > uvOld > Run > python']);
  });

  it('counts a set-up step with its own condition only for steps under the same condition', () => {
    const py = { uses: 'actions/setup-python@abc' };
    const wf = {
      jobs: {
        skipped: { steps: [{ ...py, if: false }, { name: 'Run', run: 'python3 a.py' }] },
        sameCondition: { steps: [{ ...py, if: '${{ !cancelled() }}' }, { name: 'Run', if: '!cancelled()', run: 'python3 a.py' }] },
        unconditionalSetup: { steps: [py, { name: 'Run', if: "github.ref == 'refs/heads/main'", run: 'python3 a.py' }] },
        // The unwritten success(): a set-up step with no `if:` is skipped after a failure, an always() step is not.
        afterAFailure: { steps: [py, { name: 'Run', if: 'always()', run: 'python3 a.py' }] },
        afterAFailureSetUpToo: { steps: [{ ...py, if: 'always()' }, { name: 'Run', if: 'failure()', run: 'python3 a.py' }] },
        otherCondition: { steps: [{ ...py, if: "github.event_name == 'push'" }, { name: 'Run', if: 'failure()', run: 'python3 a.py' }] },
        // ci.yml's verify job: the set-up runs for either term, the step for the second.
        orTerm: { steps: [{ ...py, if: "matrix.relevant == 'true' || matrix.name == 'scripts (operations)'" }, { name: 'Run', if: "matrix.name == 'scripts (operations)'", run: 'python3 a.py' }] },
        andTerm: { steps: [{ ...py, if: "a == 'x' && b == 'y'" }, { name: 'Run', if: "b == 'y'", run: 'python3 a.py' }] },
      },
    };
    expect(unsetJobs('x.yml', wf)).toEqual(['x.yml > skipped > Run > python', 'x.yml > afterAFailure > Run > python', 'x.yml > otherCondition > Run > python', 'x.yml > andTerm > Run > python']);
    expect(orTerms("(a || b) || c == 'x || y'")).toEqual(['a || b', "c == 'x || y'"]);
    expect(condition({ if: '${{  a &&   b }}' })).toBe('a && b');
  });

  it('compares the job status a set-up step runs after with the later step\'s', () => {
    const cases = [
      ['', '', true],
      ['', 'always()', false],
      ['', '!cancelled()', false],
      ['', 'failure()', false],
      ['!cancelled()', '!cancelled()', true],
      ['always()', 'failure()', true],
      ['always()', 'cancelled()', true],
      ['!cancelled()', 'always()', false],
      ['!cancelled()', 'cancelled()', false],
      ['failure()', '', false],
      ['always() && a', 'a', true],
      ['always() && a', '!cancelled() && a', true],
      ['a', 'failure() && a', false],
      ['always()', 'a || b', true],
      ['(a || b) && c', 'a', false],
    ];
    for (const [setup, step, covered] of cases) expect(setupCovers(setup, step), `${setup} / ${step}`).toBe(covered);
  });
});

describe('.github/workflows', () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  const unset = files.flatMap((file) => unsetJobs(file, parse(readFileSync(join(WORKFLOWS, file), 'utf8'))));

  it('every step that runs Node.js or Python comes after its version is set up, so the runner image never chooses it', () => {
    expect(unset.filter((entry) => !(entry in RUNNER_DEFAULT_ALLOWED))).toEqual([]);
  });

  it('every allowed exception still exists, so the list cannot hide a job that has since changed', () => {
    for (const [entry, reason] of Object.entries(RUNNER_DEFAULT_ALLOWED)) {
      expect(unset, entry).toContain(entry);
      // An exception without a reason a reviewer can check is not an exception (Copilot on HCW-CloudAssessor_AddOn#89).
      expect(String(reason ?? '').trim(), `${entry} gives no reason`).not.toBe('');
    }
  });
});
