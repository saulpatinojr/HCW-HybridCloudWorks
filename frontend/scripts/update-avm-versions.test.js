// @vitest-environment node
/**
 * The pure parts of the AVM pin updater (#671): the version comparison that
 * decides whether a pin moved, the targeted text edits that move it, the
 * registry validation that refuses a release string it cannot pin, and the
 * summary the workflow puts in the pull request body. Every source is
 * stubbed; nothing here reaches the registry or GitHub.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  EditRefused,
  RegistryError,
  VENDOR_BUILD_ARGS,
  VendorError,
  applyChanges,
  checkModules,
  childRecordReport,
  compareVersions,
  envBuilders,
  envKeyFor,
  envVendors,
  isNewer,
  latestFromRegistry,
  nameForKey,
  parseArgs,
  parsePrintedPins,
  parseVersion,
  printChildPins,
  providerDrift,
  providersAt,
  recordChildren,
  registryModuleUrl,
  registryVersionsUrl,
  releaseNotesUrl,
  rewriteChildBlocks,
  rewriteChildList,
  rewriteEnv,
  rewritePin,
  rewriteSmokePin,
  sha256Hex,
  stampVerifiedOn,
  summarize,
  tarballUrl,
} from './update-avm-versions.mjs';

/** The shape of avmVersions.js: one-line pins and one Prettier has broken. */
const PINS = [
  "export const AVM_VERIFIED_ON = '2026-09-25';",
  '',
  'export const AVM_MODULES = Object.freeze({',
  "  'avm-ptn-alz': avm('avm-ptn-alz', '0.21.0', ['alz', 'azapi', 'modtm', 'random', 'time']),",
  "  'avm-ptn-alz-management': avm('avm-ptn-alz-management', '0.9.0', [",
  "    'azapi',",
  "    'azurerm',",
  '  ]),',
  "  'avm-ptn-alz-connectivity-hub-and-spoke-vnet': avm(",
  "    'avm-ptn-alz-connectivity-hub-and-spoke-vnet',",
  "    '0.17.5',",
  "    ['azapi', 'azurerm', 'modtm', 'random']",
  '  ),',
  '});',
  '',
].join('\n');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

/** The shape of lab-image/versions.env: two of the three modules vendored. */
const ENV = [
  '# Azure Verified Modules vendored at /opt/avm/<name>@<version>.',
  'AVM_PTN_ALZ_VERSION=0.21.0',
  `AVM_PTN_ALZ_SHA256=${SHA_A}`,
  'AVM_PTN_ALZ_MANAGEMENT_VERSION=0.9.0',
  `AVM_PTN_ALZ_MANAGEMENT_SHA256=${SHA_B}`,
  '',
].join('\n');

const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

/** ENV with the two blocks the vendor stage prints, keyed by the pinned versions. */
const ENV_WITH_CHILDREN = [
  ENV.trimEnd(),
  '# The children, printed by the vendor stage.',
  "AVM_CHILD_MODULES='",
  `avm-utl-interfaces@0.5.0 ${SHA_C}`,
  "'",
  "AVM_CHILD_CALLS='",
  'avm-ptn-alz-management@0.9.0',
  'avm-ptn-alz@0.21.0 avm-utl-interfaces@0.5.0',
  "'",
  '',
].join('\n');

/** ENV_WITH_CHILDREN after the version lines moved, before the blocks did: the state #1306 arrived in. */
const BUMPED_ENV = rewriteEnv(ENV_WITH_CHILDREN, 'avm-ptn-alz', '0.21.0', '0.22.0', SHA_D);

/**
 * What `docker build --target vendor --build-arg AVM_PRINT_PINS=1
 * --progress=plain lab-image` writes for the stage, prefixes and all, after
 * avm-ptn-alz moved to 0.22.0 and gained a child.
 */
const VENDOR_LOG = [
  '#15 [vendor 2/2] RUN set -eu; . /build/versions.env; bash /build/vendor-avm.sh',
  '#15 0.260 vendor-avm: pass 1, resolving children of: avm-ptn-alz-management@0.9.0 avm-ptn-alz@0.22.0',
  '#15 12.97 vendor-avm: vendored avm-utl-interfaces@0.5.0 from m.avm_interfaces',
  '#15 12.97 vendor-avm: vendored avm-utl-regions@0.12.0 from m.regions',
  '#15 12.97 vendor-avm: avm-ptn-alz@0.22.0: module "avm_interfaces" -> ../avm-utl-interfaces@0.5.0',
  "#15 12.97 AVM_CHILD_MODULES='",
  `#15 12.97 avm-utl-interfaces@0.5.0 ${SHA_C}`,
  `#15 12.97 avm-utl-regions@0.12.0 ${SHA_D}`,
  "#15 12.97 '",
  "#15 12.97 AVM_CHILD_CALLS='",
  '#15 12.97 avm-ptn-alz-management@0.9.0',
  '#15 12.97 avm-ptn-alz@0.22.0 avm-utl-interfaces@0.5.0',
  '#15 12.97 avm-ptn-alz@0.22.0 avm-utl-regions@0.12.0',
  "#15 12.97 '",
  '#15 DONE 13.1s',
  '',
].join('\n');

