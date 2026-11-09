/**
 * The nightly drift check runs the whole play in check mode (2026-11-09).
 *
 * `hcw-playbook-drift.service` runs `ansible-playbook site.yml --check --diff`
 * every night (the hardening role, README section 9). In check mode Ansible
 * does not run a `command` or `shell` task unless the task says
 * `check_mode: false`: it records an empty `stdout`, an `rc` of 0 and
 * `skipped` (ansible-core 2.22), and a task skipped by its own `when` records
 * no `stdout` at all. The task's own `failed_when` is not evaluated then. So a later task that reads such a result (`x.stdout.split()[0]`,
 * `x.rc == 0`, `x.results[0].stdout`) either fails or decides on nothing.
 * On 2026-11-09 the check stopped with exit 1 at the coder_sandbox role:
 * "Give the user a subordinate uid range" read
 * `coder_sandbox_subids.results[0].stdout.split()[0]` from an awk read that
 * had not run, and `''.split()[0]` has no element 0.
 *
 * The rule this test holds: when a `command` or `shell` task registers a
 * result, and a later task, template or vars file reads its output
 * (`stdout`, `stdout_lines`, `stderr`, `stderr_lines`, `rc` or `results`),
 * then either
 *   - the producing task (or a block around it) sets `check_mode: false`,
 *     which is right only for a read that changes nothing, or
 *   - the reading task is guarded by `not ansible_check_mode` (in its `when`,
 *     a block's `when`, the `when` of every include of its file, or the
 *     expression itself), or tests the result `is not skipped`,
 *     which is how a task that must not run in a check (it writes, restarts
 *     or reports) keeps its readers safe.
 *
 * Limits, on purpose: it reads text, not Jinja. It does not follow a value
 * through `set_fact` to a later fact (the `set_fact` task itself is the
 * reader it checks), it trusts `not ansible_check_mode` anywhere in a
 * reader as a guard, it covers only `command` and `shell` producers (a
 * module that skips itself in a check, such as `uri` or `wait_for`, is not
 * yet tracked; #1631), it follows an include only to a file in the same
 * folder, and `| default(...)` is not a guard, because a command skipped in
 * check mode still has `stdout: ''` and `rc: 0`. A real `--check` run on the
 * host is the full test; this one catches the pattern that broke it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANSIBLE = join(REPO, 'lab-host', 'ansible');

const COMMAND_MODULES = new Set(
  ['command', 'shell'].flatMap((m) => [m, `ansible.builtin.${m}`, `ansible.legacy.${m}`]),
);
const BLOCK_KEYS = ['block', 'rescue', 'always'];

/** Every file under `dir`, recursively, as a path relative to the repository. */
function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [relative(REPO, path).replace(/\\/g, '/')];
  });
}

const whenText = (when) => (when === undefined ? '' : JSON.stringify(when));

/**
 * Flattens a task list into its tasks, each with the `check_mode` and `when`
 * text of the blocks around it. A block itself is not returned.
 */
export function flattenTasks(list, inherited = { checkModeOff: false, when: '' }) {
  if (!Array.isArray(list)) return [];
  return list.flatMap((task) => {
    if (!task || typeof task !== 'object') return [];
    const scope = {
      checkModeOff: inherited.checkModeOff || task.check_mode === false,
      when: `${inherited.when} ${whenText(task.when)}`,
    };
    if (BLOCK_KEYS.some((key) => Array.isArray(task[key]))) {
      return BLOCK_KEYS.flatMap((key) => flattenTasks(task[key], scope));
    }
    return [{ task, ...scope }];
  });
}

/** The tasks of a play file (pre_tasks, tasks, post_tasks, handlers). */
function playTasks(doc) {
  if (!Array.isArray(doc)) return [];
  return doc.flatMap((play) =>
    play && typeof play === 'object' && 'hosts' in play
      ? ['pre_tasks', 'tasks', 'post_tasks', 'handlers'].flatMap((key) => flattenTasks(play[key]))
      : flattenTasks([play]),
  );
}

const INCLUDE_MODULES = new Set(
  ['include_tasks', 'import_tasks'].flatMap((m) => [m, `ansible.builtin.${m}`]),
);

/** The task file an include or import names, relative to the including file. */
function includedFile(task, file) {
  const key = Object.keys(task).find((k) => INCLUDE_MODULES.has(k));
  if (!key) return undefined;
  const arg = typeof task[key] === 'string' ? task[key] : task[key]?.file;
  return typeof arg === 'string' && !arg.includes('{{') ? `${file.replace(/[^/]*$/, '')}${arg}` : undefined;
}

