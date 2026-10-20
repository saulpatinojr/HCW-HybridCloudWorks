/**
 * Bump the Azure Verified Module pins when the Terraform Registry has a newer
 * release (#671, Phase 5 of #657).
 *
 * The Landing Zone Builder emits `module` blocks pinned to the versions in
 * src/lib/landingZone/avmVersions.js, and the lab image vendors the same
 * modules at the same versions from lab-image/versions.env (#658). Both files
 * say the pins were "looked up, not remembered"; this script is what keeps
 * that true without a human remembering to look.
 *
 * What it does, in order:
 *
 *   1. Reads AVM_MODULES out of avmVersions.js (imported as ESM; the module
 *      is pure) and asks `https://registry.terraform.io/v1/modules/Azure/
 *      <name>/azurerm` for each module's latest release.
 *   2. For a module the registry lists at a newer release: rewrites that one
 *      `avm('<name>', '<version>', …)` pin with a targeted text edit, stamps
 *      AVM_VERIFIED_ON with today's UTC date, downloads the release source
 *      tarball from GitHub (which is also the proof the tag exists) and, where
 *      lab-image/versions.env vendors the module, rewrites its `_VERSION` and
 *      `_SHA256` lines with the new version and the tarball's SHA256 — the
 *      same sum `sha256sum` prints and the Dockerfile checks. Where the
 *      smoke payload (lab-image/smoke/terraform-validate-payload/main.tf)
 *      pins the module's block to the exact old version, that pin moves too;
 *      its constraint blocks are left alone.
 *   3. When a vendored module moved, regenerates the image's record of what
 *      each builder module calls (#1306). AVM_CHILD_CALLS in versions.env is
 *      keyed by each builder module's version, so step 2 alone leaves the
 *      new version with no line, the static vendoring test red and the image
 *      build failing in its vendor stage; what a new release calls is only
 *      known once that stage resolves it. So this runs the stage the way the
 *      README says a human does — `docker build --target vendor --build-arg
 *      AVM_PRINT_PINS=1 --progress=plain lab-image`, with its log on stderr
 *      so a failed build is read in the job output — and splices the
 *      AVM_CHILD_MODULES and AVM_CHILD_CALLS blocks it prints over the two in
 *      versions.env, touching no other line. LAB_IMAGE_CHILD_AVM in
 *      labImage.js is the builder's copy of the child list, so it is
 *      rewritten to match when the list changed. A build that fails, or
 *      prints something that is not the two blocks keyed by the versions the
 *      file now pins, ends the run with exit code 1 before anything stale
 *      could reach a pull request. `--children <log>` splices from a saved
 *      `--progress=plain` log instead of running Docker.
 *   4. Prints a Markdown summary: every module's pinned and registry version,
 *      each bump's old → new with a link to the GitHub release notes,
 *      whether the release's `required_providers` differ from the pinned
 *      `requiredProviders`, because that is the edit this script does NOT
 *      make (see below), and what the regenerated child record says.
 *
 * Exit code 0 and no writes when nothing moved. `--dry-run` prints without
 * writing, and does not run Docker. `--summary <path>` also writes the
 * summary to a file, which the workflow carries into the pull request body.
 *
 * WHAT IT DOES NOT DO, on purpose. AVM input names drift between versions,
 * and so do provider constraints. The script edits version strings, a
 * checksum and the two child blocks the build prints; it does not touch
 * `requiredProviders`, PROVIDER_PINS, the docblocks that quote each module's
 * constraints, or the HCL emitters. The workflow refreshes the snapshot
 * tests after a bump so the pull request carries the Terraform diff, and a
 * human reads the module's release notes against that diff before merging.
 * That review is the gate; this is the reminder.
 *
 * Every registry response is validated before it is believed: a `version`
 * that is not `MAJOR.MINOR.PATCH`, or whose `tag` is not `v<version>`, ends
 * the run with exit code 1 and one sentence, and nothing is written.
 *
 * TWO FILES. This one owns everything that touches the network, the
 * filesystem, Docker or the clock; avm-versions-edits.mjs owns the version
 * comparison, the registry-document validation, the text edits (the pins,
 * the versions file, the child blocks and the builder's child list), the
 * reading of the vendor stage's print-out and the summary, and is
 * re-exported here so a test imports from one place.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import prettier from 'prettier';

import { AVM_MODULES } from '../src/lib/landingZone/avmVersions.js';
import {
  EditRefused,
  RegistryError,
  UNKNOWN_DRIFT,
  VendorError,
  childRecordReport,
  envVendors,
  isNewer,
  latestFromRegistry,
  parsePrintedPins,
  providerDrift,
  providersAt,
  registryModuleUrl,
  registryVersionsUrl,
  releaseNotesUrl,
  rewriteChildBlocks,
  rewriteChildList,
  rewriteEnv,
  rewritePin,
  rewriteSmokePin,
  stampVerifiedOn,
  summarize,
  tarballUrl,
  terraformTfUrl,
} from './avm-versions-edits.mjs';

export * from './avm-versions-edits.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');

export const PINS_FILE = path.join(frontendRoot, 'src', 'lib', 'landingZone', 'avmVersions.js');
export const LAB_IMAGE_FILE = path.join(frontendRoot, 'src', 'lib', 'landingZone', 'labImage.js');
export const VERSIONS_ENV_FILE = path.join(repoRoot, 'lab-image', 'versions.env');
export const SMOKE_PAYLOAD_FILE = path.join(
  repoRoot,
  'lab-image',
  'smoke',
  'terraform-validate-payload',
  'main.tf'
);

/**
 * The vendor stage in print mode, as lab-image/README.md "Updating a
 * version" has it, plus `--no-cache-filter vendor`: the stage's inputs
 * change with the bump so BuildKit would rebuild it anyway, but a cached
 * stage prints nothing, and a print-out with no blocks is a failure this
 * script would rather not be able to produce.
 */
