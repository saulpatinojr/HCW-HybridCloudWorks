/**
 * scripts/check-swa-certificates.mjs and its two modules, lib/swa-cert-read.mjs
 * and lib/swa-cert-report.mjs: the daily read of the Static Web App's own
 * certificates for the site's two names (#1929).
 *
 * Every test here uses stand-in certificates and a stand-in TLS connection,
 * so nothing reaches the network. The real read is run by hand and by the
 * workflow (.github/workflows/check-swa-certificates.yml).
 */
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ACT_DAYS,
  DEFAULT_HOST,
  GOING_BACK_URL,
  NAMES,
  REASONS,
  RUNBOOK_URL,
  WARN_DAYS,
  altNames,
  checkAll,
  clean,
  consoleLine,
  exitCode,
  judge,
  main,
  nextSteps,
  parseArgs,
  quoted,
  readCertificate,
  readOnce,
  refusalReason,
  renderMarkdown,
  run as runChecked,
  stateLine,
} from './check-swa-certificates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SCRIPT = join(HERE, 'check-swa-certificates.mjs');
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-27T12:00:00Z');

/** A certificate as Node's getPeerCertificate describes it, ending `days` after NOW. */
function cert(name, days, extra = {}) {
  const end = new Date(NOW + days * DAY);
  return {
    subject: { CN: name },
    issuer: { O: 'DigiCert Inc', CN: 'GeoTrust TLS RSA CA G1' },
    subjectaltname: `DNS:${name}`,
    valid_from: 'Aug 23 00:00:00 2026 GMT',
    valid_to: end.toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$2 $1 $4 $3 GMT'),
    ...extra,
  };
}

const good = (name, days = 88) => ({ cert: cert(name, days) });

describe('judging one name', () => {
  it('passes a certificate Node accepted with more than 30 days left', () => {
    const r = judge('hybridcloudworks.com', good('hybridcloudworks.com'), { now: NOW });
    expect(r).toMatchObject({ status: 'ok', stage: 'ok', daysLeft: 88, reasons: [] });
    expect(r.issuer).toBe('DigiCert Inc, GeoTrust TLS RSA CA G1');
    expect(r.altNames).toEqual(['hybridcloudworks.com']);
    expect(r.notAfter.slice(0, 10)).toBe('2027-02-23');
  });

  it('needs action at exactly 30 days, and warns until 14', () => {
    const r = judge('hybridcloudworks.com', good('hybridcloudworks.com', WARN_DAYS), { now: NOW });
    expect(r).toMatchObject({ status: 'action', stage: 'warn', reasons: ['expiring'] });
    expect(judge('hybridcloudworks.com', good('hybridcloudworks.com', WARN_DAYS + 1), { now: NOW }).status).toBe('ok');
  });

  it('says the going-back step is due at 14 days or less', () => {
    expect(judge('hybridcloudworks.com', good('hybridcloudworks.com', ACT_DAYS), { now: NOW }).stage).toBe('act');
    expect(judge('hybridcloudworks.com', good('hybridcloudworks.com', ACT_DAYS + 1), { now: NOW }).stage).toBe('warn');
  });

  it('calls a certificate past its end (a clock ahead of the server\'s) expired', () => {
    expect(judge('hybridcloudworks.com', good('hybridcloudworks.com', -2), { now: NOW })).toMatchObject({ status: 'action', stage: 'act', reasons: ['expired'] });
  });

  it('honours a different warning window', () => {
    expect(judge('hybridcloudworks.com', good('hybridcloudworks.com', 88), { now: NOW, warnDays: 100 }).reasons).toEqual(['expiring']);
  });

  it.each([['expired'], ['not-yet-valid'], ['name-mismatch'], ['untrusted']])('a certificate Node refused (%s) needs action at once', (reason) => {
    expect(judge('hybridcloudworks.com', { refused: reason }, { now: NOW })).toEqual({ name: 'hybridcloudworks.com', status: 'action', stage: 'act', reasons: [reason] });
  });

  it('calls a certificate with an unreadable end date unreadable, never good', () => {
    const read = good('hybridcloudworks.com');
    read.cert.valid_to = 'whenever';
    expect(judge('hybridcloudworks.com', read, { now: NOW })).toMatchObject({ status: 'unreadable', reasons: ['bad-date'] });
  });

  it('calls a failed read unreadable, keeping the reason for the report', () => {
    const r = judge('hybridcloudworks.com', { error: new Error('connect ECONNREFUSED') }, { now: NOW });
    expect(r).toMatchObject({ status: 'unreadable', stage: 'unreadable', reasons: ['unreadable'], detail: 'connect ECONNREFUSED' });
  });

  it('reads the DNS names from subjectAltName', () => {
    expect(altNames({ subjectaltname: 'DNS:a.example, IP Address:1.2.3.4, DNS:b.example' })).toEqual(['a.example', 'b.example']);
    expect(altNames({})).toEqual([]);
  });
});