/** The same bump where the child list did not change: the #1306 case. */
const SAME_LIST_LOG = VENDOR_LOG.replace(`#15 12.97 avm-utl-regions@0.12.0 ${SHA_D}\n`, '').replace(
  '#15 12.97 avm-ptn-alz@0.22.0 avm-utl-regions@0.12.0\n',
  ''
);

/** The shape of the smoke payload: one block per module, one exact pin. */
const PAYLOAD = [
  'module "management" {',
  '  source  = "Azure/avm-ptn-alz-management/azurerm"',
  '  version = "~> 0.9"',
  '}',
  '',
  'module "alz" {',
  '  source  = "Azure/avm-ptn-alz/azurerm"',
  '  version = "0.21.0"',
  '',
  '  location = "centralus"',
  '}',
  '',
].join('\n');

/** The shape of labImage.js around the child list. */
const LAB_IMAGE = [
  '/** Every child the image vendors. */',
  'export const LAB_IMAGE_CHILD_AVM = Object.freeze([',
  "  'avm-utl-interfaces@0.5.0',",
  ']);',
  '',
  'export const OTHER = 1;',
  '',
].join('\n');

const module = (name, version, requiredProviders) => ({
  name,
  source: `Azure/${name}/azurerm`,
  version,
  requiredProviders,
});

