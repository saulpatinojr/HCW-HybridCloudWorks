/**
 * A lab job's resource limits are stated in four places, and they agree.
 *
 * vps-agent/index.js falls back to a default for each LABS_AGENT_* limit;
 * vps-agent/.env.example documents the same names with values; the lab
 * host's labs_agent role writes /etc/hcw/labs-agent.env from its
 * defaults/main.yml, whose comment calls them "the defaults from
 * vps-agent/.env.example"; and its meta/argument_specs.yml states each
 * default again. lab-image/sandbox-check.mjs reads index.js's defaults, so
 * it proves the image against whatever this test holds the host to.
 *
 * When the job memory moved from 256m to 512m on 2026-09-27 (the builder's
 * full default build is OOM-killed by `terraform validate` at 256m; see the
 * comment on the default in index.js), all four had to move by hand and
 * nothing would have said if one had not. The host runs the role's value,
 * not the agent's fallback, so a role default left behind is the limit that
 * is actually in force. None of these files can be imported here (index.js
 * starts the agent; the others are not JavaScript), so each is read from
 * its source text, and the role's env template is checked to render each
 * name from its variable.
 *
 * The stop budget is a pair as well (LAB-13, #959). On SIGTERM the agent
 * waits LABS_AGENT_SHUTDOWN_TIMEOUT_MS for the reports of the jobs it
 * interrupted, beside and after two heartbeats of
 * SHUTDOWN_HEARTBEAT_TIMEOUT_MS each, and systemd kills whatever is left at
 * the unit's TimeoutStopSec. #1178 set 210 s against 240 s, and the
 * heartbeats' 20 s each made the worst case 250 s, which nothing here
 * checked. vps-agent/lib/shutdown.js starts nothing on import, so its
 * constants are imported rather than read from text.
 *
 * The same reading holds the hardening role's job label to the agent's
 * JOB_LABEL (the last block but one): the host's nightly reboot gate filters
 * `docker ps` on it (LAB-13, #959). The last block holds the maintenance
 * hold the gate writes before its second look to the path the agent reads,
 * the agent's acknowledgement to the path the gate reads, and the gate's
 * waits to the agent's own bounds (CodeRabbit on #1191).
 * vps-agent/lib/maintenance-hold.js imports nothing but node:fs, so its
 * constants are imported too.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, SHUTDOWN_HEARTBEAT_TIMEOUT_MS } from '../vps-agent/lib/shutdown.js';
import {
  ACK_POLL_INTERVAL_MS,
  ACK_WITHIN_MS,
  DEFAULT_ACK_PATH,
  DEFAULT_HOLD_PATH,
  MAX_HOLD_MS,
} from '../vps-agent/lib/maintenance-hold.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(repo, ...p), 'utf8');

/** env name -> labs_agent role variable. */
const LIMITS = {
  LABS_AGENT_MAX_CONCURRENT: 'labs_agent_max_concurrent',
  LABS_AGENT_POLL_MS: 'labs_agent_poll_ms',
  LABS_AGENT_JOB_MEMORY: 'labs_agent_job_memory',
  LABS_AGENT_JOB_CPUS: 'labs_agent_job_cpus',
  LABS_AGENT_JOB_PIDS: 'labs_agent_job_pids',
  LABS_AGENT_JOB_NOFILE: 'labs_agent_job_nofile',
};

/** The shutdown budget's env name and role variable; its agent default is lib/shutdown.js's. */
const SHUTDOWN = ['LABS_AGENT_SHUTDOWN_TIMEOUT_MS', 'labs_agent_shutdown_timeout_ms'];

/** The maintenance hold's env name and labs_agent role variable; its agent default is lib/maintenance-hold.js's. */
const HOLD = ['LABS_AGENT_MAINTENANCE_HOLD_PATH', 'labs_agent_maintenance_hold_path'];

/** The acknowledgement's env name and labs_agent role variable; its agent default is lib/maintenance-hold.js's. */
const ACK = ['LABS_AGENT_MAINTENANCE_ACK_PATH', 'labs_agent_maintenance_ack_path'];

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/** `process.env.NAME || <default>` in index.js, quoted or not. */
function agentDefault(source, name) {
  const found = source.match(new RegExp(`process\\.env\\.${name} \\|\\| ([^),]+)`));
  expect(found, `vps-agent/index.js has no process.env.${name} || <default>`).not.toBeNull();
  return unquote(found[1]);
}

