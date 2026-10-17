/**
 * SSH on the lab host (#953, owner decisions 2026-10-16): one account,
 * hcwadmin, by key only, and only the keys group_vars pins, which is the
 * owner's workstation key. Root keeps no key at all; break-glass is meant
 * to be hPanel's Web Console, which the owner verifies by hand (runbook).
 * This holds the files that make that true to each other:
 *
 * - the sshd drop-in's directives;
 * - the pinned key in group_vars, checked against its fingerprint, which is
 *   computed here from the key itself;
 * - the hardening role's refusals before it writes anything (an empty list,
 *   and the lockout guard against a list without the key of the most recent
 *   login in the journal, or, with no login there, sharing no key with the
 *   keys on file), and its writes: hcwadmin's file from the list alone,
 *   root's empty;
 * - the order that keeps a bad drop-in from reaching sshd: written, tested
 *   whole, read back with sshd -T, then reloaded (never restarted);
 * - Connect-Lab.ps1, which no longer writes root's keys.
 *
 * roles/hardening/tests/admin-keys.test.sh runs the key tasks themselves
 * against a journal fixture and scratch files, and sshd-apply.test.sh runs
 * the sshd tasks against a stub sshd. In the CI matrix this runs in the
 * `scripts (operations)` row, whose filter covers lab-host/ and scripts/.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A repository file as text. */
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');
const role = 'lab-host/ansible/roles/hardening';

const dropIn = read(`${role}/templates/sshd_hardening.conf.j2`);
const mainTasks = read(`${role}/tasks/main.yml`);
const tasks = read(`${role}/tasks/sshd.yml`);
const keyTasks = read(`${role}/tasks/admin_keys.yml`);
const handlers = read(`${role}/handlers/main.yml`);
const defaults = read(`${role}/defaults/main.yml`);
const vars = read(`${role}/vars/main.yml`);
const specs = read(`${role}/meta/argument_specs.yml`);
const groupVars = read('lab-host/ansible/group_vars/all.yml');
const connectLab = read('scripts/lab/Connect-Lab.ps1');

const WORKSTATION_FINGERPRINT = 'SHA256:VTyaLLQLfYwi38RP1mHDD6Vtu0eSQsa4EPsNJTrdgG8';

/** Every `- name:` item of a task file, at any indentation, with its body up to the next one. */
function items(text) {
  const starts = [...text.matchAll(/^([ \t]*)- name: (.+)$/gm)];
  return starts.map((m, i) => ({
    name: m[2].trim(),
    at: m.index,
    body: text.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : text.length),
  }));
}
/** The task named `name` in a task file, failing the test when there is none. */
const task = (text, name) => {
  const found = items(text).find((t) => t.name === name);
  expect(found, `no task named "${name}"`).toBeDefined();
  return found;
};

/** OpenSSH's SHA256 fingerprint of a public key line: base64 of the SHA-256 of the key blob, unpadded. */
const fingerprint = (line) =>
  'SHA256:' + createHash('sha256').update(Buffer.from(line.split(' ')[1], 'base64')).digest('base64').replace(/=+$/, '');

/** The directives of the drop-in, keyword to value, comments and blank lines dropped. */
const directives = Object.fromEntries(
  dropIn
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => {
      const [keyword, ...rest] = line.trim().split(/\s+/);
      return [keyword, rest.join(' ')];
    })
);