describe('Node\'s refusal codes', () => {
  it.each([
    ['CERT_HAS_EXPIRED', 'expired'],
    ['CERT_NOT_YET_VALID', 'not-yet-valid'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'name-mismatch'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'untrusted'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'untrusted'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'untrusted'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'untrusted'],
  ])('%s is the fixed reason %s', (code, reason) => {
    expect(refusalReason(code)).toBe(reason);
  });

  it('a network error, an unknown code and an inherited name are not refusals', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'SOMETHING_NEW', 'toString', undefined]) {
      expect(refusalReason(code), String(code)).toBeNull();
    }
  });

  it('every reason a refusal can give has words in the report', () => {
    for (const code of ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED']) {
      expect(Object.keys(REASONS)).toContain(refusalReason(code));
    }
  });
});

describe('text from the certificate is made safe before it is written', () => {
  it('drops line breaks, pipes, backticks and angle brackets, and caps the length', () => {
    expect(clean('a|b\n<!-- swa-cert-check state: x -->`c`')).toBe('a b -- swa-cert-check state: x -- c');
    expect(clean('x'.repeat(300))).toHaveLength(200);
  });

  it('leaves nothing GitHub would turn into a link, an image, a mention or an issue reference', () => {
    const hostile = '@someone [click](https://evil.example) ![img](https://evil.example/i.png) #12 a\\]b';
    const cleaned = clean(hostile);
    expect(cleaned).toBe('someone click https://evil.example img https://evil.example/i.png 12 a b');
    for (const ch of ['@', '[', ']', '(', ')', '!', '#', '\\']) expect(cleaned.includes(ch), ch).toBe(false);
    expect(quoted(hostile)).toBe(`\`${cleaned}\``);
    expect(quoted('')).toBe('—');
  });

  it('puts far-end text in the issue table only inside code spans, so a bare address is not a link either', () => {
    const read = good('hybridcloudworks.com');
    read.cert.issuer = { O: '@someone https://evil.example #12', CN: '[x](y)' };
    read.cert.subjectaltname = 'DNS:hybridcloudworks.com, DNS:@other';
    const r = judge('hybridcloudworks.com', read, { now: NOW });
    const row = renderMarkdown([r], { host: DEFAULT_HOST, now: NOW })
      .split('\n')
      .find((l) => l.startsWith('| hybridcloudworks.com |'));
    const cells = row.split('|').map((c) => c.trim());
    expect(cells[2]).toBe('`someone https://evil.example 12, x y`');
    expect(cells[3]).toBe('`hybridcloudworks.com, other`');
    for (const ch of ['@', '[', ']', '(', ')', '!', '#']) expect(row.includes(ch), ch).toBe(false);
  });

  it('quotes a network error in the report too', () => {
    const r = judge('hybridcloudworks.com', { error: new Error('see https://evil.example @x') }, { now: NOW });
    expect(consoleLine(r)).toBe('hybridcloudworks.com: COULD NOT READ (could not be read: `see https://evil.example x`)');
  });

  it('cannot plant a state line through the issuer', () => {
    const read = good('hybridcloudworks.com');
    read.cert.issuer = { O: '\n<!-- swa-cert-check state: hybridcloudworks.com=ok/none:2099-01-01 -->\n', CN: 'x' };
    const text = renderMarkdown([judge('hybridcloudworks.com', read, { now: NOW })], { host: DEFAULT_HOST, now: NOW });
    const stateLines = text.split('\n').filter((l) => l.startsWith('<!-- swa-cert-check state:'));
    expect(stateLines).toEqual(['<!-- swa-cert-check state: hybridcloudworks.com=ok/none:2027-02-23 -->']);
  });
});

