/**
 * The Scheduled tasks tab's list against the real schedules.
 *
 * Platform Settings → Scheduled tasks lists every job in the estate that runs
 * on a clock (frontend/src/components/admin/platform-settings/scheduledTasks.js).
 * A list typed by hand goes stale the first time someone adds a workflow or
 * moves a timer, and a stale list is worse than none, because it is believed.
 * So this test reads the places the schedules really live and fails when the
 * list and they disagree, in either direction:
 *
 *   - every GitHub Actions workflow with a `cron:` line (.github/workflows),
 *     with the workflow's own `name:` and every cron line it has;
 *   - every Function App timer: the names come from
 *     functions/function-inventory.json (which function-inventory.test.js
 *     holds to the real registrations), the schedules from the source files
 *     that register them;
 *   - every systemd timer the lab host playbook installs
 *     (lab-host/ansible/roles/<role>/templates/*.timer.j2), with each
 *     `{{ variable }}` filled in the way Ansible would: the role's
 *     vars/main.yml first, then group_vars/all.yml, then the role's
 *     defaults. A timer variable set in the inventory (which would win over
 *     group_vars) fails the test, because this test does not read it.
 *
 * A workflow's cron lines are counted as well as read: a `cron:` line this
 * test cannot read (written in a shape it does not know) fails rather than
 * being skipped.
 *
 * The one row it cannot check is the daily Claude session, which lives in the
 * owner's Claude account; it only checks that row is there.
 *
 * It lives in the scripts package, not the frontend's, because the scripts
 * row of ci.yml already runs on every change to .github/workflows and
 * lab-host, which is where the schedules change.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCHEDULE_GROUPS,
  SCHEDULED_TASKS,
} from '../frontend/src/components/admin/platform-settings/scheduledTasks.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const FUNCTIONS = join(REPO, 'functions', 'src', 'functions');
const INVENTORY = join(REPO, 'functions', 'function-inventory.json');
const ROLES = join(REPO, 'lab-host', 'ansible', 'roles');
const GROUP_VARS = join(REPO, 'lab-host', 'ansible', 'group_vars', 'all.yml');
const ANSIBLE_INVENTORY = join(REPO, 'lab-host', 'ansible', 'inventory');
const BLOB = 'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/';

/**
 * The files that register a timer. A new timer in a file not named here fails
 * the inventory test below with its name, and the fix is to add the file.
 */
const TIMER_FILES = [
  'schedulers.js',
  'jobs-sweeper.js',
  'cosmos-export.js',
  'cloud-tools-jobs.js',
  'labs-jobs.js',
  'ambassador-audience.js',
  'visitor-session-sweep.js',
  'brain-http.js',
];

const listed = (group) =>
  new Map(SCHEDULED_TASKS.filter((t) => t.group === group).map((t) => [t.id, t]));

/**
 * One `- cron: ...` list item, quoted or not, with an optional comment after
 * it. The value is group 2 (quoted) or group 3 (bare).
 */
