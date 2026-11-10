/**
 * An architecture example that calls an Azure Verified Module names a version
 * the lab image carries (#1604).
 *
 * Each design page shows its Terraform example next to a "Verify in 15-Min
 * Browser Lab" button. The lab runs with no network, so it can only load the
 * modules the lab image vendors (keeps a copy of). `labResolution` in
 * `src/lib/landingZone/labImage.js` is the lab's own rule for that, in
 * JavaScript: which copy each `module` block resolves to, by the same
 * constraint rules and source spellings, and which it would leave for
 * `terraform init` to fail on. The hub-and-spoke example had `0.21.0` typed
 * in while the builder and the image had moved to the next release, so a
 * reader who pasted it into the lab got a version the lab does not have.
 * The versions are read from `AVM_MODULES` here, never typed in, so the
 * weekly bump that moves them keeps this test green.
 */
import { describe, it, expect } from 'vitest';
import { AVM_MODULES } from '../lib/landingZone/avmVersions';
import { labModuleReport, labResolution } from '../lib/landingZone/labImage';
import { architecturesByProvider } from './architectures';

/** Every design's example as a `main.tf` file of its own, as the lab would receive it. */
const files = Object.entries(architecturesByProvider).flatMap(([provider, catalogue]) =>
  Object.entries(catalogue).map(([slug, design]) => ({
    path: `${provider}/${slug}/main.tf`,
    content: design.terraformCode ?? '',
  }))
);

/** What the lab would fail on, one line per module and constraint. */
const unresolved = (given) =>
  labResolution(given).unresolved.map(
    (row) => `${row.path}: ${row.module} "${row.constraint}" (the lab has ${row.have.join(', ')})`
  );

describe('architecture examples name module versions the lab image carries (#1604)', () => {
  it('resolves every Azure Verified Module call in every example to a vendored copy', () => {
    expect(unresolved(files)).toEqual([]);
  });

  it('checks at least one module call, so the test above cannot pass on nothing', () => {
    expect(labModuleReport(files).length).toBeGreaterThan(0);
  });

  it('catches an example with 0.21.0 typed in, the version the hub-and-spoke example showed', () => {
    const { source, version } = AVM_MODULES['avm-ptn-alz'];
    const typed = (pin) => [
      {
        path: 'x/main.tf',
        content: `module "x" {\n  source  = "${source}"\n  version = "${pin}"\n}`,
      },
    ];
    expect(version).not.toBe('0.21.0');
    expect(labResolution(typed('0.21.0')).unresolved).toHaveLength(1);
    expect(unresolved(typed('0.21.0'))[0]).toContain('avm-ptn-alz "0.21.0"');
    expect(labResolution(typed(version)).ok).toBe(true);
  });
});

describe('a design names no Terraform release of its own (#1656)', () => {
  it('says "HashiCorp Terraform" without a version, which the lab and the builder would outgrow', () => {
    // Two Azure designs said "Terraform 1.9" while the lab ran 1.17 and the
    // builder required 1.12 or newer. The release is pinned in
    // lab-image/versions.env and TERRAFORM_REQUIRED_VERSION, not here.
    const named = Object.entries(architecturesByProvider).flatMap(([provider, catalogue]) =>
      Object.entries(catalogue)
        .filter(([, design]) =>
          /Terraform\s+\d/.test(design.ecosystemPartnerValidation?.validatedWith || '')
        )
        .map(([slug]) => `${provider}/${slug}`)
    );
    expect(named).toEqual([]);
  });
});