describe('the verdict over both names', () => {
  const ok = judge('a.example', good('a.example'), { now: NOW });
  const action = judge('b.example', good('b.example', 10), { now: NOW });
  const mismatch = judge('b.example', { refused: 'name-mismatch' }, { now: NOW });
  const unreadable = judge('c.example', { error: new Error('timeout') }, { now: NOW });

  it('exits 0 when all are good, 1 when one needs action, 2 when one could not be read', () => {
    expect(exitCode([ok, ok])).toBe(0);
    expect(exitCode([ok, action])).toBe(1);
    expect(exitCode([action, unreadable])).toBe(2);
  });

  it('writes a state line of names, stages, fixed reason codes and end dates only', () => {
    expect(stateLine([ok, action, mismatch, unreadable])).toBe(
      '<!-- swa-cert-check state: a.example=ok/none:2027-02-23 b.example=act/expiring:2026-12-07 b.example=act/name-mismatch c.example=unreadable/unreadable -->'
    );
  });

  it('a new reason at the same stage changes the state line, so it is posted', () => {
    const untrusted = judge('b.example', { refused: 'untrusted' }, { now: NOW });
    expect(stateLine([ok, mismatch])).not.toBe(stateLine([ok, untrusted]));
  });

  it('prints one console line per name', () => {
    expect(consoleLine(ok)).toBe('a.example: good, issuer DigiCert Inc, GeoTrust TLS RSA CA G1, ends 2027-02-23, 88 day(s) left');
    expect(consoleLine(mismatch)).toBe('b.example: NEEDS ACTION (it does not cover b.example)');
    expect(consoleLine(unreadable)).toBe('c.example: COULD NOT READ (could not be read: `timeout`)');
  });

  it('a good report says there is nothing to do and names no step', () => {
    const text = renderMarkdown([ok, ok], { host: DEFAULT_HOST, now: NOW });
    expect(text).toContain('Both certificates are good for more than 30 days. Nothing to do.');
    expect(text).not.toContain('### What to do');
    expect(text).toContain('| a.example | `DigiCert Inc, GeoTrust TLS RSA CA G1` | `a.example` | 2027-02-23 | 88 | good |');
  });

  it('a near-expiry report names the going-back step, the variable and the runbook', () => {
    const text = renderMarkdown([ok, action], { host: DEFAULT_HOST, now: NOW });
    expect(text).toContain(`[Going back](${GOING_BACK_URL})`);
    expect(text).toContain('set `site_proxied_hosts` to `none`, wait until this check shows a new end date, then set it back');
    expect(text).toContain(RUNBOOK_URL);
    expect(text.trimEnd().split('\n').at(-1)).toBe(stateLine([ok, action]));
  });

  it('gives one step per kind of problem, in a fixed order, each once', () => {
    const untrusted = judge('d.example', { refused: 'untrusted' }, { now: NOW });
    const steps = nextSteps([unreadable, mismatch, untrusted, action, action], { host: DEFAULT_HOST }).filter((l) => l.startsWith('- **'));
    expect(steps.map((l) => l.slice(0, l.indexOf('.**') + 3))).toEqual([
      '- **Ending within 30 days, or ended.**',
      '- **Does not cover the name.**',
      '- **Not trusted, or not valid yet.**',
      '- **Could not read.**',
    ]);
  });

  it('an unreadable report says nothing was judged and how to fix the host', () => {
    const text = renderMarkdown([unreadable], { host: DEFAULT_HOST, now: NOW });
    expect(text).toContain('**Could not read.** Nothing was judged');
    expect(text).toContain('STATIC_WEB_APP_DEFAULT_HOSTNAME');
  });

  it('uses the warning window it was given, everywhere, not the default', () => {
    const wide = judge('a.example', good('a.example', 88), { now: NOW, warnDays: 100 });
    const text = renderMarkdown([wide], { host: DEFAULT_HOST, now: NOW, warnDays: 100 });
    expect(text).toContain('Action is needed at 100 days or less');
    expect(text).toContain('NEEDS ACTION: it ends in 88 day(s), within 100');
    expect(text).toContain('- **Ending within 100 days, or ended.**');
    expect(text).not.toContain('30 days');
    expect(nextSteps([ok], { host: DEFAULT_HOST, warnDays: 45 })).toEqual(['Both certificates are good for more than 45 days. Nothing to do.']);
    expect(consoleLine(wide, 100)).toContain('within 100');
  });
});

