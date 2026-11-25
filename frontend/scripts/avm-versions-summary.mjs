/**
 * The Markdown the AVM pin updater puts in its pull request body (#671;
 * moved out of avm-versions-edits.mjs by #1845): a table of every pin, one
 * section per pin that moved, and what happened to the child record. Pure,
 * like the edits; update-avm-versions.mjs re-exports summarize.
 */
import { envKeyFor } from './avm-versions-edits.mjs';

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

/**
 * One line when the smoke payload's block for this module moved with it:
 * an exact pin, or a window or `~>` the release had left (#1658). It names
 * the constraint before and after, not the module's versions, because a
 * window moves differently from the pin (the first run after #1658 called a
 * window an exact pin).
 */
function payloadLine(result) {
  if (!result.smokePinMoved) return null;
  const from = result.smokeFrom ?? result.from;
  const to = result.smokeTo ?? result.to;
  const added = result.smokeAdded ?? [];
  const inputs = added.length
    ? ` It also now sets ${added.map(code).join(', ')}, which this release requires (${code('AVM_REQUIRED_INPUTS')} in ${code(PINS_PATH)}).`
    : '';
  const version =
    from === to
      ? `its block for this module keeps ${code(`version = "${from}"`)}, which the release still meets.`
      : `its block for this module read ${code(`version = "${from}"`)} and now reads ${code(`version = "${to}"`)}, so smoke.sh still rewrites one block per builder module.`;
  return `- ${code(PAYLOAD_PATH)}: ${version}${inputs}`;
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
