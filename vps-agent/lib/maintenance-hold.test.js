/**
 * The lab host's maintenance hold, as the agent reads it (LAB-13, #959;
 * CodeRabbit on #1191).
 *
 * hcw-reboot-when-idle writes `<epoch seconds>\n` to the hold file before its
 * second look at an idle host, and the agent claims nothing while it holds.
 * These run the reader against a fake file system and a fake clock for each
 * thing the file can say, then once against a real file in the format the
 * script writes, and hold ACK_WITHIN_MS to the two intervals it is the sum
 * of. The acknowledgement the agent writes back (CodeRabbit's second round
 * on #1191) runs against a recording fake and once against real files.
 *
 * The fake models what makes the reader safe against the script's rename
 * (CodeQL js/file-system-race, alert 1404 on #1191): a descriptor keeps the
 * file it opened, while the path can be renamed over at any moment. It
 * counts every call, so each case can also say that the time and the
 * content came from the descriptor, not the path, and that the descriptor
 * was closed.
 *
 * Node's built-in test runner, like the rest of this package: no dependency.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACK_POLL_INTERVAL_MS,
  ACK_WITHIN_MS,
  DEFAULT_ACK_PATH,
  DEFAULT_HOLD_PATH,
  MAX_HOLD_MS,
  ackPath,
  createAcknowledger,
  createHoldGate,
  holdPath,
  readHold,
} from './maintenance-hold.js';
import { REQUEST_TIMEOUT_MS } from './api.js';

const HOLD = '/run/hcw-maintenance/reboot-hold';
const T0 = Date.UTC(2026, 9, 16, 4, 30, 0);
/** A held hold's expiry as the reader returns it: the digits, as the script wrote them. */
const E = (seconds) => String(Math.floor(T0 / 1000) + seconds);

/** An Error carrying a Node fs code, as the real calls throw. */
const fsError = (code) => Object.assign(new Error(code), { code });

/**
 * A one-path fake of the fs calls the reader may make. `file` is what is at
 * the path now and can be changed between calls: `text` is its content (an
 * Error to throw when it is read; undefined for no file), `mtimeMs` its write
 * time, and `open`, `fstat`, `stat` and `close` are Errors to throw from
 * those calls. openSync binds a descriptor to the file as it is at that
 * moment, as a real descriptor keeps its inode. `afterNextCall(fn)` runs fn
 * once, right after the next call returns or throws: a rename landing
 * between two of the reader's calls. readFileSync also accepts the path, as
 * the old reader called it, so the race case can show what that would read.
 */
function fakeFs({ text, mtimeMs = T0, open, fstat, stat, close } = {}) {
  const file = { text, mtimeMs, open, fstat, stat, close };
  const calls = { open: 0, fstat: 0, readByFd: 0, readByPath: 0, stat: 0, closed: [] };
  const fds = new Map();
  let nextFd = 3;
  let hook = null;
  /** Runs the pending hook once. */
  const after = () => {
    const run = hook;
    hook = null;
    if (run) run();
  };
  /** Wraps a call so the pending hook runs after it, however it ends. */
  const call = (fn) => {
    try {
      return fn();
    } finally {
      after();
    }
  };
  return {
    file,
    calls,
    /** Descriptors opened and not closed. */
    stillOpen: () => [...fds.keys()],
    afterNextCall: (fn) => {
      hook = fn;
    },
    openSync: (p, flags) =>
      call(() => {
        assert.equal(p, HOLD);
        assert.equal(flags, 'r');
        calls.open += 1;
        if (file.open) throw file.open;
        if (file.text === undefined) throw fsError('ENOENT');
        const fd = nextFd++;
        fds.set(fd, { text: file.text, mtimeMs: file.mtimeMs });
        return fd;
      }),
    fstatSync: (fd) =>
      call(() => {
        assert.ok(fds.has(fd), `fstat of a descriptor that is not open: ${fd}`);
        calls.fstat += 1;
        if (file.fstat) throw file.fstat;
        return { mtimeMs: fds.get(fd).mtimeMs };
      }),
    readFileSync: (target, encoding) =>
      call(() => {
        assert.equal(encoding, 'utf8');
        let content;
        if (typeof target === 'number') {
          assert.ok(fds.has(target), `read of a descriptor that is not open: ${target}`);
          calls.readByFd += 1;
          content = fds.get(target).text;
        } else {
          assert.equal(target, HOLD);
          calls.readByPath += 1;
          content = file.text === undefined ? fsError('ENOENT') : file.text;
        }
        if (content instanceof Error) throw content;
        return content;
      }),
    closeSync: (fd) =>
      call(() => {
        calls.closed.push(fd);
        assert.ok(fds.delete(fd), `close of a descriptor that is not open: ${fd}`);
        if (file.close) throw file.close;
      }),
    statSync: (p) =>
      call(() => {
        assert.equal(p, HOLD);
        calls.stat += 1;
        if (file.stat) throw file.stat;
        if (file.text === undefined) throw fsError('ENOENT');
        return { mtimeMs: file.mtimeMs };
      }),
  };
}