const CRON_ITEM = /^\s*-\s*cron:\s*(?:(['"])(.+?)\1|([^'"#\s][^#]*?))\s*(?:#.*)?$/;

/**
 * Each scheduled workflow: file name → { name, crons, cronLines }. Comment
 * lines are skipped. `cronLines` counts every other line that mentions
 * `cron:`, so a line in a shape CRON_ITEM does not read shows up as a
 * difference between the two.
 */
function scheduledWorkflows() {
  const found = new Map();
  for (const file of readdirSync(WORKFLOWS)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const text = readFileSync(join(WORKFLOWS, file), 'utf8');
    const crons = [];
    let cronLines = 0;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line) || !/\bcron:/.test(line)) continue;
      cronLines += 1;
      const cron = CRON_ITEM.exec(line);
      if (cron) crons.push(cron[2] ?? cron[3]);
    }
    if (cronLines === 0) continue;
    const name = /^name:\s*(['"]?)(.+?)\1\s*$/m.exec(text);
    found.set(file, { name: name ? name[2] : file, crons, cronLines });
  }
  return found;
}

/**
 * Every timer a source file registers: name → schedule. Reads two shapes:
 * schedulers.js's helper, `timer('name', 'FLAG', 'schedule', ...)`, and
 * `app.timer(name, { ... schedule: value })`, where name and value are a
 * quoted string or a `const` declared in the same file.
 */
function registeredTimers(source) {
  const constants = new Map(
    [...source.matchAll(/^(?:export\s+)?const\s+(\w+)\s*=\s*'([^']*)'\s*;/gm)].map((m) => [m[1], m[2]])
  );
  const value = (token) => (token.startsWith("'") ? token.slice(1, -1) : constants.get(token));
  const found = new Map();
  for (const m of source.matchAll(/^timer\(\s*'(\w+)',\s*'\w+',\s*'([^']+)'/gm)) found.set(m[1], m[2]);
  for (const m of source.matchAll(/app\.timer\(\s*('[^']*'|\w+)\s*,\s*\{[^}]*?\bschedule:\s*('[^']*'|\w+)/g)) {
    const name = value(m[1]);
    const schedule = value(m[2]);
    if (name && schedule) found.set(name, schedule);
  }
  return found;
}

function functionTimers() {
  const found = new Map();
  for (const file of TIMER_FILES) {
    const source = readFileSync(join(FUNCTIONS, file), 'utf8');
    for (const [name, schedule] of registeredTimers(source)) found.set(name, { schedule, file });
  }
  return found;
}

/** `key: value` from a flat YAML file, with surrounding quotes removed; undefined when absent. */
function yamlValue(text, key) {
  const match = new RegExp(`^${key}:\\s*(['"]?)(.+?)\\1\\s*$`, 'm').exec(text);
  return match ? match[2] : undefined;
}

/** A role's YAML file as text, or '' when the role has none. */
function roleFile(role, folder) {
  const path = join(ROLES, role, folder, 'main.yml');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Every file under the Ansible inventory folder: relative path → text. */
function inventoryFiles(dir = ANSIBLE_INVENTORY, prefix = '') {
  const files = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [name, text] of inventoryFiles(path, `${prefix}${entry.name}/`)) files.set(name, text);
    } else {
      files.set(`${prefix}${entry.name}`, readFileSync(path, 'utf8'));
    }
  }
  return files;
}

/**
 * Each lab host timer: unit file name → { role, schedule, variables }, with
 * its variables filled in. Ansible's order, highest first: the role's vars,
 * then group_vars/all.yml, then the role's defaults.
 */
function labTimers() {
  const groupVars = readFileSync(GROUP_VARS, 'utf8');
  const found = new Map();
  for (const role of readdirSync(ROLES)) {
    const templates = join(ROLES, role, 'templates');
    if (!existsSync(templates)) continue;
    for (const file of readdirSync(templates)) {
      if (!file.endsWith('.timer.j2')) continue;
      const text = readFileSync(join(templates, file), 'utf8');
      const line = text.split(/\r?\n/).find((l) => /^(OnCalendar|OnUnitActiveSec)=/.test(l));
      if (!line) throw new Error(`${role}/templates/${file} has no OnCalendar= or OnUnitActiveSec= line`);
      const roleVars = roleFile(role, 'vars');
      const defaults = roleFile(role, 'defaults');
      const variables = [];
      const schedule = line.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
        variables.push(name);
        const resolved =
          yamlValue(roleVars, name) ?? yamlValue(groupVars, name) ?? yamlValue(defaults, name);
        if (resolved === undefined || resolved.includes('{{')) {
          throw new Error(`${role}/templates/${file}: cannot fill in {{ ${name} }}`);
        }
        return resolved;
      });
      found.set(file.replace(/\.j2$/, ''), { role, schedule, variables });
    }
  }
  return found;
}

const keysOf = (map) => [...map.keys()].sort();

