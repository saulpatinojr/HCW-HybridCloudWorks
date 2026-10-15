/**
 * What happens to a running job when the host stops (LAB-13, #959).
 *
 * The acceptance is the issue's own: a terminal status for the job within
 * five seconds of the signal, written by this agent, not by the server's
 * lease fifteen minutes later. Everything here runs against a fake runner,
 * a fake API, a fake heartbeat and a fake exit, in order and on a clock, so
 * the sequence the host sees — abort, the job's report, `stopping`,
 * `offline`, exit — is asserted rather than described.
 *
 * Node's built-in test runner, like the rest of this package: no dependency.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createShutdown,
  shutdownTimeoutMs,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  SHUTDOWN_HEARTBEAT_TIMEOUT_MS,
  INTERRUPTED_OUTPUT,
} from './shutdown.js';

const CAPABILITIES = { 'shell-echo': { image: 'alpine', timeoutSeconds: 30 } };
const LIMITS = { memory: '512m', cpus: '0.5', pidsLimit: 128, nofile: 1024 };
// claimId: every report answers the claim it was handed (#1094's fence, from
// #1190), so an interrupted job's report must carry it too.
const JOB = { id: '0f7c2b1e-9a4d-4c3e-8f21-6b5a7c8d9e01', claimId: 'claim-7d3e', type: 'shell-echo', payload: 'hello' };
const BEAT = { timeoutMs: SHUTDOWN_HEARTBEAT_TIMEOUT_MS };

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ended = (overrides) => ({ exitCode: 0, output: 'ok', truncated: false, timedOut: false, aborted: false, ...overrides });

/** The real runner's shape under an abort: resolves `aborted` when the signal fires, never otherwise. */
const runUntilAborted = (capability, job, limits, { signal }) =>
  new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(ended({ exitCode: -1, output: '', aborted: true })), { once: true });
  });

/** A runner that ignores its signal and finishes on its own after `ms` with `result`. */
const runFor =
  (ms, result = ended()) =>
  () =>
    sleep(ms).then(() => result);

/** A runner that never finishes and never answers its signal. */
const runForever = () => new Promise(() => {});

/**
 * One supervisor with every dependency faked. `events` is the order things
 * happened in: ['complete', body], ['heartbeat', status, options], ['exit', code].
 * `claimsInFlight` stands in for index.js's pendingClaims.
 */
function harness({ runInDocker = runForever, env = {}, completeJob, claimsInFlight } = {}) {
  const events = [];
  const api = {
    async completeJob(body) {
      events.push(['complete', body]);
      if (completeJob) await completeJob(body);
    },
  };
  const lines = { info: [], warn: [], error: [] };
  const log = {
    lines,
    info: (...args) => lines.info.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
    fault: (level, what, err, detail) => {
      lines[level].push(what);
      lines.info.push(`${what}: ${detail ?? ''}: ${err?.message ?? err}`);
    },
  };
  const sendHeartbeat = async (status, options) => {
    events.push(['heartbeat', status, options]);
  };
  const exit = (code) => events.push(['exit', code]);
  const supervisor = createShutdown({
    api,
    log,
    sendHeartbeat,
    capabilities: CAPABILITIES,
    limits: LIMITS,
    claimsInFlight,
    runInDocker,
    exit,
    env,
  });
  return { supervisor, events, log };
}

const kinds = (events) => events.map(([kind]) => kind);

