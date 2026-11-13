/**
 * Every workflow job that runs Node.js or Python chooses its version (#1707).
 *
 * A job that runs `node`, `npm`, `npx`, `yarn`, `pnpm`, `python3`, `pip`,
 * `pipx`, `pytest`, `uv` or `uvx` without actions/setup-node or
 * actions/setup-python gets whatever the runner image ships: on ubuntu-26.04
 * that was Node.js 24 and Python 3.14 in November 2026, both below the
 * floors in scripts/version-floors.json (Node.js 26, Python 3.15). Nothing
 * else would notice, because the floors test reads only the versions a file
 * names, and a job that names none has nothing to read. Six jobs were found
 * that way on 2026-11-12. `uv` and `uvx` count as Python,
 * because uv runs the interpreter it finds, the runner's own unless one was
 * set up; so astral-sh/setup-uv counts as setting Python up only when it is
 * given a `python-version` at or above the floor in version-floors.json.
 * `yarn` and `pnpm` are Node.js programs and count as Node.js; `pytest` and
 * `pipx` are Python programs and count as Python. pipx makes each tool's
 * virtual environment from the interpreter pipx itself runs on unless it is
 * given `--python` or `PIPX_DEFAULT_PYTHON`
 * (https://pipx.pypa.io/latest/reference/environment-variables.html), and
 * GitHub's Ubuntu runner images install pipx with the image's own python3
 * (actions/runner-images#14654), so setting Python up is not enough. A step
 * that runs `pipx` in command position must also choose its interpreter:
 * `--python` among that pipx command's own words (`pipx run --python
 * "$PYTHON_PATH" …`, with actions/setup-python's `python-path` output), or
 * `PIPX_DEFAULT_PYTHON` set in front of it (`PIPX_DEFAULT_PYTHON=/p pipx …`)
 * or in the step's, job's or workflow's `env:` (Copilot on
 * HCW-NetworkEyes_App#393). A step that does not is reported, named; one
 * kept that way on purpose is listed, with its reason, in PIPX_ALLOWED. An
 * `export PIPX_DEFAULT_PYTHON=…` earlier in the script is not read; use
 * `env:` instead.
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
 * the first word of a line that continues the one before it). One more quoted
 * string is read: the script of a shell that is itself in command position
 * and given `-c` (`bash -c 'node x'`, `sh -euo pipefail -c "…"`, `sudo bash
 * -lc '…'`, `bash -c -- '…'`). That script runs on the runner, so its
 * commands count, while the same words after `docker run image` stay a
 * container's; an unquoted script is the one word after `-c` (`bash -c node
 * x.js` runs `node`, while `bash -c echo node` does not). A double-quoted `-c` script is read both ways: as the outer
 * shell reads it (its `$(…)` and backticks run first) and as the inner shell
 * does. The set-up step must come before the first such step. Limits, on
 * purpose: a job that runs in a `container:` uses that image's runtime and is
 * not checked; a script a step calls (a `.ps1` or `.sh` file) is not read, so
 * a step that starts a runtime that way is listed in INDIRECT_RUNTIME. A
 * command substitution inside a double-quoted string (`"$(…)"`, or a
 * backtick pair) runs on the runner, so it is read like any other script, a
 * `-c` script in it included (`echo "$(bash -c 'node x')"`); one that hands
 * its script to a container (`"$(docker run img bash -c '…')"`) stays
 * unread. The same check is
 * copied into the add-on and App repositories; keep the logic the same in
 * each copy and change only the lists and comments.
 *
 * A set-up step with its own `if:` covers a later step only when that step's
 * condition makes the set-up's true: the same condition, one of the terms
 * the set-up's condition joins with a top-level `||`, or a condition that
 * joins one of those with a top-level `&&` and has no top-level `||` of its
 * own (`a && b` runs only when `a` holds; `a && b || d` can run through `d`
 * alone, so it is not split; Copilot on HCW-NetworkEyes_App#393). Otherwise
 * the set-up could be skipped while the command still runs (Copilot on
 * HCW-NetworkEyes_AddOn#100). A set-up step with no `if:` covers every later
 * step whose condition does not test the job's status. Equal text means equal
 * value only for values that stay fixed during a job (`matrix`, `github`,
 * `inputs`, `needs`, `vars`, `secrets`); a term that reads anything else
 * (`env.*`, which a step can change through `$GITHUB_ENV`, `steps.*`, `job`,
 * `runner`, `hashFiles()`) is never matched by its text, so its step is
 * reported (Copilot on HCW-MigrateOrchestrator_AddOn#74). The one exception
 * is `steps.<id>` of a step that comes before the set-up step: its outputs,
 * outcome and conclusion are fixed once it has run (the `core-update.yml`
 * jobs' `steps.refs.outputs.changed`). Prefer the fixed values in such
 * conditions.
 *
 * The job's status is compared on its own. Without `always()`, `failure()`,
 * `cancelled()` or `success()` in it, a step's condition includes an
 * unwritten `success()`, so a set-up step with no `if:` is skipped once an
 * earlier step has failed, while a later `if: always()`, `failure()` or
 * `!cancelled()` step still runs (Copilot on HCW-CloudCrawler_AddOn#73 and
 * HCW-CloudAssessor_App#97). So the statuses a later step can run under
 * (after success, after a failure, after a cancel) must all be ones its set-up
 * step runs under too, and the rule above is applied to the conditions with
 * their status-only `&&` terms taken out, but only from a condition with no
 * top-level `||`: `failure() && a || b` is `(failure() && a) || b`, so taking
 * `failure()` out would change it (Copilot on HCW-MigrateOrchestrator_AddOn#74).
 * `||`, `&&`, `!` and parentheses are
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

/**
 * Steps that start a runtime indirectly, through a script or program the
 * check cannot read in the `run:` text (`bash scripts/build.sh` that runs
 * `node`, say). Each counts as running that runtime, so its set-up step must
 * come first. Same keys as above, each with a reason; a key that no longer
 * names a step fails the test, so a renamed or removed step cannot leave the
 * list pointing at nothing. The `verify` job of `ci.yml` runs each matrix
 * row's command (`npm run lint`, `npm test`, …) as `bash -eo pipefail -c
 * "$COMMAND"`, with the command in the step's `env:` from the matrix, which
 * the check cannot read, so those five steps are listed here. The four
 * `role-tests` entries run a test script that starts `node` or `python3`
 * (found by reading every script a workflow step calls, 2026-11-13); the
 * lab-images-role one was a live gap a review found (Copilot on #1716): its
 * Node.js set-up step came long after it, so it ran the runner's own Node.js.
 */