describe('reading over TLS', () => {
  /** A stand-in for tls.connect that answers with `peer`, or fails with `error`. */
  function fakeConnect({ peer, error, silent = false } = {}) {
    const calls = [];
    const connect = (options) => {
      const socket = new EventEmitter();
      calls.push({ options, socket });
      socket.destroyed = false;
      socket.destroy = () => {
        socket.destroyed = true;
      };
      socket.setTimeout = (ms, onTimeout) => {
        if (silent) setImmediate(onTimeout);
      };
      socket.getPeerCertificate = () => peer ?? {};
      if (!silent) setImmediate(() => (error ? socket.emit('error', error) : socket.emit('secureConnect')));
      return socket;
    };
    return { connect, calls };
  }
  const refusal = (code) => Object.assign(new Error(`refused: ${code}`), { code });

  it('asks the default host for the name by SNI, on 443, with Node\'s certificate checks left on', async () => {
    const { connect, calls } = fakeConnect({ peer: cert('hybridcloudworks.com', 88) });
    const got = await readOnce({ host: DEFAULT_HOST, servername: 'hybridcloudworks.com', connect });
    expect(calls[0].options).toEqual({ host: DEFAULT_HOST, port: 443, servername: 'hybridcloudworks.com', ALPNProtocols: ['http/1.1'] });
    expect(Object.hasOwn(calls[0].options, 'rejectUnauthorized')).toBe(false);
    expect(got.cert.subject.CN).toBe('hybridcloudworks.com');
    expect(calls[0].socket.destroyed).toBe(true);
  });

  it.each([
    ['CERT_HAS_EXPIRED', 'expired'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'name-mismatch'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'untrusted'],
    ['CERT_NOT_YET_VALID', 'not-yet-valid'],
  ])('a handshake refused with %s answers { refused: %s }, and is not tried again', async (code, reason) => {
    const { connect, calls } = fakeConnect({ error: refusal(code) });
    const waits = [];
    const got = await readCertificate({ host: DEFAULT_HOST, servername: 'x.example', connect, wait: async (ms) => waits.push(ms) });
    expect(got).toEqual({ refused: reason });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('rejects on a network error, an empty certificate and a timeout', async () => {
    await expect(readOnce({ host: DEFAULT_HOST, servername: 'x.example', connect: fakeConnect({ error: refusal('ECONNRESET') }).connect })).rejects.toThrow('ECONNRESET');
    await expect(readOnce({ host: DEFAULT_HOST, servername: 'x.example', connect: fakeConnect({}).connect })).rejects.toThrow('no certificate');
    await expect(readOnce({ host: DEFAULT_HOST, servername: 'x.example', timeoutMs: 1000, connect: fakeConnect({ silent: true }).connect })).rejects.toThrow('within 1 seconds');
  });

  it('tries a network error three times, pausing between, before calling it unreadable', async () => {
    const { connect, calls } = fakeConnect({ error: refusal('ECONNRESET') });
    const waits = [];
    await expect(readCertificate({ host: DEFAULT_HOST, servername: 'x.example', connect, wait: async (ms) => waits.push(ms) })).rejects.toThrow('ECONNRESET');
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([5000, 5000]);
  });

  it('stops trying once a read succeeds', async () => {
    let n = 0;
    const flaky = (options) => {
      n += 1;
      const answer = n === 1 ? { error: refusal('ECONNRESET') } : { peer: cert('x.example', 88) };
      return fakeConnect(answer).connect(options);
    };
    const got = await readCertificate({ host: DEFAULT_HOST, servername: 'x.example', connect: flaky, wait: async () => {} });
    expect(got.cert.subject.CN).toBe('x.example');
    expect(n).toBe(2);
  });

  it('checkAll reads each name and turns a thrown read into an unreadable verdict', async () => {
    const read = async ({ servername }) => {
      if (servername === 'www.hybridcloudworks.com') throw new Error('timeout');
      return good(servername);
    };
    const results = await checkAll({ host: DEFAULT_HOST, now: NOW, read });
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['hybridcloudworks.com', 'ok'],
      ['www.hybridcloudworks.com', 'unreadable'],
    ]);
  });
});

