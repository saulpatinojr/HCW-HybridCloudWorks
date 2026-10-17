/**
 * A Coder with no account is never published (#954 review). Coder v2.38.0
 * lets whoever reaches a deployment with no account make the first one, its
 * Owner, through /setup or through a GitHub sign-in even with sign-ups off.
 * The coder role (tasks/first_user.yml) asks /api/v2/users/first after Coder
 * starts and before its Caddy route is written. On a 404 it takes the route
 * down, reloads Caddy at once and fails with the runbook's steps. This holds
 * that order, the read, and the runbook's procedure, together.
 *
 * In the CI matrix this runs in the `scripts (operations)` row, whose filter
 * covers lab-host/.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A repository file as text. */
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

const role = 'lab-host/ansible/roles/coder';
const main = read(`${role}/tasks/main.yml`);
const firstUser = read(`${role}/tasks/first_user.yml`);
const runbook = read('docs/runbooks/labs-host.md');

/** The body of the task named `name` in a task file, up to the next task. */
function task(text, name) {
  const start = text.indexOf(`- name: ${name}\n`);
  expect(start, `no task named "${name}"`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n- name: ', start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

describe('the coder role keeps a Coder with no account unpublished', () => {
  it('counts the accounts in the database and takes the route down BEFORE Coder starts', () => {
    const names = [
      'Start PostgreSQL alone, to read whether Coder has an account',
      'Count Coder\'s accounts in its database',
      'Take Coder\'s route down before a Coder with no account starts',
      'Start Coder and PostgreSQL',
    ].map((name) => main.indexOf(`- name: ${name}\n`));
    expect(names.every((at) => at >= 0), String(names)).toBe(true);
    expect([...names].sort((a, b) => a - b)).toEqual(names);
    expect(task(main, 'Start PostgreSQL alone, to read whether Coder has an account')).toContain('services: [coder-postgres]');
    const count = task(main, 'Count Coder\'s accounts in its database');
    // System accounts left out, as /api/v2/users/first leaves them out (v2.38.0 has `prebuilds`).
    expect(count).toContain('- SELECT count(*) FROM users WHERE NOT deleted AND NOT is_system');
    expect(count).toContain('- coder-postgres');
    expect(count).toContain('failed_when: false');
    expect(count).toContain('check_mode: false');
    // The container the query names is the Compose file's.
    expect(read('lab-host/coder/docker-compose.yml')).toMatch(/^\s+container_name: coder-postgres$/m);
    const include = task(main, 'Take Coder\'s route down before a Coder with no account starts');
    expect(include).toContain('ansible.builtin.include_tasks: unpublish.yml');
    // Anything but a readable count above zero, an error included, takes the route down.
    expect(include).toContain('- not (coder_account_count.rc == 0 and (coder_account_count.stdout | trim | int) > 0)');
  });

  it('removes the route and flushes the reload handler then and there, always reporting the removal', () => {
    const unpublish = read(`${role}/tasks/unpublish.yml`);
    const remove = task(unpublish, 'Remove the coder route');
    expect(remove).toContain('path: "{{ coder_caddy_route_file }}"');
    expect(remove).toContain('state: absent');
    // A route removed by an interrupted run may still be loaded: the reload always runs.
    expect(remove).toContain('changed_when: true');
    expect(remove).toContain('notify: Reload caddy for the coder route');
    expect(task(unpublish, 'Reload Caddy now, before Coder starts')).toContain('ansible.builtin.meta: flush_handlers');
    expect(unpublish).not.toMatch(/state: (reloaded|restarted)/);
  });

  it('asks after Coder starts and before the Caddy route is written', () => {
    const start = main.indexOf('- name: Start Coder and PostgreSQL');
    const guard = main.indexOf('- name: Keep a Coder with no account unpublished');
    const route = main.indexOf('- name: Render the Caddy route for the coder names');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(start);
    expect(route).toBeGreaterThan(guard);
    const imported = task(main, 'Keep a Coder with no account unpublished');
    expect(imported).toContain('ansible.builtin.import_tasks: first_user.yml');
    expect(imported).toContain('when: coder_enabled | bool');
  });

  it('reads /api/v2/users/first on the loopback, taking 404 as an answer, in check mode too', () => {
    const ask = task(firstUser, 'Ask Coder whether its first account exists');
    expect(ask).toContain('url: "http://127.0.0.1:{{ coder_http_port }}/api/v2/users/first"');
    expect(ask).toContain('status_code: [200, 404]');
    expect(ask).toContain('check_mode: false');
  });

  it('on a 404 takes the route down through the reload handler, which still runs when the play fails, and fails', () => {
    const takeDown = task(firstUser, 'Take down the coder route while Coder has no account');
    const refuse = task(firstUser, 'Refuse to publish a Coder with no account');
    expect(firstUser.indexOf(takeDown)).toBeLessThan(firstUser.indexOf(refuse));
    expect(takeDown).toContain('path: "{{ coder_caddy_route_file }}"');
    expect(takeDown).toContain('state: absent');
    // Caddy is reloaded by handlers only (lab-host-caddy-admin.test.mjs), and
    // force_handlers runs this one although the fail ends the play.
    expect(takeDown).toContain('notify: Reload caddy for the coder route');
    expect(takeDown).toContain('changed_when: true');
    expect(read(`${role}/handlers/main.yml`)).toContain('- name: Reload caddy for the coder route\n');
    expect(read('lab-host/ansible/site.yml')).toMatch(/^\s+force_handlers: true$/m);
    expect(firstUser).not.toMatch(/state: (reloaded|restarted)/);
    for (const body of [takeDown, refuse]) {
      expect(body).toContain('coder_first_user.status == 404');
    }
    expect(task(firstUser, 'Refuse to publish a Coder with no account')).toContain('"A Coder with no account');
  });

  it('has the runbook section the failure names, with the measured commands', () => {
    const at = runbook.indexOf('### A Coder with no account yet');
    expect(at, 'runbook section missing').toBeGreaterThanOrEqual(0);
    const section = runbook.slice(at, runbook.indexOf('\n## ', at));
    expect(section).toContain('--first-user-username hcw-breakglass');
    expect(section).toContain('--first-user-trial=false');
    expect(section).toContain('coder users edit-roles saulpatinojr --roles owner -y');
    expect(section).toContain('coder logout -y');
    // A suspended Owner is refused, so the role comes off first.
    expect(section).toContain('coder users edit-roles hcw-breakglass --roles auditor -y && echo yes | coder users suspend hcw-breakglass');
    // Token lines strip the carriage return, as every such line does.
    for (const line of section.split('\n').filter((l) => l.includes('read -r CODER_SESSION_TOKEN'))) {
      expect(line).toContain('tr -d \\\\r');
    }
  });
});