/**
 * A guard that keeps a reader out of a check run: `not ansible_check_mode`,
 * alone or opening a negated group. A bare mention is not enough, since
 * `ansible_check_mode and x.stdout ...` reads the empty output in a check.
 */
const CHECK_MODE_GUARD = /\bnot\s+\(?\s*ansible_check_mode\b/;

/**
 * The `when` text a file inherits from the tasks that include it, kept only
 * when every include of the file names `ansible_check_mode`: a file reached
 * once without that guard runs in a check.
 */
function includeGuards(entries) {
  const guards = {};
  for (let pass = 0; pass < 4; pass += 1) {
    const seen = {};
    for (const { task, file, when } of entries) {
      const target = includedFile(task, file);
      if (!target) continue;
      const text = `${when} ${whenText(task.when)} ${guards[file] ?? ''}`;
      (seen[target] ??= []).push(text);
    }
    for (const [target, texts] of Object.entries(seen)) {
      guards[target] = texts.every((t) => CHECK_MODE_GUARD.test(t)) ? texts.join(' ') : '';
    }
  }
  return guards;
}

const isCommandTask = (task) => Object.keys(task).some((key) => COMMAND_MODULES.has(key));

/** A reference to the output fields of registered result `name`. */
const outputRef = (name) =>
  new RegExp(`\\b${name}(?:\\.(?:stdout|stdout_lines|stderr|stderr_lines|rc|results)\\b|\\[['"](?:stdout|stdout_lines|stderr|stderr_lines|rc|results)['"]\\])`);

/**
 * Every place a command result that is not produced in check mode is read
 * without a check-mode guard, as `file: task "name" reads register (from file: task "name")`.
 *
 * `taskFiles` maps a file to its parsed YAML (a task list or a play list);
 * `textFiles` maps a template or vars file to its text.
 */
export function unguardedCheckModeReads(taskFiles, textFiles = {}) {
  const raw = Object.entries(taskFiles).flatMap(([file, doc]) =>
    playTasks(doc).map((entry) => ({ ...entry, file })),
  );
  const guards = includeGuards(raw);
  const entries = raw.map((entry) => ({ ...entry, when: `${entry.when} ${guards[entry.file] ?? ''}` }));
  const producers = entries.filter(
    ({ task, checkModeOff }) => typeof task.register === 'string' && isCommandTask(task) && !checkModeOff,
  );
  const found = [];
  for (const producer of producers) {
    const name = producer.task.register;
    const ref = outputRef(name);
    const skippedGuard = new RegExp(`\\b${name}\\s+is\\s+not\\s+skipped\\b|\\bnot\\s+${name}\\.skipped\\b`);
    for (const reader of entries) {
      if (reader.task === producer.task) continue;
      const text = JSON.stringify(reader.task);
      if (!ref.test(text)) continue;
      const guarded = CHECK_MODE_GUARD.test(`${text} ${reader.when}`) || skippedGuard.test(`${text} ${reader.when}`);
      if (!guarded) {
        found.push(`${reader.file}: task "${reader.task.name}" reads ${name} (from ${producer.file}: task "${producer.task.name}")`);
      }
    }
    for (const [file, text] of Object.entries(textFiles)) {
      if (ref.test(text) && !CHECK_MODE_GUARD.test(text)) {
        found.push(`${file} reads ${name} (from ${producer.file}: task "${producer.task.name}")`);
      }
    }
  }
  return found;
}

const FILES = filesUnder(ANSIBLE);
const TASK_FILES = FILES.filter(
  (file) => /\/roles\/[^/]+\/(tasks|handlers)\/[^/]+\.ya?ml$/.test(file) || file === 'lab-host/ansible/site.yml',
);
const TEXT_FILES = FILES.filter(
  (file) => /\/roles\/[^/]+\/(templates\/|(vars|defaults)\/[^/]+\.ya?ml$)/.test(file) || /\/group_vars\//.test(file),
);
const read = (file) => readFileSync(join(REPO, file), 'utf8');

describe('command results read later are produced in check mode, or read behind a guard', () => {
  it('reads the playbook and every role', () => {
    expect(TASK_FILES).toContain('lab-host/ansible/site.yml');
    expect(TASK_FILES).toContain('lab-host/ansible/roles/coder_sandbox/tasks/main.yml');
    expect(TASK_FILES).toContain('lab-host/ansible/roles/vault/tasks/install.yml');
    expect(TEXT_FILES.some((file) => file.endsWith('.j2'))).toBe(true);
  });

  it('holds for every task under lab-host/ansible', () => {
    const tasks = Object.fromEntries(TASK_FILES.map((file) => [file, parse(read(file), { logLevel: 'silent' })]));
    const texts = Object.fromEntries(TEXT_FILES.map((file) => [file, read(file)]));
    expect(unguardedCheckModeReads(tasks, texts)).toEqual([]);
  });

  const awkRead = {
    name: 'Read the subordinate id ranges already allocated',
    'ansible.builtin.command': { argv: ['awk', '{ print }', '/etc/subuid'] },
    register: 'ids',
    changed_when: false,
  };
  const usermod = {
    name: 'Give the user a subordinate uid range',
    'ansible.builtin.command': { argv: ['usermod', '--add-subuids', "{{ ids.results[0].stdout.split()[1] }}"] },
    when: "ids.results[0].stdout.split()[0] == '0'",
  };

  it('would have caught the read that stopped the drift check on 2026-11-09', () => {
    expect(unguardedCheckModeReads({ 'x.yml': [awkRead, usermod] })).toEqual([
      'x.yml: task "Give the user a subordinate uid range" reads ids (from x.yml: task "Read the subordinate id ranges already allocated")',
    ]);
  });

  it('accepts check_mode: false on the read, or on a block around it', () => {
    expect(unguardedCheckModeReads({ 'x.yml': [{ ...awkRead, check_mode: false }, usermod] })).toEqual([]);
    expect(unguardedCheckModeReads({ 'x.yml': [{ block: [awkRead], check_mode: false }, usermod] })).toEqual([]);
  });

  it('accepts a reader guarded by not ansible_check_mode, on itself or a block, or by `is not skipped`', () => {
    expect(unguardedCheckModeReads({ 'x.yml': [awkRead, { ...usermod, when: ['not ansible_check_mode', usermod.when] }] })).toEqual([]);
    expect(unguardedCheckModeReads({ 'x.yml': [awkRead, { block: [usermod], when: 'not ansible_check_mode' }] })).toEqual([]);
    expect(unguardedCheckModeReads({ 'x.yml': [awkRead, { ...usermod, when: ['ids is not skipped', usermod.when] }] })).toEqual([]);
  });

  it('does not take a positive mention of check mode, or `is skipped`, as a guard', () => {
    // Both still let the reader see the empty output of a check run.
    expect(unguardedCheckModeReads({ 'x.yml': [awkRead, { ...usermod, when: ['ansible_check_mode', usermod.when] }] })).toHaveLength(1);
    expect(unguardedCheckModeReads({ 'x.yml': [awkRead, { ...usermod, when: ['ids is skipped', usermod.when] }] })).toHaveLength(1);
  });

  it('accepts a reader in a file every include of which skips check mode', () => {
    const include = (when) => ({ name: 'inc', 'ansible.builtin.include_tasks': 'b.yml', when });
    expect(unguardedCheckModeReads({ 'r/a.yml': [awkRead, include('not ansible_check_mode')], 'r/b.yml': [usermod] })).toEqual([]);
    expect(
      unguardedCheckModeReads({ 'r/a.yml': [awkRead, include('not ansible_check_mode'), include('x')], 'r/b.yml': [usermod] }),
    ).toHaveLength(1);
  });

  it('does not take `| default` as a guard, and reads templates', () => {
    const reader = { name: 'r', 'ansible.builtin.debug': { msg: "{{ ids.stdout | default('') }}" } };
    expect(unguardedCheckModeReads({ 'x.yml': [awkRead, reader] })).toHaveLength(1);
    expect(unguardedCheckModeReads({ 'x.yml': [awkRead] }, { 'x.j2': '{{ ids.rc }}' })).toEqual([
      'x.j2 reads ids (from x.yml: task "Read the subordinate id ranges already allocated")',
    ]);
  });

  it('ignores a result read only as changed or failed', () => {
    const reader = { name: 'r', 'ansible.builtin.debug': { msg: 'x' }, when: 'ids is changed' };
    expect(unguardedCheckModeReads({ 'x.yml': [awkRead, reader] })).toEqual([]);
  });
});