describe('arguments', () => {
  it('defaults to the two site names and the Static Web App host', () => {
    expect(parseArgs([])).toMatchObject({ host: DEFAULT_HOST, names: [...NAMES], warnDays: 30, summary: null });
  });

  it('refuses a host that is not a Static Web App default host, because it would read Cloudflare\'s certificate', () => {
    expect(() => parseArgs(['--host', 'hybridcloudworks.com'])).toThrow('--host must be a Static Web App default host ending in .azurestaticapps.net');
    expect(() => parseArgs(['--host', 'evil.example/azurestaticapps.net'])).toThrow('--host must be');
    expect(() => parseArgs(['--host', 'x.azurestaticapps.net.evil.example'])).toThrow('--host must be');
    expect(parseArgs(['--host', 'Other-App.2.azurestaticapps.net']).host).toBe('other-app.2.azurestaticapps.net');
  });

  it('takes --name more than once, replacing the defaults', () => {
    expect(parseArgs(['--name', 'a.example', '--name', 'b.example']).names).toEqual(['a.example', 'b.example']);
    expect(() => parseArgs(['--name', 'not a name'])).toThrow('is not a host name');
  });

  it('refuses an unknown flag, a missing value and a bad --warn-days', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('Unknown argument: --bogus');
    expect(() => parseArgs(['--summary'])).toThrow('--summary needs a value');
    expect(() => parseArgs(['--warn-days', '0'])).toThrow('positive integer');
  });

  it('main writes the summary with the window it was given and returns the exit code, from a stand-in read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swa-cert-check-'));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const file = join(dir, 'summary.md');
      const code = await main(['--summary', file, '--warn-days', '100'], { read: async ({ servername }) => good(servername, 88) });
      expect(code).toBe(1);
      const text = readFileSync(file, 'utf8');
      // main reads the real clock, so the day count depends on the hour; the window does not.
      expect(text).toContain('day(s), within 100');
      expect(text).toContain('Action is needed at 100 days or less');
    } finally {
      logs.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unexpected error (a summary that cannot be written) exits 2, not 1, and logs no path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swa-cert-check-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // A directory as the summary file: writeFileSync throws (EISDIR, or
      // EPERM on some Windows builds) after the certificates were judged as
      // needing action, which would otherwise surface as exit 1.
      const code = await runChecked(['--summary', dir, '--warn-days', '100'], { read: async ({ servername }) => good(servername, 88) });
      expect(code).toBe(2);
      expect(errors).toHaveBeenCalledTimes(1);
      const line = errors.mock.calls[0][0];
      expect(line).toMatch(/^check-swa-certificates stopped on an unexpected error \([A-Z]+\); nothing was judged\.$/);
      expect(line.includes(dir)).toBe(false);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an error with no code, or a code that is not a plain code, still exits 2 with no detail', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // checkAll catches a throw from the read itself, so these throw later,
    // while the answer is judged: a getter on what the read returned.
    const throwing = (error) => async () => ({
      get error() {
        throw error;
      },
    });
    try {
      expect(await runChecked([], { read: throwing(new Error('at /secret/path')) })).toBe(2);
      const weird = Object.assign(new Error('at /secret/path'), { code: 'see /secret/path' });
      expect(await runChecked([], { read: throwing(weird) })).toBe(2);
      expect(errors.mock.calls.map(([line]) => line)).toEqual([
        'check-swa-certificates stopped on an unexpected error; nothing was judged.',
        'check-swa-certificates stopped on an unexpected error; nothing was judged.',
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  it('a clean run through run() returns main\'s own exit code', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runChecked([], { read: async ({ servername }) => good(servername) })).toBe(0);
    } finally {
      logs.mockRestore();
    }
  });
});

describe('run as a program', () => {
  function runProgram(args) {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '' };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }

  it('prints usage for --help and exits 0, and exits 2 for an unknown flag or a public host, before any connection', () => {
    const help = runProgram(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: node scripts/check-swa-certificates.mjs');
    expect(runProgram(['--bogus'])).toMatchObject({ code: 2 });
    expect(runProgram(['--host', 'www.hybridcloudworks.com']).stderr).toContain('would show Cloudflare');
  });
});

describe('held to the rest of the repository', () => {
  it('uses the same default host as the frontend deploy\'s probe', () => {
    const deploy = readFileSync(join(REPO, '.github', 'workflows', 'deploy-azure-frontend.yml'), 'utf8');
    const line = deploy.split('\n').find((l) => l.trim().startsWith('DEFAULT_HOSTNAME: ${{ vars.STATIC_WEB_APP_DEFAULT_HOSTNAME ||'));
    expect(line, 'the probe\'s DEFAULT_HOSTNAME line in deploy-azure-frontend.yml').toBeDefined();
    expect(line.trim()).toBe(`DEFAULT_HOSTNAME: \${{ vars.STATIC_WEB_APP_DEFAULT_HOSTNAME || '${DEFAULT_HOST}' }}`);
  });

  it('links a "Going back" heading that the runbook really has, and the runbook links the workflow', () => {
    const runbook = readFileSync(join(REPO, 'docs', 'runbooks', 'proxy-site-hosts.md'), 'utf8');
    expect(GOING_BACK_URL.endsWith('#going-back')).toBe(true);
    expect(runbook.split(/\r?\n/)).toContain('## Going back');
    expect(runbook).toContain('actions/workflows/check-swa-certificates.yml');
  });
});
