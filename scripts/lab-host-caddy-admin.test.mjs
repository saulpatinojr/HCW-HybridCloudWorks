/**
 * Caddy's admin API listens on a Unix socket, not on TCP 2019 (#958). Three
 * files have to agree for that to work, and a fourth decides whether the
 * first run after the change can reload at all:
 *
 * - roles/caddy/vars/main.yml names the socket, under /run/caddy;
 * - caddy.service.j2 creates /run/caddy as its RuntimeDirectory= and points
 *   ExecReload's `caddy reload --address` at the socket;
 * - Caddyfile.j2 puts the admin API there in a global block rendered on
 *   every run, and turns HTTP/3 off;
 * - the handlers. A run that moves Caddy from TCP to the socket notifies
 *   both a restart (the unit changed) and a reload (the Caddyfile changed).
 *   Ansible runs notified handlers in the order they are defined, so the
 *   restart has to be defined ahead of every reload of Caddy, in the caddy
 *   role and in the roles site.yml lists after it; a reload defined earlier,
 *   or done as a task, would reach a Caddy with nothing on the socket.
 *
 * roles/caddy/tests/caddy-adapt.test.sh checks the rendered Caddyfile with
 * the pinned Caddy itself; this holds the files to each other. In the CI
 * matrix it runs in the `scripts (operations)` row, whose filter covers
 * lab-host/.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ansible = path.join(repoRoot, 'lab-host/ansible');
const read = (relative) => readFileSync(path.join(ansible, relative), 'utf8');

const vars = read('roles/caddy/vars/main.yml');
const unit = read('roles/caddy/templates/caddy.service.j2');
const caddyfile = read('roles/caddy/templates/Caddyfile.j2');
const site = read('site.yml');

/** A top-level `key: value` from a YAML file, unquoted. */
function yamlScalar(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*"?([^"\\n#]*?)"?\\s*(?:#.*)?$`, 'm'));
  expect(match, `${key} is not set as a plain scalar`).not.toBeNull();
  return match[1];
}

/** Every `- name:` item of a task or handler file, at any indentation, with its body. */
function items(text) {
  const starts = [...text.matchAll(/^([ \t]*)- name: (.+)$/gm)];
  return starts.map((m, i) => ({
    name: m[2].trim(),
    body: text.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : text.length),
  }));
}

/** True when an item restarts or reloads the caddy unit. */
const touchesCaddy = (body, states) =>
  /^\s+name:\s*caddy\s*$/m.test(body) && new RegExp(`^\\s+state:\\s*(${states})\\s*$`, 'm').test(body);

const socket = yamlScalar(vars, 'caddy_admin_socket');
const address = yamlScalar(vars, 'caddy_admin_address').replace('{{ caddy_admin_socket }}', socket);

