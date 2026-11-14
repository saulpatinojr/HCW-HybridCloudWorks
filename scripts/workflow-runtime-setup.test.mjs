/**
 * Every workflow job that runs Node.js or Python chooses its version (#1707).
 *
 * A job that runs `node`, `npm`, `npx`, `yarn`, `pnpm`, `python3`, `pip`,
 * `pipx`, `pytest`, `uv` or `uvx` without actions/setup-node or
 * actions/setup-python gets whatever the runner image ships: on ubuntu-26.04
 * that was Node.js 24 and Python 3.14 in November 2026, both below the floors
 * in scripts/version-floors.json (Node.js 26, Python 3.15). Nothing else would
 * notice, because the floors test reads only the versions a file names, and a
 * job that names none has nothing to read. Six jobs were found that way on
 * 2026-11-12. `uv` and `uvx` count as Python, because uv runs the interpreter
 * it finds, the runner's own unless one was set up; so astral-sh/setup-uv
 * counts as setting Python up only when it is given a `python-version` at or
 * above the floor in version-floors.json. `yarn` and `pnpm` are Node.js
 * programs and count as Node.js; `pytest` and `pipx` are Python programs and
 * count as Python. pipx makes each tool's virtual environment from the
 * interpreter pipx itself runs on unless it is given `--python` or
 * `PIPX_DEFAULT_PYTHON`
 * (https://pipx.pypa.io/latest/reference/environment-variables.html), and
 * GitHub's Ubuntu runner images install pipx with the image's own python3
 * (actions/runner-images#14654), so setting Python up is not enough. A step
 * that runs `pipx` in command position must also choose its interpreter:
 * `--python` among that pipx command's own words (`pipx run --python
 * "$PYTHON_PATH" …`, with actions/setup-python's `python-path` output), or
 * `PIPX_DEFAULT_PYTHON` set in front of it (`PIPX_DEFAULT_PYTHON=/p pipx …`) or
 * in the step's, job's or workflow's `env:` (Copilot on
 * HCW-NetworkEyes_App#393). A step that does not is reported, named; one kept
 * that way on purpose is listed, with its reason, in PIPX_ALLOWED. The script's
 * own `unset`, `export` and assignments of it are read too, the last in a shell
 * winning.
 *
 * What pipx is given must also be the set-up Python. The runner's own Python
 * named by its path (`--python /usr/bin/python3`, `/usr/bin/python3.12`,
 * `/bin/python3` or the Azure CLI's `/opt/az/bin/python3`, the same as
 * `PIPX_DEFAULT_PYTHON`) chooses nothing, nor does a command or process
 * substitution this check cannot run (`"$(command -v python3)"`, `<(…)`) or a `$` the shell passes on as
 * text (`'$P'`, `\$P`). A `${{ steps.<id>.outputs.python-path }}` value (only
 * that output: `cache-hit` and `python-version` are not a path), given
 * directly or through a variable of
 * the step's `env:` (`--python "$PYTHON_PATH"`), counts only when `<id>` is an
 * earlier actions/setup-python step of the same job that is sure to have run
 * first, by the same rules as a set-up step with an `if:` (below); a missing
 * id, a later step, a step that is not actions/setup-python or one that may be
 * skipped chooses nothing, and so does a `steps` reference written another way
 * (`steps['py'].outputs`), which names no id this check can read. A shell
 * variable the step's, job's or workflow's `env:` does not set chooses nothing
 * too, unless the script sets it itself before the command (`P=…;`, `for P
 * in`, `read P`, but not `echo P=…` or `P=/x pipx …`) in the same shell or
 * it is `$pythonLocation` (setup-python sets it) once an actions/setup-python
 * step, with or without an id, is sure to have run first. A name set in a `-c` script,
 * a shell fed a heredoc, a `$(…)` or a `( … )` subshell stays there, and one
 * set outside reaches a child shell only when exported. A later assignment in
 * the script wins over the `env:` value, and its value is read by the same
 * rules (`P=/usr/bin/python3` chooses nothing). A bare `python3.15` still
 * counts, and so does a path under `${{ env.pythonLocation }}`, by the same
 * rule as `$pythonLocation`. Any other GitHub expression chooses nothing
 * (`${{ github.workspace }}/.venv/bin/python`, `${{ inputs.python }}`,
 * `${{ env.UNSET }}`), except `${{ env.X }}` and `${{ matrix.X }}`, which are
 * read as GitHub replaces them, from the step's, job's or workflow's `env:` and
 * from every entry of the job's matrix list, so they choose when the value they
 * stand for does (Copilot on HCW-NetworkEyes_AddOn#109). A path is read as the
 * shell resolves it before it is compared, so `/usr/bin/../bin/python3` and
 * `/usr/./bin/python3` are the runner's own (Copilot on
 * HCW-MigrateOrchestrator_AddOn#75). Settings travel the way the shell
 * passes them: `PIPX_DEFAULT_PYTHON=/p bash -c 'pipx run x'` and `env
 * PIPX_DEFAULT_PYTHON=/p env -S 'pipx run x'` give the inner script the
 * setting, and `sudo` drops every inherited setting (its default `env_reset`)
 * unless it is given `-E` or `--preserve-env` (bare, or with a list that names
 * the variable), while `sudo PIPX_DEFAULT_PYTHON=/p pipx …` sets it.
 *
 * A command counts when it is in command position on a line of a `run:` step:
 * at the start, after `$(`, `<(`, a backtick, `(`, `{`, `|`, `&&`, `||` or `;`, after
 * leading `NAME=value` assignments (the value plain text, a quoted string, or
 * both run together), after a `case` pattern at the start of a line
 * (`check)`), or after a word that runs the next one (`env`, `sudo`, `xargs`,
 * `exec`, `time`, `nice`, `!`, `if`, `then`, `do` and the like) and that
 * word's options (`sudo -u nobody`, `env -i`). A wrapper's long option may be
 * shortened as far as it stays unambiguous, as the commands themselves accept
 * (`timeout --kill=5`, `nice --adj 5`); an ambiguous one is read as taking no
 * value. A long or short option that takes a value takes the next word even
 * when it starts with `-` (`timeout --kill-after -5`, `nice -n -5`). It counts
 * with a path in front too (`/usr/bin/python3`, `./venv/bin/python`,
 * `/usr/bin/env node`), because a path to the runner's interpreter is still
 * the runner's, and `python3.15.2` counts like `python3`. A `$'…'` string is
 * decoded as the shell decodes it (`\xHH`, `\uHHHH`, `\UHHHHHHHH`, octal
 * `\NNN`, `\n` and the like) and read as one word, so `$'\x70ython3'` is
 * `python3` while `$'node\x20x'` is the one word `node x`. A heredoc's body is
 * read only for the commands the shell runs in it: `$(…)` and backticks in the
 * body of a heredoc whose delimiter is not quoted or escaped (`<<EOF`,
 * `<<-EOF`), and nothing in the body of `<<'EOF'`, `<<"EOF"` or `<<\EOF`. It
 * does not count in a comment, the rest of a heredoc's body, a quoted string
 * (unless a double-quoted one runs a command with `$(`, `<(` or a backtick; a
 * single-quoted one may run over several lines, as the `bash -c '…'` script
 * of a `docker run` does) or as an argument (`docker run image python …`, or
 * the first word of a line that continues the one before it). One more quoted
 * string is read: the script of a shell that is itself in command position
 * and given `-c` (`bash -c 'node x'`, `sh -euo pipefail -c "…"`, `sudo bash
 * -lc '…'`, `bash -c -- '…'`). That script runs on the runner, so its
 * commands count, while the same words after `docker run image` stay a
 * container's; an unquoted script is the one word after `-c` (`bash -c node
 * x.js` runs `node`, while `bash -c echo node` does not), and text written
 * onto the `-c` is read as the script too (`bash -cnode x`, `bash -ec'node
 * x'`), though bash and dash refuse that form, so reading it only errs
 * towards reporting. A double-quoted `-c` script is read both ways: as the outer
 * shell reads it (its `$(…)` and backticks run first) and as the inner shell
 * does. The set-up step must come before the first such step. Limits, on
 * purpose: a job that runs in a `container:` uses that image's runtime and is
 * not checked; a script a step calls (a `.ps1` or `.sh` file) is not read, so
 * a step that starts a runtime that way is listed in INDIRECT_RUNTIME. A
 * command substitution inside a double-quoted string (`"$(…)"`, or a
 * backtick pair) runs on the runner, so it is read like any other script, a
 * `-c` script in it included (`echo "$(bash -c 'node x')"`); one that hands
 * its script to a container (`"$(docker run img bash -c '…')"`) stays
 * unread. A heredoc or a here-string given to a shell that reads its script
 * from its input is that shell's script (`bash <<'EOF'`, `bash -s <<EOF`,
 * `bash <<< 'node x'`), whatever the quoting of the delimiter, since the shell
 * runs it; the same body given to `cat` is text.
 *
 * Round 3 (#1707) reads more forms the way the shell and GitHub do. A command
 * named in quotes (`'node' x.js`, `"node" x.js`, `''node x`) or with a `\` in
 * it (`\node x`) is that command, a command's name ends at an operator as well
 * as a space (`node;`, `x=$(node)`), and `eval` and `builtin` run the words
 * after them. A quoted `"NAME=…"` given to `env` or `sudo` is an assignment, as
 * env and sudo read it. A runtime run through `sudo` counts as the runner's own
 * even after a set-up step, because sudo looks its command up on its own fixed
 * list of folders (`secure_path`); only `sudo env "PATH=$PATH" …`, which passes
 * the PATH the shell already has, keeps the set-up one, and a step whose
 * `shell:` runs through sudo runs its whole text that way. A step whose
 * `shell:` (or `defaults.run.shell`) is a runtime (`python`, `node {0}`) runs
 * it. The outer shell runs only the `$(…)` and backticks of a double-quoted
 * string, so `bash -c "x; pipx run y $(true)"` runs no `pipx` outside. `unset`,
 * `export -n` (which takes a name's export away) and `declare +x` are read, and
 * so is a script line that sets PIPX_DEFAULT_PYTHON to a value that chooses
 * nothing (and, since Copilot's third review, one that chooses, the latest
 * change in a shell winning). sudo refuses `-i` together with `-E` outright, so
 * `sudo -iE pipx` counts as having no Python chosen. A value given to pipx
 * chooses nothing when it is a bare name other than the floor's own
 * `python3.15` (PATH would find the runner's), a path under /usr/local/bin, a
 * path with a `..` after a part this check cannot see, or a pattern or `~` the
 * shell would still expand; a `\` in it is dropped first. `${{ env.X }}` is
 * read as GitHub evaluates it, level by level, and `${{ env.pythonLocation }}`
 * stays setup-python's word, which chooses nothing when an `env:` sets
 * `pythonLocation` itself or the script unsets it.
 *
 * Limits, known and kept: a composite action whose set-up step takes its
 * version from `${{ inputs.* }}` cannot be read, so it fails closed and needs
 * an entry in BELOW_FLOOR_ALLOWED; a `shell: python` step's text is still read
 * as shell too, and an `eval` script is read as a child shell (a name set but
 * not exported before it is not seen), both of which can only add findings; and
 * these are not reported: `env -i python3` after a set-up step (env empties
 * PATH, so `python3` is looked up on the system's default folders); a
 * `--python` path to a Python outside the folders of RUNNER_PYTHON_FOLDERS
 * (`/opt/hostedtoolcache/Python/3.12…`, `/usr/share/miniconda/bin/python3`); a
 * relative path after `cd` (`cd /usr/bin && pipx run --python ./python3 x`); a
 * value a `for` loop or `read` sets (`for P in /usr/bin/python3; do …`), which
 * counts as chosen; a PATH or setting written to `$GITHUB_PATH` or
 * `$GITHUB_ENV` by an earlier step; and a set-up version `3` or `3.x` (a major
 * line only), which reads as at the floor. `unset -n P` is read as unsetting P,
 * which is what bash does unless P is a name reference.
 *
 * The website reads YAML with the `yaml` library and refuses (`readWorkflow`)
 * the forms the other copies' line readers refuse: `jobs`, a job, `steps`, a
 * step, `strategy` or `matrix` written on one line, a plain or quoted value
 * that runs over more than one line or starts on the line after its key, a
 * quoted key (`'run': x`), a space before a key's colon (`run : x`), and an
 * anchor, alias or tag (`&a`, `*a`, `!!str`).
 *
 * The same check is
 * copied into the add-on and App repositories; keep the logic the same in
 * each copy and change only the lists and comments.
 *
 * A composite action (`.github/actions/<name>/action.yml`, `runs: using:
 * composite`) is checked like a job of its own, named `composite`, so its keys
 * read `.github/actions/<name>/action.yml > composite > step name > runtime`.
 * Its steps run inside the caller's job, but a caller cannot be relied on to
 * have set the runtime up, so the action sets up what it runs itself. Its
 * findings go into the same lists as a workflow's, and an exception for one
 * goes in the same lists too. A job whose `steps:` is not a list, or a step
 * that is not a mapping, stops the check with an error rather than being read
 * as having no steps (see `readWorkflow` above for the other forms it
 * refuses). A heredoc's delimiter is its whole word (`<<EOF-1`,
 * `<<E"OF"`), its body ending only at a line that is exactly that word (after
 * leading tabs for `<<-`), and astral-sh/setup-uv's `python-version` is read
 * through `${{ env.* }}` and `${{ matrix.* }}` in the forms the Python copies
 * read (`3.15`, `3.15.x`, `3.15.2`; not `3.15-dev`). A composite action's
 * set-up steps must ask for the floor or newer (`floorProblems`; the
 * website's workflows are held to the floors by scripts/version-floors.test.mjs
 * instead), and one whose version cannot be read (`${{ inputs.* }}`) is
 * reported unless BELOW_FLOOR_ALLOWED lists it. A version file is read only
 * when it is a `.python-version`, `.nvmrc` or `.node-version` file at a
 * relative path inside the checkout with no `..` and no symbolic link on the
 * way, and a composite action must have `runs: steps:`.
 *
 * A set-up step with its own `if:` covers a later step only when that step's
 * condition makes the set-up's true: the same condition, one of the terms
 * the set-up's condition joins with a top-level `||`, or a condition that
 * joins one of those with a top-level `&&` and has no top-level `||` of its
 * own (`a && b` runs only when `a` holds; `a && b || d` can run through `d`
 * alone, so it is not split; Copilot on HCW-NetworkEyes_App#393), or, when the
 * set-up's condition has no top-level `||`, a condition with no top-level `||`
 * whose `&&` terms include every one of the set-up's (`a && b` covers `c && a
 * && b`; Copilot on HCW-MigrateOrchestrator_App#117), an
 * `&&` term of the set-up's that joins terms with `||` counting as included
 * when one of those terms is (`(a || b) && c` covers `a && c`, not `d && c`;
 * Copilot on HCW-MigrateOrchestrator_App#118). Otherwise
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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAlias, isMap, isScalar, isSeq, parse, parseDocument, visit } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/**
 * Set-up steps of composite actions that ask for a version below the floor, or one this check cannot read (an
 * `${{ inputs.* }}` version), on purpose, keyed by the problem `floorProblems` reports, each with its reason. Empty:
 * this repository has no composite action.
 */
const BELOW_FLOOR_ALLOWED = {};

// Where a command may start: the line's start or an opening/joining
// character, then any `NAME=value` assignments (the value plain text, a
// quoted string, a whole `$(…)`, `$((…))` or backtick pair with no parentheses
// inside, or those run together: `FOO="a b"`, `FOO=$(date) node`) and words
// that run the next word (`env FOO=1 node`, `sudo node`, `if node …; then`).
// A plain value holds no `(`, `)` or backtick, so `x=$(sudo pipx run y)` is
// read from the `$(`, not as an assignment whose value runs into the
// substitution, and no `;`, `&`, `|`, `<` or `>`, which end it (`P=/x; pipx
// …` is two commands).
const ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\(\([^()\x60]*\)\)|[$<>]\([^()\x60]*\)|\x60[^\x60]*\x60|[^\s"'()\x60;&|<>])*\s+`;
// Words that run the next word, each with the options it may take first:
// the letters of the options that take an argument (`sudo -u nobody`,
// `nice -n 10`), any other `-x`/`--long` flag, and the `--` that ends the
// options (`env -- node`). `timeout` also takes its duration (`timeout 60
// node`). `command` only with `-p` or `--`, because `command -v node` looks node up
// and runs nothing. An option that takes an argument always takes the next
// word, whatever it starts with (so `sudo -u node whoami` runs whoami, not node, and `nice -n -5 node` runs node),
// and an option can be read only one way: otherwise twenty `-oL`s make the match try every split
// (the same pattern as the Python copies, HCW-NetworkEyes_App's
// tests/security/test_workflow_runtime_setup.py).
// `env -S` (`--split-string`) is read as a flag, not as one that takes a value, because its value is the command it
// runs: unquoted, the next word is in command position (`env -S node x.js`); quoted, see ENV_SPLIT_SCRIPT.
const WRAPPER_OPTIONS = { env: 'uC', sudo: 'ugCDhprtTUR', xargs: 'InPLdaEs', exec: 'a', time: 'of', nice: 'n', nohup: '', stdbuf: 'ioe', timeout: 'sk' };
// The long options of those words that take a value (`timeout --kill-after 5 10 node`, `sudo --user nobody node`),
// the long forms of the letters above: the value follows `=` or is the next word, whatever it starts with. Any other
// `--long[=value]` is a flag, so each long option too can be read only one way (Copilot on
// HCW-MigrateOrchestrator_AddOn#74).
const WRAPPER_LONG_OPTIONS = {
  env: ['unset', 'chdir'],
  sudo: ['user', 'group', 'close-from', 'chdir', 'host', 'prompt', 'role', 'type', 'other-user', 'command-timeout', 'chroot'],
  xargs: ['max-args', 'max-procs', 'delimiter', 'arg-file', 'max-chars', 'process-slot-var'],
  time: ['output', 'format'],
  nice: ['adjustment'],
  stdbuf: ['input', 'output', 'error'],
  timeout: ['signal', 'kill-after'],
};
// Their other long options, which take no value or take one only after `=`. getopt_long, which these commands use,
// accepts any start of a long option that names only one of them (`timeout --kill=5`, `nice --adj 5`), so the whole
// list is needed to tell which starts are unambiguous.
const WRAPPER_LONG_FLAGS = {
  env: ['ignore-environment', 'null', 'split-string', 'block-signal', 'default-signal', 'ignore-signal', 'list-signal-handling', 'debug', 'help', 'version'],
  sudo: ['askpass', 'background', 'bell', 'edit', 'set-home', 'help', 'login', 'remove-timestamp', 'reset-timestamp', 'list', 'non-interactive', 'preserve-env', 'preserve-groups', 'stdin', 'shell', 'version', 'validate'],
  xargs: ['null', 'eof', 'replace', 'max-lines', 'interactive', 'no-run-if-empty', 'show-limits', 'verbose', 'exit', 'open-tty', 'help', 'version'],
  time: ['append', 'portability', 'verbose', 'quiet', 'help', 'version'],
  nice: ['help', 'version'],
  nohup: ['help', 'version'],
  stdbuf: ['help', 'version'],
  timeout: ['foreground', 'preserve-status', 'verbose', 'help', 'version'],
};
/**
 * The long option of the wrapper `word` that `--name` names: the option itself, or the one option `name` is the start
 * of (`kill` for `kill-after`). null when it names none, or more than one, which the command refuses.
 */
export function longOption(name, word) {
  const every = [...(WRAPPER_LONG_OPTIONS[word] ?? []), ...(WRAPPER_LONG_FLAGS[word] ?? [])];
  if (every.includes(name)) return name;
  const found = every.filter((option) => name && option.startsWith(name));
  return found.length === 1 ? found[0] : null;
}
/** Every way of writing the long options `names` of the wrapper `word`: each option and each unambiguous start of it, longest first. */
const forms = (word, names) =>
  [...new Set(names.flatMap((name) => [...name].map((_, k) => name.slice(0, k + 1)).filter((form) => longOption(form, word) === name)))].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)
  );
// A wrapper's `--long` options: one that takes a value, written in full or shortened (see `forms`), with its value
// (`--signal=KILL`, `--sig KILL`, `--kill-after -5`), or any other `--long[=value]` as a flag.
const longOptionsOf = (word) => {
  const joined = forms(word, WRAPPER_LONG_OPTIONS[word] ?? []).join('|');
  return joined
    ? String.raw`--(?:${joined})(?:=\S*|\s+\S+)|--(?!(?:${joined})(?![\w-]))\w[\w-]*(?:=\S+)?`
    : String.raw`--\w[\w-]*(?:=\S+)?`;
};
const optionsOf = (takes, word) =>
  takes
    ? String.raw`(?:\s+(?:-(?:(?![${takes}])[A-Za-z])*[${takes}](?:\s+\S+|\S+)|${longOptionsOf(word)}|-(?:(?![${takes}])\w)+|--(?=\s)))*`
    : String.raw`(?:\s+(?:${longOptionsOf(word)}|-\w+|--(?=\s)))*`;
// A shell option (`-e`, `-o pipefail`, `-O extglob`, `--rcfile /tmp/rc`, `--login`, the `--` that ends them),
// `letters` being the letters a short option may hold. The options that take an argument (`-o`, `-O`, `--rcfile`,
// `--init-file`) never take one starting with `-`, so an option can be read only one way (otherwise `-o -o -o …`
// makes the match try every split).
const shellOption = (letters) =>
  String.raw`(?:[-+]${letters}*[oO]\s+[^\s-][\w-]*|--(?:rcfile|init-file)\s+[^\s-]\S*|[-+]${letters}+|--[\w-]+|--(?=\s))`;
