#!/usr/bin/env node
/**
 * Is every AWS and Google Cloud module the Landing Zone Builder pins a
 * release that was actually published? (#1869)
 *
 * WHY. The builder writes `module` blocks pinned to an exact release of a
 * Terraform registry module. In #1862 one pin named network-firewall 1.1.0,
 * a release that was never published, and `terraform init` failed for every
 * learner who downloaded the AWS pack. The offline test
 * (src/lib/landingZone/hcl/cloudModuleVersions.test.js) cannot see that,
 * because CI does not call the registry. This does, once a week, from
 * .github/workflows/check-cloud-module-pins.yml.
 *
 * WHAT IT DOES. For each entry of AWS_MODULES and GCP_MODULES it reads the
 * registry's list of releases (registry.terraform.io/v1/modules/<namespace>/
 * <name>/<provider>/versions, with any `//submodule` taken off the source).
 *
 *   - The pin is not in the list: FAIL, naming the module.
 *   - A newer release exists: a warning, not a failure. It then reads that
 *     release's versions.tf from GitHub (the repository and tag the registry
 *     names for it) and says where it differs from the `requires` recorded
 *     beside the pin.
 *   - The registry or GitHub cannot be reached, times out, or answers
 *     something it cannot read: the check fails as "could not finish". It
 *     never reports a pin it did not check as fine.
 *
 * Usage (bash, from frontend/):
 *   node scripts/check-cloud-module-pins.mjs [--summary report.md]
 *
 * Exit codes: 0 every pin is published; 1 a pin is not published; 2 the
 * check could not finish. No secret is needed: both sites are public.
 *
 * The offline logic is in cloud-module-pins.mjs; this file is the fetching.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { AWS_MODULES } from '../src/lib/landingZone/hcl/aws/moduleVersions.js';
import { GCP_MODULES } from '../src/lib/landingZone/hcl/gcp/moduleVersions.js';
import {
  CheckError,
  exitCodeFor,
  judgePin,
  listedVersions,
  logLines,
  newerWarning,
  parseVersionsTf,
  registryAddress,
  releaseUrl,
  requiresDrift,
  summarize,
  versionsTfUrl,
  versionsUrl,
} from './cloud-module-pins.mjs';

export * from './cloud-module-pins.mjs';

export const PACKS = Object.freeze([
  { cloud: 'AWS', modules: AWS_MODULES },
  { cloud: 'GCP', modules: GCP_MODULES },
]);

const USER_AGENT =
  'HCW-HybridCloudWorks check-cloud-module-pins (+https://github.com/saulpatinojr/HCW-HybridCloudWorks)';

/** How long one request may take, and how many tries it gets. */
export const TIMEOUT_MS = 20_000;
export const ATTEMPTS = 2;

/** A 404, kept apart because "not there" is an answer, not an outage. */
class NotFound extends Error {}

/**
 * GET a URL and return its body as text. A network error, a timeout, a 429
 * or a 5xx is tried once more; anything still wrong throws CheckError (or
 * NotFound for a 404) with one sentence naming the URL.
 */
export async function fetchText(
  url,
  { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, attempts = ATTEMPTS } = {}
) {
  let last = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      last =
        error?.name === 'TimeoutError'
          ? `no answer within ${timeoutMs / 1000} seconds`
          : `the request failed (${error?.message ?? error})`;
      continue;
    }
    if (response.status === 404) throw new NotFound(url);
    if (response.ok) return response.text();
    last = `it answered HTTP ${response.status}`;
    if (response.status !== 429 && response.status < 500) break;
  }
  throw new CheckError(`${url} could not be read: ${last}.`);
}

async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new CheckError(`${url} did not answer with JSON.`);
  }
}

/** For a newer release: where its versions.tf differs from the recorded `requires`. */
async function newerReleaseWarning(address, module, newest, options) {
  const release = await fetchJson(releaseUrl(address, newest), options);
  const url = versionsTfUrl(release?.source, release?.tag, address.submodule);
  if (!url) {
    return newerWarning({
      version: module.version,
      newest,
      unread: `The registry names no GitHub repository and tag for it (${release?.source ?? 'no source'}), so its versions.tf was not read.`,
    });
  }
  let text;
  try {
    text = await fetchText(url, options);
  } catch (error) {
    if (!(error instanceof NotFound)) throw error;
    return newerWarning({
      version: module.version,
      newest,
      unread: `It has no versions.tf at ${url}, so what it asks for was not read; read the release by hand.`,
    });
  }
  const drift = requiresDrift(module.requires, parseVersionsTf(text));
  return newerWarning({ version: module.version, newest, drift });
}

/**
 * Check one pin. Never throws: a problem becomes a result with status
 * `missing` or `error`, so one bad module does not hide the others.
 */
export async function checkPin(cloud, key, module, options = {}) {
  const base = { cloud, key, source: module.source, version: module.version, newest: null };
  try {
    const address = registryAddress(module.source);
    let versions;
    try {
      versions = listedVersions(await fetchJson(versionsUrl(address), options), module.source);
    } catch (error) {
      if (!(error instanceof NotFound)) throw error;
      return {
        ...base,
        status: 'missing',
        message: `the registry has no module called ${address.namespace}/${address.name}/${address.provider}.`,
      };
    }
    const { published, newest, newer } = judgePin(module.version, versions);
    if (!published) {
      return {
        ...base,
        newest,
        status: 'missing',
        message: `${module.version} is not a published release of ${module.source}; the newest is ${newest ?? 'unknown'}.`,
      };
    }
    const warnings = newer ? [await newerReleaseWarning(address, module, newest, options)] : [];
    return { ...base, newest, newer, status: 'ok', warnings };
  } catch (error) {
    if (error instanceof CheckError || error instanceof NotFound) {
      const message = error instanceof NotFound ? `${error.message} answered 404.` : error.message;
      return { ...base, status: 'error', message };
    }
    throw error;
  }
}

/** Check every pin of every pack, one at a time (seven requests or so). */
export async function checkPins({ packs = PACKS, ...options } = {}) {
  const results = [];
  for (const { cloud, modules } of packs) {
    for (const [key, module] of Object.entries(modules)) {
      results.push(await checkPin(cloud, key, module, options));
    }
  }
  return results;
}

export function parseArgs(argv) {
  const args = { summary: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--summary' && argv[i + 1]) {
      args.summary = argv[i + 1];
      i += 1;
    } else {
      throw new CheckError(
        `Unknown argument "${argv[i]}". Usage: node scripts/check-cloud-module-pins.mjs [--summary report.md]`
      );
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2), { fetchImpl = fetch } = {}) {
  const args = parseArgs(argv);
  const results = await checkPins({ fetchImpl });
  for (const line of logLines(results)) console.log(line);
  const report = summarize(results, { checkedOn: new Date().toISOString().slice(0, 10) });
  if (args.summary) writeFileSync(args.summary, report);
  const exit = exitCodeFor(results);
  if (exit === 1) console.error('A pinned module release is not published; see the FAIL lines.');
  if (exit === 2) console.error('The check could not finish; see the ERROR lines.');
  return exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error?.message ?? error);
      process.exitCode = 2;
    }
  );
}