describe('a signal with a job running', () => {
  test('the job is interrupted and reported failed in visitor language, then offline, then exit, within the budget', async () => {
    const { supervisor, events } = harness({ runInDocker: runUntilAborted });
    const running = supervisor.execute(JOB);
    await tick();
    assert.equal(supervisor.active(), 1);
    assert.equal(supervisor.stopping, false);

    const started = Date.now();
    await supervisor.shutdown('SIGTERM');
    await running;
    const elapsed = Date.now() - started;

    assert.ok(elapsed < supervisor.timeoutMs, `the shutdown took ${elapsed} ms, the whole budget`);
    assert.equal(supervisor.stopping, true);
    assert.equal(supervisor.active(), 0);

    // The abort comes before any round trip, so the job's report is in
    // flight beside the `stopping` beat and lands before `offline`.
    assert.deepEqual(kinds(events), ['heartbeat', 'complete', 'heartbeat', 'exit']);
    assert.deepEqual(events[0], ['heartbeat', 'stopping', BEAT]);
    assert.deepEqual(events[1], [
      'complete',
      { jobId: JOB.id, claimId: JOB.claimId, status: 'failed', exitCode: -1, output: INTERRUPTED_OUTPUT },
    ]);
    assert.deepEqual(events[2], ['heartbeat', 'offline', BEAT]);
    assert.deepEqual(events[3], ['exit', 0]);
  });

  test('the interrupted sentence is visitor language: no vendor, tool, process or admin-side state in it', () => {
    assert.doesNotMatch(
      INTERRUPTED_OUTPUT,
      /docker|container|systemd|sigterm|agent|azure|cosmos|node|proxy|claimed|lease|vps/i
    );
    assert.match(INTERRUPTED_OUTPUT, /Submit it again/);
  });

  test('a job that finishes on its own during the drain is reported once, with its own result', async () => {
    const { supervisor, events } = harness({ runInDocker: runFor(30) });
    const running = supervisor.execute(JOB);
    await tick();

    await supervisor.shutdown('SIGTERM');
    await running;

    const completes = events.filter(([kind]) => kind === 'complete');
    assert.equal(completes.length, 1, 'the job was reported more than once');
    assert.deepEqual(completes[0][1], { jobId: JOB.id, claimId: JOB.claimId, status: 'succeeded', exitCode: 0, output: 'ok' });
    assert.ok(kinds(events).indexOf('complete') < kinds(events).indexOf('exit'), 'the agent exited before the report');
    // The finishing job sends no beat of its own while stopping: `offline`
    // is the last word.
    assert.deepEqual(
      events.filter(([kind]) => kind === 'heartbeat').map(([, status]) => status),
      ['stopping', 'offline']
    );
  });

  test('a job that never reports does not hold the agent past the budget: offline still goes, the agent exits, the overrun is an error line', async () => {
    const { supervisor, events, log } = harness({
      runInDocker: runForever,
      env: { LABS_AGENT_SHUTDOWN_TIMEOUT_MS: '40' },
    });
    supervisor.execute(JOB);
    await tick();

    const started = Date.now();
    await supervisor.shutdown('SIGTERM');
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 30 && elapsed < 2000, `elapsed ${elapsed} ms against a 40 ms budget`);
    assert.deepEqual(events, [
      ['heartbeat', 'stopping', BEAT],
      ['heartbeat', 'offline', BEAT],
      ['exit', 0],
    ]);
    assert.match(
      log.lines.error.join('\n'),
      /^shutdown budget of 40 ms exceeded with 1 job\(s\) unreported and 0 claim\(s\) unanswered, exiting$/m
    );
  });

  test('an API that refuses the report does not hold the shutdown either', async () => {
    const { supervisor, events, log } = harness({
      runInDocker: runUntilAborted,
      completeJob: async () => {
        throw Object.assign(new Error('Job is cancelled'), { status: 409 });
      },
    });
    const running = supervisor.execute(JOB);
    await tick();

    const started = Date.now();
    await supervisor.shutdown('SIGTERM');
    await running;

    assert.ok(Date.now() - started < supervisor.timeoutMs);
    assert.equal(events.at(-1)[0], 'exit');
    assert.ok(log.lines.error.includes('could not report a failure'));
    assert.doesNotMatch(log.lines.error.join('\n'), /budget/);
  });
});

