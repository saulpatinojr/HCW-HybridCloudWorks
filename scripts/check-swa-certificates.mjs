#!/usr/bin/env node
/**
 * check-swa-certificates.mjs — are the Static Web App's own certificates for
 * the site's two names still good for more than 30 days? (#1929)
 *
 * Azure Static Web Apps makes and renews a certificate for each custom name
 * (`hybridcloudworks.com` and `www.hybridcloudworks.com`). Microsoft only
 * promises the renewal while the name "resolves to the static web app over
 * public internet"
 * (https://learn.microsoft.com/azure/static-web-apps/custom-domain). Once
 * Cloudflare proxies the two names (docs/runbooks/proxy-site-hosts.md) they
 * resolve to Cloudflare instead, so the renewal is no longer promised. Under
 * SSL Full (strict) Cloudflare checks this certificate on its way to Azure,
 * and an expired one shows every visitor Cloudflare's error 526. Nothing
 * else would notice before that day, so this does.
 *
 * HOW IT READS THEM. It opens a TLS connection (the handshake that starts
 * every HTTPS request, and nothing after it) to the Static Web App's default
 * host, `<name>.azurestaticapps.net`, and asks for each site name in turn
 * (SNI, the name a client sends so the server knows which certificate to
 * show). That reaches Azure directly and gets the certificate Azure holds
 * for that name. Asking at the public name instead would reach Cloudflare
 * once the name is proxied, and show Cloudflare's own certificate, which
 * says nothing about Azure's. So `--host` must be an `azurestaticapps.net`
 * name, and anything else is refused. (Read 2026-11-27: Azure's front end
 * chooses the certificate by the name asked for, not by the host connected
 * to; a made-up `*.7.azurestaticapps.net` host showed the same certificate.
 * So this check cannot tell whether `--host` is still this app's own host;
 * it only needs it to be Azure's front end.)
 *
 * It sends no request, reads no page, and needs no credentials.
 *
 * A certificate NEEDS ACTION when any of these is true:
 *   - it ends in 30 days or less (expired included);
 *   - it does not cover the name asked for (Node's own name check,
 *     tls.checkServerIdentity, the one an HTTPS client uses);
 *   - it is not trusted (the chain does not lead to a public certificate
 *     authority Node trusts), which Full (strict) would refuse too;
 *   - it is not valid yet.
 * At 14 days or less the runbook's "Going back" step is due, and the report
 * says so.
 *
 * Exit codes, the workflow's contract:
 *   0  both certificates are good for more than 30 days;
 *   1  at least one needs action;
 *   2  at least one could not be read after three tries (no connection, a
 *      failed handshake, no certificate), or the arguments were wrong. A
 *      check that could not look has not passed.
 * A certificate that needs action and another that could not be read is 2.
 *
 * .github/workflows/check-swa-certificates.yml runs it daily and turns a
 * non-zero exit into one issue, kept current.
 *
 * Usage: node scripts/check-swa-certificates.mjs [--host <name>.azurestaticapps.net]
 *          [--name <site name>]... [--warn-days <n>] [--summary <file>]
 */
import { writeFileSync } from 'node:fs';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import { pathToFileURL } from 'node:url';

/**
 * The Static Web App's default host. The same value is the built-in default
 * of the frontend deploy's post-deploy probe (deploy-azure-frontend.yml), and
 * the test holds the two together. The STATIC_WEB_APP_DEFAULT_HOSTNAME
 * repository variable overrides both.
 */
export const DEFAULT_HOST = 'calm-ground-0d0e6a010.7.azurestaticapps.net';
export const NAMES = Object.freeze(['hybridcloudworks.com', 'www.hybridcloudworks.com']);
export const WARN_DAYS = 30;
export const ACT_DAYS = 14;
export const RUNBOOK_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/proxy-site-hosts.md';
/** The runbook section that says what to do; the test holds it to a real heading. */
export const GOING_BACK_URL = `${RUNBOOK_URL}#going-back`;
const DAY_MS = 86_400_000;
const PORT = 443;
const ATTEMPTS = 3;
const RETRY_MS = 5_000;
const TIMEOUT_MS = 15_000;

