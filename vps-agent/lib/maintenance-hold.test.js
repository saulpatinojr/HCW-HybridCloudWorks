/**
 * The lab host's maintenance hold, as the agent reads it (LAB-13, #959;
 * CodeRabbit on #1191).
 *
 * hcw-reboot-when-idle writes `<epoch seconds>\n` to the hold file before its
 * second look at an idle host, and the agent claims nothing while it holds.
 * These run the reader against a fake file system and a fake clock for each
 * thing the file can say, then once against a real file in the format the
 * script writes, and hold CLAIM_SETTLE_MS to the two timeouts it is the sum
 * of.
 *
 * Node's built-in test runner, like the rest of this package: no dependency.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAIM_SETTLE_MS,
  CONTAINER_START_MARGIN_MS,
  DEFAULT_HOLD_PATH,
  MAX_HOLD_MS,
  createHoldGate,
  holdPath,
  readHold,
} from './maintenance-hold.js';
import { REQUEST_TIMEOUT_MS } from './api.js';

const HOLD = '/run/hcw-maintenance/reboot-hold';
const T0 = Date.UTC(2026, 9, 16, 4, 30, 0);

/** An Error carrying a Node fs code, as the real calls throw. */
const fsError = (code) => Object.assign(new Error(code), { code });

/**
 * A one-file fake of the two fs calls the reader makes. `mtimeMs` is when
 * the file was written; `text` is its content, or an Error to throw on read;
 * `stat` is an Error to throw on stat instead.
 */
function fakeFs({ text, mtimeMs = T0, stat } = {}) {
  return {
    statSync(p) {
      assert.equal(p, HOLD);
      if (stat) throw stat;
      if (text === undefined) throw fsError('ENOENT');
      return { mtimeMs };
    },
    readFileSync(p, encoding) {
      assert.equal(p, HOLD);
      assert.equal(encoding, 'utf8');
      if (text instanceof Error) throw text;
      if (text === undefined) throw fsError('ENOENT');
      return text;
    },
  };
}

/** The expiry the script writes for a hold lasting `seconds` from T0. */
const expiry = (seconds) => `${Math.floor(T0 / 1000) + seconds}\n`;

