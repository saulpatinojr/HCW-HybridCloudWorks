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
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

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

/** Turns a value that came out of the vm context into plain data of this realm (a frozen array is still an array). */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * The catalogue row with this id. The file is pure data with no imports (its own header says so), so it is
 * loaded as a module from a data: URL, which works whatever package.json is or is not beside the file.
 */
export async function loadCatalogueRow(catalogueText, id) {
  const url = `data:text/javascript;base64,${Buffer.from(catalogueText, 'utf8').toString('base64')}`;
  let module;
  try {
    module = await import(url);
  } catch (error) {
    throw new Error(`the site's catalogue could not be loaded: ${error.message}`);
  }
  const rows = module.addons;
  if (!Array.isArray(rows)) throw new Error("the site's catalogue does not export an `addons` list");
  const row = rows.find((candidate) => candidate?.id === id);
  return row === undefined ? null : plain(row);
}

/**
 * The text of the guide's pasted row: the first ```js block under the heading that starts "Catalogue row"
 * (a number before the words is allowed: "## 1. Catalogue row"). Returns { block } or { error }.
 */
export function extractRowBlock(guideText) {
  const lines = guideText.replace(/\r\n/g, '\n').split('\n');
  const heading = lines.findIndex((line) => /^#{1,6}[ \t]+(?:\d+\.[ \t]*)?Catalogue row\b/i.test(line));
  if (heading === -1) return { error: 'the guide has no heading that starts "Catalogue row"' };

  for (let i = heading + 1; i < lines.length; i += 1) {
    if (/^#{1,6}[ \t]/.test(lines[i])) break;
    if (!/^```(?:js|javascript)[ \t]*$/.test(lines[i])) continue;
    const end = lines.findIndex((line, at) => at > i && /^```[ \t]*$/.test(line));
    if (end === -1) return { error: 'the guide\'s row block is never closed (no closing ``` line)' };
    return { block: lines.slice(i + 1, end).join('\n') };
  }
  return { error: 'the guide has no ```js block under its "Catalogue row" heading' };
}

/** Evaluates the pasted object literal in an empty vm context. Returns { row } or { error }. */
export function evaluateRowBlock(block) {
  let value;
  try {
    value = vm.runInNewContext(`(${block}\n)`, Object.create(null), {
      timeout: 1000,
      contextCodeGeneration: { strings: false, wasm: false },
    });
  } catch (error) {
    return { error: `the guide's row block is not a readable object (${String(error?.message ?? error).split('\n')[0]})` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: "the guide's row block is not a single `{ ... }` object" };
  }
  let row;
  try {
    row = plain(value);
  } catch (error) {
    return { error: `the guide's row block is not plain data (${error.message})` };
  }
  return { row };
}

/**
 * The port the guide states, or null when it states none. Reads a table row whose label mentions the loopback
 * port; the value must start with a number (optionally in backticks, optionally `127.0.0.1:` before it).
 * "not assigned; ... the Cloud Assessor uses 18083" starts with a word, so it states nothing.
 */
export function guidePort(guideText) {
  for (const line of guideText.replace(/\r\n/g, '\n').split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4 || cells[0] !== '') continue;
    if (!/loopback port/i.test(cells[1])) continue;
    const value = cells[2].match(/^`?(?:127\.0\.0\.1:)?(\d{2,5})\b/);
    if (value) return Number(value[1]);
  }
  return null;
}

/**
 * The `port:` of each `addons:` row in the lab host's group_vars, by id. Split the same way read-addon-pins.mjs
 * splits (rows start at two spaces and `- id:`), but a row with no digest still counts: the guide may state a
 * port before the image exists.
 */
export function readAddonPorts(groupVarsText) {
  const block = groupVarsText.replace(/\r\n/g, '\n').match(/^addons:\n([\s\S]*?)(?=\n[A-Za-z_]+:|\n*(?![\s\S]))/m)?.[1];
  if (!block) throw new Error('no `addons:` block in the group_vars file');
  const ports = new Map();
  for (const row of `\n${block}`.split(/\n {2}- id:[ \t]*/).slice(1)) {
    const id = row.match(/^([a-z0-9-]+)/)?.[1];
    if (!id) throw new Error('an addons row has no id');
    const port = row.match(/^ {4}port:[ \t]*(\d+)\b/m)?.[1];
    ports.set(id, port === undefined ? null : Number(port));
  }
  return ports;
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
    if (!name || !wanted.has(name) || value === undefined || value.startsWith('--') || name in args) throw new Error(USAGE);
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