/** A Static Web App default host: one or more labels, then `.azurestaticapps.net`. */
const SWA_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+azurestaticapps\.net$/;
/** A site name to ask for: letters, digits, hyphens and dots only. */
const SITE_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A problem with the arguments: exit 2. */
export class UsageError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One TLS handshake with `host`, asking for `servername`. Resolves with the
 * server's certificate as Node describes it (getPeerCertificate) and whether
 * Node trusts it; rejects on any connection or handshake failure. The chain
 * is not refused here (`rejectUnauthorized: false`), so an untrusted or
 * mismatched certificate can still be read and reported; `authorized` and
 * `authorizationError` carry Node's verdict.
 */
export function readOnce({ host, servername, port = PORT, timeoutMs = TIMEOUT_MS, connect = tlsConnect }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host, port, servername, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`no answer within ${timeoutMs / 1000} seconds`)));
    socket.once('error', (error) => finish(error));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert || Object.keys(cert).length === 0) {
        finish(new Error('the server sent no certificate'));
        return;
      }
      finish(null, { cert, authorized: socket.authorized === true, authorizationError: socket.authorizationError ?? null });
    });
  });
}

/**
 * readOnce, tried up to `attempts` times with a pause between, so one
 * dropped connection is not reported as an unreadable certificate.
 */
export async function readCertificate({ attempts = ATTEMPTS, retryMs = RETRY_MS, wait = sleep, ...options }) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readOnce(options);
    } catch (error) {
      last = error;
      if (attempt < attempts) await wait(retryMs);
    }
  }
  throw last;
}

/**
 * Text that came from the far end, made safe for one Markdown table cell:
 * no line breaks, pipes, backticks or angle brackets, at most 200 characters.
 * The issue step compares only the state line this script writes itself, and
 * no cleaned value can start a line, so nothing the certificate says can
 * pose as that line.
 */
