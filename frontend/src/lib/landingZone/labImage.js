/**
 * What the lab's runner image can initialise offline (#672, Phase 6 of #657),
 * and the rule it decides that by, so the builder can say before anything is
 * submitted which of its modules the lab will resolve.
 *
 * ONE LIST AND TWO MIRRORS, EACH HELD TO ITS SOURCE BY labImage.test.js:
 *
 *   - `LAB_IMAGE_AVM` is every `/opt/avm/<name>@<version>` the runner image
 *     carries, in two parts. The builder modules are not copied here at all:
 *     they are AVM_MODULES from avmVersions.js, because the image vendors
 *     exactly the modules the builder emits at the versions it emits them
 *     (ADR 0032 decision 5), every `AVM_<KEY>_VERSION` pair in
 *     lab-image/versions.env, which the Dockerfile's fetch stage reads and
 *     scripts/lab-image-avm-vendoring.test.mjs holds equal to avmVersions.js.
 *     A builder pin therefore moves this list with it. The registry modules
 *     those call, `LAB_IMAGE_CHILD_AVM`, are the one copy: AVM_CHILD_MODULES
 *     in versions.env, where each carries the tree hash the build checks.
 *     The test reads versions.env and fails when either part drifts from it.
 *   - `labModuleReport` is lab-image/lib/tf_rewrite.py in JavaScript, with
 *     tf_constraints.py beside it as tfConstraints.js: the same regular
 *     expressions for a `module` block, its depth-1 `source` and `version`
 *     lines and a registry AVM source, the same Terraform constraint
 *     operators, and the same choice (the highest vendored version that
 *     satisfies the constraint). A block the image would leave alone, so
 *     that `terraform init` fails on it under `--network none`, is reported
 *     here with the versions the image has.
 *
 * NOTHING HERE CHANGES A FILE. ADR 0032 decision 5: the builder's download
 * and the submitted payload keep their registry `source` and `version`
 * lines, so the zip initialises anywhere with network, and the
 * `terraform-validate` capability rewrites them to the vendored paths on its
 * own tmpfs copy inside the job (lab-image/bin/hcw-terraform-validate). This
 * module predicts that rewrite; it does not perform it.
 *
 * Until 2026-09-27 the builder's fourth module, avm-res-network-virtualnetwork
 * 0.22.2 (every spoke), was not in the image, only the connectivity
 * module's child copy at 0.15.0, so a build with a spoke was refused here.
 * The image now vendors every builder module; a build that calls any other
 * module or version is still refused, with the module named, by the same
 * rule.
 *
 * Pure: no React, no DOM, no network.
 */
import { AVM_MODULES } from './avmVersions';
import { chooseVendored, vendoredModules } from './tfConstraints';

/** The builder modules, as `<name>@<version>`: what the builder emits is what the image vendors. */
export const LAB_IMAGE_BUILDER_AVM = Object.freeze(
  Object.values(AVM_MODULES).map((module) => `${module.name}@${module.version}`)
);

/** The registry modules the builder modules call, transitively (versions.env AVM_CHILD_MODULES). */
export const LAB_IMAGE_CHILD_AVM = Object.freeze([
  'avm-ptn-network-private-link-private-dns-zones@0.23.2',
  'avm-res-network-azurefirewall@0.4.0',
  'avm-res-network-bastionhost@0.9.0',
  'avm-res-network-ddosprotectionplan@0.3.0',
  'avm-res-network-dnsresolver@0.7.3',
  'avm-res-network-firewallpolicy@0.3.3',
  'avm-res-network-natgateway@0.3.2',
  'avm-res-network-privatednszone@0.4.3',
  'avm-res-network-publicipaddress@0.2.0',
  'avm-res-network-routetable@0.3.1',
  'avm-res-network-routetable@0.5.0',
  'avm-res-network-virtualnetwork@0.22.2',
  'avm-utl-interfaces@0.10.0',
  'avm-utl-interfaces@0.2.0',
  'avm-utl-interfaces@0.5.0',
  'avm-utl-interfaces@0.6.0',
  'avm-utl-network-ip-addresses@0.1.0',
  'avm-utl-regions@0.12.0',
]);

/**
 * Every vendored module in the runner image, as `<name>@<version>`, each
 * once (a child at a builder module's exact name@version is that builder
 * module's directory, as lab-image/vendor-avm.sh resolves it), in the
 * code-point order of the image's own `sorted(os.listdir("/opt/avm"))`.
 */
export const LAB_IMAGE_AVM = Object.freeze(
  [...new Set([...LAB_IMAGE_BUILDER_AVM, ...LAB_IMAGE_CHILD_AVM])].sort()
);

/** Where the image keeps them (tf_constraints.py AVM_ROOT). */
export const LAB_IMAGE_AVM_ROOT = '/opt/avm';

