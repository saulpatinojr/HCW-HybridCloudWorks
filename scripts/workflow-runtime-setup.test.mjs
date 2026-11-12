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
 * both run together), after a `case` pattern at the start of a line
 * (`check)`), or after a word that runs the next one (`env`, `sudo`, `xargs`,
 * `exec`, `time`, `nice`, `!`, `if`, `then`, `do` and the like) and that
 * word's options (`sudo -u nobody`, `env -i`). It counts with a path in front
 * too (`/usr/bin/python3`, `./venv/bin/python`), because a path to the
 * runner's interpreter is still the runner's, and `python3.15.2` counts like
 * `python3`. It does not count in a comment, a heredoc's body, a quoted string
 * (unless a double-quoted one runs a command with `$(`, `<(` or a backtick; a
 * single-quoted one may run over several lines, as the `bash -c '…'` script
 * of a `docker run` does) or as an argument (`docker run image python …`, or
 * the first word of a line that continues the one before it). The set-up step must come before the first such
 * step. Limits, on purpose: a job that runs in a `container:` uses that
 * image's runtime and is not checked; a script a step calls (a `.ps1` or
 * `.sh` file) is not read.
 *
 * A set-up step with its own `if:` covers a later step only when that step's
 * condition makes the set-up's true: the same condition, or one of the terms
 * the set-up's condition joins with a top-level `||`. Otherwise the set-up
 * could be skipped while the command still runs (Copilot on
 * HCW-NetworkEyes_AddOn#100). A set-up step with no `if:` covers every later
 * step whose condition does not test the job's status. Equal text means equal
 * value only for values that stay fixed during a job (`matrix`, `github`,
 * `inputs`, `needs`, `vars`); a condition on `steps.*` or `env.*` set between
 * the two steps could differ, so prefer those fixed values in such conditions.
 *
 * The job's status is compared on its own. Without `always()`, `failure()`,
 * `cancelled()` or `success()` in it, a step's condition includes an
 * unwritten `success()`, so a set-up step with no `if:` is skipped once an
 * earlier step has failed, while a later `if: always()`, `failure()` or
 * `!cancelled()` step still runs (Copilot on HCW-CloudCrawler_AddOn#73 and
 * HCW-CloudAssessor_App#97). So the statuses a later step can run under
 * (after success, after a failure, after a cancel) must all be ones its set-up
 * step runs under too, and the rule above is applied to the conditions with
 * their status-only `&&` terms taken out. `||`, `&&`, `!` and parentheses are
 * followed: `always() && !cancelled()` runs after success and failure, not
 * after a cancel.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
// Words that run the next word, each with the options it may take first:
// the letters of the options that take an argument (`sudo -u nobody`,
// `nice -n 10`), any other `-x`/`--long` flag, and the `--` that ends the
// options (`env -- node`). `timeout` also takes its duration (`timeout 60
// node`). `command` only with `-p`, because `command -v node` looks node up
// and runs nothing.
const WRAPPER_OPTIONS = { env: 'uCS', sudo: 'ugCDhprtU', xargs: 'InPLdaEs', exec: 'a', time: 'of', nice: 'n', nohup: '', stdbuf: 'ioe', timeout: 'sk' };
const optionsOf = (takes) =>
  String.raw`(?:\s+(?:${takes ? String.raw`-[A-Za-z]*[${takes}]\s*[^\s-]\S*|` : ''}--?\w[\w-]*(?:=\S+)?|--(?=\s)))*`;
const WRAPPERS = [
  ...Object.entries(WRAPPER_OPTIONS).map(([word, takes]) =>
    word === 'timeout' ? String.raw`timeout${optionsOf(takes)}\s+\d+(?:\.\d+)?[smhd]?\s+` : String.raw`${word}${optionsOf(takes)}\s+`
  ),
  String.raw`command(?:\s+-p)*\s+`,
  String.raw`(?:if|then|else|elif|do|while|until|!)\s+`,
].join('|');
// A `case` pattern that ends at the start of a line (`check)`, `a|b)`), after which a command may follow.
const CASE_PATTERN = String.raw`^[^()\s|]+(?:\|[^()\s|]+)*\)\s*`;
const START = String.raw`(?:^|[$<]\(\s*|[\x60({|;&]\s*|${CASE_PATTERN})(?:${ASSIGNMENT}|${WRAPPERS})*`;
// A runtime may be named with a path in front (`/usr/bin/python3`,
// `./venv/bin/python`): a path to the runner's own interpreter is still the
// runner's. The path holds no `=`, so an assignment (`NODE=/x/node`) is not a command.
const PATH = String.raw`(?:[^\s=]*/)?`;
const COMMAND = {
  node: new RegExp(`${START}${PATH}(?:node|npm|npx)(?=\\s|$)`),
  python: new RegExp(`${START}${PATH}(?:python(?:3(?:\\.\\d+){0,2})?|pip3?|uvx?)(?=\\s|$)`),
};
const SETUP = { node: /^actions\/setup-node@/, python: /^actions\/setup-python@/ };
// astral-sh/setup-uv sets Python up only when given a `python-version` at or above the floor (see `setsUp`).
const SETUP_UV = /^astral-sh\/setup-uv@/;
const floors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'version-floors.json'), 'utf8'));
const PYTHON_FLOOR = floors.kinds.python.floor.split('.').map(Number);

