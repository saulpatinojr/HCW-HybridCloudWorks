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
 * Node's normal certificate checks stay on (lib/swa-cert-read.mjs), the same
 * checks Cloudflare's Full (strict) makes, so a refused certificate is
 * refused for the reason a visitor would meet. It sends no request, reads no
 * page, and needs no credentials.
 *
 * A certificate NEEDS ACTION (exit 1) when any of these is true:
 *   - it ends in 30 days or less (`expiring`), or has ended (`expired`);
 *   - it does not cover the name asked for (`name-mismatch`);
 *   - its chain does not lead to a certificate authority Node trusts
 *     (`untrusted`);
 *   - it is not valid yet (`not-yet-valid`).
 * It COULD NOT BE READ (exit 2) when no handshake could be made after three
 * tries (`unreadable`), or its end date makes no sense (`bad-date`). A check
 * that could not look has not passed. One of each is exit 2.
 * At 14 days or less the runbook's "Going back" step is due, and the report
 * says so. The words in brackets are the fixed reason codes in the state
 * line (lib/swa-cert-report.mjs).
 *
 * Exit 0: both certificates are good for more than 30 days. Exit 2 too for
 * wrong arguments, or an error the script did not expect.
 *
 * .github/workflows/check-swa-certificates.yml runs it daily and turns a
 * non-zero exit into one issue, kept current.
 *
 * Usage: node scripts/check-swa-certificates.mjs [--host <name>.azurestaticapps.net]
 *          [--name <site name>]... [--warn-days <n>] [--summary <file>]
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readCertificate } from './lib/swa-cert-read.mjs';
import { ACT_DAYS, WARN_DAYS, clean, consoleLine, renderMarkdown } from './lib/swa-cert-report.mjs';

export { readCertificate, readOnce, refusalReason } from './lib/swa-cert-read.mjs';
export {
  ACT_DAYS,
  GOING_BACK_URL,
  REASONS,
  RUNBOOK_URL,
  WARN_DAYS,
  clean,
  consoleLine,
  nextSteps,
  problems,
  quoted,
  renderMarkdown,
  stateLine,
} from './lib/swa-cert-report.mjs';

/**
 * The Static Web App's default host. The same value is the built-in default
 * of the frontend deploy's post-deploy probe (deploy-azure-frontend.yml), and
 * the test holds the two together. The STATIC_WEB_APP_DEFAULT_HOSTNAME
 * repository variable overrides both.
 */
export const DEFAULT_HOST = 'calm-ground-0d0e6a010.7.azurestaticapps.net';
export const NAMES = Object.freeze(['hybridcloudworks.com', 'www.hybridcloudworks.com']);
const DAY_MS = 86_400_000;

/** A Static Web App default host: one or more labels, then `.azurestaticapps.net`. */
const SWA_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+azurestaticapps\.net$/;
/** A site name to ask for: letters, digits, hyphens and dots only. */
const SITE_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A problem with the arguments: exit 2. */
export class UsageError extends Error {}

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

/** The verdict for a certificate Node accepted: only its end date is left to judge. */
function judgeAccepted(name, cert, { now, warnDays, actDays }) {
  const notAfter = parseCertDate(cert.valid_to);
  const base = {
    name,
    issuer: clean(distinguished(cert.issuer)),
    subject: clean(distinguished(cert.subject)),
    altNames: altNames(cert).map(clean),
    notAfter: notAfter === null ? null : new Date(notAfter).toISOString(),
  };
  if (notAfter === null) return { ...base, status: 'unreadable', stage: 'unreadable', daysLeft: null, reasons: ['bad-date'] };
  const left = notAfter - now;
  const daysLeft = Math.floor(left / DAY_MS);
  if (left > warnDays * DAY_MS) return { ...base, status: 'ok', stage: 'ok', daysLeft, reasons: [] };
  const reasons = [left <= 0 ? 'expired' : 'expiring'];
  return { ...base, status: 'action', stage: left <= actDays * DAY_MS ? 'act' : 'warn', daysLeft, reasons };
}

/**
 * The verdict for one name. `read` is what readCertificate resolved with
 * ({ cert } or { refused: reason }), or `{ error }` when it could not read.
 * Returns { name, status, stage, reasons, ... } where status is 'ok',
 * 'action' or 'unreadable', stage is 'ok', 'warn', 'act' or 'unreadable',
 * and reasons are fixed codes (lib/swa-cert-report.mjs, REASONS).
 */
export function judge(name, read, { now = Date.now(), warnDays = WARN_DAYS, actDays = ACT_DAYS } = {}) {
  if (read.error) {
    return { name, status: 'unreadable', stage: 'unreadable', reasons: ['unreadable'], detail: read.error.message ?? String(read.error) };
  }
  if (read.refused) return { name, status: 'action', stage: 'act', reasons: [read.refused] };
  return judgeAccepted(name, read.cert, { now, warnDays, actDays });
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

/** The value after a flag, refused when it is missing or another flag. */
function valueAfter(argv, i) {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${argv[i]} needs a value`);
  return value;
}

export function parseArgs(argv) {
  let options = { host: DEFAULT_HOST, names: null, warnDays: WARN_DAYS, summary: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (HELP_FLAGS.has(argv[i])) {
      options.help = true;
      continue;
    }
    const set = FLAGS[argv[i]];
    if (!set) throw new UsageError(`Unknown argument: ${argv[i]}`);
    options = set(options, valueAfter(argv, i));
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

  const { host, names, warnDays, summary } = options;
  const now = Date.now();
  const results = await checkAll({ host, names, now, warnDays, read });
  for (const r of results) console.log(consoleLine(r, warnDays));
  if (summary) writeFileSync(summary, renderMarkdown(results, { host, now, warnDays }));
  return exitCode(results);
}

/**
 * main, with any error it did not expect (a summary file that cannot be
 * written, say) turned into exit 2, "could not check", never the 1 that
 * means a certificate needs action. The line it logs names no path or value:
 * only the error's own code when Node gives one (EISDIR, EACCES).
 */
export async function run(argv, deps) {
  try {
    return await main(argv, deps);
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? ` (${error.code})` : '';
    console.error(`check-swa-certificates stopped on an unexpected error${code}; nothing was judged.`);
    return 2;
  }
}

// pathToFileURL rather than a hand-built file:// string: a Windows path does
// not round-trip through the latter (entrypoint-guards.test.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
