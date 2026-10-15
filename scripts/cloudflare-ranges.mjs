/**
 * cloudflare-ranges.mjs — hold `cloudflare_ip_ranges` (infra/variables.tf) to
 * the list Cloudflare publishes, by pull request (PLAT-10, #970).
 *
 * The origin lock (infra/functionapp.tf) admits exactly the ranges in that
 * variable's default: one Allow rule each, deny-all behind them. Cloudflare
 * adds or retires a range rarely and without notice. A retired range is dead
 * weight in the rule list; a new one is a Cloudflare edge the origin refuses,
 * which a visitor sees as a 403 from a site that is otherwise up. Nothing
 * watched the list: it was a literal, checked by hand on the day it was
 * committed and compared by nothing since. The review called that out.
 *
 * This reads https://api.cloudflare.com/client/v4/ips (public, no token),
 * compares the IPv4 list with the declared default, and with `--bump`
 * rewrites the default to the published list, in Cloudflare's order, when
 * they differ. cloudflare-ranges.yml runs it weekly and opens or updates the
 * `chore/cloudflare-ranges` pull request through the repository's App, the
 * arrangement #949 approved for the lab pin sets (scripts/open-lab-pin-pr.mjs
 * holds the set: `infra/variables.tf` and nothing else).
 *
 * WHAT IT REFUSES, so a bad answer can never empty the lock (exit 2, nothing
 * written): a response that is not Cloudflare's `success: true` envelope, a
 * list shorter than MIN_DECLARED_RANGES (assert-origin-lock.mjs holds every
 * deploy to the same floor), or an entry that is not an IPv4 CIDR. IPv6 is
 * read and ignored: the Function App's restriction rules are IPv4 (the
 * explicit deny-all in functionapp.tf is IPv4), as the variable's description
 * says.
 *
 * THE MERGE ORDER MATTERS. assert-origin-lock.mjs reads the declared list from
 * the checkout a deploy runs from and holds the Function App's live rules to
 * it: a merged move that has not been applied fails the next deploy by
 * design. The pull request body says so; the owner applies the HCP Terraform
 * run, then deploys.
 *
 * Usage: node scripts/cloudflare-ranges.mjs --check                  exit 0 current, 3 behind, 2 unreadable
 *        node scripts/cloudflare-ranges.mjs --bump [--dry-run] [--evidence <file>]
 *                                                                   exit 0 either way; writes the file when behind
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { declaredCloudflareRanges, MIN_DECLARED_RANGES, RANGES_VARIABLE } from './assert-origin-lock.mjs';

export const CLOUDFLARE_IPS_URL = 'https://api.cloudflare.com/client/v4/ips';
/** The opener's set (scripts/open-lab-pin-pr.mjs SETS): one branch, one path. */
export const SET = 'cloudflare-ranges';
export const VARIABLES_PATH = 'infra/variables.tf';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** True for one IPv4 CIDR: a dotted quad with octets 0..255 and a prefix 0..32. */
export function isIpv4Cidr(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(value));
  if (!match) return false;
  const octets = match.slice(1, 5);
  if (!octets.every((o) => Number(o) <= 255 && String(Number(o)) === o)) return false;
  return Number(match[5]) <= 32 && String(Number(match[5])) === match[5];
}

/**
 * Cloudflare's answer, judged. Returns `{ ranges, etag }` or throws with the
 * reason, so the caller never sees a partial list as "the list".
 */
export function parsePublished(body) {
  let doc;
  try {
    doc = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    throw new Error('the answer is not JSON');
  }
  if (!doc || doc.success !== true || !doc.result || !Array.isArray(doc.result.ipv4_cidrs)) {
    throw new Error('the answer is not the `success: true` envelope with `result.ipv4_cidrs`');
  }
  const ranges = doc.result.ipv4_cidrs.map(String);
  const bad = ranges.filter((r) => !isIpv4Cidr(r));
  if (bad.length) throw new Error(`not IPv4 CIDRs: ${bad.join(', ')}`);
  if (ranges.length < MIN_DECLARED_RANGES) {
    throw new Error(`only ${ranges.length} ranges, below the floor of ${MIN_DECLARED_RANGES}; refusing to narrow the lock on a short answer`);
  }
  if (new Set(ranges).size !== ranges.length) throw new Error('the list repeats a range');
  return { ranges, etag: typeof doc.result.etag === 'string' ? doc.result.etag : '' };
}

/** What moved: the published ranges the default lacks, and the declared ranges Cloudflare no longer lists. */
export function diffRanges(declared, published) {
  const have = new Set(declared);
  const want = new Set(published);
  const added = published.filter((r) => !have.has(r));
  const removed = declared.filter((r) => !want.has(r));
  const reordered = added.length === 0 && removed.length === 0 && declared.join(',') !== published.join(',');
  return { added, removed, reordered, same: added.length === 0 && removed.length === 0 && !reordered };
}

/**
 * The variables file with the default of `cloudflare_ip_ranges` replaced by
 * `ranges`, in that order, keeping the file's own indentation. Throws when
 * the block is not where assert-origin-lock.mjs looks for it, so a rewrite
 * can never land outside the variable.
 */
