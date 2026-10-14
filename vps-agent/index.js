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
import { runInDocker } from './lib/docker-runner.js';
import { createApiClient } from './lib/api.js';
import { readAppliedCommit } from './lib/applied-commit.js';
import { missingConfig, readApiConfig } from './lib/config.js';
import { createLogger } from './lib/log.js';

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

let activeJobs = 0;
// Claims in flight: decided on, not yet owned by executeJob. Counted separately
// from activeJobs so the concurrency guard cannot be raced by a slow claim
// (T-744).
let pendingClaims = 0;
let shuttingDown = false;

// ── Heartbeat ─────────────────────────────────────────────────────────────────

// Once shutdown begins every heartbeat says `stopping`, the interval's and a
// finishing job's included: an `idle` or `busy` one during the drain would
// reopen the public door that `stopping` closed (review of #1018).
//
// `applied` is the commit the playbook last converged this host from, read
// afresh each time (lib/applied-commit.js says why), so the site can raise a
// host that lags main (#1009). Absent when there is no valid record.
async function sendHeartbeat(status = shuttingDown ? 'stopping' : 'idle') {
  try {
    const applied = await readAppliedCommit();
    await api.heartbeat({
      status,
      activeJobs,
      hostname: os.hostname(),
      version: AGENT_VERSION,
      applied,
    });
  } catch (err) {
    // Never fatal. A heartbeat gap shows as "offline" in the Labs dashboard,
    // which is the correct thing for it to show if the API is unreachable.
    // A warning, not an error: one missed beat is weather; three are an
    // outage the health timer reports on its own.
    log.fault('warn', 'heartbeat failed', err);
  }
}

// ── Job execution ─────────────────────────────────────────────────────────────

async function executeJob(job) {
  const capability = CAPABILITIES[job.type];

  // Defence in depth. The server already restricts claims to the agent's
  // registered capabilities, but this process is the thing that would actually
  // run the command, so it refuses anything it has no allowlisted recipe for
  // rather than trusting the response.
  if (!capability) {
    log.error(`refusing a job: no local capability for type ${job.type}`);
    log.info(`refused job ${job.id} (${job.type})`);
    await api
      .completeJob({
        jobId: job.id,
        status: 'failed',
        exitCode: -1,
        output: `agent has no capability for job type ${job.type}`,
      })
      .catch((err) => log.fault('error', 'could not report a refusal', err, `job ${job.id}`));
    return;
  }

  activeJobs += 1;
  log.info(`running job ${job.id} (${job.type})`);

  try {
    // The whole claimed job goes in: its id becomes the container's
    // hcw.lab-job label and its payloadEncoding selects how the payload is
    // staged (lib/docker-runner.js).
    const result = await runInDocker(capability, job, config.limits);
    const status = result.timedOut ? 'timeout' : result.exitCode === 0 ? 'succeeded' : 'failed';

    await api.completeJob({
      jobId: job.id,
      status,
      exitCode: result.exitCode,
      output: result.output,
    });
    // A failed or timed-out job is the learner's result, not the agent's
    // fault, so it is information.
    log.info(`job ${job.id} -> ${status} (exit ${result.exitCode})`);
  } catch (err) {
    log.fault('error', 'job errored', err, `job ${job.id}`);
    // Best effort: if this also fails the job's claim lease expires server-side
    // and another agent picks it up, which is why the lease exists.
    await api
      .completeJob({
        jobId: job.id,
        status: 'failed',
        exitCode: -1,
        output: `agent error: ${err.message}`,
      })
      .catch((reportErr) => log.fault('error', 'could not report a failure', reportErr, `job ${job.id}`));
  } finally {
    activeJobs -= 1;
    sendHeartbeat();
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function poll() {
  // The slot is reserved BEFORE the await, not after (T-744). activeJobs is
  // only incremented inside executeJob, which runs after claimJob resolves —
  // and claimJob's timeout (20s) is longer than the poll interval (15s), so a
  // slow claim let a second poll pass this guard with the counter still at its
  // old value. With the documented LABS_AGENT_MAX_CONCURRENT=1 and a
  // 512 MB / 0.5 CPU budget per job, two concurrent Terraform containers is a
  // real resource-exhaustion path on a small VPS.
  //
  // pendingClaims covers exactly the window between "we decided to claim" and
  // "executeJob owns the slot", so the guard reflects work already committed
  // to rather than only work already started.
  if (shuttingDown || activeJobs + pendingClaims >= config.maxConcurrentJobs) return;

  pendingClaims += 1;
  try {
    const job = await api.claimJob();
    if (!job) return;
    executeJob(job); // intentionally not awaited — the poll interval continues
  } catch (err) {
    log.fault('warn', 'claim failed', err);
  } finally {
    // Released in every path. On the path that takes a slot, executeJob
    // reaches `activeJobs += 1` with no await in front of it, so the handoff
    // from pendingClaims to activeJobs has no gap. Its one earlier await is in
    // the "no capability for this job type" branch, which returns without
    // taking a slot — nothing to hand over there.
    pendingClaims -= 1;
  }
}

async function start() {
  log.info(`agent ${config.agentId} v${AGENT_VERSION} starting against ${config.apiBase}`);
  log.info(
    `capabilities are assigned server-side; local recipes: ${Object.keys(CAPABILITIES).join(', ')}`
  );

  await sendHeartbeat('idle');
  setInterval(() => sendHeartbeat(), config.heartbeatIntervalMs);
  setInterval(poll, config.pollIntervalMs);
  poll();
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received; finishing active jobs (${activeJobs})...`);
  await sendHeartbeat('stopping');

  const deadline = Date.now() + 60_000;
  while (activeJobs > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  await sendHeartbeat('offline');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  log.fault('error', 'fatal agent error', err);
  process.exit(1);
});