const VERIFY_COMMAND = "runs `bash -eo pipefail -c \"$COMMAND\"`, where `COMMAND` is the matrix row's npm command, which the check cannot read";
const INDIRECT_RUNTIME = {
  'ci.yml > verify > Lint > node': VERIFY_COMMAND,
  'ci.yml > verify > Format check > node': VERIFY_COMMAND,
  'ci.yml > verify > Route validation > node': VERIFY_COMMAND,
  'ci.yml > verify > Build > node': VERIFY_COMMAND,
  'ci.yml > verify > Test > node': VERIFY_COMMAND,
  'ci.yml > role-tests > lab-images-role test > node':
    '`bash roles/lab_images/tests/lab-images-role.test.sh` runs `node "${helper}"` on the role\'s plan helper and `node -e`',
  'ci.yml > role-tests > hcw-docker-stale-bridges test > python':
    '`bash roles/docker/tests/hcw-docker-stale-bridges.test.sh` runs `python3` on the role\'s stale-bridges helper',
  'ci.yml > role-tests > hcw-docker-volume-carry test > python':
    '`sudo bash roles/docker/tests/hcw-docker-volume-carry.test.sh` runs `python3` on the role\'s volume-carry helper',
  'ci.yml > role-tests > ufw closed-ports test > python':
    '`bash roles/hardening/tests/ufw-closed-ports.test.sh` runs `python3 "${work}/listen.py"`',
};

/**
 * Steps that run `pipx` without choosing its interpreter (`--python` or
 * PIPX_DEFAULT_PYTHON) on purpose, keyed by "file > job > step name > pipx",
 * each with its reason. Empty: no workflow here runs pipx.
 */
const PIPX_ALLOWED = {};

// Where a command may start: the line's start or an opening/joining
// character, then any `NAME=value` assignments (the value plain text, a
// quoted string, or both run together: `FOO="a b"`) and words that run the
// next word (`env FOO=1 node`, `sudo node`, `if node …; then`).
const ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])*\s+`;
// Words that run the next word, each with the options it may take first:
// the letters of the options that take an argument (`sudo -u nobody`,
// `nice -n 10`), any other `-x`/`--long` flag, and the `--` that ends the
// options (`env -- node`). `timeout` also takes its duration (`timeout 60
// node`). `command` only with `-p` or `--`, because `command -v node` looks node up
// and runs nothing. An option that takes an argument always takes the next
// word (so `sudo -u node whoami` runs whoami, not node), and an option can be
// read only one way: otherwise twenty `-oL`s make the match try every split
// (the same pattern as the Python copies, HCW-NetworkEyes_App's
// tests/security/test_workflow_runtime_setup.py).
const WRAPPER_OPTIONS = { env: 'uCS', sudo: 'ugCDhprtU', xargs: 'InPLdaEs', exec: 'a', time: 'of', nice: 'n', nohup: '', stdbuf: 'ioe', timeout: 'sk' };
// The long options of those words that take a value (`timeout --kill-after 5 10 node`, `sudo --user nobody node`),
// the long forms of the letters above: the value follows `=` or is the next word, which never starts with `-`. Any
// other `--long[=value]` is a flag, so each long option too can be read only one way (Copilot on
// HCW-MigrateOrchestrator_AddOn#74).
const WRAPPER_LONG_OPTIONS = {
  env: ['unset', 'chdir', 'split-string'],
  sudo: ['user', 'group', 'close-from', 'chdir', 'host', 'prompt', 'role', 'type', 'other-user'],
  xargs: ['max-args', 'max-procs', 'delimiter', 'arg-file', 'max-chars', 'process-slot-var'],
  time: ['output', 'format'],
  nice: ['adjustment'],
  stdbuf: ['input', 'output', 'error'],
  timeout: ['signal', 'kill-after'],
};
const longOptionsOf = (names) =>
  names.length
    ? String.raw`--(?:${names.join('|')})(?:=\S*|\s+[^\s-]\S*)|--(?!(?:${names.join('|')})(?![\w-]))\w[\w-]*(?:=\S+)?`
    : String.raw`--\w[\w-]*(?:=\S+)?`;
const optionsOf = (takes, long = []) =>
  takes
    ? String.raw`(?:\s+(?:-(?:(?![${takes}])[A-Za-z])*[${takes}](?:\s+[^\s-]\S*|\S+)|${longOptionsOf(long)}|-(?:(?![${takes}])\w)+|--(?=\s)))*`
    : String.raw`(?:\s+(?:${longOptionsOf(long)}|-\w+|--(?=\s)))*`;
// A shell option (`-e`, `-o pipefail`, `-O extglob`, `--rcfile /tmp/rc`, `--login`, the `--` that ends them),
// `letters` being the letters a short option may hold. The options that take an argument (`-o`, `-O`, `--rcfile`,
// `--init-file`) never take one starting with `-`, so an option can be read only one way (otherwise `-o -o -o …`
// makes the match try every split).
const shellOption = (letters) =>
  String.raw`(?:[-+]${letters}*[oO]\s+[^\s-][\w-]*|--(?:rcfile|init-file)\s+[^\s-]\S*|[-+]${letters}+|--[\w-]+|--(?=\s))`;
