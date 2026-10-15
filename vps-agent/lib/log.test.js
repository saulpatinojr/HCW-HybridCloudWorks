/**
 * The agent's log lines carry the priority journald reads (#1009), and the
 * lines that priority gets collected say nothing but what failed (#1018).
 *
 * The lab host's data collection rule takes the `daemon` facility at Warning
 * and above only, and journald gives a line with no `<N>` prefix priority 6,
 * info. So the load-bearing assertions are that an error line starts `<3>`
 * and a warning `<4>` on EVERY physical line, that info carries no prefix,
 * that index.js and lib/shutdown.js write nothing that bypasses the logger, and that no warn or
 * error line carries an identifier or an error's own text.
 *
 * Node's built-in test runner, like the rest of this package.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PRIORITY, createLogger, errorClass, formatLine } from './log.js';

const AT = new Date('2026-10-08T04:30:00.000Z');

function capture() {
  const writes = [];
  const log = createLogger({ now: () => AT, write: (stream, text) => writes.push({ stream, text }) });
  return { log, writes };
}

describe('formatLine', () => {
  it('prefixes an error with <3> and a warning with <4>, the sd-daemon priorities', () => {
    assert.deepEqual(PRIORITY, { error: 3, warn: 4, info: 6 });
    assert.equal(
      formatLine({ level: 'error', at: AT, args: ['job errored (ETIMEDOUT)'] }),
      '<3>2026-10-08T04:30:00.000Z job errored (ETIMEDOUT)\n'
    );
    assert.equal(
      formatLine({ level: 'warn', at: AT, args: ['heartbeat failed (HTTP 503)'] }),
      '<4>2026-10-08T04:30:00.000Z heartbeat failed (HTTP 503)\n'
    );
  });

  it('leaves info unprefixed, so it stays at journald\'s default and reads as it always did', () => {
    assert.equal(
      formatLine({ level: 'info', at: AT, args: ['running job j1 (terraform-validate)'] }),
      '2026-10-08T04:30:00.000Z running job j1 (terraform-validate)\n'
    );
  });

  it('prefixes every physical line, because journald reads the priority per line', () => {
    const text = formatLine({ level: 'error', at: AT, args: ['Fatal agent error:', 'first\nsecond\r\nthird'] });
    const lines = text.trimEnd().split('\n');
    assert.equal(lines.length, 3);
    for (const line of lines) assert.match(line, /^<3>/);
    assert.equal(lines[2], '<3>third');
  });

  it('formats its arguments the way console.log does', () => {
    assert.equal(formatLine({ level: 'info', at: AT, args: ['%s jobs', 2] }), '2026-10-08T04:30:00.000Z 2 jobs\n');
  });
});

describe('errorClass', () => {
  it('names a failure by its code, its HTTP status or its constructor, never by its text', () => {
    assert.equal(errorClass(Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' })), 'ETIMEDOUT');
    assert.equal(errorClass(Object.assign(new Error('agent not registered'), { status: 403 })), 'HTTP 403');
    assert.equal(errorClass(new TypeError('x is not a function')), 'TypeError');
    assert.equal(errorClass(new Error('tar payload: refusing path "../../etc/passwd"')), 'Error');
    assert.equal(errorClass('a string'), 'Error');
    assert.equal(errorClass(null), 'Error');
  });

  it('does not let a code that is really text through', () => {
    assert.equal(errorClass({ code: 'path /srv/jobs/a b', name: 'Error' }), 'Error');
  });
});

describe('createLogger', () => {
  it('writes info to stdout and warnings and errors to stderr, both of which reach the journal', () => {
    const { log, writes } = capture();
    log.info('starting');
    log.warn('claim failed (ECONNRESET)');
    log.error('could not report a failure (HTTP 503)');
    assert.deepEqual(
      writes.map(({ stream, text }) => [stream, text.slice(0, 3)]),
      [
        ['stdout', '202'],
        ['stderr', '<4>'],
        ['stderr', '<3>'],
      ]
    );
  });

  it('writes a fault as a collected line with the class only and a host line with the detail', () => {
    const { log, writes } = capture();
    const err = new Error('tar payload: refusing path "../../etc/passwd"');
    log.fault('error', 'job errored', err, 'job 3f2c');
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], { stream: 'stderr', text: '<3>2026-10-08T04:30:00.000Z job errored (Error)\n' });
    assert.equal(writes[1].stream, 'stdout');
    assert.match(writes[1].text, /^2026-10-08T04:30:00\.000Z job errored: job 3f2c: Error: tar payload: refusing path "\.\.\/\.\.\/etc\/passwd"\n/);
    // The detail line is info on every physical line, the stack included.
    for (const line of writes[1].text.trimEnd().split('\n')) assert.doesNotMatch(line, /^<\d>/);
  });

  it('writes a fault with no detail, and a thrown non-Error, without failing', () => {
    const { log, writes } = capture();
    log.fault('warn', 'heartbeat failed', 'socket hang up');
    assert.equal(writes[0].text, '<4>2026-10-08T04:30:00.000Z heartbeat failed (Error)\n');
    assert.equal(writes[1].text, '2026-10-08T04:30:00.000Z heartbeat failed: socket hang up\n');
  });
});

describe('index.js and lib/shutdown.js', () => {
  // The job loop and its lines moved to lib/shutdown.js (LAB-13, #959), so
  // the two files are held to these rules together.
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const index = strip(readFileSync(new URL('../index.js', import.meta.url), 'utf8'));
  const shutdown = strip(readFileSync(new URL('./shutdown.js', import.meta.url), 'utf8'));
  const code = `${index}\n${shutdown}`;

  it('writes nothing past the logger: no console call, no bare log()', () => {
    assert.doesNotMatch(code, /\bconsole\.\w+\(/);
    assert.doesNotMatch(code, /(?<![.\w])log\(/);
    assert.match(index, /const log = createLogger\(\)/);
  });

  it('writes the failures that need a person at error, and the transient ones at warn', () => {
    for (const what of ['job errored', 'could not report a refusal', 'could not report a failure', 'fatal agent error']) {
      assert.ok(code.includes(`log.fault('error', '${what}'`), `${what} is not a fault at error`);
    }
    for (const what of ['heartbeat failed', 'claim failed']) {
      assert.ok(code.includes(`log.fault('warn', '${what}'`), `${what} is not a fault at warn`);
    }
    assert.ok(code.includes('log.error(`Missing required configuration'));
    assert.ok(code.includes('log.error(`refusing a job: no local capability for type ${job.type}`)'));
  });

  it('puts no job id, agent id or error text on a warn or error line (content-free telemetry)', () => {
    const collected = [...code.matchAll(/log\.(?:warn|error)\(([^;]*?)\);/g)].map((m) => m[1]);
    // The missing-configuration line, the refusal, and the shutdown budget's
    // overrun. A semicolon inside a message would hide its line from this
    // match, which is why the overrun line says ", exiting".
    assert.ok(collected.length >= 3, 'expected the direct warn/error calls to be found');
    assert.ok(collected.some((args) => args.includes('shutdown budget of')), 'the overrun line was not inspected');
    for (const args of collected) {
      assert.doesNotMatch(args, /job\.id|agentId|\.message|\berr\b/, `a collected line carries content: ${args}`);
    }
  });

  it('heartbeats `stopping`, not `idle`, once shutdown has begun', () => {
    assert.match(index, /async function sendHeartbeat\(status = supervisor\.stopping \? 'stopping' : 'idle'/);
  });
});

describe('the systemd unit', () => {
  it('keeps journald reading the prefix (SyslogLevelPrefix=true), so the priority is not printed as text', () => {
    const unit = readFileSync(
      new URL('../../lab-host/ansible/roles/labs_agent/templates/hcw-labs-agent.service.j2', import.meta.url),
      'utf8'
    );
    assert.match(unit, /^SyslogLevelPrefix=true$/m);
    assert.doesNotMatch(unit, /^StandardOutput=(?!journal)/m);
    assert.doesNotMatch(unit, /^StandardError=(?!journal|inherit)/m);
  });
});
