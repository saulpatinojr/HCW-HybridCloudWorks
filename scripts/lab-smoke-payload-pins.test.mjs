/**
 * The smoke payload's connectivity block resolves to the same release
 * online and offline, and passes the inputs that release requires (#1868).
 *
 * lab-image/smoke/terraform-validate-payload/main.tf is validated offline
 * by smoke.sh, where each block resolves to the copy the image vendors
 * (lab-image/versions.env). The connectivity block used to be a window,
 * `>= 0.18.0, < 0.19.0`: offline that was the vendored 0.18.1, but online,
 * with network, Terraform picked the newest 0.18.x. 0.18.2 added a required
 * `location` input that 0.18.1 does not declare, so the same block passed
 * offline and failed online ("The argument "location" is required"), and
 * no block can pass on both: 0.18.1 refuses `location` as an unsupported
 * argument. So the block is pinned to exactly the vendored version, and
 * this file holds it there.
 *
 * It also holds the block to AVM_REQUIRED_INPUTS in avmVersions.js, the
 * hand-written list of inputs a release started to require: every row that
 * applies at the vendored version is set, and none that does not (an input
 * the older release lacks fails `terraform init`). The weekly update adds
 * the input when it moves the pin, so a bump that skipped it is red here.
 *
 * Only reads files; no network and no Terraform. The real validate is
 * smoke.sh in the image build.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AVM_MODULES,
  AVM_REQUIRED_INPUTS,
  requiredInputs,
} from "../frontend/src/lib/landingZone/avmVersions.js";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAYLOAD_PATH = "lab-image/smoke/terraform-validate-payload/main.tf";
const PAYLOAD = readFileSync(
  path.join(
    repo,
    "lab-image",
    "smoke",
    "terraform-validate-payload",
    "main.tf",
  ),
  "utf8",
);
const ENV = readFileSync(path.join(repo, "lab-image", "versions.env"), "utf8");
const CONNECTIVITY = "avm-ptn-alz-connectivity-hub-and-spoke-vnet";

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const envKey = (name) => name.toUpperCase().replace(/-/g, "_");

/** The version versions.env vendors for a builder module, or null. */
function vendoredVersion(env, name) {
  const match = new RegExp(`^${envKey(name)}_VERSION=(\\S+)$`, "m").exec(env);
  return match ? match[1] : null;
}

/** The text of the payload's block for a module: `{ version, body }`, or null. */
function payloadBlock(payload, name) {
  const source = new RegExp(
    `source\\s*=\\s*"Azure/${escaped(name)}/azurerm"`,
  ).exec(payload);
  if (!source) return null;
  // From the `module "…" {` line above the source to the lone `}` below it.
  const start = payload.lastIndexOf('\nmodule "', source.index) + 1;
  const end = payload.indexOf("\n}", source.index);
  const body = payload.slice(start, end === -1 ? payload.length : end + 2);
  const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(body);
  return { body, version: version ? version[1] : null };
}

const sets = (body, input) =>
  new RegExp(`^\\s*${escaped(input)}\\s*=`, "m").test(body);

/** Every way the payload's connectivity block disagrees with the image. One sentence each. */
function connectivityProblems({ payload, env }) {
  const block = payloadBlock(payload, CONNECTIVITY);
  if (!block) return [`${PAYLOAD_PATH} has no block for ${CONNECTIVITY}`];
  const vendored = vendoredVersion(env, CONNECTIVITY);
  const problems = [];
  if (block.version !== vendored) {
    problems.push(
      `${PAYLOAD_PATH} asks for ${CONNECTIVITY} "${block.version}", and the image vendors ${vendored}; pin it to exactly "${vendored}" so online and offline validate the same release`,
    );
  }
  const needed = requiredInputs(CONNECTIVITY, vendored).map((row) => row.input);
  for (const input of needed) {
    if (!sets(block.body, input)) {
      problems.push(
        `${PAYLOAD_PATH}'s ${CONNECTIVITY} block does not set ${input}, which ${vendored} requires`,
      );
    }
  }
  const later = AVM_REQUIRED_INPUTS.filter(
    (row) => row.module === CONNECTIVITY && !needed.includes(row.input),
  );
  for (const row of later) {
    if (sets(block.body, row.input)) {
      problems.push(
        `${PAYLOAD_PATH}'s ${CONNECTIVITY} block sets ${row.input}, which ${vendored} does not declare (it arrived in ${row.since})`,
      );
    }
  }
  return problems;
}

describe("the smoke payload validates the release the image vendors (#1868)", () => {
  it("agrees with the image and the builder", () => {
    expect(connectivityProblems({ payload: PAYLOAD, env: ENV })).toEqual([]);
  });

  it("pins the connectivity block to exactly the builder pin and the vendored version", () => {
    const { version } = payloadBlock(PAYLOAD, CONNECTIVITY);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).toBe(vendoredVersion(ENV, CONNECTIVITY));
    expect(version).toBe(AVM_MODULES[CONNECTIVITY].version);
  });
});

describe("the check goes red on the drift #1868 found", () => {
  const vendored = vendoredVersion(ENV, CONNECTIVITY);
  const withVersion = (payload, version) =>
    payload.replace(
      new RegExp(
        `(source\\s*=\\s*"Azure/${escaped(CONNECTIVITY)}/azurerm"\\s*\\n\\s*version\\s*=\\s*")[^"]+(")`,
      ),
      `$1${version}$2`,
    );
  const withEnv = (version) =>
    ENV.replace(
      new RegExp(`^(${envKey(CONNECTIVITY)}_VERSION=)\\S+$`, "m"),
      `$1${version}`,
    );
  const withLocation = (payload) =>
    payload.replace(
      new RegExp(
        `(source\\s*=\\s*"Azure/${escaped(CONNECTIVITY)}/azurerm"\\s*\\n\\s*version\\s*=\\s*"[^"]+")`,
      ),
      '$1\n\n  location = "centralus"',
    );

  it("fails the window the payload had, which resolves differently online", () => {
    const payload = withVersion(PAYLOAD, ">= 0.18.0, < 0.19.0");
    expect(connectivityProblems({ payload, env: ENV })).toEqual([
      `${PAYLOAD_PATH} asks for ${CONNECTIVITY} ">= 0.18.0, < 0.19.0", and the image vendors ${vendored}; pin it to exactly "${vendored}" so online and offline validate the same release`,
    ]);
  });

  it("fails a bump to 0.18.4 that left location out, and passes it with location", () => {
    const payload = withVersion(PAYLOAD, "0.18.4");
    const env = withEnv("0.18.4");
    expect(connectivityProblems({ payload, env })).toEqual([
      `${PAYLOAD_PATH}'s ${CONNECTIVITY} block does not set location, which 0.18.4 requires`,
    ]);
    expect(
      connectivityProblems({ payload: withLocation(payload), env }),
    ).toEqual([]);
  });

  it("fails location on 0.18.1, which does not declare it", () => {
    const payload = withLocation(withVersion(PAYLOAD, "0.18.1"));
    expect(connectivityProblems({ payload, env: withEnv("0.18.1") })).toEqual([
      `${PAYLOAD_PATH}'s ${CONNECTIVITY} block sets location, which 0.18.1 does not declare (it arrived in 0.18.2)`,
    ]);
  });
});
