/**
 * Version floors: every runtime, OS and base image this repository chooses is
 * on its newest supported release, with one tolerance per kind (#715, #714).
 *
 * The floors live in scripts/version-floors.json, one entry per kind, each
 * with the newest release, the floor derived from it, the date it was read and
 * the URL it was read from. This module is the other half: it judges every
 * pin the repository actually carries against those floors.
 *
 *   - version-floors.test.mjs runs it against the real tree, so a pin that
 *     falls behind fails CI naming the file, the pin and the floor.
 *   - update-version-floors.mjs moves the floors when endoflife.date lists a
 *     newer release, and with them every pin proposeMove() can move: an
 *     engines.node range left behind within its line. The pull request it
 *     opens goes red only on the pins a person has to move (an exact pin
 *     with its digest or checksum, or a new line), and names each one.
 *
 * THREE FILES. lib/version-math.mjs owns the arithmetic (versions, the N-2
 * floors, npm ranges, Terraform constraints); lib/version-pins.mjs owns
 * reading the tree (where a version is chosen and how each place is read);
 * this one owns the rules and re-exports the other two, so a test imports
 * from one place. None of it touches the network or the clock.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareVersions, meetsFloor, npmRangeAdmits, npmRangeMinimum, parseVersion, terraformConstraintAdmits } from './lib/version-math.mjs';

export * from './lib/version-math.mjs';
export { collectPins, readDockerfile, readJobImages, readLabHost, readWorkflow, trackedFiles } from './lib/version-pins.mjs';
export { BUILT_HERE, JOB_IMAGES_FILE } from './lib/version-pins-hosts.mjs';

/**
 * Packages with no engines.node, each with the reason. A package.json that
 * has no engines and no entry here is a finding, so a new package cannot
 * arrive without a floor by accident.
 */
export const ENGINES_EXEMPT = {
  'edge/availability-probe/package.json':
    'A Cloudflare Worker: it runs on workerd, not Node.js, so an engines.node range would describe nothing that runs in production. Its node:test suite runs on the CI row, whose node-version this check governs.',
};

/** Load scripts/version-floors.json from the repository root. */
export function loadFloors(root) {
  return JSON.parse(readFileSync(join(root, 'scripts', 'version-floors.json'), 'utf8'));
}

/** `.github/workflows/ci.yml > verify > functions (azure)` matches that pin and anything beneath it. */
export function selectorMatches(selector, where) {
  return where === selector || where.startsWith(`${selector} > `) || where.startsWith(`${selector} (`);
}

/**
 * The platform ceiling that governs a pin, if any. A workflow's runs-on
 * (a `runner` pin) is always under the runners ceiling; a Node.js pin is under
 * the ceiling whose appliesTo names it.
 */
export function ceilingFor(pin, floors) {
  if (pin.kind === 'ubuntu' && pin.runner) {
    const runners = floors.kinds.ubuntu.platformCeilings?.runners;
    return runners ? { component: 'runners', ...runners } : null;
  }
  if (pin.kind !== 'node') return null;
  const ceilings = Object.entries(floors.kinds.node.platformCeilings ?? {});
  const hit = ceilings.find(([, ceiling]) => ceiling.appliesTo.some((s) => selectorMatches(s, pin.where)));
  return hit ? { component: hit[0], ...hit[1] } : null;
}

/** The message of the first check that failed, or null when every check passed. */
const firstFailure = (checks) => checks.find(([failed]) => failed)?.[1] ?? null;

const lineOf = (version) => String(parseVersion(version)[0]);

/** A functions range must sit on the ceiling line, at or above its floor, and admit nothing newer. */
function rangeAgainstCeiling(range, minimum, ceiling) {
  const shown = `engines.node "${range}"`;
  const next = `${Number(ceiling.line) + 1}.0.0`;
  return firstFailure([
    [
      lineOf(minimum) !== ceiling.line || !meetsFloor(minimum, ceiling.floor),
      `${shown} admits ${minimum}; ${ceiling.platform} holds this component at Node.js ${ceiling.line}, floor ${ceiling.floor}`,
    ],
    [!npmRangeAdmits(range, ceiling.newest), `${shown} does not admit ${ceiling.newest}, the newest Node.js ${ceiling.line}`],
    [npmRangeAdmits(range, next), `${shown} admits Node.js ${Number(ceiling.line) + 1}+, which ${ceiling.platform} does not run`],
  ]);
}

/** Any other range: its lowest admitted version meets the floor, and it admits the newest release. */
function rangeAgainstFloor(range, minimum, kind) {
  const shown = `engines.node "${range}"`;
  return firstFailure([
    [!meetsFloor(minimum, kind.floor), `${shown} admits ${minimum}, below the floor ${kind.floor}`],
    [!npmRangeAdmits(range, kind.newest), `${shown} does not admit ${kind.newest}, the newest release`],
  ]);
}

function judgeRange(range, kind, ceiling) {
  let minimum;
  try {
    minimum = npmRangeMinimum(range);
  } catch (err) {
    return `engines.node "${range}" cannot be read (${err.message})`;
  }
  if (!minimum) return `engines.node "${range}" admits no version`;
  return ceiling ? rangeAgainstCeiling(range, minimum, ceiling) : rangeAgainstFloor(range, minimum, kind);
}

function judgeConstraint(constraint, kind) {
  try {
    return terraformConstraintAdmits(constraint, kind.newest)
      ? null
      : `required_version "${constraint}" does not admit ${kind.newest}, the newest release`;
  } catch (err) {
    return `required_version "${constraint}" cannot be read (${err.message})`;
  }
}

