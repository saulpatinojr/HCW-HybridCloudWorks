/**
 * record-docker-cli-fixture.mjs — re-record scripts/fixtures/docker-cli-agent-
 * requests.json with the Docker CLI the lab host pins (LAB-5; #949).
 *
 * lab-host-docker-proxy.test.mjs holds the agent's socket proxy to every
 * request the pinned docker CLI makes, and fails when the fixture was recorded
 * with another version than docker_release_pins names. So a host bump that
 * moves Docker Engine has to move the fixture with it, and this is how
 * lab-supply-chain.yml does that, in the step after the bump:
 *
 *   1. read the engine pin for one codename (resolute, the lab host's
 *      release) and the version the fixture records; the same, and this
 *      exits 0 with nothing written;
 *   2. read that codename's Packages index from Docker's apt repository the
 *      way the bumper does — the index's own SHA256 checked against the
 *      signed InRelease — and take the docker-ce-cli .deb at the pinned
 *      version string, with the SHA256 the index lists for it;
 *   3. download the .deb, refuse it unless it hashes to that SHA256, and
 *      extract it into a temporary directory (`dpkg-deb -x`; nothing is
 *      installed on the machine);
 *   4. run scripts/lab/capture-docker-cli-requests.mjs with that directory's
 *      usr/bin first on PATH, so `docker` is the pinned CLI, and check the
 *      fixture now records the pinned version.
 *
 * The CLI is verified the way the host's own install is: the .deb's hash is
 * the one the signed index lists, not a checksum this file would hold. It
 * runs where dpkg is (the ubuntu runner); a workstation without dpkg-deb
 * runs the capture by hand with the pinned CLI, as its header says.
 *
 * Usage: node scripts/lab/record-docker-cli-fixture.mjs [--codename resolute] [--force]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOCKER_APT, DOCKER_CLI_FIXTURE_PATH, GROUP_VARS_PATH, aptIndex, dockerCliDeb, makeHttp } from '../lib/lab-pin-bumps.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CAPTURE_PATH = 'scripts/lab/capture-docker-cli-requests.mjs';

/**
 * The engine version string docker_release_pins names for a codename, and its
 * upstream core, which is what `docker version` reports for the CLI built
 * from it (`5:29.9.0-1~ubuntu.26.04~resolute` → `29.9.0`).
 */
export function pinnedEngine(groupVars, codename = 'resolute') {
  const block = String(groupVars).match(new RegExp(`^ {2}${codename}:\\n((?: {4}.*\\n)+)`, 'm'));
  const version = block?.[1].match(/^ {4}engine: "([^"]+)"$/m)?.[1];
  if (!version) throw new Error(`docker_release_pins.${codename}.engine not found in ${GROUP_VARS_PATH}`);
  const core = version.match(/^(?:\d+:)?(\d+\.\d+\.\d+)-/)?.[1];
  if (!core) throw new Error(`${version} is not an epoch:upstream-revision Debian version`);
  return { version, core };
}

/** The CLI version a fixture records, or null for a file that is not one. */
export function recordedCli(fixtureText) {
  try {
    const cli = JSON.parse(String(fixtureText))?.dockerCli;
    return typeof cli === 'string' ? cli : null;
  } catch {
    return null;
  }
}

const flag = (argv, name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

async function main(argv) {
  const codename = flag(argv, '--codename') ?? 'resolute';
  const force = argv.includes('--force');
  const { version, core } = pinnedEngine(readFileSync(path.join(REPO, GROUP_VARS_PATH), 'utf8'), codename);
  const fixtureAt = path.join(REPO, DOCKER_CLI_FIXTURE_PATH);
  const recorded = recordedCli(readFileSync(fixtureAt, 'utf8'));
  if (recorded === core && !force) {
    process.stdout.write(`${DOCKER_CLI_FIXTURE_PATH} already records docker CLI ${core}; nothing to do\n`);
    return 0;
  }

  const http = makeHttp(fetch);
  const index = await aptIndex(http, DOCKER_APT, `dists/${codename}`, 'stable');
  const deb = dockerCliDeb(index.text, version);
  const { body } = await http.raw(deb.url);
  const hex = createHash('sha256').update(body).digest('hex');
  if (hex !== deb.sha256) throw new Error(`${deb.url} hashes to ${hex}, but ${index.packagesUrl} lists ${deb.sha256}`);

  const work = mkdtempSync(path.join(os.tmpdir(), 'docker-cli-'));
  try {
    const debAt = path.join(work, 'docker-ce-cli.deb');
    writeFileSync(debAt, body);
    execFileSync('dpkg-deb', ['-x', debAt, work], { stdio: 'inherit' });
    const bin = path.join(work, 'usr', 'bin');
    execFileSync(process.execPath, [path.join(REPO, CAPTURE_PATH), fixtureAt], {
      stdio: 'inherit',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const now = recordedCli(readFileSync(fixtureAt, 'utf8'));
  if (now !== core) throw new Error(`the fixture now records docker CLI ${now}, not the pinned ${core}`);
  process.stdout.write(
    `re-recorded ${DOCKER_CLI_FIXTURE_PATH} with docker CLI ${core} (${deb.url}, SHA256 ${deb.sha256} as ${index.packagesUrl} lists)\n`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`record-docker-cli-fixture: ${error.message}\n`);
      process.exit(1);
    });
}
