/**
 * The connectivity block passes an input only from the release that
 * requires it (#1868). connectivity 0.18.2 made `location` a required
 * top-level input; 0.18.1, the pin when this was written, has no such
 * variable and refuses it. So the block must follow the pin both ways, and
 * the weekly update that moves the pin then moves the block with it.
 */
import { describe, it, expect } from 'vitest';
import { connectivityTf } from './connectivity';
import { AVM_MODULES, AVM_REQUIRED_INPUTS, requiredInputs } from '../avmVersions';
import { DEFAULT_STATE } from '../state';

const NAME = 'avm-ptn-alz-connectivity-hub-and-spoke-vnet';

/** The top-level lines of `module "connectivity"`, indented two spaces. */
function moduleLines(version) {
  const { content } = connectivityTf(DEFAULT_STATE, version);
  const body = content.slice(content.indexOf('module "connectivity" {'));
  return body.split('\n').filter((line) => /^ {2}\S/.test(line));
}

describe('the connectivity block passes the inputs its release requires (#1868)', () => {
  it('passes no top-level location at 0.18.1, which does not declare one', () => {
    expect(moduleLines('0.18.1').some((line) => /^ {2}location\s*=/.test(line))).toBe(false);
  });

  it('passes location = var.location from 0.18.2 on', () => {
    for (const version of ['0.18.2', '0.18.4', '0.19.0']) {
      expect(moduleLines(version), version).toContain('  location = var.location');
    }
  });

  it('follows the pin when no version is given', () => {
    const pinned = AVM_MODULES[NAME].version;
    const expected = requiredInputs(NAME, pinned).map(
      (row) => `  ${row.input} = ${row.builderValue}`
    );
    const lines = moduleLines();
    for (const line of expected) expect(lines).toContain(line);
  });

  it('every row names a pinned module, a release, and the variables.tf that declares it', () => {
    for (const row of AVM_REQUIRED_INPUTS) {
      expect(AVM_MODULES[row.module], row.module).toBeDefined();
      expect(row.since).toMatch(/^\d+\.\d+\.\d+$/);
      expect(row.url).toBe(
        `https://github.com/Azure/terraform-azurerm-${row.module}/blob/v${row.since}/variables.tf`
      );
      expect(row.builderValue).toBeTruthy();
      expect(row.smokeValue).toBeTruthy();
    }
  });
});
