/**
 * HCW Labs VPS Agent
 *
 * Pull-based job executor. No inbound ports: the agent dials out to the
 * Functions API, asks for a job it is registered to run, executes it in a
 * sandboxed Docker container (lib/docker-runner.js), and posts the result back.
 *
 * ===========================================================================
 * WHAT CHANGED FROM THE VERSION THIS REPLACES
 * ===========================================================================
 * The file that was here held a Cosmos DB **account primary key** — read/write
 * over all 71 containers — in an environment variable on a third-party VPS
 * (T-401). It also never worked: `pollJobs` was a TODO,
 * there was no heartbeat interval, no job execution, and the module used ESM
 * syntax in a package with no `"type": "module"`.
 *
 * This version holds no database credential at all. Three consequences worth
 * knowing when reading the loop below:
 *
 *  - **The server decides what this agent may run.** Capabilities come from the
 *    `lab_agents` registry document, not from configuration here. The old agent
 *    sent its own capability list and filtered client-side, which meant an
 *    agent could claim any job type it felt like.
 *  - **Claiming is one API call, not a transaction.** The atomicity that the
 *    Firestore version got from `runTransaction` now lives server-side in an
 *    ETag-guarded write. Losing the race is not an error here — the server
 *    simply hands back the next candidate, or none.
 *  - **The agent cannot invent a status.** `succeeded`, `failed` and `timeout`
 *    are the only outcomes the API accepts; `cancelled` belongs to the operator.
 *
 * Configuration is all environment; nothing is baked in. See .env.example.
 */

import os from 'node:os';
import { readFileSync } from 'node:fs';
import { CAPABILITIES } from './lib/capabilities.js';
import { createApiClient } from './lib/api.js';
import { readAppliedCommit } from './lib/applied-commit.js';
import { missingConfig, readApiConfig } from './lib/config.js';
import { createLogger } from './lib/log.js';
import { ackPath, createAcknowledger, createHoldGate, holdPath } from './lib/maintenance-hold.js';
import { createPoller } from './lib/poll.js';
import { createShutdown } from './lib/shutdown.js';

const AGENT_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
).version;

// ── Config ────────────────────────────────────────────────────────────────────

const config = {
  // The API client's settings, from lib/config.js, which
  // bin/report-coder-automation.js reads too, so the two cannot disagree
  // about which API or which agent this host is. The limits below stay here:
  // lab-image/sandbox-check.mjs and scripts/lab-job-limits.test.mjs read
  // their defaults from this file's text.
  ...readApiConfig(),
  heartbeatIntervalMs: 30 * 1000,
  pollIntervalMs: Number(process.env.LABS_AGENT_POLL_MS || 15000),
  maxConcurrentJobs: Number(process.env.LABS_AGENT_MAX_CONCURRENT || 1),
  limits: {
    // 512m, not the 256m this was until 2026-09-27 (owner decision that day).
    // The Landing Zone Builder's full default build, both landing zones
    // included, is OOM-killed by `terraform validate` at 256m: exit 247,
    // docker inspect OOMKilled true, after an offline init that succeeded,
    // because it declares sixteen provider configurations (azurerm and azapi
    // six times each) and validate starts a plugin process for each.
    // Measured on Docker 29.8 against the pinned hcw-lab-runner: 320m passes
    // but erratically, in 20 to 86 s across four runs, and 512m in 15 to
    // 19 s every time. The host runs one job at a time
    // (LABS_AGENT_MAX_CONCURRENT=1, labs_agent_max_concurrent) on a 16 GB
    // VPS, so 512m buys margin over the 320m floor for next to nothing.
    // lab-image/sandbox-check.mjs runs every job at these limits.
    memory: process.env.LABS_AGENT_JOB_MEMORY || '512m',
    cpus: process.env.LABS_AGENT_JOB_CPUS || '0.5',
    pidsLimit: Number(process.env.LABS_AGENT_JOB_PIDS || 128),
    // Open files per job container (LAB-13, #959). The swap bound is not a
    // setting either: the runner writes Docker's own rule (swap at most the
    // memory limit) into the argv, from this memory value.
    nofile: Number(process.env.LABS_AGENT_JOB_NOFILE || 1024),
  },
  // The file hcw-reboot-when-idle writes while it takes its second look at an
  // idle host; no claim is sent while it holds (LAB-13, #959).
  // LABS_AGENT_MAINTENANCE_HOLD_PATH, or the default in lib/maintenance-hold.js.
  maintenanceHoldPath: holdPath(),
  // Where the agent answers that hold once nothing is in flight or running,
  // which the script waits for before its second look.
  // LABS_AGENT_MAINTENANCE_ACK_PATH, or the default in lib/maintenance-hold.js.
  maintenanceAckPath: ackPath(),
};

