/**
 * check-guide-drift.mjs (#1356) — does an add-on's integration guide still say what the website says?
 *
 * Each add-on repository keeps docs/website-integration/integration-guide.md, and that guide pastes a copy of the
 * add-on's row from frontend/src/data/addons/catalogue.js. A copy of a fact that lives somewhere else goes stale:
 * on 2026-10-24 two guides still said `coming` twelve days after the site had made them `available`. This script
 * compares the pasted row with the real one and fails, naming each field that differs and both values, so the fix
 * is a one-line edit in the add-on's guide and not a review that has to notice.
 *
 *   node scripts/addons/check-guide-drift.mjs --catalogue <catalogue.js> --group-vars <all.yml> --guide <guide.md> --id <add-on id>
 *
 * It reads three files and writes nothing. Exit 0 prints `in step: N fields compared`. Exit 1 means the guide has
 * drifted, or the site no longer lists the add-on, or the guide has no row (or an unreadable one). Exit 2 means the
 * command was used wrongly or a file could not be read.
 *
 * THE GUIDE'S ROW IS TEXT FROM ANOTHER REPOSITORY. It is evaluated with node:vm in an empty context with code
 * generation switched off and a time limit, never with eval or `new Function` in this process. That keeps a row
 * that reaches for `process` or `require` from working (they do not exist in the empty context). It is a guard
 * against mistakes, not a sandbox to rely on against a hostile guide: the caller runs this on its own guide.
 *
 * THE PORT comes from the lab host's group_vars, the same file and the same row-splitting approach as
 * scripts/lab/read-addon-pins.mjs. It is compared only when the guide states one, and a guide may state it as
 * a table row (`| Lab-host loopback port | 18082 |`) or as `127.0.0.1:18081 -> 8080`. A guide that says the port
 * is "not assigned" states none, so nothing is compared. A guide that states a port for an id the lab host
 * does not run is a difference, not a skip.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateRowBlock, extractRowBlock, guidePort } from './guide-drift-row.mjs';
import { loadCatalogueRow, readAddonPorts } from './guide-drift-site.mjs';

// The work is split by side into two sibling files (#1845): guide-drift-row.mjs reads the guide, and
// guide-drift-site.mjs reads the website's catalogue and lab-host settings. Both use Node built-ins only, and
// addon-guide-check.yml fetches all three files. What this file used to export is re-exported, so the test and any
// caller keep one import path.
export { evaluateRowBlock, extractRowBlock, guidePort } from './guide-drift-row.mjs';
export { loadCatalogueRow, readAddonPorts } from './guide-drift-site.mjs';

/** The catalogue fields compared, in the order differences are reported. `port` is added when the guide states one. */
export const COMPARED_FIELDS = Object.freeze([
  'id',
  'title',
  'summary',
  'origin',
  'panePath',
  'healthPath',
  'providers',
  'technology',
  'status',
  'capabilities',
  'docsUrl',
  'articleSlugs',
]);

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A value as it is shown in a failure message: JSON, with a missing field named as missing. */
const show = (value) => (value === undefined ? '(not in the row)' : JSON.stringify(value));

/** Whether two values are the same data. Arrays are compared item by item and in order; objects key by key. */
function same(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => same(a[key], b[key]));
  }
  return false;
}

/**
 * The whole check on text already read. Returns { ok, compared, problems }; `problems` are sentences, one per
 * difference, each naming the field and both values (the site's first).
 */
export async function checkGuideDrift({ catalogueText, groupVarsText, guideText, id }) {
  const fail = (...problems) => ({ ok: false, compared: 0, problems });
  if (typeof id !== 'string' || !ID.test(id)) return fail(`"${id}" is not an add-on id (lowercase words joined by hyphens)`);

  const site = await loadCatalogueRow(catalogueText, id);
  if (site === null) {
    return fail(`the site no longer lists this add-on: id "${id}" is not in frontend/src/data/addons/catalogue.js`);
  }

  const found = extractRowBlock(guideText);
  if (found.error) return fail(found.error);
  const parsed = evaluateRowBlock(found.block);
  if (parsed.error) return fail(parsed.error);

  const problems = [];
  let compared = 0;
  for (const field of COMPARED_FIELDS) {
    compared += 1;
    if (!same(site[field], parsed.row[field])) {
      problems.push(`${field}: the site says ${show(site[field])}, the guide says ${show(parsed.row[field])}`);
    }
  }

  const stated = guidePort(guideText);
  if (stated !== null) {
    compared += 1;
    const ports = readAddonPorts(groupVarsText);
    const real = ports.get(id);
    if (real === undefined || real === null) {
      problems.push(`port: the guide says ${stated}, the lab host's group_vars has no port for "${id}"`);
    } else if (real !== stated) {
      problems.push(`port: the site's lab host says ${real}, the guide says ${stated}`);
    }
  }

  return { ok: problems.length === 0, compared, problems };
}

const USAGE =
  'usage: node check-guide-drift.mjs --catalogue <catalogue.js> --group-vars <all.yml> --guide <integration-guide.md> --id <add-on id>';

/** `--name value` pairs only; anything else is a usage error. */
export function parseArgs(argv) {
  const wanted = new Set(['catalogue', 'group-vars', 'guide', 'id']);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
    const value = argv[i + 1];
    // A known option, given once, followed by a value that is not another option.
    if (!name || !wanted.has(name) || name in args) throw new Error(USAGE);
    if (value === undefined || value.startsWith('--')) throw new Error(USAGE);
    args[name] = value;
  }
  if ([...wanted].some((name) => !(name in args))) throw new Error(USAGE);
  return args;
}

async function main(argv) {
  let args;
  let texts;
  try {
    args = parseArgs(argv);
    texts = {
      catalogueText: readFileSync(args.catalogue, 'utf8'),
      groupVarsText: readFileSync(args['group-vars'], 'utf8'),
      guideText: readFileSync(args.guide, 'utf8'),
    };
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  let result;
  try {
    result = await checkGuideDrift({ ...texts, id: args.id });
  } catch (error) {
    result = { ok: false, compared: 0, problems: [error.message] };
  }

  if (result.ok) {
    process.stdout.write(`in step: ${result.compared} fields compared\n`);
    return 0;
  }
  const lines = [`The guide for "${args.id}" no longer matches the website (${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}):`];
  for (const problem of result.problems) lines.push(`  - ${problem}`);
  lines.push('The website is the authority. Edit the guide\'s pasted row to match it (or, if the website is wrong, fix the website first).');
  process.stderr.write(`${lines.join('\n')}\n`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
