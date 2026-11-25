/** The DNS audit's command line: its usage text and flags (cloudflare-dns-audit.mjs). */
import { AuditReadError, DEFAULT_WINDOW_HOURS, ENV, ZONE_NAME } from './dns-audit-settings.mjs';

export function usage() {
  return [
    'Usage: node scripts/cloudflare-dns-audit.mjs [--since <RFC3339|YYYY-MM-DD>] [--before <RFC3339|YYYY-MM-DD>]',
    '         [--hours <n>] [--report <file>]',
    '',
    `Reads the Cloudflare account audit log for the window (default: the last ${DEFAULT_WINDOW_HOURS} hours),`,
    `keeps the DNS-record changes on ${ZONE_NAME}, and judges each against the allowlist at the top`,
    'of the script. Exit 0 when every change is expected or there is none, 2 when one is not,',
    '1 when the log could not be read.',
    '',
    `Environment: ${ENV.token} (secret), ${ENV.accountId}; optional ${ENV.zoneId},`,
    `${ENV.ownerEmail}, ${ENV.caddyHostIp}, ${ENV.caddyTokenName}, ${ENV.tfcToken} (secret; without it`,
    'the hcp-terraform entry is inactive).',
  ].join('\n');
}

const FLAGS = {
  '--since': (o, v) => ({ ...o, since: v }),
  '--before': (o, v) => ({ ...o, before: v }),
  '--hours': (o, v) => ({ ...o, hours: v }),
  '--report': (o, v) => ({ ...o, report: v }),
};

export function parseArgs(argv) {
  let options = { since: null, before: null, hours: String(DEFAULT_WINDOW_HOURS), report: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    const set = FLAGS[flag];
    if (!set) throw new AuditReadError(`Unknown argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new AuditReadError(`${flag} needs a value`);
    options = set(options, value);
    i += 1;
  }
  const hours = Number(options.hours);
  if (!Number.isFinite(hours) || hours <= 0) throw new AuditReadError('--hours must be a positive number');
  options.hours = hours;
  return options;
}
