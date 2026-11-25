/**
 * The lab image vendors every module the Landing Zone Builder can emit, at
 * every version it can emit (ADR 0032 decision 5).
 *
 * Found 2026-09-27 (#737): the builder's spokes call
 * avm-res-network-virtualnetwork 0.22.2 and the image carried only 0.15.0,
 * as a child of the connectivity module, so the full default build could not
 * `terraform init` under `--network none`. Nothing compared the builder's
 * pins with what the image vendors; this does, in the `scripts (operations)`
 * CI job, whose filter already covers avmVersions.js and lab-image/. The
 * image-side half is smoke.sh (every builder module and recorded child is on
 * disk and inits offline) and sandbox-check.mjs (the builder's real default
 * build validates offline under the job sandbox).
 *
 * The check itself is scripts/lib/avm-vendoring.mjs. Which vendored copy a
 * block resolves to is the builder's own port of the image's rule
 * (frontend/src/lib/landingZone/labImage.js and tfConstraints.js), whose
 * constraint table labImage.test.js holds to tf_constraints.py; it is not
 * restated here. The last group below feeds the check a bumped pin and a
 * lost child and expects it to go red, so the gate is shown to fire rather
 * than assumed to.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AVM_MODULES } from '../frontend/src/lib/landingZone/avmVersions.js';
import { chooseVendored, vendoredModules } from '../frontend/src/lib/landingZone/tfConstraints.js';
import {
  builderModules,
  childCalls,
  childPins,
  vendoredEntries,
  vendoringProblems,
} from './lib/avm-vendoring.mjs';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(repo, ...parts), 'utf8');

const ENV = read('lab-image', 'versions.env');
const FIXTURE = read('lab-image', 'smoke', 'terraform-validate-payload', 'main.tf');
const MODULES = Object.values(AVM_MODULES);

describe('the lab image vendors what the Landing Zone Builder emits', () => {
  it('has no gap between avmVersions.js and lab-image/versions.env', () => {
    expect(vendoringProblems({ modules: MODULES, env: ENV, fixture: FIXTURE })).toEqual([]);
  });

  it('vendors each pinned module as a builder module at the pinned version, with a tarball sum', () => {
    const vendored = builderModules(ENV);
    expect(vendored.map((m) => `${m.name}@${m.version}`).sort()).toEqual(
      MODULES.map((m) => `${m.name}@${m.version}`).sort()
    );
    for (const m of vendored) expect(m.sha256, m.name).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records what every pinned version calls, and pins every child it records', () => {
    const calls = childCalls(ENV);
    const pins = childPins(ENV);
    // A child at a builder module's exact name@version is that builder's own
    // directory, so vendor-avm.sh records the call and pins nothing for it.
    const builders = new Set(MODULES.map((m) => `${m.name}@${m.version}`));
    for (const m of MODULES) {
      const children = calls.get(`${m.name}@${m.version}`);
      expect(children, `${m.name}@${m.version} in AVM_CHILD_CALLS`).toBeDefined();
      for (const child of children) {
        expect(pins.has(child) || builders.has(child), `${child} in AVM_CHILD_MODULES`).toBe(true);
      }
    }
  });

  // The case #737 found, named so a reader can find it: the spokes' version
  // and the connectivity module's child are two directories, and a spoke's
  // exact pin resolves to its own.
  it("carries the spokes' virtual network module beside the connectivity module's older copy", () => {
    const { name, version } = AVM_MODULES['avm-res-network-virtualnetwork'];
    const vendored = vendoredModules(vendoredEntries(ENV));
    const versions = vendored[name].map((v) => v.text);
    expect(versions).toContain(version);
    expect(versions.length).toBeGreaterThan(1);
    expect(chooseVendored(vendored, name, version)).toBe(version);
    expect(chooseVendored(vendored, name, `>= ${versions[0]}`)).toBe(version);
  });
});

// The versions below are read from the pins, not remembered (#1287, #1300):
// the weekly bumper runs this file after a bump, and a literal `0.22.2`
// here would fail the bump that moved it with a perfect record in hand.
describe('lab-image/README.md names no module version the weekly bump moves (#1594)', () => {
  // The weekly update-avm-versions.yml moves the pins in versions.env and
  // avmVersions.js, and nothing rewrites the README, which is how it fell three
  // versions behind before #1590. So the README names modules without their
  // versions and points to versions.env; this keeps a version from coming back.
  const README = read('lab-image', 'README.md');
  const VERSIONED = /\bavm-[a-z0-9-]+@\d+\.\d+\.\d+/g;

  it('writes no avm-<name>@<version> in the README', () => {
    expect(README.match(VERSIONED) || []).toEqual([]);
  });

  it('still names every builder module, without its version', () => {
    for (const m of MODULES) expect(README, m.name).toContain(`\`${m.name}\``);
  });

  it('catches a pinned version written back in', () => {
    const pinned = `${MODULES[0].name}@${MODULES[0].version}`;
    expect(`see /opt/avm/${pinned}`.match(VERSIONED)).toEqual([pinned]);
  });
});

describe('the check goes red when the image is left behind', () => {
  const bumped = (name, version) =>
    MODULES.map((m) => (m.name === name ? { ...m, version } : m));

  const SPOKE = 'avm-res-network-virtualnetwork';
  const spokePin = AVM_MODULES[SPOKE].version;
  const spokeId = `${SPOKE}@${spokePin}`;
  /** A release the image does not carry: one patch above the builder's pin. */
  const absent = spokePin.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  const CALLS = childCalls(ENV);
  /** A registry child the spoke module calls, per the record (the first, if it calls several). */
  const [spokeChild] = [...(CALLS.get(spokeId) ?? [])];
  /**
   * Every builder whose record names `child`, in record order. A child can
   * have more than one caller: on 2026-11-24 connectivity 0.18.4 began
   * calling the same avm-utl-interfaces release as the spoke (#1877), so
   * the expectations below are read from the record, never assumed to be
   * the spoke alone.
   */
  const callersOf = (child) =>
    [...CALLS].filter(([, children]) => children.has(child)).map(([builder]) => builder);
  const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** versions.env with each AVM_CHILD_CALLS line passed through `edit` (null drops the line). */
  const editCalls = (env, edit) =>
    env.replace(/^AVM_CHILD_CALLS='([^']*)'/m, (_, body) => {
      const lines = body.split('\n').map((line) => (line.trim() ? edit(line.trim()) : line));
      return `AVM_CHILD_CALLS='${lines.filter((line) => line !== null).join('\n')}'`;
    });

  it('fails a builder pin bump that versions.env did not follow (the state #737 found)', () => {
    const problems = vendoringProblems({
      modules: bumped(SPOKE, absent),
      env: ENV,
      fixture: FIXTURE,
    });
    expect(problems.join('\n')).toContain(
      `the builder emits ${SPOKE} ${absent}, and lab-image/versions.env vendors ${spokePin}`
    );
    expect(problems.join('\n')).toContain(
      `records nothing for ${SPOKE}@${absent} in AVM_CHILD_CALLS`
    );
  });

  it('fails a bump that moved the version line but not the record of its children', () => {
    const env = ENV.replace(
      /^AVM_RES_NETWORK_VIRTUALNETWORK_VERSION=.*$/m,
      `AVM_RES_NETWORK_VIRTUALNETWORK_VERSION=${absent}`
    );
    const problems = vendoringProblems({
      modules: bumped(SPOKE, absent),
      env,
      fixture: FIXTURE,
    });
    // If another builder's tree also calls the spoke's exact release, that
    // call stops being "a builder module" once the pin moves, so the check
    // rightly adds one line per such caller; read them from the record.
    const orphaned = callersOf(spokeId).map(
      (builder) =>
        `${builder} calls ${spokeId}, and AVM_CHILD_MODULES does not pin it, so the image does not vendor it`
    );
    expect(problems).toHaveLength(2 + orphaned.length);
    expect(problems[0]).toContain(`records nothing for ${SPOKE}@${absent}`);
    expect(problems[1]).toContain(`AVM_CHILD_CALLS records ${spokeId}`);
    expect(problems.slice(2)).toEqual(orphaned);
  });

  it('fails a builder module the image does not vendor at all', () => {
    const env = ENV.replace(/^AVM_RES_NETWORK_VIRTUALNETWORK_(VERSION|SHA256)=.*\n/gm, '');
    const problems = vendoringProblems({ modules: MODULES, env, fixture: FIXTURE });
    expect(problems[0]).toBe(
      `the builder emits ${SPOKE} ${spokePin}, and lab-image/versions.env has no AVM_RES_NETWORK_VIRTUALNETWORK_VERSION line, so the image does not vendor it`
    );
  });

  it('fails a recorded child that is not pinned, and a pin nothing calls', () => {
    expect(spokeChild, `${spokeId} calls a registry child in AVM_CHILD_CALLS`).toBeDefined();
    const callers = callersOf(spokeChild);
    expect(callers, `${spokeId} is among the callers of ${spokeChild}`).toContain(spokeId);

    // Unpin the child: one problem per builder that calls it, not one in all.
    const lost = ENV.replace(new RegExp(`^${escaped(spokeChild)} [0-9a-f]{64}\\n`, 'm'), '');
    expect(lost, `the AVM_CHILD_MODULES line for ${spokeChild} was removed`).not.toBe(ENV);
    expect(vendoringProblems({ modules: MODULES, env: lost, fixture: FIXTURE })).toEqual(
      callers.map(
        (builder) =>
          `${builder} calls ${spokeChild}, and AVM_CHILD_MODULES does not pin it, so the image does not vendor it`
      )
    );

    // Leave the pin but stop every caller calling it. Removing only the
    // spoke's line would leave the other callers' lines, and the pin would
    // still be called. A builder whose only child this was keeps its line,
    // alone, as a builder that calls nothing does.
    const stale = editCalls(ENV, (line) => {
      const [builder, child] = line.split(/\s+/);
      if (child !== spokeChild) return line;
      return CALLS.get(builder).size === 1 ? builder : null;
    });
    const staleCalls = [...childCalls(stale)];
    expect(
      staleCalls.map(([builder]) => builder),
      'every builder keeps a record'
    ).toEqual([...CALLS.keys()]);
    expect(
      staleCalls.filter(([, children]) => children.has(spokeChild)),
      `no line calls ${spokeChild}`
    ).toEqual([]);
    expect(vendoringProblems({ modules: MODULES, env: stale, fixture: FIXTURE })).toEqual([
      `AVM_CHILD_MODULES pins ${spokeChild}, which no AVM_CHILD_CALLS line calls`,
    ]);
  });

  it('fails a smoke payload that stops calling a builder module', () => {
    const fixture = FIXTURE.replace(/^module "spoke" \{[\s\S]*?^\}\n?/m, '');
    const problems = vendoringProblems({ modules: MODULES, env: ENV, fixture });
    expect(problems).toEqual([
      'lab-image/smoke/terraform-validate-payload/main.tf calls Azure/avm-res-network-virtualnetwork/azurerm 0 times, not once; smoke.sh expects one rewrite per builder module',
    ]);
  });
});