/** A functions pin is exactly on the ceiling line, at or above the line's floor. */
function versionAgainstCeiling(version, ceiling) {
  return firstFailure([
    [
      lineOf(version) !== ceiling.line,
      `${version} must be Node.js ${ceiling.line}: ${ceiling.platform} supports Node.js ${ceiling.line} at most, and the rule is the newest line the platform allows`,
    ],
    [!meetsFloor(version, ceiling.floor), `${version} is below the floor ${ceiling.floor} for Node.js ${ceiling.line}`],
  ]);
}

/**
 * A runs-on is exactly the release the runners ceiling records: an older one
 * is behind, and a newer one is an image GitHub has not made generally
 * available, which carries no SLA.
 */
function runnerAgainstCeiling(version, ceiling) {
  if (version === ceiling.newest) return null;
  const why =
    compareVersions(version, ceiling.newest) < 0
      ? `ubuntu-${ceiling.newest} is the newest LTS ${ceiling.platform} offer as generally available`
      : `${ceiling.platform} do not offer ubuntu-${version} as generally available yet`;
  return `ubuntu-${version} must be ubuntu-${ceiling.newest}: ${why}`;
}

function judgeVersion(pin, kind, ceiling) {
  if (!parseVersion(pin.version)) return `"${pin.raw}" is not a version the floors check can read`;
  if (ceiling?.component === 'runners') return runnerAgainstCeiling(pin.version, ceiling);
  if (ceiling) return versionAgainstCeiling(pin.version, ceiling);
  const shown = pin.codename ? `${pin.version} (${pin.codename})` : pin.version;
  return firstFailure([
    [!meetsFloor(pin.version, kind.floor), `${shown} is below the floor ${kind.floor}`],
    [pin.kind === 'ubuntu' && !/^\d*[02468]\.04$/.test(pin.version), `${pin.version} is an interim release; the rule is the newest LTS only`],
  ]);
}

/**
 * Judge one pin. Returns null when it meets its rule, or one sentence saying
 * what it is, what it must be and why.
 */
export function judge(pin, floors) {
  const kind = floors.kinds[pin.kind];
  if (!kind) return `no floor is recorded for kind "${pin.kind}"`;
  const ceiling = ceilingFor(pin, floors);
  if (pin.range !== undefined) return judgeRange(pin.range, kind, ceiling);
  if (pin.constraint !== undefined) return judgeConstraint(pin.constraint, kind);
  return judgeVersion(pin, kind, ceiling);
}

/** `26.8.0` as a whole version inside a range, not inside `126.8.0` or `26.8.01`. */
const writtenVersion = (version) => new RegExp(`(?<![\\d.])${version.replaceAll('.', '\\.')}(?![\\d.])`, 'g');

/**
 * The range an engines.node pin moves to when its floor moved within its
 * line, or null when the move is not mechanical and stays on the work list.
 *
 * The lowest version the range admits, as it is written, is replaced by the
 * floor that governs the pin (its platform ceiling's, when it has one), and
 * the move stands only when the rule then passes. Nothing else moves: an
 * exact pin carries a digest or checksum this cannot read, a new line's
 * release notes come first, and a range whose minimum is not written out
 * (`^26.8`) is a person's to rewrite.
 */
export function proposeMove(pin, floors) {
  if (pin.kind !== 'node' || pin.range === undefined || judge(pin, floors) === null) return null;
  const floor = ceilingFor(pin, floors)?.floor ?? floors.kinds.node.floor;
  let minimum;
  try {
    minimum = npmRangeMinimum(pin.range);
  } catch {
    return null;
  }
  if (!minimum || meetsFloor(minimum, floor) || lineOf(minimum) !== lineOf(floor)) return null;
  const range = pin.range.replace(writtenVersion(minimum), floor);
  return range !== pin.range && judge({ ...pin, range }, floors) === null ? range : null;
}

/** Ceiling selectors that match no pin: a renamed job would otherwise move a functions pin under the general floor. */
function staleSelectors(floors, pins) {
  return Object.entries(floors.kinds.node.platformCeilings ?? {}).flatMap(([component, ceiling]) =>
    ceiling.appliesTo
      .filter((selector) => !pins.some((p) => p.kind === 'node' && selectorMatches(selector, p.where)))
      .map((selector) => ({
        file: 'scripts/version-floors.json',
        line: 0,
        where: `kinds.node.platformCeilings.${component}.appliesTo`,
        kind: 'node',
        raw: selector,
        message: `"${selector}" matches no Node.js pin; it was renamed or removed, so the ${component} ceiling no longer covers it`,
      }))
  );
}

/** A package.json with no engines.node that is not exempt, or any pin its rule rejects. */
function pinFinding(pin, floors, enginesExempt) {
  if (pin.missing) {
    return Object.hasOwn(enginesExempt, pin.file)
      ? null
      : { ...pin, message: 'no engines.node: every package declares the Node.js floor it runs on' };
  }
  const message = judge(pin, floors);
  return message ? { ...pin, message } : null;
}

/**
 * Every finding in the tree: pins below their floor, pins that cannot be
 * read, and ceiling selectors that no longer match anything.
 */
export function findViolations(floors, { pins, problems }, { enginesExempt = {} } = {}) {
  return [
    ...pins.map((pin) => pinFinding(pin, floors, enginesExempt)).filter(Boolean),
    ...problems,
    ...staleSelectors(floors, pins),
  ];
}

/** `file:line  [kind] where` and the message beneath it, one per finding, for a failing assertion to print. */
export function formatFindings(findings) {
  return findings.map((f) => `${f.file}${f.line ? `:${f.line}` : ''}  [${f.kind}] ${f.where}\n    ${f.message}`).join('\n');
}
