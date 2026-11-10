/**
 * An architecture example that calls an Azure Verified Module names the
 * version the lab image carries, or no version at all (#1604).
 *
 * Each design page shows its Terraform example next to a "Verify in 15-Min
 * Browser Lab" button. The lab runs offline (no network), so it can only
 * load the modules the lab image vendors (keeps a copy of), and those are
 * exactly the versions the Landing Zone Builder pins in `AVM_MODULES`
 * (`src/lib/landingZone/avmVersions.js`); `scripts/lab-image-avm-vendoring.test.mjs`
 * holds the image to those pins. The hub-and-spoke example had `0.21.0` typed
 * in while the builder and the image had moved to the next release, so a
 * reader who pasted it into the lab got a version the lab does not have.
 * The versions are read from `AVM_MODULES` here, never typed in, so the
 * weekly bump that moves them keeps this test green.
 */
import { describe, it, expect } from 'vitest';
import { AVM_MODULES } from '../lib/landingZone/avmVersions.js';
import { architecturesByProvider } from './architectures';

const BY_SOURCE = new Map(Object.values(AVM_MODULES).map((m) => [m.source, m]));

/** The `source` and `version` of every Azure Verified Module call in a Terraform example. */
function avmCalls(code) {
  const arg = (block, name) =>
    block.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? null;
  return [...String(code).matchAll(/module\s+"[^"]+"\s*\{([\s\S]*?)\n\}/g)]
    .map(([, block]) => ({ source: arg(block, 'source'), version: arg(block, 'version') }))
    .filter((call) => /^Azure\/avm-/.test(call.source ?? ''));
}

/** What is wrong with an example's module calls, one line each; empty when nothing is. */
function problems(code) {
  return avmCalls(code).flatMap(({ source, version }) => {
    const pinned = BY_SOURCE.get(source);
    if (!pinned) return [`${source} is not a module the lab image vendors`];
    if (version !== null && version !== pinned.version) {
      return [`${source} is shown at ${version}, and the lab image vendors ${pinned.version}`];
    }
    return [];
  });
}

const designs = Object.entries(architecturesByProvider).flatMap(([provider, catalogue]) =>
  Object.entries(catalogue).map(([slug, design]) => ({
    id: `${provider}/${slug}`,
    code: design.terraformCode ?? '',
  }))
);

describe('architecture examples name the module versions the lab image vendors (#1604)', () => {
  it('shows every Azure Verified Module at the version AVM_MODULES pins, or with no version', () => {
    const found = designs.flatMap(({ id, code }) => problems(code).map((p) => `${id}: ${p}`));
    expect(found).toEqual([]);
  });

  it('checks at least one example, so the test above cannot pass on nothing', () => {
    const calls = designs.flatMap(({ code }) => avmCalls(code));
    expect(calls.length).toBeGreaterThan(0);
  });

  it('catches an example with a typed-in version the lab image does not carry', () => {
    const { source, version } = AVM_MODULES['avm-ptn-alz'];
    const older = version.replace(/\d+$/, (patch) => `${patch}-old`);
    const typed = `module "x" {\n  source  = "${source}"\n  version = "${older}"\n}`;
    expect(problems(typed)).toEqual([
      `${source} is shown at ${older}, and the lab image vendors ${version}`,
    ]);
    expect(problems(typed.replace(older, version))).toEqual([]);
  });
});