// tf_rewrite.py, verbatim in meaning.
const REGISTRY_SOURCE =
  /^(?:registry\.terraform\.io\/)?[Aa]zure\/([A-Za-z0-9._-]+)\/(azurerm|azure)(?:\/\/(.+))?$/;
const MODULE_HEADER = /^\s*module\s+"([^"]+)"\s*\{/;
const SOURCE_LINE = /^(\s*)source(\s*)=(\s*)"([^"]+)"(.*)$/;
const VERSION_LINE = /^(\s*)version\s*=\s*"([^"]*)"(.*)$/;
const SKIP_DIRS = new Set(['.terraform', '.git']);

const braceDelta = (line) => (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;

/**
 * Walk one `module` block from its header line (tf_rewrite.scan_block): the
 * index after its closing brace, and the indexes of its depth-1 `source` and
 * `version` lines, so a `source` inside a nested block or an object value is
 * not taken.
 */
function scanBlock(lines, start) {
  let depth = braceDelta(lines[start]);
  let j = start + 1;
  let sourceAt = null;
  let versionAt = null;
  while (j < lines.length && depth > 0) {
    if (depth === 1 && SOURCE_LINE.test(lines[j])) sourceAt = j;
    else if (depth === 1 && VERSION_LINE.test(lines[j])) versionAt = j;
    depth += braceDelta(lines[j]);
    j += 1;
  }
  return { end: j, sourceAt, versionAt };
}

/** Every top-level `module` block in one file's lines (tf_rewrite.module_blocks). */
function moduleBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const header = MODULE_HEADER.exec(lines[i]);
    if (!header) {
      i += 1;
      continue;
    }
    const { end, sourceAt, versionAt } = scanBlock(lines, i);
    blocks.push({ name: header[1], sourceAt, versionAt });
    i = end;
  }
  return blocks;
}

const isScanned = (path) =>
  path.endsWith('.tf') && !path.split('/').some((part) => SKIP_DIRS.has(part));

/**
 * What the runner image will do with each registry AVM `module` block in
 * the files: rewrite it to a vendored copy (`vendored` is `<name>@<version>`)
 * or leave it for `init` to fail on (`vendored` is null, `have` lists what
 * the image carries). Blocks that name no registry AVM source are not in the
 * report, exactly as the image's own report leaves them out. Files are
 * scanned in path order, as the image's `sorted(rglob('*.tf'))` does.
 *
 * @param {Array<{ path: string, content: string }>} files
 * @param {string[]} [entries] the image's vendored list
 * @returns {Array<{ path: string, block: string, source: string, module: string, constraint: string, vendored: string|null, have: string[] }>}
 */
export function labModuleReport(files, entries = LAB_IMAGE_AVM) {
  const vendored = vendoredModules(entries);
  const report = [];
  for (const file of files.filter((f) => isScanned(f.path)).sort(byPath)) {
    const lines = file.content.split('\n');
    for (const block of moduleBlocks(lines)) {
      const row = blockRow(file.path, lines, block, vendored);
      if (row) report.push(row);
    }
  }
  return report;
}

/** Code-point order, as Python's `sorted()` compares paths. */
function byPath(a, b) {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

/** The line a block index points at, matched, or null (tf_rewrite.resolve_block). */
const lineMatch = (lines, at, pattern) => (at === null ? null : pattern.exec(lines[at]));

/** One block's report row, or null when its source is not a registry AVM module. */
function blockRow(path, lines, block, vendored) {
  const src = lineMatch(lines, block.sourceAt, SOURCE_LINE);
  const source = src ? src[4].trim() : '';
  const reg = REGISTRY_SOURCE.exec(source);
  if (!reg) return null;
  const ver = lineMatch(lines, block.versionAt, VERSION_LINE);
  const constraint = ver ? ver[2] : '';
  const picked = chooseVendored(vendored, reg[1], constraint);
  return {
    path,
    block: block.name,
    source,
    module: reg[1],
    constraint,
    vendored: picked === null ? null : `${reg[1]}@${picked}`,
    have: (vendored[reg[1]] ?? []).map((c) => c.text),
  };
}

/**
 * Whether the lab can initialise these files offline, as far as modules go:
 * `{ ok, unresolved }`, the second being the report rows the image would
 * leave alone, one per distinct module and constraint.
 */
export function labResolution(files, entries = LAB_IMAGE_AVM) {
  const seen = new Set();
  const unresolved = [];
  for (const row of labModuleReport(files, entries)) {
    const id = `${row.module} ${row.constraint}`;
    if (row.vendored !== null || seen.has(id)) continue;
    seen.add(id);
    unresolved.push(row);
  }
  return { ok: unresolved.length === 0, unresolved };
}