/** The read came from one descriptor, which was closed, and the path was never stat'ed. */
function fromOneDescriptor(fake) {
  assert.equal(fake.calls.open, 1, 'opened once');
  assert.equal(fake.calls.stat, 0, 'no stat of the path once the file is open');
  assert.equal(fake.calls.readByPath, 0, 'no read of the path');
  assert.equal(fake.calls.closed.length, 1, 'closed once');
  assert.deepEqual(fake.stillOpen(), [], 'nothing left open');
}

/** The expiry the script writes for a hold lasting `seconds` from T0. */
const expiry = (seconds) => `${Math.floor(T0 / 1000) + seconds}\n`;

describe('readHold', () => {
  test('no file is no hold, with nothing opened and the path not stat-ed', () => {
    const fake = fakeFs();
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fake }), { state: 'none' });
    assert.deepEqual(fake.calls.closed, []);
    assert.equal(fake.calls.stat, 0);
  });

  test('no directory is no hold too', () => {
    const fake = fakeFs({ text: expiry(300), open: fsError('ENOTDIR') });
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fake }), { state: 'none' });
    assert.equal(fake.calls.stat, 0);
  });

  test('an expiry in the future holds until that second, read from one descriptor', () => {
    for (const [now, want] of [
      [T0, { state: 'held', until: T0 + 300_000, expiry: E(300) }],
      [T0 + 299_999, { state: 'held', until: T0 + 300_000, expiry: E(300) }],
      [T0 + 300_000, { state: 'expired' }],
    ]) {
      const fake = fakeFs({ text: expiry(300) });
      assert.deepEqual(readHold(HOLD, { now, fsImpl: fake }), want);
      fromOneDescriptor(fake);
      assert.equal(fake.calls.fstat, 1);
      assert.equal(fake.calls.readByFd, 1);
    }
  });

  test('an expiry without its newline reads the same', () => {
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fakeFs({ text: expiry(300).trim() }) }), {
      state: 'held',
      until: T0 + 300_000,
      expiry: E(300),
    });
  });

  test('an expiry in the past is no hold: its writer died without removing it', () => {
    const fake = fakeFs({ text: expiry(-1) });
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fake }), { state: 'expired' });
    fromOneDescriptor(fake);
  });

  test("no hold outlasts MAX_HOLD_MS from its write, the descriptor's time, whatever its expiry says", () => {
    const fake = fakeFs({ text: expiry(24 * 3600) });
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fake }), { state: 'held', until: T0 + MAX_HOLD_MS, expiry: E(24 * 3600) });
    fromOneDescriptor(fake);
    assert.equal(readHold(HOLD, { now: T0 + MAX_HOLD_MS, fsImpl: fakeFs({ text: expiry(24 * 3600) }) }).state, 'expired');
  });

  test('a file that exists and cannot be opened holds until its stat time plus MAX_HOLD_MS, nothing else read', () => {
    for (const code of ['EACCES', 'EPERM']) {
      const fake = fakeFs({ text: expiry(300), open: fsError(code) });
      assert.deepEqual(readHold(HOLD, { now: T0 + 1000, fsImpl: fake }), { state: 'held-unreadable', until: T0 + MAX_HOLD_MS }, code);
      assert.equal(fake.calls.stat, 1, `${code}: its time is read by path, once`);
      assert.equal(fake.calls.readByPath + fake.calls.readByFd, 0, `${code}: no content read`);
      assert.deepEqual(fake.calls.closed, [], `${code}: nothing was opened, so nothing to close`);
      assert.equal(
        readHold(HOLD, { now: T0 + MAX_HOLD_MS, fsImpl: fakeFs({ text: expiry(300), open: fsError(code) }) }).state,
        'expired',
        code
      );
    }
  });

  test('a file that cannot be opened and whose time cannot be read either cannot be told: no hold', () => {
    const fake = fakeFs({ text: expiry(300), open: fsError('EACCES'), stat: fsError('EIO') });
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fake }), { state: 'unknown' });
  });

  test('any other failure to open cannot tell, and is no hold, without a stat', () => {
    for (const open of [fsError('EIO'), fsError('EMFILE'), fsError('EISDIR'), new Error('odd')]) {
      const fake = fakeFs({ text: expiry(300), open });
      assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fake }), { state: 'unknown' }, String(open.code));
      assert.equal(fake.calls.stat, 0, String(open.code));
    }
  });

  test('a descriptor whose time cannot be read cannot tell: no hold, and it is closed', () => {
    const fake = fakeFs({ text: expiry(300), fstat: fsError('EIO') });
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fake }), { state: 'unknown' });
    fromOneDescriptor(fake);
    assert.equal(fake.calls.readByFd, 0);
  });

  test('a descriptor that cannot be read holds by its own time, and is closed', () => {
    for (const code of ['EIO', 'EISDIR', 'EACCES']) {
      const fake = fakeFs({ text: fsError(code) });
      assert.deepEqual(readHold(HOLD, { now: T0 + 1000, fsImpl: fake }), { state: 'held-unreadable', until: T0 + MAX_HOLD_MS }, code);
      fromOneDescriptor(fake);
      assert.equal(readHold(HOLD, { now: T0 + MAX_HOLD_MS, fsImpl: fakeFs({ text: fsError(code) }) }).state, 'expired', code);
    }
  });

  test('a file that is not an expiry (empty, partly written, or a date) holds the same bounded way', () => {
    for (const text of ['', '\n', 'x1760589000\n', ' 1760589000\n', '2026-10-16T04:35Z\n', '1760589000\n\n', '1760589000.5\n', 'NaN\n']) {
      const fake = fakeFs({ text });
      const found = readHold(HOLD, { now: T0, fsImpl: fake });
      assert.equal(found.state, 'held-unreadable', JSON.stringify(text));
      assert.equal(found.until, T0 + MAX_HOLD_MS, JSON.stringify(text));
      fromOneDescriptor(fake);
    }
  });

  test('a hold renamed over between two calls still reads as one file: its own time with its own expiry', () => {
    // The old hold: written 9 minutes before T0 (its cap is T0 + 60 s), and
    // saying T0 + 30 s. The new one, renamed over it right after the
    // reader's first call: written at T0, saying T0 + 300 s. Read as one
    // file each, the answer is T0 + 30 s (the old) or T0 + 300 s (the new).
    // The old file's cap with the new file's expiry would be T0 + 60 s, a
    // hold that belongs to neither (CodeQL js/file-system-race on #1191).
    const fake = fakeFs({ text: expiry(30), mtimeMs: T0 - 9 * 60_000 });
    fake.afterNextCall(() => {
      fake.file.text = expiry(300);
      fake.file.mtimeMs = T0;
    });
    const found = readHold(HOLD, { now: T0, fsImpl: fake });
    assert.notEqual(found.until, T0 + 60_000, "one file's write time paired with the next file's expiry");
    assert.deepEqual(found, { state: 'held', until: T0 + 30_000, expiry: E(30) });
    fromOneDescriptor(fake);
  });

  test('a hold removed after it is opened is still read whole, from the descriptor', () => {
    const fake = fakeFs({ text: expiry(300) });
    fake.afterNextCall(() => {
      fake.file.text = undefined;
    });
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fake }), { state: 'held', until: T0 + 300_000, expiry: E(300) });
    fromOneDescriptor(fake);
    // The next poll sees the removal.
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fake }), { state: 'none' });
  });

  test('a descriptor that will not close does not throw, and the answer stands', () => {
    const fake = fakeFs({ text: expiry(300), close: fsError('EIO') });
    assert.deepEqual(readHold(HOLD, { now: T0, fsImpl: fake }), { state: 'held', until: T0 + 300_000, expiry: E(300) });
    assert.equal(fake.calls.closed.length, 1);
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
  /** A gate over one fake file the test changes between calls, and the lines it said. */
  function gate() {
    const fake = fakeFs();
    const lines = [];
    const log = { info: (line) => lines.push(['info', line]), warn: (line) => lines.push(['warn', line]) };
    let now = T0;
    const check = createHoldGate({ path: HOLD, log, now: () => now, fsImpl: fake });
    return { fake, file: fake.file, lines, check, held: () => check().held, at: (t) => (now = t) };
  }

  test('true while held, false otherwise, and each change said once, never per poll', () => {
    const g = gate();
    assert.equal(g.held(), false);
    assert.deepEqual(g.lines, []);

    g.file.text = expiry(300);
    assert.deepEqual(g.check(), { held: true, expiry: E(300) }, 'a held hold carries its expiry as read');
    assert.equal(g.held(), true);
    assert.deepEqual(g.lines, [['info', 'maintenance hold in force: claiming no new job until it lifts']]);

    g.file.text = undefined;
    assert.equal(g.held(), false);
    assert.equal(g.held(), false);
    assert.deepEqual(g.lines.at(-1), ['info', 'maintenance hold lifted: claiming again']);
    assert.equal(g.lines.length, 2);
    assert.deepEqual(g.fake.stillOpen(), [], 'every poll closed what it opened');
  });

  test('an unreadable hold holds and is said at warn, which is collected', () => {
    const g = gate();
    g.file.text = fsError('EIO');
    assert.deepEqual(g.check(), { held: true, expiry: null }, 'held, and with no expiry to acknowledge');
    assert.deepEqual(g.lines, [
      ['warn', 'maintenance hold present but unreadable: claiming no new job until it is ten minutes old'],
    ]);
    g.at(T0 + MAX_HOLD_MS);
    assert.equal(g.held(), false);
    assert.deepEqual(g.lines.at(-1), ['warn', 'maintenance hold expired without being removed: claiming as usual']);
  });

  test('a hold that cannot be checked does not hold, and says so at warn', () => {
    const g = gate();
    g.file.text = expiry(300);
    g.file.open = fsError('EIO');
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
    for (const step of [expiry(300), undefined, fsError('EIO'), undefined]) {
      g.file.text = step;
      g.held();
    }
    g.file.text = expiry(300);
    g.file.open = fsError('EIO');
    g.held();
    for (const [, line] of g.lines) assert.doesNotMatch(line, /\/|\d{4,}/, line);
  });
});