export function renderDefault(source, ranges) {
  const at = source.indexOf(`variable "${RANGES_VARIABLE}"`);
  if (at < 0) throw new Error(`no variable "${RANGES_VARIABLE}" in the source`);
  const end = source.indexOf('\n}', at);
  if (end < 0) throw new Error(`variable "${RANGES_VARIABLE}" never closes`);
  const block = source.slice(at, end);
  const list = /(default\s*=\s*\[)([\s\S]*?)(\n[ \t]*\])/.exec(block);
  if (!list) throw new Error(`variable "${RANGES_VARIABLE}" has no list default`);
  const entryIndent = /\n([ \t]*)"/.exec(list[2])?.[1] ?? '    ';
  const body = ranges.map((r) => `\n${entryIndent}"${r}",`).join('');
  const rendered = block.replace(list[0], `${list[1]}${body}${list[3]}`);
  return source.slice(0, at) + rendered + source.slice(end);
}

/** The pull request's evidence section, one row per range that moved. */
export function renderEvidence({ declared, published, etag, date }) {
  const { added, removed, reordered } = diffRanges(declared, published);
  const lines = [
    `Read ${CLOUDFLARE_IPS_URL} on ${date}${etag ? ` (etag \`${etag}\`)` : ''}: ${published.length} IPv4 ranges published, ${declared.length} declared in \`${VARIABLES_PATH}\`.`,
    '',
    '| Range | Change | Effect on the origin lock |',
    '| --- | --- | --- |',
  ];
  for (const r of added) lines.push(`| \`${r}\` | published, not declared | a Cloudflare edge the origin refuses today; the apply adds its Allow rule |`);
  for (const r of removed) lines.push(`| \`${r}\` | declared, no longer published | a rule nothing reaches through; the apply removes it |`);
  if (reordered) lines.push('| (all) | same ranges, Cloudflare\'s order | rule priorities follow the list order; no admission changes |');
  return `${lines.join('\n')}\n`;
}

/** `--flag value` from argv, or undefined. */
export function flag(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** Fetch and judge the published list. Separated so main() is testable with a fake fetch. */
export async function publishedRanges(fetchImpl = fetch) {
  const response = await fetchImpl(CLOUDFLARE_IPS_URL, { headers: { accept: 'application/json' }, redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${CLOUDFLARE_IPS_URL}`);
  return parsePublished(await response.text());
}

/**
 * The command. `io` is injected for the tests: read/write the variables file,
 * fetch, today's date and where to append `changed=`.
 */
export async function main(argv, io = {}) {
  const read = io.read ?? (() => readFileSync(join(REPO, VARIABLES_PATH), 'utf8'));
  const write = io.write ?? ((text) => writeFileSync(join(REPO, VARIABLES_PATH), text));
  const log = io.log ?? ((line) => process.stdout.write(`${line}\n`));
  const date = io.date ?? new Date().toISOString().slice(0, 10);
  const mode = argv.includes('--bump') ? 'bump' : argv.includes('--check') ? 'check' : null;
  if (!mode) {
    log('Usage: node scripts/cloudflare-ranges.mjs --check | --bump [--dry-run] [--evidence <file>]');
    return 2;
  }

  const source = read();
  const declared = declaredCloudflareRanges(source);
  if (declared.length < MIN_DECLARED_RANGES) {
    log(`::error::${VARIABLES_PATH} declares ${declared.length} ranges, below the floor of ${MIN_DECLARED_RANGES}; nothing compared`);
    return 2;
  }

  let published;
  try {
    published = await publishedRanges(io.fetch);
  } catch (error) {
    log(`::error::Cloudflare's list could not be read: ${error.message}. Nothing written.`);
    return 2;
  }

  const change = diffRanges(declared, published.ranges);
  const output = io.output ?? process.env.GITHUB_OUTPUT;
  const record = (changed) => {
    if (output) appendFileSync(output, `changed=${changed}\n`);
  };

  if (change.same) {
    log(`\`${RANGES_VARIABLE}\` is current: ${declared.length} ranges, the same ${published.ranges.length} Cloudflare publishes${published.etag ? ` (etag \`${published.etag}\`)` : ''}.`);
    record(false);
    return 0;
  }

  const summary = `\`${RANGES_VARIABLE}\` is behind Cloudflare's list: ${change.added.length} to add, ${change.removed.length} to remove${change.reordered ? ', order differs' : ''}.`;
  log(summary);
  for (const r of change.added) log(`  + ${r}`);
  for (const r of change.removed) log(`  - ${r}`);

  if (mode === 'check') return 3;

  const evidence = renderEvidence({ declared, published: published.ranges, etag: published.etag, date });
  const evidenceAt = flag(argv, '--evidence');
  if (evidenceAt) writeFileSync(evidenceAt, evidence);
  if (argv.includes('--dry-run')) {
    log(`dry run: ${VARIABLES_PATH} not written`);
    record(false);
    return 0;
  }
  write(renderDefault(source, published.ranges));
  log(`${VARIABLES_PATH}: default of \`${RANGES_VARIABLE}\` rewritten to the ${published.ranges.length} published ranges.`);
  record(true);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`::error::${error.message}\n`);
      process.exit(2);
    }
  );
}