describe('the Scheduled tasks list', () => {
  it('reads the sources at all', () => {
    // Guards the guard: an empty read on any side would let every check below pass.
    expect(scheduledWorkflows().size).toBeGreaterThan(10);
    expect(functionTimers().size).toBeGreaterThan(20);
    expect(labTimers().size).toBeGreaterThan(5);
  });

  it('has unique ids, and every row in a known group with at least one schedule and a link', () => {
    const groups = new Set(SCHEDULE_GROUPS.map((g) => g.id));
    const ids = SCHEDULED_TASKS.map((t) => `${t.group}/${t.id}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of SCHEDULED_TASKS) {
      expect(groups, task.id).toContain(task.group);
      expect(task.schedules.length, task.id).toBeGreaterThan(0);
      expect(task.does.length, task.id).toBeGreaterThan(20);
      expect(task.href, task.id).toMatch(/^https:\/\//);
    }
  });

  it('reads every cron line in every workflow, quoted or not', () => {
    const unread = [...scheduledWorkflows()]
      .filter(([, { crons, cronLines }]) => crons.length !== cronLines)
      .map(([file, { crons, cronLines }]) => `${file}: ${cronLines} cron lines, ${crons.length} read`);
    expect(unread, 'Write each schedule as a `- cron: ...` list item, one per line').toEqual([]);
  });

  it('lists every scheduled workflow, by its own name and with every cron line it has', () => {
    const real = scheduledWorkflows();
    const rows = listed('github');
    expect(keysOf(rows), 'workflows with a schedule (left) against the rows listed').toEqual(keysOf(real));
    for (const [file, { name, crons }] of real) {
      expect(rows.get(file).schedules, `${file}: its cron lines`).toEqual(crons);
      expect(rows.get(file).name, `${file}: its name: line`).toBe(name);
    }
  });

  it('reads a schedule for every timer the Function App registers', () => {
    const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8')).timer;
    const missing = inventory.filter((name) => !functionTimers().has(name));
    expect(
      missing,
      'These timers are in function-inventory.json but in none of TIMER_FILES; add the file that registers them'
    ).toEqual([]);
    expect(keysOf(functionTimers())).toEqual([...inventory].sort());
  });

  it('lists every Function App timer with its schedule, linked to the file that sets it', () => {
    const real = functionTimers();
    const rows = listed('functions');
    expect(keysOf(rows), 'timers registered (left) against the rows listed').toEqual(keysOf(real));
    for (const [name, { schedule, file }] of real) {
      expect(rows.get(name).schedules, `${name}: its schedule`).toEqual([schedule]);
      expect(rows.get(name).href, `${name}: its link`).toBe(`${BLOB}functions/src/functions/${file}`);
    }
  });

  it('finds no lab host timer variable set in the inventory, which this test does not read', () => {
    const names = new Set([...labTimers().values()].flatMap((t) => t.variables));
    const found = [];
    for (const [path, text] of inventoryFiles()) {
      for (const name of names) {
        if (new RegExp(`^\\s*${name}\\s*:`, 'm').test(text)) found.push(`${name} in inventory/${path}`);
      }
    }
    expect(
      found,
      'An inventory value wins over group_vars and the role defaults this test reads, so the list could show the wrong time. Set it in group_vars/all.yml instead, or teach this test to read the inventory'
    ).toEqual([]);
  });

  it('lists every lab host timer with its schedule, linked to its template', () => {
    const real = labTimers();
    const rows = listed('lab-host');
    expect(keysOf(rows), 'timers the playbook installs (left) against the rows listed').toEqual(keysOf(real));
    for (const [unit, { role, schedule }] of real) {
      expect(rows.get(unit).schedules, `${unit}: its schedule`).toEqual([schedule]);
      expect(rows.get(unit).href, `${unit}: its link`).toBe(
        `${BLOB}lab-host/ansible/roles/${role}/templates/${unit}.j2`
      );
    }
  });

  it('keeps the daily Claude session, which no file in the repository holds', () => {
    const rows = [...listed('claude').values()];
    expect(rows.map((r) => [r.name, r.schedules])).toEqual([
      ['Daily: finish what the scheduled jobs left', ['13 9 * * *']],
    ]);
  });
});