// A shell given `-c`, with its options. The options before it hold no `c`, so the first short option that holds one
// is the `-c` (`-c`, `-lc`, `-ec`), and a long run of options can be read only one way.
const SHELL_GIVEN_C = String.raw`(?:ba|da|k|z)?sh(?:\s+${shellOption('(?:(?!c)[A-Za-z])')})*\s+-(?:(?!c)[A-Za-z])*c[A-Za-z]*(?:\s+${shellOption('[A-Za-z]')})*\s+`;
// A shell given `-c` is also a word that runs the next one: an unquoted script is that one word (`bash -c node x.js`
// runs `node`, with `x.js` as its `$0`). A quoted script is read by `shellText` instead.
const SHELL_C = String.raw`(?:[^\s=]*/)?${SHELL_GIVEN_C}`;
const WRAPPERS = [
  ...Object.entries(WRAPPER_OPTIONS).map(([word, takes]) =>
    word === 'timeout'
      ? String.raw`timeout${optionsOf(takes, WRAPPER_LONG_OPTIONS[word])}\s+\d+(?:\.\d+)?[smhd]?\s+`
      : String.raw`${word}${optionsOf(takes, WRAPPER_LONG_OPTIONS[word])}\s+`
  ),
  String.raw`command(?:\s+(?:-p|--(?=\s)))*\s+`,
  String.raw`(?:if|then|else|elif|do|while|until|!)\s+`,
  SHELL_C,
].join('|');
// A `case` pattern that ends at the start of a line (`check)`, `a|b)`), after which a command may follow.
const CASE_PATTERN = String.raw`^[^()\s|]+(?:\|[^()\s|]+)*\)\s*`;
const START = String.raw`(?:^|[$<]\(\s*|[\x60({|;&]\s*|${CASE_PATTERN})(?:${ASSIGNMENT}|${WRAPPERS})*`;
// A runtime may be named with a path in front (`/usr/bin/python3`,
// `./venv/bin/python`): a path to the runner's own interpreter is still the
// runner's. The path holds no `=`, so an assignment (`NODE=/x/node`) is not a command.
const PATH = String.raw`(?:[^\s=]*/)?`;
// yarn and pnpm are Node.js programs; pytest and pipx are Python programs, so they run on the interpreter they were
// installed with, which is the runner's own unless a set-up step came first (pipx also builds each tool's virtual
// environment from that interpreter unless it is given `--python`).
const COMMAND = {
  node: new RegExp(`${START}${PATH}(?:node|npm|npx|yarn|pnpm)(?=\\s|$)`),
  python: new RegExp(`${START}${PATH}(?:python(?:3(?:\\.\\d+){0,2})?|pip3?|pipx|pytest|uvx?)(?=\\s|$)`),
};
// A shell in command position given a script with `-c` (`bash -c '…'`, `sh -euo pipefail -c "…"`, `sudo bash -lc
// '…'`): the script runs on the runner too, so its commands count. The same words after `docker run image` are not
// in command position, so a container's script stays unread.
const SHELL_SCRIPT = new RegExp(`${START}${PATH}${SHELL_GIVEN_C}$`);
// `pipx` in command position, with what comes before it (its assignments and wrappers) and its words, up to the end
// of the command (`;`, `&`, `|` or `)`). It has chosen its interpreter when `--python` is one of pipx's own options
// (see `pipxOptionChoosesPython`) or `PIPX_DEFAULT_PYTHON` is one of the assignments in front of it.
const PIPX = new RegExp(`(?<before>${START})${PATH}pipx(?=\\s|$)(?<words>[^;&|)]*)`, 'g');
// An assignment word (`NAME=value`, the value plain, quoted or both) that starts a word, as ASSIGNMENT reads one: so in
// `FOO=PIPX_DEFAULT_PYTHON=/p` the name is FOO, and the rest is FOO's value.
const ASSIGNMENT_WORD = /(?:^|(?<=[\s;&|({`]))([A-Za-z_][A-Za-z0-9_]*)=((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])*)(?=\s|$)/g;
// pipx's options that take a value as the next word, so that word is not read as an option or as the app's name.
const PIPX_VALUE_OPTIONS = new Set(['--spec', '--python', '--index-url', '--pip-args', '--suffix', '--preinstall', '--backend', '--fetch-python']);
// Where `((` opens an arithmetic command rather than two subshells: at the start of a command.
const ARITHMETIC_COMMAND = /(?:^|[;&|({]|\b(?:then|else|do|if|elif|while|until|for))\s*$/;
// The escapes `$'…'` turns into other characters; any other `\x` is left as it is.
const ANSI_C = { n: '\n', t: '\t', "'": "'", '"': '"', '\\': '\\' };
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
 * bodies dropped (`<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`, `<<-EOF`, but not
 * the shift `<<` inside `$((…))` or `((…))`), a line that ends in `\` joined
 * to the next (so the next line's first word is still an argument),
 * single-quoted text and `$'…'` text written as `'_'` (`''` when empty), and double-quoted text as `"_"` (`""` when empty)
 * unless it runs a command (`"$(node x)"`, or the older "`node x`"). An
 * escaped backtick (`\``, a Markdown summary line) is a plain character. A
 * quoted string may run over several lines, as the script of `docker run image
 * bash -c '…'` does; what it runs is the container's. The one quoted string
 * that is read is the script of a shell in command position given `-c`
 * (`bash -c 'node x'`): it is read the same way, on lines of its own, and the
 * line after it starts with `:` so that the words after the script (the inner
 * shell's `$0` and arguments) are still arguments.
 */
/**
 * The index of the `)` that closes the `$(` at `at`, or the end of the text: escapes, quoted strings and the
 * substitutions inside them are skipped, so their quotes and parentheses do not count.
 */
function substitutionClose(run, at) {
  const n = run.length;
  let depth = 0;
  let k = at + 1;
  while (k < n) {
    const char = run[k];
    if (char === '\\') k += 2;
    else if (char === "'") {
      const end = run.indexOf("'", k + 1);
      k = end === -1 ? n : end + 1;
    } else if (char === '"') {
      k += 1;
      while (k < n && run[k] !== '"') {
        if (run[k] === '\\') k += 2;
        else if (run.startsWith('$(', k)) k = substitutionClose(run, k) + 1;
        else k += 1;
      }
      k += 1;
    } else {
      depth += char === '(' ? 1 : char === ')' ? -1 : 0;
      if (depth === 0) return k;
      k += 1;
    }
  }
  return n;
}

/** The index of the backtick that closes the one at `at` (an escaped one does not), or the end of the text. */
function backtickClose(run, at) {
  let k = at + 1;
  while (k < run.length && run[k] !== '`') k += run[k] === '\\' ? 2 : 1;
  return Math.min(k, run.length);
}

export function shellText(run) {
  const out = [];
  let heredocs = [];
  // Open parentheses inside `$((…))` or `((…))`, where `<<` is a shift; 0 outside.
  let arithmetic = 0;
  let i = 0;
  const n = run.length;
  const line = () => {
    const text = out.join('');
    return text.slice(text.lastIndexOf('\n') + 1);
  };
  // A `-c` script keeps the outer reading too: the outer shell runs a `$(…)` or backtick in a double-quoted script
  // before the inner shell starts (`bash -c "echo '$(node x)'"`).
  const quoted = (script, text) => out.push(SHELL_SCRIPT.test(line().trimStart()) ? `${text}\n${shellText(script)}\n:` : text);
  while (i < n) {
    const char = run[i];
    if (char === '\\' && i + 1 < n) {
      out.push(run[i + 1] === '\n' ? ' ' : run[i + 1] === '`' ? '' : run.slice(i, i + 2));
      i += 2;
    } else if (char === '$' && run[i + 1] === "'") {
      // `$'…'` may hold `\'`, which does not end it.
      let j = i + 2;
      while (j < n && run[j] !== "'") j += run[j] === '\\' ? 2 : 1;
      quoted(run.slice(i + 2, j).replace(/\\([\s\S])/g, (escape, c) => ANSI_C[c] ?? escape), j > i + 2 ? "'_'" : "''");
      i = j + 1;
    } else if (char === "'") {
      const end = run.indexOf("'", i + 1) === -1 ? n : run.indexOf("'", i + 1);
      quoted(run.slice(i + 1, end), end > i + 1 ? "'_'" : "''");
      i = end + 1;
    } else if (char === '"') {
      // A command substitution in the string (`$(…)`, or a backtick pair) may hold quotes of its own, and it runs on
      // the runner, so its script is read like any other. As text, an escaped backtick prints.
      let j = i + 1;
      const parts = [];
      while (j < n && run[j] !== '"') {
        if (run[j] === '\\') {
          parts.push(run.slice(j, j + 2) === '\\`' ? '' : run.slice(j, j + 2));
          j += 2;
        } else if (run.startsWith('$(', j) && !run.startsWith('$((', j)) {
          const close = substitutionClose(run, j);
          parts.push(`$(${shellText(run.slice(j + 2, close))})`);
          j = close + 1;
        } else if (run[j] === '`') {
          const close = backtickClose(run, j);
          parts.push(`\`${shellText(run.slice(j + 1, close))}\``);
          j = close + 1;
        } else {
          parts.push(run[j]);
          j += 1;
        }
      }
      const raw = run.slice(i + 1, Math.min(j, n));
      const text = parts.join('');
      // Given to `-c`, the inner shell runs the script, an escaped backtick included.
      quoted(raw.replace(/\\([\\"$`\n])/g, (escape, c) => (c === '\n' ? '' : c)), /[$<]\(|`/.test(text) ? `"${text}"` : text ? '"_"' : '""');
      i = j + 1;
    } else if (char === '#' && (i === 0 || ' \t\n;'.includes(run[i - 1]))) {
      const end = run.indexOf('\n', i);
      i = end === -1 ? n : end;
    } else if (!arithmetic && (run.startsWith('$((', i) || (run.startsWith('((', i) && ARITHMETIC_COMMAND.test(line())))) {
      const open = char === '$' ? '$((' : '((';
      out.push(open);
      i += open.length;
      arithmetic = 2;
    } else if (arithmetic && (char === '(' || char === ')')) {
      arithmetic += char === '(' ? 1 : -1;
      out.push(char);
      i += 1;
    } else if (!arithmetic && run.startsWith('<<', i) && !run.startsWith('<<<', i)) {
      const found = run.slice(i).match(/^<<-?\s*(\\?)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
      if (found) heredocs.push(found[3]);
      out.push('<<');
      i += found ? found[0].length : 2;
    } else if (char === '\n' && heredocs.length) {
      out.push('\n');
      i += 1;
      for (const delimiter of heredocs) {
        while (i < n) {
          const end = run.indexOf('\n', i) === -1 ? n : run.indexOf('\n', i);
          const text = run.slice(i, end);
          i = end + 1;
          if (text.trim() === delimiter) break;
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

/**
 * The condition without its top-level `&&` terms that test only the job's status (`always()`, `!cancelled()`), when
 * it has no top-level `||`: `failure() && a || b` is `(failure() && a) || b`, and `a || b` holds when it does not
 * (Copilot on HCW-MigrateOrchestrator_AddOn#74).
 */
const withoutStatus = (text) => {
  if (orTerms(text).length > 1) return text;
  const terms = orTerms(text, '&&', false);
  const kept = terms.filter((term) => term.replace(STATUS_CALL, '').replace(/[\s!()&|]/g, ''));
  return kept.length === terms.length ? text : kept.join(' && ');
};

// A name in a condition whose value is not fixed for the whole job: `env` (a step can write `$GITHUB_ENV`), `steps`,
// `job`, `jobs` and `hashFiles()`. `runner` and `strategy` are fixed for the whole job, like `matrix`. Outside quoted strings and not after a `.`, so
// `needs.build.outputs.env` and `'env.x'` are not one.
const CHANGING = /(?<![\w.-])(?:env|steps|job|jobs|hashfiles)(?![\w-])/i;
/**
 * True when a term reads only values fixed from the set-up step on, so equal text means an equal value: no name in
 * CHANGING, apart from `steps.<id>` of a step in `ran` (the ids of the steps before the set-up step, whose outputs,
 * outcome and conclusion no longer change).
 */
const fixedTerm = (term, ran = new Set()) =>
  !CHANGING.test(
    term.replace(/'(?:[^']|'')*'/g, "''").replace(/(?<![\w.-])steps\.([\w-]+)/gi, (whole, id) => (ran.has(id) ? 'ran' : whole))
  );
/** The ids of these steps, for `setupCovers`. */
export const stepIds = (steps) => new Set((steps ?? []).map((step) => step?.id).filter((id) => id !== undefined && id !== null).map(String));

/**
 * True when a set-up step with condition `setup` is sure to have run before a step with condition `step`. Apart from
 * the job status, the set-up step covers the later step when the later condition is the same, is one of the set-up
 * condition's `||` terms, or, when it has no top-level `||` of its own, is joined by `&&` with one of them: a step that
 * runs only when `a && b` holds can run only when `a` holds, so a set-up step under `a || c` has run, while
 * `a && b || d` can run through `d`. The term matched must read only values fixed from the set-up step on
 * (`fixedTerm`, with `ran` the ids of the steps before it): `env.RUN == 'true'` can be false at the set-up step and
 * true later.
 */
export const setupCovers = (setup, step, ran = new Set()) => {
  for (const status of [...STATUSES].sort()) {
    if (runsAfter(step, status) === false) continue;
    const runs = runsAfter(setup, status);
    if (runs === false) return false;
    if (runs === null) {
      const [rest, wanted] = [withoutStatus(setup), withoutStatus(step)];
      const setupTerms = new Set([rest, ...orTerms(rest)].map(unwrap));
      // Split on `&&` only when the later condition has no top-level `||`: `a && c || d` can run through `d`.
      const andTerms = orTerms(wanted).length === 1 ? orTerms(wanted, '&&') : [];
      const stepTerms = [wanted, ...andTerms].map(unwrap);
      if (!(rest === '' || stepTerms.some((term) => setupTerms.has(term) && fixedTerm(term, ran)))) return false;
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

/** The key a step is named by in the lists above and in failures: "file > job > step > kind". */
export const stepKey = (file, name, step, i, kind) => `${file} > ${name} > ${step?.name || `step ${i + 1}`} > ${kind}`;

/**
 * The steps of one workflow's `jobs` that run a runtime before (or without) setting it up, by `stepKey`. A step named
 * in `indirect` counts as running its runtime even when its `run:` text does not show it.
 */
export function unsetSteps(file, jobs, indirect = INDIRECT_RUNTIME) {
  const found = [];
  for (const [name, job] of Object.entries(jobs ?? {})) {
    if (!Array.isArray(job?.steps) || job.container) continue;
    for (const kind of Object.keys(COMMAND)) {
      job.steps.forEach((step, i) => {
        const key = stepKey(file, name, step, i, kind);
        if (!(runsRuntime(step?.run, kind) || key in indirect)) return;
        // Covered by an earlier set-up step that always runs, or that runs under the same condition as this step.
        const covered = job.steps
          .slice(0, i)
          .some((earlier, j) => setsUp(earlier, kind) && setupCovers(condition(earlier), condition(step), stepIds(job.steps.slice(0, j))));
        if (!covered) found.push(key);
      });
    }
  }
  return found;
}

/**
 * True when `--python` (or `--python=…`) is one of pipx's own options among the words after `pipx`. Reading stops at a
 * bare `--`, after which every word is the app's, and, for `pipx run`, at the app's name (the first word after `run`
 * that is not an option or an option's value), after which every word is the app's argument (`pipx run tool --python
 * x` gives `--python` to the tool).
 */
export function pipxOptionChoosesPython(words) {
  let command = null;
  let valueNext = false;
  for (const word of words.split(/\s+/).filter(Boolean)) {
    if (valueNext) valueNext = false;
    else if (word === '--') return false;
    else if (word === '--python' || word.startsWith('--python=')) return true;
    else if (PIPX_VALUE_OPTIONS.has(word)) valueNext = true;
    else if (word.startsWith('-')) continue;
    else if (command === null) command = word;
    else if (command === 'run') return false;
  }
  return false;
}

/**
 * Whether the assignments in front of `pipx` set PIPX_DEFAULT_PYTHON to something: an empty value
 * (`PIPX_DEFAULT_PYTHON= pipx`, `PIPX_DEFAULT_PYTHON='' pipx`, `PIPX_DEFAULT_PYTHON=''"" pipx`) leaves pipx on its own
 * interpreter. `shellText` writes an empty quoted string as `''` or `""` and any other as `'_'` or `"_"`, so a value
 * made only of empty quotes is empty. The last assignment of the name wins, as in the shell.
 */
function choosesDefaultPython(before) {
  let chosen = false;
  for (const m of before.matchAll(ASSIGNMENT_WORD)) {
    if (m[1] === 'PIPX_DEFAULT_PYTHON') chosen = m[2].replace(/''|""/g, '') !== '';
  }
  return chosen;
}

/**
 * True when a run script runs `pipx` in command position without choosing its interpreter: no `--python` among pipx's
 * own options, no non-empty `PIPX_DEFAULT_PYTHON` among the assignments in front of it (a whole assignment word, not a
 * value that happens to hold the text), and none in `env` (the step's, job's and workflow's). A `${{ }}` expression
 * counts as a value on purpose (`PIPX_DEFAULT_PYTHON: ${{ steps.python.outputs.python-path }}`): passing
 * setup-python's `python-path` output that way is the documented way to point pipx at the Python it set up
 * (https://github.com/actions/setup-python/blob/main/docs/advanced-usage.md#python-path).
 */
export function pipxWithoutPython(run, env = {}) {
  if (String(env?.PIPX_DEFAULT_PYTHON ?? '').trim()) return false;
  return shellText(String(run ?? ''))
    .split('\n')
    .some((line) =>
      [...line.trim().matchAll(PIPX)].some(
        (found) => !(choosesDefaultPython(found.groups.before) || pipxOptionChoosesPython(found.groups.words))
      )
    );
}

/**
 * The steps of one workflow that run `pipx` without choosing its interpreter, by `stepKey` with the kind `pipx`. A job
 * in a `container:` is skipped, as `unsetSteps` skips it.
 */
export function pipxProblems(file, workflow) {
  const found = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    if (!Array.isArray(job?.steps) || job.container) continue;
    job.steps.forEach((step, i) => {
      const env = { ...(workflow?.env ?? {}), ...(job?.env ?? {}), ...(step?.env ?? {}) };
      if (pipxWithoutPython(step?.run, env)) found.push(stepKey(file, name, step, i, 'pipx'));
    });
  }
  return found;
}

describe('runsRuntime and unsetSteps', () => {
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
    for (const line of ['/opt/node/bin/node x.js', 'env -i npm ci', 'nice -n 10 node x.js', 'env -- node script.mjs', 'command -- node scripts/x.mjs', 'command -p -- npm ci', 'sudo -u nobody -- node x.js', 'timeout 60 node x.js', 'nohup node x.js', 'xargs -n 1 node', 'a|b) node x.js ;;']) {
      expect(runsRuntime(line, 'node'), line).toBe(true);
    }
    // A container's script, a continued line's argument, a heredoc's body, a lookup and an assignment are not commands.
    expect(runsRuntime("docker run --rm img bash -c '\n  /opt/az/bin/python3 -Im pip check\n'", 'python')).toBe(false);
    expect(runsRuntime('docker run --rm img \\\n  /opt/az/bin/python3 -Im pip check', 'python')).toBe(false);
    expect(runsRuntime("cat > x.txt <<'EOF'\npython3 is named here\nEOF", 'python')).toBe(false);
    expect(runsRuntime('command -v node', 'node')).toBe(false);
    expect(runsRuntime('sudo -u node whoami', 'node')).toBe(false);
    // Long options that take a value, after `=` or as the next word (Copilot on HCW-MigrateOrchestrator_AddOn#74).
    for (const [line, kind] of [
      ['timeout --kill-after 5 10 python3 check.py', 'python'],
      ['timeout --kill-after=5 10 node x', 'node'],
      ['timeout --signal KILL 10 node x', 'node'],
      ['timeout -s KILL 10 node x', 'node'],
      ['timeout --foreground --signal=TERM 1m python3 x.py', 'python'],
      ['sudo --user nobody node x', 'node'],
      ['sudo --user=nobody -- python3 x.py', 'python'],
      ['env --unset FOO node x', 'node'],
      ['env --chdir=/tmp python3 x.py', 'python'],
      ['nice --adjustment 5 node x', 'node'],
      ['xargs --max-args 1 node', 'node'],
      ['xargs --process-slot-var SLOT node x', 'node'],
      ['xargs --process-slot-var=SLOT node x', 'node'],
      ['stdbuf --output L node x', 'node'],
      ['time --output t.txt python3 x.py', 'python'],
    ]) {
      expect(runsRuntime(line, kind), line).toBe(true);
    }
    for (const line of ['sudo --user node whoami', 'timeout --signal node 10 x', 'env --unset node x', 'stdbuf --output node x']) {
      expect(runsRuntime(line, 'node'), line).toBe(false);
    }
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

  it('reads the script a shell is given with -c on the runner, and not one given to a container', () => {
    const runs = [
      ["bash -c 'node x.js'", 'node'],
      ['sh -c "python3 x.py"', 'python'],
      ["bash -lc 'npm ci'", 'node'],
      ["bash -euo pipefail -c 'python3 x.py'", 'python'],
      ["bash -O extglob -c 'node x'", 'node'],
      ["bash +O nullglob -c 'node x'", 'node'],
      ["bash --rcfile /tmp/empty -c 'node x'", 'node'],
      ["bash --init-file ./rc.sh -eo pipefail -c 'python3 x.py'", 'python'],
      ["sudo -u runner bash -c 'python3 x.py'", 'python'],
      ['/bin/bash -c "cd app && npm test"', 'node'],
      ["version=$(sh -c 'node --version')", 'node'],
      ["bash -c '\n  set -e\n  python3 x.py\n'", 'python'],
      // Inside double quotes `\`` is a backtick the inner shell runs; `$'…'` turns `\n` into a new line.
      ['bash -c "echo \\`node --version\\`"', 'node'],
      ["bash -c $'echo start\\nnode x.js'", 'node'],
      ["if true; then\n  bash -c 'node x.js'\nfi", 'node'],
      ["bash -c -- 'node x.js'", 'node'],
      // An unquoted script is the one word after `-c` (Copilot on HCW-HybridCloudWorks#1716).
      ['bash -c node x.js', 'node'],
      ['sh -c python3 x.py', 'python'],
      ['sudo bash -lc -e pytest', 'python'],
      // The outer shell runs `$(…)` and backticks in a double-quoted script first, whatever the inner one makes of them.
      ['bash -c "echo \'$(node x)\'"', 'node'],
      ["sh -c \"echo '`node x`' > v\"", 'node'],
      ['bash -c "x=1 # $(node y)"', 'node'],
      ['bash -c "cat <<EOF\n$(python3 v)\nEOF"', 'python'],
      // A substitution inside double quotes runs on the runner, so a `-c` script in it is read (Copilot on #1716).
      [`echo "$(bash -c 'node x')"`, 'node'],
      [`FOO="$(sh -c 'node x')" true`, 'node'],
      ['FOO="$(sh -c "node x")" true', 'node'],
      ["v=`bash -c 'python3 y'`", 'python'],
      ["echo \"`bash -c 'python3 y'`\"", 'python'],
      [`x=$(echo "$(bash -c 'node x')")`, 'node'],
    ];
    const notRuns = [
      ["docker run --rm img bash -c 'node x.js'", 'node'],
      ['docker exec web sh -c "python3 x.py"', 'python'],
      ["echo bash -c 'node x.js'", 'node'],
      ["bash -c 'echo node is named here'", 'node'],
      // The word after the script is the inner shell's `$0`, an argument.
      ["bash -c 'echo \"$0\"' python3", 'python'],
      ["bash scripts/check.sh 'node x.js'", 'node'],
      ['bash -c echo node', 'node'],
      [`echo "$(docker run img bash -c 'node x')"`, 'node'],
      [`echo "$(echo 'node x')"`, 'node'],
      ['docker run img bash -c node x.js', 'node'],
    ];
    for (const [line, kind] of runs) expect(runsRuntime(line, kind), line).toBe(true);
    for (const [line, kind] of notRuns) expect(runsRuntime(line, kind), line).toBe(false);
  });

  it('reads a long run of shell options quickly', () => {
    // Each `-o -o` could once be split two ways, so 18 of them took seconds.
    const started = performance.now();
    expect(runsRuntime(`bash ${'-o -o '.repeat(200)}x'y'`, 'node')).toBe(false);
    expect(runsRuntime(`bash ${'-c '.repeat(200)}x'node y'`, 'node')).toBe(false);
    // The same for a wrapper's options, each of which could be read with or without an argument (twenty `-oL`s took
    // seconds; `sudo -uuu` repeated took minutes).
    expect(runsRuntime(`stdbuf${' -oL'.repeat(40)} -`, 'node')).toBe(false);
    expect(runsRuntime(`nice${' -n10'.repeat(40)} -`, 'node')).toBe(false);
    // 200 nested substitutions, quoted and not, each read once per level.
    expect(runsRuntime(`x="${'$(echo "'.repeat(200)}$(bash -c 'node y')${'")'.repeat(200)}"`, 'node')).toBe(true);
    expect(runsRuntime(`${'$('.repeat(200)}node y${')'.repeat(200)}`, 'node')).toBe(true);
    expect(runsRuntime(`sudo${' -uuu'.repeat(40)} -`, 'node')).toBe(false);
    expect(runsRuntime(`timeout${' --signal KILL --kill-after=5'.repeat(40)} -`, 'node')).toBe(false);
    expect(runsRuntime(`sudo${' --user u --user=u --userx'.repeat(40)} -`, 'node')).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('counts yarn and pnpm as Node.js, and pytest and pipx as Python, only as whole words in command position', () => {
    for (const line of ['yarn install --frozen-lockfile', 'pnpm install', 'cd web && pnpm test', 'CI=1 yarn build']) {
      expect(runsRuntime(line, 'node'), line).toBe(true);
    }
    for (const line of ['pytest -q', 'PYTHONPATH=src pytest tests', '/usr/local/bin/pytest -q', 'pipx run --spec checkov==3.3.30 checkov -d .']) {
      expect(runsRuntime(line, 'python'), line).toBe(true);
    }
    for (const line of ['echo yarn', './scripts/yarn-audit.sh', 'myyarn install', 'docker run img pnpm test']) {
      expect(runsRuntime(line, 'node'), line).toBe(false);
    }
    for (const line of ['echo pytest -q', 'grep pytest requirements.txt', 'pytest-runner --help', 'docker run img pytest']) {
      expect(runsRuntime(line, 'python'), line).toBe(false);
    }
  });

  it('reads arithmetic shifts, backslash-quoted heredocs and $\'…\' strings the way the shell does', () => {
    // `<<` inside `$((…))` or `((…))` is a shift, not a heredoc, so the next line is still read.
    expect(runsRuntime('size=$((1<<k))\nnode a.js', 'node')).toBe(true);
    expect(runsRuntime('(( n = 1 << k ))\nnode a.js', 'node')).toBe(true);
    expect(runsRuntime('for ((i = 0; i < 1<<k; i++)); do echo "$i"; done\nnode a.js', 'node')).toBe(true);
    // `<<\EOF` is a heredoc whose body is not run.
    expect(runsRuntime('cat <<\\EOF\nnode is named here\nEOF', 'node')).toBe(false);
    expect(runsRuntime('cat <<\\EOF\ntext\nEOF\nnode a.js', 'node')).toBe(true);
    // `\'` inside `$'…'` does not end the string.
    expect(runsRuntime("echo $'it\\'s'\nnode a.js", 'node')).toBe(true);
    expect(runsRuntime("echo $'it\\'s' 'node x'", 'node')).toBe(false);
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
    expect(unsetSteps('x.yml', wf.jobs)).toEqual(['x.yml > late > Early > node', 'x.yml > none > step 1 > python', 'x.yml > uvOnly > Run > python', 'x.yml > uvOld > Run > python']);
  });

  it('counts a step listed as starting a runtime indirectly as running it', () => {
    const jobs = {
      scan: { steps: [{ name: 'Build', run: 'bash scripts/build.sh' }, { uses: 'actions/setup-node@abc' }] },
      ready: { steps: [{ uses: 'actions/setup-node@abc' }, { name: 'Build', run: 'bash scripts/build.sh' }] },
    };
    const key = 'x.yml > scan > Build > node';
    expect(unsetSteps('x.yml', jobs, { [key]: 'build.sh runs node', 'x.yml > ready > Build > node': 'build.sh runs node' })).toEqual([key]);
    expect(unsetSteps('x.yml', jobs, {})).toEqual([]);
    // A step with no name, or an empty one, is named by its place in the job.
    expect(stepKey('x.yml', 'scan', { name: '' }, 2, 'python')).toBe('x.yml > scan > step 3 > python');
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
        // A condition on `env` proves nothing; one on a step's outputs does once that step has run before the set-up
        // step (Copilot on HCW-MigrateOrchestrator_AddOn#74).
        envCondition: { steps: [{ ...py, if: "env.RUN == 'true'" }, { name: 'Run', if: "env.RUN == 'true'", run: 'python3 a.py' }] },
        stepRanFirst: {
          steps: [{ id: 'refs', run: 'echo x' }, { ...py, if: "steps.refs.outputs.changed == 'true'" }, { name: 'Run', if: "steps.refs.outputs.changed == 'true'", run: 'python3 a.py' }],
        },
        stepRanLater: {
          steps: [{ ...py, if: "steps.refs.outputs.changed == 'true'" }, { id: 'refs', run: 'echo x' }, { name: 'Run', if: "steps.refs.outputs.changed == 'true'", run: 'python3 a.py' }],
        },
      },
    };
    expect(unsetSteps('x.yml', wf.jobs)).toEqual(['x.yml > skipped > Run > python', 'x.yml > afterAFailure > Run > python', 'x.yml > otherCondition > Run > python', 'x.yml > andTerm > Run > python', 'x.yml > envCondition > Run > python', 'x.yml > stepRanLater > Run > python']);
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
      // A later step joined by `&&` with the set-up condition, or with one of its `||` terms, needs it to hold
      // (Copilot on HCW-HybridCloudWorks#1716: ci.yml's verify job sets up Node under `relevant || operations` and
      // runs `relevant && lint`).
      ['a || b', 'a && c', true],
      ['a', 'a && c', true],
      ['a || b', 'c && (a)', true],
      ['a || b', 'a || c', false],
      ['a && b', 'a && c', false],
      ['a || b', 'c && d', false],
      // The later condition is split on `&&` only when it has no top-level `||` (Copilot on HCW-NetworkEyes_App#393):
      // `a && c || d` can run through `d` alone.
      ['a || b', 'a && c || d', false],
      ['a || b', 'd || a && c', false],
      ['a || b', '(a && c) || d', false],
      ['a || b', 'a && (c || d)', true],
      // Status functions joined by `&&` and `||` (Copilot on HCW-CloudAssessor_AddOn#89).
      ['always() && !cancelled()', 'cancelled()', false],
      ['always() && !cancelled()', 'failure()', true],
      ['failure() || cancelled()', 'cancelled()', true],
      ['failure() || cancelled()', '', false],
      ['success() || failure()', '!cancelled()', true],
      // Status terms come out only of a condition with no top-level `||` (Copilot on HCW-MigrateOrchestrator_AddOn#74):
      // after success with `a` true and `b` false, `failure() && a || b` is false while `a` is true.
      ['failure() && a || b', 'a', false],
      ['always() && a || b', 'b', true],
      // A term that reads something a step can change is never matched by its text (Copilot on
      // HCW-MigrateOrchestrator_AddOn#74): an earlier step can write `RUN=true` to `$GITHUB_ENV` after the set-up was
      // skipped.
      ["runner.os == 'Linux'", "runner.os == 'Linux'", true],
      ["strategy.job-index == 0", "strategy.job-index == 0", true],
      ["job.status == 'success'", "job.status == 'success'", false],
      ["env.RUN == 'true'", "env.RUN == 'true'", false],
      ["steps.changes.outputs.py == 'true'", "steps.changes.outputs.py == 'true'", false],
      ["github.event_name == 'push' && env.RUN", "github.event_name == 'push' && env.RUN", false],
      ["matrix.os == 'linux' || env.RUN == 'true'", "matrix.os == 'linux'", true],
      ["matrix.os == 'linux'", "matrix.os == 'linux' && env.RUN == 'true'", true],
      ["needs.build.outputs.env == 'x'", "needs.build.outputs.env == 'x'", true],
      ["inputs.mode == 'env.RUN'", "inputs.mode == 'env.RUN'", true],
      // `steps.<id>` is fixed once that step has run before the set-up step; the fourth item is those steps' ids.
      ["steps.refs.outputs.changed == 'true'", "steps.refs.outputs.changed == 'true'", true, ['refs']],
      ["steps.refs.outputs.changed == 'true'", "steps.refs.outputs.changed == 'true'", false, ['other']],
      ["steps.refs.outputs.changed == 'true' && env.RUN", "steps.refs.outputs.changed == 'true' && env.RUN", false, ['refs']],
    ];
    for (const [setup, step, covered, ran = []] of cases) expect(setupCovers(setup, step, new Set(ran)), `${setup} / ${step}`).toBe(covered);
    expect([...statuses('always() && !cancelled()')].sort()).toEqual(['failure', 'success']);
    expect([...statuses('failure() || cancelled()')].sort()).toEqual(['cancelled', 'failure']);
    expect([...statuses('!(failure() || cancelled())')]).toEqual(['success']);
  });
});

describe('pipx chooses its Python', () => {
  it('reports a pipx command that names no interpreter, and not one that does', () => {
    const cases = [
      ['pipx run --spec checkov==3.3.30 checkov -d .', {}, true],
      ['cd y && pipx install zizmor', {}, true],
      ["bash -c 'pipx run x'", {}, true],
      ['pipx run --python "$P" a && pipx run b', {}, true],
      ['MY_PIPX_DEFAULT_PYTHON=/p pipx run x', {}, true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '' }, true],
      // Only pipx's own options and assignments count (Copilot on HCW-NetworkEyes_App#394): after `--`, and after the
      // app's name for `pipx run`, `--python` is the app's; a value holding the text sets nothing.
      ['pipx run --spec tool -- tool --python', {}, true],
      ['pipx run tool --python x', {}, true],
      ['pipx run --pip-args "--python" tool', {}, true],
      ['env FOO=PIPX_DEFAULT_PYTHON=/p pipx run x', {}, true],
      ['FOO="PIPX_DEFAULT_PYTHON=/p" pipx run x', {}, true],
      ['pipx run --python "$P" tool', {}, false],
      ['pipx run --python=/p tool', {}, false],
      ['pipx run --spec checkov==3.3.30 --python /p checkov -d .', {}, false],
      ['pipx install --python /p tool', {}, false],
      ['pipx install tool --python /p', {}, false],
      ['FOO=1 PIPX_DEFAULT_PYTHON=/p pipx run x', {}, false],
      // An empty value leaves pipx on its own interpreter (Copilot on HCW-NetworkEyes_App#394); a quoted non-empty one
      // still counts, though the shell reading empties it.
      ['PIPX_DEFAULT_PYTHON= pipx run x', {}, true],
      ["PIPX_DEFAULT_PYTHON='' pipx run x", {}, true],
      ['PIPX_DEFAULT_PYTHON="" pipx run x', {}, true],
      ['PIPX_DEFAULT_PYTHON="$P" pipx run x', {}, false],
      ["PIPX_DEFAULT_PYTHON='/opt/py/bin/python3' pipx run x", {}, false],
      ['env PIPX_DEFAULT_PYTHON= pipx run x', {}, true],
      // Empty quotes run together are still empty, a quoted value elsewhere in the script does not vouch for this
      // command's, and the last assignment of the name wins (Copilot on HCW-HybridCloudWorks#1718).
      ['PIPX_DEFAULT_PYTHON=\'\'"" pipx run x', {}, true],
      ['PIPX_DEFAULT_PYTHON=""\'\' pipx run x', {}, true],
      ["PIPX_DEFAULT_PYTHON='' pipx run x; PIPX_DEFAULT_PYTHON=\"$P\" echo", {}, true],
      ["PIPX_DEFAULT_PYTHON='' pipx a; PIPX_DEFAULT_PYTHON='/p' pipx b", {}, true],
      ["PIPX_DEFAULT_PYTHON='/p' PIPX_DEFAULT_PYTHON= pipx run x", {}, true],
      ["PIPX_DEFAULT_PYTHON= PIPX_DEFAULT_PYTHON='/p' pipx run x", {}, false],
      ['PIPX_DEFAULT_PYTHON=""/p pipx run x', {}, false],
      ['pipx run --python "$P" --spec x x', {}, false],
      ['pipx run --python=/opt/py/bin/python3 x', {}, false],
      ['PIPX_DEFAULT_PYTHON=/p pipx run x', {}, false],
      ['env PIPX_DEFAULT_PYTHON=/p pipx run x', {}, false],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '/p' }, false],
      ['echo pipx', {}, false],
      ['docker run img pipx run x', {}, false],
      ['python3 -m pip install pipx', {}, false],
    ];
    for (const [run, env, flagged] of cases) expect(pipxWithoutPython(run, env), run).toBe(flagged);
  });

  it("reads the step's, job's and workflow's env", () => {
    const scan = 'pipx run checkov -d .';
    const workflow = {
      env: { FROM_WORKFLOW: '1' },
      jobs: {
        bare: { steps: [{ name: 'Scan', run: 'pipx run --spec checkov==3.3.30 checkov -d .' }] },
        stepEnv: { steps: [{ name: 'Scan', env: { PIPX_DEFAULT_PYTHON: '${{ steps.python.outputs.python-path }}' }, run: scan }] },
        jobEnv: { env: { PIPX_DEFAULT_PYTHON: '/opt/py/bin/python3' }, steps: [{ run: scan }] },
        option: { steps: [{ name: 'Scan', env: { PYTHON_PATH: '${{ steps.python.outputs.python-path }}' }, run: 'pipx run --python "$PYTHON_PATH" --spec checkov==3.3.30 checkov -d .' }] },
        boxed: { container: 'python:3.15', steps: [{ run: scan }] },
      },
    };
    expect(pipxProblems('x.yml', workflow)).toEqual(['x.yml > bare > Scan > pipx']);
    expect(pipxProblems('x.yml', { ...workflow, env: { PIPX_DEFAULT_PYTHON: '/opt/py/bin/python3' } })).toEqual([]);
  });
});

describe('.github/workflows', () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  const workflows = Object.fromEntries(files.map((file) => [file, parse(readFileSync(join(WORKFLOWS, file), 'utf8'))]));
  const unset = files.flatMap((file) => unsetSteps(file, workflows[file]?.jobs));
  const pipx = files.flatMap((file) => pipxProblems(file, workflows[file]));

  it('every step that runs Node.js or Python comes after its version is set up, so the runner image never chooses it', () => {
    expect(unset.filter((entry) => !(entry in RUNNER_DEFAULT_ALLOWED))).toEqual([]);
  });

  it('every step that runs pipx chooses its Python, so pipx never falls back to the runner image\'s own', () => {
    expect(pipx.filter((entry) => !(entry in PIPX_ALLOWED))).toEqual([]);
  });

  it('every allowed exception still exists, so the list cannot hide a job that has since changed', () => {
    for (const [entry, reason] of Object.entries(RUNNER_DEFAULT_ALLOWED)) {
      expect(unset, entry).toContain(entry);
      // An exception without a reason a reviewer can check is not an exception (Copilot on HCW-CloudAssessor_AddOn#89).
      expect(String(reason ?? '').trim(), `${entry} gives no reason`).not.toBe('');
    }
    for (const [entry, reason] of Object.entries(PIPX_ALLOWED)) {
      expect(pipx, entry).toContain(entry);
      expect(String(reason ?? '').trim(), `${entry} gives no reason`).not.toBe('');
    }
  });

  it('every indirect step still exists and says why, so a renamed or removed step cannot leave the list pointing at nothing', () => {
    const keys = new Set(
      files.flatMap((file) =>
        Object.entries(workflows[file]?.jobs ?? {}).flatMap(([name, job]) =>
          (Array.isArray(job?.steps) ? job.steps : []).flatMap((step, i) => Object.keys(COMMAND).map((kind) => stepKey(file, name, step, i, kind)))
        )
      )
    );
    for (const [entry, reason] of Object.entries(INDIRECT_RUNTIME)) {
      expect(String(reason ?? '').trim(), `${entry} gives no reason`).not.toBe('');
      expect(keys.has(entry), entry).toBe(true);
    }
  });
});