/** `NAME=value` in .env.example. */
function envExample(source, name) {
  const found = source.match(new RegExp(`^${name}=(.*)$`, 'm'));
  expect(found, `vps-agent/.env.example has no ${name}=`).not.toBeNull();
  return unquote(found[1]);
}

/** `variable: value` at the top level of a role's defaults/main.yml. */
function roleDefault(source, variable, role = 'labs_agent') {
  const found = source.match(new RegExp(`^${variable}:\\s*(.+)$`, 'm'));
  expect(found, `${role} defaults/main.yml has no ${variable}`).not.toBeNull();
  return unquote(found[1]);
}

/** The `default:` inside `variable:`'s block in a role's meta/argument_specs.yml. */
function specDefault(source, variable, role = 'labs_agent') {
  const start = source.search(new RegExp(`^\\s+${variable}:\\s*$`, 'm'));
  expect(start, `${role} argument_specs.yml has no ${variable}`).toBeGreaterThan(-1);
  const found = source.slice(start).match(/^\s+default:\s*(.+)$/m);
  expect(found, `${variable} in argument_specs.yml has no default`).not.toBeNull();
  return unquote(found[1]);
}

describe('lab job limits agree across the agent, its example env and the host role', () => {
  const index = read('vps-agent', 'index.js');
  const example = read('vps-agent', '.env.example');
  const defaults = read('lab-host', 'ansible', 'roles', 'labs_agent', 'defaults', 'main.yml');
  const specs = read('lab-host', 'ansible', 'roles', 'labs_agent', 'meta', 'argument_specs.yml');

  for (const [name, variable] of Object.entries(LIMITS)) {
    it(`${name} / ${variable}`, () => {
      const agent = agentDefault(index, name);
      expect({
        '.env.example': envExample(example, name),
        'defaults/main.yml': roleDefault(defaults, variable),
        'argument_specs.yml': specDefault(specs, variable),
      }).toEqual({
        '.env.example': agent,
        'defaults/main.yml': agent,
        'argument_specs.yml': agent,
      });
    });
  }

  it('job memory is 512m, the owner decision of 2026-09-27', () => {
    expect(agentDefault(index, 'LABS_AGENT_JOB_MEMORY')).toBe('512m');
  });
});

describe('the role writes each name into the agent env file from its own variable', () => {
  const template = read('lab-host', 'ansible', 'roles', 'labs_agent', 'templates', 'labs-agent.env.j2');

  for (const [name, variable] of [...Object.entries(LIMITS), SHUTDOWN, HOLD, ACK]) {
    it(`${name}={{ ${variable} }}`, () => {
      expect(template).toMatch(new RegExp(`^${name}=\\{\\{ ${variable} \\}\\}$`, 'm'));
    });
  }
});