export const VENDOR_BUILD_ARGS = Object.freeze([
  'build',
  '--target',
  'vendor',
  '--build-arg',
  'AVM_PRINT_PINS=1',
  '--progress=plain',
  '--no-cache-filter',
  'vendor',
  'lab-image',
]);

const USER_AGENT =
  'HCW-HybridCloudWorks update-avm-versions (+https://github.com/saulpatinojr/HCW-HybridCloudWorks)';

// --- fetching ---------------------------------------------------------------

/**
 * A GET that either returns an OK response or throws RegistryError with one
 * sentence. `describeStatus` turns a non-2xx status into that sentence, so
 * a 404 on a tarball can say "GitHub has no tag" rather than just "404".
 */
async function fetchOk(url, fetchImpl, headers, describeStatus) {
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new RegistryError(
      `${url} could not be fetched (${error.message}), so nothing was written.`
    );
  }
  if (!response.ok) throw new RegistryError(describeStatus(response.status));
  return response;
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchOk(
    url,
    fetchImpl,
    { accept: 'application/json', 'user-agent': USER_AGENT },
    (status) => `${url} answered HTTP ${status}, so nothing was written.`
  );
  return response.json().catch(() => {
    throw new RegistryError(`${url} did not return JSON, so nothing was written.`);
  });
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * The SHA256 of the release source tarball, computed from the bytes GitHub
 * serves — the same value `sha256sum` prints for the download and the value
 * the lab image's Dockerfile checks before it unpacks anything.
 */
export async function fetchTarballSha256(name, version, fetchImpl = fetch) {
  const url = tarballUrl(name, version);
  const response = await fetchOk(
    url,
    fetchImpl,
    { 'user-agent': USER_AGENT },
    (status) =>
      `${url} answered HTTP ${status}: the registry lists ${name} ${version} but GitHub has no tag v${version}, so nothing was written.`
  );
  return sha256Hex(await response.arrayBuffer());
}

// --- checking and applying --------------------------------------------------

/** The provider drift for a moved module, from the registry's versions document. */
async function driftFor(module, version, fetchImpl) {
  const versions = await fetchJson(registryVersionsUrl(module.name), fetchImpl);
  return providerDrift([...module.requiredProviders], providersAt(versions, version));
}

async function checkModule(module, fetchImpl) {
  const latest = latestFromRegistry(
    await fetchJson(registryModuleUrl(module.name), fetchImpl),
    module.name
  );
  const moved = isNewer(latest.version, module.version);
  return {
    name: module.name,
    from: module.version,
    to: latest.version,
    moved,
    publishedAt: latest.publishedAt,
    requiredProviders: [...module.requiredProviders],
    drift: moved ? await driftFor(module, latest.version, fetchImpl) : UNKNOWN_DRIFT,
    releaseNotes: releaseNotesUrl(module.name, latest.version),
    terraformTf: terraformTfUrl(module.name, latest.version),
    vendored: null,
    sha256: null,
    smokePinMoved: null,
  };
}

