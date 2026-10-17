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

  it('on a 404 takes the route down, reloads Caddy before failing, and fails', () => {
    const order = [
      'Take down the coder route while Coder has no account',
      'Reload Caddy so the route is gone now',
      'Refuse to publish a Coder with no account',
    ].map((name) => firstUser.indexOf(`- name: ${name}\n`));
    expect(order.every((at) => at >= 0), String(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(task(firstUser, 'Take down the coder route while Coder has no account')).toContain(
      'path: "{{ coder_caddy_route_file }}"'
    );
    const reload = task(firstUser, 'Reload Caddy so the route is gone now');
    expect(reload).toContain('state: reloaded');
    expect(reload).toContain('- coder_first_user_route is changed');
    for (const name of [
      'Take down the coder route while Coder has no account',
      'Reload Caddy so the route is gone now',
      'Refuse to publish a Coder with no account',
    ]) {
      expect(task(firstUser, name), name).toContain('coder_first_user.status == 404');
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