describe('readHold', () => {
  test('no file is no hold', () => {
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fakeFs() }), { state: 'none' });
  });

  test('no directory is no hold too', () => {
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fakeFs({ stat: fsError('ENOTDIR') }) }), { state: 'none' });
  });

  test('an expiry in the future holds until that second', () => {
    const fsImpl = fakeFs({ text: expiry(300) });
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl }), { state: 'held', until: T0 + 300_000 });
    assert.equal(readHold(HOLD, { now: T0 + 299_999, fsImpl }).state, 'held');
    assert.equal(readHold(HOLD, { now: T0 + 300_000, fsImpl }).state, 'expired');
  });

  test('an expiry without its newline reads the same', () => {
    assert.equal(readHold(HOLD, { now: T0, fsImpl: fakeFs({ text: expiry(300).trim() }) }).state, 'held');
  });

  test('an expiry in the past is no hold: its writer died without removing it', () => {
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fakeFs({ text: expiry(-1) }) }), { state: 'expired' });
  });

  test('no hold outlasts MAX_HOLD_MS from its write, whatever its expiry says', () => {
    const fsImpl = fakeFs({ text: expiry(24 * 3600) });
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl }), { state: 'held', until: T0 + MAX_HOLD_MS });
    assert.equal(readHold(HOLD, { now: T0 + MAX_HOLD_MS, fsImpl }).state, 'expired');
  });

  test('a file that is there but cannot be read holds, for at most MAX_HOLD_MS from its write', () => {
    const fsImpl = fakeFs({ text: fsError('EACCES') });
    assert.deepEqual(readHold(HOLD, { now: T0 + 1000, fsImpl }), { state: 'held-unreadable', until: T0 + MAX_HOLD_MS });
    assert.equal(readHold(HOLD, { now: T0 + MAX_HOLD_MS, fsImpl }).state, 'expired');
  });

  test('a file that is not an expiry (empty, partly written, or a date) holds the same bounded way', () => {
    for (const text of ['', '\n', 'x1760589000\n', ' 1760589000\n', '2026-10-16T04:35Z\n', '1760589000\n\n', '1760589000.5\n', 'NaN\n']) {
      const found = readHold(HOLD, { now: T0, fsImpl: fakeFs({ text }) });
      assert.equal(found.state, 'held-unreadable', JSON.stringify(text));
      assert.equal(found.until, T0 + MAX_HOLD_MS, JSON.stringify(text));
    }
  });

  test('a file removed between the stat and the read is no hold', () => {
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fakeFs({ text: fsError('ENOENT') }) }), { state: 'none' });
  });

  test('a stat that fails for any other reason cannot tell, and is no hold', () => {
    for (const code of ['EACCES', 'EIO', undefined]) {
      const stat = code ? fsError(code) : new Error('odd');
      assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fakeFs({ stat }) }), { state: 'unknown' }, String(code));
    }
  });

  test('reads a real file in the exact format the script writes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hold-'));
    try {
      const file = path.join(dir, 'reboot-hold');
      const now = Date.now();
      writeFileSync(file, `${Math.floor(now / 1000) + 300}\n`);
      assert.equal(readHold(file, { now }).state, 'held');
      assert.equal(readHold(file, { now: now + 301_000 }).state, 'expired');
      rmSync(file);
      assert.equal(readHold(file, { now }).state, 'none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createHoldGate', () => {
  /** A gate over a file whose content the test changes between calls, and the lines it said. */
  function gate() {
    const file = { text: undefined, stat: undefined };
    const lines = [];
    const fsImpl = {
      statSync: (p) => fakeFs({ text: file.text, stat: file.stat }).statSync(p),
      readFileSync: (p, e) => fakeFs({ text: file.text }).readFileSync(p, e),
    };
    const log = { info: (line) => lines.push(['info', line]), warn: (line) => lines.push(['warn', line]) };
    let now = T0;
    const held = createHoldGate({ path: HOLD, log, now: () => now, fsImpl });
    return { file, lines, held, at: (t) => (now = t) };
  }

  test('true while held, false otherwise, and each change said once, never per poll', () => {
    const g = gate();
    assert.equal(g.held(), false);
    assert.deepEqual(g.lines, []);

    g.file.text = expiry(300);
    assert.equal(g.held(), true);
    assert.equal(g.held(), true);
    assert.deepEqual(g.lines, [['info', 'maintenance hold in force: claiming no new job until it lifts']]);

    g.file.text = undefined;
    assert.equal(g.held(), false);
    assert.equal(g.held(), false);
    assert.deepEqual(g.lines.at(-1), ['info', 'maintenance hold lifted: claiming again']);
    assert.equal(g.lines.length, 2);
  });

  test('an unreadable hold holds and is said at warn, which is collected', () => {
    const g = gate();
    g.file.text = fsError('EACCES');
    assert.equal(g.held(), true);
    assert.deepEqual(g.lines, [
      ['warn', 'maintenance hold present but unreadable: claiming no new job until it is ten minutes old'],
    ]);
    g.at(T0 + MAX_HOLD_MS);
    assert.equal(g.held(), false);
    assert.deepEqual(g.lines.at(-1), ['warn', 'maintenance hold expired without being removed: claiming as usual']);
  });

  test('a hold that cannot be checked does not hold, and says so at warn', () => {
    const g = gate();
    g.file.stat = fsError('EACCES');
    assert.equal(g.held(), false);
    assert.deepEqual(g.lines, [['warn', 'maintenance hold could not be checked: claiming as usual']]);
  });

  test('a stale hold found at start is said once; its removal later says nothing', () => {
    const g = gate();
    g.file.text = expiry(-60);
    assert.equal(g.held(), false);
    g.file.text = undefined;
    assert.equal(g.held(), false);
    assert.deepEqual(g.lines, [['warn', 'maintenance hold expired without being removed: claiming as usual']]);
  });

  test('no line names the path or carries any identifier', () => {
    const g = gate();
    for (const step of [expiry(300), undefined, fsError('EACCES'), undefined]) {
      g.file.text = step;
      g.held();
    }
    g.file.stat = fsError('EIO');
    g.held();
    for (const [, line] of g.lines) assert.doesNotMatch(line, /\/|\d{4,}/, line);
  });
});

describe('the hold path and the settle bound', () => {
  test('the path is LABS_AGENT_MAINTENANCE_HOLD_PATH when absolute, else the default', () => {
    assert.equal(holdPath({}), DEFAULT_HOLD_PATH);
    assert.equal(holdPath({ LABS_AGENT_MAINTENANCE_HOLD_PATH: '/run/x/hold' }), '/run/x/hold');
    for (const bad of ['', 'run/x/hold', './hold', undefined]) {
      assert.equal(holdPath({ LABS_AGENT_MAINTENANCE_HOLD_PATH: bad }), DEFAULT_HOLD_PATH, String(bad));
    }
  });

  test("CLAIM_SETTLE_MS is the API client's request timeout plus the container start margin", () => {
    // The request timeout is imported, not copied: a longer claim timeout in
    // lib/api.js must lengthen the wait, or a claim could outlast it.
    assert.equal(CLAIM_SETTLE_MS, REQUEST_TIMEOUT_MS + CONTAINER_START_MARGIN_MS);
    assert.ok(CONTAINER_START_MARGIN_MS > 0);
  });

  test('the cap is longer than the settle, so a hold always outlives the wait it exists for', () => {
    assert.ok(MAX_HOLD_MS > CLAIM_SETTLE_MS);
  });
});