/**
 * One result per pinned module: what is pinned, what the registry lists, and
 * whether the two differ. Only reads; nothing here writes.
 */
export async function checkModules({ modules = AVM_MODULES, fetchImpl = fetch } = {}) {
  const results = [];
  for (const module of Object.values(modules)) {
    results.push(await checkModule(module, fetchImpl));
  }
  return results;
}

/**
 * Apply one bump to the three files' text: the pin, the image's version and
 * sum lines, and the smoke payload's exact pin where its block for the
 * module has one. Downloads the tarball even when the lab image does not
 * vendor the module, because the download is also the proof that the
 * registry's version exists as a tag on GitHub — the cross-check
 * avmVersions.js says every pin has had.
 */
async function applyBump(state, result, fetchImpl) {
  const pinsSource = rewritePin(state.pinsSource, result.name, result.from, result.to);
  result.sha256 = await fetchTarballSha256(result.name, result.to, fetchImpl);
  result.vendored = envVendors(state.envSource, result.name);
  const envSource = result.vendored
    ? rewriteEnv(state.envSource, result.name, result.from, result.to, result.sha256)
    : state.envSource;
  const payload = rewriteSmokePin(state.payloadSource, result.name, result.from, result.to);
  result.smokePinMoved = payload.moved;
  return { pinsSource, envSource, payloadSource: payload.source };
}

/** Apply every bump, then stamp the date once if anything moved. */
export async function applyChanges({
  results,
  pinsSource,
  envSource,
  payloadSource = '',
  today,
  fetchImpl = fetch,
}) {
  const moved = results.filter((result) => result.moved);
  let state = { pinsSource, envSource, payloadSource };
  for (const result of moved) {
    state = await applyBump(state, result, fetchImpl);
  }
  if (moved.length > 0) state.pinsSource = stampVerifiedOn(state.pinsSource, today);
  return { ...state, results };
}

// --- the child record -------------------------------------------------------

/**
 * Run the vendor stage in print mode from the repository root and resolve
 * with everything it wrote, stdout and stderr in arrival order. Every byte
 * is also echoed to `echo` (stderr) as it arrives, so the job output holds
 * the whole build log whether or not the build succeeds. A non-zero exit, or
 * a `docker` that cannot be started, rejects with VendorError.
 */