describe('the sshd drop-in', () => {
  it('lets in the allowlist only, by public key only, from authorized_keys only', () => {
    expect(directives).toMatchObject({
      AllowUsers: "{{ hardening_sshd_allow_users | join(' ') }}",
      AuthenticationMethods: 'publickey',
      PubkeyAuthentication: 'yes',
      AuthorizedKeysFile: '.ssh/authorized_keys',
      PasswordAuthentication: 'no',
      KbdInteractiveAuthentication: 'no',
      PermitRootLogin: 'no',
      MaxAuthTries: '4',
    });
    expect(dropIn).not.toMatch(/authorized_keys2/);
  });

  it('allows local TCP forwards only, and no agent, Unix-socket, tunnel or X11 forwarding', () => {
    expect(directives).toMatchObject({
      AllowAgentForwarding: 'no',
      AllowTcpForwarding: 'local',
      AllowStreamLocalForwarding: 'no',
      PermitTunnel: 'no',
      X11Forwarding: 'no',
    });
  });

  it('gives a login 30 seconds, and exempts the loopback Arc SSH arrives from from per-source penalties', () => {
    expect(directives).toMatchObject({
      LoginGraceTime: '30',
      PerSourcePenaltyExemptList: '127.0.0.1,::1',
    });
  });

  it('logs at VERBOSE, for the refused keys INFO does not name', () => {
    expect(directives.LogLevel).toBe('VERBOSE');
    // INFO already names the accepted key; the reason given must not say otherwise.
    expect(dropIn).toContain('INFO already logs the fingerprint of the key each accepted login used');
  });

  it('sets each keyword once, since sshd keeps the first value it reads', () => {
    const keywords = dropIn
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .map((line) => line.trim().split(/\s+/)[0]);
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it('defaults the allowlist to the administrative user, and refuses one without it or with root', () => {
    expect(defaults).toMatch(/^hardening_sshd_allow_users:\n {2}- "\{\{ hardening_admin_user \}\}"$/m);
    const guard = task(tasks, 'Refuse an sshd allowlist that leaves out the administrative user or lets root in').body;
    expect(guard).toContain('- hardening_admin_user in hardening_sshd_allow_users');
    expect(guard).toContain(`- "'root' not in hardening_sshd_allow_users"`);
  });
});

describe('the pinned key', () => {
  const list = groupVars.match(/^hardening_admin_authorized_keys:\n((?: {2}.*\n)+)/m);
  const entries = list ? [...list[1].matchAll(/^ {2}- (.+)$/gm)].map((m) => m[1]) : [];

  it('is one key, the owner\'s workstation key, by fingerprint', () => {
    expect(list, 'hardening_admin_authorized_keys is not a list in group_vars/all.yml').not.toBeNull();
    expect(entries).toHaveLength(1);
    expect(fingerprint(entries[0])).toBe(WORKSTATION_FINGERPRINT);
  });

  it('is a bare type and key, its comment stripped, and matches the role\'s key pattern', () => {
    expect(entries[0]).toMatch(/^ssh-ed25519 AAAA[A-Za-z0-9+/]+={0,3}$/);
    const types = vars.match(/^hardening_public_key_types: '(.+)'$/m)[1];
    const pattern = vars
      .match(/^hardening_public_key_pattern: '(.+)'$/m)[1]
      .replace('{{ hardening_public_key_types }}', types);
    expect(pattern).not.toContain('{{');
    expect(entries[0]).toMatch(new RegExp(pattern));
    // And the pattern refuses what a key list must not hold: options in front, or no key at all.
    expect(`no-pty ${entries[0]}`).not.toMatch(new RegExp(pattern));
    expect('ssh-ed25519 not-a-key').not.toMatch(new RegExp(pattern));
  });

  it('carries a comment naming it the workstation key, with that fingerprint', () => {
    expect(list[1]).toMatch(/^ {2}# The owner's workstation key, ~\/\.ssh\/hcw-lab_ed25519\.pub,$/m);
    expect(list[1]).toContain(`# ${WORKSTATION_FINGERPRINT}`);
  });
});

describe('the keys the role writes', () => {
  const keyItems = items(keyTasks);
  const index = (name) => keyItems.findIndex((t) => t.name === name);

  it('has no fallback: the role default is empty, and an empty list stops the run first', () => {
    expect(defaults).toMatch(/^hardening_admin_authorized_keys: \[\]$/m);
    expect(specs).toMatch(/hardening_admin_authorized_keys:\n(?: {8}.*\n)*? {8}default: \[\]\n/);
    const first = keyItems[0];
    expect(first.name).toBe('Refuse to run without a public key for the administrative user');
    expect(first.body).toContain('- hardening_admin_authorized_keys | length > 0');
    expect(first.body).toContain('lab-host/ansible/group_vars/all.yml');
    // The copy-from-root fallback is gone from both task files.
    expect(mainTasks + tasks + keyTasks).not.toMatch(/hardening_effective_authorized_keys/);
    expect(mainTasks + tasks).not.toMatch(/slurp:/);
    // hcwadmin's keys are written before sshd's settings change.
    expect(mainTasks.indexOf('ansible.builtin.import_tasks: admin_keys.yml')).toBeGreaterThan(0);
    expect(mainTasks.indexOf('ansible.builtin.import_tasks: sshd.yml')).toBeGreaterThan(
      mainTasks.indexOf('ansible.builtin.import_tasks: admin_keys.yml')
    );
  });

  it('refuses a list without the key of the most recent login in the journal, unless told to replace it', () => {
    // The journal sshd's INFO lines are read from, and the login that counts.
    expect(vars).toMatch(
      /^hardening_ssh_login_journal_argv:\n {2}- journalctl\n {2}- --quiet\n {2}- --no-pager\n {2}- --unit\n {2}- ssh\.service\n {2}- --since\n {2}- 14 days ago\n {2}- --output\n {2}- cat\n/m
    );
    const read = task(keyTasks, 'Read the SSH logins of the last 14 days from the journal').body;
    expect(read).toContain('argv: "{{ hardening_ssh_login_journal_argv }}"');
    expect(read).toContain('check_mode: false');
    expect(task(keyTasks, 'Refuse to guess which key logs in when the journal cannot be read').body).toContain(
      '- hardening_ssh_journal.rc == 0'
    );
    const last = task(keyTasks, 'Find the most recent SSH login as the administrative user or root').body;
    expect(last).toContain("select('match', '^Accepted publickey for (' ~ (hardening_admin_user | regex_escape) ~ '|root) ')");
    expect(last).toContain('| list | last');
    // The journal decides when it has a login; the files only when it has none.
    const basis = task(keyTasks, 'Decide what the key list is compared with').body;
    expect(basis).toContain("hardening_keys_lockout_basis: \"{{ 'journal' if hardening_ssh_last_login | length > 0 else 'file' }}\"");
    const decide = task(keyTasks, 'Decide whether the key list would lock out the key that logs in today').body;
    expect(decide).toContain('hardening_ssh_last_login_fp not in hardening_keys_wanted_fps');
    expect(decide).toContain("if hardening_keys_lockout_basis == 'journal'");
    expect(decide).toContain('else (hardening_keys_now | length > 0 and hardening_keys_now | intersect(hardening_keys_wanted) | length == 0)');
    const guard = task(keyTasks, 'Refuse a key list that would lock out the key that logs in today').body;
    expect(guard).toContain('- not (hardening_keys_lockout | bool) or (hardening_admin_keys_replace_all | bool)');
    expect(guard).toContain('-e hardening_admin_keys_replace_all=true');
    expect(defaults).toMatch(/^hardening_admin_keys_replace_all: false$/m);
    expect(specs).toMatch(/hardening_admin_keys_replace_all:\n {8}type: bool\n {8}required: false\n {8}default: false\n/);
  });

  it("falls back to hcwadmin's keys on file, or root's while hcwadmin has none", () => {
    const which = task(keyTasks, 'Decide which keys on file the list falls back to').body;
    expect(which).toMatch(/hardening_admin_authorized_keys_path\s+if hardening_keys_admin_text is search/);
    expect(which).toContain('else hardening_root_authorized_keys_path');
  });

  it("writes hcwadmin's file from the list alone, only after every refusal", () => {
    const write = task(keyTasks, "Write the administrative user's authorized_keys from the list, and nothing else").body;
    expect(write).toContain('ansible.builtin.copy:');
    expect(write).toContain(`content: "{{ hardening_admin_authorized_keys | join('\\n') }}\\n"`);
    expect(write).toContain('mode: "0600"');
    const writeAt = index("Write the administrative user's authorized_keys from the list, and nothing else");
    for (const refusal of [
      'Refuse to run without a public key for the administrative user',
      'Refuse an entry in the key list that is not one public key',
      'Refuse to guess which key logs in when the journal cannot be read',
      'Refuse a key list ssh-keygen cannot read',
      'Refuse a key list that would lock out the key that logs in today',
    ]) {
      expect(index(refusal), refusal).toBeGreaterThanOrEqual(0);
      expect(index(refusal), refusal).toBeLessThan(writeAt);
    }
  });

  it('marks the reload pending before the drop-in changes, and reloads before root\'s keys when a marker is left', () => {
    const at = (name) => task(tasks, name).at;
    const mark = task(tasks, "Mark sshd's reload pending before the drop-in changes");
    expect(mark.body).toContain('dest: "{{ hardening_sshd_reload_marker }}"');
    expect(mark.body).toContain('when: hardening_sshd_dropin_preview is changed');
    expect(task(tasks, 'See whether the sshd drop-in is about to change').body).toContain('check_mode: true');
    expect(at('See whether the sshd drop-in is about to change')).toBeLessThan(mark.at);
    expect(mark.at).toBeLessThan(at("Harden sshd through a drop-in that sorts before cloud-init's"));
    const pending = task(tasks, 'Look for a reload of sshd an earlier run left pending');
    expect(pending.body).toContain('path: "{{ hardening_sshd_reload_marker }}"');
    expect(pending.body).toContain('notify: Reload ssh');
    expect(pending.at).toBeLessThan(at('Apply the sshd drop-in before any later role can fail'));
    expect(vars).toMatch(/^hardening_sshd_reload_marker: \/var\/lib\/hcw-hardening\/sshd-reload-pending$/m);
    // Only the reload handler removes the marker, after the reload itself.
    expect(handlers).toMatch(
      /- name: Forget the pending reload of sshd\n {2}ansible\.builtin\.file:\n {4}path: "\{\{ hardening_sshd_reload_marker \}\}"\n {4}state: absent\n {2}listen: Reload ssh\n/
    );
    expect(handlers.indexOf('- name: Forget the pending reload of sshd')).toBeGreaterThan(handlers.indexOf('- name: Reload ssh'));
  });

  it("keeps root's authorized_keys empty, once sshd has reloaded", () => {
    expect(vars).toMatch(/^hardening_root_authorized_keys_path: \/root\/\.ssh\/authorized_keys$/m);
    const empty = task(tasks, "Keep root's authorized_keys empty");
    expect(empty.body).toContain('dest: "{{ hardening_root_authorized_keys_path }}"');
    expect(empty.body).toMatch(/content: ""\n/);
    expect(empty.body).toContain('mode: "0600"');
    expect(empty.at).toBeGreaterThan(task(tasks, 'Apply the sshd drop-in before any later role can fail').at);
  });
});

describe('the drop-in reaches sshd only after it is proven', () => {
  const block = tasks.slice(
    tasks.indexOf('- name: Harden sshd, and prove what it would apply before it reads the change'),
    tasks.indexOf('- name: Apply the sshd drop-in before any later role can fail')
  );
  const order = [
    'Harden sshd through a drop-in that sorts before cloud-init\'s',
    'Test the whole sshd configuration the drop-in is part of',
    'Read what sshd would apply to a login as the administrative user and as root',
    'Refuse an sshd configuration that is not the one this role writes',
  ];

  it('writes, tests the whole configuration, reads it back, and asserts, in that order, before the flush', () => {
    const at = order.map((name) => block.indexOf(`- name: ${name}`));
    for (const [i, name] of order.entries()) expect(at[i], name).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(block).toContain('validate: "{{ hardening_sshd_binary }} -t -f %s"');
    expect(vars).toMatch(/^hardening_sshd_binary: \/usr\/sbin\/sshd$/m);
    expect(vars).toMatch(/^hardening_sshd_dropin_path: \/etc\/ssh\/sshd_config\.d\/00-hcw-hardening\.conf$/m);
    expect(block).toContain('notify: Reload ssh');
  });

  it('asks sshd -T about hcwadmin and root, and holds the answer to the drop-in', () => {
    expect(block).toMatch(/- -T\n\s+- -C\n\s+- "user=\{\{ item \}\},host=\{\{ hardening_sshd_test_host \}\},addr=\{\{ hardening_sshd_test_addr \}\}"/);
    expect(vars).toMatch(/^hardening_sshd_test_addr: 192\.0\.2\.10$/m);
    for (const line of [
      'authenticationmethods publickey',
      'permitrootlogin no',
      'allowagentforwarding no',
      'allowtcpforwarding local',
      'allowstreamlocalforwarding no',
      'logingracetime 30',
      'persourcepenaltyexemptlist 127.0.0.1,::1',
      'passwordauthentication no',
    ]) {
      expect(block).toContain(`'${line}' in hardening_sshd_effective.results[0].stdout_lines`);
    }
    expect(block).toContain("'permitrootlogin no' in hardening_sshd_effective.results[1].stdout_lines");
    expect(block).toContain("'allowusers root' not in hardening_sshd_effective.results[1].stdout_lines");
  });

  it('puts the previous drop-in back when a check fails, removes the backup, and only then stops', () => {
    const rescue = block.slice(block.indexOf('  rescue:'));
    const back = rescue.indexOf('src: "{{ hardening_sshd_dropin.backup_file }}"');
    const removed = rescue.indexOf('- name: Remove the backup, now that it is back in place');
    const stop = rescue.indexOf('ansible.builtin.fail:');
    expect(back).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(back);
    expect(stop).toBeGreaterThan(removed);
    expect(rescue.slice(removed, stop)).toContain('path: "{{ hardening_sshd_dropin.backup_file }}"\n        state: absent');
  });

  it('reloads sshd, never restarts it, so open sessions stay up', () => {
    expect(handlers).toMatch(/- name: Reload ssh\n {2}ansible\.builtin\.systemd_service:\n {4}name: ssh\n {4}state: reloaded\n/);
    const roles = path.join(repoRoot, 'lab-host/ansible/roles');
    for (const r of readdirSync(roles)) {
      for (const dir of ['tasks', 'handlers']) {
        const folder = path.join(roles, r, dir);
        if (!existsSync(folder)) continue;
        for (const file of readdirSync(folder).filter((f) => f.endsWith('.yml'))) {
          const text = readFileSync(path.join(folder, file), 'utf8');
          for (const item of items(text)) {
            const restartsSsh = /^\s+name:\s*(ssh|sshd)(\.service)?\s*$/m.test(item.body) && /^\s+state:\s*restarted\s*$/m.test(item.body);
            expect(restartsSsh, `${r}/${dir}/${file}: ${item.name}`).toBe(false);
          }
        }
      }
    }
  });
});

describe('Connect-Lab.ps1', () => {
  it("never writes root's authorized_keys, which the playbook keeps empty", () => {
    expect(connectLab).not.toMatch(/\/root\/\.ssh/);
    expect(connectLab).not.toMatch(/sudo tee/);
  });

  it('prints the group_vars line that pins a key', () => {
    expect(connectLab).toContain('function Get-LabGroupVarsKeyLine');
    expect(connectLab).toContain('Write-Host (Get-LabGroupVarsKeyLine -PublicKey $publicKey)');
  });
});

describe('port 22 closed to the internet behind the Arc gate (#953 stage 3)', () => {
  const ufwTasks = read(`${role}/tasks/ufw.yml`);
  const arcDefaults = read('lab-host/ansible/roles/arc/defaults/main.yml');
  const ci = read('.github/workflows/ci.yml');
  /** A top-level `key: value` scalar of a YAML file, quotes and comment dropped. */
  const scalar = (text, key) => {
    const match = new RegExp(`^${key}:\\s*"?([^"#\\n]*?)"?\\s*(?:#.*)?$`, 'm').exec(text);
    expect(match, `${key} is not set`).not.toBeNull();
    return match[1];
  };

  it('runs the ufw tasks from tasks/ufw.yml, which the shell test runs as they ship', () => {
    expect(mainTasks).toMatch(/ansible\.builtin\.import_tasks: ufw\.yml/);
    expect(mainTasks).not.toContain('community.general.ufw');
  });

  it('turns the gate on for the lab host, and reads the agent where the arc role installs it', () => {
    expect(scalar(groupVars, 'hardening_ssh_arc_gate')).toBe('true');
    expect(scalar(defaults, 'hardening_ssh_arc_gate')).toBe('false');
    expect(scalar(defaults, 'hardening_arc_azcmagent_path')).toBe(scalar(arcDefaults, 'arc_azcmagent_path'));
  });

  it('closes only the lists it settled, so the gate decides 22 for every task after it', () => {
    expect(ufwTasks).toContain('loop: "{{ hardening_ufw_allow_now }}"');
    expect(ufwTasks).toContain('loop: "{{ hardening_ufw_close_now }}"');
    expect(ufwTasks).not.toMatch(/loop: "\{\{ hardening_ufw_(allowed|closed)_tcp_ports \}\}"/);
    // Only Connected with incoming connections on for 22 closes it. A
    // Disconnected agent may be a reset one being onboarded again over 22, so
    // 22 is left as it is; anything else keeps it open, so a rebuilt host stays
    // reachable for onboarding (pre-review of #953 stage 3).
    expect(ufwTasks).toContain("{{ 'open' if not (hardening_arc_ssh_wanted | bool)");
    expect(ufwTasks).toContain("else 'close' if hardening_arc_status == 'Connected'");
    expect(ufwTasks).toContain("and hardening_arc_incoming_enabled == 'true'");
    expect(ufwTasks).toContain("and '22' in hardening_arc_incoming_ports");
    expect(ufwTasks).toContain("else 'hold' if hardening_arc_status == 'Disconnected'");
    expect(ufwTasks).toContain("if hardening_ufw_gate_22 in ['open', 'hold'] else hardening_ufw_closed_ports");
    // The lists are compared as integers, so "22" cannot slip past the gate.
    expect(ufwTasks).toContain("hardening_ufw_closed_tcp_ports | map('int') | list");
  });

  it('runs tests/ufw-closed-ports.test.sh in CI, as root, with ufw installed', () => {
    const step = /- name: ufw closed-ports test\n([\s\S]*?)\n\n/.exec(ci);
    expect(step, 'ci.yml has no "ufw closed-ports test" step').not.toBeNull();
    expect(step[1]).toContain('apt-get install -y -qq ufw');
    expect(step[1]).toMatch(/sudo env "PATH=\$PATH" "ANSIBLE_COLLECTIONS_PATH=\$HOME\/\.ansible\/collections" bash roles\/hardening\/tests\/ufw-closed-ports\.test\.sh/);
  });
});