describe('the admin socket', () => {
  it('is /run/caddy/admin.sock, in Caddy network-address form unix//run/caddy/admin.sock', () => {
    expect(socket).toBe('/run/caddy/admin.sock');
    expect(address).toBe('unix//run/caddy/admin.sock');
  });

  it("lives in the directory the unit creates as its RuntimeDirectory", () => {
    const runtime = unit.match(/^RuntimeDirectory=(.+)$/m);
    expect(runtime, 'caddy.service.j2 has no RuntimeDirectory=').not.toBeNull();
    expect(runtime[1]).toBe('caddy');
    expect(path.posix.dirname(socket)).toBe(`/run/${runtime[1]}`);
    expect(unit).toMatch(/^RuntimeDirectoryMode=0700$/m);
  });

  it('is where ExecReload sends the reload, and the only ExecReload', () => {
    const reloads = [...unit.matchAll(/^ExecReload=(.+)$/gm)].map((m) => m[1]);
    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toBe(
      '{{ caddy_binary_path }} reload --config {{ caddy_config_dir }}/Caddyfile --adapter caddyfile --address {{ caddy_admin_address }} --force'
    );
  });

  it('is set in a global block the Caddyfile renders on every run, with HTTP/3 off', () => {
    const adminAt = caddyfile.indexOf('  admin {{ caddy_admin_address }}\n');
    expect(adminAt, 'Caddyfile.j2 does not set admin {{ caddy_admin_address }}').toBeGreaterThan(0);
    // No Jinja condition opens before the admin line, so no value of
    // caddy_acme_email (or anything else) can leave it out.
    expect(caddyfile.slice(0, adminAt)).not.toMatch(/\{%-?\s*(if|for)\b/);
    const block = caddyfile.slice(caddyfile.lastIndexOf('\n{\n', adminAt), caddyfile.indexOf('\n}\n', adminAt));
    expect(block).toContain('  servers {\n    protocols h1 h2\n  }\n');
  });

  it('leaves nothing in the caddy role on TCP 2019', () => {
    for (const relative of ['templates/caddy.service.j2', 'templates/Caddyfile.j2', 'templates/00-apex.caddy.j2', 'vars/main.yml', 'defaults/main.yml']) {
      expect(read(`roles/caddy/${relative}`), relative).not.toMatch(/(^|[^0-9])2019([^0-9-]|$)/m);
    }
  });
});

describe('the restart runs before any reload of Caddy', () => {
  const roleOrder = [...site.matchAll(/^ {4}- role: ([a-z_]+)$/gm)].map((m) => m[1]);
  const roles = readdirSync(path.join(ansible, 'roles'));
  const handlersOf = (role) => {
    const file = path.join(ansible, 'roles', role, 'handlers/main.yml');
    return existsSync(file) ? items(readFileSync(file, 'utf8')) : [];
  };

  it('site.yml has no play-level handlers that could run first', () => {
    expect(site).not.toMatch(/^ {2}handlers:/m);
  });

  it('the caddy role defines Restart caddy ahead of Reload caddy', () => {
    const names = handlersOf('caddy').map((h) => h.name);
    expect(names.indexOf('Restart caddy')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('Reload caddy')).toBeGreaterThan(names.indexOf('Restart caddy'));
    expect(touchesCaddy(handlersOf('caddy')[names.indexOf('Restart caddy')].body, 'restarted')).toBe(true);
  });

  it('every handler that reloads Caddy belongs to the caddy role or a role site.yml runs after it', () => {
    const caddyAt = roleOrder.indexOf('caddy');
    expect(caddyAt).toBeGreaterThanOrEqual(0);
    const reloaders = roles.flatMap((role) =>
      handlersOf(role)
        .filter((h) => touchesCaddy(h.body, 'reloaded|restarted'))
        .map((h) => ({ role, name: h.name }))
    );
    // The two the coder and addons roles define for their routes, and the caddy role's own pair.
    expect(reloaders.map((r) => r.name)).toEqual(
      expect.arrayContaining(['Restart caddy', 'Reload caddy', 'Reload caddy for the coder route', 'Reload caddy for the addons route'])
    );
    for (const { role, name } of reloaders) {
      expect(roleOrder.indexOf(role), `${role}: ${name}`).toBeGreaterThanOrEqual(caddyAt);
    }
  });

  it('no task reloads or restarts Caddy directly, outside the handlers', () => {
    for (const role of roles) {
      const dir = path.join(ansible, 'roles', role, 'tasks');
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
        for (const task of items(readFileSync(path.join(dir, file), 'utf8'))) {
          expect(touchesCaddy(task.body, 'reloaded|restarted'), `${role}/tasks/${file}: ${task.name}`).toBe(false);
        }
      }
    }
  });

  it('a running Caddy without the socket notifies the restart', () => {
    const tasks = items(read('roles/caddy/tasks/main.yml'));
    const check = tasks.find((t) => t.name === 'Check that the running Caddy answers on the admin socket');
    expect(check, 'the caddy role no longer checks the admin socket').toBeDefined();
    expect(check.body).toContain('path: "{{ caddy_admin_socket }}"');
    expect(check.body).toContain('changed_when: not (caddy_admin_socket_stat.stat.issock | default(false))');
    expect(check.body).toContain('notify: Restart caddy');
    // After the unit is installed and started, so the check reads the Caddy this run leaves.
    const names = tasks.map((t) => t.name);
    expect(names.indexOf('Check that the running Caddy answers on the admin socket')).toBeGreaterThan(
      names.indexOf('Enable and start Caddy')
    );
  });
});