describe('createAcknowledger', () => {
  const ACK = '/run/hcw-labs-agent/maintenance-ack';

  /**
   * An acknowledger over a recording fake: `ops` is every call in order,
   * `files` what is on disk, `fail` the call names that throw, and `lines`
   * what it said.
   */
  function acker() {
    const ops = [];
    const files = new Map();
    const fail = {};
    const lines = [];
    /** Throws the Error set for `name`, if one is. */
    const maybeThrow = (name) => {
      if (fail[name]) throw fail[name];
    };
    const fsImpl = {
      writeFileSync(p, data, options) {
        ops.push(['write', p, data, options.mode]);
        maybeThrow('write');
        files.set(p, data);
      },
      renameSync(from, to) {
        ops.push(['rename', from, to]);
        maybeThrow('rename');
        files.set(to, files.get(from));
        files.delete(from);
      },
      unlinkSync(p) {
        ops.push(['unlink', p]);
        maybeThrow('unlink');
        if (!files.delete(p)) throw fsError('ENOENT');
      },
    };
    const log = { info: (line) => lines.push(['info', line]), warn: (line) => lines.push(['warn', line]) };
    return { ack: createAcknowledger({ path: ACK, log, fsImpl }), ops, files, fail, lines };
  }

  test("writes the hold's expiry, exactly as read, to a temporary file renamed into place", () => {
    const a = acker();
    a.ack.acknowledge(E(300));
    assert.deepEqual(a.ops, [
      ['write', `${ACK}.new`, `${E(300)}\n`, 0o644],
      ['rename', `${ACK}.new`, ACK],
    ]);
    assert.deepEqual([...a.files], [[ACK, `${E(300)}\n`]]);
    assert.equal(a.ack.current(), E(300));
    assert.deepEqual(a.lines, [['info', 'maintenance hold acknowledged: no claim in flight and no job running']]);
  });

  test('the same hold is written once; another hold is written anew', () => {
    const a = acker();
    a.ack.acknowledge(E(300));
    a.ack.acknowledge(E(300));
    assert.equal(a.ops.length, 2);
    a.ack.acknowledge(E(400));
    assert.equal(a.files.get(ACK), `${E(400)}\n`);
    assert.equal(a.ops.length, 4);
  });

  test('withdrawing removes it once, and is nothing at all when none is written', () => {
    const a = acker();
    a.ack.withdraw();
    assert.deepEqual(a.ops, []);
    a.ack.acknowledge(E(300));
    a.ack.withdraw();
    a.ack.withdraw();
    assert.deepEqual(a.ops.at(-1), ['unlink', ACK]);
    assert.equal(a.ops.filter(([op]) => op === 'unlink').length, 1);
    assert.equal(a.files.size, 0);
    assert.equal(a.ack.current(), null);
    assert.deepEqual(a.lines.at(-1), ['info', 'maintenance hold acknowledgement withdrawn']);
  });

  test('a write or rename that fails leaves no acknowledgement and no temporary file, says so once, and is tried again', () => {
    for (const step of ['write', 'rename']) {
      const a = acker();
      a.fail[step] = fsError('EACCES');
      assert.doesNotThrow(() => a.ack.acknowledge(E(300)), step);
      assert.doesNotThrow(() => a.ack.acknowledge(E(300)), step);
      assert.equal(a.ack.current(), null, step);
      assert.equal(a.files.has(ACK), false, step);
      assert.equal(a.files.has(`${ACK}.new`), false, `${step}: the temporary file is cleaned up`);
      assert.deepEqual(a.lines, [['warn', 'maintenance hold could not be acknowledged: the idle reboot will defer']], step);
      delete a.fail[step];
      a.ack.acknowledge(E(300));
      assert.equal(a.files.get(ACK), `${E(300)}\n`, `${step}: written once the fault clears`);
    }
  });

  test('a withdrawal that fails does not throw, says so once, and is tried again', () => {
    const a = acker();
    a.ack.acknowledge(E(300));
    a.fail.unlink = fsError('EACCES');
    assert.doesNotThrow(() => a.ack.withdraw());
    assert.doesNotThrow(() => a.ack.withdraw());
    assert.equal(a.ack.current(), E(300));
    assert.equal(a.lines.filter(([level]) => level === 'warn').length, 1);
    delete a.fail.unlink;
    a.ack.withdraw();
    assert.equal(a.files.size, 0);
  });

  test('no line names a path or carries a number', () => {
    const a = acker();
    a.ack.acknowledge(E(300));
    a.ack.withdraw();
    a.fail.write = fsError('EIO');
    a.ack.acknowledge(E(400));
    for (const [, line] of a.lines) assert.doesNotMatch(line, /\/|\d{4,}/, line);
  });

  test('on a real file system: the file holds the expiry and a newline, 0644, nothing left beside it, and goes on withdrawal', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ack-'));
    try {
      const file = path.join(dir, 'maintenance-ack');
      const log = { info() {}, warn() {} };
      const ack = createAcknowledger({ path: file, log });
      ack.acknowledge(E(300));
      assert.equal(readFileSync(file, 'utf8'), `${E(300)}\n`);
      assert.deepEqual(readdirSync(dir), ['maintenance-ack']);
      if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o644);
      ack.withdraw();
      assert.equal(existsSync(file), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the paths and the wait bound', () => {
  test('the path is LABS_AGENT_MAINTENANCE_HOLD_PATH when absolute, else the default', () => {
    assert.equal(holdPath({}), DEFAULT_HOLD_PATH);
    assert.equal(holdPath({ LABS_AGENT_MAINTENANCE_HOLD_PATH: '/run/x/hold' }), '/run/x/hold');
    for (const bad of ['', 'run/x/hold', './hold', undefined]) {
      assert.equal(holdPath({ LABS_AGENT_MAINTENANCE_HOLD_PATH: bad }), DEFAULT_HOLD_PATH, String(bad));
    }
  });

  test('the acknowledgement is LABS_AGENT_MAINTENANCE_ACK_PATH when absolute, else the default', () => {
    assert.equal(ackPath({}), DEFAULT_ACK_PATH);
    assert.equal(ackPath({ LABS_AGENT_MAINTENANCE_ACK_PATH: '/run/x/ack' }), '/run/x/ack');
    for (const bad of ['', 'run/x/ack', './ack', undefined]) {
      assert.equal(ackPath({ LABS_AGENT_MAINTENANCE_ACK_PATH: bad }), DEFAULT_ACK_PATH, String(bad));
    }
  });

  test("ACK_WITHIN_MS is the API client's request timeout plus one poll interval", () => {
    // The request timeout is imported, not copied: a longer claim timeout in
    // lib/api.js must lengthen the bound, or a claim could outlast it.
    assert.equal(ACK_WITHIN_MS, REQUEST_TIMEOUT_MS + ACK_POLL_INTERVAL_MS);
    assert.ok(ACK_POLL_INTERVAL_MS > 0);
  });

  test('the cap is longer than the wait, so a hold always outlives the wait it exists for', () => {
    assert.ok(MAX_HOLD_MS > ACK_WITHIN_MS);
  });
});
