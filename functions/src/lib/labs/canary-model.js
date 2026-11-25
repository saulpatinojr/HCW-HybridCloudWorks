/**
 * labs/canary-model.js — the lab canary's constants and its pure half
 * (canary.js has the header that explains the canary): the job it
 * enqueues, and the verdict on a job that came back. canary.js re-exports
 * what callers use.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';

export const LAB_CANARY_DOC_ID = 'lab_canary';
export const LAB_CANARY_DOC_TYPE = 'lab_canary';
/** The smoke-test capability: `cat` of the payload in the pinned alpine image (vps-agent/lib/capabilities.js). */
export const CANARY_JOB_TYPE = 'shell-echo';
/** Who the job document names as its requester: not a person. */
export const CANARY_REQUESTER = 'lab-canary';
/**
 * How long to wait for the job. The agent polls every 15 s, a shell-echo run
 * takes a few seconds, and one visitor job may be ahead of it (the host runs
 * one at a time); two and a half minutes covers that with room.
 */
export const CANARY_WAIT_MS = 150_000;
export const CANARY_POLL_MS = 5_000;
/** A claimed job older than the claim lease and this is one no agent is finishing. */
export const CANARY_ABANDON_GRACE_MS = 5 * 60_000;
/**
 * How long a run's hold on the record (`activeRun`) counts as live. A run
 * lasts the 150 s wait plus a few reads and writes; one still holding after
 * ten minutes has died.
 */
export const CANARY_RUN_HOLD_MS = 10 * 60_000;
export const WRITE_ATTEMPTS = 3;

/** Outcomes that mean nothing ran the job, as against a job that ran and failed. */
export const UNREACHED_OUTCOMES = Object.freeze(['no-agent', 'not-claimed']);

export const TERMINAL = Object.freeze(['succeeded', 'failed', 'timeout', 'cancelled']);
export const PK = { partitionKey: ADMIN_CONFIG_PARTITION };
export const isRace = (error) => error?.code === 412 || error?.code === 409 || error?.code === 404;
export const msOf = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
};
export const between = (from, to) => {
  const a = msOf(from);
  const b = msOf(to);
  return a !== null && b !== null ? Math.max(0, b - a) : null;
};
export const seconds = (ms) => Math.round(ms / 100) / 10;

/** The fixed payload: a marker and the job's own id, so the echo cannot be another job's. */
export const canaryPayload = (jobId) => `hcw-canary ${jobId}`;

/** The job document, as enqueueLabJob writes one (lib/labs.js), plus `canary: true`. */
export function canaryJob(jobId, createdAt) {
  return {
    id: jobId,
    type: CANARY_JOB_TYPE,
    payload: canaryPayload(jobId),
    payloadEncoding: 'text',
    status: 'queued',
    requestedBy: CANARY_REQUESTER,
    requestedByEmail: null,
    createdAt,
    claimedAt: null,
    finishedAt: null,
    agentId: null,
    exitCode: null,
    output: null,
    canary: true,
  };
}

/** What a finished job says about the run, with its timings. Pure. */
export function judgeJob(job, payload) {
  const timings = {
    claimMs: between(job.createdAt, job.claimedAt),
    runMs: between(job.claimedAt, job.finishedAt),
  };
  if (job.status === 'succeeded') {
    if (String(job.output ?? '').trim() === payload) {
      return { ok: true, outcome: 'succeeded', timings, reason: 'the agent ran it and echoed the payload' };
    }
    return {
      ok: false,
      outcome: 'mismatch',
      timings,
      reason: 'the agent reported success, but the output was not the payload',
    };
  }
  if (job.status === 'cancelled') {
    return { ok: false, outcome: 'cancelled', timings, reason: 'the job was cancelled before it ran' };
  }
  const exit = Number.isInteger(job.exitCode) ? ` with exit ${job.exitCode}` : '';
  return {
    ok: false,
    outcome: job.status === 'timeout' ? 'timeout' : 'failed',
    timings,
    reason: `the agent reported ${job.status}${exit}`,
  };
}
