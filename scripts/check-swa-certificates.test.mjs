/**
 * scripts/check-swa-certificates.mjs, the daily read of the Static Web App's
 * own certificates for the site's two names (#1929).
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
import { describe, expect, it } from 'vitest';
import {
  ACT_DAYS,
  DEFAULT_HOST,
  GOING_BACK_URL,
  NAMES,
  RUNBOOK_URL,
  WARN_DAYS,
  altNames,
  checkAll,
  clean,
  consoleLine,
  exitCode,
  judge,
  main,
  parseArgs,
  readCertificate,
  readOnce,
  renderMarkdown,
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
    fingerprint256: 'AA:BB',
    ...extra,
  };
}

const good = (name, days = 88) => ({ cert: cert(name, days), authorized: true, authorizationError: null });

describe('judging one certificate', () => {
  it('passes one that covers the name and has more than 30 days left', () => {
    const r = judge('hybridcloudworks.com', good('hybridcloudworks.com'), { now: NOW });
    expect(r).toMatchObject({ status: 'ok', stage: 'ok', daysLeft: 88, problems: [] });
    expect(r.issuer).toBe('DigiCert Inc, GeoTrust TLS RSA CA G1');
    expect(r.notAfter.slice(0, 10)).toBe('2027-02-23');
  });

  it('needs action at exactly 30 days, and warns until 14', () => {
    const r = judge('hybridcloudworks.com', good('hybridcloudworks.com', WARN_DAYS), { now: NOW });
    expect(r).toMatchObject({ status: 'action', stage: 'warn' });
    expect(r.problems).toEqual(['it ends in 30 day(s), within 30']);
    expect(judge('hybridcloudworks.com', good('hybridcloudworks.com', WARN_DAYS + 1), { now: NOW }).status).toBe('ok');
  });

  it('says the going-back step is due at 14 days or less', () => {
    expect(judge('hybridcloudworks.com', good('hybridcloudworks.com', ACT_DAYS), { now: NOW }).stage).toBe('act');
    expect(judge('hybridcloudworks.com', good('hybridcloudworks.com', ACT_DAYS + 1), { now: NOW }).stage).toBe('warn');
  });

  it('reports an expired one as expired', () => {
    const r = judge('hybridcloudworks.com', good('hybridcloudworks.com', -2), { now: NOW });
    expect(r).toMatchObject({ status: 'action', stage: 'act' });
    expect(r.problems).toContain('it has expired');
  });

  it('needs action, at once, for a certificate that does not cover the name (Azure\'s own default one)', () => {
    const read = {
      cert: cert('*.azurestaticapps.net', 88, { subjectaltname: 'DNS:*.azurestaticapps.net, DNS:*.7.azurestaticapps.net' }),
      authorized: false,
      authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID',
    };
    const r = judge('www.hybridcloudworks.com', read, { now: NOW });
    expect(r).toMatchObject({ status: 'action', stage: 'act' });
    expect(r.problems).toEqual(['it does not cover www.hybridcloudworks.com']);
  });

  it('accepts a wildcard that covers the name, by Node\'s own name check', () => {
    const read = { cert: cert('*.hybridcloudworks.com', 88, { subjectaltname: 'DNS:*.hybridcloudworks.com' }), authorized: true };
    expect(judge('www.hybridcloudworks.com', read, { now: NOW }).status).toBe('ok');
    expect(judge('hybridcloudworks.com', read, { now: NOW }).status).toBe('action');
  });

  it('needs action for an untrusted chain, which Full (strict) would refuse', () => {
    const read = { cert: cert('hybridcloudworks.com', 88), authorized: false, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' };
    const r = judge('hybridcloudworks.com', read, { now: NOW });
    expect(r.status).toBe('action');
    expect(r.problems).toEqual(['it is not trusted (UNABLE_TO_VERIFY_LEAF_SIGNATURE)']);
  });

  it('needs action for a certificate that is not valid yet', () => {
    const read = good('hybridcloudworks.com');
    read.cert.valid_from = 'Jan 1 00:00:00 2030 GMT';
    expect(judge('hybridcloudworks.com', read, { now: NOW }).problems).toContain('it is not valid yet');
  });

  it('calls a certificate with an unreadable end date unreadable, never good', () => {
    const read = good('hybridcloudworks.com');
    read.cert.valid_to = 'whenever';
    expect(judge('hybridcloudworks.com', read, { now: NOW }).status).toBe('unreadable');
  });

  it('calls a failed read unreadable, with the reason', () => {
    const r = judge('hybridcloudworks.com', { error: new Error('connect ECONNREFUSED') }, { now: NOW });
    expect(r).toMatchObject({ status: 'unreadable', stage: 'unreadable' });
    expect(r.problems).toEqual(['could not be read: connect ECONNREFUSED']);
  });

  it('honours a different warning window', () => {
    expect(judge('hybridcloudworks.com', good('hybridcloudworks.com', 88), { now: NOW, warnDays: 100 }).status).toBe('action');
  });

  it('reads the DNS names from subjectAltName', () => {
    expect(altNames({ subjectaltname: 'DNS:a.example, IP Address:1.2.3.4, DNS:b.example' })).toEqual(['a.example', 'b.example']);
    expect(altNames({})).toEqual([]);
  });
});

describe('text from the certificate is made safe before it is written', () => {
  it('drops line breaks, pipes, backticks and angle brackets, and caps the length', () => {
    expect(clean('a|b\n<!-- swa-cert-check state: x -->`c`')).toBe('a b !-- swa-cert-check state: x -- c');
    expect(clean('x'.repeat(300))).toHaveLength(200);
  });

  it('cannot plant a state line through the issuer', () => {
    const read = good('hybridcloudworks.com');
    read.cert.issuer = { O: '\n<!-- swa-cert-check state: hybridcloudworks.com=ok:2099-01-01 -->\n', CN: 'x' };
    const text = renderMarkdown([judge('hybridcloudworks.com', read, { now: NOW })], { host: DEFAULT_HOST, now: NOW });
    const stateLines = text.split('\n').filter((l) => l.startsWith('<!-- swa-cert-check state:'));
    expect(stateLines).toEqual(['<!-- swa-cert-check state: hybridcloudworks.com=ok:2027-02-23 -->']);
  });
});

describe('the verdict over both names', () => {
  const ok = judge('a.example', good('a.example'), { now: NOW });
  const action = judge('b.example', good('b.example', 10), { now: NOW });
  const unreadable = judge('c.example', { error: new Error('timeout') }, { now: NOW });

  it('exits 0 when all are good, 1 when one needs action, 2 when one could not be read', () => {
    expect(exitCode([ok, ok])).toBe(0);
    expect(exitCode([ok, action])).toBe(1);
    expect(exitCode([action, unreadable])).toBe(2);
  });

  it('writes a state line of names, stages and end dates only', () => {
    expect(stateLine([ok, action, unreadable])).toBe(
      '<!-- swa-cert-check state: a.example=ok:2027-02-23 b.example=act:2026-12-07 c.example=unreadable -->'
    );
  });

  it('prints one console line per name with the issuer and the days left', () => {
    expect(consoleLine(ok)).toBe('a.example: good, issuer DigiCert Inc, GeoTrust TLS RSA CA G1, ends 2027-02-23, 88 day(s) left');
    expect(consoleLine(unreadable)).toBe('c.example: COULD NOT READ (could not be read: timeout)');
  });

  it('a good report says there is nothing to do and names no step', () => {
    const text = renderMarkdown([ok, ok], { host: DEFAULT_HOST, now: NOW });
    expect(text).toContain('Nothing to do.');
    expect(text).not.toContain('### What to do');
    expect(text).toContain(`| a.example | DigiCert Inc, GeoTrust TLS RSA CA G1 | a.example | 2027-02-23 | 88 | good |`);
  });

  it('a near-expiry report names the going-back step, the variable and the runbook', () => {
    const text = renderMarkdown([ok, action], { host: DEFAULT_HOST, now: NOW });
    expect(text).toContain(`[Going back](${GOING_BACK_URL})`);
    expect(text).toContain('set `site_proxied_hosts` to `none`, wait until this check shows a new end date, then set it back');
    expect(text).toContain(RUNBOOK_URL);
    expect(text.trimEnd().split('\n').at(-1)).toBe(stateLine([ok, action]));
  });

  it('an unreadable report says nothing was judged and how to fix the host', () => {
    const text = renderMarkdown([unreadable], { host: DEFAULT_HOST, now: NOW });
    expect(text).toContain('**Could not read.** Nothing was judged');
    expect(text).toContain('STATIC_WEB_APP_DEFAULT_HOSTNAME');
  });
});

describe('reading over TLS', () => {
  /** A stand-in for tls.connect that answers with `cert`, or fails with `error`. */
  function fakeConnect({ cert: peer, error, silent = false, authorized = true } = {}) {
    const calls = [];
    const connect = (options) => {
      calls.push(options);
      const socket = new EventEmitter();
      socket.destroyed = false;
      socket.authorized = authorized;
      socket.authorizationError = authorized ? null : 'SELF_SIGNED_CERT_IN_CHAIN';
      socket.destroy = () => {
        socket.destroyed = true;
      };
      socket.setTimeout = (ms, onTimeout) => {
        if (silent) setImmediate(onTimeout);
      };
      socket.getPeerCertificate = () => peer ?? {};
      if (!silent) setImmediate(() => (error ? socket.emit('error', error) : socket.emit('secureConnect')));
      calls.at(-1).socket = socket;
      return socket;
    };
    return { connect, calls };
  }

  it('asks the default host for the name by SNI, on 443, and reads the chain without refusing it', async () => {
    const { connect, calls } = fakeConnect({ cert: cert('hybridcloudworks.com', 88) });
    const got = await readOnce({ host: DEFAULT_HOST, servername: 'hybridcloudworks.com', connect });
    expect(calls[0]).toMatchObject({ host: DEFAULT_HOST, port: 443, servername: 'hybridcloudworks.com', rejectUnauthorized: false });
    expect(got).toMatchObject({ authorized: true, cert: { subject: { CN: 'hybridcloudworks.com' } } });
    expect(calls[0].socket.destroyed).toBe(true);
  });

  it('carries an untrusted chain through as authorized: false', async () => {
    const { connect } = fakeConnect({ cert: cert('hybridcloudworks.com', 88), authorized: false });
    const got = await readOnce({ host: DEFAULT_HOST, servername: 'hybridcloudworks.com', connect });
    expect(got).toMatchObject({ authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN' });
  });

  it('rejects on a connection error, an empty certificate and a timeout', async () => {
    await expect(readOnce({ host: DEFAULT_HOST, servername: 'x.example', connect: fakeConnect({ error: new Error('ECONNRESET') }).connect })).rejects.toThrow('ECONNRESET');
    await expect(readOnce({ host: DEFAULT_HOST, servername: 'x.example', connect: fakeConnect({}).connect })).rejects.toThrow('no certificate');
    await expect(readOnce({ host: DEFAULT_HOST, servername: 'x.example', timeoutMs: 1000, connect: fakeConnect({ silent: true }).connect })).rejects.toThrow('within 1 seconds');
  });

  it('tries three times, pausing between, before calling it unreadable', async () => {
    const { connect, calls } = fakeConnect({ error: new Error('ECONNRESET') });
    const waits = [];
    await expect(readCertificate({ host: DEFAULT_HOST, servername: 'x.example', connect, wait: async (ms) => waits.push(ms) })).rejects.toThrow('ECONNRESET');
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([5000, 5000]);
  });

  it('stops trying once a read succeeds', async () => {
    let n = 0;
    const flaky = (options) => {
      n += 1;
      return n === 1 ? fakeConnect({ error: new Error('ECONNRESET') }).connect(options) : fakeConnect({ cert: cert('x.example', 88) }).connect(options);
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
    expect(() => parseArgs(['--host', 'hybridcloudworks.com'])).toThrow(/azurestaticapps\.net/);
    expect(() => parseArgs(['--host', 'evil.example/azurestaticapps.net'])).toThrow();
    expect(() => parseArgs(['--host', 'x.azurestaticapps.net.evil.example'])).toThrow();
    expect(parseArgs(['--host', 'Other-App.2.azurestaticapps.net']).host).toBe('other-app.2.azurestaticapps.net');
  });

  it('takes --name more than once, replacing the defaults', () => {
    expect(parseArgs(['--name', 'a.example', '--name', 'b.example']).names).toEqual(['a.example', 'b.example']);
    expect(() => parseArgs(['--name', 'not a name'])).toThrow();
  });

  it('refuses an unknown flag, a missing value and a bad --warn-days', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('Unknown argument: --bogus');
    expect(() => parseArgs(['--summary'])).toThrow('--summary needs a value');
    expect(() => parseArgs(['--warn-days', '0'])).toThrow('positive integer');
  });

  it('main writes the summary and returns the exit code, from a stand-in read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swa-cert-check-'));
    try {
      const file = join(dir, 'summary.md');
      const code = await main(['--summary', file, '--warn-days', '100'], { read: async ({ servername }) => good(servername, 88) });
      expect(code).toBe(1);
      expect(readFileSync(file, 'utf8')).toContain('NEEDS ACTION');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('run as a program', () => {
  function run(args) {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '' };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }

  it('prints usage for --help and exits 0, and exits 2 for an unknown flag or a public host, before any connection', () => {
    const help = run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: node scripts/check-swa-certificates.mjs');
    expect(run(['--bogus'])).toMatchObject({ code: 2 });
    expect(run(['--host', 'www.hybridcloudworks.com']).stderr).toContain('would show Cloudflare');
  });
});

describe('held to the rest of the repository', () => {
  it('uses the same default host as the frontend deploy\'s probe', () => {
    const deploy = readFileSync(join(REPO, '.github', 'workflows', 'deploy-azure-frontend.yml'), 'utf8');
    const found = /DEFAULT_HOSTNAME: \$\{\{ vars\.STATIC_WEB_APP_DEFAULT_HOSTNAME \|\| '([^']+)' \}\}/.exec(deploy);
    expect(found?.[1], 'the probe\'s default host in deploy-azure-frontend.yml').toBe(DEFAULT_HOST);
  });

  it('links a "Going back" heading that the runbook really has', () => {
    const runbook = readFileSync(join(REPO, 'docs', 'runbooks', 'proxy-site-hosts.md'), 'utf8');
    expect(GOING_BACK_URL.endsWith('#going-back')).toBe(true);
    expect(runbook).toMatch(/^## Going back$/m);
    expect(runbook, 'Part 2 step 4 links the workflow').toContain('actions/workflows/check-swa-certificates.yml');
  });
});