describe('the stop budget fits inside the unit (LAB-13, #959)', () => {
  const example = read('vps-agent', '.env.example');
  const defaults = read('lab-host', 'ansible', 'roles', 'labs_agent', 'defaults', 'main.yml');
  const specs = read('lab-host', 'ansible', 'roles', 'labs_agent', 'meta', 'argument_specs.yml');
  const unit = read('lab-host', 'ansible', 'roles', 'labs_agent', 'templates', 'hcw-labs-agent.service.j2');
  const [name, variable] = SHUTDOWN;

  it(`${name} / ${variable}`, () => {
    const agent = String(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    expect({
      '.env.example': envExample(example, name),
      'defaults/main.yml': roleDefault(defaults, variable),
      'argument_specs.yml': specDefault(specs, variable),
    }).toEqual({
      '.env.example': agent,
      'defaults/main.yml': agent,
      'argument_specs.yml': agent,
    });
  });

  it("the shutdown budget is 5 s, the issue's own acceptance for a terminal status", () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(5000);
  });

  it('the unit takes its stop timeout from labs_agent_timeout_stop_sec and signals the agent alone', () => {
    expect(unit).toMatch(/^TimeoutStopSec=\{\{ labs_agent_timeout_stop_sec \}\}$/m);
    expect(unit).toMatch(/^KillMode=mixed$/m);
  });

  for (const [file, valueOf] of [
    ['defaults/main.yml', (v) => roleDefault(defaults, v)],
    ['argument_specs.yml', (v) => specDefault(specs, v)],
  ]) {
    it(`timeout_stop_sec * 1000 >= shutdown_ms + 2 * the shutdown heartbeat timeout, in ${file}`, () => {
      const stopSec = Number(valueOf('labs_agent_timeout_stop_sec'));
      const shutdownMs = Number(valueOf(variable));
      expect(Number.isInteger(stopSec) && stopSec > 0, `labs_agent_timeout_stop_sec is ${stopSec}`).toBe(true);
      expect(Number.isInteger(shutdownMs) && shutdownMs > 0, `${variable} is ${shutdownMs}`).toBe(true);
      expect(stopSec * 1000).toBeGreaterThanOrEqual(shutdownMs + 2 * SHUTDOWN_HEARTBEAT_TIMEOUT_MS);
    });
  }
});

/**
 * hcw-reboot-when-idle, in the hardening role, defers the 04:30 reboot while
 * `docker ps --filter label=<hardening_reboot_job_label>` lists anything
 * (LAB-13, #959). A label that drifted from the one docker-runner.js writes
 * on every job container would see no job, ever, and reboot through a
 * running one, which is the failure the gate exists to stop, and nothing on
 * the host would say so. The role's test reads the same constant when
 * vps-agent/ is in its checkout; this holds it in the suite that runs when
 * either file changes.
 */
describe('the reboot gate filters on the label the agent writes', () => {
  const runner = read('vps-agent', 'lib', 'docker-runner.js');
  const defaults = read('lab-host', 'ansible', 'roles', 'hardening', 'defaults', 'main.yml');
  const specs = read('lab-host', 'ansible', 'roles', 'hardening', 'meta', 'argument_specs.yml');

  it('hardening_reboot_job_label / JOB_LABEL', () => {
    const found = runner.match(/^export const JOB_LABEL = '([^']+)';$/m);
    expect(found, 'vps-agent/lib/docker-runner.js has no export const JOB_LABEL').not.toBeNull();
    const label = found[1];
    expect({
      'defaults/main.yml': roleDefault(defaults, 'hardening_reboot_job_label', 'hardening'),
      'argument_specs.yml': specDefault(specs, 'hardening_reboot_job_label', 'hardening'),
    }).toEqual({
      'defaults/main.yml': label,
      'argument_specs.yml': label,
    });
  });
});

/**
 * The maintenance hold (CodeRabbit on #1191). Before its second look at an
 * idle host, hcw-reboot-when-idle writes a file the agent reads before every
 * claim, and claims nothing while it holds. Three things have to agree for
 * that to close the gap between the look and the reboot: the path (a hold
 * written anywhere else is a hold the agent never sees, and the reboot goes
 * through a job started under it), the wait for the agent's acknowledgement
 * (shorter than an agent that honours the hold can take to acknowledge it,
 * and a night the agent was idle defers for nothing), and the hold's length
 * (longer than the agent's cap, and it lifts before the role thinks it
 * does). The acknowledgement's path has to agree too (written anywhere else,
 * the script never sees it and defers every night), and the poll interval
 * the bound counts on has to be the agent's. The hardening role writes the
 * hold and reads the acknowledgement, the labs_agent role passes both paths
 * to the agent, and the agent has its own defaults; all of them are held
 * here, with both roles' argument specs.
 */
