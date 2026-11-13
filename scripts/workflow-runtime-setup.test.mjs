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
 * What pipx is given must also be the set-up Python. The runner's own Python
 * named by its path (`--python /usr/bin/python3`, `/usr/bin/python3.12` or
 * `/bin/python3`, the same as `PIPX_DEFAULT_PYTHON`) chooses nothing. A
 * `${{ steps.<id>.outputs.* }}` value, given directly or through a variable of
 * the step's `env:` (`--python "$PYTHON_PATH"`), counts only when `<id>` is an
 * earlier actions/setup-python step of the same job that is sure to have run
 * first, by the same rules as a set-up step with an `if:` (below); a missing
 * id, a later step, a step that is not actions/setup-python or one that may be
 * skipped chooses nothing. A bare `python3.15` and a path under
 * `${{ env.pythonLocation }}` still count. Settings travel the way the shell
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
 * unread. The same check is
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
 * as having no steps.
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
const WRAPPERS = [
  ...Object.entries(WRAPPER_OPTIONS).map(([word, takes]) =>
    word === 'timeout'
      ? String.raw`${PATH}timeout${optionsOf(takes, word)}\s+\d+(?:\.\d+)?[smhd]?\s+`
      : String.raw`${word === 'exec' ? '' : PATH}${word}${optionsOf(takes, word)}\s+`
  ),
  String.raw`command(?:\s+(?:-p|--(?=\s)))*\s+`,
  String.raw`(?:if|then|else|elif|do|while|until|!)\s+`,
  SHELL_C,
].join('|');
// A `case` pattern that ends at the start of a line (`check)`, `a|b)`), after which a command may follow.
const CASE_PATTERN = String.raw`^[^()\s|]+(?:\|[^()\s|]+)*\)\s*`;
const START = String.raw`(?:^|[$<]\(\s*|[\x60({|;&]\s*|${CASE_PATTERN})(?:${ASSIGNMENT}|${WRAPPERS})*`;
// yarn and pnpm are Node.js programs; pytest and pipx are Python programs, so they run on the interpreter they were
// installed with, which is the runner's own unless a set-up step came first (pipx also builds each tool's virtual
// environment from that interpreter unless it is given `--python`).
const COMMAND = {
  node: new RegExp(`${START}${PATH}(?:node|npm|npx|yarn|pnpm)(?=\\s|$)`),
  python: new RegExp(`${START}${PATH}(?:python(?:3(?:\\.\\d+){0,2})?|pip3?|pipx|pytest|uvx?)(?=\\s|$)`),
};
// A shell in command position given a script with `-c` (`bash -c '…'`, `sh -euo pipefail -c "…"`, `sudo bash -lc
// '…'`, `bash -ec'…'`): the script runs on the runner too, so its commands count. The same words after `docker run
// image` are not in command position, so a container's script stays unread.
const SHELL_SCRIPT = new RegExp(`${START}${PATH}${SHELL_UP_TO_C}(?:${SHELL_AFTER_C})?$`);
// `env -S` (`--split-string`, or any unambiguous start of it) in command position: env splits its value into words
// and runs them, so a quoted value there is read as a script, like a `-c` shell's (`env -S 'node x.js'`,
// `env --split-string='python3 x.py'`; Copilot on HCW-MigrateOrchestrator_AddOn#74). An unquoted value is the next
// word, which is in command position already.
const ENV_SPLIT_SCRIPT = new RegExp(
  String.raw`${START}${PATH}env${optionsOf(WRAPPER_OPTIONS.env, 'env')}\s+(?:-(?:(?![uCS])[A-Za-z])*S|--(?:${forms('env', ['split-string']).join('|')})=?)\s*$`
);
// `pipx` in command position, with what comes before it (its assignments and wrappers) and its words, up to the end
// of the command (`;`, `&`, `|` or `)`). It has chosen its interpreter when `--python` is one of pipx's own options
// (see `pipxOptionChoosesPython`) or `PIPX_DEFAULT_PYTHON` is one of the assignments in front of it.
const PIPX = new RegExp(`(?<before>${START})${PATH}pipx(?=\\s|$)(?<words>[^;&|)]*)`, 'g');
// pipx's options that take a value as the next word, so that word is not read as an option or as the app's name.
const PIPX_VALUE_OPTIONS = new Set(['--spec', '--python', '--index-url', '--pip-args', '--suffix', '--preinstall', '--backend', '--fetch-python']);
// Where `((` opens an arithmetic command rather than two subshells: at the start of a command.
const ARITHMETIC_COMMAND = /(?:^|[;&|({]|\b(?:then|else|do|if|elif|while|until|for))\s*$/;
// The escapes `$'…'` turns into other characters: these, `\xHH`, `\uHHHH`, `\UHHHHHHHH` and octal `\NNN` (see
// `ansiC`); any other `\x` is left as it is.
const ANSI_C = { n: '\n', t: '\t', "'": "'", '"': '"', '\\': '\\' };
const ANSI_C_ESCAPE = /\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|[\s\S])/g;
// A quoted string that is one plain word once the shell has read it (`$'\x70ython3'` is `python3`), written as that
// word, so it is read in command position like any other.
const PLAIN_WORD = /^[A-Za-z0-9_./+:@%,-]+$/;
// The characters a quoted value keeps when `shellText` is asked for values (the pipx check); any other becomes `_`, so
// the value stays one word and opens nothing. A `${NAME}` in it is first written `$NAME` (see VARIABLE).
const VALUE_UNSAFE = /[^A-Za-z0-9_./:@%+,=$-]/gu;
// A shell variable in a value (`"$PYTHON_PATH"`, `${PYTHON_PATH}`), read from the step's, job's or workflow's `env:`.
const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
// A GitHub expression (`${{ steps.py.outputs.python-path }}`), which GitHub replaces before the shell starts. For the
// pipx check it is written as one word, `__gha__` and the expression with every other character made `_`.
const GHA_EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
// The id of each step whose outputs a value reads (`steps.py.outputs.python-path`).
const STEP_OUTPUT = /(?<![A-Za-z0-9.-])steps\.([A-Za-z0-9_-]+)\.outputs(?![A-Za-z0-9_-])/gi;
// The runner's own Python named by its path, which pipx would use instead of the set-up one.
const SYSTEM_PYTHON = /^(?:\/usr)?\/bin\/python(?:3(?:\.\d+)*)?$/;
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

/**
 * The text of a `$'…'` string as the shell reads it: `\n`, `\t`, `\'`, `\"`, `\\`, `\xHH`, `\uHHHH`, `\UHHHHHHHH`
 * and octal `\NNN` decoded, cut at a NUL as bash cuts it, and every character that is not printable ASCII, a tab or a
 * new line written `_`, which the shell does not split a word on either.
 */
export function ansiC(body) {
  const text = body
    .replace(ANSI_C_ESCAPE, (escape, code) => {
      if ('xuU'.includes(code[0]) && code.length > 1) {
        const value = parseInt(code.slice(1), 16);
        return value <= 0x10ffff ? String.fromCodePoint(value) : '_';
      }
      if ('01234567'.includes(code[0])) return String.fromCodePoint(parseInt(code, 8));
      return ANSI_C[code] ?? escape;
    })
    .split('\0')[0];
  return text.replace(/[^\x20-\x7e\t\n]/gu, '_');
}

/**
 * How `shellText` writes a quoted string that runs nothing: `''` (or `""`) when empty, else `'_'` (or `"_"`), or, when
 * asked for values, the quotes around the content with every character VALUE_UNSAFE names made `_`.
 */
function quotedText(content, mark, values) {
  if (!content) return mark + mark;
  if (!values) return `${mark}_${mark}`;
  return mark + content.replace(VARIABLE, (whole, braced, plain) => `$${braced ?? plain}`).replace(VALUE_UNSAFE, '_') + mark;
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
  let heredocs = [];
  // Open parentheses inside `$((…))` or `((…))`, where `<<` is a shift; 0 outside.
  let arithmetic = 0;
  let i = 0;
  const n = run.length;
  const line = () => {
    const text = out.join('');
    return text.slice(text.lastIndexOf('\n') + 1);
  };
  // A `-c` script (or an `env -S` value) keeps the outer reading too: the outer shell runs a `$(…)` or backtick in a
  // double-quoted script before the inner shell starts (`bash -c "echo '$(node x)'"`).
  const quoted = (script, text) => {
    const head = line().trimStart();
    const found = SHELL_SCRIPT.exec(head) ?? ENV_SPLIT_SCRIPT.exec(head);
    if (!found) out.push(text);
    else if (values) out.push(`${text}\n\x01${found[0]}\n${shellText(script, values)}\n\x02\n:`);
    else out.push(`${text}\n${shellText(script)}\n:`);
  };
  while (i < n) {
    const char = run[i];
    if (char === '\\' && i + 1 < n) {
      out.push(run[i + 1] === '\n' ? ' ' : run[i + 1] === '`' ? '' : run.slice(i, i + 2));
      i += 2;
    } else if (char === '$' && run[i + 1] === "'") {
      // `$'…'` may hold `\'`, which does not end it.
      let j = i + 2;
      while (j < n && run[j] !== "'") j += run[j] === '\\' ? 2 : 1;
      const body = ansiC(run.slice(i + 2, j));
      quoted(body, PLAIN_WORD.test(body) ? body : quotedText(body, "'", values));
      i = j + 1;
    } else if (char === "'") {
      const end = run.indexOf("'", i + 1) === -1 ? n : run.indexOf("'", i + 1);
      quoted(run.slice(i + 1, end), quotedText(run.slice(i + 1, end), "'", values));
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
          parts.push(`$(${shellText(run.slice(j + 2, close), values)})`);
          j = close + 1;
        } else if (run[j] === '`') {
          const close = backtickClose(run, j);
          parts.push(`\`${shellText(run.slice(j + 1, close), values)}\``);
          j = close + 1;
        } else {
          parts.push(run[j]);
          j += 1;
        }
      }
      const raw = run.slice(i + 1, Math.min(j, n));
      const text = parts.join('');
      // Given to `-c`, the inner shell runs the script, an escaped backtick included.
      const script = raw.replace(/\\([\\"$`\n])/g, (escape, c) => (c === '\n' ? '' : c));
      quoted(script, /[$<]\(|`/.test(text) ? `"${text}"` : quotedText(text, '"', values));
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
      // The body is expanded only when no part of the delimiter is quoted or escaped.
      if (found) heredocs.push([found[3], !(found[1] || found[2])]);
      out.push('<<');
      i += found ? found[0].length : 2;
    } else if (char === '\n' && heredocs.length) {
      out.push('\n');
      i += 1;
      for (const [delimiter, expands] of heredocs) {
        const body = [];
        while (i < n) {
          const end = run.indexOf('\n', i) === -1 ? n : run.indexOf('\n', i);
          const text = run.slice(i, end);
          i = end + 1;
          if (text.trim() === delimiter) break;
          body.push(text);
        }
        if (expands) for (const command of heredocSubstitutions(body.join('\n'), values)) out.push(`${command}\n`);
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
 * The steps of one workflow's `jobs` that run a runtime before (or without) setting it up, by `stepKey`. A step named
 * in `indirect` counts as running its runtime even when its `run:` text does not show it.
 */
export function unsetSteps(file, jobs, indirect = INDIRECT_RUNTIME) {
  const found = [];
  for (const [name, job] of Object.entries(jobs ?? {})) {
    const steps = stepsOf(file, name, job);
    if (job?.container) continue;
    for (const kind of Object.keys(COMMAND)) {
      steps.forEach((step, i) => {
        const key = stepKey(file, name, step, i, kind);
        if (!(runsRuntime(step?.run, kind) || key in indirect)) return;
        // Covered by an earlier set-up step that always runs, or that runs under the same condition as this step.
        const covered = steps
          .slice(0, i)
          .some((earlier, j) => setsUp(earlier, kind) && setupCovers(condition(earlier), condition(step), stepIds(steps.slice(0, j))));
        if (!covered) found.push(key);
      });
    }
  }
  return found;
}

/** The text with each GitHub expression written as one word (see GHA_EXPRESSION). */
export const ghaTokens = (text) => text.replace(GHA_EXPRESSION, (whole, inner) => `__gha__${inner.trim().replace(/[^A-Za-z0-9_.-]/gu, '_')}__`);

/**
 * True when a value given to pipx as its Python (`--python`, PIPX_DEFAULT_PYTHON) chooses the set-up one: it is not
 * empty (quotes aside), not the runner's own Python named by its path (SYSTEM_PYTHON: `/usr/bin/python3`,
 * `/bin/python3`), and every `steps.<id>.outputs` it reads is of a step in `setupIds`, the earlier actions/setup-python
 * steps of the job that are sure to have run first. A shell variable in it is read from `env` (the step's, job's and
 * workflow's `env:`) when it is there (`--python "$PYTHON_PATH"` with `PYTHON_PATH: ${{
 * steps.python.outputs.python-path }}`); one that is not stays as it is. `python3.15` or a path under
 * `${{ env.pythonLocation }}` counts.
 */
export function chooses(value, setupIds = new Set(), env = {}) {
  const text = value
    .replace(/['"]/g, '')
    .replace(VARIABLE, (whole, braced, plain) => (Object.hasOwn(env ?? {}, braced ?? plain) ? ghaTokens(String(env[braced ?? plain])) : whole))
    .trim();
  if (!text || SYSTEM_PYTHON.test(text)) return false;
  return [...text.matchAll(STEP_OUTPUT)].every((found) => setupIds.has(found[1]));
}

/**
 * True when `--python` (or `--python=…`) is one of pipx's own options among the words after `pipx`, given a value that
 * chooses the set-up Python (see `chooses`; the last one wins, as in pipx). Reading stops at a bare `--`, after which
 * every word is the app's, and, for `pipx run`, at the app's name (the first word after `run` that is not an option or
 * an option's value), after which every word is the app's argument (`pipx run tool --python x` gives `--python` to the
 * tool).
 */
export function pipxOptionChoosesPython(words, setupIds = new Set(), env = {}) {
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
function localDefaultPython(before, setupIds = new Set(), env = {}) {
  let chosen = null;
  let wrapper = ''; // 'env' or 'sudo' while reading that word's options
  let following = ''; // the next word is the value of `env -u` ('unset') or of another option ('skip')
  let preserve = false; // `sudo` was told to keep PIPX_DEFAULT_PYTHON
  for (const word of (before.match(WORD) ?? []).map((w) => w.replace(OPENING, ''))) {
    if (following) {
      if (following === 'unset' && word === 'PIPX_DEFAULT_PYTHON') chosen = false;
      following = '';
      continue;
    }
    if (wrapper === 'sudo' && (word === '--' || !word.startsWith('-'))) {
      // The end of sudo's options: it resets the environment now, unless told to keep the variable.
      chosen = preserve ? chosen : false;
      wrapper = '';
      if (word === '--') continue;
    }
    // An assignment word (`NAME=value`): in `FOO=PIPX_DEFAULT_PYTHON=/p` the name is FOO, and the rest is its value.
    const assignment = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
    if (assignment) {
      if (assignment[1] === 'PIPX_DEFAULT_PYTHON') chosen = chooses(assignment[2], setupIds, env);
      wrapper = '';
    } else if (/^(?:\S*\/)?env$/.test(word)) wrapper = 'env';
    else if (/^(?:\S*\/)?sudo$/.test(word)) [wrapper, preserve] = ['sudo', false];
    else if (wrapper === 'sudo' && word.startsWith('--')) {
      const [name, ...rest] = word.slice(2).split('=');
      const option = longOption(name, 'sudo');
      if (option === 'preserve-env') preserve = preserve || !rest.length || rest.join('=').split(',').includes('PIPX_DEFAULT_PYTHON');
      else if (WRAPPER_LONG_OPTIONS.sudo.includes(option) && !rest.length) following = 'skip';
    } else if (wrapper === 'sudo') {
      for (let k = 1; k < word.length; k++) {
        if (word[k] === 'E') preserve = true;
        else if (WRAPPER_OPTIONS.sudo.includes(word[k])) {
          following = word.slice(k + 1) ? '' : 'skip';
          break;
        }
      }
    } else if (wrapper !== 'env' || word === '--') wrapper = '';
    else if (word === '-') chosen = false;
    else if (word.startsWith('--')) {
      const [name, ...rest] = word.slice(2).split('=');
      const option = longOption(name, 'env');
      if (option === 'ignore-environment') chosen = false;
      else if (option === 'unset' && rest.length) chosen = rest.join('=') === 'PIPX_DEFAULT_PYTHON' ? false : chosen;
      else if ((option === 'unset' || option === 'chdir') && !rest.length) following = option === 'unset' ? 'unset' : 'skip';
    } else if (word.startsWith('-')) {
      for (let k = 1; k < word.length; k++) {
        if (word[k] === 'i') chosen = false;
        else if ('uCS'.includes(word[k])) {
          const value = word.slice(k + 1);
          if (word[k] !== 'S' && !value) following = word[k] === 'u' ? 'unset' : 'skip';
          else if (word[k] === 'u' && value === 'PIPX_DEFAULT_PYTHON') chosen = false;
          break;
        }
      }
    } else wrapper = '';
  }
  if (wrapper === 'sudo' && !preserve) chosen = false;
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
 * variable of the step's `env:` (`--python "$PYTHON_PATH"`), which is read the same way. An inherited value is used as
 * written, since GitHub does not expand a variable in `env:`.
 */
export function pipxWithoutPython(run, env = {}, setupIds = new Set()) {
  const stack = [chooses(ghaTokens(String(env?.PIPX_DEFAULT_PYTHON ?? '')), setupIds)];
  for (const raw of shellText(ghaTokens(String(run ?? '')), true).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('\x01')) {
      // A `-c` script (or `env -S` value) starts: it inherits what the words in front of its shell make.
      stack.push(localDefaultPython(line.slice(1), setupIds, env) ?? stack.at(-1));
      continue;
    }
    if (line.startsWith('\x02')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    for (const found of line.matchAll(PIPX)) {
      if (!(pipxOptionChoosesPython(found.groups.words, setupIds, env) || (localDefaultPython(found.groups.before, setupIds, env) ?? stack.at(-1)))) return true;
    }
  }
  return false;
}

/**
 * The ids of the actions/setup-python steps before step `i` that are sure to have run before it (see `setupCovers`),
 * the only steps whose outputs choose pipx's Python.
 */
export const pythonSetupIds = (steps, i) =>
  new Set(
    steps
      .slice(0, i)
      .flatMap((earlier, j) =>
        earlier?.id !== undefined && earlier?.id !== null && SETUP.python.test(String(earlier?.uses ?? '')) && setupCovers(condition(earlier), condition(steps[i]), stepIds(steps.slice(0, j)))
          ? [String(earlier.id)]
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
      const env = { ...(workflow?.env ?? {}), ...(job?.env ?? {}), ...(step?.env ?? {}) };
      if (pipxWithoutPython(step?.run, env, pythonSetupIds(steps, i))) found.push(stepKey(file, name, step, i, 'pipx'));
    });
  }
  return found;
}

/**
 * A composite action's steps (`runs: using: composite`, `runs: steps:`) as one job named `composite`, so they are read
 * the same way as a workflow's; {} for any other kind of action (`node24`, `docker`).
 */
export const actionJobs = (action) => (action?.runs?.using === 'composite' ? { composite: { steps: action.runs.steps } } : {});

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
    .map((name) => [name, parse(readFileSync(join(root, '.github', 'workflows', name), 'utf8')) ?? {}]);
  const actions = list(join(root, '.github', 'actions'))
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => ['action.yml', 'action.yaml'].map((file) => `.github/actions/${entry.name}/${file}`))
    .filter((label) => existsSync(join(root, label)))
    .sort()
    .map((label) => [label, { jobs: actionJobs(parse(readFileSync(join(root, label), 'utf8'))) }]);
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
      ['pipx run --python ${{ env.pythonLocation }}/bin/python x', {}, [], false],
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

  it('reads steps written on one line, and refuses steps that are not a list of mappings', () => {
    // The YAML library reads `steps: [{…}]` and `- {…}` as they are, so their steps are checked; the Python copies'
    // line reader refuses both instead. Anything that is not a list of mappings stops the check with an error.
    const flow = parse('jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps: [{run: python3 x.py}]\n');
    const item = parse('jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - {run: python3 x.py}\n');
    expect(unsetSteps('x.yml', flow.jobs, {})).toEqual(['x.yml > j > step 1 > python']);
    expect(unsetSteps('x.yml', item.jobs, {})).toEqual(['x.yml > j > step 1 > python']);
    const scalar = parse('jobs:\n  j:\n    runs-on: ubuntu-26.04\n    steps:\n      - run: echo\n      - python3 x.py\n');
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

describe('.github/workflows and .github/actions', () => {
  // The workflows and the composite actions (see `sources`), read once for every test below.
  const found = sources(REPO);
  const unset = found.flatMap(([label, workflow]) => unsetSteps(label, workflow?.jobs));
  const pipx = found.flatMap(([label, workflow]) => pipxProblems(label, workflow));

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