describe('a signal with a claim still in flight', () => {
  test('the claim is waited for, and the job it brings back is reported interrupted without ever being started', async () => {
    let claims = 1;
    const started = [];
    const { supervisor, events } = harness({
      runInDocker: (capability, job) => {
        started.push(job.id);
        return runForever();
      },
      claimsInFlight: () => claims,
    });

    const stopping = supervisor.shutdown('SIGTERM');
    await sleep(30);
    assert.deepEqual(kinds(events), ['heartbeat'], 'the agent went offline with a claim unanswered');

    // What index.js's poll does when the claim answers: hand the job to
    // execute, then release its pending count.
    const late = supervisor.execute(JOB);
    claims = 0;
    await stopping;
    await late;

    assert.deepEqual(started, [], 'a job claimed after the signal reached the runner');
    assert.deepEqual(events, [
      ['heartbeat', 'stopping', BEAT],
      ['complete', { jobId: JOB.id, claimId: JOB.claimId, status: 'failed', exitCode: -1, output: INTERRUPTED_OUTPUT }],
      ['heartbeat', 'offline', BEAT],
      ['exit', 0],
    ]);
  });

  test('a claim that never answers holds the agent no longer than the budget, and the error line counts it', async () => {
    const { supervisor, events, log } = harness({
      claimsInFlight: () => 1,
      env: { LABS_AGENT_SHUTDOWN_TIMEOUT_MS: '40' },
    });

    const started = Date.now();
    await supervisor.shutdown('SIGTERM');
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 30 && elapsed < 2000, `elapsed ${elapsed} ms against a 40 ms budget`);
    assert.deepEqual(events, [
      ['heartbeat', 'stopping', BEAT],
      ['heartbeat', 'offline', BEAT],
      ['exit', 0],
    ]);
    assert.match(
      log.lines.error.join('\n'),
      /^shutdown budget of 40 ms exceeded with 0 job\(s\) unreported and 1 claim\(s\) unanswered, exiting$/m
    );
  });
});

describe('a signal with nothing running', () => {
  test('is the two heartbeats and the exit, and a second signal is ignored', async () => {
    const { supervisor, events } = harness();
    await Promise.all([supervisor.shutdown('SIGTERM'), supervisor.shutdown('SIGINT')]);
    await supervisor.shutdown('SIGTERM');
    assert.deepEqual(events, [
      ['heartbeat', 'stopping', BEAT],
      ['heartbeat', 'offline', BEAT],
      ['exit', 0],
    ]);
  });
});

describe('LABS_AGENT_SHUTDOWN_TIMEOUT_MS', () => {
  test('a positive whole number of milliseconds is the budget; anything else is the default', () => {
    assert.equal(DEFAULT_SHUTDOWN_TIMEOUT_MS, 5000);
    assert.equal(shutdownTimeoutMs({ LABS_AGENT_SHUTDOWN_TIMEOUT_MS: '7000' }), 7000);
    assert.equal(shutdownTimeoutMs({}), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    for (const bad of ['', 'abc', '0', '-5', '1.5', '1e999', '1e20', 'NaN', '5000ms', ' ']) {
      assert.equal(
        shutdownTimeoutMs({ LABS_AGENT_SHUTDOWN_TIMEOUT_MS: bad }),
        DEFAULT_SHUTDOWN_TIMEOUT_MS,
        `LABS_AGENT_SHUTDOWN_TIMEOUT_MS=${JSON.stringify(bad)} was used`
      );
    }
    assert.equal(harness({ env: { LABS_AGENT_SHUTDOWN_TIMEOUT_MS: 'abc' } }).supervisor.timeoutMs, 5000);
    assert.equal(harness({ env: { LABS_AGENT_SHUTDOWN_TIMEOUT_MS: '250' } }).supervisor.timeoutMs, 250);
  });
});

describe('outside a shutdown', () => {
  test('a job runs to its own result, is counted while it runs, and sends a heartbeat when it ends', async () => {
    for (const [result, status] of [
      [ended(), 'succeeded'],
      [ended({ exitCode: 2, output: 'boom' }), 'failed'],
      [ended({ exitCode: -1, timedOut: true }), 'timeout'],
    ]) {
      const { supervisor, events } = harness({ runInDocker: runFor(5, result) });
      const running = supervisor.execute(JOB);
      await tick();
      assert.equal(supervisor.active(), 1);
      await running;
      assert.equal(supervisor.active(), 0);
      assert.deepEqual(events, [
        ['complete', { jobId: JOB.id, claimId: JOB.claimId, status, exitCode: result.exitCode, output: result.output }],
        ['heartbeat', undefined, undefined],
      ]);
    }
  });

  test('a job with no local capability is refused without taking a slot', async () => {
    const { supervisor, events, log } = harness();
    await supervisor.execute({ ...JOB, type: 'rm-rf' });
    assert.equal(supervisor.active(), 0);
    assert.deepEqual(events, [
      ['complete', { jobId: JOB.id, claimId: JOB.claimId, status: 'failed', exitCode: -1, output: 'agent has no capability for job type rm-rf' }],
    ]);
    assert.match(log.lines.error.join('\n'), /no local capability for type rm-rf/);
  });
});