// A runtime or a wrapper may be named with a path in front (`/usr/bin/python3`, `./venv/bin/python`,
// `/usr/bin/env`): a path to the runner's own interpreter is still the runner's. The path holds no `=`, so an
// assignment (`NODE=/x/node`) is not a command.
const PATH = String.raw`(?:[^\s=]*/)?`;
// A shell and its options up to the `-c` it is given. The options before it hold no `c`, so the first short option
// that holds one is the `-c` (`-c`, `-lc`, `-ec`), and a long run of options can be read only one way.
const SHELL_UP_TO_C = String.raw`(?:ba|da|k|z)?sh(?:\s+${shellOption('(?:(?!c)[A-Za-z])')})*\s+-(?:(?!c)[A-Za-z])*c`;
// What may follow that `c` before the script: more letters and options, then a space.
const SHELL_AFTER_C = String.raw`[A-Za-z]*(?:\s+${shellOption('[A-Za-z]')})*\s+`;
// A shell given `-c`, with its options; the script is the next word, or text written onto the `-c` (`bash -cnode x`).
// bash and dash refuse that second form, so reading it as a script only errs towards reporting.
const SHELL_GIVEN_C = String.raw`${SHELL_UP_TO_C}(?:${SHELL_AFTER_C}|(?=\S))`;
// A shell given `-c` is also a word that runs the next one: an unquoted script is that one word (`bash -c node x.js`
// runs `node`, with `x.js` as its `$0`). A quoted script is read by `shellText` instead.
const SHELL_C = `${PATH}${SHELL_GIVEN_C}`;
// A shell that reads its script from its input: its name and options, none of them `-c` (`bash`, `bash -s`, `sh -e`).
const SHELL_READS_INPUT = String.raw`${PATH}(?:ba|da|k|z)?sh(?:\s+${shellOption('(?:(?!c)[A-Za-z])')})*`;
// A here-string given to such a shell (`bash <<< node`) is its script; unquoted, that is the one word after `<<<`.
const SHELL_HERE_STRING = String.raw`${SHELL_READS_INPUT}\s*<<<\s*`;
const WRAPPERS = [
  ...Object.entries(WRAPPER_OPTIONS).map(([word, takes]) =>
    word === 'timeout'
      ? String.raw`${PATH}timeout${optionsOf(takes, word)}\s+\d+(?:\.\d+)?[smhd]?\s+`
      : String.raw`${word === 'exec' ? '' : PATH}${word}${optionsOf(takes, word)}\s+`
  ),
  String.raw`command(?:\s+(?:-p|--(?=\s)))*\s+`,
  String.raw`(?:if|then|else|elif|do|while|until|!)\s+`,
  // `eval` runs its arguments as a script (round 3, #1707): an unquoted first argument is in command position.
  // `builtin` runs the builtin named next (`builtin eval node x`).
  String.raw`(?:eval(?:\s+--(?=\s))?|builtin)\s+`,
  SHELL_C,
  SHELL_HERE_STRING,
].join('|');
// A `case` pattern that ends at the start of a line (`check)`, `a|b)`), after which a command may follow.
const CASE_PATTERN = String.raw`^[^()\s|]+(?:\|[^()\s|]+)*\)\s*`;
const START = String.raw`(?:^|[$<]\(\s*|[\x60({|;&]\s*|${CASE_PATTERN})(?:${ASSIGNMENT}|${WRAPPERS})*`;
// A runtime's command names. yarn and pnpm are Node.js programs; pytest and pipx are Python programs, so they run on
// the interpreter they were installed with, which is the runner's own unless a set-up step came first (pipx also builds
// each tool's virtual environment from that interpreter unless it is given `--python`).
const RUNTIME_NAMES = { node: '(?:node|npm|npx|yarn|pnpm)', python: String.raw`(?:python(?:3(?:\.\d+){0,2})?|pip3?|pipx|pytest|uvx?)` };
// Where a command's name ends: a space, the end of the line, or an operator (`node;`, `x=$(node)`, `python3<<EOF`,
// `'npx'|cat`; round 3 review, #1707).
const NAME_END = String.raw`(?=[\s;&|()<>]|$)`;
// A runtime command in command position, with the words in front of it (see `runtimeCommands`).
const RUNTIME = Object.fromEntries(Object.entries(RUNTIME_NAMES).map(([kind, names]) => [kind, new RegExp(`(?<before>${START})${PATH}${names}${NAME_END}`, 'g')]));
// The runtimes this check reads, by kind.
const COMMAND = RUNTIME;
// A shell in command position given a script with `-c` (`bash -c '…'`, `sh -euo pipefail -c "…"`, `sudo bash -lc
// '…'`, `bash -ec'…'`): the script runs on the runner too, so its commands count. The same words after `docker run
// image` are not in command position, so a container's script stays unread.
const SHELL_SCRIPT = new RegExp(`${START}${PATH}${SHELL_UP_TO_C}(?:${SHELL_AFTER_C})?$`);
// The same for a quoted here-string given to a shell that reads its script from its input (`bash <<< 'node x'`), and
// for a heredoc given to one (`bash <<'EOF'`, `bash -s <<EOF`), read where the `<<` starts.
const HERE_STRING_SCRIPT = new RegExp(`${START}${SHELL_HERE_STRING}$`);
const HEREDOC_SCRIPT = new RegExp(String.raw`${START}${SHELL_READS_INPUT}\s*$`);
// `env -S` (`--split-string`, or any unambiguous start of it) in command position: env splits its value into words
// and runs them, so a quoted value there is read as a script, like a `-c` shell's (`env -S 'node x.js'`,
// `env --split-string='python3 x.py'`; Copilot on HCW-MigrateOrchestrator_AddOn#74). An unquoted value is the next
// word, which is in command position already.
const ENV_SPLIT_SCRIPT = new RegExp(
  String.raw`${START}${PATH}env${optionsOf(WRAPPER_OPTIONS.env, 'env')}\s+(?:-(?:(?![uCS])[A-Za-z])*S|--(?:${forms('env', ['split-string']).join('|')})=?)\s*$`
);
// `eval` in command position, with any arguments before this one: eval joins its arguments and runs them as a script,
// so a quoted argument is read like a `-c` script (`eval 'node x'`, `eval echo 'a; node x'`; round 3, #1707).
const EVAL_SCRIPT = new RegExp(String.raw`${START}eval(?:\s+[^\s;&|()<>]+)*\s+$`);
// The words after `env` or `sudo` (with their options and assignments), where a quoted `"NAME=…"` is still an
// assignment: env and sudo read their arguments after the shell has taken the quotes off, so `sudo env "PATH=$PATH"
// python3` runs python3 with that PATH (round 3 review, #1707). At the start of a command a quoted `"NAME=…"` is the
// command's name, not an assignment, and `PREFIX_ONLY` (the line ends in the words in front of a command) tells the two
// apart.
const AFTER_ENV_OR_SUDO = new RegExp(
  String.raw`(?:^|[\s;&|(\x60])${PATH}(?:env${optionsOf(WRAPPER_OPTIONS.env, 'env')}|sudo${optionsOf(WRAPPER_OPTIONS.sudo, 'sudo')})\s+(?:${ASSIGNMENT})*$`
);
const PREFIX_ONLY = new RegExp(`${START}$`);
const QUOTED_NAME = /^[A-Za-z_][A-Za-z0-9_]*=/;
// `pipx` in command position, with what comes before it (its assignments and wrappers) and its words, up to the end
// of the command (`;`, `&`, `|` or `)`). It has chosen its interpreter when `--python` is one of pipx's own options
// (see `pipxOptionChoosesPython`) or `PIPX_DEFAULT_PYTHON` is one of the assignments in front of it.
const PIPX = new RegExp(`(?<before>${START})${PATH}pipx${NAME_END}(?<words>[^;&|)]*)`, 'g');
// pipx's options that take a value as the next word, so that word is not read as an option or as the app's name.
const PIPX_VALUE_OPTIONS = new Set(['--spec', '--python', '--index-url', '--pip-args', '--suffix', '--preinstall', '--backend', '--fetch-python']);
// Where `((` opens an arithmetic command rather than two subshells: at the start of a command.
const ARITHMETIC_COMMAND = /(?:^|[;&|({]|\b(?:then|else|do|if|elif|while|until|for))\s*$/;
// The escapes `$'…'` turns into other characters: these, `\xHH`, `\x{H…}`, `\uHHHH`, `\UHHHHHHHH` and octal
// `\NNN` (see `ansiC`); any other `\x` is left as it is.
const ANSI_C = { n: '\n', t: '\t', "'": "'", '"': '"', '\\': '\\' };
const ANSI_C_ESCAPE = /\\(x\{[0-9A-Fa-f]*\}?|x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|[\s\S])/g;
// A quoted string that is one plain word once the shell has read it (`$'\x70ython3'` is `python3`), written as that
// word, so it is read in command position like any other.
const PLAIN_WORD = /^[A-Za-z0-9_./+:@%,-]+$/;
// The characters a quoted value keeps when `shellText` is asked for values (the pipx check); any other becomes `_`, so
// the value stays one word and opens nothing. A `${NAME}` in it is first written `$NAME` (see VARIABLE).
const VALUE_UNSAFE = /[^A-Za-z0-9_./:@%+,=$\x03-]/gu;
// A `$` the shell passes on as text (inside single quotes or `$'…'`, or after a `\`), written so for the pipx check:
// no variable is read from it, and a value holding one chooses nothing (Copilot on HCW-NetworkEyes_App#395).
const LITERAL_DOLLAR = '\x03';
// A shell variable in a value (`"$PYTHON_PATH"`, `${PYTHON_PATH}`), read from the step's, job's or workflow's `env:`.
const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
// A GitHub expression (`${{ steps.py.outputs.python-path }}`), which GitHub replaces before the shell starts. For the
// pipx check it is written as one word (see `ghaTokens`).
const GHA_EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
// The two GitHub expressions a value given to pipx may hold and still choose its Python: setup-python's `python-path`
// output (`steps.py.outputs.python-path`, or `steps.py.outputs['python-path']`) and `env.pythonLocation`. `ghaTokens`
// writes each as one fixed word (STEP_OUTPUT, PYTHON_LOCATION) and any other expression as OTHER_EXPRESSION, which
// chooses nothing: one written another way (`steps['py'].outputs`), naming another output (`cache-hit`, or
// `python-version`, which is a version, not a path; Copilot on HCW-NetworkEyes_App#395) or any other context
// (`github.workspace`, `inputs.python`; Copilot on HCW-NetworkEyes_AddOn#109). A plain mention of `steps` outside an
// expression chooses nothing either.
const PYTHON_PATH_EXPRESSION = /^steps\.([A-Za-z0-9_-]+)\.outputs(?:\.python-path|\[\s*(['"])python-path\2\s*\])$/i;
const STEP_OUTPUT = /__gha__steps\.([A-Za-z0-9_-]+)\.outputs\.python-path__/g;
const PYTHON_LOCATION = '__gha__env.pythonLocation__';
const OTHER_EXPRESSION = '__gha__other__';
const STEPS = /(?<![A-Za-z0-9.-])steps(?![A-Za-z0-9-])/i;
// A GitHub expression that reads the step's, job's or workflow's `env:` or the job's matrix (`${{ env.PY }}`,
// `${{ matrix.python }}`), which GitHub replaces with that value before the shell starts (see `expansions`).
const ENV_OR_MATRIX = /\$\{\{\s*(env|matrix)\.([A-Za-z0-9_-]+)\s*\}\}/g;
// The variables a value may name without the step's `env:` setting them: actions/setup-python sets `pythonLocation`,
// so it counts only after an actions/setup-python step that is sure to have run (Copilot on HCW-NetworkEyes_AddOn#109).
const SET_UP_VARIABLES = new Set(['pythonLocation']);
// Stands for a value the script sets itself, in the names `chooses` reads.
const SCRIPT_SET = Symbol('set by the script');
// Stands for a name the script removes (`unset P`), in the records `namesView` reads (round 3, #1707).
const UNSET = Symbol('unset by the script');
// The names a script itself sets, whose values this check does not follow, so a value naming one still counts. They
// are read only where the shell sets a variable (Copilot on HCW-NetworkEyes_App#395 and HCW-HybridCloudWorks#1719), at
// the start of a command: a command made only of assignments (`P=/x;`; `P=/x pipx …` sets P for pipx alone, after
// `$P` was read), `export`, `declare`, `local`, `readonly` or `typeset` with assignments, `for P in` or `select P in`,
// `read P` (`read -a P`) and `unset P` (round 3, #1707), those builtins with assignments in front of them too (`FOO=1
// unset P`: bash still runs the builtin, and, outside POSIX mode, keeps FOO for that one command only, so FOO is not
// read as set; Copilot on #1722); never an argument (`echo P=/x`), quoted text, a comment or a heredoc's body, which
// `shellText` has already set apart. A name counts only for the commands after the one that sets it.
const ASSIGNED_WORD = String.raw`([A-Za-z_][A-Za-z0-9_]*)\+?=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\(\([^()\x60]*\)\)|[$<>]\([^()\x60]*\)|\x60[^\x60]*\x60|[^\s"'()\x60;&|<>])*`;
const ONE_ASSIGNMENT = new RegExp(String.raw`${ASSIGNED_WORD}\s*`, 'y');
const NAMES_SET = new RegExp(
  String.raw`(?:^|[$<]\(|[\x60({|;&]|(?<![^\s])(?:then|do|else|elif|if|while|until|!))\s*` +
    String.raw`(?:(?:${ASSIGNMENT})*(?:(?<keyword>export|declare|local|readonly|typeset)(?![A-Za-z0-9_=])(?<flags>(?:\s+[-+][A-Za-z]+)*)` +
    String.raw`(?<declared>(?:\s+[^\s;&|)]+)*)` +
    String.raw`|(?:for|select)\s+(?<loop>[A-Za-z_][A-Za-z0-9_]*)` +
    String.raw`|read(?![A-Za-z0-9_=])(?<read>(?:[ \t]+[^\s;&|)]+)*)` +
    String.raw`|unset(?![A-Za-z0-9_=])(?<unset>(?:[ \t]+[^\s;&|)]+)*))` +
    String.raw`|(?<assigned>(?:${ASSIGNED_WORD.replace('(', '(?:')}\s*)+)(?=$|[;&|)}]))`,
  'g'
);
// `read`'s options that take a value; `-a` names the array it sets.
const READ_VALUE_OPTIONS = 'adinNptu';
// The folders that hold a Python the runner image ships (its own, and the Azure CLI's at /opt/az/bin), and a path to
// one of them, which pipx would use instead of the set-up one (a doubled `/` is read as one; Copilot on
// HCW-HybridCloudWorks#1719). /usr/local/bin is one too (round 3, #1707): actions/setup-python never puts its Python
// there, while the runner image installs pip's console scripts (pipx among them, run by /usr/bin/python3) there and
// makes the folder writable by every user (images/ubuntu/scripts/build/install-python.sh and install-nodejs.sh in
// actions/runner-images).
const RUNNER_PYTHON_FOLDERS = ['/usr/bin', '/bin', '/opt/az/bin', '/usr/local/bin'];
const SYSTEM_PYTHON = new RegExp(`^(?:${RUNNER_PYTHON_FOLDERS.map((folder) => folder.replaceAll('/', '/+')).join('|')})/+python(?:3(?:\\.\\d+)*)?$`);
const SETUP = { node: /^actions\/setup-node@/, python: /^actions\/setup-python@/ };
// astral-sh/setup-uv sets Python up only when given a `python-version` at or above the floor (see `setsUp`).
const SETUP_UV = /^astral-sh\/setup-uv@/;
const floors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'version-floors.json'), 'utf8'));
const PYTHON_FLOOR = floors.kinds.python.floor.split('.').map(Number);
const FLOORS = { python: PYTHON_FLOOR, node: floors.kinds.node.floor.split('.').map(Number) };
// The one bare interpreter name that chooses a Python at or above the floor wherever it is found on PATH: the floor's
// own `python3.15` (round 3, #1707). Any other bare name (`python3`, `python`, `python3.14`, a version like `3.15`) is
// looked up on PATH, which finds the runner's own Python when no set-up step has run first.
const FLOOR_PYTHON_NAME = `python${PYTHON_FLOOR[0]}.${PYTHON_FLOOR[1]}`;
// The set-up step's inputs that name the version, directly or through a file in the repository.
const VERSION_INPUTS = { python: ['python-version', 'python-version-file'], node: ['node-version', 'node-version-file'] };

// The job statuses a step can run after, and the status functions that name them.
const STATUSES = ['success', 'failure', 'cancelled'];
const STATUS_CALL = /(!?)\s*\b(always|failure|cancelled|success)\(\s*\)/g;
const HAS_STATUS = /\b(?:always|failure|cancelled|success)\(\s*\)/;

// A heredoc's delimiter: the whole shell word after `<<` or `<<-` (`EOF`, `EOF-1`, `END.txt`, `'EOF X'`, `E"OF"`).
const HEREDOC_WORD = /<<-?[ \t]*((?:'[^']*'|"(?:[^"\\]|\\.)*"|\\[\s\S]|[^\s;&|<>()'"\\])+)/y;

/**
 * The heredoc that `<<` at `at` starts: its delimiter with the quotes and backslashes taken out, whether any part of
 * it was quoted or escaped (then the body is text the shell does not expand), and where the word ends; null when no
 * word follows.
 */
function heredocWord(run, at) {
  // (and, last, whether it is `<<-`, after which leading tabs are dropped from the body's lines)
  HEREDOC_WORD.lastIndex = at;
  const found = HEREDOC_WORD.exec(run);
  if (!found) return null;
  const word = found[1];
  const delimiter = word.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\([\s\S])/g, (whole, single, double, escaped) =>
    single !== undefined ? single : double !== undefined ? double.replace(/\\([\\"$`])/g, '$1') : escaped
  );
  return [delimiter, /['"\\]/.test(word), HEREDOC_WORD.lastIndex, found[0].startsWith('<<-')];
}

/**
 * True when a body line ends its heredoc: the line is exactly the delimiter, after its leading tabs for `<<-` (bash does
 * not end one at ` EOF` or `EOF `; Copilot on HCW-NetworkEyes_App#395).
 */
const endsHeredoc = (line, delimiter, tabs) => (tabs ? line.replace(/^\t+/, '') : line) === delimiter;

/**
 * Where the text continues after the bodies of these heredocs ([delimiter, `<<-`]), which start at `at` (just after a
 * new line): each body ends at a line that ends it (see `endsHeredoc`).
 */
function skipHeredocBodies(run, at, heredocs) {
  let k = at;
  const n = run.length;
  for (const [delimiter, tabs] of heredocs) {
    while (k < n) {
      const end = run.indexOf('\n', k) === -1 ? n : run.indexOf('\n', k);
      const text = run.slice(k, end);
      k = end + 1;
      if (endsHeredoc(text, delimiter, tabs)) break;
    }
  }
  return k;
}

/**
 * The index of the `)` that closes the `$(` at `at`, or the end of the text: escapes, quoted strings, heredoc bodies
 * and the substitutions inside them are skipped, so their quotes and parentheses do not count (`$(cat <<EOF` with
 * `it's` in the body). Inside `((…))` a `<<` is a shift.
 */
function substitutionClose(run, at) {
  const n = run.length;
  let depth = 0;
  let k = at + 1;
  let pending = []; // the delimiters of heredocs whose bodies start at the next new line
  let arithmetic = null; // the depth an open `((` started at
  while (k < n) {
    const char = run[k];
    if (char === '\n' && pending.length) {
      k = skipHeredocBodies(run, k + 1, pending);
      pending = [];
    } else if (run.startsWith('<<<', k)) k += 3;
    else if (char === '<' && run.startsWith('<<', k) && arithmetic === null) {
      const word = heredocWord(run, k);
      if (word) pending.push([word[0], word[3]]);
      k = word ? word[2] : k + 2;
    } else if (char === '\\') k += 2;
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
      if (arithmetic === null && run.startsWith('((', k)) arithmetic = depth;
      depth += char === '(' ? 1 : char === ')' ? -1 : 0;
      if (arithmetic !== null && depth <= arithmetic) arithmetic = null;
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

/**
 * The text of a `$'…'` string as the shell reads it: `\n`, `\t`, `\'`, `\"`, `\\`, `\xHH`, `\x{H…}`, `\uHHHH`,
 * `\UHHHHHHHH` and octal `\NNN` decoded (an octal or `\x{…}` value keeps its low eight bits, as bash 5.2 does: `\560`
 * is `p`), cut at a NUL as bash cuts it, and every character that is not printable ASCII, a tab or a new line written
 * `_`, which the shell does not split a word on either.
 */
export function ansiC(body) {
  const text = body
    .replace(ANSI_C_ESCAPE, (escape, code) => {
      if (code.startsWith('x{')) return String.fromCodePoint(parseInt((code.slice(2).replace(/\}$/, '') || '0').slice(-2), 16));
      if ('xuU'.includes(code[0]) && code.length > 1) {
        const value = parseInt(code.slice(1), 16);
        return value <= 0x10ffff ? String.fromCodePoint(value) : '_';
      }
      if ('01234567'.includes(code[0])) return String.fromCodePoint(parseInt(code, 8) & 0xff);
      return ANSI_C[code] ?? escape;
    })
    .split('\0')[0];
  return text.replace(/[^\x20-\x7e\t\n]/gu, '_');
}

/**
 * How `shellText` writes a quoted string that runs nothing: `''` (or `""`) when empty, else `'_'` (or `"_"`), or, when
 * asked for values, the quotes around the content with every character VALUE_UNSAFE names made `_` (and, in single
 * quotes, every `$` written LITERAL_DOLLAR, since the shell reads no variable there).
 */
function quotedText(content, mark, values) {
  if (!content) return mark + mark;
  if (!values) return `${mark}_${mark}`;
  if (mark === "'") return mark + content.replace(VALUE_UNSAFE, '_').replaceAll('$', LITERAL_DOLLAR) + mark;
  return mark + content.replace(VARIABLE, (whole, braced, plain) => `$${braced ?? plain}`).replace(VALUE_UNSAFE, '_') + mark;
}

/**
 * How `shellText` writes the text between the substitutions of a double-quoted string that runs one: ` _ ` ('' when
 * there is none), with or without values. The text runs nothing, and a value that holds a substitution chooses nothing
 * whatever its text (see `chooses`). The spaces keep a long string from being one long word, which PATH (a run of
 * characters up to a `/`) read again from every place it could start (round 3 review, #1707: 3,000 substitutions took
 * seconds).
 */
function textPart(literal) {
  return literal ? ' _ ' : '';
}

/**
 * The commands the shell runs in the body of a heredoc whose delimiter is not quoted (`<<EOF`): each `$(…)` and
 * backtick pair, written as `shellText` writes them, including those inside `$((…))`. Everything else in the body,
 * quotes included, is text; a `\` makes the next character text.
 */
function heredocSubstitutions(body, values) {
  const found = [];
  let k = 0;
  while (k < body.length) {
    if (body[k] === '\\') k += 2;
    else if (body.startsWith('$((', k)) k += 3;
    else if (body.startsWith('$(', k)) {
      const close = substitutionClose(body, k);
      found.push(`$(${shellText(body.slice(k + 2, close), values)})`);
      k = close + 1;
    } else if (body[k] === '`') {
      const close = backtickClose(body, k);
      found.push(`\`${shellText(body.slice(k + 1, close), values)}\``);
      k = close + 1;
    } else k += 1;
  }
  return found;
}

/**
 * The script as the shell reads it, for finding commands: comments dropped, a heredoc's body dropped apart from the
 * `$(…)` and backticks the shell runs in it when the delimiter is not quoted (see `heredocSubstitutions`; nothing from
 * `<<'EOF'`, `<<"EOF"` or `<<\EOF`, and not the shift `<<` inside `$((…))` or `((…))`), a line that ends in `\`
 * joined to the next (so the next line's first word is still an argument), single-quoted text and `$'…'` text written
 * as `'_'` (`''` when empty; a `$'…'` string that is one plain word once decoded is written as that word, see
 * `ansiC`), and double-quoted text as `"_"` (`""` when empty) unless it runs a command (`"$(node x)"`, or the older
 * "`node x`"). An escaped backtick (`\``, a Markdown summary line) is a plain character. A quoted string may run over
 * several lines, as the script of `docker run image bash -c '…'` does; what it runs is the container's. The one quoted
 * string that is read is the script of a shell in command position given `-c` (`bash -c 'node x'`) or of `env -S`: it
 * is read the same way, on lines of its own, and the line after it starts with `:` so that the words after the script
 * (the inner shell's `$0` and arguments) are still arguments.
 *
 * With `values`, for the pipx check, a quoted string that runs nothing keeps its content (see `quotedText`), and a
 * script read that way is put between a line holding `\x01` and the words in front of the shell (its assignments and
 * wrappers) and a line holding `\x02`, so the settings those words make reach the commands inside it.
 */
export function shellText(run, values = false) {
  const out = [];
  // Each heredoc whose body starts at the next new line: its delimiter, whether the shell expands its body, and, when
  // it is given to a shell that reads its script from its input, the words in front of that shell.
  let heredocs = [];
  // Open parentheses inside `$((…))` or `((…))`, where `<<` is a shift; 0 outside.
  let arithmetic = 0;
  let i = 0;
  const n = run.length;
  // The text so far on the current line, read back only to the last new line (rejoining everything each time made a
  // long script take a minute).
  const line = () => {
    const tail = [];
    for (let k = out.length - 1; k >= 0; k--) {
      const at = out[k].lastIndexOf('\n');
      if (at !== -1) {
        tail.push(out[k].slice(at + 1));
        break;
      }
      tail.push(out[k]);
    }
    return tail.reverse().join('');
  };
  // A `-c` script (or an `env -S` value) keeps the outer reading too: the outer shell runs a `$(…)` or backtick in a
  // double-quoted script before the inner shell starts (`bash -c "echo '$(node x)'"`).
  // An empty quoted string run together with other text adds nothing to its word (`''node x` runs node; round 3
  // review, #1707); on its own it is an empty word, and stays one.
  const quoted = (script, text, next = '') => {
    const head = line().trimStart();
    if ((text === "''" || text === '""') && (/[^\s;&|()<>]$/.test(head) || /^[^\s;&|()<>]/.test(next))) return;
    const found = SHELL_SCRIPT.exec(head) ?? ENV_SPLIT_SCRIPT.exec(head) ?? HERE_STRING_SCRIPT.exec(head) ?? EVAL_SCRIPT.exec(head);
    if (!found) out.push(text);
    else if (values) out.push(`${text}\n\x01${found[0]}\n${shellText(script, values)}\n\x02\n:`);
    else out.push(`${text}\n${shellText(script)}\n:`);
  };
  // The `NAME=` of a quoted assignment given to `env` or `sudo` (see AFTER_ENV_OR_SUDO), which is written in front of
  // the quotes (`PATH="$PATH"`) so that it reads as the assignment it is; '' for any other quoted string.
  const assigned = (at) => {
    const name = QUOTED_NAME.exec(run.slice(at, at + 256));
    if (!name) return '';
    const head = line().trimStart();
    // `env -S 'A=1 node x'` is a script to split, not an assignment.
    return AFTER_ENV_OR_SUDO.test(head) && PREFIX_ONLY.test(head) && !ENV_SPLIT_SCRIPT.test(head) ? name[0] : '';
  };
  while (i < n) {
    const char = run[i];
    if (char === '\\' && i + 1 < n) {
      const escaped = run[i + 1];
      // A `\` in front of an ordinary character only stands for that character (`\node` is `node`; round 3 review).
      out.push(
        escaped === '\n'
          ? ' '
          : escaped === '`'
            ? ''
            : values && escaped === '$'
              ? LITERAL_DOLLAR
              : /[A-Za-z0-9_.\/:@%+,=-]/.test(escaped)
                ? escaped
                : run.slice(i, i + 2)
      );
      i += 2;
    } else if (char === '$' && run[i + 1] === "'") {
      // `$'…'` may hold `\'`, which does not end it.
      let j = i + 2;
      while (j < n && run[j] !== "'") j += run[j] === '\\' ? 2 : 1;
      const body = ansiC(run.slice(i + 2, j));
      quoted(body, PLAIN_WORD.test(body) ? body : quotedText(body, "'", values), run[j + 1]);
      i = j + 1;
    } else if (char === "'") {
      const end = run.indexOf("'", i + 1) === -1 ? n : run.indexOf("'", i + 1);
      const name = assigned(i + 1);
      const body = run.slice(i + 1 + name.length, end);
      // A quoted plain word is that word to the shell, so `'node' x` runs node (round 3, #1707).
      quoted(body, name + (PLAIN_WORD.test(body) ? body : quotedText(body, "'", values)), run[end + 1]);
      i = end + 1;
    } else if (char === '"') {
      const name = assigned(i + 1);
      // A command substitution in the string (`$(…)`, or a backtick pair) may hold quotes of its own, and it runs on
      // the runner, so its script is read like any other. Everything else in the string is text to the outer shell,
      // written as quotedText writes text, so that a `;`, `|` or word in it is not read as a command (round 3,
      // #1707: `bash -c "x; pipx run y $(true)"` runs no pipx in the outer shell). As text, an escaped backtick prints.
      let j = i + 1 + name.length;
      const parts = [];
      let literal = '';
      let runs = false;
      while (j < n && run[j] !== '"') {
        if (run[j] === '\\') {
          const escape = run.slice(j, j + 2);
          literal += escape === '\\`' ? '' : values && escape === '\\$' ? LITERAL_DOLLAR : escape;
          j += 2;
        } else if (run.startsWith('$(', j) && !run.startsWith('$((', j)) {
          const close = substitutionClose(run, j);
          parts.push(textPart(literal) + `$(${shellText(run.slice(j + 2, close), values)})`);
          literal = '';
          runs = true;
          j = close + 1;
        } else if (run[j] === '`') {
          const close = backtickClose(run, j);
          parts.push(textPart(literal) + `\`${shellText(run.slice(j + 1, close), values)}\``);
          literal = '';
          runs = true;
          j = close + 1;
        } else {
          literal += run[j];
          j += 1;
        }
      }
      const raw = run.slice(i + 1 + name.length, Math.min(j, n));
      const text = literal;
      parts.push(textPart(literal));
      // Given to `-c`, the inner shell runs the script, an escaped backtick included.
      const script = raw.replace(/\\([\\"$`\n])/g, (escape, c) => (c === '\n' ? '' : c));
      quoted(script, name + (runs ? `"${parts.join('')}"` : PLAIN_WORD.test(raw) ? raw : quotedText(text, '"', values)), run[j + 1]);
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
    } else if (run.startsWith('<<<', i)) {
      out.push('<<<');
      i += 3;
    } else if (!arithmetic && run.startsWith('<<', i)) {
      const word = heredocWord(run, i);
      if (word) {
        // The body is expanded only when no part of the delimiter is quoted or escaped.
        const shell = HEREDOC_SCRIPT.exec(line().trimStart());
        heredocs.push([word[0], !word[1], shell ? shell[0] : null, word[3]]);
      }
      out.push('<<');
      i = word ? word[2] : i + 2;
    } else if (char === '\n' && heredocs.length) {
      out.push('\n');
      i += 1;
      for (const [delimiter, expands, shell, tabs] of heredocs) {
        const body = [];
        while (i < n) {
          const end = run.indexOf('\n', i) === -1 ? n : run.indexOf('\n', i);
          const text = run.slice(i, end);
          i = end + 1;
          if (endsHeredoc(text, delimiter, tabs)) break;
          body.push(text);
        }
        let script = body.join('\n');
        if (expands) {
          for (const command of heredocSubstitutions(script, values)) out.push(`${command}\n`);
          // What the shell given the body then reads: the body with the outer shell's escapes taken out.
          script = script.replace(/\\([\\$`\n])/g, (escape, c) => (c === '\n' ? '' : c));
        }
        if (shell !== null) {
          const inner = shellText(script, values);
          out.push(values ? `\x01${shell}\n${inner}\n\x02\n` : `${inner}\n`);
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

// A `case` pattern at the start of a line, whose words are patterns, not commands (`node|npm) …`).
const CASE_PREFIX = new RegExp(CASE_PATTERN);

/**
 * Every runtime command of `kind` in command position on a line (see `pipxCommands`), each with the words in front of
 * it. A line that starts with a `case` pattern is read after the pattern, so `node)` names no command now that a name
 * may end at `)`.
 */
function runtimeCommands(line, kind) {
  return pipxCommands(line.replace(CASE_PREFIX, ''), RUNTIME[kind]);
}

/** True when a run step calls the runtime in command position (see `shellText` for what is left out). */
export function runsRuntime(run, kind) {
  return shellText(String(run ?? ''))
    .split('\n')
    .some((line) => runtimeCommands(line.trim(), kind).length > 0);
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
      // A set-up condition with no top-level `||` holds whenever every one of its `&&` terms does, so a later step whose
      // `&&` terms include all of them is covered too (`a && b` covers `c && a && b`; Copilot on
      // HCW-MigrateOrchestrator_App#117), a term that joins terms with `||` being included when one of those is
      // (`(a || b) && c` covers `a && c`; Copilot on HCW-MigrateOrchestrator_App#118).
      const wantedTerms = conjuncts(wanted);
      const every = orTerms(rest).length === 1 && orTerms(wanted).length === 1 && conjuncts(rest).every((term) => termHolds(term, wantedTerms, ran));
      if (!(rest === '' || every || stepTerms.some((term) => setupTerms.has(term) && fixedTerm(term, ran)))) return false;
    }
  }
  return true;
};

/**
 * True when the set-up condition's `&&` term `term` surely holds whenever every one of `terms` (the later condition's
 * `&&` terms) does: it is one of them, or it joins terms with a top-level `||` and one of those is (`a || b` holds when
 * `a` does; Copilot on HCW-MigrateOrchestrator_App#118). The term matched must read only values fixed from the set-up
 * step on (`fixedTerm`). The same rule as the Python copies' `_term_holds`.
 */
function termHolds(term, terms, ran = new Set()) {
  return [term, ...orTerms(term)].some((option) => terms.includes(option) && fixedTerm(option, ran));
}

/**
 * The terms a condition with no top-level `||` joins with `&&`, a term in parentheses that itself joins terms with `&&`
 * alone opened up: `(a && b) && c` is `a`, `b` and `c`.
 */
function conjuncts(expression) {
  return orTerms(unwrap(expression.trim()), '&&').flatMap((term) =>
    orTerms(term, '&&').length > 1 && orTerms(term).length === 1 ? conjuncts(term) : [term]
  );
}

/**
 * True when a version is under the floor of `kind`, false when at or above it, null when it is not one of the forms
 * this test reads: `N`, `N.x`, `N.M` and `N.M.x` name a line and mean its newest release, so only their numbers are
 * compared with the floor's (`3.15` and `3.15.x` with 3.15; Copilot on HCW-HybridCloudWorks#1719); `N.M.P` is exact
 * and compared in full. Anything else, trailing text included (`3.15-dev`, `3.15.0b4`, `lts/*`), is null. The same
 * rule as the Python copies' `_below_floor`.
 */
export function belowFloor(version, kind = 'python') {
  const found = String(version).trim().match(/^v?(\d+)(?:\.x|\.(\d+)(?:\.x|\.(\d+))?)?$/);
  if (!found) return null;
  const numbers = found.slice(1).filter((number) => number !== undefined).map(Number);
  for (let i = 0; i < numbers.length; i++) if (numbers[i] !== FLOORS[kind][i]) return numbers[i] < FLOORS[kind][i];
  return false;
}

/**
 * The `env` context a step's `with:` and `run:` are read with, as GitHub builds it level by level (round 3, #1707): the
 * workflow's `env:`, then the job's on top, as written (GitHub does not allow the `env` context in either, so a
 * `${{ env.X }}` there stays as written and chooses nothing), then the step's own `env:` on top, each `${{ env.X }}` in
 * it replaced once by X's value at the job's level (a name the step's own `env:` sets is not seen there). `pythonLocation`
 * is left as written: it is actions/setup-python's (see `expansions`). The context availability table:
 * https://docs.github.com/en/actions/reference/workflows-and-actions/contexts. The same rule as the Python copies'
 * `step_env`.
 */
export function stepEnv(workflowEnv = {}, jobEnv = {}, ownEnv = {}) {
  const context = { ...(workflowEnv ?? {}), ...(jobEnv ?? {}) };
  const evaluated = { ...context };
  for (const [name, given] of Object.entries(ownEnv ?? {})) {
    evaluated[name] =
      given === null || given === undefined
        ? given
        : String(given).replace(ENV_OR_MATRIX, (whole, source, key) =>
            source === 'env' && key !== 'pythonLocation' && Object.hasOwn(context, key) ? String(context[key] ?? '') : whole
          );
  }
  return evaluated;
}

/**
 * The plain values an input stands for: itself, or what `${{ env.X }}` (the `env` context of `stepEnv`) or
 * `${{ matrix.X }}` (every entry of the job's matrix list) holds, a value of `env` that is itself one `${{ matrix.Y }}`
 * read as the matrix list Y (GitHub evaluates a job's or step's `env:` with the matrix); null when it cannot be worked
 * out here. The same rule as the Python copies' `_resolved`.
 */
function resolved(value, step, job, workflowEnv) {
  const text = String(value ?? '').trim();
  const found = text.match(/^\$\{\{\s*(env|matrix)\.([A-Za-z0-9_-]+)\s*\}\}$/);
  if (!found) return text.includes('${{') ? null : [text];
  let name = found[2];
  if (found[1] === 'env') {
    const env = stepEnv(workflowEnv, job?.env, step?.env);
    if (!Object.hasOwn(env, name)) return null;
    const given = String(env[name] ?? '').trim();
    const matrix = given.match(/^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/);
    if (!matrix) return given.includes('${{') ? null : [given];
    name = matrix[1];
  }
  const list = job?.strategy?.matrix?.[name];
  return Array.isArray(list) && list.length ? list.map((entry) => String(entry ?? '')) : null;
}

/**
 * True when the step chooses the runtime for the steps after it: actions/setup-node or actions/setup-python, or, for
 * Python, astral-sh/setup-uv given a `python-version` at or above the floor, read through `${{ env.* }}` and
 * `${{ matrix.* }}` (every matrix value must be), in a form `belowFloor` reads (without one, uv uses the runner's
 * Python; scripts/version-floors.test.mjs reads the pins themselves).
 */
export function setsUp(step, kind, job = {}, workflowEnv = {}) {
  const uses = String(step?.uses ?? '');
  if (kind === 'python' && SETUP_UV.test(uses)) {
    if (!Object.hasOwn(step?.with ?? {}, 'python-version')) return false;
    const versions = resolved(step.with['python-version'], step, job, workflowEnv);
    return Boolean(versions?.length) && versions.every((version) => belowFloor(version, 'python') === false);
  }
  return SETUP[kind].test(uses);
}

/** True for a step that sets the runtime up, whatever version it asks for (see `floorProblems`). */
const isSetUp = (step, kind) =>
  kind === 'python' && SETUP_UV.test(String(step?.uses ?? '')) ? Object.hasOwn(step?.with ?? {}, 'python-version') : SETUP[kind].test(String(step?.uses ?? ''));

// The version files this check reads: the names the `scripts (operations)` change filter matches wherever they are, so
// a change to one runs this test (Copilot on HCW-HybridCloudWorks#1719). Any other name is not read, so its set-up step
// is reported as asking for a version this check cannot work out, and needs an entry in BELOW_FLOOR_ALLOWED.
const VERSION_FILE_NAMES = ['.python-version', '.nvmrc', '.node-version'];

/**
 * The version file a set-up step names, when this check may read it: a path relative to `root` with no `..` and no
 * symbolic link on the way, to a regular file whose name is in VERSION_FILE_NAMES; null otherwise, so the step is
 * reported (Copilot on HCW-HybridCloudWorks#1719: a composite action's `../../proc/self/environ` must not be read). The
 * same rule as the Python copies' `_version_file`.
 */
function versionFile(root, given) {
  const parts = given.replaceAll('\\', '/').split('/');
  if (!given || given.startsWith('/') || parts.includes('..') || !VERSION_FILE_NAMES.includes(parts.at(-1))) return null;
  let path = root;
  for (const part of parts.filter((part) => part !== '' && part !== '.')) {
    path = join(path, part);
    try {
      if (lstatSync(path).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }
  return lstatSync(path).isFile() ? path : null;
}

/**
 * The versions a set-up step asks for, read through `env`, `matrix` and a version file under `root` (see
 * `versionFile`); null when unreadable. The same rule as the Python copies' `requested_versions`.
 */
function requestedVersions(step, job, root, kind, workflowEnv) {
  const [direct, fromFile] = VERSION_INPUTS[kind];
  const given = step?.with ?? {};
  if (Object.hasOwn(given, direct)) return resolved(given[direct], step, job, workflowEnv);
  if (!Object.hasOwn(given, fromFile)) return null;
  const paths = resolved(given[fromFile], step, job, workflowEnv) ?? [];
  const file = paths.length === 1 ? versionFile(root, paths[0]) : null;
  if (file === null) return null;
  const lines = readFileSync(file, 'utf8').split(/\r\n|\r|\n/).map((line) => line.trim());
  const versions = lines.filter((line) => line && !line.startsWith('#'));
  return versions.length ? versions : null;
}

/** A version written as Python's `repr` writes a string, so a problem reads the same in every copy. */
const pythonRepr = (text) => (text.includes("'") && !text.includes('"') ? `"${text}"` : `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);

/**
 * Every set-up step that asks for a version below the floor, or one this test cannot read, with the reason. The website
 * reads its workflows' pins with scripts/version-floors.test.mjs, so this copy applies it to composite actions only,
 * which that test does not read (Copilot on HCW-HybridCloudWorks#1719); the Python copies apply it to every
 * workflow too. A set-up step whose version comes from `${{ inputs.* }}` cannot be read, so it is reported, and one kept
 * that way on purpose goes in BELOW_FLOOR_ALLOWED with its reason.
 */
export function floorProblems(file, jobs, root, workflowEnv = {}) {
  const problems = [];
  for (const [name, job] of Object.entries(jobs ?? {})) {
    stepsOf(file, name, job).forEach((step, i) => {
      for (const kind of Object.keys(COMMAND)) {
        if (!isSetUp(step, kind)) continue;
        const label = `${file} > ${name} > ${step?.name || `step ${i + 1}`} > ${kind}`;
        const versions = requestedVersions(step, job, root, kind, workflowEnv);
        if (!versions?.length) problems.push(`${label}: cannot work out the version it asks for`);
        for (const version of versions ?? []) {
          const below = belowFloor(version, kind);
          if (below === null) problems.push(`${label}: ${pythonRepr(version)} is not a version number this test can compare`);
          else if (below) problems.push(`${label}: asks for ${version}, below the floor`);
        }
      }
    });
  }
  return problems;
}

/** The key a step is named by in the lists above and in failures: "file > job > step > kind". */
export const stepKey = (file, name, step, i, kind) => `${file} > ${name} > ${step?.name || `step ${i + 1}`} > ${kind}`;

/**
 * A job's steps, failing closed: a `steps:` that is not a list, or a step that is not a mapping, stops the check with
 * an error rather than read as a job with no steps or an empty step (the Python copies' line reader refuses
 * `steps: [{…}]` and `- {…}` the same way). A job without `steps:` (one that calls a reusable workflow) has none.
 */
function stepsOf(file, name, job) {
  if (job?.steps === undefined) return [];
  if (!Array.isArray(job.steps)) throw new Error(`${file} > ${name}: steps: is not a list`);
  for (const step of job.steps) {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${file} > ${name}: a step is not a mapping`);
  }
  return job.steps;
}

/**
 * What the words in front of a command do to the PATH it is looked up on: true when `sudo` replaced it with sudo's
 * `secure_path`, false when `env` set PATH again after that (`sudo env "PATH=$PATH" node`), null when neither. sudo
 * looks its command up on `secure_path` and gives it that PATH even with `-E`, and refuses a `PATH=` given to sudo
 * itself (sudo's plugins/sudoers/sudoers.c `set_cmnd_path` and env.c `rebuild_env`), so only a later `env` that is
 * given PATH, and then looks the command up itself, passes the set-up PATH on (round 3, #1707).
 */
function sudoPath(before) {
  let state = null;
  let env = false; // an `env` came after the `sudo`, so a `PATH=` word is its assignment
  for (const word of (before.match(WORD) ?? []).map((w) => w.replace(OPENING, ''))) {
    if (/^(?:\S*\/)?sudo$/.test(word)) [state, env] = [true, false];
    else if (state !== null && /^(?:\S*\/)?env$/.test(word)) env = true;
    // Only the PATH the outer shell had (`PATH=$PATH`, `PATH="$PATH":/x`): `PATH=/usr/bin` finds the runner's own
    // (round 3 review, #1707). Words with no `sudo` in front of them leave the state to the script around them, whose
    // `$PATH` is sudo's `secure_path` when it runs under sudo.
    else if (env && state !== null && PASSES_PATH.test(word.replace(/['"]/g, ''))) state = false;
  }
  return state;
}
// A `PATH=` that passes on the PATH the shell already has.
const PASSES_PATH = /^PATH=(?:\$PATH|\$\{PATH\})(?::|$)/;

/**
 * The PATH a command finds its runtime on, from what the words in front of it do (`local`, see `sudoPath`) and the PATH
 * of the script it is in (`outer`). `$PATH` in `env PATH=$PATH` is that script's PATH, so passing it on under a sudo'd
 * script still passes sudo's `secure_path`: `sudo bash -c 'sudo env PATH=$PATH node x'` runs the runner's own Node.js
 * (Copilot on the round-3 ports, #1707).
 */
function underPath(local, outer) {
  if (local === null) return outer;
  return local || outer === true;
}

/**
 * True when a run script runs the runtime through `sudo` without passing PATH on (see `sudoPath`): `sudo python3 x.py`,
 * `sudo -E node x`, `sudo bash -c 'node x'`. sudo's `secure_path` holds the runner's own Node.js and Python (Ubuntu's
 * and Debian's sudoers set it, and actions/runner-images does not change it), not the set-up ones in
 * /opt/hostedtoolcache, so such a step runs the runner's own runtime even after a set-up step (round 3, #1707). A
 * script a sudo'd shell runs (`-c`, a heredoc, `env -S`, `eval`) carries the sudo in front of it, and so does a step's
 * whole text when its `shell:` is run through sudo (`inherited`, see `stepShell`).
 */
export function runsThroughSudo(run, kind, inherited = null) {
  const stack = [inherited];
  for (const raw of shellText(String(run ?? ''), true).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('\x01')) {
      stack.push(underPath(sudoPath(line.slice(1)), stack.at(-1)));
      continue;
    }
    if (line.startsWith('\x02')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (runtimeCommands(line, kind).some((found) => underPath(sudoPath(found.groups.before), stack.at(-1)) === true)) return true;
  }
  return false;
}

/**
 * The command line a step's `run:` text is handed to, as GitHub reads `shell:` (the step's, else the job's or the
 * workflow's `defaults.run.shell`), with `{0}` written as a word: `python` runs `python {0}`, and a custom `node {0}`
 * runs node, so such a step runs that runtime whatever its text says (round 3, #1707;
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell). '' for the
 * default shell. The same rule as the Python copies' `step_shell`.
 */
export function stepShell(step, job, defaults = {}) {
  const shell = step && Object.hasOwn(step, 'shell') ? step.shell : job?.defaults?.run?.shell ?? defaults?.run?.shell;
  return String(shell ?? '').replaceAll('{0}', 'script');
}

/**
 * The steps of one workflow's `jobs` that run a runtime before (or without) setting it up, or through `sudo` (see
 * `runsThroughSudo`), by `stepKey`. A step named in `indirect` counts as running its runtime even when its `run:` text
 * does not show it, and so does one whose `shell:` runs it (see `stepShell`); `workflowEnv` is the workflow's `env:`,
 * for reading a setup-uv `python-version` given as `${{ env.X }}`, and `defaults` its `defaults:`.
 */
export function unsetSteps(file, jobs, indirect = INDIRECT_RUNTIME, workflowEnv = {}, defaults = {}) {
  const found = [];
  for (const [name, job] of Object.entries(jobs ?? {})) {
    const steps = stepsOf(file, name, job);
    if (job?.container) continue;
    for (const kind of Object.keys(COMMAND)) {
      steps.forEach((step, i) => {
        const key = stepKey(file, name, step, i, kind);
        const shell = Object.hasOwn(step, 'run') ? stepShell(step, job, defaults) : '';
        if (!(runsRuntime(step?.run, kind) || runsRuntime(shell, kind) || key in indirect)) return;
        // Covered by an earlier set-up step that always runs, or that runs under the same condition as this step.
        const covered = steps
          .slice(0, i)
          .some((earlier, j) => setsUp(earlier, kind, job, workflowEnv) && setupCovers(condition(earlier), condition(step), stepIds(steps.slice(0, j))));
        if (!covered || runsThroughSudo(step?.run, kind, sudoPath(shell)) || runsThroughSudo(shell, kind)) found.push(key);
      });
    }
  }
  return found;
}

/**
 * The text with each GitHub expression written as one word: setup-python's `python-path` output as
 * `__gha__steps.<id>.outputs.python-path__`, `env.pythonLocation` as PYTHON_LOCATION, and any other expression as
 * OTHER_EXPRESSION (see STEP_OUTPUT). The same rule as the Python copies' `_gha_tokens`.
 */
export const ghaTokens = (text) =>
  text.replace(GHA_EXPRESSION, (whole, inner) => {
    const expression = inner.trim();
    const output = expression.match(PYTHON_PATH_EXPRESSION);
    if (output) return `__gha__steps.${output[1]}.outputs.python-path__`;
    return expression === 'env.pythonLocation' ? PYTHON_LOCATION : OTHER_EXPRESSION;
  });

/**
 * A path as the shell resolves it, for comparing with SYSTEM_PYTHON: `.` and empty parts dropped and `..` taking the
 * part before it away, as Python's `posixpath.normpath` does, and any run of leading `/` written as one
 * (`/usr/bin/../bin/python3` and `//usr/bin/python3` are `/usr/bin/python3`; Copilot on
 * HCW-MigrateOrchestrator_AddOn#75).
 */
function resolvedPath(text) {
  const absolute = text.startsWith('/');
  const parts = [];
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..' || (!absolute && !parts.length) || (parts.length && parts.at(-1) === '..')) parts.push(part);
    else if (parts.length) parts.pop();
  }
  return (absolute ? '/' : '') + parts.join('/') || '.';
}

/**
 * True when a value given to pipx as its Python (`--python`, PIPX_DEFAULT_PYTHON) chooses the set-up one: it is not
 * empty (quotes aside), not the runner's own Python named by its path (SYSTEM_PYTHON: `/usr/bin/python3`,
 * `/bin/python3`), every mention of `steps` in it is a `steps.<id>.outputs` this check can read (`steps['py']` is not),
 * and each such id is of a step in `setupIds`, the earlier actions/setup-python steps of the job that are sure to have
 * run first. Given `env` (the step's, job's and workflow's `env:`, and SCRIPT_SET for each name the script sets
 * itself), a shell variable in the value is read from it (`--python "$PYTHON_PATH"` with `PYTHON_PATH: ${{
 * steps.python.outputs.python-path }}`); one the script sets counts, as does `$pythonLocation`, which
 * actions/setup-python sets; any other one is unknown, so the value chooses nothing. Without `env` (an inherited value,
 * which GitHub does not expand) the value is read as written. `python3.15` or a path under `${{ env.pythonLocation }}`
 * counts. A command substitution (`$(…)`, a backtick) or a `$` the shell passes on as text (`'$P'`, `\$P`) chooses
 * nothing.
 */
export function chooses(value, setupIds = new Set(), env = null) {
  let unknown = false;
  let located = false;
  // The value as the shell passes it on: quotes taken off and a `\` dropped from the character after it
  // (`/usr/bin/pyt\hon3` is `/usr/bin/python3`; round 3, #1707).
  const quoteless = value.replace(/['"]/g, '').replace(/\\([\s\S])/g, '$1');
  const text = (
    env === null
      ? quoteless
      : quoteless.replace(VARIABLE, (whole, braced, plain) => {
          const name = braced ?? plain;
          if (env[name] === UNSET) unknown = true;
          if (Object.hasOwn(env, name)) return env[name] === SCRIPT_SET || env[name] === UNSET ? whole : ghaTokens(String(env[name] ?? ''));
          unknown = unknown || !SET_UP_VARIABLES.has(name);
          located = true;
          return whole;
        })
  ).trim();
  // A `$` passed on as text, or a command or process substitution this check cannot run (`"$(printf
  // /usr/bin/python3)"`, or `<(…)`, which the shell passes as `/dev/fd/N`), is not a Python it can vouch for (Copilot on
  // HCW-NetworkEyes_App#395).
  const unreadable = text.includes(LITERAL_DOLLAR) || ['$(', '<(', '>(', '`'].some((sign) => text.includes(sign));
  // A value the shell would still expand chooses nothing either, since it is compared before that expansion could
  // turn it into the runner's own Python (round 3, #1707): a glob or brace (`/usr/bin/python*`, `{a,b}`) or a leading
  // `~` (the runner's home folder).
  const expands = /[*?[{}]/.test(text.replace(VARIABLE, '')) || text.startsWith('~');
  // A `..` after a part this check cannot see (a GitHub expression, a variable) can climb anywhere, the runner's own
  // Python included (`${{ env.pythonLocation }}/../../usr/bin/python3`; round 3, #1707).
  const parts = text.split('/');
  const dynamic = parts.findIndex((part) => part.includes('__gha__') || part.includes('$'));
  const climbs = dynamic !== -1 && parts.slice(dynamic + 1).includes('..');
  // A path is compared as the shell resolves it (see `resolvedPath`).
  // A value over more than one line (a block value with a `#` line in it, which YAML reads as part of the value) is no
  // interpreter's path (Copilot on HCW-NetworkEyes_App#399).
  const several = /[\r\n]/.test(text);
  if (!text || unknown || unreadable || expands || climbs || several || SYSTEM_PYTHON.test(resolvedPath(text))) return false;
  // A bare name is looked up on PATH, which finds the runner's own Python before a set-up step has run, so only the
  // floor's own name counts (FLOOR_PYTHON_NAME; round 3, #1707).
  if (!text.includes('/') && !text.includes('$') && !text.includes('__gha__')) return text === FLOOR_PYTHON_NAME;
  const ids = [...text.matchAll(STEP_OUTPUT)].map((found) => found[1]);
  let rest = text.replace(STEP_OUTPUT, '');
  located = located || rest.includes(PYTHON_LOCATION);
  rest = rest.replaceAll(PYTHON_LOCATION, '');
  // Any other expression, or a mention of `steps` outside one, chooses nothing; `$pythonLocation` and
  // `${{ env.pythonLocation }}` count only after an actions/setup-python step that is sure to have run.
  return !rest.includes('__gha__') && !STEPS.test(rest) && ids.every((id) => setupIds.has(id)) && (!located || setupIds.size > 0);
}

/**
 * A value a script assigns, as `chooses` reads it in place of the variable: the text with its quotes taken off. So
 * `/usr/bin/python3` chooses nothing, nor does a substitution (`$(command -v python3)`), as when it is given to pipx
 * directly; a variable in it (`P="$X"`) is not followed further and counts.
 */
const literal = (value) => value.replace(/['"]/g, '');

/**
 * What one NAMES_SET match sets, read from a line of `shellText` with values: each name with its value (see `literal`;
 * SCRIPT_SET, a value this check does not know but counts, for `for`, `read` and `+=`; UNSET for `unset P`), whether
 * the command exports them (`export`, `declare -x`, `typeset -x`: true) or takes their export away (`export -n`,
 * `declare +x`, `typeset +x`: 'unexport'; round 3, #1707), and the names it only exports or unexports (`export P`,
 * `export -n P`).
 */
function namesSet(found) {
  const { keyword = '', flags = '', declared, loop, read, assigned, unset } = found.groups;
  const exporting = keyword === 'export' || (['declare', 'typeset'].includes(keyword) && /(?:^|\s)-[A-Za-z]*x/.test(flags ?? ''));
  const unexporting = (keyword === 'export' && /(?:^|\s)-[A-Za-z]*n/.test(flags ?? '')) || (['declare', 'typeset'].includes(keyword) && /(?:^|\s)\+[A-Za-z]*x/.test(flags ?? ''));
  const exported = unexporting ? 'unexport' : exporting;
  const pairs = [];
  const marks = [];
  if (loop) pairs.push([loop, SCRIPT_SET]);
  for (const word of (declared ?? '').split(/\s+/).filter(Boolean)) {
    const named = word.match(/^([A-Za-z_][A-Za-z0-9_]*)(\+?)=([\s\S]*)$/);
    if (named) pairs.push([named[1], named[2] ? SCRIPT_SET : literal(named[3])]);
    else if (exported && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) marks.push(word);
  }
  // `unset P` removes P, unless it is given `-f` (a function); its other options take no value.
  const unsetWords = (unset ?? '').split(/\s+/).filter(Boolean);
  if (!unsetWords.some((word) => /^-[A-Za-z]*f/.test(word))) {
    for (const word of unsetWords) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) pairs.push([word, UNSET]);
  }
  for (let at = 0, one; ; at = ONE_ASSIGNMENT.lastIndex) {
    ONE_ASSIGNMENT.lastIndex = at;
    one = ONE_ASSIGNMENT.exec(assigned ?? '');
    if (!one || ONE_ASSIGNMENT.lastIndex <= at) break;
    const value = one[0].trimEnd().slice(one[1].length);
    pairs.push([one[1], value.startsWith('+') ? SCRIPT_SET : literal(value.slice(1))]);
  }
  let pending = '';
  for (const word of (read ?? '').split(/\s+/).filter(Boolean)) {
    if (pending) {
      if (pending === 'a') pairs.push([word, SCRIPT_SET]);
      pending = '';
    } else if (word.startsWith('-') && word.length > 1) {
      for (let k = 1; k < word.length; k++) {
        if (READ_VALUE_OPTIONS.includes(word[k])) {
          if (word.slice(k + 1) && word[k] === 'a') pairs.push([word.slice(k + 1), SCRIPT_SET]);
          pending = word.slice(k + 1) ? '' : word[k];
          break;
        }
      }
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) pairs.push([word, SCRIPT_SET]);
  }
  return [pairs, exported, marks];
}

/**
 * For each character of a `shellText` reading with values, the shells and subshells it runs in, innermost last, and
 * what each one is: "child" for a shell the script starts with its own script (a `-c` or `env -S` script, a heredoc
 * or here-string given to a shell: the lines between `\x01` and `\x02`), which sees only exported variables, and
 * "sub" (or "tick") for a `$(…)`, `<(…)`, backtick pair or `( … )` subshell, which sees all of them. Neither hands the
 * names it sets back out. `$((…))` and `((…))` are arithmetic, not a subshell; a `)` with nothing open (a `case`
 * pattern) closes nothing. The same rule as the Python copies' `_scope_paths`.
 */
function scopePaths(text) {
  const paths = [];
  const kinds = new Map();
  const stack = []; // [id or null, kind, open parentheses]
  let current = [];
  const settle = () => {
    current = stack.filter((frame) => frame[0] !== null).map((frame) => frame[0]);
  };
  const push = (kind, depth = 0) => {
    let ident = null;
    if (kind !== 'arith') {
      ident = kinds.size;
      kinds.set(ident, kind);
    }
    stack.push([ident, kind, depth]);
    settle();
  };
  const n = text.length;
  for (let k = 0; k < n; ) {
    const char = text[k];
    const top = stack.at(-1);
    let step = 1;
    if (char === '\\') step = 2;
    else if (char === '\x01') push('child');
    else if (char === '\x02') {
      while (stack.length && stack.pop()[1] !== 'child');
      settle();
    } else if (text.startsWith('$((', k) || (text.startsWith('((', k) && !(top && top[1] === 'arith'))) {
      step = char === '$' ? 3 : 2;
      push('arith', 2);
    } else if ('$<>'.includes(char) && text.startsWith('(', k + 1)) {
      step = 2;
      push('sub');
    } else if (char === '(') {
      if (top && top[1] === 'arith') top[2] += 1;
      else push('sub');
    } else if (char === ')') {
      if (top && top[1] === 'arith') {
        top[2] -= 1;
        if (top[2] === 0) stack.pop();
      } else if (top && top[1] === 'sub') {
        stack.pop();
        settle();
      }
    } else if (char === '`') {
      if (top && top[1] === 'tick') {
        stack.pop();
        settle();
      } else push('tick');
    }
    for (let i = 0; i < Math.min(step, n - k); i++) paths.push(current);
    k += step;
  }
  return [paths, kinds];
}

/**
 * The variables a command at `here` sees: the step's, job's and workflow's `env:` (which GitHub exports), then every
 * earlier assignment of the script in this shell or one around it, in order, the last one winning over `env:` too
 * (Copilot on HCW-NetworkEyes_App#395); one made outside a child shell reaches into it only when exported (an `env:`
 * name stays exported when the script assigns it). An assignment inside a subshell or child shell that has ended is not
 * seen (Copilot on HCW-HybridCloudWorks#1719). `records` holds the script's assignments by name, and only the names in
 * `names` are worked out; any other name keeps its `env:` value.
 */
function namesView(env, records, here, kinds, names) {
  const view = { ...env };
  // Names the script has unset or unexported since, so an `env:` name no longer reaches a child shell (round 3, #1707).
  const unexported = new Set();
  // Only the names the command reads (`names`), each from its own records, so a long script is not read again in full
  // for every command (round 3 review, #1707: 4,000 lines took seconds).
  for (const [name, value, at, exported] of [...names].flatMap((one) => records.get(one) ?? [])) {
    if (at.some((id, i) => here[i] !== id) || here.length < at.length) continue;
    const crosses = here.slice(at.length).some((id) => kinds.get(id) === 'child');
    if (value === UNSET || (exported === 'unexport' && crosses)) {
      // An unset `pythonLocation` is no longer the one setup-python set, so it is kept as UNSET for `chooses`.
      if (SET_UP_VARIABLES.has(name) && value === UNSET) view[name] = UNSET;
      else delete view[name];
      unexported.add(name);
      continue;
    }
    if (exported === 'unexport') unexported.add(name);
    else if (exported) unexported.delete(name);
    if (!crosses || exported === true || (Object.hasOwn(env, name) && !unexported.has(name))) view[name] = value;
  }
  return view;
}

/**
 * Every `pipx` in command position on a line, each read from where it starts: the search goes on from the start of
 * each match, not its end, so a `pipx` inside an assignment's `$(…)` is read even when a later command on the line took
 * the assignment into its own match (`x=$(sudo pipx run y) PIPX_DEFAULT_PYTHON=/p pipx run z`; Copilot on
 * HCW-HybridCloudWorks#1719).
 */
function pipxCommands(line, pattern = PIPX) {
  const found = [];
  for (let at = 0; ; ) {
    pattern.lastIndex = at;
    const one = pattern.exec(line);
    if (!one) return found;
    found.push(one);
    at = one.index + 1;
  }
}

/**
 * True when `--python` (or `--python=…`) is one of pipx's own options among the words after `pipx`, given a value that
 * chooses the set-up Python (see `chooses`; the last one wins, as in pipx). Reading stops at a bare `--`, after which
 * every word is the app's, and, for `pipx run`, at the app's name (the first word after `run` that is not an option or
 * an option's value), after which every word is the app's argument (`pipx run tool --python x` gives `--python` to the
 * tool).
 */
export function pipxOptionChoosesPython(words, setupIds = new Set(), env = null) {
  let command = null;
  let valueNext = '';
  let chosen = false;
  for (const word of words.split(/\s+/).filter(Boolean)) {
    if (valueNext) {
      if (valueNext === '--python') chosen = chooses(word, setupIds, env);
      valueNext = '';
    } else if (word === '--') return chosen;
    else if (word.startsWith('--python=')) chosen = chooses(word.slice('--python='.length), setupIds, env);
    else if (PIPX_VALUE_OPTIONS.has(word)) valueNext = word;
    else if (word.startsWith('-')) continue;
    else if (command === null) command = word;
    else if (command === 'run') return chosen;
  }
  return chosen;
}

// One word of a command as `shellText` leaves it: plain text and quoted strings run together. The first word in front
// of a command may start with what opened it (`(`, `$(`, `&&`, `;`), which is not part of the word.
const WORD = /(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])+/g;
const OPENING = /^(?:[$<]?\(|[`{|;&])+/;

/**
 * What the words in front of `pipx` do to PIPX_DEFAULT_PYTHON, read in order, the last one that touches it winning as
 * in the shell: true when an assignment sets it to a value that chooses the set-up Python (see `chooses`); false when
 * one sets it to anything else, empty included (`PIPX_DEFAULT_PYTHON=`, `PIPX_DEFAULT_PYTHON=''""`), when `env` unsets
 * it (`-u`, `--unset`) or clears the whole environment (`-i`, `-`, `--ignore-environment`), or when `sudo` resets the
 * environment (it does unless given `-E`, `--preserve-env`, or `--preserve-env=` with a list that names the variable);
 * null when none of them touches it, so the inherited value (the step's, job's or workflow's `env:`, or the outer
 * command's around a `-c` script) applies (Copilot on HCW-NetworkEyes_App#394). A long option of `env` or `sudo` may
 * be shortened as far as it stays unambiguous (see `longOption`). An assignment after `sudo`'s options (`sudo
 * PIPX_DEFAULT_PYTHON=/p pipx`) is sudo's own and sets the variable.
 */
function localDefaultPython(before, setupIds = new Set(), env = null) {
  let chosen = null;
  let wrapper = ''; // 'env' or 'sudo' while reading that word's options
  let following = ''; // the next word is the value of `env -u` ('unset') or of another option ('skip')
  let preserve = false; // `sudo` was told to keep the whole environment (`-E`, `--preserve-env`)
  let named = false; // `sudo` was told to keep PIPX_DEFAULT_PYTHON by name (`--preserve-env=…,PIPX_DEFAULT_PYTHON`)
  let login = false; // `sudo -i` (`--login`), which resets the environment whatever `-E` says (round 3, #1707)
  for (const word of (before.match(WORD) ?? []).map((w) => w.replace(OPENING, ''))) {
    // The word as the command receives it: quotes removed (`-u 'PIPX_DEFAULT_PYTHON'`, `--unset="…"`); a `$'…'` string
    // is already decoded by `shellText` (Copilot on HCW-NetworkEyes_App#395).
    const bare = word.replace(/['"]/g, '');
    if (following) {
      if (following === 'unset' && bare === 'PIPX_DEFAULT_PYTHON') chosen = false;
      following = '';
      continue;
    }
    if (wrapper === 'sudo' && (word === '--' || !word.startsWith('-'))) {
      // The end of sudo's options: it resets the environment now, unless told to keep the variable.
      chosen = named || (preserve && !login) ? chosen : false;
      wrapper = '';
      if (word === '--') continue;
    }
    // An assignment word (`NAME=value`): in `FOO=PIPX_DEFAULT_PYTHON=/p` the name is FOO, and the rest is its value.
    const assignment = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
    if (assignment) {
      if (assignment[1] === 'PIPX_DEFAULT_PYTHON') chosen = chooses(assignment[2], setupIds, env);
      wrapper = '';
    } else if (/^(?:\S*\/)?env$/.test(word)) wrapper = 'env';
    else if (/^(?:\S*\/)?sudo$/.test(word)) [wrapper, preserve, named, login] = ['sudo', false, false, false];
    else if (wrapper === 'sudo' && bare.startsWith('--')) {
      const [name, ...rest] = bare.slice(2).split('=');
      const option = longOption(name, 'sudo');
      if (option === 'preserve-env' && !rest.length) preserve = true;
      else if (option === 'preserve-env') named = named || rest.join('=').split(',').includes('PIPX_DEFAULT_PYTHON');
      else if (option === 'login') login = true;
      else if (WRAPPER_LONG_OPTIONS.sudo.includes(option) && !rest.length) following = 'skip';
    } else if (wrapper === 'sudo') {
      for (let k = 1; k < bare.length; k++) {
        if (bare[k] === 'E') preserve = true;
        else if (bare[k] === 'i') login = true;
        else if (WRAPPER_OPTIONS.sudo.includes(bare[k])) {
          following = bare.slice(k + 1) ? '' : 'skip';
          break;
        }
      }
    } else if (wrapper !== 'env' || word === '--') wrapper = '';
    else if (bare === '-') chosen = false;
    else if (bare.startsWith('--')) {
      const [name, ...rest] = bare.slice(2).split('=');
      const option = longOption(name, 'env');
      if (option === 'ignore-environment') chosen = false;
      else if (option === 'unset' && rest.length) chosen = rest.join('=') === 'PIPX_DEFAULT_PYTHON' ? false : chosen;
      else if ((option === 'unset' || option === 'chdir') && !rest.length) following = option === 'unset' ? 'unset' : 'skip';
    } else if (bare.startsWith('-')) {
      for (let k = 1; k < bare.length; k++) {
        if (bare[k] === 'i') chosen = false;
        else if ('uCS'.includes(bare[k])) {
          const value = bare.slice(k + 1);
          if (bare[k] !== 'S' && !value) following = bare[k] === 'u' ? 'unset' : 'skip';
          else if (bare[k] === 'u' && value === 'PIPX_DEFAULT_PYTHON') chosen = false;
          break;
        }
      }
    } else wrapper = '';
  }
  if (wrapper === 'sudo' && !(named || (preserve && !login))) chosen = false;
  return chosen;
}

/**
 * True when a run script runs `pipx` in command position without choosing its interpreter: no `--python` among pipx's
 * own options, and no PIPX_DEFAULT_PYTHON that chooses the set-up Python, read first from the words in front of that
 * `pipx` (a whole assignment word, not a value that happens to hold the text, and `env`'s unset and clear options and
 * `sudo`'s reset, see `localDefaultPython`) and only when they leave it alone from what the command inherits: the
 * step's, job's and workflow's `env`, or, inside a `-c` script or an `env -S` value, the setting the words in front of
 * that shell make (`PIPX_DEFAULT_PYTHON=/p bash -c 'pipx run x'`). A setting on the command overrides the inherited
 * one (Copilot on HCW-NetworkEyes_App#394). A value counts only when it chooses the set-up Python (see `chooses`):
 * `${{ steps.python.outputs.python-path }}` counts when `python` is in `setupIds`, the ids of the earlier
 * actions/setup-python steps that are sure to have run first; passing setup-python's `python-path` output that way is
 * the documented way to point pipx at the Python it set up
 * (https://github.com/actions/setup-python/blob/main/docs/advanced-usage.md#python-path), as is giving it through a
 * variable of the step's `env:` (`--python "$PYTHON_PATH"`), which is read the same way; a variable that neither the
 * `env:` nor the script sets chooses nothing. An inherited value is used as written, since GitHub does not expand a
 * shell variable in `env:`. `${{ env.X }}` and `${{ matrix.X }}` are read as GitHub replaces them, the script reported
 * when any entry of the job's `matrix` it names leaves pipx without a Python (see `expansions`).
 */
export function pipxWithoutPython(run, env = {}, setupIds = new Set(), matrix = null) {
  return expansions(String(run ?? ''), env ?? {}, matrix).some(([text, values]) => pipxWithoutPythonOnce(text, values, setupIds));
}

// A `pythonLocation` the workflow's, job's or step's own `env:` sets: GitHub's value for it may be that one or
// actions/setup-python's, so neither `$pythonLocation` nor `${{ env.pythonLocation }}` chooses then (round 3, #1707).
const OWN_LOCATION = '${{ pythonLocation set in env: }}';
const LOCATION_EXPRESSION = /\$\{\{\s*env\.pythonLocation\s*\}\}/g;

/**
 * The run script and `env` (the `env` context of `stepEnv`) as GitHub hands them to the shell, once for each
 * combination of the matrix entries the text names: each `${{ matrix.X }}` in a value of `env` replaced by one entry of
 * the job's matrix list X, then each `${{ env.X }}` and `${{ matrix.X }}` in the script replaced, once, by that value or
 * entry (GitHub does not read an expression again in the text one produced; round 3, #1707). An expression it cannot
 * replace stays, and `ghaTokens` writes it as one that chooses nothing (Copilot on HCW-NetworkEyes_AddOn#109).
 * `${{ env.pythonLocation }}` is never replaced: it stays actions/setup-python's word, which `chooses` reads, or, when
 * `env` sets `pythonLocation` itself, becomes OWN_LOCATION. The same rule as the Python copies' `_expansions`.
 */
function expansions(run, env, matrix) {
  const lists = matrix ?? {};
  const listed = (name) => Array.isArray(lists[name]) && lists[name].length > 0;
  const own = Object.hasOwn(env, 'pythonLocation');
  const located = (text) => (own ? text.replace(LOCATION_EXPRESSION, OWN_LOCATION) : text);
  const texts = [run, ...Object.values(env).filter((value) => value !== null && value !== undefined).map(String)];
  const names = [...new Set(texts.flatMap((text) => [...text.matchAll(ENV_OR_MATRIX)].filter((found) => found[1] === 'matrix' && listed(found[2])).map((found) => found[2])))].sort();
  let entries = [{}];
  for (const name of names) entries = entries.flatMap((entry) => lists[name].map((value) => ({ ...entry, [name]: value })));
  return entries.map((entry) => {
    const fromMatrix = (whole, source, name) => (source === 'matrix' && Object.hasOwn(entry, name) ? String(entry[name]) : whole);
    const values = Object.fromEntries(
      Object.entries(env).map(([name, given]) => [name, given === null || given === undefined ? given : located(String(given)).replace(ENV_OR_MATRIX, fromMatrix)])
    );
    if (own) values.pythonLocation = OWN_LOCATION;
    const replace = (whole, source, name) => {
      if (source === 'matrix') return fromMatrix(whole, source, name);
      if (name === 'pythonLocation' || !Object.hasOwn(values, name)) return whole;
      return values[name] === null || values[name] === undefined ? '' : String(values[name]);
    };
    return [located(run).replace(ENV_OR_MATRIX, replace), values];
  });
}

/** The shell variables a text names (`$P`, `${P}`), the only ones `chooses` reads from a view. */
const namesIn = (text) => new Set([...text.matchAll(VARIABLE)].map((found) => found[1] ?? found[2]));

/** `pipxWithoutPython` for one script and `env` with no `${{ env.* }}` or `${{ matrix.* }}` left to replace. */
function pipxWithoutPythonOnce(run, env, setupIds) {
  const stack = [chooses(ghaTokens(String(env?.PIPX_DEFAULT_PYTHON ?? '')), setupIds)];
  env = { ...(env ?? {}) };
  const text = shellText(ghaTokens(String(run ?? '')), true);
  const scopes = []; // `scopePaths(text)`, worked out the first time a script sets a name
  const records = new Map(); // name -> [value, scope path, exported], in the order the script sets them
  // Each change the script makes to PIPX_DEFAULT_PYTHON, in order (see `inherited`): its scope path, what it does
  // ('unset', 'unexport', 'export' or 'assign'), and whether the value it gives chooses the set-up Python (null when it
  // gives none: `export -n PIPX_DEFAULT_PYTHON`). A value this check does not follow (`read`, `+=`) chooses nothing.
  const changes = [];
  // The variables a command at `index` of `text` sees, of those in `names` (see `namesView`).
  const viewAt = (index, names) => {
    if (!records.size) return { ...env };
    if (!scopes.length) scopes.push(...scopePaths(text));
    return namesView(env, records, index >= 0 ? scopes[0][index] : [], scopes[1], names);
  };
  const record = (name, value, here, exported) => {
    if (!records.has(name)) records.set(name, []);
    records.get(name).push([name, value, here, exported]);
  };
  // What a command at `index` inherits for PIPX_DEFAULT_PYTHON: what the shell it runs in (the innermost child shell)
  // was started with, then each change the script made to it in that shell, or in a subshell of it that is still open,
  // in order, the latest winning (Copilot on HCW-NetworkEyes_App#399): `unset` removes it, `export -n` keeps it from the
  // commands the shell starts, `export` gives it to them again, and an assignment changes its value. pipx sees the value
  // only while it is exported: in the outermost shell when the step's, job's or workflow's `env:` sets it or the script
  // exports it, in a child shell when it was handed one that chooses.
  const inherited = (index) => {
    let state = stack.at(-1);
    let exported = stack.length === 1 ? Object.hasOwn(env, 'PIPX_DEFAULT_PYTHON') : state;
    if (changes.length) {
      const here = index >= 0 ? scopes[0][index] : [];
      const child = here.findLastIndex((id) => scopes[1].get(id) === 'child');
      for (const [at, change, choice] of changes) {
        if (at.length <= child || at.some((id, i) => here[i] !== id)) continue;
        if (change === 'unset') {
          [state, exported] = [false, false];
          continue;
        }
        exported = change === 'unexport' ? false : change === 'export' ? true : exported;
        state = choice === null ? state : choice;
      }
    }
    return state && exported;
  };
  let offset = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const lead = offset + raw.length - raw.trimStart().length;
    offset += raw.length + 1;
    if (line.startsWith('\x01')) {
      // A `-c` script (or `env -S` value) starts: it inherits what the words in front of its shell make.
      stack.push(localDefaultPython(line.slice(1), setupIds, viewAt(lead - 1, namesIn(line))) ?? inherited(lead - 1));
      continue;
    }
    if (line.startsWith('\x02')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    // In the order the shell meets them: a name the script sets counts from the end of the command that sets it on, in
    // the shell that set it (see `namesView`); the step's `env:` comes first. A `case` pattern at the start of the line
    // (`pipx) …`) names no command, so `pipx` is looked for after it.
    const skip = CASE_PREFIX.exec(line)?.[0].length ?? 0;
    const events = [
      ...[...line.matchAll(NAMES_SET)].map((found) => [found.index + found[0].length, 0, found]),
      ...pipxCommands(line.slice(skip)).map((found) => [skip + found.index + found.groups.before.length, 1, found]),
    ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [at, kind, found] of events) {
      if (kind === 0) {
        const [pairs, exported, marks] = namesSet(found);
        if (!scopes.length && (pairs.length || marks.length)) scopes.push(...scopePaths(text));
        const here = scopes.length ? scopes[0][lead + at - 1] : [];
        const change = exported === 'unexport' ? 'unexport' : exported === true ? 'export' : 'assign';
        for (const [name, value] of pairs) {
          if (name === 'PIPX_DEFAULT_PYTHON') {
            changes.push(
              value === UNSET
                ? [here, 'unset', null]
                : [here, change, typeof value === 'string' && chooses(value, setupIds, viewAt(lead + at - 1, namesIn(value)))]
            );
          }
          record(name, value, here, exported);
        }
        const view = marks.length ? viewAt(lead + at - 1, marks) : {};
        for (const name of marks) {
          if (name === 'PIPX_DEFAULT_PYTHON') changes.push([here, change, null]);
          if (Object.hasOwn(view, name)) record(name, view[name], here, exported);
        }
        continue;
      }
      const view = viewAt(lead + at, namesIn(found[0]));
      if (!(pipxOptionChoosesPython(found.groups.words, setupIds, view) || (localDefaultPython(found.groups.before, setupIds, view) ?? inherited(lead + at)))) return true;
    }
  }
  return false;
}

/**
 * The ids of the actions/setup-python steps before step `i` that are sure to have run before it (see `setupCovers`),
 * the only steps whose outputs choose pipx's Python; one without an id is `''`, which no output names but which lets
 * `$pythonLocation` count (Copilot on HCW-NetworkEyes_AddOn#109).
 */
export const pythonSetupIds = (steps, i) =>
  new Set(
    steps
      .slice(0, i)
      .flatMap((earlier, j) =>
        SETUP.python.test(String(earlier?.uses ?? '')) && setupCovers(condition(earlier), condition(steps[i]), stepIds(steps.slice(0, j)))
          ? [earlier?.id === undefined || earlier?.id === null ? '' : String(earlier.id)]
          : []
      )
  );

/**
 * The steps of one workflow that run `pipx` without choosing its interpreter, by `stepKey` with the kind `pipx`. A job
 * in a `container:` is skipped, as `unsetSteps` skips it.
 */
export function pipxProblems(file, workflow) {
  const found = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    const steps = stepsOf(file, name, job);
    if (job?.container) continue;
    steps.forEach((step, i) => {
      const env = stepEnv(workflow?.env, job?.env, step?.env);
      if (pipxWithoutPython(step?.run, env, pythonSetupIds(steps, i), job?.strategy?.matrix)) found.push(stepKey(file, name, step, i, 'pipx'));
    });
  }
  return found;
}

/**
 * A composite action's steps (`runs: using: composite`, `runs: steps:`) as one job named `composite`, so they are read
 * the same way as a workflow's; {} for any other kind of action (`node24`, `docker`). A composite action without
 * `runs: steps:` stops the check with an error.
 */
export function actionJobs(action) {
  if (action?.runs?.using !== 'composite') return {};
  // Without `runs: steps:` it would read as having no steps, so it stops the check instead (Copilot on
  // HCW-HybridCloudWorks#1719).
  if (action.runs.steps === undefined) throw new Error('a composite action has no runs: steps: list');
  return { composite: { steps: action.runs.steps } };
}

/**
 * A workflow or action file read as YAML, refusing the one-line (flow) forms the Python copies' and the
 * MigrateOrchestrator copies' line readers refuse, so every copy reads the same files (round 3, #1707): `jobs: {…}`, a
 * job written `{…}`, `steps: […]`, a step written `- {…}`, `strategy: {…}`, `matrix: {…}`, and an action's `runs: {…}`
 * or `runs: steps: […]`, and a plain or quoted value that runs over more than one line. A `with:` or `env:` written
 * `{…}` is read, as the line readers read it. A plain number is read as YAML reads it, `3.10` as `3.1`, which is what
 * GitHub hands an action (actions/runner#849), and the line readers read it the same way.
 */
export function readWorkflow(text, label = 'workflow') {
  const document = parseDocument(text);
  if (document.errors.length) throw new Error(`${label}: ${document.errors[0].message}`);
  // An anchor (`&a`), an alias (`*a`) or a tag (`!!str`): the line readers would read them as text (round 3 review).
  visit(document, {
    Node(key, node) {
      if (isAlias(node) || node.anchor || node.tag) throw new Error(`${label}: an anchor, alias or tag (&, *, !); write the value out`);
    },
  });
  const flow = (node, what) => {
    if ((isMap(node) || isSeq(node)) && node.flow) throw new Error(`${label}: ${what} is written on one line ({…} or […]); write it as a block`);
  };
  const jobs = document.get('jobs', true);
  flow(jobs, 'jobs:');
  const runs = document.get('runs', true);
  flow(runs, 'runs:');
  const groups = [...(isMap(jobs) ? jobs.items.map((pair) => [String(pair.key), pair.value]) : []), ...(isMap(runs) ? [['runs', runs]] : [])];
  for (const [name, job] of groups) {
    flow(job, `job ${name}`);
    if (!isMap(job)) continue;
    const strategy = job.get('strategy', true);
    flow(strategy, `job ${name}: strategy:`);
    if (isMap(strategy)) {
      const matrix = strategy.get('matrix', true);
      flow(matrix, `job ${name}: matrix:`);
      // A matrix is a block of lists or a `${{ … }}` expression (read as no lists); any other value is refused, as the
      // line readers refuse it (Copilot on HCW-NetworkEyes_App#399).
      if (isScalar(matrix) && matrix.value !== null && !/^\$\{\{[\s\S]*\}\}$/.test(String(matrix.value).trim())) {
        throw new Error(`${label}: job ${name}: matrix: is written on one line`);
      }
    }
    const steps = job.get('steps', true);
    flow(steps, `job ${name}: steps:`);
    for (const step of isSeq(steps) ? steps.items : []) flow(step, `job ${name}: a step`);
  }
  for (const node of [jobs, runs, document.get('env', true), document.get('defaults', true)]) {
    if (!isMap(node)) continue;
    visit(node, {
      // Forms the line readers refuse (round 3 review, #1707): a quoted key (`'run': x`), a space before a block key's
      // colon (`run : x`), and a plain or quoted value that starts on the line after its key (`run:` with `node x` below).
      Pair(key, pair, path) {
        if (!isScalar(pair.key) || !pair.key.range) return;
        if (pair.key.type !== 'PLAIN') throw new Error(`${label}: a quoted key (${JSON.stringify(String(pair.key.value))}); write it plain`);
        if (!path.at(-1)?.flow && text[pair.key.range[1]] !== ':') throw new Error(`${label}: a space before the colon of ${pair.key.value}`);
        const value = pair.value;
        if (isScalar(value) && value.range && ['PLAIN', 'QUOTE_DOUBLE', 'QUOTE_SINGLE'].includes(value.type) && text.slice(pair.key.range[0], value.range[0]).includes('\n')) {
          throw new Error(`${label}: the value of ${pair.key.value} starts on the next line; write it on the key's line or as a block (|) value`);
        }
      },
      Scalar(key, scalar) {
        const source = scalar.range ? text.slice(scalar.range[0], scalar.range[1]) : '';
        if (['PLAIN', 'QUOTE_DOUBLE', 'QUOTE_SINGLE'].includes(scalar.type) && source.includes('\n')) {
          throw new Error(`${label}: a value runs over more than one line (${JSON.stringify(source.slice(0, 40))}); write it as a block (|) value`);
        }
      },
    });
  }
  return document.toJS() ?? {};
}

/**
 * Everything this check reads under `root`, each with its label and parsed workflow: every workflow in
 * .github/workflows, named by its file name, then every composite action in .github/actions/<name>/action.yml (or
 * .yaml), named by its path from `root`, as a workflow whose one job is `composite`. A repository without
 * .github/actions has none.
 */
export function sources(root) {
  const list = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []);
  const workflows = list(join(root, '.github', 'workflows'))
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => [name, readWorkflow(readFileSync(join(root, '.github', 'workflows', name), 'utf8'), name)]);
  const actions = list(join(root, '.github', 'actions'))
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => ['action.yml', 'action.yaml'].map((file) => `.github/actions/${entry.name}/${file}`))
    .filter((label) => existsSync(join(root, label)))
    .sort()
    .map((label) => [label, { jobs: actionJobs(readWorkflow(readFileSync(join(root, label), 'utf8'), label)) }]);
  return [...workflows, ...actions];
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
    // `env -S` runs its value as a command, so a quoted value is read like a `-c` script (Copilot on
    // HCW-MigrateOrchestrator_AddOn#74).
    for (const [line, kind] of [
      ["env -S 'node x.js'", 'node'],
      ['env -S "python3 x.py"', 'python'],
      ["env --split-string='node x'", 'node'],
      ["env --split-string 'node x'", 'node'],
      ["env -S'node x'", 'node'],
      ["env -iS 'python3 x.py'", 'python'],
      ["sudo env -S 'FOO=1 node x'", 'node'],
      ['env -S node x.js', 'node'],
      ["env -S 'pipx run x'", 'python'],
    ]) {
      expect(runsRuntime(line, kind), line).toBe(true);
    }
    for (const line of ["env -S 'echo node'", 'env -S echo node', "echo env -S 'node x'", "docker run img env -S 'node x'"]) {
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
    expect(runsRuntime(`env${' -S -i -u X'.repeat(40)} -`, 'node')).toBe(false);
    expect(runsRuntime(`env${" -S 'x'".repeat(40)} -`, 'node')).toBe(false);
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
      ['pipx run --python "$P" tool', { P: '/opt/py/bin/python3' }, false],
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
      ['PIPX_DEFAULT_PYTHON="$P" pipx run x', { P: '/opt/py/bin/python3' }, false],
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
      ['pipx run --python "$P" --spec x x', { P: '/opt/py/bin/python3' }, false],
      ['pipx run --python=/opt/py/bin/python3 x', {}, false],
      ['PIPX_DEFAULT_PYTHON=/p pipx run x', {}, false],
      ['env PIPX_DEFAULT_PYTHON=/p pipx run x', {}, false],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '/p' }, false],
      // A setting on the command overrides the inherited one (Copilot on HCW-NetworkEyes_App#394): set empty, unset or
      // cleared by `env`, it chooses nothing; `--python` still chooses.
      ['PIPX_DEFAULT_PYTHON= pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ["PIPX_DEFAULT_PYTHON='' pipx run x", { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['env -u PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['env -uPIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['env --unset PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['env --unset=PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['env -i pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['env --ignore-environment pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['env --chdir /tmp -u PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['PIPX_DEFAULT_PYTHON=/p env -u PIPX_DEFAULT_PYTHON pipx run x', {}, true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['env -u PIPX_DEFAULT_PYTHON pipx run --python /p x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['env -i PIPX_DEFAULT_PYTHON=/p pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['env -u OTHER pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      // `-u` is sudo's user, not env's unset; `-E` keeps the inherited value (sudo resets it otherwise, see below).
      ['sudo -E -u PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ["env -S 'pipx run x'", {}, true],
      ["env -S 'pipx run x'", { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['(PIPX_DEFAULT_PYTHON=/p pipx run x)', {}, false],
      ['cd y &&PIPX_DEFAULT_PYTHON=/p pipx run x', {}, false],
      ['(PIPX_DEFAULT_PYTHON= pipx run x)', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['x=$(env -i pipx run x)', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['echo pipx', {}, false],
      ['docker run img pipx run x', {}, false],
      ['python3 -m pip install pipx', {}, false],
    ];
    for (const [run, env, flagged] of cases) expect(pipxWithoutPython(run, env), run).toBe(flagged);
  });

  it("reads the step's, job's and workflow's env", () => {
    const scan = 'pipx run checkov -d .';
    const setUp = { id: 'python', uses: 'actions/setup-python@abc', with: { 'python-version': '3.15' } };
    const workflow = {
      env: { FROM_WORKFLOW: '1' },
      jobs: {
        bare: { steps: [{ name: 'Scan', run: 'pipx run --spec checkov==3.3.30 checkov -d .' }] },
        stepEnv: { steps: [setUp, { name: 'Scan', env: { PIPX_DEFAULT_PYTHON: '${{ steps.python.outputs.python-path }}' }, run: scan }] },
        jobEnv: { env: { PIPX_DEFAULT_PYTHON: '/opt/py/bin/python3' }, steps: [{ run: scan }] },
        option: { steps: [setUp, { name: 'Scan', env: { PYTHON_PATH: '${{ steps.python.outputs.python-path }}' }, run: 'pipx run --python "$PYTHON_PATH" --spec checkov==3.3.30 checkov -d .' }] },
        boxed: { container: 'python:3.15', steps: [{ run: scan }] },
      },
    };
    expect(pipxProblems('x.yml', workflow)).toEqual(['x.yml > bare > Scan > pipx']);
    expect(pipxProblems('x.yml', { ...workflow, env: { PIPX_DEFAULT_PYTHON: '/opt/py/bin/python3' } })).toEqual([]);
  });
});

describe('round two: heredocs, attached -c scripts, $\'…\' strings, wrappers, sudo, pipx values, composite actions', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order.
  it('reads the round-two forms as the shell reads them', () => {
    const cases = [
      // An unquoted heredoc runs the `$(...)` and backticks in its body; a quoted or escaped one runs nothing, and
      // the rest of a body is text, quotes included.
      ['cat <<EOF\n$(python3 check.py)\nEOF', 'python', true],
      ['cat <<-EOF\n\tvalue: $(node x.js)\n\tEOF', 'node', true],
      ['cat <<EOF > v.txt\n`node --version`\nEOF', 'node', true],
      ['cat <<EOF\n$(( $(node -p 1) + 1 ))\nEOF', 'node', true],
      ['cat <<EOF\n\'$(python3 x.py)\'\nEOF', 'python', true],
      ['cat <<EOF\n$(bash -c \'node x\')\nEOF', 'node', true],
      ['cat <<A <<\'B\'\n$(node x)\nA\n$(python3 y)\nB', 'node', true],
      ['cat <<A <<\'B\'\n$(node x)\nA\n$(python3 y)\nB', 'python', false],
      ['cat <<EOF\ntext\nEOF\nnode x.js', 'node', true],
      ['cat <<EOF\nnode is named here\nEOF', 'node', false],
      ['cat <<\'EOF\'\n$(node x)\nEOF', 'node', false],
      ['cat <<"EOF"\n$(python3 x)\nEOF', 'python', false],
      ['cat <<\\EOF\n`node x`\nEOF', 'node', false],
      ['cat <<EOF\n\\$(node x)\nEOF', 'node', false],
      ['cat <<EOF\n$(echo node)\nEOF', 'node', false],
      // Text written onto `-c` is read as the script (bash and dash refuse it, so this only errs towards reporting).
      ['bash -cnode x', 'node', true],
      ['sh -cpython3 x.py', 'python', true],
      ['bash -c\'node x\'', 'node', true],
      ['bash -ec\'python3 x.py\'', 'python', true],
      ['sudo bash -lc\'pytest\'', 'python', true],
      ['bash -ce \'node x\'', 'node', true],
      ['docker run img bash -cnode x', 'node', false],
      ['bash -c\'echo node\'', 'node', false],
      ['echo bash -cnode', 'node', false],
      // `$'...'` is decoded, then read as one word.
      ['$\'\\x70ython3\' x.py', 'python', true],
      ['$\'\\160ython3\' x.py', 'python', true],
      ['$\'\\u0070ython3\' x.py', 'python', true],
      ['$\'\\U00000070ython3\' x.py', 'python', true],
      ['$\'/usr/bin/\\x70ython3\' x.py', 'python', true],
      ['FOO=1 $\'n\\157de\' x', 'node', true],
      ['$\'node\\0x\' y', 'node', true],
      ['bash -c $\'node\\x20x\'', 'node', true],
      ['bash -c $\'\\x6eode x\'', 'node', true],
      ['$\'node\\x20x\'', 'node', false],
      ['echo $\'\\x6eode\'', 'node', false],
      ['$\'\\x6eodejs\' x', 'node', false],
      ['$\'\\x\' node', 'node', false],
      // A wrapper named by its path is the same wrapper.
      ['/usr/bin/env node x.js', 'node', true],
      ['/usr/bin/timeout 5 python3 x.py', 'python', true],
      ['/usr/bin/sudo -u nobody node x', 'node', true],
      ['/usr/bin/nice -n 5 node x', 'node', true],
      ['./node_modules/.bin/pnpm install', 'node', true],
      ['/usr/bin/env bash -c \'python3 x.py\'', 'python', true],
      ['/usr/bin/env -S \'node x\'', 'node', true],
      ['echo /usr/bin/env node', 'node', false],
      ['/opt/tools/envy node x', 'node', false],
      // A long option may be shortened while it names one option; an ambiguous start takes no value.
      ['timeout --kill=5 10 node x', 'node', true],
      ['timeout --kill 5 10 node x', 'node', true],
      ['timeout --sig KILL 10 python3 x.py', 'python', true],
      ['env --uns FOO node x', 'node', true],
      ['nice --adj 5 node x', 'node', true],
      ['xargs --max-a 1 node', 'node', true],
      ['sudo --us nobody node x', 'node', true],
      ['stdbuf --out L node x', 'node', true],
      ['sudo --command-t 5 python3 x.py', 'python', true],
      ['xargs --max node x', 'node', true],
      ['env --split \'node x\'', 'node', true],
      ['sudo --us node whoami', 'node', false],
      ['timeout --sig node 10 x', 'node', false],
      ['nice --adj node x', 'node', false],
      // An option that takes a value takes the next word whatever it starts with.
      ['timeout --kill-after -5 10 node x', 'node', true],
      ['nice -n -5 node x', 'node', true],
      ['nice --adjustment -5 python3 x.py', 'python', true],
      ['timeout --kill-after -5 node x', 'node', false],
      // sudo's other options that take a value.
      ['sudo -T 5 node x', 'node', true],
      ['sudo --command-timeout=5 node x', 'node', true],
      ['sudo -R /srv node x', 'node', true],
      ['sudo -T node whoami', 'node', false],

    ];
    for (const [line, kind, found] of cases) expect(runsRuntime(line, kind), `${line} / ${kind}`).toBe(found);
  });

  it('reads what pipx is given, and the settings that reach it, as the shell and GitHub pass them', () => {
    const cases = [
      // A heredoc's body runs pipx only through a substitution of an unquoted heredoc.
      ['cat <<EOF\n$(pipx run x)\nEOF', {}, [], true],
      ['cat <<\'EOF\'\n$(pipx run x)\nEOF', {}, [], false],
      // A step's output counts only for an earlier actions/setup-python step that is sure to have run (`ids`).
      ['pipx run --python ${{ steps.py.outputs.python-path }} x', {}, ['py'], false],
      ['pipx run --python ${{ steps.py.outputs.python-path }} x', {}, [], true],
      ['pipx run --python ${{ steps.py.outputs.python-path }} x', {}, ['other'], true],
      ['pipx run --python "${{ steps.py.outputs.python-path }}" x', {}, ['py'], false],
      ['pipx run --python=${{ steps.py.outputs.python-path }} x', {}, [], true],
      ['pipx run --python ${{ steps.py.outputs[\'python-path\'] }} x', {}, ['py'], false],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ steps.py.outputs.python-path }}' }, ['py'], false],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ steps.py.outputs.python-path }}' }, [], true],
      ['PIPX_DEFAULT_PYTHON=\'${{ steps.py.outputs.python-path }}\' pipx run x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=${{ steps.py.outputs.python-path }} pipx run x', {}, ['py'], false],
      // A variable of the step's `env:` is read the same way; one that is not there stays a value.
      ['pipx run --python "$PYTHON_PATH" x', { PYTHON_PATH: '${{ steps.py.outputs.python-path }}' }, ['py'], false],
      ['pipx run --python "$PYTHON_PATH" x', { PYTHON_PATH: '${{ steps.py.outputs.python-path }}' }, [], true],
      ['pipx run --python ${PYTHON_PATH} x', { PYTHON_PATH: '/usr/bin/python3' }, [], true],
      ['PIPX_DEFAULT_PYTHON="$P" pipx run x', { P: '/usr/bin/python3' }, [], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '$P', P: '/usr/bin/python3' }, [], false],
      // Settings in front of a `-c` shell or `env -S` reach the script inside it.
      ['PIPX_DEFAULT_PYTHON=/p bash -c \'pipx run y\'', {}, [], false],
      ['env PIPX_DEFAULT_PYTHON=/p env -S \'pipx run y\'', {}, [], false],
      ['PIPX_DEFAULT_PYTHON=/p bash -c "bash -c \'pipx run y\'"', {}, [], false],
      ['PIPX_DEFAULT_PYTHON=/p bash -c\'pipx run y\'', {}, [], false],
      ['echo "$(PIPX_DEFAULT_PYTHON=/p bash -c \'pipx run y\')"', {}, [], false],
      ['PIPX_DEFAULT_PYTHON= bash -c \'pipx run y\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['env -u PIPX_DEFAULT_PYTHON bash -c \'pipx run y\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['env -i bash -c \'pipx run y\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['PIPX_DEFAULT_PYTHON=/p bash -c \'PIPX_DEFAULT_PYTHON= pipx run y\'', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=/p bash -c \'true\'; pipx run y', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=/p bash -c "echo $(pipx run y)"', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=/usr/bin/python3 bash -c \'pipx run y\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      // sudo resets the environment unless told to keep the variable; its own assignment sets it.
      ['sudo pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo -E pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['sudo --preserve-env pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['sudo --preserve-env=PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['sudo --preserve-env=PATH,PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['sudo --preserve-env=PATH pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo --preserve-e pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['sudo --preserve pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo PIPX_DEFAULT_PYTHON=/p pipx run x', {}, [], false],
      ['PIPX_DEFAULT_PYTHON=/p sudo pipx run x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=/p sudo -E pipx run x', {}, [], false],
      ['sudo -Eu nobody pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['sudo -uE pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo -u PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo bash -c \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo -E bash -c \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['/usr/bin/sudo pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo -- pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo -E -- pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      // env's long options may be shortened too.
      ['env --uns PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['env --uns=PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['env --ignore-e pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['env --ch /tmp pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['env --chdir=/tmp pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['/usr/bin/env PIPX_DEFAULT_PYTHON=/p pipx run x', {}, [], false],
      // The runner's own Python named by its path chooses nothing.
      ['pipx run --python /usr/bin/python3 x', {}, [], true],
      ['pipx run --python=/usr/bin/python3.12 x', {}, [], true],
      ['pipx run --python /bin/python3 x', {}, [], true],
      ['pipx run --python \'/usr/bin/python3\' x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=/usr/bin/python3 pipx run x', {}, [], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '/usr/bin/python3' }, [], true],
      ['pipx run --python python3.15 x', {}, [], false],
      ['pipx run --python ${{ env.pythonLocation }}/bin/python x', {}, [], true],
      ['pipx run --python ${{ env.pythonLocation }}/bin/python x', {}, [''], false],
      ['pipx run --python /usr/bin/python3 --python /p x', {}, [], false],
      ['pipx run --python /opt/hostedtoolcache/Python/3.15.0/x64/bin/python3 x', {}, [], false],
      // `$'...'` is decoded before it is read.
      ['$\'pipx\' run x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=$\'\' pipx run x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=$\'/usr/bin/python3\' pipx run x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=$\'/opt/py/bin/\\x70ython3\' pipx run x', {}, [], false],

    ];
    for (const [run, env, ids, flagged] of cases) expect(pipxWithoutPython(run, env, new Set(ids)), `${run} / ${JSON.stringify(env)} / ${ids}`).toBe(flagged);
  });

  it("counts a step's output given to pipx only for an earlier set-up Python step that is sure to have run", () => {
    const setUp = { id: 'py', uses: 'actions/setup-python@abc', with: { 'python-version': '3.15' } };
    const scan = { name: 'Scan', run: 'pipx run --python ${{ steps.py.outputs.python-path }} checkov -d .' };
    const workflow = {
      jobs: {
        earlier: { steps: [setUp, scan] },
        later: { steps: [scan, setUp] },
        'not-set-up': { steps: [{ id: 'py', run: 'echo "python-path=/x" >> "$GITHUB_OUTPUT"' }, scan] },
        'uv-only': {
          steps: [
            { id: 'py', uses: 'astral-sh/setup-uv@abc', with: { 'python-version': '3.15' } },
            { name: 'Scan', env: { PIPX_DEFAULT_PYTHON: '${{ steps.py.outputs.python-path }}' }, run: 'pipx run checkov -d .' },
          ],
        },
        'may-be-skipped': { steps: [{ ...setUp, if: "github.event_name == 'push'" }, scan] },
        'same-condition': {
          steps: [
            { ...setUp, if: "github.event_name == 'push'" },
            { name: 'Scan', if: "github.event_name == 'push'", env: { PYTHON_PATH: '${{ steps.py.outputs.python-path }}' }, run: 'pipx run --python "$PYTHON_PATH" checkov -d .' },
          ],
        },
        'no-such-step': {
          steps: [
            { uses: 'actions/setup-python@abc', with: { 'python-version': '3.15' } },
            { name: 'Scan', env: { PYTHON_PATH: '${{ steps.python.outputs.python-path }}' }, run: 'pipx run --python "$PYTHON_PATH" checkov -d .' },
          ],
        },
      },
    };
    expect(pipxProblems('x.yml', workflow)).toEqual([
      'x.yml > later > Scan > pipx',
      'x.yml > not-set-up > Scan > pipx',
      'x.yml > uv-only > Scan > pipx',
      'x.yml > may-be-skipped > Scan > pipx',
      'x.yml > no-such-step > Scan > pipx',
    ]);
  });

  it('refuses steps written on one line, and steps that are not a list of mappings', () => {
    // Since round 3 (#1707) the website refuses `steps: [{…}]` and `- {…}`, as the Python copies' line reader does
    // (`readWorkflow`), so every copy reads the same files. Anything that is not a list of mappings stops the check.
    expect(() => readWorkflow('jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps: [{run: python3 x.py}]\n')).toThrow(/one line/);
    expect(() => readWorkflow('jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - {run: python3 x.py}\n')).toThrow(/one line/);
    const scalar = readWorkflow('jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - run: echo\n      - python3 x.py\n');
    expect(() => unsetSteps('x.yml', scalar.jobs, {})).toThrow(/a step is not a mapping/);
    expect(() => pipxProblems('x.yml', scalar)).toThrow(/a step is not a mapping/);
    expect(() => unsetSteps('x.yml', { j: { steps: 'python3 x.py' } }, {})).toThrow(/steps: is not a list/);
    expect(() => unsetSteps('x.yml', { j: { steps: null } }, {})).toThrow(/steps: is not a list/);
    expect(unsetSteps('x.yml', { j: { uses: './.github/workflows/other.yml' } }, {})).toEqual([]);
  });

  const COMPOSITE = [
    'name: sample',
    'description: a sample action',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - name: Script',
    '      shell: bash',
    '      run: |',
    '        python3 x.py',
    '    - uses: actions/setup-python@abc',
    '      with:',
    '        python-version: "3.14"',
    '    - name: Scan',
    '      shell: bash',
    '      run: pipx run checkov -d .',
    '',
  ].join('\n');

  it('reads a composite action as one job of its own', () => {
    const jobs = actionJobs(parse(COMPOSITE));
    const label = '.github/actions/a/action.yml';
    expect(jobs.composite.steps.map((step) => step.name)).toEqual(['Script', undefined, 'Scan']);
    expect(unsetSteps(label, jobs, {})).toEqual([`${label} > composite > Script > python`]);
    expect(pipxProblems(label, { jobs })).toEqual([`${label} > composite > Scan > pipx`]);
    expect(actionJobs(parse('name: js\nruns:\n  using: node24\n  main: index.js\n'))).toEqual({});
    expect(actionJobs(parse("name: docker\nruns:\n  using: 'docker'\n  image: Dockerfile\n"))).toEqual({});
  });

  it('reads composite actions with the workflows, so their keys can be listed as exceptions', () => {
    const root = mkdtempSync(join(tmpdir(), 'round2-runtime-'));
    try {
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(root, '.github', 'workflows', 'w.yml'), 'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - run: node x.js\n');
      expect(sources(root).map(([label]) => label)).toEqual(['w.yml']);
      for (const name of ['a', 'b', 'c']) mkdirSync(join(root, '.github', 'actions', name), { recursive: true });
      writeFileSync(join(root, '.github', 'actions', 'a', 'action.yml'), COMPOSITE);
      writeFileSync(join(root, '.github', 'actions', 'b', 'action.yaml'), COMPOSITE.replace('python3 x.py', 'node x.js'));
      writeFileSync(join(root, '.github', 'actions', 'c', 'action.yml'), 'name: js\nruns:\n  using: node24\n  main: index.js\n');
      const found = sources(root);
      expect(found.map(([label]) => label)).toEqual(['w.yml', '.github/actions/a/action.yml', '.github/actions/b/action.yaml', '.github/actions/c/action.yml']);
      expect(found.flatMap(([label, workflow]) => unsetSteps(label, workflow.jobs, {}))).toEqual([
        'w.yml > j > step 1 > node',
        '.github/actions/a/action.yml > composite > Script > python',
        '.github/actions/b/action.yaml > composite > Script > node',
      ]);
      expect(found.flatMap(([label, workflow]) => pipxProblems(label, workflow))).toEqual([
        '.github/actions/a/action.yml > composite > Scan > pipx',
        '.github/actions/b/action.yaml > composite > Scan > pipx',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('round two review: assignments, step references, heredocs and here-strings, variables, YAML values, conditions', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order.
  it('reads the review forms as the shell reads them', () => {
    const cases = [
      // An assignment's value holds a whole `$(...)`, `$((...))` or backtick pair, so a substitution that runs into
      // the next word is read from its own `$(`.
      ['FOO=$(date) node x', 'node', true],
      ['FOO=`date` node x', 'node', true],
      ['n=$((n+1)) node x', 'node', true],
      ['x=$(node y)', 'node', true],
      ['x=$(echo node)', 'node', false],
      // An octal or `\x{...}` value keeps its low eight bits, as bash 5.2 does.
      ['$\'\\560ython3\' x.py', 'python', true],
      ['$\'\\556ode\' x', 'node', true],
      ['$\'\\x{70}ython3\' x.py', 'python', true],
      ['$\'\\x{170}ython3\' x.py', 'python', true],
      ['$\'node\\x{0}x\' y', 'node', true],
      ['$\'\\x{zz}node\' x', 'node', false],
      // A heredoc's delimiter is the whole word, quotes taken out; quoted anywhere, its body is text.
      ['cat <<EOF-X\nhi\nEOF-X\nnode x', 'node', true],
      ['cat <<END.txt\nhi\nEND.txt\nnode x', 'node', true],
      ['cat <<E"OF"\nhi\nEOF\nnode x', 'node', true],
      ['cat <<E"OF"\n$(node x)\nEOF', 'node', false],
      ['cat <<\'EOF X\'\nhi\nEOF X\nnode x', 'node', true],
      ['cat <<EOF-1\n$(python3 x)\nEOF-1', 'python', true],
      // A heredoc or here-string given to a shell that reads its script from its input is that shell's script.
      ['bash <<\'EOF\'\nnode x\nEOF', 'node', true],
      ['bash -s <<EOF\npython3 x\nEOF', 'python', true],
      ['sudo bash -s <<\'EOF\'\npython3 x\nEOF', 'python', true],
      ['/bin/sh <<EOF\nnode x\nEOF\necho done', 'node', true],
      ['bash <<< \'node x\'', 'node', true],
      ['sh <<<"python3 x"', 'python', true],
      ['bash <<< node', 'node', true],
      ['cat <<\'EOF\'\nnode x\nEOF', 'node', false],
      ['bash x.sh <<\'EOF\'\nnode x\nEOF', 'node', false],
      ['bash -c \'true\' <<\'EOF\'\nnode x\nEOF', 'node', false],
      ['cat <<< \'node x\'', 'node', false],
      ['docker run -i img bash <<\'EOF\'\nnode x\nEOF', 'node', false],
      ['bash <<\'EOF\'\necho node\nEOF', 'node', false],
      // A heredoc's body inside a substitution is skipped, so its quotes do not hide what follows.
      ['msg="$(cat <<EOF\nit\'s done\nEOF\n)"\nnode x.js', 'node', true],
      ['msg="$(cat <<\'EOF\'\n"quoted\nEOF\n)"\nnode x', 'node', true],
      ['v="$(( 1<<2 ))"\nnode x', 'node', true],
    ];
    for (const [line, kind, found] of cases) expect(runsRuntime(line, kind), `${line} / ${kind}`).toBe(found);
  });

  it('reads the review pipx forms', () => {
    const cases = [
      // A substitution in an assignment's value is read from its own `$(`, with what is in front of the command.
      ['x=$(sudo pipx run y)', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['x=`sudo pipx run y`', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['x="$(sudo pipx run y)"', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['x=$(PIPX_DEFAULT_PYTHON= pipx run y)', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['x=$(PIPX_DEFAULT_PYTHON=/usr/bin/python3 pipx run y)', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['x=$(sudo bash -c \'pipx run y\')', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['y=$(PIPX_DEFAULT_PYTHON=/p pipx run y)', {}, [], false],
      // A `steps` reference written another way names no id this check can read.
      ['pipx run --python ${{ steps[\'py\'].outputs.python-path }} x', {}, ['py'], true],
      ['pipx run --python ${{ steps.py[\'outputs\'].python-path }} x', {}, ['py'], true],
      ['pipx run --python ${{ steps[ \'py\' ].outputs[\'python-path\'] }} x', {}, ['py'], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ steps[\'py\'].outputs.python-path }}' }, ['py'], true],
      ['pipx run --python ${{ STEPS.py.outputs.python-path }} x', {}, ['py'], false],
      ['pipx run --python ${{ STEPS.py.outputs.python-path }} x', {}, [], true],
      // A variable no `env:` and no line of the script sets chooses nothing; `pythonLocation` is setup-python's.
      ['pipx run --python $NOPE x', {}, [], true],
      ['pipx run --python "$NOPE" x', {}, [], true],
      ['pipx run --python $HOME/py/bin/python x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON="$NOPE" pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['P=/opt/py/bin/python3; pipx run --python "$P" x', {}, [], false],
      ['export P=/opt/py/bin/python3\npipx run --python "$P" x', {}, [], false],
      ['for P in /a /b; do pipx run --python "$P" x; done', {}, [], false],
      ['read -r P < p.txt; pipx run --python "$P" x', {}, [], false],
      ['pipx run --python "$pythonLocation/bin/python" x', {}, [], true],
      ['pipx run --python "${pythonLocation}/bin/python" x', {}, [], true],
      ['pipx run --python "$pythonLocation/bin/python" x', {}, [''], false],
      ['pipx run --python "${pythonLocation}/bin/python" x', {}, ['py'], false],
      ['pipx run --python /usr/bin//python3 x', {}, [], true],
      // A heredoc or here-string given to a shell carries the settings in front of that shell.
      ['PIPX_DEFAULT_PYTHON=/p bash <<\'EOF\'\npipx run x\nEOF', {}, [], false],
      ['bash <<\'EOF\'\npipx run x\nEOF', {}, [], true],
      ['sudo bash <<< \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo -E bash <<< \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
    ];
    for (const [run, env, ids, flagged] of cases) expect(pipxWithoutPython(run, env, new Set(ids)), `${run} / ${JSON.stringify(env)} / ${ids}`).toBe(flagged);
  });

  it("counts a later step whose `&&` terms include all of the set-up step's as covered", () => {
    const cases = [
      // A set-up condition with no top-level `||` covers a later step whose `&&` terms include all of its own
      // (Copilot on HCW-MigrateOrchestrator_App#117).
      ['a && b', 'a && b && c', true],
      ['a && b', 'c && a && b', true],
      ['(a && b)', 'c && (a && b)', true],
      ['a && b', '(a && b) && c', true],
      ['a && b', 'a && c', false],
      ['a && b', 'a && b || c', false],
      ['a && b || d', 'a && b && c', false],
      ['a && env.RUN', 'a && env.RUN && c', false],
      ['a && b', '!cancelled() && a && b && c', false],
      ['always() && a && b', 'c && a && b', true],
    ];
    for (const [setup, step, covered] of cases) expect(setupCovers(condition({ if: setup }), condition({ if: step })), `${setup} / ${step}`).toBe(covered);
  });

  // Values YAML reads its own way: null is empty, a block scalar is its text, and `|2-` is a block scalar too.
  const REVIEW_YAML = [
    'on: push',
    'env:',
    '  PY: "3.15"',
    'jobs:',
    '  null-env:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env:',
    '          PIPX_DEFAULT_PYTHON: ~',
    '        run: pipx run checkov -d .',
    '  block-env:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env:',
    '          PIPX_DEFAULT_PYTHON: >-',
    '            /usr/bin/python3',
    '        run: pipx run checkov -d .',
    '  block-env-good:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env:',
    '          PIPX_DEFAULT_PYTHON: |',
    '            /opt/py/bin/python3',
    '        run: pipx run checkov -d .',
    '  block-run:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Script',
    '        run: |2-',
    '            node x.js',
    '      - name: Other',
    '        run: >-2',
    '          python3 y.py',
    '  uv-dev:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with: { python-version: "3.15-dev" }',
    '      - name: Run',
    '        run: uv run x.py',
    '  uv-matrix:',
    '    runs-on: ubuntu-26.04',
    '    strategy:',
    '      matrix:',
    '        py: ["3.15"]',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with: { python-version: "${{ matrix.py }}" }',
    '      - name: Run',
    '        run: uv run x.py',
    '  uv-matrix-old:',
    '    runs-on: ubuntu-26.04',
    '    strategy:',
    '      matrix:',
    '        py: ["3.15", "3.14"]',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with: { python-version: "${{ matrix.py }}" }',
    '      - name: Run',
    '        run: uv run x.py',
    '  uv-env:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: ${{ env.PY }}',
    '      - name: Run',
    '        run: uv run x.py',
    '  uv-block:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: >-',
    '            3.15',
    '      - name: Run',
    '        run: uv run x.py',
    '',
  ].join('\n');

  it('reads YAML values as YAML reads them, and setup-uv versions the way the Python copies do', () => {
    const workflow = parse(REVIEW_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env)).toEqual([
      'x.yml > block-run > Script > node',
      'x.yml > block-run > Other > python',
      'x.yml > uv-dev > Run > python',
      'x.yml > uv-matrix-old > Run > python',
    ]);
    expect(pipxProblems('x.yml', workflow)).toEqual(['x.yml > null-env > Scan > pipx', 'x.yml > block-env > Scan > pipx']);
  });

  it('reads a long script quickly', () => {
    // Reading the current line must not rejoin the whole script each time (8,000 lines once took a minute).
    const script = `${"echo 'a' \"b\" $((1 + 2))\n".repeat(8000)}node y`;
    const started = performance.now();
    expect(runsRuntime(script, 'node')).toBe(true);
    expect(pipxWithoutPython(script, {})).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('round two, Copilot round one: outputs, quoting, substitutions, option values, names, heredoc ends, folding, floors', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order.
  it('reads the Copilot round-one forms as the shell reads them', () => {
    const cases = [
      // A heredoc ends only at a line that is exactly its delimiter, after leading tabs for `<<-` (Copilot on
      // HCW-NetworkEyes_App#395 and HCW-HybridCloudWorks#1719).
      ['cat <<EOF\n EOF \nnode x\nEOF', 'node', false],
      ['cat <<EOF\nbody\n  EOF\nnode x\nEOF', 'node', false],
      ['cat <<-EOF\n\tbody\n\tEOF\nnode x', 'node', true],
      ['cat <<-EOF\n\tbody\n  EOF\nnode x\nEOF', 'node', false],
      ['cat <<EOF\nbody\nEOF\nnode x', 'node', true],
      // A substitution in an assignment's value runs before the command after it (Copilot on
      // HCW-HybridCloudWorks#1719), and `;` ends an assignment.
      ['x=$(node v.js) true', 'node', true],
      ['x=`python3 v.py` true', 'python', true],
      ['FOO=1;node x', 'node', true],
      ['x=$(echo node) true', 'node', false],
    ];
    for (const [line, kind, found] of cases) expect(runsRuntime(line, kind), `${line} / ${kind}`).toBe(found);
  });

  it('reads the Copilot round-one pipx forms', () => {
    const cases = [
      // Only a setup-python step's `python-path` output is its Python; `cache-hit` or `python-version` is not.
      ['pipx run --python ${{ steps.py.outputs.cache-hit }} x', {}, ['py'], true],
      ['pipx run --python ${{ steps.py.outputs.python-version }} x', {}, ['py'], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ steps.py.outputs.cache-hit }}' }, ['py'], true],
      ['pipx run --python ${{ steps.py.outputs.python-path }} x', {}, ['py'], false],
      // No variable is read inside single quotes or after `\`: the shell passes `$P` on as text.
      ['pipx run --python \'$P\' x', { P: '/opt/py/bin/python3' }, [], true],
      ['pipx run --python "\\$P" x', { P: '/opt/py/bin/python3' }, [], true],
      ['pipx run --python \\$P x', { P: '/opt/py/bin/python3' }, [], true],
      ['PIPX_DEFAULT_PYTHON=\'$P\' pipx run x', { P: '/opt/py/bin/python3' }, [], true],
      ['pipx run --python $\'$P\' x', { P: '/opt/py/bin/python3' }, [], true],
      ['pipx run --python "$P" x', { P: '/opt/py/bin/python3' }, [], false],
      // A command substitution this check cannot run chooses nothing.
      ['pipx run --python "$(printf /usr/bin/python3)" x', {}, [], true],
      ['pipx run --python `printf /usr/bin/python3` x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=$(command -v python3) pipx run x', {}, [], true],
      ['pipx run --python "$(command -v python3)" x', {}, [], true],
      // A wrapper's option values are read without their quotes.
      ['env --unset=\'PIPX_DEFAULT_PYTHON\' pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['env -u \'PIPX_DEFAULT_PYTHON\' pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['env -u "PIPX_DEFAULT_PYTHON" pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['env -u\'PIPX_DEFAULT_PYTHON\' pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['env -u $\'PIPX_DEFAULT_PYTHON\' pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo --preserve-env=\'PIPX_DEFAULT_PYTHON\' pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['sudo --preserve-env="PATH,PIPX_DEFAULT_PYTHON" pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      // A name the script sets counts only where the shell sets it, and only for the commands after it.
      ['echo P=/opt/py/bin/python3; pipx run --python "$P" x', {}, [], true],
      ['echo \'P=x\'; pipx run --python "$P" x', {}, [], true],
      ['# P=/x\npipx run --python "$P" x', {}, [], true],
      ['cat <<\'EOF\'\nP=/opt/py/bin/python3\nEOF\npipx run --python "$P" x', {}, [], true],
      ['P=/opt/py/bin/python3 pipx run --python "$P" x', {}, [], true],
      ['pipx run --python "$P" x; P=/opt/py/bin/python3', {}, [], true],
      ['pipx run --python "$P" x\nP=/opt/py/bin/python3', {}, [], true],
      ['P=/opt/py/bin/python3; pipx run --python "$P" x', {}, [], false],
      ['if true; then P=/opt/py/bin/python3; fi\npipx run --python "$P" x', {}, [], false],
      ['declare -x P=/opt/py/bin/python3\npipx run --python "$P" x', {}, [], false],
      // A `pipx` inside an assignment's `$(...)` is read even when a later command shares the line.
      ['x=$(sudo pipx run y) true', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['x=$(sudo pipx run y) PIPX_DEFAULT_PYTHON=/p pipx run z', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['x=$(PIPX_DEFAULT_PYTHON=/p pipx run y) PIPX_DEFAULT_PYTHON=/p pipx run z', {}, [], false],
      // The Azure CLI's Python on the runner is the runner's own too.
      ['pipx run --python /opt/az/bin/python3 x', {}, [], true],
      ['pipx run --python /opt/az/bin/python3.13 x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=/opt/az/bin/python3 pipx run x', {}, [], true],
    ];
    for (const [run, env, ids, flagged] of cases) expect(pipxWithoutPython(run, env, new Set(ids)), `${run} / ${JSON.stringify(env)} / ${ids}`).toBe(flagged);
  });

  it('reads a minor line written with .x as its line', () => {
    const cases = [
      // `N.M.x` names a line, like `N.M` (Copilot on HCW-HybridCloudWorks#1719).
      ['3.15.x', 'python', false],
      ['3.14.x', 'python', true],
      ['26.11.x', 'node', false],
      ['26.10.x', 'node', true],
      ['3.15.x.1', 'python', null],
    ];
    for (const [version, kind, below] of cases) expect(belowFloor(version, kind), `${version} / ${kind}`).toBe(below);
  });

  // A `run: >` script is folded as YAML folds it: lines at the base indent join with a space; a blank line or a line
  // indented further keeps its line break, and the base indent is the indentation indicator's when there is one (`>2-`:
  // the key's indent plus two; Copilot on HCW-NetworkEyes_App#395).
  const FOLDED_YAML = [
    'on: push',
    'jobs:',
    '  folded:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Joined',
    '        run: >-',
    '          echo',
    '          node x.js',
    '      - name: Blank line',
    '        run: >',
    '          echo start',
    '',
    '          node x.js',
    '      - name: Indented',
    '        run: >',
    '          echo start',
    '            python3 y.py',
    '      - name: Indicator',
    '        run: >2-',
    '            echo',
    '            pytest',
    '',
  ].join('\n');

  it('reads a folded run script as GitHub reads it', () => {
    expect(unsetSteps('x.yml', parse(FOLDED_YAML).jobs, {})).toEqual(['x.yml > folded > Blank line > node', 'x.yml > folded > Indented > python', 'x.yml > folded > Indicator > python']);
  });

  // A composite action whose set-up step's version comes from its inputs, or is not given, cannot be read, so the floor
  // rule reports it (Copilot on HCW-HybridCloudWorks#1719).
  const INPUTS_ACTION = [
    'name: sample',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - uses: actions/setup-python@abc',
    '      with:',
    '        python-version: ${{ inputs.python }}',
    '    - uses: actions/setup-node@abc',
    '    - uses: astral-sh/setup-uv@abc',
    '      with:',
    '        python-version: ${{ inputs.python }}',
    '    - name: Script',
    '      shell: bash',
    '      run: python3 x.py',
    '',
  ].join('\n');

  it('reports a composite set-up step whose version cannot be read', () => {
    const label = '.github/actions/a/action.yml';
    const jobs = actionJobs(parse(INPUTS_ACTION));
    expect(unsetSteps(label, jobs, {})).toEqual([]);
    expect(floorProblems(label, jobs, REPO)).toEqual([
      `${label} > composite > step 1 > python: cannot work out the version it asks for`,
      `${label} > composite > step 2 > node: cannot work out the version it asks for`,
      `${label} > composite > step 3 > python: cannot work out the version it asks for`,
    ]);
  });
});

describe('round two, Copilot round two: names stay in the shell that set them and win over env', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order.
  it('reads a name the script sets only in its own shell, after it, and over env', () => {
    const cases = [
      // A name the script sets stays in the shell that set it: a `-c` script, a shell fed a heredoc, a `$(...)`,
      // a backtick pair or a `( ... )` subshell hands nothing back; a child shell sees only exported names, a
      // subshell sees them all (Copilot on HCW-HybridCloudWorks#1719).
      ['bash -c \'P=/opt/py/bin/python3\' ; pipx run --python "$P" x', {}, [], true],
      ['x=$(P=/opt/py/bin/python3; echo) ; pipx run --python "$P" x', {}, [], true],
      ['(P=/opt/py/bin/python3); pipx run --python "$P" x', {}, [], true],
      ['P=/opt/py/bin/python3; bash -c \'pipx run --python "$P" x\'', {}, [], true],
      ['export P=/opt/py/bin/python3; bash -c \'pipx run --python "$P" x\'', {}, [], false],
      ['P=/opt/py/bin/python3; x=$(pipx run --python "$P" x)', {}, [], false],
      ['P=/opt/py/bin/python3; (pipx run --python "$P" x)', {}, [], false],
      ['bash -c \'pipx run --python "$P" x\'', { P: '/opt/py/bin/python3' }, [], false],
      ['bash -c \'P=/opt/py/bin/python3; pipx run --python "$P" x\'', {}, [], false],
      ['bash <<\'EOF\'\nP=/opt/py/bin/python3\nEOF\npipx run --python "$P" x', {}, [], true],
      ['P=/opt/py/bin/python3\nbash <<\'EOF\'\npipx run --python "$P" x\nEOF', {}, [], true],
      ['declare -x P=/opt/py/bin/python3\nbash <<\'EOF\'\npipx run --python "$P" x\nEOF', {}, [], false],
      ['echo "$(P=/opt/py/bin/python3; echo)"; pipx run --python "$P" x', {}, [], true],
      ['x=`P=/opt/py/bin/python3; echo`; pipx run --python "$P" x', {}, [], true],
      ['{ P=/opt/py/bin/python3; }; pipx run --python "$P" x', {}, [], false],
      // A later assignment in the script wins over the step's, job's or workflow's `env:`, and its value is read
      // the same way (Copilot on HCW-NetworkEyes_App#395).
      ['P=/usr/bin/python3; pipx run --python "$P" x', { P: '/opt/py/bin/python3' }, [], true],
      ['bash -c \'P=/usr/bin/python3\'; pipx run --python "$P" x', { P: '/opt/py/bin/python3' }, [], false],
      ['pipx run --python "$P" x; P=/usr/bin/python3', { P: '/opt/py/bin/python3' }, [], false],
      ['P=/usr/bin/python3\nbash -c \'pipx run --python "$P" x\'', { P: '/opt/py/bin/python3' }, [], true],
      ['P=\nPIPX_DEFAULT_PYTHON="$P" pipx run x', { P: '/opt/py/bin/python3' }, [], true],
      ['P=/opt/py/bin/python3; pipx run --python "$P" x', { P: '/usr/bin/python3' }, [], false],
      ['P=$(command -v python3); pipx run --python "$P" x', {}, [], true],
    ];
    for (const [run, env, ids, flagged] of cases) expect(pipxWithoutPython(run, env, new Set(ids)), `${run} / ${JSON.stringify(env)}`).toBe(flagged);
  });
});

describe('round two, Copilot round three: process substitutions, version files, composite steps', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order.
  it('reads a process substitution given as pipx\'s Python as choosing nothing', () => {
    const cases = [
      // A process substitution given as pipx's Python is `/dev/fd/N` to pipx, which this check cannot vouch for
      // (Copilot on HCW-NetworkEyes_App#395).
      ['pipx run --python <(printf /opt/py/bin/python3) x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=<(printf /opt/py/bin/python3) pipx run x', {}, [], true],
      ['P=<(printf /opt/py/bin/python3); pipx run --python "$P" x', {}, [], true],
      ['pipx run --python >(cat) x', {}, [], true],
    ];
    for (const [run, env, ids, flagged] of cases) expect(pipxWithoutPython(run, env, new Set(ids)), run).toBe(flagged);
    expect(runsRuntime('FOO=<(node v.js) true', 'node')).toBe(true);
    expect(runsRuntime('FOO=<(x) node y', 'node')).toBe(true);
  });

  // Each job names a version file; only `.python-version`, `.nvmrc` or `.node-version` at a relative path inside the
  // checkout, with no `..` and no symbolic link on the way, is read (Copilot on HCW-HybridCloudWorks#1719).
  const VERSION_FILE_YAML = [
    'on: push',
    'jobs:',
    '  plain:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version-file: .python-version }',
    '  nested-old:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version-file: ./sub/.python-version }',
    '  other-name:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-node@abc',
    '        with: { node-version-file: ci/node-runtime.txt }',
    '  escape:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version-file: ../../../../proc/self/.python-version }',
    '  absolute:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version-file: /etc/.python-version }',
    '  link:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-node@abc',
    '        with: { node-version-file: .nvmrc }',
    '  linked-folder:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version-file: linked/.python-version }',
    '  missing:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-node@abc',
    '        with: { node-version-file: .node-version }',
    '',
  ].join('\n');

  it('reads a version file only inside the checkout and by its usual name', () => {
    const base = mkdtempSync(join(tmpdir(), 'round2-version-files-'));
    try {
      const root = join(base, 'repo');
      for (const dir of ['sub', 'ci', 'real']) mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, '.python-version'), '3.15\n');
      writeFileSync(join(root, 'sub', '.python-version'), '3.14\n');
      writeFileSync(join(root, 'ci', 'node-runtime.txt'), '26\n');
      writeFileSync(join(root, 'real', '.nvmrc'), '26\n');
      writeFileSync(join(root, 'real', '.python-version'), '3.15\n');
      symlinkSync(join(root, 'real', '.nvmrc'), join(root, '.nvmrc'));
      symlinkSync(join(root, 'real'), join(root, 'linked'), 'dir');
      const label = 'x.yml';
      expect(floorProblems(label, parse(VERSION_FILE_YAML).jobs, root)).toEqual([
        `${label} > nested-old > step 1 > python: asks for 3.14, below the floor`,
        `${label} > other-name > step 1 > node: cannot work out the version it asks for`,
        `${label} > escape > step 1 > python: cannot work out the version it asks for`,
        `${label} > absolute > step 1 > python: cannot work out the version it asks for`,
        `${label} > link > step 1 > node: cannot work out the version it asks for`,
        `${label} > linked-folder > step 1 > python: cannot work out the version it asks for`,
        `${label} > missing > step 1 > node: cannot work out the version it asks for`,
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('stops on a composite action without steps', () => {
    // It would otherwise read as having no steps (Copilot on HCW-HybridCloudWorks#1719).
    expect(() => actionJobs(parse('name: x\nruns:\n  using: composite\n'))).toThrow(/no runs: steps: list/);
  });
});

describe('round two, Copilot round four: pipx expressions, pythonLocation, resolved paths, mixed conditions, block values', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order.
  it('reads the Copilot round-four pipx values', () => {
    const cases = [
      // A: a GitHub expression other than setup-python's `python-path` output or `env.pythonLocation` chooses nothing
      // (Copilot on HCW-NetworkEyes_AddOn#109, HCW-MigrateOrchestrator_AddOn#75 and HCW-CloudCrawler_App#85).
      ['pipx run --python ${{ github.workspace }}/.venv/bin/python x', {}, ['py'], true],
      ['pipx run --python ${{ inputs.python }} x', {}, ['py'], true],
      ['pipx run --python ${{ env.UNSET }} x', {}, ['py'], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ inputs.python }}' }, ['py'], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ env.NOT_PYTHON_LOCATION }}' }, ['py'], true],
      ['pipx run --python "$P" x', { P: '${{ github.workspace }}/py' }, ['py'], true],
      ['pipx run --python ${{ steps.py.outputs.python-path }}${{ github.sha }} x', {}, ['py'], true],
      ['pipx run --python steps.py.outputs.python-path x', {}, ['py'], true],
      // `${{ env.X }}` is read as GitHub replaces it: it chooses when the value it stands for does.
      ['pipx run --python ${{ env.PY }} x', { PY: '${{ steps.py.outputs.python-path }}' }, ['py'], false],
      ['pipx run --python ${{ env.PY }} x', { PY: '${{ steps.py.outputs.python-path }}' }, [], true],
      ['pipx run --python ${{ env.PY }} x', { PY: '/usr/bin/python3' }, ['py'], true],
      ['pipx run --python ${{ env.PY }} x', { PY: '/opt/py/bin/python3' }, [], false],
      ['pipx run --python ${{env.PY}} x', { PY: '${{ env.PY }}' }, ['py'], true],
      // `env` here is the context GitHub has already evaluated (see `stepEnv`), so a value in it that still holds
      // `${{ env.PY }}` was a sibling GitHub does not read, and chooses nothing (round 3, #1707).
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ env.PY }}', PY: '/opt/py/bin/python3' }, [], true],
      ['pipx run --python "$PYTHON_PATH" x', { PYTHON_PATH: '${{ steps.python.outputs.python-path }}' }, ['python'], false],
      ['PY=/opt/py; pipx run --python ${{ env.PY }} x', { PY: '/usr/bin/python3' }, [], true],
      // B: `$pythonLocation` and `${{ env.pythonLocation }}` count only after a set-up step, with or without an id.
      ['pipx run --python ${{ env.pythonLocation }}/bin/python3 x', {}, ['py'], false],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ env.pythonLocation }}/bin/python3' }, [], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ env.pythonLocation }}/bin/python3' }, [''], false],
      ['PIPX_DEFAULT_PYTHON=$pythonLocation/bin/python3 pipx run x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=$pythonLocation/bin/python3 pipx run x', {}, [''], false],
      // An `env:` that sets `pythonLocation` itself leaves it unknown which value GitHub uses (round 3, #1707).
      ['pipx run --python ${{ env.pythonLocation }}/bin/python3 x', { pythonLocation: '/opt/py' }, [], true],
      ['pipx run --python ${{ env.pythonLocation }}/bin/python3 x', { pythonLocation: '/usr' }, [''], true],
      // C: a path is compared as the shell resolves it (Copilot on HCW-MigrateOrchestrator_AddOn#75).
      ['pipx run --python /usr/bin/../bin/python3 x', {}, [], true],
      ['pipx run --python /usr/./bin/python3 x', {}, [], true],
      ['pipx run --python //usr/bin/python3 x', {}, [], true],
      ['pipx run --python /opt/az/lib/../bin/python3 x', {}, [], true],
      ['pipx run --python /usr/bin/python3/ x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=/usr/local/../bin/python3 pipx run x', {}, [], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '/bin/./python3' }, [], true],
      // /usr/local/bin is the runner's too since round 3 (#1707), so this path is read as the runner's Python.
      ['pipx run --python /usr/bin/../local/bin/python3 x', {}, [], true],
      ['pipx run --python /usr/bin/../../opt/py/bin/python3 x', {}, [], false],
      ['pipx run --python /opt/py/../py/bin/python3 x', {}, [], false],
    ];
    for (const [run, env, ids, flagged] of cases) expect(pipxWithoutPython(run, env, new Set(ids)), `${run} / ${JSON.stringify(env)} / ${ids}`).toBe(flagged);
  });

  it('reads a matrix value given to pipx for every entry', () => {
    // `${{ matrix.X }}` is read as GitHub replaces it, once for each entry of the job's matrix list (Copilot on
    // HCW-NetworkEyes_AddOn#109): one entry naming the runner's Python is enough to report it.
    const run = 'pipx run --python ${{ matrix.py }} x';
    expect(pipxWithoutPython(run, {}, new Set(), { py: ['/opt/a/python3', '/opt/b/python3'] })).toBe(false);
    expect(pipxWithoutPython(run, {}, new Set(), { py: ['/opt/a/python3', '/usr/bin/python3'] })).toBe(true);
    expect(pipxWithoutPython(run, {}, new Set(), {})).toBe(true);
    expect(pipxWithoutPython('pipx run x', { PIPX_DEFAULT_PYTHON: '${{ matrix.py }}' }, new Set(), { py: ['/opt/a/python3'] })).toBe(false);
    const workflow = parse(
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    strategy:\n      matrix:\n        py: [/opt/a/python3, /bin/python3]\n    steps:\n      - name: Scan\n        run: pipx run --python ${{ matrix.py }} x\n'
    );
    expect(pipxProblems('x.yml', workflow)).toEqual(['x.yml > j > Scan > pipx']);
  });

  it('counts a python location only after a set-up step, one without an id too', () => {
    // `pythonSetupIds` names a set-up step without an id as '' (Copilot on HCW-NetworkEyes_AddOn#109).
    const workflow = parse(
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - name: Before\n' +
        '        run: pipx run --python "$pythonLocation/bin/python3" x\n' +
        "      - uses: actions/setup-python@abc\n        with:\n          python-version: '3.15'\n" +
        '      - name: After\n' +
        '        run: pipx run --python "$pythonLocation/bin/python3" x\n' +
        '      - name: Skipped set-up\n        if: inputs.go\n        uses: actions/setup-python@abc\n'
    );
    expect([...pythonSetupIds(workflow.jobs.j.steps, 2)]).toEqual(['']);
    expect(pipxProblems('x.yml', workflow)).toEqual(['x.yml > j > Before > pipx']);
  });

  it("counts a set-up term joined with || as holding when one of its terms does", () => {
    const cases = [
      // D: a set-up `&&` term that joins terms with `||` holds when one of those is among the later step's `&&` terms
      // (Copilot on HCW-MigrateOrchestrator_App#118).
      ['(a || b) && c', 'a && c', true],
      ['(a || b) && c', 'c && b', true],
      ['(a || b) && c', 'd && c', false],
      ['(a || b) && c', 'a', false],
      ['(a || b) && c', '(a || b) && c && d', true],
      ['(a || env.B) && c', 'a && c', true],
      ['(env.A || b) && c', 'env.A && c', false],
      ['(a || b) && c', 'a && c || d', false],
      ['a || b && c', 'a && c', true],
      ['(a || (b && d)) && c', 'b && d && c', false],
    ];
    for (const [setup, step, covered] of cases) expect(setupCovers(condition({ if: setup }), condition({ if: step })), `${setup} / ${step}`).toBe(covered);
  });

  // A block value in `env:` or `with:` ends at the first line indented no further than its key; the `yaml` package
  // reads it so already, and the Python copies' and the MigrateOrchestrator copies' line readers now do too.
  const BLOCK_VALUE_YAML = [
    'jobs:',
    '  j:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - id: py',
    '        uses: actions/setup-python@abc',
    '        with:',
    "          python-version: '3.15'",
    '      - name: Comment after block',
    '        env:',
    '          PIPX_DEFAULT_PYTHON: |-',
    '            /usr/bin/python3',
    '# a comment at column 0',
    '        run: pipx run x',
    '      - name: Indented comment after block',
    '        env:',
    '          PIPX_DEFAULT_PYTHON: |-',
    '            /usr/bin/python3',
    "          # a comment at the key's indent",
    '        run: pipx run x',
    '      - name: Key after block',
    '        env:',
    '          A: |-',
    '            /usr/bin/python3',
    '          PIPX_DEFAULT_PYTHON: ${{ steps.py.outputs.python-path }}',
    '        run: pipx run x',
    '      - name: Blank and comment lines inside',
    '        env:',
    '          A: |',
    '            a',
    '',
    '            # kept: indented like the value',
    '            b',
    '        run: echo "$A"',
    '',
  ].join('\n');

  it('ends a block value at the first line indented no further than its key', () => {
    const workflow = parse(BLOCK_VALUE_YAML);
    expect(workflow.jobs.j.steps.slice(1).map((step) => step.env)).toEqual([
      { PIPX_DEFAULT_PYTHON: '/usr/bin/python3' },
      { PIPX_DEFAULT_PYTHON: '/usr/bin/python3' },
      { A: '/usr/bin/python3', PIPX_DEFAULT_PYTHON: '${{ steps.py.outputs.python-path }}' },
      { A: 'a\n\n# kept: indented like the value\nb\n' },
    ]);
    expect(pipxProblems('x.yml', workflow)).toEqual(['x.yml > j > Comment after block > pipx', 'x.yml > j > Indented comment after block > pipx']);
  });
});

describe('round three: wrappers, quoted words, sudo, shells, env levels, pipx values, YAML values', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order
  // (round 3 of #1707: https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1707#issuecomment-6848049164).
  it('reads the round-three forms as the shell reads them', () => {
    const cases = [
      // 2: a quoted plain word is that word to the shell, so `'node' x` runs node.
      ["'node' x.js", 'node', true],
      ['"python3" x.py', 'python', true],
      ["'/usr/bin/'python3 x.py", 'python', true],
      ['"no""de" x', 'node', true],
      ["sudo 'node' x", 'node', true],
      ["echo 'node' x", 'node', false],
      ["'node x'", 'node', false],
      ['"no\\de" x', 'node', false],
      ["'FOO=1' node x", 'node', false],
      // 15: `eval` runs its arguments as a script.
      ['eval node x.js', 'node', true],
      ["eval 'node x.js'", 'node', true],
      ['eval "python3 x.py"', 'python', true],
      ['eval -- node x', 'node', true],
      ["eval echo 'a; node x'", 'node', true],
      ["x=$(eval 'node y')", 'node', true],
      ['echo eval node x', 'node', false],
      ['eval echo node', 'node', false],
      // 5: the outer shell runs only the substitutions of a double-quoted string, not the rest of its text.
      ['echo "a; node x $(true)"', 'node', false],
      ['echo "a | python3 x `true`"', 'python', false],
      ['echo "\\$(node x)"', 'node', false],
      ['echo "<(node x)"', 'node', false],
      ['bash -c "x; node y $(true)"', 'node', true],
      ['echo "a $(node x) b"', 'node', true],
    ];
    for (const [line, kind, found] of cases) expect(runsRuntime(line, kind), `${line} / ${kind}`).toBe(found);
  });

  it('reads the round-three pipx forms', () => {
    const cases = [
      // 1: `export -n` and `declare +x` take a name's export away, so a child shell no longer sees it.
      ['export -n P=/opt/py/bin/python3; bash -c \'pipx run --python "$P" x\'', {}, [], true],
      ['export P=/opt/py/bin/python3; export -n P; bash -c \'pipx run --python "$P" x\'', {}, [], true],
      ['export -n P; bash -c \'pipx run --python "$P" x\'', { P: '/opt/py/bin/python3' }, [], true],
      ['declare +x P; bash -c \'pipx run --python "$P" x\'', { P: '/opt/py/bin/python3' }, [], true],
      ['export -n P=/opt/py/bin/python3; pipx run --python "$P" x', {}, [], false],
      ['export -n PIPX_DEFAULT_PYTHON; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['export P=/opt/py/bin/python3; bash -c \'pipx run --python "$P" x\'', {}, [], false],
      // 10: `unset` removes a name for the rest of that shell.
      ['unset PIPX_DEFAULT_PYTHON; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['unset -v PIPX_DEFAULT_PYTHON\npipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['unset -f PIPX_DEFAULT_PYTHON; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['(unset PIPX_DEFAULT_PYTHON); pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['unset PIPX_DEFAULT_PYTHON; PIPX_DEFAULT_PYTHON=/p pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ["unset PIPX_DEFAULT_PYTHON; PIPX_DEFAULT_PYTHON=/p bash -c 'pipx run x'", { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ["unset PIPX_DEFAULT_PYTHON; bash -c 'pipx run x'", { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ["bash -c 'unset PIPX_DEFAULT_PYTHON; pipx run x'", { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ["bash -c 'unset PIPX_DEFAULT_PYTHON'; pipx run x", { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['unset P; pipx run --python "$P" x', { P: '/opt/py/bin/python3' }, [], true],
      ['PIPX_DEFAULT_PYTHON=/usr/bin/python3; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      // An export in the script that chooses is read too since Copilot's third review of HCW-NetworkEyes_App#399.
      ['export PIPX_DEFAULT_PYTHON=/opt/py/bin/python3; pipx run x', {}, [], false],
      // 5: the outer shell runs only the substitutions of a double-quoted string, not the rest of its text.
      ['PIPX_DEFAULT_PYTHON=/p bash -c "x; pipx run y $(true)"', {}, [], false],
      ['bash -c "x; pipx run y $(true)"', {}, [], true],
      ['echo "a; pipx run y $(true)"', {}, [], false],
      ['PIPX_DEFAULT_PYTHON=/p bash -c "echo $(pipx run y)"', {}, [], true],
      // 2: a quoted plain word is that word to the shell, so `'node' x` runs node.
      ["'pipx' run x", {}, [], true],
      ['"pipx" run --python /p x', {}, [], false],
      // 15: `eval` runs its arguments as a script.
      ["eval 'pipx run x'", {}, [], true],
      ['eval pipx run x', {}, [], true],
      ["PIPX_DEFAULT_PYTHON=/p eval 'pipx run x'", {}, [], false],
      // 9: `sudo -i` resets the environment whatever `-E` says; a list naming the variable still passes it.
      ['sudo -iE pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo -E -i pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo --login --preserve-env pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo --log -E pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      ['sudo -i --preserve-env=PIPX_DEFAULT_PYTHON pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      ['sudo -E pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], false],
      // 12: a bare name is looked up on PATH, so only the floor's own `python3.15` counts.
      ['pipx run --python python3 x', {}, [], true],
      ['pipx run --python python x', {}, [], true],
      ['pipx run --python python3.14 x', {}, [], true],
      ['pipx run --python 3.15 x', {}, [], true],
      ['pipx run --python python3.15 x', {}, [], false],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: 'python3' }, [], true],
      ['PIPX_DEFAULT_PYTHON=python3.15 pipx run x', {}, [], false],
      ['P=python3; pipx run --python "$P" x', {}, [], true],
      // 13: a `..` after a part this check cannot see can climb anywhere.
      ['pipx run --python ${{ env.pythonLocation }}/../../usr/bin/python3 x', {}, [''], true],
      ['pipx run --python ${{ steps.py.outputs.python-path }}/../python3 x', {}, ['py'], true],
      ['pipx run --python "$pythonLocation/../../../usr/bin/python3" x', {}, [''], true],
      ['pipx run --python "$P/../bin/python3" x', { P: '/opt/py/bin' }, [], false],
      ['pipx run --python ${{ env.pythonLocation }}/bin/python3 x', {}, [''], false],
      // 14: `${{ env.pythonLocation }}` stays setup-python's word; an `env:` that sets it leaves it unknown.
      ['pipx run --python ${{ env.pythonLocation }}/bin/python3 x', { pythonLocation: '/opt/py' }, [''], true],
      ['pipx run --python "$pythonLocation/bin/python3" x', { pythonLocation: '/opt/py' }, [''], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ env.pythonLocation }}/bin/python3', pythonLocation: '/usr' }, [''], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '${{ env.pythonLocation }}/bin/python3' }, [''], false],
      // 16: globs, braces, escapes and a leading `~` are read before the shell could expand them.
      ['pipx run --python /usr/bin/python* x', {}, [], true],
      ['pipx run --python /usr/bin/pyt\\hon3 x', {}, [], true],
      ['pipx run --python ~/py/bin/python3 x', {}, [], true],
      ['pipx run --python /opt/py/bin/python{3,} x', {}, [], true],
      ['pipx run --python /usr/bin/python3.1? x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=~/py/bin/python3 pipx run x', {}, [], true],
      ['pipx run --python /opt/py/bin/pyth\\on3 x', {}, [], false],
      // 8: /usr/local/bin is the runner's.
      ['pipx run --python /usr/local/bin/python3 x', {}, [], true],
      ['PIPX_DEFAULT_PYTHON=/usr/local/bin/python3.15 pipx run x', {}, [], true],
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '/usr/local/bin/python3' }, [], true],
    ];
    for (const [run, env, ids, flagged] of cases) expect(pipxWithoutPython(run, env, new Set(ids)), `${run} / ${JSON.stringify(env)} / ${ids}`).toBe(flagged);
  });

  // 3: sudo looks its command up on its own secure_path, so it runs the runner's runtime even after a set-up step.
  const ROUND_THREE_SUDO_YAML = [
    'on: push',
    'jobs:',
    '  sudo-python:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        run: sudo python3 x.py',
    '  sudo-e-node:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-node@abc',
    '        with: { node-version: "26" }',
    '      - name: Run',
    '        run: sudo -E node x.js',
    '  sudo-path:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        run: sudo env "PATH=$PATH" python3 x.py',
    '  sudo-shell:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-node@abc',
    '        with: { node-version: "26" }',
    '      - name: Run',
    "        run: sudo bash -c 'node x.js'",
    '  sudo-own-path:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        run: sudo PATH="$PATH" python3 x.py',
    '  sudo-env-path-shell:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        run: sudo env PATH="$PATH" bash -c \'python3 x.py\'',
    '  sudo-heredoc:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        run: |',
    "          sudo bash <<'EOF'",
    '          python3 x.py',
    '          EOF',
    '  sudo-split:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    "        run: sudo -u nobody env -S 'python3 x.py'",
    '  no-sudo:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        run: python3 x.py',
    '',
  ].join('\n');

  it('reads the round-three sudo workflow', () => {
    const workflow = readWorkflow(ROUND_THREE_SUDO_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env, workflow.defaults)).toEqual([
      'x.yml > sudo-python > Run > python',
      'x.yml > sudo-e-node > Run > node',
      'x.yml > sudo-shell > Run > node',
      'x.yml > sudo-own-path > Run > python',
      'x.yml > sudo-heredoc > Run > python',
      'x.yml > sudo-split > Run > python',
    ]);
    expect(pipxProblems('x.yml', workflow)).toEqual([
    ]);
  });

  // 4: a step's `shell:` (or `defaults.run.shell`) runs its text with that program.
  const ROUND_THREE_SHELL_YAML = [
    'on: push',
    'defaults:',
    '  run:',
    '    shell: bash',
    'jobs:',
    '  python-shell:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Script',
    '        shell: python',
    '        run: print(1)',
    '  python-shell-set-up:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Script',
    '        shell: python',
    '        run: print(1)',
    '  node-shell:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Script',
    '        shell: node {0}',
    '        run: console.log(1)',
    '  job-default:',
    '    runs-on: ubuntu-26.04',
    '    defaults:',
    '      run:',
    '        shell: python3 {0}',
    '    steps:',
    '      - name: Script',
    '        run: print(1)',
    '  pwsh:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Script',
    '        shell: pwsh',
    '        run: Write-Output 1',
    '  sudo-shell:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Script',
    '        shell: sudo python3 {0}',
    '        run: print(1)',
    '  uses-only:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Action',
    '        shell: python',
    '        uses: actions/checkout@abc',
    '',
  ].join('\n');

  it('reads the round-three shell workflow', () => {
    const workflow = readWorkflow(ROUND_THREE_SHELL_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env, workflow.defaults)).toEqual([
      'x.yml > python-shell > Script > python',
      'x.yml > node-shell > Script > node',
      'x.yml > job-default > Script > python',
      'x.yml > sudo-shell > Script > python',
    ]);
    expect(pipxProblems('x.yml', workflow)).toEqual([
    ]);
  });

  // 4: a step's `shell:` (or `defaults.run.shell`) runs its text with that program.
  const ROUND_THREE_SHELL_WORKFLOW_DEFAULT_YAML = [
    'on: push',
    'defaults:',
    '  run:',
    '    shell: python',
    'jobs:',
    '  inherits:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Script',
    '        run: print(1)',
    '  own-default:',
    '    runs-on: ubuntu-26.04',
    '    defaults:',
    '      run:',
    '        shell: bash',
    '    steps:',
    '      - name: Script',
    '        run: print(1)',
    '',
  ].join('\n');

  it('reads the round-three shell workflow default workflow', () => {
    const workflow = readWorkflow(ROUND_THREE_SHELL_WORKFLOW_DEFAULT_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env, workflow.defaults)).toEqual([
      'x.yml > inherits > Script > python',
    ]);
    expect(pipxProblems('x.yml', workflow)).toEqual([
    ]);
  });

  // 7: `env` is evaluated level by level, as GitHub does.
  const ROUND_THREE_ENV_LEVELS_YAML = [
    'on: push',
    'env:',
    '  PY: /opt/py/bin/python3',
    '  V: "3.15"',
    'jobs:',
    '  job-level:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env:',
    '          PIPX_DEFAULT_PYTHON: ${{ env.PY }}',
    '        run: pipx run x',
    '  sibling:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env:',
    '          OWN: /opt/py/bin/python3',
    '          PIPX_DEFAULT_PYTHON: ${{ env.OWN }}',
    '        run: pipx run x',
    '  job-env-reads-env:',
    '    runs-on: ubuntu-26.04',
    '    env:',
    '      A: ${{ env.PY }}',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        run: pipx run --python ${{ env.A }} x',
    '  one-round:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env:',
    '          B: ${{ env.PY }}',
    '        run: pipx run --python ${{ env.B }} x',
    '  uv-step-env:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        env:',
    '          W: ${{ env.V }}',
    '        with:',
    '          python-version: ${{ env.W }}',
    '      - name: Run',
    '        run: uv run x.py',
    '  uv-job-env:',
    '    runs-on: ubuntu-26.04',
    '    env:',
    '      W: ${{ env.V }}',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: ${{ env.W }}',
    '      - name: Run',
    '        run: uv run x.py',
    '  location:',
    '    runs-on: ubuntu-26.04',
    '    env:',
    '      pythonLocation: /opt/py',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        run: pipx run --python ${{ env.pythonLocation }}/bin/python3 x',
    '  location-shell:',
    '    runs-on: ubuntu-26.04',
    '    env:',
    '      pythonLocation: /opt/py',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        run: pipx run --python "$pythonLocation/bin/python3" x',
    '  location-set-up:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        run: pipx run --python ${{ env.pythonLocation }}/bin/python3 x',
    '',
  ].join('\n');

  it('reads the round-three env levels workflow', () => {
    const workflow = readWorkflow(ROUND_THREE_ENV_LEVELS_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env, workflow.defaults)).toEqual([
      'x.yml > uv-job-env > Run > python',
    ]);
    expect(pipxProblems('x.yml', workflow)).toEqual([
      'x.yml > sibling > Scan > pipx',
      'x.yml > job-env-reads-env > Scan > pipx',
      'x.yml > location > Scan > pipx',
      'x.yml > location-shell > Scan > pipx',
    ]);
  });

  // 17: values are read as YAML reads them (items 6, 11, 17 and 18).
  const ROUND_THREE_YAML_VALUES_YAML = [
    'on: push',
    'jobs:',
    '  comment-in-env:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env:',
    '          PIPX_DEFAULT_PYTHON: |-',
    '            /opt/py/bin/python3',
    '           # a comment indented between the key and the value',
    '        run: pipx run x',
    '  comment-in-with:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: |-',
    '            3.15',
    '           # a comment indented between the key and the value',
    '      - name: Run',
    '        run: uv run x.py',
    '  comment-in-run:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env:',
    '          PIPX_DEFAULT_PYTHON: /opt/py/bin/python3',
    '        run: |',
    '            pipx run x',
    '          # a comment indented between the key and the script',
    '  double-quoted:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Run',
    '        run: "python3 x.py" # a comment',
    '  escapes:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Run',
    '        run: "\\x70ython3 x.py"',
    '      - name: Tab',
    '        run: "node\\tx.js"',
    '  single-quoted:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Run',
    "        run: 'echo ''; node x'''",
    '  matrix-comment:',
    '    runs-on: ubuntu-26.04',
    '    strategy:',
    '      matrix:',
    '        py:',
    "          - /usr/bin/python3 # the runner's",
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env:',
    '          PIPX_DEFAULT_PYTHON: ${{ matrix.py }}',
    '        run: pipx run x',
    '  matrix-quoted:',
    '    runs-on: ubuntu-26.04',
    '    strategy:',
    '      matrix:',
    '        py:',
    '          - "3.15" # the floor',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: ${{ matrix.py }}',
    '      - name: Run',
    '        run: uv run x.py',
    '  number:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: 3.20',
    '      - name: Run',
    '        run: uv run x.py',
    '  number-matrix:',
    '    runs-on: ubuntu-26.04',
    '    strategy:',
    '      matrix:',
    '        py: [3.20]',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: ${{ matrix.py }}',
    '      - name: Run',
    '        run: uv run x.py',
    '',
  ].join('\n');

  it('reads the round-three yaml values workflow', () => {
    const workflow = readWorkflow(ROUND_THREE_YAML_VALUES_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env, workflow.defaults)).toEqual([
      'x.yml > double-quoted > Run > python',
      'x.yml > escapes > Tab > node',
      'x.yml > escapes > Run > python',
      'x.yml > number > Run > python',
      'x.yml > number-matrix > Run > python',
    ]);
    expect(pipxProblems('x.yml', workflow)).toEqual([
      'x.yml > matrix-comment > Scan > pipx',
    ]);
  });

  it('refuses the forms every copy\'s reader refuses, so all copies read the same files (item 11)', () => {
    const refused = [
      'jobs:\n  j: {runs-on: ubuntu-26.04, steps: [{run: python3 x.py}]}\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps: [{run: python3 x.py}]\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - {run: python3 x.py}\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    strategy: {matrix: {py: [a]}}\n    steps:\n      - run: echo\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    strategy:\n      matrix: {py: [a]}\n    steps:\n      - run: echo\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - run: echo a\n          node x\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - run: "echo a\n          node x"\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - env:\n          A: one\n            two\n        run: echo\n',
      // A matrix item continued on the next line (Copilot on HCW-NetworkEyes_App#399).
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    strategy:\n      matrix:\n        py:\n          - /usr/bin/python3\n            --x\n    steps:\n      - run: echo\n',
    ];
    for (const text of refused) expect(() => readWorkflow(text), text).toThrow();
  });
});

describe('round three review: quoted assignments, sudo PATH, shells, YAML anchors, quoting, operators, speed', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order (the
  // pre-PR review of round 3, #1707).
  it('reads the round-three review forms as the shell reads them', () => {
    const cases = [
      // 1: a quoted assignment given to env or sudo is still an assignment.
      ['env "PATH=$PATH" python3 x', 'python', true],
      ['sudo env "PATH=$PATH" python3 x', 'python', true],
      ["env 'A=1' node x", 'node', true],
      ["sudo -E 'A=1' node x", 'node', true],
      ['"A=1" node x', 'node', false],
      ["env -S 'A=1 node x'", 'node', true],
      ["echo env 'A=1' node x", 'node', false],
      // 5: empty quotes, escapes, builtin and a name that ends at an operator.
      ["''node x", 'node', true],
      ['""node x', 'node', true],
      ['n""ode x', 'node', true],
      ['\\node x', 'node', true],
      ['n\\ode x', 'node', true],
      ["'' node x", 'node', false],
      ["'node'&& echo", 'node', true],
      ["'npx'|cat", 'node', true],
      ["'node';", 'node', true],
      ['builtin eval node x', 'node', true],
      ['\\eval node x', 'node', true],
      ['python3<<EOF\nx\nEOF', 'python', true],
      ['(cd a && npm)', 'node', true],
      ['x=$(node)', 'node', true],
      ['node;', 'node', true],
      ['python3>log', 'python', true],
      ['case "$k" in node) echo ;; esac', 'node', false],
      ['node|npm) echo hi ;;', 'node', false],
      ['node) node x ;;', 'node', true],
      ['nodejs x', 'node', false],
      ['echo node;', 'node', false],
    ];
    for (const [line, kind, found] of cases) expect(runsRuntime(line, kind), `${line} / ${kind}`).toBe(found);
  });

  it('passes the set-up runtime through sudo only with the outer PATH', () => {
    const cases = [
      // 2: only the outer PATH, passed on by env after sudo, keeps the set-up runtime.
      ['sudo env PATH=$PATH python3 x', 'python', false],
      ['sudo env "PATH=$PATH" python3 x', 'python', false],
      ['sudo env PATH="${PATH}" python3 x', 'python', false],
      ['sudo env PATH=$PATH:/usr/bin python3 x', 'python', false],
      ['sudo env PATH=/usr/bin:$PATH python3 x', 'python', true],
      ['sudo env PATH=/usr/bin python3 x', 'python', true],
      ["sudo bash -c 'env PATH=$PATH node x'", 'node', true],
      // Copilot on the round-3 ports: inside a sudo'd script `$PATH` is already sudo's `secure_path`.
      ["sudo bash -c 'sudo env PATH=$PATH node x'", 'node', true],
      ["sudo bash -c 'sudo env PATH=$PATH python3 x'", 'python', true],
      ["sudo bash -c 'env PATH=$PATH sudo env PATH=$PATH node x'", 'node', true],
      ['sudo bash -c \'bash -c "sudo env PATH=$PATH node x"\'', 'node', true],
      ["sudo env PATH=$PATH bash -c 'sudo env PATH=$PATH node x'", 'node', false],
      ['sudo env PATH=$PATH bash -c \'sudo bash -c "sudo env PATH=$PATH node x"\'', 'node', true],
      ['env PATH=$PATH sudo python3 x', 'python', true],
      ['env PATH=/usr/bin node x', 'node', false],
    ];
    for (const [line, kind, found] of cases) expect(runsThroughSudo(line, kind), `${line} / ${kind}`).toBe(found);
  });

  it('reads the round-three review pipx forms', () => {
    const cases = [
      // 1: a quoted assignment given to env or sudo is still an assignment.
      ['env "A=1" pipx run x', {}, [], true],
      ['env "PIPX_DEFAULT_PYTHON=/usr/bin/python3" pipx run x', {}, [], true],
      ['env "PIPX_DEFAULT_PYTHON=/opt/py/bin/python3" pipx run x', {}, [], false],
      ['sudo env "PIPX_DEFAULT_PYTHON=/opt/py/bin/python3" pipx run x', {}, [], false],
      ["env 'PIPX_DEFAULT_PYTHON=' pipx run x", { PIPX_DEFAULT_PYTHON: '/opt/py' }, [], true],
      // 4: an unset pythonLocation is not setup-python's any more.
      ['unset pythonLocation; pipx run --python "$pythonLocation/bin/python3" x', {}, [''], true],
      ['(unset pythonLocation); pipx run --python "$pythonLocation/bin/python3" x', {}, [''], false],
      ['pipx run --python "$pythonLocation/bin/python3" x', {}, [''], false],
    ];
    for (const [run, env, ids, flagged] of cases) expect(pipxWithoutPython(run, env, new Set(ids)), `${run} / ${JSON.stringify(env)} / ${ids}`).toBe(flagged);
  });

  // 1 and 7: a quoted assignment given to env does not hide the command after it, and a step whose shell is run through sudo runs its text under sudo.
  const ROUND_THREE_REVIEW_SUDO_YAML = [
    'on: push',
    'jobs:',
    '  quoted-no-set-up:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Run',
    '        run: sudo env "PATH=$PATH" python3 x',
    '  env-quoted-no-set-up:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - name: Run',
    '        run: env "PATH=$PATH" python3 x',
    '  quoted-set-up:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        run: sudo env "PATH=$PATH" python3 x',
    '  sudo-shell:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        shell: sudo bash -e {0}',
    '        run: python3 x',
    '  sudo-default-shell:',
    '    runs-on: ubuntu-26.04',
    '    defaults:',
    '      run:',
    '        shell: sudo bash -e {0}',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        run: python3 x',
    '  sudo-path-shell:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        shell: sudo env PATH="$PATH" bash -e {0}',
    '        run: python3 x',
    '',
  ].join('\n');

  it('reads the round-three review sudo workflow', () => {
    const workflow = readWorkflow(ROUND_THREE_REVIEW_SUDO_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env, workflow.defaults)).toEqual(['x.yml > quoted-no-set-up > Run > python', 'x.yml > env-quoted-no-set-up > Run > python', 'x.yml > sudo-shell > Run > python', 'x.yml > sudo-default-shell > Run > python']);
    expect(pipxProblems('x.yml', workflow)).toEqual([]);
  });

  // Copilot on the round-3 ports (#1707): under a `shell:` run through sudo the step's `$PATH` is sudo's `secure_path`,
  // so a `sudo env "PATH=$PATH"` in its text passes that on, not the set-up Python.
  const COPILOT_PORTS_SUDO_YAML = [
    'on: push',
    'jobs:',
    '  sudo-shell:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        shell: sudo bash -e {0}',
    '        run: sudo env "PATH=$PATH" python3 x',
    '  path-shell:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Run',
    '        shell: sudo env PATH="$PATH" bash -e {0}',
    '        run: sudo env "PATH=$PATH" python3 x',
    '',
  ].join('\n');

  it('passes on only its own secure_path under a sudo shell', () => {
    const workflow = readWorkflow(COPILOT_PORTS_SUDO_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env, workflow.defaults)).toEqual(['x.yml > sudo-shell > Run > python']);
  });

  // reader alignment: a step's keys after `-   `, and a matrix list at its key's indent.
  const ROUND_THREE_REVIEW_YAML_YAML = [
    'on: push',
    'jobs:',
    '  spaced-dash:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      -   name: Run',
    '          run: node x',
    '  matrix-at-key:',
    '    runs-on: ubuntu-26.04',
    '    strategy:',
    '      matrix:',
    '        py:',
    '        - "3.15"',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: ${{ matrix.py }}',
    '      - name: Run',
    '        run: uv run x.py',
    '',
  ].join('\n');

  it('reads the round-three review yaml workflow', () => {
    const workflow = readWorkflow(ROUND_THREE_REVIEW_YAML_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env, workflow.defaults)).toEqual(['x.yml > spaced-dash > Run > node']);
    expect(pipxProblems('x.yml', workflow)).toEqual([]);
  });

  it('refuses YAML anchors, aliases, tags and the forms the line readers cannot read', () => {
    const refused = [
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - run: &a node x\n      - run: *a\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - run: !!str node x\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - env:\n          P: &p /usr/bin/python3\n        run: echo\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - env:\n          P: !!str /usr/bin/python3\n        run: echo\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - \'run\': x\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - run : x\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - run:\n          node x\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - env: {\'A\': x}\n        run: echo\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    strategy:\n      matrix:\n        py:\n          - "3.15"#x\n    steps:\n      - run: echo\n',
    ];
    for (const text of refused) expect(() => readWorkflow(text), text).toThrow();
  });

  it('reads a long double-quoted string and a long script of unset, export -n and eval quickly', () => {
    // The review found 3,000 substitutions in one string took 8 seconds, and 4,000 such lines 5 seconds.
    const started = performance.now();
    const quoted = `echo "${'$(true) x; '.repeat(3000)}"`;
    const lines = `${Array.from({ length: 4000 }, (_, i) => `unset P${i}; export -n Q${i}; eval 'echo ${i}'`).join('\n')}\npipx run x`;
    for (const run of [quoted, lines]) {
      runsRuntime(run, 'node');
      runsThroughSudo(run, 'python');
      pipxWithoutPython(run, { PIPX_DEFAULT_PYTHON: '/opt/py/bin/python3' });
    }
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

// What a reported step needs, for either of the two reasons a step is reported (round 3 review, #1707).
const UNSET_HELP =
  'Each step listed runs Node.js or Python on the runner\'s own version. Either no set-up step is sure to have run ' +
  'before it: add actions/setup-node or actions/setup-python (or astral-sh/setup-uv with a python-version) before it, ' +
  'under the same if: as the step. Or it runs the runtime through sudo, which looks commands up on its own fixed list ' +
  'of folders (secure_path) and so finds the runner\'s: write `sudo env "PATH=$PATH" …` so the set-up version is ' +
  'found. A step kept that way on purpose goes in RUNNER_DEFAULT_ALLOWED with its reason.';

describe('round three, Copilot round one: builtins with assignments in front of them', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order. Bash runs
  // `FOO=1 unset P`, `FOO=1 export -n P` and `FOO=1 declare +x P` like the builtin alone (Copilot on #1722).
  it('reads unset, export and declare with assignments in front of them', () => {
    const cases = [
      ['FOO=1 unset PIPX_DEFAULT_PYTHON; bash -c \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['FOO=1 unset PIPX_DEFAULT_PYTHON; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['FOO=1 export -n PIPX_DEFAULT_PYTHON; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['FOO=1 declare +x PIPX_DEFAULT_PYTHON; bash -c \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['A=1 B="x y" export -n P; bash -c \'pipx run --python "$P" x\'', { P: '/opt/py/bin/python3' }, true],
      ['FOO=1 unset P; pipx run --python "$P" x', { P: '/opt/py/bin/python3' }, true],
      ['FOO=1 export P=/opt/py/bin/python3; bash -c \'pipx run --python "$P" x\'', {}, false],
      ['FOO=1 read P < p.txt; pipx run --python "$P" x', {}, false],
      ['FOO=1 unset -f PIPX_DEFAULT_PYTHON; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['echo unset PIPX_DEFAULT_PYTHON; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
    ];
    for (const [run, env, flagged] of cases) expect(pipxWithoutPython(run, env), `${run} / ${JSON.stringify(env)}`).toBe(flagged);
  });
});

describe('round three, Copilot round two: pipx at an operator, sudo through env, block values, matrices, flow quotes', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order (Copilot on
  // #1722 and HCW-NetworkEyes_App#399).
  it('reads the Copilot round-two pipx forms', () => {
    const cases = [
      // 5: `pipx` ends at an operator, as a runtime's name does, and not inside a `case` pattern.
      ['pipx;', {}, true],
      ['pipx | cat', {}, true],
      ['pipx &', {}, true],
      ['(pipx)', {}, true],
      ['pipx>log', {}, true],
      ['x=$(pipx)', {}, true],
      ['pipx run x;', {}, true],
      ['PIPX_DEFAULT_PYTHON=/p pipx;', {}, false],
      ['pipx) echo ;;', {}, false],
      ['pipx) pipx run x ;;', {}, true],
      // 6: sudo's reset of the environment holds through a later `env`, unless sudo keeps the variable.
      ['sudo env PATH="$PATH" pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['sudo env -S \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['sudo -E env PATH="$PATH" pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['sudo --preserve-env=PIPX_DEFAULT_PYTHON env PATH="$PATH" pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['sudo -E env -S \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      // 1: a `#` line at a block value's content indentation is part of the value, so a value over two lines chooses nothing.
      ['pipx run x', { PIPX_DEFAULT_PYTHON: '# note\n/opt/py/bin/python3' }, true],
    ];
    for (const [run, env, flagged] of cases) expect(pipxWithoutPython(run, env), `${run} / ${JSON.stringify(env)}`).toBe(flagged);
  });

  // 1, 2 and 4: block values, matrices and quotes, read as YAML reads them.
  const COPILOT_TWO_YAML = [
    'on: push',
    'jobs:',
    '  comment-first-version:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: |-',
    '            # note',
    '            3.15',
    '      - name: Run',
    '        run: uv run x.py',
    '  comment-first-pipx:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env:',
    '          PIPX_DEFAULT_PYTHON: |-',
    '            # note',
    '            /usr/bin/python3',
    '        run: pipx run x',
    '  matrix-expression:',
    '    runs-on: ubuntu-26.04',
    '    strategy:',
    '      matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: ${{ matrix.py }}',
    '      - name: Run',
    '        run: uv run x.py',
    '  escaped-quote:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with: { note: "a\\"b,c", python-version: "3.15" }',
    '      - name: Run',
    '        run: uv run x.py',
    '  single-quote:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with: { note: \'a\'\'b,c\', python-version: "3.15" }',
    '      - name: Run',
    '        run: uv run x.py',
    '  matrix-quoted-comma:',
    '    runs-on: ubuntu-26.04',
    '    strategy:',
    '      matrix:',
    '        py: ["3.15", "3.14,x"]',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: ${{ matrix.py }}',
    '      - name: Run',
    '        run: uv run x.py',
    '',
  ].join('\n');

  it('reads block values, matrix expressions and quoted one-line values as YAML reads them', () => {
    const workflow = readWorkflow(COPILOT_TWO_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env, workflow.defaults)).toEqual(['x.yml > comment-first-version > Run > python', 'x.yml > matrix-expression > Run > python', 'x.yml > matrix-quoted-comma > Run > python']);
    expect(pipxProblems('x.yml', workflow)).toEqual(['x.yml > comment-first-pipx > Scan > pipx']);
  });

  it('refuses a more-indented leading blank line, an inline matrix and an unreadable matrix line', () => {
    // 1, 2 and 3: the forms YAML or the line readers refuse.
    const refused = [
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - env:\n          P: |-\n                \n            x\n        run: echo\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    strategy:\n      matrix: [3.14]\n    steps:\n      - run: echo\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    strategy:\n      matrix: foo\n    steps:\n      - run: echo\n',
      'jobs:\n  j:\n    runs-on: ubuntu-26.04\n    strategy:\n      matrix:\n        py: ["3.15"]\n        oops\n    steps:\n      - run: echo\n',
    ];
    for (const text of refused) expect(() => readWorkflow(text), text).toThrow();
  });
});

describe('round three, Copilot round three: the latest change to PIPX_DEFAULT_PYTHON wins; quoted # in one-line values', () => {
  // The same cases as HCW-NetworkEyes_App's tests/security/test_workflow_runtime_setup.py, in the same order (Copilot on
  // HCW-NetworkEyes_App#399).
  it('reads the latest change the script makes to PIPX_DEFAULT_PYTHON in each shell', () => {
    const cases = [
      ['PIPX_DEFAULT_PYTHON=/usr/bin/python3; PIPX_DEFAULT_PYTHON=/opt/py/bin/python3; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['PIPX_DEFAULT_PYTHON=/usr/bin/python3; PIPX_DEFAULT_PYTHON=/opt/py/bin/python3; bash -c \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['PIPX_DEFAULT_PYTHON=/usr/bin/python3; PIPX_DEFAULT_PYTHON=/opt/py/bin/python3; pipx run x', {}, true],
      ['export PIPX_DEFAULT_PYTHON=/usr/bin/python3; export PIPX_DEFAULT_PYTHON=/opt/py/bin/python3; pipx run x', {}, false],
      ['PIPX_DEFAULT_PYTHON=/opt/py/bin/python3; PIPX_DEFAULT_PYTHON=/usr/bin/python3; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['PIPX_DEFAULT_PYTHON=/opt/py/bin/python3; unset PIPX_DEFAULT_PYTHON; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['unset PIPX_DEFAULT_PYTHON; export PIPX_DEFAULT_PYTHON=/opt/py/bin/python3; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['unset PIPX_DEFAULT_PYTHON; PIPX_DEFAULT_PYTHON=/opt/py/bin/python3; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['export -n PIPX_DEFAULT_PYTHON; export PIPX_DEFAULT_PYTHON; pipx run x', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['export -n PIPX_DEFAULT_PYTHON; export PIPX_DEFAULT_PYTHON; bash -c \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, false],
      ['export -n PIPX_DEFAULT_PYTHON; bash -c \'pipx run x\'', { PIPX_DEFAULT_PYTHON: '/opt/py' }, true],
      ['(export PIPX_DEFAULT_PYTHON=/opt/py/bin/python3); pipx run x', {}, true],
      ['bash -c \'export PIPX_DEFAULT_PYTHON=/opt/py/bin/python3; pipx run x\'', {}, false],
    ];
    for (const [run, env, flagged] of cases) expect(pipxWithoutPython(run, env), `${run} / ${JSON.stringify(env)}`).toBe(flagged);
  });

  // A `#` inside quotes in a one-line `[ ]` or `{ }` is part of the value, not a comment.
  const COPILOT_THREE_YAML = [
    'on: push',
    'jobs:',
    '  matrix-hash:',
    '    runs-on: ubuntu-26.04',
    '    strategy:',
    '      matrix:',
    '        py: ["3.15 # floor"] # a comment',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with:',
    '          python-version: ${{ matrix.py }}',
    '      - name: Run',
    '        run: uv run x.py',
    '  flow-env-hash:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: actions/setup-python@abc',
    '        with: { python-version: "3.15" }',
    '      - name: Scan',
    '        env: { NOTE: "a # b", PIPX_DEFAULT_PYTHON: /opt/py/bin/python3 } # c',
    '        run: pipx run x',
    '  flow-with-quote:',
    '    runs-on: ubuntu-26.04',
    '    steps:',
    '      - uses: astral-sh/setup-uv@abc',
    '        with: { note: \'it\'\'s # x\', python-version: "3.15" }',
    '      - name: Run',
    '        run: uv run x.py',
    '',
  ].join('\n');

  it('keeps a # inside quotes in a one-line value', () => {
    const workflow = readWorkflow(COPILOT_THREE_YAML);
    expect(unsetSteps('x.yml', workflow.jobs, {}, workflow.env, workflow.defaults)).toEqual(['x.yml > matrix-hash > Run > python']);
    expect(pipxProblems('x.yml', workflow)).toEqual([]);
  });
});

describe('.github/workflows and .github/actions', () => {
  // The workflows and the composite actions (see `sources`), read once for every test below.
  const found = sources(REPO);
  const unset = found.flatMap(([label, workflow]) => unsetSteps(label, workflow?.jobs, INDIRECT_RUNTIME, workflow?.env, workflow?.defaults));
  const pipx = found.flatMap(([label, workflow]) => pipxProblems(label, workflow));
  const floor = found.filter(([label]) => label.startsWith('.github/actions/')).flatMap(([label, workflow]) => floorProblems(label, workflow.jobs, REPO, workflow.env));

  it('every set-up step of a composite action asks for the floor or newer, and one whose version cannot be read is reported', () => {
    expect(floor.filter((entry) => !(entry in BELOW_FLOOR_ALLOWED))).toEqual([]);
    for (const [entry, reason] of Object.entries(BELOW_FLOOR_ALLOWED)) {
      expect(floor, entry).toContain(entry);
      expect(String(reason ?? '').trim(), `${entry} gives no reason`).not.toBe('');
    }
  });

  it('every step that runs Node.js or Python comes after its version is set up, so the runner image never chooses it', () => {
    expect(unset.filter((entry) => !(entry in RUNNER_DEFAULT_ALLOWED)), UNSET_HELP).toEqual([]);
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
      found.flatMap(([label, workflow]) =>
        Object.entries(workflow?.jobs ?? {}).flatMap(([name, job]) =>
          (Array.isArray(job?.steps) ? job.steps : []).flatMap((step, i) => Object.keys(COMMAND).map((kind) => stepKey(label, name, step, i, kind)))
        )
      )
    );
    for (const [entry, reason] of Object.entries(INDIRECT_RUNTIME)) {
      expect(String(reason ?? '').trim(), `${entry} gives no reason`).not.toBe('');
      expect(keys.has(entry), entry).toBe(true);
    }
  });
});
