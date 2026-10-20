/**
 * The pure half of the AVM pin updater (#671): version comparison, registry
 * document validation, the targeted text edits that move a pin, and the
 * Markdown summary. Nothing here reads a file, a clock or the network; the
 * entry point and its I/O live in update-avm-versions.mjs, which re-exports
 * everything below so a test can import from one place.
 *
 * Every edit is a refusal first. A pin that is missing, doubled, or not at
 * the version that was read means the file has been reshaped into something
 * this script should not guess at, so it throws EditRefused with the line
 * named and nothing is written.
 */

const GITHUB_ORG = 'https://github.com/Azure';
export const REGISTRY_BASE = 'https://registry.terraform.io/v1/modules';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A source that could not be read or said something unusable. One sentence. */
export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * A file whose shape is not the one this script knows how to edit: a pin
 * that is missing, doubled or not at the version that was read. Nothing is
 * written, and the sentence names the line. Not a bug, so no stack.
 */
export class EditRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditRefused';
  }
}

// --- versions ---------------------------------------------------------------

/** `[major, minor, patch]` for a release string, or null for anything else. */
export function parseVersion(text) {
  const match = SEMVER.exec(String(text ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function releaseParts(text) {
  const parts = parseVersion(text);
  if (!parts) throw new TypeError(`Not a release version: ${JSON.stringify(text)}`);
  return parts;
}

/** -1, 0 or 1. Throws for a string that is not a plain release version. */
export function compareVersions(a, b) {
  const left = releaseParts(a);
  const right = releaseParts(b);
  const index = left.findIndex((part, at) => part !== right[at]);
  if (index === -1) return 0;
  return left[index] < right[index] ? -1 : 1;
}

export function isNewer(candidate, pinned) {
  return compareVersions(candidate, pinned) > 0;
}

// --- registry documents -----------------------------------------------------

export const registryModuleUrl = (name) => `${REGISTRY_BASE}/Azure/${name}/azurerm`;
export const registryVersionsUrl = (name) => `${registryModuleUrl(name)}/versions`;
export const releaseNotesUrl = (name, version) =>
  `${GITHUB_ORG}/terraform-azurerm-${name}/releases/tag/v${version}`;
export const tarballUrl = (name, version) =>
  `${GITHUB_ORG}/terraform-azurerm-${name}/archive/refs/tags/v${version}.tar.gz`;
export const terraformTfUrl = (name, version) =>
  `${GITHUB_ORG}/terraform-azurerm-${name}/blob/v${version}/terraform.tf`;

/**
 * The latest release from the registry's module document, validated: the
 * version is a plain MAJOR.MINOR.PATCH and, when the document carries a tag,
 * the tag is `v<version>`. Anything else is refused rather than pinned.
 */
export function latestFromRegistry(document, name) {
  const version = String(document?.version ?? '').trim();
  if (!parseVersion(version)) {
    throw new RegistryError(
      `The registry lists ${name} at ${JSON.stringify(document?.version ?? null)}, which is not a MAJOR.MINOR.PATCH release, so nothing was written.`
    );
  }
  const tag = document.tag == null ? null : String(document.tag);
  if (tag !== null && tag !== `v${version}`) {
    throw new RegistryError(
      `The registry lists ${name} ${version} under tag ${JSON.stringify(tag)} rather than v${version}, so nothing was written.`
    );
  }
  return { version, tag, publishedAt: document.published_at ?? null };
}

const isRealProvider = (provider) => Boolean(provider?.name && provider.source);
const providerName = (provider) => String(provider.name).toLowerCase();

/**
 * The provider names one release requires, from the registry's versions
 * document. The registry lists a pseudo-provider named `terraform` with an
 * empty source for the `required_version` line; it is not a provider and is
 * dropped. Null when the release is not in the document.
 */
export function providersAt(versionsDocument, version) {
  const entries = versionsDocument?.modules?.[0]?.versions ?? [];
  const entry = entries.find((candidate) => candidate?.version === version);
  if (!entry) return null;
  const names = (entry.root?.providers ?? []).filter(isRealProvider).map(providerName);
  return [...new Set(names)].sort();
}

export const UNKNOWN_DRIFT = Object.freeze({ added: [], removed: [], unknown: true });

/** What the release requires that the pin does not list, and the reverse. */
export function providerDrift(pinned, latest) {
  if (latest === null) return UNKNOWN_DRIFT;
  const pinnedSet = new Set(pinned);
  const latestSet = new Set(latest);
  return {
    added: latest.filter((name) => !pinnedSet.has(name)),
    removed: pinned.filter((name) => !latestSet.has(name)),
    unknown: false,
  };
}

// --- targeted text edits ---------------------------------------------------

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The one match of `pattern` in `source`, or EditRefused naming how many
 * there were. Every edit below goes through this, so "exactly one line, or
 * nothing is written" is said once.
 */
function onlyMatch(source, pattern, file, what) {
  const matches = [...String(source).matchAll(pattern)];
  if (matches.length !== 1) {
    throw new EditRefused(
      `${file} holds ${matches.length} ${what}, not one, so it was not written.`
    );
  }
  return matches[0];
}

function assertRelease(version) {
  if (!parseVersion(version)) throw new TypeError(`Not a release version: ${version}`);
}

/**
 * Rewrite one module's pin in avmVersions.js and nothing else: the second
 * argument of its `avm('<name>', '<version>', …)` call, whether that call is
 * on one line or Prettier has broken it across several. Exactly one pin must
 * match and it must currently read `fromVersion`, or the file is refused —
 * a file that has been reshaped is a file this edit should not guess at.
 */
export function rewritePin(source, name, fromVersion, toVersion) {
  assertRelease(toVersion);
  const pattern = new RegExp(
    `(avm\\(\\s*'${escapeRegExp(name)}',\\s*')(\\d+\\.\\d+\\.\\d+)(')`,
    'g'
  );
  const [, , current] = onlyMatch(source, pattern, 'avmVersions.js', `pins for ${name}`);
  if (current !== fromVersion) {
    throw new EditRefused(
      `avmVersions.js pins ${name} at ${current}, not the ${fromVersion} that was read, so it was not written.`
    );
  }
  return String(source).replace(pattern, `$1${toVersion}$3`);
}

/** Stamp the shared verification date; refuses a file that lost the line. */
export function stampVerifiedOn(source, date) {
  if (!ISO_DATE.test(date)) throw new TypeError(`Not a YYYY-MM-DD date: ${date}`);
  const pattern = /^(export const AVM_VERIFIED_ON = ')(\d{4}-\d{2}-\d{2})(';)$/gm;
  onlyMatch(source, pattern, 'avmVersions.js', 'AVM_VERIFIED_ON lines');
  return String(source).replace(pattern, `$1${date}$3`);
}

/** `avm-ptn-alz` → `AVM_PTN_ALZ`, the prefix of its lines in versions.env. */
export function envKeyFor(name) {
  return String(name).toUpperCase().replace(/-/g, '_');
}

/** Whether versions.env vendors this module (has its `_VERSION` line). */
export function envVendors(envSource, name) {
  return new RegExp(`^${envKeyFor(name)}_VERSION=`, 'm').test(String(envSource));
}

/**
 * Rewrite one module's two lines in lab-image/versions.env: `_VERSION` to the
 * new release and `_SHA256` to the new tarball sum. Both lines must exist
 * exactly once and the version must currently read `fromVersion`; a file
 * with one line and not the other is refused, because a version without its
 * sum is a build that fails at the download and a sum without its version is
 * a build that verifies the wrong archive.
 */
export function rewriteEnv(envSource, name, fromVersion, toVersion, sha256) {
  assertRelease(toVersion);
  if (!SHA256_HEX.test(sha256)) throw new TypeError(`Not a SHA256 hex digest: ${sha256}`);
  const key = envKeyFor(name);
  const source = String(envSource);

  const versionPattern = new RegExp(`^(${key}_VERSION=)(\\S+)$`, 'gm');
  const [, , current] = onlyMatch(source, versionPattern, 'versions.env', `${key}_VERSION lines`);
  if (current !== fromVersion) {
    throw new EditRefused(
      `versions.env has ${key}_VERSION=${current}, not the ${fromVersion} avmVersions.js pins, so it was not written.`
    );
  }

  const shaPattern = new RegExp(`^(${key}_SHA256=)([0-9a-f]{64})$`, 'gm');
  onlyMatch(source, shaPattern, 'versions.env', `${key}_SHA256 lines beside its _VERSION line`);

  return source.replace(versionPattern, `$1${toVersion}`).replace(shaPattern, `$1${sha256}`);
}

/**
 * Move the exact pin on one module's block in the smoke payload
 * (lab-image/smoke/terraform-validate-payload/main.tf), where the version
 * line directly under `source = "Azure/<name>/azurerm"` reads `fromVersion`
 * and nothing else: the payload holds one block per builder module with a
 * different constraint operator each, and an exact pin is the one a bump
 * breaks by construction (`"0.21.0"` cannot resolve to 0.22.0). A block
 * whose version is a constraint (`~> 0.9`, `>= 0.15.0`) is left alone; the
 * static vendoring test says when a bump has outgrown it. Returns the text
 * and whether a pin moved; two exact pins on one module is a reshaped file
 * and is refused.
 */
export function rewriteSmokePin(payloadSource, name, fromVersion, toVersion) {
  assertRelease(toVersion);
  const source = String(payloadSource);
  const pattern = new RegExp(
    `(source\\s*=\\s*"Azure/${escapeRegExp(name)}/azurerm"\\s*\\n\\s*version\\s*=\\s*")(\\d+\\.\\d+\\.\\d+)(")`,
    'g'
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0) return { source, moved: false };
  if (matches.length > 1) {
    throw new EditRefused(
      `the smoke payload holds ${matches.length} exact pins for ${name}, not one, so it was not written.`
    );
  }
  const [, , current] = matches[0];
  if (current !== fromVersion) {
    throw new EditRefused(
      `the smoke payload pins ${name} at ${current}, not the ${fromVersion} avmVersions.js pins, so it was not written.`
    );
  }
  return { source: source.replace(pattern, `$1${toVersion}$3`), moved: true };
}

// --- the child record -------------------------------------------------------
//
// AVM_CHILD_CALLS in versions.env is keyed by each builder module's version,
// so a bump leaves the new version with no line and the static vendoring test
// red (#1306), and what a new release calls is only known once the image's
// vendor stage resolves it. The build prints both blocks with
// AVM_PRINT_PINS=1; these functions read that print-out and put the blocks
// where the old ones were, touching no other line.

/**
 * A vendor-stage build that failed, or a capture of one that says nothing
 * this script can splice: no block, two of them, a line that is not the
 * shape the build prints, or a record of builder modules that are not the
 * ones versions.env now pins. Nothing is written. Not a bug, so no stack.
 */
export class VendorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VendorError';
  }
}

export const CHILD_BLOCKS = Object.freeze(['AVM_CHILD_MODULES', 'AVM_CHILD_CALLS']);

/** `#15 12.97 ` — what `docker build --progress=plain` puts before each line a step prints. */
const BUILDKIT_PREFIX = /^#\d+ \d+\.\d+ /;
const MODULE_ID = '[^@\\s]+@\\d+\\.\\d+\\.\\d+';
const CHILD_PIN_LINE = new RegExp(`^(${MODULE_ID}) ([0-9a-f]{64})$`);
const CHILD_CALL_LINE = new RegExp(`^(${MODULE_ID})(?: (${MODULE_ID}))?$`);
const LINE_SHAPE = {
  AVM_CHILD_MODULES: { pattern: CHILD_PIN_LINE, shape: '<name>@<version> <tree hash>' },
  AVM_CHILD_CALLS: { pattern: CHILD_CALL_LINE, shape: '<builder>@<version> [<child>@<version>]' },
};

/** `PTN_ALZ` -> `avm-ptn-alz`, the Dockerfile's `tr 'A-Z_' 'a-z-'`; the inverse of envKeyFor. */
export const nameForKey = (key) => `avm-${String(key).toLowerCase().replace(/_/g, '-')}`;

/** The builder modules versions.env vendors, as `<name>@<version>`, sorted. */
export function envBuilders(envSource) {
  return [...String(envSource).matchAll(/^AVM_([A-Z0-9_]+)_VERSION=(\S+)$/gm)]
    .map(([, key, version]) => `${nameForKey(key)}@${version}`)
    .sort();
}

/** The non-blank lines of one quoted block, from a print-out or from versions.env. */
function blockOf(lines, name, describe) {
  const starts = lines.flatMap((line, at) => (line === `${name}='` ? [at] : []));
  if (starts.length !== 1) {
    throw new VendorError(
      starts.length === 0
        ? `${describe} has no ${name} block; a cached vendor stage prints nothing, and a failed one says why above, so nothing was written.`
        : `${describe} has ${starts.length} ${name} blocks, not one, so nothing was written.`
    );
  }
  const end = lines.indexOf("'", starts[0] + 1);
  if (end === -1) {
    throw new VendorError(
      `${describe}'s ${name} block has no closing quote, so nothing was written.`
    );
  }
  const body = lines
    .slice(starts[0] + 1, end)
    .filter((line) => line !== '' && !line.startsWith('#'));
  const { pattern, shape } = LINE_SHAPE[name];
  for (const line of body) {
    if (!pattern.test(line)) {
      throw new VendorError(
        `${describe}'s ${name} block has the line ${JSON.stringify(line)}, which is not ${shape}, so nothing was written.`
      );
    }
  }
  if (body.length === 0) {
    throw new VendorError(`${describe}'s ${name} block is empty, so nothing was written.`);
  }
  return body;
}

/**
 * The two blocks out of what `docker build --target vendor --build-arg
 * AVM_PRINT_PINS=1 --progress=plain lab-image` printed, BuildKit's `#N t.t `
 * prefix stripped from every line, as `{ AVM_CHILD_MODULES: [...lines],
 * AVM_CHILD_CALLS: [...lines] }` in the order the build printed them. A
 * block that is missing, doubled, unterminated, empty, or holds a line that
 * is not the shape vendor-avm.sh prints is refused with VendorError.
 */
export function parsePrintedPins(log) {
  const lines = String(log)
    .split(/\r?\n/)
    .map((line) => line.replace(BUILDKIT_PREFIX, ''));
  return Object.fromEntries(
    CHILD_BLOCKS.map((name) => [name, blockOf(lines, name, 'the vendor stage print-out')])
  );
}

/** The current lines of one block in versions.env, for the before/after in the summary. */
export function envChildBlock(envSource, name) {
  return blockOf(String(envSource).split(/\r?\n/), name, 'versions.env');
}

/**
 * Put the printed blocks where versions.env's old ones are and change no
 * other line: each `NAME='` … `'` block must appear exactly once, and the
 * builder modules the capture's AVM_CHILD_CALLS is keyed by must be exactly
 * the `AVM_<KEY>_VERSION` pairs the file now holds, or the capture is of
 * some other state of the file (a stale log, a build of another branch)
 * and is refused. Splicing the same blocks twice yields the same text.
 */
export function rewriteChildBlocks(envSource, blocks) {
  const source = String(envSource);
  const recorded = [...new Set(blocks.AVM_CHILD_CALLS.map((line) => line.split(' ')[0]))].sort();
  const pinned = envBuilders(source);
  if (recorded.join(' ') !== pinned.join(' ')) {
    throw new VendorError(
      `the vendor stage's AVM_CHILD_CALLS is keyed by ${recorded.join(', ')}, and versions.env now pins ${pinned.join(', ')}, so the capture is not of this file and it was not written.`
    );
  }
  let next = source;
  for (const name of CHILD_BLOCKS) {
    const pattern = new RegExp(`^${name}='[^']*'$`, 'gm');
    onlyMatch(next, pattern, 'versions.env', `${name} blocks`);
    const block = `${name}='\n${blocks[name].join('\n')}\n'`;
    next = next.replace(pattern, () => block);
  }
  return next;
}

/**
 * What the regenerated AVM_CHILD_MODULES says against the file's old block:
 * the children added and dropped (as `<name>@<version>`), and the counts.
 * The list is what LAB_IMAGE_CHILD_AVM in labImage.js carries, so a change
 * here is a change there.
 */
export function childRecordReport(envSource, blocks) {
  const pinOf = (line) => line.split(' ')[0];
  const before = new Set(envChildBlock(envSource, 'AVM_CHILD_MODULES').map(pinOf));
  const after = blocks.AVM_CHILD_MODULES.map(pinOf);
  return {
    modules: after.length,
    calls: blocks.AVM_CHILD_CALLS.length,
    added: after.filter((pin) => !before.has(pin)),
    removed: [...before].filter((pin) => !after.includes(pin)),
  };
}

/**
 * Rewrite LAB_IMAGE_CHILD_AVM in labImage.js to the regenerated child list,
 * one `'<name>@<version>',` per line in the order the build printed them
 * (the entry point formats the file with Prettier afterwards). Exactly one
 * array must be there, or the file is refused.
 */
export function rewriteChildList(labImageSource, blocks) {
  const pattern = /^(export const LAB_IMAGE_CHILD_AVM = Object\.freeze\(\[)\n[\s\S]*?^(\]\);)$/gm;
  onlyMatch(labImageSource, pattern, 'labImage.js', 'LAB_IMAGE_CHILD_AVM arrays');
  const entries = blocks.AVM_CHILD_MODULES.map((line) => `  '${line.split(' ')[0]}',`).join('\n');
  return String(labImageSource).replace(
    pattern,
    (_, open, close) => `${open}\n${entries}\n${close}`
  );
}

// --- summary ---------------------------------------------------------------

const code = (text) => `\`${text}\``;
const PINS_PATH = 'frontend/src/lib/landingZone/avmVersions.js';
const ENV_PATH = 'lab-image/versions.env';

function headline(results, moved, today) {
  if (moved.length === 0) {
    return `Nothing moved: every pin in ${code(PINS_PATH)} is the latest release the Terraform Registry lists.`;
  }
  return `${moved.length} of ${results.length} pins moved. ${code('AVM_VERIFIED_ON')} is now ${today}.`;
}

function tableRow(result) {
  const change = result.moved ? `**${result.from} → ${result.to}**` : result.to;
  const notes = result.moved ? `[v${result.to}](${result.releaseNotes})` : '—';
  return `| ${code(result.name)} | ${result.from} | ${change} | ${notes} |`;
}

function releaseNotesLine(result) {
  const published = result.publishedAt
    ? `, published ${String(result.publishedAt).slice(0, 10)}`
    : '';
  return `- Release notes: ${result.releaseNotes}${published}.`;
}

/** One line about versions.env, or none when the tarball was never fetched. */
function envLine(result) {
  const key = envKeyFor(result.name);
  const byState = {
    true: `- ${code(ENV_PATH)}: ${code(`${key}_VERSION`)} and ${code(`${key}_SHA256`)} rewritten; the tarball's SHA256 is ${code(result.sha256)}.`,
    false: `- ${code(ENV_PATH)} does not vendor this module, so it has no line to move; the tag was still downloaded (SHA256 ${code(result.sha256)}) to prove it exists.`,
  };
  return byState[String(result.vendored)] ?? null;
}

const PAYLOAD_PATH = 'lab-image/smoke/terraform-validate-payload/main.tf';

/** One line when the smoke payload's exact pin on this module moved with it. */
function payloadLine(result) {
  if (!result.smokePinMoved) return null;
  return `- ${code(PAYLOAD_PATH)}: the exact ${code(`version = "${result.from}"`)} on its block for this module now reads ${code(result.to)}, so smoke.sh still rewrites one block per builder module.`;
}

const driftParts = (drift) =>
  [
    drift.added.length ? `adds ${drift.added.join(', ')}` : null,
    drift.removed.length ? `drops ${drift.removed.join(', ')}` : null,
  ].filter(Boolean);

function providersLine(result) {
  const { drift, to, terraformTf } = result;
  const tf = code('required_providers');
  const pinned = code('requiredProviders');
  if (drift.unknown) {
    return `- ${tf} at v${to} could not be read from the registry; compare ${terraformTf} with ${pinned} by hand.`;
  }
  const parts = driftParts(drift);
  if (parts.length === 0) {
    return `- ${tf} at v${to} names the same providers as the pinned ${pinned} (${result.requiredProviders.join(', ')}); the version constraints may still have moved, so read ${terraformTf}.`;
  }
  return `- **HAND EDIT NEEDED.** ${tf} at v${to} ${parts.join(' and ')} against the pinned ${pinned}. This script does not edit ${pinned}, ${code('PROVIDER_PINS')} or the docblocks that quote the constraints; read ${terraformTf} and change them in this pull request before merging.`;
}

function bumpSection(result) {
  return [
    '',
    `#### ${code(result.name)} ${result.from} → ${result.to}`,
    '',
    releaseNotesLine(result),
    envLine(result),
    payloadLine(result),
    providersLine(result),
  ].filter((line) => line !== null);
}

const LAB_IMAGE_PATH = 'frontend/src/lib/landingZone/labImage.js';
const PRINT_COMMAND = code(
  'docker build --target vendor --build-arg AVM_PRINT_PINS=1 --progress=plain lab-image'
);

/** What happened to the child list, after the blocks line. */
function childListLine(children) {
  const list = code('LAB_IMAGE_CHILD_AVM');
  if (children.added.length === 0 && children.removed.length === 0) {
    return `- The child list is unchanged, so ${list} in ${code(LAB_IMAGE_PATH)} stands.`;
  }
  const parts = [
    children.added.length ? `adds ${children.added.join(', ')}` : null,
    children.removed.length ? `drops ${children.removed.join(', ')}` : null,
  ].filter(Boolean);
  return `- The child list ${parts.join(' and ')}, so ${list} in ${code(LAB_IMAGE_PATH)} was rewritten to match; the pull request carries that diff too.`;
}

/**
 * The child record section, after the bumps: what the vendor stage printed
 * and what changed, or that the run did not regenerate it (a dry run, or no
 * builder module moved).
 */
function childrenSection(children) {
  const blocks = `${code('AVM_CHILD_MODULES')} and ${code('AVM_CHILD_CALLS')}`;
  const lines = ['', '#### Child modules', ''];
  if (!children) {
    return [
      ...lines,
      `- ${blocks} in ${code(ENV_PATH)} were not regenerated: no builder module the image vendors moved, so the vendor stage would print what the file already holds.`,
    ];
  }
  if (children.dryRun) {
    return [
      ...lines,
      `- Dry run: ${blocks} in ${code(ENV_PATH)} would be regenerated from ${PRINT_COMMAND}; nothing was written.`,
    ];
  }
  return [
    ...lines,
    `- ${blocks} in ${code(ENV_PATH)} regenerated from ${PRINT_COMMAND}: ${children.modules} children pinned, ${children.calls} call lines, keyed by the bumped versions. The image build on this pull request verifies both blocks against what it resolves.`,
    childListLine(children),
  ];
}

/**
 * The Markdown the workflow puts in the pull request body. `children` is
 * the childRecordReport of a regenerated record, `{ dryRun: true }` when the
 * run would have regenerated it, or null when it did not need to; the
 * section is only written when a pin moved.
 */
export function summarize({ results, today, children = null }) {
  const moved = results.filter((result) => result.moved);
  return [
    `### Azure Verified Module pins, checked ${today}`,
    '',
    headline(results, moved, today),
    '',
    '| Module | Pinned | Registry | Release notes |',
    '| --- | --- | --- | --- |',
    ...results.map(tableRow),
    ...moved.flatMap(bumpSection),
    ...(moved.length > 0 ? childrenSection(children) : []),
    '',
  ].join('\n');
}