describe('version comparison', () => {
  it('parses MAJOR.MINOR.PATCH and nothing else', () => {
    expect(parseVersion('0.21.0')).toEqual([0, 21, 0]);
    expect(parseVersion(' 1.2.3 ')).toEqual([1, 2, 3]);
    expect(parseVersion('v0.21.0')).toBeNull();
    expect(parseVersion('0.21')).toBeNull();
    expect(parseVersion('0.21.0-rc.1')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it('compares numerically, not as strings', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.21.0', '0.21.0')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(isNewer('0.22.0', '0.21.0')).toBe(true);
    expect(isNewer('0.21.0', '0.21.0')).toBe(false);
    expect(isNewer('0.20.9', '0.21.0')).toBe(false);
  });

  it('refuses to compare a string that is not a release', () => {
    expect(() => compareVersions('0.21.0', 'latest')).toThrow(TypeError);
  });
});

describe('latestFromRegistry', () => {
  it('returns the version, tag and publication date when they agree', () => {
    expect(
      latestFromRegistry(
        { version: '0.22.0', tag: 'v0.22.0', published_at: '2026-10-01T09:00:00Z' },
        'avm-ptn-alz'
      )
    ).toEqual({ version: '0.22.0', tag: 'v0.22.0', publishedAt: '2026-10-01T09:00:00Z' });
  });

  it('accepts a document without a tag', () => {
    expect(latestFromRegistry({ version: '0.22.0' }, 'x').tag).toBeNull();
  });

  it('refuses a pre-release, a missing version, or a tag that is not v<version>', () => {
    expect(() => latestFromRegistry({ version: '0.22.0-beta.1' }, 'avm-ptn-alz')).toThrow(
      RegistryError
    );
    expect(() => latestFromRegistry({}, 'avm-ptn-alz')).toThrow(
      'The registry lists avm-ptn-alz at null, which is not a MAJOR.MINOR.PATCH release, so nothing was written.'
    );
    expect(() => latestFromRegistry({ version: '0.22.0', tag: '0.22.0' }, 'avm-ptn-alz')).toThrow(
      /under tag "0.22.0" rather than v0.22.0/
    );
  });
});

describe('required_providers from the registry', () => {
  const versions = {
    modules: [
      {
        versions: [
          {
            version: '0.21.0',
            root: {
              providers: [
                { name: 'alz', source: 'azure/alz' },
                { name: 'terraform', source: '' },
                { name: 'azapi', source: 'Azure/azapi' },
                { name: 'alz', source: 'azure/alz' },
              ],
            },
          },
        ],
      },
    ],
  };

  it('lists each real provider once, lower-cased and sorted, dropping the terraform pseudo-entry', () => {
    expect(providersAt(versions, '0.21.0')).toEqual(['alz', 'azapi']);
  });

  it('returns null for a release the document does not carry', () => {
    expect(providersAt(versions, '0.22.0')).toBeNull();
    expect(providersAt({}, '0.22.0')).toBeNull();
  });

  it('names what the release adds and drops against the pin', () => {
    expect(providerDrift(['alz', 'azapi', 'time'], ['alz', 'azurerm'])).toEqual({
      added: ['azurerm'],
      removed: ['azapi', 'time'],
      unknown: false,
    });
    expect(providerDrift(['alz'], ['alz'])).toEqual({ added: [], removed: [], unknown: false });
    expect(providerDrift(['alz'], null)).toEqual({ added: [], removed: [], unknown: true });
  });
});

describe('rewritePin', () => {
  it('moves a one-line pin and nothing else', () => {
    const next = rewritePin(PINS, 'avm-ptn-alz', '0.21.0', '0.22.0');
    expect(next).toContain(
      "avm('avm-ptn-alz', '0.22.0', ['alz', 'azapi', 'modtm', 'random', 'time'])"
    );
    expect(next).not.toContain('0.21.0');
    // The other pins and the date are untouched.
    expect(next).toContain("avm('avm-ptn-alz-management', '0.9.0', [");
    expect(next).toContain("    '0.17.5',");
    expect(next).toContain("AVM_VERIFIED_ON = '2026-09-25'");
    expect(next.split('\n')).toHaveLength(PINS.split('\n').length);
  });

  it('moves a pin Prettier broke across lines, preserving the layout', () => {
    const next = rewritePin(
      PINS,
      'avm-ptn-alz-connectivity-hub-and-spoke-vnet',
      '0.17.5',
      '0.18.0'
    );
    expect(next).toContain(
      "  'avm-ptn-alz-connectivity-hub-and-spoke-vnet': avm(\n    'avm-ptn-alz-connectivity-hub-and-spoke-vnet',\n    '0.18.0',\n"
    );
    expect(next).not.toContain('0.17.5');
  });

  it('does not confuse a module with another whose name it prefixes', () => {
    const next = rewritePin(PINS, 'avm-ptn-alz-management', '0.9.0', '0.10.0');
    expect(next).toContain("avm('avm-ptn-alz', '0.21.0'");
    expect(next).toContain("avm('avm-ptn-alz-management', '0.10.0', [");
  });

  it('refuses a file where the pin is missing, doubled, or not at the version that was read', () => {
    expect(() => rewritePin(PINS, 'avm-ptn-hubnetworking', '0.1.0', '0.2.0')).toThrow(EditRefused);
    expect(() => rewritePin(PINS, 'avm-ptn-hubnetworking', '0.1.0', '0.2.0')).toThrow(
      'avmVersions.js holds 0 pins for avm-ptn-hubnetworking, not one, so it was not written.'
    );
    expect(() => rewritePin(`${PINS}${PINS}`, 'avm-ptn-alz', '0.21.0', '0.22.0')).toThrow(
      /holds 2 pins/
    );
    expect(() => rewritePin(PINS, 'avm-ptn-alz', '0.20.0', '0.22.0')).toThrow(
      'avmVersions.js pins avm-ptn-alz at 0.21.0, not the 0.20.0 that was read, so it was not written.'
    );
  });

  it('refuses a target that is not a release version', () => {
    expect(() => rewritePin(PINS, 'avm-ptn-alz', '0.21.0', 'latest')).toThrow(TypeError);
  });
});

describe('stampVerifiedOn', () => {
  it('rewrites the shared date line only', () => {
    const next = stampVerifiedOn(PINS, '2026-10-06');
    expect(next).toContain("export const AVM_VERIFIED_ON = '2026-10-06';");
    expect(next).not.toContain('2026-09-25');
    expect(next).toContain("'0.21.0'");
  });

  it('refuses a file that lost the line and a date that is not YYYY-MM-DD', () => {
    expect(() => stampVerifiedOn("const x = '2026-09-25';", '2026-10-06')).toThrow(EditRefused);
    expect(() => stampVerifiedOn(PINS, '6 October 2026')).toThrow(TypeError);
  });
});

describe('lab-image/versions.env', () => {
  it('derives the line prefix from the module name', () => {
    expect(envKeyFor('avm-ptn-alz')).toBe('AVM_PTN_ALZ');
    expect(envKeyFor('avm-ptn-alz-connectivity-hub-and-spoke-vnet')).toBe(
      'AVM_PTN_ALZ_CONNECTIVITY_HUB_AND_SPOKE_VNET'
    );
  });

  it('knows which modules the image vendors', () => {
    expect(envVendors(ENV, 'avm-ptn-alz')).toBe(true);
    expect(envVendors(ENV, 'avm-ptn-alz-management')).toBe(true);
    expect(envVendors(ENV, 'avm-res-network-virtualnetwork')).toBe(false);
  });

  it('rewrites the version and the sum together and touches no other line', () => {
    const sha = 'c'.repeat(64);
    const next = rewriteEnv(ENV, 'avm-ptn-alz', '0.21.0', '0.22.0', sha);
    expect(next).toContain('AVM_PTN_ALZ_VERSION=0.22.0\n');
    expect(next).toContain(`AVM_PTN_ALZ_SHA256=${sha}\n`);
    expect(next).toContain('AVM_PTN_ALZ_MANAGEMENT_VERSION=0.9.0\n');
    expect(next).toContain(`AVM_PTN_ALZ_MANAGEMENT_SHA256=${SHA_B}\n`);
    expect(next.startsWith('# Azure Verified Modules')).toBe(true);
    expect(next.split('\n')).toHaveLength(ENV.split('\n').length);
  });

  it('refuses a module the file does not vendor, a stale version, or a version line without its sum', () => {
    const sha = 'c'.repeat(64);
    expect(() =>
      rewriteEnv(ENV, 'avm-res-network-virtualnetwork', '0.22.2', '0.23.0', sha)
    ).toThrow(EditRefused);
    expect(() => rewriteEnv(ENV, 'avm-ptn-alz', '0.20.0', '0.22.0', sha)).toThrow(
      'versions.env has AVM_PTN_ALZ_VERSION=0.21.0, not the 0.20.0 avmVersions.js pins, so it was not written.'
    );
    const halved = ENV.replace(`AVM_PTN_ALZ_SHA256=${SHA_A}\n`, '');
    expect(() => rewriteEnv(halved, 'avm-ptn-alz', '0.21.0', '0.22.0', sha)).toThrow(
      /0 AVM_PTN_ALZ_SHA256 lines beside its _VERSION line/
    );
  });

  it('refuses a sum that is not 64 hex characters', () => {
    expect(() => rewriteEnv(ENV, 'avm-ptn-alz', '0.21.0', '0.22.0', 'deadbeef')).toThrow(TypeError);
  });

  it('reads the builder modules back as name@version, the way the Dockerfile does', () => {
    expect(nameForKey('PTN_ALZ_CONNECTIVITY_HUB_AND_SPOKE_VNET')).toBe(
      'avm-ptn-alz-connectivity-hub-and-spoke-vnet'
    );
    expect(envBuilders(ENV_WITH_CHILDREN)).toEqual([
      'avm-ptn-alz-management@0.9.0',
      'avm-ptn-alz@0.21.0',
    ]);
  });
});

describe('the smoke payload', () => {
  it("moves the exact pin on the module's block and nothing else", () => {
    const { source, moved } = rewriteSmokePin(PAYLOAD, 'avm-ptn-alz', '0.21.0', '0.22.0');
    expect(moved).toBe(true);
    expect(source).toBe(PAYLOAD.replace('version = "0.21.0"', 'version = "0.22.0"'));
    expect(source).toContain('version = "~> 0.9"');
  });

  it('leaves a block whose version is a constraint alone, and says so', () => {
    const { source, moved } = rewriteSmokePin(PAYLOAD, 'avm-ptn-alz-management', '0.9.0', '0.10.0');
    expect(moved).toBe(false);
    expect(source).toBe(PAYLOAD);
  });

  it('refuses a pin that is not at the version that was read, and a doubled block', () => {
    expect(() => rewriteSmokePin(PAYLOAD, 'avm-ptn-alz', '0.20.0', '0.22.0')).toThrow(
      'the smoke payload pins avm-ptn-alz at 0.21.0, not the 0.20.0 avmVersions.js pins, so it was not written.'
    );
    expect(() => rewriteSmokePin(PAYLOAD + PAYLOAD, 'avm-ptn-alz', '0.21.0', '0.22.0')).toThrow(
      EditRefused
    );
    expect(() => rewriteSmokePin(PAYLOAD, 'avm-ptn-alz', '0.21.0', 'latest')).toThrow(TypeError);
  });
});

describe('the vendor stage print-out', () => {
  it('reads the two blocks out of a plain-progress log, prefixes stripped, other lines ignored', () => {
    expect(parsePrintedPins(VENDOR_LOG)).toEqual({
      AVM_CHILD_MODULES: [`avm-utl-interfaces@0.5.0 ${SHA_C}`, `avm-utl-regions@0.12.0 ${SHA_D}`],
      AVM_CHILD_CALLS: [
        'avm-ptn-alz-management@0.9.0',
        'avm-ptn-alz@0.22.0 avm-utl-interfaces@0.5.0',
        'avm-ptn-alz@0.22.0 avm-utl-regions@0.12.0',
      ],
    });
  });

  it('reads the same blocks from a log Windows gave CRLF line endings', () => {
    expect(parsePrintedPins(VENDOR_LOG.replace(/\n/g, '\r\n'))).toEqual(
      parsePrintedPins(VENDOR_LOG)
    );
  });

  it('refuses a log with no block, which is what a cached stage prints', () => {
    expect(() =>
      parsePrintedPins('#15 [vendor 2/2] RUN bash /build/vendor-avm.sh\n#15 CACHED\n')
    ).toThrow(VendorError);
    expect(() => parsePrintedPins('#15 CACHED\n')).toThrow(
      /has no AVM_CHILD_MODULES block; a cached vendor stage prints nothing/
    );
  });

  it('refuses a doubled block, an unterminated one and an empty one', () => {
    expect(() => parsePrintedPins(VENDOR_LOG + VENDOR_LOG)).toThrow(
      /2 AVM_CHILD_MODULES blocks, not one/
    );
    const unterminated = VENDOR_LOG.replace(
      "#15 12.97 '\n#15 12.97 AVM_CHILD_CALLS='",
      "#15 12.97 AVM_CHILD_CALLS='"
    );
    expect(() => parsePrintedPins(unterminated)).toThrow(/AVM_CHILD_MODULES block has the line/);
    const empty = VENDOR_LOG.replace(
      /#15 12\.97 avm-ptn-alz-management@0\.9\.0\n#15 12\.97 avm-ptn-alz@0\.22\.0 [^\n]*\n#15 12\.97 avm-ptn-alz@0\.22\.0 [^\n]*\n/,
      ''
    );
    expect(() => parsePrintedPins(empty)).toThrow(/AVM_CHILD_CALLS block is empty/);
    expect(() =>
      parsePrintedPins(VENDOR_LOG.replace(`\n#15 12.97 '\n#15 DONE`, '\n#15 DONE'))
    ).toThrow(/AVM_CHILD_CALLS block has no closing quote/);
  });

  it('refuses a line that is not the shape vendor-avm.sh prints, naming it', () => {
    const short = VENDOR_LOG.replace(
      `avm-utl-regions@0.12.0 ${SHA_D}`,
      'avm-utl-regions@0.12.0 deadbeef'
    );
    expect(() => parsePrintedPins(short)).toThrow(
      'the vendor stage print-out\'s AVM_CHILD_MODULES block has the line "avm-utl-regions@0.12.0 deadbeef", which is not <name>@<version> <tree hash>, so nothing was written.'
    );
    const three = VENDOR_LOG.replace(
      'avm-ptn-alz@0.22.0 avm-utl-regions@0.12.0',
      'avm-ptn-alz@0.22.0 avm-utl-regions@0.12.0 extra@1.0.0'
    );
    expect(() => parsePrintedPins(three)).toThrow(
      /is not <builder>@<version> \[<child>@<version>\]/
    );
  });
});

describe('rewriteChildBlocks', () => {
  const blocks = parsePrintedPins(VENDOR_LOG);

  it('puts the printed blocks where the old ones were and changes no other line', () => {
    const next = rewriteChildBlocks(BUMPED_ENV, blocks);
    const before = BUMPED_ENV.split('\n');
    const after = next.split('\n');
    // Everything above the first block is untouched, comments included.
    const blockAt = before.indexOf("AVM_CHILD_MODULES='");
    expect(after.slice(0, blockAt)).toEqual(before.slice(0, blockAt));
    expect(after.slice(blockAt)).toEqual([
      "AVM_CHILD_MODULES='",
      `avm-utl-interfaces@0.5.0 ${SHA_C}`,
      `avm-utl-regions@0.12.0 ${SHA_D}`,
      "'",
      "AVM_CHILD_CALLS='",
      'avm-ptn-alz-management@0.9.0',
      'avm-ptn-alz@0.22.0 avm-utl-interfaces@0.5.0',
      'avm-ptn-alz@0.22.0 avm-utl-regions@0.12.0',
      "'",
      '',
    ]);
    expect(next).toContain(`AVM_PTN_ALZ_SHA256=${SHA_D}\n`);
    expect(next).not.toContain('\r');
  });

  it('is idempotent: splicing the same blocks twice is the same text', () => {
    const once = rewriteChildBlocks(BUMPED_ENV, blocks);
    expect(rewriteChildBlocks(once, blocks)).toBe(once);
  });

  it('refuses a capture keyed by versions the file does not pin, so a stale log cannot be written', () => {
    expect(() => rewriteChildBlocks(ENV_WITH_CHILDREN, blocks)).toThrow(VendorError);
    expect(() => rewriteChildBlocks(ENV_WITH_CHILDREN, blocks)).toThrow(
      "the vendor stage's AVM_CHILD_CALLS is keyed by avm-ptn-alz-management@0.9.0, avm-ptn-alz@0.22.0, and versions.env now pins avm-ptn-alz-management@0.9.0, avm-ptn-alz@0.21.0, so the capture is not of this file and it was not written."
    );
  });

  it('refuses a file that lost a block or holds it twice', () => {
    const lost = BUMPED_ENV.replace(/^AVM_CHILD_CALLS='[^']*'\n/m, '');
    expect(() => rewriteChildBlocks(lost, blocks)).toThrow(/0 AVM_CHILD_CALLS blocks, not one/);
    const doubled = `${BUMPED_ENV}AVM_CHILD_MODULES='\n'\n`;
    expect(() => rewriteChildBlocks(doubled, blocks)).toThrow(EditRefused);
  });
});

describe('the child list', () => {
  const blocks = parsePrintedPins(VENDOR_LOG);

  it('reports the counts and what the list added and dropped', () => {
    expect(childRecordReport(BUMPED_ENV, blocks)).toEqual({
      modules: 2,
      calls: 3,
      added: ['avm-utl-regions@0.12.0'],
      removed: [],
    });
    expect(childRecordReport(BUMPED_ENV, parsePrintedPins(SAME_LIST_LOG))).toEqual({
      modules: 1,
      calls: 2,
      added: [],
      removed: [],
    });
  });

  it('rewrites LAB_IMAGE_CHILD_AVM to the printed list and nothing else', () => {
    expect(rewriteChildList(LAB_IMAGE, blocks)).toBe(
      LAB_IMAGE.replace(
        "  'avm-utl-interfaces@0.5.0',\n",
        "  'avm-utl-interfaces@0.5.0',\n  'avm-utl-regions@0.12.0',\n"
      )
    );
    expect(() => rewriteChildList('export const OTHER = 1;\n', blocks)).toThrow(
      /0 LAB_IMAGE_CHILD_AVM arrays, not one/
    );
  });

  it('regenerates versions.env, and labImage.js only when the list changed', () => {
    const changed = recordChildren({
      log: VENDOR_LOG,
      envSource: BUMPED_ENV,
      labImageSource: LAB_IMAGE,
    });
    expect(changed.envSource).toBe(rewriteChildBlocks(BUMPED_ENV, blocks));
    expect(changed.labImageSource).toContain("'avm-utl-regions@0.12.0',");
    expect(changed.report.added).toEqual(['avm-utl-regions@0.12.0']);

    const same = recordChildren({
      log: SAME_LIST_LOG,
      envSource: BUMPED_ENV,
      labImageSource: LAB_IMAGE,
    });
    expect(same.labImageSource).toBe(LAB_IMAGE);
    expect(same.envSource).toContain('avm-ptn-alz@0.22.0 avm-utl-interfaces@0.5.0\n');
    expect(same.envSource).not.toContain('avm-ptn-alz@0.21.0');
  });
});

describe('printChildPins, with docker stubbed', () => {
  /** A spawn that plays back chunks on the two streams and closes with `code`. */
  const fakeDocker = ({ chunks = [], code = 0, startError = null } = {}) => {
    const calls = [];
    const spawnImpl = (command, args, options) => {
      calls.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      setImmediate(() => {
        if (startError) {
          child.emit('error', startError);
          return;
        }
        for (const [stream, text] of chunks) child[stream].emit('data', Buffer.from(text));
        child.emit('close', code);
      });
      return child;
    };
    return { spawnImpl, calls };
  };
  const echoed = () => {
    const parts = [];
    return { write: (chunk) => parts.push(String(chunk)), text: () => parts.join('') };
  };

  it('runs the README command from the repository root, without the vendor stage cached', async () => {
    const docker = fakeDocker({ chunks: [['stderr', VENDOR_LOG]] });
    await printChildPins({ spawnImpl: docker.spawnImpl, cwd: '/repo', echo: echoed() });
    expect(docker.calls).toHaveLength(1);
    expect(docker.calls[0].command).toBe('docker');
    expect(docker.calls[0].args).toEqual([...VENDOR_BUILD_ARGS]);
    expect(docker.calls[0].args.join(' ')).toContain(
      'build --target vendor --build-arg AVM_PRINT_PINS=1 --progress=plain --no-cache-filter vendor lab-image'
    );
    expect(docker.calls[0].options.cwd).toBe('/repo');
  });

  it('resolves with everything the build wrote, in arrival order, and echoes it as it arrives', async () => {
    const echo = echoed();
    const docker = fakeDocker({
      chunks: [
        ['stderr', '#15 0.260 vendor-avm: pass 1\n'],
        ['stdout', 'stdout line\n'],
        ['stderr', VENDOR_LOG],
      ],
    });
    const log = await printChildPins({ spawnImpl: docker.spawnImpl, cwd: '/repo', echo });
    expect(log).toBe(`#15 0.260 vendor-avm: pass 1\nstdout line\n${VENDOR_LOG}`);
    expect(echo.text()).toBe(log);
    expect(parsePrintedPins(log).AVM_CHILD_CALLS).toHaveLength(3);
  });

  it('rejects with the exit code when the build fails, after echoing its log', async () => {
    const echo = echoed();
    const docker = fakeDocker({
      chunks: [
        ['stderr', '#15 120.9 vendor-avm: terraform get failed for pass1-avm-ptn-alz@0.22.0\n'],
      ],
      code: 1,
    });
    await expect(
      printChildPins({ spawnImpl: docker.spawnImpl, cwd: '/repo', echo })
    ).rejects.toThrow(VendorError);
    await expect(
      printChildPins({ spawnImpl: docker.spawnImpl, cwd: '/repo', echo })
    ).rejects.toThrow(/exited 1; its log is above, and the child blocks were not regenerated/);
    expect(echo.text()).toContain('terraform get failed');
  });

  it('rejects in one sentence when docker cannot be started', async () => {
    const docker = fakeDocker({ startError: new Error('spawn docker ENOENT') });
    await expect(
      printChildPins({ spawnImpl: docker.spawnImpl, cwd: '/repo', echo: echoed() })
    ).rejects.toThrow(
      'docker could not be run (spawn docker ENOENT), so the child blocks were not regenerated and nothing more was written.'
    );
  });
});

describe('URLs and sums', () => {
  it('points at the release page and the tag tarball the Dockerfile downloads', () => {
    expect(releaseNotesUrl('avm-ptn-alz', '0.22.0')).toBe(
      'https://github.com/Azure/terraform-azurerm-avm-ptn-alz/releases/tag/v0.22.0'
    );
    expect(tarballUrl('avm-ptn-alz', '0.22.0')).toBe(
      'https://github.com/Azure/terraform-azurerm-avm-ptn-alz/archive/refs/tags/v0.22.0.tar.gz'
    );
  });

  it('hashes bytes the way sha256sum does', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('checkModules and applyChanges, with the registry and GitHub stubbed', () => {
  const modules = {
    'avm-ptn-alz': module('avm-ptn-alz', '0.21.0', ['alz', 'azapi', 'modtm', 'random', 'time']),
    'avm-ptn-alz-management': module('avm-ptn-alz-management', '0.9.0', ['azapi', 'azurerm']),
    'avm-ptn-alz-connectivity-hub-and-spoke-vnet': module(
      'avm-ptn-alz-connectivity-hub-and-spoke-vnet',
      '0.17.5',
      ['azapi', 'azurerm', 'modtm', 'random']
    ),
  };

  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const bytes = (text) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  });

  const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => '' };

  /** avm-ptn-alz moved and gained a provider; the other two are current. */
  const responses = new Map([
    [
      registryModuleUrl('avm-ptn-alz'),
      json({ version: '0.22.0', tag: 'v0.22.0', published_at: '2026-10-01T09:00:00Z' }),
    ],
    [
      registryVersionsUrl('avm-ptn-alz'),
      json({
        modules: [
          {
            versions: [
              {
                version: '0.22.0',
                root: {
                  providers: ['alz', 'azapi', 'azurerm', 'modtm', 'random', 'time'].map((name) => ({
                    name,
                    source: `x/${name}`,
                  })),
                },
              },
            ],
          },
        ],
      }),
    ],
    [registryModuleUrl('avm-ptn-alz-management'), json({ version: '0.9.0', tag: 'v0.9.0' })],
    [
      registryModuleUrl('avm-ptn-alz-connectivity-hub-and-spoke-vnet'),
      json({ version: '0.17.5', tag: 'v0.17.5' }),
    ],
    [tarballUrl('avm-ptn-alz', '0.22.0'), bytes('abc')],
  ]);
  const fetchImpl = async (url) => responses.get(url) ?? notFound;

  it('reports one result per module and marks only the one that moved', async () => {
    const results = await checkModules({ modules, fetchImpl });
    expect(results.map((r) => [r.name, r.from, r.to, r.moved])).toEqual([
      ['avm-ptn-alz', '0.21.0', '0.22.0', true],
      ['avm-ptn-alz-management', '0.9.0', '0.9.0', false],
      ['avm-ptn-alz-connectivity-hub-and-spoke-vnet', '0.17.5', '0.17.5', false],
    ]);
    expect(results[0].drift).toEqual({ added: ['azurerm'], removed: [], unknown: false });
    expect(results[1].drift.unknown).toBe(true);
  });

  it('rewrites the three files for the moved module, stamps the date, and leaves the rest alone', async () => {
    const results = await checkModules({ modules, fetchImpl });
    const next = await applyChanges({
      results,
      pinsSource: PINS,
      envSource: ENV,
      payloadSource: PAYLOAD,
      today: '2026-10-06',
      fetchImpl,
    });
    expect(next.pinsSource).toContain("avm('avm-ptn-alz', '0.22.0'");
    expect(next.pinsSource).toContain("AVM_VERIFIED_ON = '2026-10-06'");
    expect(next.pinsSource).toContain("'0.17.5'");
    expect(next.envSource).toContain('AVM_PTN_ALZ_VERSION=0.22.0');
    expect(next.envSource).toContain(
      'AVM_PTN_ALZ_SHA256=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(next.envSource).toContain(`AVM_PTN_ALZ_MANAGEMENT_SHA256=${SHA_B}`);
    expect(next.payloadSource).toBe(PAYLOAD.replace('version = "0.21.0"', 'version = "0.22.0"'));
    expect(results[0].vendored).toBe(true);
    expect(results[0].smokePinMoved).toBe(true);
    expect(results[0].sha256).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('changes nothing, including the date, when no pin moved', async () => {
    const current = async (url) =>
      url.includes('/avm-ptn-alz/azurerm')
        ? json({ version: '0.21.0', tag: 'v0.21.0' })
        : fetchImpl(url);
    const results = await checkModules({ modules, fetchImpl: current });
    const next = await applyChanges({
      results,
      pinsSource: PINS,
      envSource: ENV,
      payloadSource: PAYLOAD,
      today: '2026-10-06',
      fetchImpl: current,
    });
    expect(results.every((r) => !r.moved)).toBe(true);
    expect(next.pinsSource).toBe(PINS);
    expect(next.envSource).toBe(ENV);
    expect(next.payloadSource).toBe(PAYLOAD);
    expect(results.every((r) => r.smokePinMoved === null)).toBe(true);
  });

  it('refuses to bump when GitHub has no tag for the version the registry lists', async () => {
    const noTag = async (url) =>
      url === tarballUrl('avm-ptn-alz', '0.22.0')
        ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
        : fetchImpl(url);
    const results = await checkModules({ modules, fetchImpl: noTag });
    await expect(
      applyChanges({
        results,
        pinsSource: PINS,
        envSource: ENV,
        today: '2026-10-06',
        fetchImpl: noTag,
      })
    ).rejects.toThrow(/GitHub has no tag v0.22.0/);
  });

  it('ends with one sentence when the registry cannot be read', async () => {
    const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await expect(checkModules({ modules, fetchImpl: down })).rejects.toThrow(RegistryError);
    await expect(checkModules({ modules, fetchImpl: down })).rejects.toThrow(
      'https://registry.terraform.io/v1/modules/Azure/avm-ptn-alz/azurerm answered HTTP 503, so nothing was written.'
    );
  });
});

describe('summarize', () => {
  const base = (overrides) => ({
    name: 'avm-ptn-alz',
    from: '0.21.0',
    to: '0.21.0',
    moved: false,
    publishedAt: null,
    requiredProviders: ['alz', 'azapi'],
    drift: { added: [], removed: [], unknown: true },
    releaseNotes: releaseNotesUrl('avm-ptn-alz', '0.21.0'),
    terraformTf: 'https://github.com/Azure/terraform-azurerm-avm-ptn-alz/blob/v0.21.0/terraform.tf',
    vendored: null,
    sha256: null,
    ...overrides,
  });

  it('says nothing moved, in one sentence, and still tables every pin', () => {
    const text = summarize({ results: [base()], today: '2026-09-25' });
    expect(text).toContain('### Azure Verified Module pins, checked 2026-09-25');
    expect(text).toContain('Nothing moved');
    expect(text).toContain('| `avm-ptn-alz` | 0.21.0 | 0.21.0 | — |');
    expect(text).not.toContain('HAND EDIT');
  });

  it('gives each bump its old → new, the release notes link, the env lines and the provider verdict', () => {
    const text = summarize({
      results: [
        base({
          to: '0.22.0',
          moved: true,
          publishedAt: '2026-10-01T09:00:00Z',
          drift: { added: ['azurerm'], removed: [], unknown: false },
          releaseNotes: releaseNotesUrl('avm-ptn-alz', '0.22.0'),
          vendored: true,
          sha256: 'c'.repeat(64),
        }),
      ],
      today: '2026-10-06',
    });
    expect(text).toContain('1 of 1 pins moved. `AVM_VERIFIED_ON` is now 2026-10-06.');
    expect(text).toContain(
      '| `avm-ptn-alz` | 0.21.0 | **0.21.0 → 0.22.0** | [v0.22.0](https://github.com/Azure/terraform-azurerm-avm-ptn-alz/releases/tag/v0.22.0) |'
    );
    expect(text).toContain('#### `avm-ptn-alz` 0.21.0 → 0.22.0');
    expect(text).toContain(', published 2026-10-01.');
    expect(text).toContain('`AVM_PTN_ALZ_VERSION` and `AVM_PTN_ALZ_SHA256` rewritten');
    expect(text).toContain('**HAND EDIT NEEDED.** `required_providers` at v0.22.0 adds azurerm');
  });

  it('says when the image does not vendor the module and when the providers did not drift', () => {
    const text = summarize({
      results: [
        base({
          name: 'avm-res-network-virtualnetwork',
          from: '0.22.2',
          to: '0.23.0',
          moved: true,
          drift: { added: [], removed: [], unknown: false },
          vendored: false,
          sha256: 'd'.repeat(64),
        }),
      ],
      today: '2026-10-06',
    });
    expect(text).toContain('does not vendor this module');
    expect(text).toContain(
      'names the same providers as the pinned `requiredProviders` (alz, azapi)'
    );
    expect(text).not.toContain('smoke/terraform-validate-payload');
  });

  const moved = (overrides) =>
    base({ to: '0.22.0', moved: true, vendored: true, sha256: SHA_C, ...overrides });

  it("says when the smoke payload's exact pin moved with the module", () => {
    const text = summarize({ results: [moved({ smokePinMoved: true })], today: '2026-10-20' });
    expect(text).toContain(
      '- `lab-image/smoke/terraform-validate-payload/main.tf`: the exact `version = "0.21.0"` on its block for this module now reads `0.22.0`'
    );
  });

  it('describes the regenerated child record, and whether the child list moved', () => {
    const same = summarize({
      results: [moved()],
      today: '2026-10-20',
      children: { modules: 17, calls: 19, added: [], removed: [] },
    });
    expect(same).toContain('#### Child modules');
    expect(same).toContain(
      '- `AVM_CHILD_MODULES` and `AVM_CHILD_CALLS` in `lab-image/versions.env` regenerated from `docker build --target vendor --build-arg AVM_PRINT_PINS=1 --progress=plain lab-image`: 17 children pinned, 19 call lines, keyed by the bumped versions.'
    );
    expect(same).toContain(
      '- The child list is unchanged, so `LAB_IMAGE_CHILD_AVM` in `frontend/src/lib/landingZone/labImage.js` stands.'
    );

    const changed = summarize({
      results: [moved()],
      today: '2026-10-20',
      children: {
        modules: 18,
        calls: 20,
        added: ['avm-utl-regions@0.12.0'],
        removed: ['avm-utl-interfaces@0.2.0'],
      },
    });
    expect(changed).toContain(
      '- The child list adds avm-utl-regions@0.12.0 and drops avm-utl-interfaces@0.2.0, so `LAB_IMAGE_CHILD_AVM` in `frontend/src/lib/landingZone/labImage.js` was rewritten to match; the pull request carries that diff too.'
    );
  });

  it('says when the record was not regenerated: a dry run, or no vendored module moved', () => {
    const dry = summarize({ results: [moved()], today: '2026-10-20', children: { dryRun: true } });
    expect(dry).toContain(
      '- Dry run: `AVM_CHILD_MODULES` and `AVM_CHILD_CALLS` in `lab-image/versions.env` would be regenerated from'
    );
    const none = summarize({ results: [moved({ vendored: false })], today: '2026-10-20' });
    expect(none).toContain('were not regenerated: no builder module the image vendors moved');
    // No pin moved: no section at all.
    expect(summarize({ results: [base()], today: '2026-10-20' })).not.toContain(
      '#### Child modules'
    );
  });
});

describe('parseArgs', () => {
  it('reads --dry-run, --summary and --children and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, summaryPath: null, childrenPath: null });
    expect(parseArgs(['--dry-run', '--summary', 'out.md', '--children', 'vendor.log'])).toEqual({
      dryRun: true,
      summaryPath: 'out.md',
      childrenPath: 'vendor.log',
    });
    expect(() => parseArgs(['--force'])).toThrow(/Usage: node scripts\/update-avm-versions.mjs/);
  });
});