// The job statuses a step can run after, and the status functions that name them.
const STATUSES = ['success', 'failure', 'cancelled'];
const STATUS_CALL = /(!?)\s*\b(always|failure|cancelled|success)\(\s*\)/g;
const HAS_STATUS = /\b(?:always|failure|cancelled|success)\(\s*\)/;

/**
 * The script as the shell reads it, for finding commands: comments and heredoc
 * bodies dropped, a line that ends in `\` joined to the next (so the next
 * line's first word is still an argument), single-quoted text emptied, and
 * double-quoted text emptied unless it runs a command (`"$(node x)"`, or the
 * older "`node x`"). An escaped backtick (`\``, a Markdown summary line) is a
 * plain character. A quoted string may run over several lines, as the script
 * of `docker run image bash -c '…'` does; what it runs is the container's.
 */
export function shellText(run) {
  const out = [];
  let heredocs = [];
  let i = 0;
  const n = run.length;
  while (i < n) {
    const char = run[i];
    if (char === '\\' && i + 1 < n) {
      out.push(run[i + 1] === '\n' ? ' ' : run[i + 1] === '`' ? '' : run.slice(i, i + 2));
      i += 2;
    } else if (char === "'") {
      const end = run.indexOf("'", i + 1);
      out.push("''");
      i = end === -1 ? n : end + 1;
    } else if (char === '"') {
      let j = i + 1;
      let text = '';
      while (j < n && run[j] !== '"') {
        const step = run[j] === '\\' && j + 1 < n ? 2 : 1;
        text += run.slice(j, j + 2) === '\\`' ? '' : run.slice(j, j + step);
        j += step;
      }
      out.push(/[$<]\(|`/.test(text) ? `"${text}"` : '""');
      i = j + 1;
    } else if (char === '#' && (i === 0 || ' \t\n;'.includes(run[i - 1]))) {
      const end = run.indexOf('\n', i);
      i = end === -1 ? n : end;
    } else if (run.startsWith('<<', i) && !run.startsWith('<<<', i)) {
      const found = run.slice(i).match(/^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (found) heredocs.push(found[2]);
      out.push('<<');
      i += found ? found[0].length : 2;
    } else if (char === '\n' && heredocs.length) {
      out.push('\n');
      i += 1;
      for (const delimiter of heredocs) {
        while (i < n) {
          const end = run.indexOf('\n', i) === -1 ? n : run.indexOf('\n', i);
          const line = run.slice(i, end);
          i = end + 1;
          if (line.trim() === delimiter) break;
        }
      }
      heredocs = [];
    } else {
      out.push(char);
      i += 1;
    }
  }
  return out.join('');
}

/** True when a run step calls the runtime in command position (see `shellText` for what is left out). */
export function runsRuntime(run, kind) {
  return shellText(String(run ?? ''))
    .split('\n')
    .some((line) => COMMAND[kind].test(line.trim()));
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
export const statuses = (text) => new Set(STATUSES.filter((status) => runsAfter(text, status) !== false));

/**
 * Whether a condition holds after the job so far ended in `status`: true,
 * false, or null when it also depends on something else. `||`, `&&`, `!` and
 * parentheses are followed; anything that is not a status function or
 * `true`/`false` is unknown.
 */
function statusValue(expression, status) {
  let text = expression.trim();
  while (unwrap(text) !== text) text = unwrap(text);
  for (const [operator, decides] of [['||', true], ['&&', false]]) {
    const terms = orTerms(text, operator, false);
    if (terms.length > 1) {
      const values = terms.map((term) => statusValue(term, status));
      if (values.includes(decides)) return decides;
      return values.includes(null) ? null : !decides;
    }
  }
  if (text.startsWith('!') && !text.startsWith('!=')) {
    const value = statusValue(text.slice(1), status);
    return value === null ? null : !value;
  }
  const call = text.match(/^(always|failure|cancelled|success)\(\s*\)$/);
  if (call) return call[1] === 'always' || call[1] === status;
  return text === 'true' ? true : text === 'false' ? false : null;
}

/** `statusValue` of a whole condition, with GitHub's unwritten `success() &&` when it names no status function. */
function runsAfter(expression, status) {
  if (!HAS_STATUS.test(expression) && status !== 'success') return false;
  return expression ? statusValue(expression, status) : true;
}

/** The condition without its top-level `&&` terms that test only the job's status (`always()`, `!cancelled()`). */
const withoutStatus = (text) => {
  const terms = orTerms(text, '&&', false);
  const kept = terms.filter((term) => term.replace(STATUS_CALL, '').replace(/[\s!()&|]/g, ''));
  return kept.length === terms.length ? text : kept.join(' && ');
};

/** True when a set-up step with condition `setup` is sure to have run before a step with condition `step`. */
export const setupCovers = (setup, step) => {
  for (const status of [...STATUSES].sort()) {
    if (runsAfter(step, status) === false) continue;
    const runs = runsAfter(setup, status);
    if (runs === false) return false;
    if (runs === null) {
      const [rest, wanted] = [withoutStatus(setup), withoutStatus(step)];
      if (!(rest === '' || rest === wanted || orTerms(rest).includes(unwrap(wanted)))) return false;
    }
  }
  return true;
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
    // A path in front still names the runner's interpreter (Copilot on HCW-NetworkEyes_AddOn#100).
    for (const line of ['/opt/az/bin/python3 -Im pip check', '/usr/bin/python3 -I check.py', './venv/bin/python x.py', "python3.15.2 -c 'print(1)'", "/usr/bin/python3 -c 'print(1)'", 'env -i python3 check.py', 'sudo -u nobody python3 check.py', 'sudo -u runner python3 check.py', 'time -p python3 check.py', 'sudo -- python3 check.py', 'timeout -k 5 1m python3 x.py', 'stdbuf -oL python3 x.py', 'check) python3 scripts/check.py ;;']) {
      expect(runsRuntime(line, 'python'), line).toBe(true);
    }
    for (const line of ['/opt/node/bin/node x.js', 'env -i npm ci', 'nice -n 10 node x.js', 'env -- node script.mjs', 'sudo -u nobody -- node x.js', 'timeout 60 node x.js', 'nohup node x.js', 'xargs -n 1 node', 'a|b) node x.js ;;']) {
      expect(runsRuntime(line, 'node'), line).toBe(true);
    }
    // A container's script, a continued line's argument, a heredoc's body, a lookup and an assignment are not commands.
    expect(runsRuntime("docker run --rm img bash -c '\n  /opt/az/bin/python3 -Im pip check\n'", 'python')).toBe(false);
    expect(runsRuntime('docker run --rm img \\\n  /opt/az/bin/python3 -Im pip check', 'python')).toBe(false);
    expect(runsRuntime("cat > x.txt <<'EOF'\npython3 is named here\nEOF", 'python')).toBe(false);
    expect(runsRuntime('command -v node', 'node')).toBe(false);
    expect(runsRuntime('NODE_BIN=/opt/node/bin/node', 'node')).toBe(false);
    expect(runsRuntime('echo $(foo) python3 x', 'python')).toBe(false);
    expect(runsRuntime('echo x # node y', 'node')).toBe(false);
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
      // Status functions joined by `&&` and `||` (Copilot on HCW-CloudAssessor_AddOn#89).
      ['always() && !cancelled()', 'cancelled()', false],
      ['always() && !cancelled()', 'failure()', true],
      ['failure() || cancelled()', 'cancelled()', true],
      ['failure() || cancelled()', '', false],
      ['success() || failure()', '!cancelled()', true],
    ];
    for (const [setup, step, covered] of cases) expect(setupCovers(setup, step), `${setup} / ${step}`).toBe(covered);
    expect([...statuses('always() && !cancelled()')].sort()).toEqual(['failure', 'success']);
    expect([...statuses('failure() || cancelled()')].sort()).toEqual(['cancelled', 'failure']);
    expect([...statuses('!(failure() || cancelled())')]).toEqual(['success']);
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
