/**
 * The claim loop (lib/poll.js): when the agent sends a claim, and when it
 * does not (LAB-13, #959; T-744).
 *
 * The case this file exists for is the host's maintenance hold, and its
 * interleaving with a claim already in flight. hcw-reboot-when-idle writes
 * the hold, waits CLAIM_SETTLE_MS, and looks again; that only closes the gap
 * CodeRabbit found on #1191 if the agent sends no claim once the hold is
 * there, and if a claim sent just before it is the only job that can still
 * start. Both are asserted here, against a fake API, a fake supervisor and
 * a fake hold, in order.
 *
 * Node's built-in test runner, like the rest of this package: no dependency.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from './poll.js';

const JOB = { id: '0f7c2b1e-9a4d-4c3e-8f21-6b5a7c8d9e01', claimId: 'claim-7d3e', type: 'shell-echo', payload: 'hello' };

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * One poller with every dependency faked. `events` is the order things
 * happened in: ['claim'], ['execute', job], ['held?']. Each claim waits for
 * the test to answer it through `answer(job)` or `fail(err)`, so a claim can
 * be held in flight while the hold changes.
 */
function harness({ maxConcurrentJobs = 1, active = 0, stopping = false } = {}) {
  const events = [];
  const pending = [];
  const state = { held: false, active, stopping };
  const api = {
    claimJob() {
      events.push(['claim']);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  const supervisor = {
    get stopping() {
      return state.stopping;
    },
    active: () => state.active,
    execute(job) {
      events.push(['execute', job]);
      state.active += 1;
      return Promise.resolve();
    },
  };
  const faults = [];
  const log = { fault: (level, what) => faults.push([level, what]) };
  const held = () => {
    events.push(['held?']);
    return state.held;
  };
  const poller = createPoller({ api, supervisor, log, maxConcurrentJobs, held });
  return {
    events,
    faults,
    state,
    poller,
    answer: (job) => pending.shift().resolve(job),
    fail: (err) => pending.shift().reject(err),
  };
}

describe('createPoller', () => {
  test('with nothing refusing, one poll sends one claim and hands its job to execute', async () => {
    const h = harness();
    const done = h.poller.poll();
    assert.equal(h.poller.inFlight(), 1);
    h.answer(JOB);
    await done;
    assert.deepEqual(h.events, [['held?'], ['claim'], ['execute', JOB]]);
    assert.equal(h.poller.inFlight(), 0);
  });

  test('the slot is reserved before the first await, so the reservation is synchronous (T-744)', () => {
    const h = harness();
    h.poller.poll();
    // No microtask has run: a poll that awaited anything before reserving
    // would still read 0 here.
    assert.equal(h.poller.inFlight(), 1);
  });

  // A poll that should be refused is started and given a tick, never
  // awaited: a poll that wrongly claims would wait on a claim nobody
  // answers, and the test would hang instead of failing.
  test('while the maintenance hold is in force, no claim is sent', async () => {
    const h = harness();
    h.state.held = true;
    h.poller.poll();
    h.poller.poll();
    await tick();
    assert.deepEqual(h.events, [['held?'], ['held?']]);
    assert.equal(h.poller.inFlight(), 0);
  });

  test('once the hold lifts, the next poll claims again', async () => {
    const h = harness();
    h.state.held = true;
    h.poller.poll();
    await tick();
    h.state.held = false;
    const done = h.poller.poll();
    h.answer(null);
    await done;
    assert.deepEqual(h.events, [['held?'], ['held?'], ['claim']]);
  });

  test('a hold that appears while a claim is in flight: that job still runs, and no claim follows it', async () => {
    // The interleaving the reboot script's settle wait is sized for: a poll
    // passed the hold check before the file existed, its claim is on the
    // wire, and the script writes the hold now.
    const h = harness({ maxConcurrentJobs: 2 });
    const first = h.poller.poll();
    assert.deepEqual(h.events, [['held?'], ['claim']]);

    h.state.held = true;
    // Polls while the hold is in force and the first claim is unanswered.
    h.poller.poll();
    h.poller.poll();
    await tick();

    // The claim already sent comes back with a job: it is not recalled (there
    // is no way to hand a claimed job back), so its container starts, and
    // the script's second look sees it and defers the reboot.
    h.answer(JOB);
    await first;
    await tick();
    assert.deepEqual(h.events, [['held?'], ['claim'], ['held?'], ['held?'], ['execute', JOB]]);
    assert.equal(h.events.filter(([e]) => e === 'claim').length, 1);
    assert.equal(h.poller.inFlight(), 0);
  });

  test('while stopping, nothing is claimed and the hold is not even read', async () => {
    const h = harness({ stopping: true });
    h.poller.poll();
    await tick();
    assert.deepEqual(h.events, []);
  });

  test('with every slot taken, nothing is claimed and the hold is not read', async () => {
    const h = harness({ active: 1 });
    h.poller.poll();
    await tick();
    assert.deepEqual(h.events, []);
  });

  test('a slow claim keeps a second poll from claiming past the limit (T-744)', async () => {
    const h = harness({ maxConcurrentJobs: 1 });
    const first = h.poller.poll();
    h.poller.poll();
    await tick();
    assert.deepEqual(h.events, [['held?'], ['claim']]);
    h.answer(null);
    await first;
    assert.equal(h.poller.inFlight(), 0);
  });

  test('a claim that fails is a warn line and gives its slot back', async () => {
    const h = harness();
    const done = h.poller.poll();
    h.fail(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    await done;
    assert.deepEqual(h.faults, [['warn', 'claim failed']]);
    assert.equal(h.poller.inFlight(), 0);
    assert.deepEqual(
      h.events.filter(([e]) => e === 'execute'),
      []
    );
  });
});