export function clean(value) {
  const text = String(value ?? '')
    .replace(/[\r\n\t|`<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** `{ O, CN }` from a certificate's issuer or subject, as one short line. */
function distinguished(part) {
  if (!part || typeof part !== 'object') return '';
  const pick = (v) => (Array.isArray(v) ? v.join(', ') : v);
  return [pick(part.O), pick(part.CN)].filter(Boolean).join(', ');
}

/** The DNS names in a certificate's subjectAltName, e.g. `DNS:a, DNS:b` -> ['a', 'b']. */
export function altNames(cert) {
  return String(cert?.subjectaltname ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('DNS:'))
    .map((entry) => entry.slice(4));
}

/** A certificate date (`Feb 23 23:59:59 2027 GMT`) -> ms, or null when unreadable. */
function parseCertDate(text) {
  const ms = Date.parse(String(text ?? ''));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The verdict for one name. `read` is what readCertificate resolved with,
 * or `{ error }` when it could not read. Returns
 * { name, status, stage, problems, issuer, subject, altNames, notAfter, daysLeft, fingerprint }
 * where status is 'ok', 'action' or 'unreadable', and stage (for 'action')
 * is 'act' at ACT_DAYS or less, 'warn' otherwise.
 */
export function judge(name, read, { now = Date.now(), warnDays = WARN_DAYS, actDays = ACT_DAYS } = {}) {
  if (read.error) {
    return { name, status: 'unreadable', stage: 'unreadable', problems: [`could not be read: ${clean(read.error.message ?? read.error)}`] };
  }
  const { cert, authorized, authorizationError } = read;
  const notAfter = parseCertDate(cert.valid_to);
  const notBefore = parseCertDate(cert.valid_from);
  const base = {
    name,
    issuer: clean(distinguished(cert.issuer)),
    subject: clean(distinguished(cert.subject)),
    altNames: altNames(cert).map(clean),
    notAfter: notAfter === null ? null : new Date(notAfter).toISOString(),
    fingerprint: clean(cert.fingerprint256),
  };
  if (notAfter === null) {
    return { ...base, status: 'unreadable', stage: 'unreadable', daysLeft: null, problems: [`its end date "${clean(cert.valid_to)}" could not be read`] };
  }

  const left = notAfter - now;
  const daysLeft = Math.floor(left / DAY_MS);
  const problems = [];
  if (left <= 0) problems.push('it has expired');
  else if (left <= warnDays * DAY_MS) problems.push(`it ends in ${daysLeft} day(s), within ${warnDays}`);
  if (notBefore !== null && notBefore > now) problems.push('it is not valid yet');
  const identity = checkServerIdentity(name, cert);
  if (identity) problems.push(`it does not cover ${name}`);
  // Node puts a name mismatch in authorizationError too; that is reported
  // once, above, by name. Anything else is the chain.
  if (!authorized && !(identity && authorizationError === 'ERR_TLS_CERT_ALTNAME_INVALID')) {
    problems.push(`it is not trusted (${clean(authorizationError ?? 'no reason given')})`);
  }

  if (problems.length === 0) return { ...base, status: 'ok', stage: 'ok', daysLeft, problems };
  return { ...base, status: 'action', stage: left <= actDays * DAY_MS || identity ? 'act' : 'warn', daysLeft, problems };
}

/** Reads and judges every name. `read` is injectable for tests. */
export async function checkAll({ host, names = NAMES, now, warnDays, read = readCertificate }) {
  const results = [];
  for (const name of names) {
    let got;
    try {
      got = await read({ host, servername: name });
    } catch (error) {
      got = { error };
    }
    results.push(judge(name, got, { now: now ?? Date.now(), warnDays }));
  }
  return results;
}

/** 0, 1 or 2, by the rule in the header. */
export function exitCode(results) {
  if (results.some((r) => r.status === 'unreadable')) return 2;
  if (results.some((r) => r.status === 'action')) return 1;
  return 0;
}

/**
 * The hidden last line of the report: each name with its stage and end date.
 * The workflow posts a new comment on the open issue only when this line
 * differs from the last one it posted, so a daily run does not repeat the
 * same news, but a new stage (30 days to 14), a renewal or a new problem is
 * posted. Only this script's own words go in it, never text the certificate
 * carries.
 */
export function stateLine(results) {
  const parts = results.map((r) => `${r.name}=${r.stage}${r.notAfter ? `:${r.notAfter.slice(0, 10)}` : ''}`);
  return `<!-- swa-cert-check state: ${parts.join(' ')} -->`;
}

const VERDICT = { ok: 'good', action: 'NEEDS ACTION', unreadable: 'COULD NOT READ' };

/** One line for the console per name. */
export function consoleLine(r) {
  if (r.status === 'unreadable') return `${r.name}: COULD NOT READ (${r.problems.join('; ')})`;
  const tail = r.problems.length ? ` (${r.problems.join('; ')})` : '';
  return `${r.name}: ${VERDICT[r.status]}, issuer ${r.issuer || 'unknown'}, ends ${r.notAfter.slice(0, 10)}, ${r.daysLeft} day(s) left${tail}`;
}

/** What to do, in the owner's words, for the results in hand. */
function nextSteps(results, host) {
  const bad = results.filter((r) => r.status !== 'ok');
  if (bad.length === 0) {
    return [`Both certificates are good for more than ${WARN_DAYS} days. Nothing to do.`];
  }
  const lines = ['### What to do', ''];
  if (bad.some((r) => r.status === 'action' && r.problems.some((p) => p.startsWith('it ends') || p === 'it has expired'))) {
    lines.push(
      `- **Ending soon.** Azure renews these certificates by itself while the names point straight at it. If the names are proxied by Cloudflare (\`site_proxied_hosts\` is \`www\` or \`both\` in the [hcw-azure workspace variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables)), Azure may not renew them. At ${ACT_DAYS} days or less, follow [Going back](${GOING_BACK_URL}) in the runbook: set \`site_proxied_hosts\` to \`none\`, wait until this check shows a new end date, then set it back. Each change is one checked Terraform run, as the runbook describes. If the names are not proxied, Azure should renew on its own; check both names are **Ready** with the runbook's \`az staticwebapp hostname list\` line (Part 3, step 1, check 5).`
    );
  }
  if (bad.some((r) => r.problems.some((p) => p.startsWith('it does not cover')))) {
    lines.push(
      '- **Does not cover the name.** Azure answered with a certificate for another name, which usually means the custom name is no longer bound to the Static Web App. Check both names are **Ready** with the runbook\'s `az staticwebapp hostname list` line (Part 3, step 1, check 5). Under Full (strict) Cloudflare refuses such a certificate with error 526.'
    );
  }
  if (bad.some((r) => r.problems.some((p) => p.startsWith('it is not trusted') || p === 'it is not valid yet'))) {
    lines.push('- **Not trusted or not valid yet.** Cloudflare\'s Full (strict) would refuse it too (error 526). Read the issuer above and give the run to a session.');
  }
  if (bad.some((r) => r.status === 'unreadable')) {
    lines.push(
      `- **Could not read.** Nothing was judged for that name. A one-off network failure clears on the next daily run. If it repeats, check that \`${host}\` is still the Static Web App's default host (Azure portal, the app's Overview page, URL); if it changed, set the \`STATIC_WEB_APP_DEFAULT_HOSTNAME\` repository variable to the new one.`
    );
  }
  lines.push('', `Runbook: [Proxying the site's own names through Cloudflare](${RUNBOOK_URL}), Part 2 step 4 and "Going back".`);
  return lines;
}

/** The Markdown the workflow writes to the job summary and the issue. */
export function renderMarkdown(results, { host, now = Date.now() } = {}) {
  const rows = results.map((r) =>
    r.status === 'unreadable' && !r.notAfter
      ? `| ${r.name} | — | — | — | — | ${VERDICT[r.status]}: ${r.problems.join('; ')} |`
      : `| ${r.name} | ${r.issuer || '—'} | ${r.altNames.join(', ') || r.subject || '—'} | ${r.notAfter ? r.notAfter.slice(0, 10) : '—'} | ${r.daysLeft ?? '—'} | ${VERDICT[r.status]}${r.problems.length ? `: ${r.problems.join('; ')}` : ''} |`
  );
  return [
    '## Static Web App certificates',
    '',
    `Read ${new Date(now).toISOString().slice(0, 16)}Z from \`${host}\` (Azure directly, not through Cloudflare), asking for each name. Action is needed at ${WARN_DAYS} days or less; the runbook's going-back step is due at ${ACT_DAYS}.`,
    '',
    '| Name | Issuer | Names it covers | Ends (UTC) | Days left | Verdict |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...nextSteps(results, host),
    '',
    stateLine(results),
    '',
  ].join('\n');
}

function usage() {
  return [
    'Usage: node scripts/check-swa-certificates.mjs [--host <name>.azurestaticapps.net]',
    '         [--name <site name>]... [--warn-days <n>] [--summary <file>]',
    '',
    `Reads the certificate the Static Web App (default ${DEFAULT_HOST}) shows for`,
    `each name (default ${NAMES.join(' and ')}) with a TLS handshake, nothing more.`,
    `Exit 0 when each is good for more than --warn-days (default ${WARN_DAYS}) days, 1 when`,
    'one needs action, 2 when one could not be read or the arguments are wrong.',
  ].join('\n');
}

function positiveInteger(text) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new UsageError('--warn-days must be a positive integer');
  return n;
}