// Every line goes through this, never console.*: the error and warning lines
// carry the syslog priority that gets them collected (lib/log.js, #1009), and
// what they may say is content-free, so a failure goes through log.fault.
const log = createLogger();

const missing = missingConfig(config);

if (missing.length > 0) {
  log.error(`Missing required configuration: ${missing.join(', ')}`);
  process.exit(1);
}

const api = createApiClient(config);

// ── State ─────────────────────────────────────────────────────────────────────

// The interval timers start() arms, cleared at the first signal so no beat
// of theirs can land after the shutdown's `offline`.
const timers = [];

// ── Heartbeat ─────────────────────────────────────────────────────────────────

// Once shutdown begins the default status is `stopping`: an `idle` or `busy`
// beat during the drain would reopen the public door that `stopping` closed
// (review of #1018). The shutdown itself sends its two beats explicitly, with
// a short timeout (lib/shutdown.js).
//
// `applied` is the commit the playbook last converged this host from, read
// afresh each time (lib/applied-commit.js says why), so the site can raise a
// host that lags main (#1009). Absent when there is no valid record.
async function sendHeartbeat(status = supervisor.stopping ? 'stopping' : 'idle', { timeoutMs } = {}) {
  try {
    const applied = await readAppliedCommit();
    await api.heartbeat(
      {
        status,
        activeJobs: supervisor.active(),
        hostname: os.hostname(),
        version: AGENT_VERSION,
        applied,
      },
      { timeoutMs }
    );
  } catch (err) {
    // Never fatal. A heartbeat gap shows as "offline" in the Labs dashboard,
    // which is the correct thing for it to show if the API is unreachable.
    // A warning, not an error: one missed beat is weather; three are an
    // outage the health timer reports on its own.
    log.fault('warn', 'heartbeat failed', err);
  }
}

// ── Job execution ─────────────────────────────────────────────────────────────

// Runs each claimed job in its sandbox (lib/docker-runner.js), reports the
// result, and at SIGTERM interrupts every job it still holds and reports
// each one as interrupted within LABS_AGENT_SHUTDOWN_TIMEOUT_MS, so no job
// is left `claimed` for the lease to recover (LAB-13, #959). Its own file
// says why it is a module and not this one. It reads the poller's claims in
// flight so the shutdown also waits, within the same budget, for a claim
// already sent: the job such a claim brings back is reported interrupted,
// never started. The poller is declared below; the shutdown asks only after
// a signal, by which time it exists.
const supervisor = createShutdown({
  api,
  log,
  sendHeartbeat,
  capabilities: CAPABILITIES,
  limits: config.limits,
  claimsInFlight: () => poller.inFlight(),
});

// ── Main loop ─────────────────────────────────────────────────────────────────

// One claim attempt per tick (lib/poll.js), refused while stopping, with
// every slot taken or promised (T-744), or while the host's maintenance hold
// is in force: hcw-reboot-when-idle writes it before its second look at an
// idle host, so no job starts between that look and the reboot (LAB-13,
// #959; lib/maintenance-hold.js). Under the hold, a tick with nothing in
// flight or running acknowledges it, and the script waits for that.
const poller = createPoller({
  api,
  supervisor,
  log,
  maxConcurrentJobs: config.maxConcurrentJobs,
  hold: createHoldGate({ path: config.maintenanceHoldPath, log }),
  ack: createAcknowledger({ path: config.maintenanceAckPath, log }),
});

/** Announces the agent idle, then starts the heartbeat and poll timers and polls once at once. */
async function start() {
  log.info(`agent ${config.agentId} v${AGENT_VERSION} starting against ${config.apiBase}`);
  log.info(
    `capabilities are assigned server-side; local recipes: ${Object.keys(CAPABILITIES).join(', ')}`
  );

  await sendHeartbeat('idle');
  timers.push(setInterval(() => sendHeartbeat(), config.heartbeatIntervalMs));
  timers.push(setInterval(poller.poll, config.pollIntervalMs));
  poller.poll();
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

/**
 * The signal handler. systemd delivers SIGTERM to this process alone
 * (KillMode=mixed in hcw-labs-agent.service.j2), never to the docker CLI
 * children; what happens to the jobs is the supervisor's decision, within
 * the budget the unit's TimeoutStopSec covers. The poll timer goes first, so
 * no new claim is sent once stopping has begun.
 *
 * @param {'SIGTERM'|'SIGINT'} signal
 */
function stop(signal) {
  for (const timer of timers) clearInterval(timer);
  supervisor.shutdown(signal);
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

start().catch((err) => {
  log.fault('error', 'fatal agent error', err);
  process.exit(1);
});
