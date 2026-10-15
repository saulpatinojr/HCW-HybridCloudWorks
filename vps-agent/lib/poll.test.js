/**
 * The claim loop (lib/poll.js): when the agent sends a claim, and when it
 * does not, and when it acknowledges the host's maintenance hold (LAB-13,
 * #959; T-744).
 *
 * hcw-reboot-when-idle writes the hold, waits for the agent's
 * acknowledgement, and looks again. That only closes the gap CodeRabbit
 * found on #1191 if the agent sends no claim once the hold is there, and
 * acknowledges it only while no claim is in flight and no job is running:
 * then no job can start, or be starting, between the second look and the
 * reboot. Both are asserted here, against a fake API, a fake supervisor, a
 * fake hold and a recording acknowledger, in order, including a claim that
 * was already in flight when the hold appeared.
 *
 * Node's built-in test runner, like the rest of this package: no dependency.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from './poll.js';

const JOB = { id: '0f7c2b1e-9a4d-4c3e-8f21-6b5a7c8d9e01', claimId: 'claim-7d3e', type: 'shell-echo', payload: 'hello' };
const EXPIRY = '1792125300';

/** Resolves after every promise already settled has run its callbacks. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * One poller with every dependency faked. `events` is the order things
 * happened in: ['hold?'], ['claim'], ['execute', job]. `acks` is what the
 * acknowledger was asked: ['ack', expiry] or ['withdraw']. Each claim waits
 * for the test to answer it through `answer(job)` or `fail(err)`, so a
 * claim can be held in flight while the hold changes. `state.held` puts a
 * hold in force, with `state.expiry` as its expiry (null for one whose
 * content cannot be read).
 */
function harness({ maxConcurrentJobs = 1, active = 0, stopping = false } = {}) {
  const events = [];
  const acks = [];
  const pending = [];
  const state = { held: false, expiry: EXPIRY, active, stopping };
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
  const hold = () => {
    events.push(['hold?']);
    return { held: state.held, expiry: state.held ? state.expiry : null };
  };
  const ack = {
    acknowledge: (expiry) => acks.push(['ack', expiry]),
    withdraw: () => acks.push(['withdraw']),
  };
  const poller = createPoller({ api, supervisor, log, maxConcurrentJobs, hold, ack });
  return {
    events,
    acks,
    faults,
    state,
    poller,
    answer: (job) => pending.shift().resolve(job),
    fail: (err) => pending.shift().reject(err),
  };
}

/** Only the acknowledgements written, not the withdrawals. */
const written = (acks) => acks.filter(([op]) => op === 'ack');

describe('createPoller: claims', () => {
  test('with nothing refusing, one poll sends one claim and hands its job to execute', async () => {
    const h = harness();
    const done = h.poller.poll();
    assert.equal(h.poller.inFlight(), 1);
    h.answer(JOB);
    await done;
    assert.deepEqual(h.events, [['hold?'], ['claim'], ['execute', JOB]]);
    assert.equal(h.poller.inFlight(), 0);
  });

  test('the slot is reserved before the first await, so the reservation is synchronous (T-744)', () => {
    const h = harness();
    h.poller.poll();
    // No microtask has run: a poll that awaited anything before reserving,
    // the hold's read or the acknowledgement's withdrawal included, would
    // still read 0 here.
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
    assert.deepEqual(h.events, [['hold?'], ['hold?']]);
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
    assert.deepEqual(h.events, [['hold?'], ['hold?'], ['claim']]);
  });

  test('while stopping, nothing is claimed, the hold is not read, and any acknowledgement is withdrawn', async () => {
    const h = harness({ stopping: true });
    h.poller.poll();
    await tick();
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.acks, [['withdraw']]);
  });

  test('with every slot taken, nothing is claimed', async () => {
    const h = harness({ active: 1 });
    h.poller.poll();
    await tick();
    assert.deepEqual(h.events, [['hold?']]);
  });

  test('a slow claim keeps a second poll from claiming past the limit (T-744)', async () => {
    const h = harness({ maxConcurrentJobs: 1 });
    const first = h.poller.poll();
    h.poller.poll();
    await tick();
    assert.deepEqual(h.events, [['hold?'], ['claim'], ['hold?']]);
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

describe('createPoller: the acknowledgement', () => {
  test('under a hold, with no claim in flight and no job running, the tick acknowledges it with its expiry', async () => {
    const h = harness();
    h.state.held = true;
    h.poller.poll();
    await tick();
    assert.deepEqual(h.acks, [['ack', EXPIRY]]);
    assert.deepEqual(h.events, [['hold?']], 'and claims nothing');
  });

  test('the acknowledgement is written in the tick itself, before any await', () => {
    const h = harness();
    h.state.held = true;
    h.poller.poll();
    assert.deepEqual(h.acks, [['ack', EXPIRY]]);
  });

  test('without a hold nothing is ever acknowledged', async () => {
    const h = harness();
    const done = h.poller.poll();
    h.answer(null);
    await done;
    h.poller.poll();
    h.answer(JOB);
    await tick();
    assert.deepEqual(written(h.acks), []);
  });

  test('under a hold with a job running, it is withdrawn, not written; once the job ends, it is written', async () => {
    const h = harness({ active: 1 });
    h.state.held = true;
    h.poller.poll();
    await tick();
    assert.deepEqual(h.acks, [['withdraw']]);
    h.state.active = 0;
    h.poller.poll();
    await tick();
    assert.deepEqual(h.acks, [['withdraw'], ['ack', EXPIRY]]);
  });

  test('a hold that appears while a claim is in flight: no acknowledgement until the claim has come back with nothing', async () => {
    const h = harness();
    const first = h.poller.poll();
    h.state.held = true;
    h.poller.poll();
    await tick();
    assert.deepEqual(written(h.acks), [], 'not while the claim is in flight');
    h.answer(null);
    await first;
    h.poller.poll();
    await tick();
    assert.deepEqual(written(h.acks), [['ack', EXPIRY]]);
    assert.equal(h.events.filter(([e]) => e === 'claim').length, 1);
  });

  test('a claim in flight that brings a job back: it runs, and there is no acknowledgement while it does', async () => {
    // The claim already sent is not recalled (there is no way to hand a
    // claimed job back): its job runs, and the reboot script, with no
    // acknowledgement, defers the night.
    const h = harness({ maxConcurrentJobs: 2 });
    const first = h.poller.poll();
    h.state.held = true;
    h.poller.poll();
    h.poller.poll();
    await tick();
    h.answer(JOB);
    await first;
    await tick();
    h.poller.poll();
    await tick();
    assert.deepEqual(written(h.acks), []);
    assert.deepEqual(h.events, [['hold?'], ['claim'], ['hold?'], ['hold?'], ['execute', JOB], ['hold?']]);
    assert.equal(h.events.filter(([e]) => e === 'claim').length, 1);
  });

  test('a hold whose expiry cannot be read is not acknowledged, and is withdrawn instead', async () => {
    const h = harness();
    h.state.held = true;
    h.state.expiry = null;
    h.poller.poll();
    await tick();
    assert.deepEqual(h.acks, [['withdraw']]);
  });

  test('when the hold lifts, the acknowledgement is withdrawn before the next claim', async () => {
    const h = harness();
    h.state.held = true;
    h.poller.poll();
    await tick();
    h.state.held = false;
    const done = h.poller.poll();
    assert.deepEqual(h.acks, [['ack', EXPIRY], ['withdraw']]);
    assert.deepEqual(h.events.at(-1), ['claim']);
    h.answer(null);
    await done;
  });
});