describe('the maintenance hold is one path, and its waits fit the agent (LAB-13, #959)', () => {
  const example = read('vps-agent', '.env.example');
  const agentDefaults = read('lab-host', 'ansible', 'roles', 'labs_agent', 'defaults', 'main.yml');
  const agentSpecs = read('lab-host', 'ansible', 'roles', 'labs_agent', 'meta', 'argument_specs.yml');
  const hardeningDefaults = read('lab-host', 'ansible', 'roles', 'hardening', 'defaults', 'main.yml');
  const hardeningSpecs = read('lab-host', 'ansible', 'roles', 'hardening', 'meta', 'argument_specs.yml');
  const [name, variable] = HOLD;

  it(`${name} / ${variable} / hardening_reboot_hold_path`, () => {
    expect({
      '.env.example': envExample(example, name),
      'labs_agent defaults/main.yml': roleDefault(agentDefaults, variable),
      'labs_agent argument_specs.yml': specDefault(agentSpecs, variable),
      'hardening defaults/main.yml': roleDefault(hardeningDefaults, 'hardening_reboot_hold_path', 'hardening'),
      'hardening argument_specs.yml': specDefault(hardeningSpecs, 'hardening_reboot_hold_path', 'hardening'),
    }).toEqual({
      '.env.example': DEFAULT_HOLD_PATH,
      'labs_agent defaults/main.yml': DEFAULT_HOLD_PATH,
      'labs_agent argument_specs.yml': DEFAULT_HOLD_PATH,
      'hardening defaults/main.yml': DEFAULT_HOLD_PATH,
      'hardening argument_specs.yml': DEFAULT_HOLD_PATH,
    });
  });

  it(`${ACK[0]} / ${ACK[1]} / hardening_reboot_ack_path`, () => {
    expect({
      '.env.example': envExample(example, ACK[0]),
      'labs_agent defaults/main.yml': roleDefault(agentDefaults, ACK[1]),
      'labs_agent argument_specs.yml': specDefault(agentSpecs, ACK[1]),
      'hardening defaults/main.yml': roleDefault(hardeningDefaults, 'hardening_reboot_ack_path', 'hardening'),
      'hardening argument_specs.yml': specDefault(hardeningSpecs, 'hardening_reboot_ack_path', 'hardening'),
    }).toEqual({
      '.env.example': DEFAULT_ACK_PATH,
      'labs_agent defaults/main.yml': DEFAULT_ACK_PATH,
      'labs_agent argument_specs.yml': DEFAULT_ACK_PATH,
      'hardening defaults/main.yml': DEFAULT_ACK_PATH,
      'hardening argument_specs.yml': DEFAULT_ACK_PATH,
    });
  });

  it("the poll interval ACK_WITHIN_MS counts on is the agent's own default, in index.js, .env.example and the role", () => {
    const index = read('vps-agent', 'index.js');
    const poll = String(ACK_POLL_INTERVAL_MS);
    expect({
      'index.js': agentDefault(index, 'LABS_AGENT_POLL_MS'),
      '.env.example': envExample(example, 'LABS_AGENT_POLL_MS'),
      'labs_agent defaults/main.yml': roleDefault(agentDefaults, 'labs_agent_poll_ms'),
    }).toEqual({ 'index.js': poll, '.env.example': poll, 'labs_agent defaults/main.yml': poll });
  });

  for (const [file, valueOf] of [
    ['defaults/main.yml', (v) => roleDefault(hardeningDefaults, v, 'hardening')],
    ['argument_specs.yml', (v) => specDefault(hardeningSpecs, v, 'hardening')],
  ]) {
    it(`the wait covers a claim already sent and one poll tick (ACK_WITHIN_MS), in hardening ${file}`, () => {
      const settle = Number(valueOf('hardening_reboot_hold_settle_seconds'));
      expect(Number.isInteger(settle), `hardening_reboot_hold_settle_seconds is ${settle}`).toBe(true);
      expect(settle * 1000).toBeGreaterThanOrEqual(ACK_WITHIN_MS);
    });

    it(`the hold outlasts the wait and stays within the agent's cap (MAX_HOLD_MS), in hardening ${file}`, () => {
      const settle = Number(valueOf('hardening_reboot_hold_settle_seconds'));
      const hold = Number(valueOf('hardening_reboot_hold_seconds'));
      expect(Number.isInteger(hold), `hardening_reboot_hold_seconds is ${hold}`).toBe(true);
      expect(hold).toBeGreaterThan(settle);
      expect(hold * 1000).toBeLessThanOrEqual(MAX_HOLD_MS);
    });
  }
});