export function printChildPins({ spawnImpl = spawn, cwd = repoRoot, echo = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const collect = (chunk) => {
      chunks.push(Buffer.from(chunk));
      echo.write(chunk);
    };
    const child = spawnImpl('docker', [...VENDOR_BUILD_ARGS], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      reject(
        new VendorError(
          `docker could not be run (${error.message}), so the child blocks were not regenerated and nothing more was written.`
        )
      );
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new VendorError(
            `docker ${VENDOR_BUILD_ARGS.join(' ')} exited ${code}; its log is above, and the child blocks were not regenerated.`
          )
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/**
 * The regenerated versions.env and labImage.js from a vendor-stage
 * print-out, with the report for the summary. Pure: the caller supplies the
 * log and both sources. labImage.js is rewritten only when the child list
 * changed, so a bump that left it alone leaves the file byte for byte.
 */
export function recordChildren({ log, envSource, labImageSource }) {
  const blocks = parsePrintedPins(log);
  const nextEnv = rewriteChildBlocks(envSource, blocks);
  const report = childRecordReport(envSource, blocks);
  const listChanged = report.added.length > 0 || report.removed.length > 0;
  return {
    envSource: nextEnv,
    labImageSource: listChanged ? rewriteChildList(labImageSource, blocks) : labImageSource,
    report,
  };
}

// --- entry point -----------------------------------------------------------

const USAGE =
  'Usage: node scripts/update-avm-versions.mjs [--dry-run] [--summary <path>] [--children <docker build log>]';

const ARG_HANDLERS = {
  '--dry-run': (args) => {
    args.dryRun = true;
    return 0;
  },
  '--summary': (args, next) => {
    args.summaryPath = next || null;
    return 1;
  },
  '--children': (args, next) => {
    args.childrenPath = next || null;
    return 1;
  },
};

export function parseArgs(argv) {
  const args = { dryRun: false, summaryPath: null, childrenPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const handler = ARG_HANDLERS[argv[index]];
    if (!handler) throw new TypeError(`Unknown argument ${argv[index]}. ${USAGE}`);
    index += handler(args, argv[index + 1]);
  }
  return args;
}

export const todayIso = () => new Date().toISOString().slice(0, 10);

/** Prettier, with the repository's config, as `npm run format` would write the file. */
async function formatted(source, file) {
  return prettier.format(source, { ...(await prettier.resolveConfig(file)), filepath: file });
}

/** Write the bumped files, Prettier-formatting the pins; returns what was written. */
async function writeChanges(next, { envSource, payloadSource }) {
  await fs.writeFile(PINS_FILE, await formatted(next.pinsSource, PINS_FILE));
  const written = [path.relative(repoRoot, PINS_FILE)];
  if (next.envSource !== envSource) {
    await fs.writeFile(VERSIONS_ENV_FILE, next.envSource);
    written.push(path.relative(repoRoot, VERSIONS_ENV_FILE));
  }
  if (next.payloadSource !== payloadSource) {
    await fs.writeFile(SMOKE_PAYLOAD_FILE, next.payloadSource);
    written.push(path.relative(repoRoot, SMOKE_PAYLOAD_FILE));
  }
  return written;
}

/**
 * Regenerate the child record for a bump that moved a vendored module. Runs
 * AFTER writeChanges, because the vendor stage reads lab-image/versions.env
 * from disk and must see the new pins; a saved log (`--children`) needs
 * nothing from disk. Writes versions.env again with the blocks, and
 * labImage.js when the child list changed; returns the report and what it
 * wrote. A dry run with no saved log reports what it would do and runs
 * nothing.
 */
async function regenerateChildren({ envSource, childrenPath, dryRun }) {
  if (dryRun && !childrenPath) return { children: { dryRun: true }, written: [] };
  const log = childrenPath ? await fs.readFile(childrenPath, 'utf8') : await printChildPins();
  const labImageSource = await fs.readFile(LAB_IMAGE_FILE, 'utf8');
  const next = recordChildren({ log, envSource, labImageSource });
  const written = [];
  if (!dryRun) {
    await fs.writeFile(VERSIONS_ENV_FILE, next.envSource);
    written.push(path.relative(repoRoot, VERSIONS_ENV_FILE));
    if (next.labImageSource !== labImageSource) {
      await fs.writeFile(LAB_IMAGE_FILE, await formatted(next.labImageSource, LAB_IMAGE_FILE));
      written.push(path.relative(repoRoot, LAB_IMAGE_FILE));
    }
  }
  return { children: next.report, written };
}

function describeRun(movedCount, dryRun, written) {
  if (movedCount === 0) return 'No pin moved; nothing was written.';
  if (dryRun) return `Dry run: ${movedCount} pin(s) would move; nothing was written.`;
  return `Rewrote ${written.join(' and ')}.`;
}

export async function main(argv = process.argv.slice(2)) {
  const { dryRun, summaryPath, childrenPath } = parseArgs(argv);
  const today = todayIso();

  const results = await checkModules({ fetchImpl: fetch });
  const pinsSource = await fs.readFile(PINS_FILE, 'utf8');
  const envSource = await fs.readFile(VERSIONS_ENV_FILE, 'utf8');
  const payloadSource = await fs.readFile(SMOKE_PAYLOAD_FILE, 'utf8');
  const next = await applyChanges({
    results,
    pinsSource,
    envSource,
    payloadSource,
    today,
    fetchImpl: fetch,
  });
  const movedCount = results.filter((result) => result.moved).length;

  const written =
    movedCount > 0 && !dryRun ? await writeChanges(next, { envSource, payloadSource }) : [];
  // Only a moved builder module changes what the vendor stage prints, so a
  // bump the image does not vendor keeps the record it has.
  let children = null;
  if (movedCount > 0 && next.envSource !== envSource) {
    const regenerated = await regenerateChildren({
      envSource: next.envSource,
      childrenPath,
      dryRun,
    });
    children = regenerated.children;
    for (const file of regenerated.written) if (!written.includes(file)) written.push(file);
  }

  const summary = summarize({ results, today, children });
  if (summaryPath) await fs.writeFile(summaryPath, summary);

  console.log(describeRun(movedCount, dryRun, written));
  console.log('');
  console.log(summary);
}

/** One sentence for a source failure or a refused edit; the stack for a bug. */
const isOperatorError = (error) =>
  [RegistryError, EditRefused, VendorError, TypeError].some((kind) => error instanceof kind);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(isOperatorError(error) ? error.message : error);
    process.exit(1);
  });
}