function swaHost(text) {
  const host = text.toLowerCase();
  if (!SWA_HOST.test(host)) {
    throw new UsageError(`--host must be a Static Web App default host ending in .azurestaticapps.net, not "${clean(text)}": a public name would show Cloudflare's certificate, not Azure's`);
  }
  return host;
}

function siteName(text) {
  const name = text.toLowerCase();
  if (!SITE_NAME.test(name)) throw new UsageError(`--name "${clean(text)}" is not a host name`);
  return name;
}

const FLAGS = {
  '--host': (o, v) => ({ ...o, host: swaHost(v) }),
  '--name': (o, v) => ({ ...o, names: [...(o.names ?? []), siteName(v)] }),
  '--warn-days': (o, v) => ({ ...o, warnDays: positiveInteger(v) }),
  '--summary': (o, v) => ({ ...o, summary: v }),
};

const HELP_FLAGS = new Set(['--help', '-h']);

export function parseArgs(argv) {
  let options = { host: DEFAULT_HOST, names: null, warnDays: WARN_DAYS, summary: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (HELP_FLAGS.has(flag)) {
      options.help = true;
      continue;
    }
    const set = FLAGS[flag];
    if (!set) throw new UsageError(`Unknown argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    options = set(options, value);
    i += 1;
  }
  return { ...options, names: options.names ?? [...NAMES] };
}

export async function main(argv, { read } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n${usage()}`);
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const now = Date.now();
  const results = await checkAll({ host: options.host, names: options.names, now, warnDays: options.warnDays, read });
  for (const r of results) console.log(consoleLine(r));
  if (options.summary) writeFileSync(options.summary, renderMarkdown(results, { host: options.host, now }));
  return exitCode(results);
}

// pathToFileURL rather than a hand-built file:// string: a Windows path does
// not round-trip through the latter (entrypoint-guards.test.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
