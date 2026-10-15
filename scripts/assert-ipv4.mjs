/**
 * assert-ipv4.mjs — one IPv4 address in, the same address out, or exit 1.
 *
 * PLAT-10 (#970). deploy-functions.yml learns its own public address from a
 * third party (`curl https://api.ipify.org`) and writes it into `az` firewall
 * arguments and a `--ip-address <value>/32` access-restriction rule. Nothing
 * checked the value between the two: an error page, an empty body or a
 * redirect notice would have been interpolated as-is. This is the check. It
 * reads stdin (or its one argument), trims it, and prints it back only when it
 * is exactly four dotted decimal octets, each 0 to 255, with nothing else on
 * the line. Anything else is refused with a message that quotes what arrived,
 * so a failed deploy says what the third party returned rather than what `az`
 * made of it.
 *
 *   RUNNER_IP=$(curl -sS --max-time 10 https://api.ipify.org | node scripts/assert-ipv4.mjs)
 *
 * No dependencies: the deploy job holds an OIDC token, and the rule there is
 * that nothing third-party runs in it that does not have to.
 */
import { readFileSync } from 'node:fs';

/** True for exactly one dotted-quad IPv4 address, each octet 0..255, no leading or trailing text. */
export function isIpv4(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  return match.slice(1).every((octet) => Number(octet) <= 255 && String(Number(octet)) === octet);
}

/**
 * The address to print, or the reason to refuse. Pure, so the refusal text is
 * tested: it quotes the input truncated to 80 characters, with control
 * characters replaced, so an HTML error page cannot write arbitrary lines
 * into the job log.
 */
export function judge(raw) {
  const value = String(raw ?? '').trim();
  if (isIpv4(value)) return { ok: true, address: value };
  const shown = value.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
  return { ok: false, reason: `not one IPv4 address: '${shown}'${value.length > 80 ? '…' : ''}` };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  const input = process.argv[2] !== undefined ? process.argv[2] : readFileSync(0, 'utf8');
  const verdict = judge(input);
  if (verdict.ok) {
    process.stdout.write(`${verdict.address}\n`);
  } else {
    process.stderr.write(`::error::runner address refused, ${verdict.reason}\n`);
    process.exit(1);
  }
}
