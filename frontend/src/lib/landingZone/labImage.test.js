/**
 * The lab image mirror (#672). What must hold: `LAB_IMAGE_AVM` is exactly
 * what lab-image/ vendors, read from its Dockerfile and versions.env, so the
 * two cannot drift; the constraint evaluator is tf_constraints.py's, case for
 * case; the module scan is tf_rewrite.py's (top-level blocks, depth-1
 * `source` and `version` only, registry AVM sources only, `.tf` files only);
 * and against the builder's own output it says what the image will do: every
 * module the full default build calls resolves, the spokes' pinned version
 * included, and a version the image does not carry is named.
 *
 * NO PIN IS WRITTEN HERE (#1287). Every version these tests expect is read
 * from avmVersions.js or lab-image/versions.env, the two files the weekly
 * bump rewrites, so a bump moves the expectations with it; the bot's own
 * check step failed twice on literals that `vitest -u` cannot refresh. The
 * one shelf of literal versions is the constraint evaluator's fixture, which
 * is about the evaluator's rule and not about what the image carries.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AVM_MODULES,
  DEFAULT_STATE,
  LAB_IMAGE_AVM,
  LAB_IMAGE_BUILDER_AVM,
  LAB_IMAGE_CHILD_AVM,
  chooseVendored,
  decodeLz,
  emitFiles,
  labModuleReport,
  labResolution,
  parseVersion,
  satisfies,
  vendoredModules,
} from './index';

const LAB_IMAGE = join(process.cwd(), '..', 'lab-image');

/** `KEY=value` and `KEY='multi-line'` assignments from versions.env, which /bin/sh sources. */
function readVersionsEnv() {
  const text = readFileSync(join(LAB_IMAGE, 'versions.env'), 'utf8');
  const values = {};
  const assignment = /^([A-Z0-9_]+)=(?:'([^']*)'|(\S*))/gm;
  for (const m of text.matchAll(assignment)) values[m[1]] = m[2] ?? m[3];
  return values;
}

/**
 * The line of lab-image/Dockerfile's fetch stage that lists the builder
 * modules: every AVM_<KEY>_VERSION line of versions.env. vendoredByImage
 * reads them the same way, so this test fails if the Dockerfile stops.
 */
const DOCKERFILE_BUILDER_LIST = String.raw`sed -n 's/^AVM_\([A-Z0-9_]*\)_VERSION=.*$/\1/p' /build/versions.env`;

/**
 * What the image vendors: the builder modules, each AVM_<KEY>_VERSION in
 * versions.env as the Dockerfile's fetch stage reads it (`avm-` plus <KEY>
 * lower-cased with `_` as `-`), plus every AVM_CHILD_MODULES line.
 */
function vendoredByImage() {
  const env = readVersionsEnv();
  const top = Object.entries(env)
    .map(([variable, value]) => [/^AVM_([A-Z0-9_]+)_VERSION$/.exec(variable)?.[1], value])
    .filter(([key]) => key)
    .map(([key, version]) => `avm-${key.toLowerCase().replace(/_/g, '-')}@${version}`);
  const children = env.AVM_CHILD_MODULES.split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  return { top, children };
}

const state = (query) => decodeLz(new URLSearchParams(query));

const SPOKE = 'avm-res-network-virtualnetwork';

/** The builder's pinned version of a module, as avmVersions.js has it today. */
const pinned = (name) => AVM_MODULES[name].version;

/** `0.9.0` → `0.9`: the `~>` series a pessimistic constraint names. */
const series = (version) => version.split('.').slice(0, 2).join('.');

/** Every version of `name` the image carries, in LAB_IMAGE_AVM order, as a report's `have` lists them. */
const carried = (name) => (vendoredModules(LAB_IMAGE_AVM)[name] ?? []).map((c) => c.text);

/** A release the image does not carry: one patch above the highest it has, whatever that is this week. */
const absent = (name) => {
  const [major, minor, patch] = parseVersion(
    chooseVendored(vendoredModules(LAB_IMAGE_AVM), name, '')
  );
  return `${major}.${minor}.${patch + 1}`;
};

describe('LAB_IMAGE_AVM is what lab-image/ vendors', () => {
  it('reads the builder modules from versions.env the way the Dockerfile does', () => {
    const dockerfile = readFileSync(join(LAB_IMAGE, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(DOCKERFILE_BUILDER_LIST);
  });

  it('vendors every module the builder emits, at the version it emits, as a builder module', () => {
    const { top } = vendoredByImage();
    const emitted = Object.values(AVM_MODULES).map((m) => `${m.name}@${m.version}`);
    expect([...top].sort()).toEqual([...emitted].sort());
    expect([...LAB_IMAGE_BUILDER_AVM].sort()).toEqual([...emitted].sort());
  });

  it('lists every builder module and every child, and nothing else', () => {
    const { top, children } = vendoredByImage();
    expect(children.length).toBeGreaterThan(0);
    expect([...LAB_IMAGE_CHILD_AVM].sort()).toEqual([...children].sort());
    expect([...LAB_IMAGE_AVM].sort()).toEqual([...new Set([...top, ...children])].sort());
  });

  it('holds only name@version entries the image’s own parser accepts', () => {
    const parsed = vendoredModules(LAB_IMAGE_AVM);
    const count = Object.values(parsed).reduce((n, list) => n + list.length, 0);
    expect(count).toBe(LAB_IMAGE_AVM.length);
  });
});

describe('Terraform constraints, as tf_constraints.py reads them', () => {
  const v = (text) => parseVersion(text);

  it.each([
    ['0.21.0', '0.21.0', true],
    ['0.21.0', '0.21.1', false],
    ['0.21.0', '= 0.21.0', true],
    ['0.21.0', 'v0.21.0', true],
    ['0.22.0', '~> 0.21', true],
    ['1.0.0', '~> 0.21', false],
    ['0.21.5', '~> 0.21.0', true],
    ['0.22.0', '~> 0.21.0', false],
    ['0.9.0', '>= 0.9, < 1.0', true],
    ['1.0.0', '>= 0.9, < 1.0', false],
    ['0.5.0', '!= 0.5.0', false],
    ['0.5.1', '!= 0.5.0', true],
    ['0.3.1', '> 0.3.0', true],
    ['0.3.0', '<= 0.3.0', true],
    ['0.21.0', '', true],
    ['0.21.0', '   ', true],
    ['0.21.0', 'latest', false],
    ['0.21.0', '>= 0.21, banana', false],
  ])('%s against %j is %s', (version, constraint, expected) => {
    expect(satisfies(v(version), constraint)).toBe(expected);
  });

  it('parses only three-part versions', () => {
    expect(parseVersion('0.21.0')).toEqual([0, 21, 0]);
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('0.21')).toBeNull();
    expect(parseVersion('0.21.0-beta')).toBeNull();
  });

  it('picks the highest vendored version that satisfies, as the registry would', () => {
    // A fixed shelf, not the image's: this is the evaluator's rule, and the
    // rule does not move when the pins do. Two versions of one module side
    // by side, as the image carries the spoke module (the builder's and the
    // connectivity module's own child).
    const vendored = vendoredModules([
      'avm-res-network-routetable@0.3.1',
      'avm-res-network-routetable@0.5.0',
      'avm-res-network-virtualnetwork@0.15.0',
      'avm-res-network-virtualnetwork@0.22.2',
      'avm-utl-interfaces@0.5.0',
      'avm-utl-interfaces@0.6.0',
    ]);
    expect(chooseVendored(vendored, 'avm-res-network-routetable', '>= 0.3')).toBe('0.5.0');
    expect(chooseVendored(vendored, 'avm-res-network-routetable', '~> 0.3.0')).toBe('0.3.1');
    expect(chooseVendored(vendored, 'avm-utl-interfaces', '~> 0.5.0')).toBe('0.5.0');
    expect(chooseVendored(vendored, 'avm-utl-interfaces', '')).toBe('0.6.0');
    expect(chooseVendored(vendored, 'avm-res-network-virtualnetwork', '0.22.2')).toBe('0.22.2');
    expect(chooseVendored(vendored, 'avm-res-network-virtualnetwork', '~> 0.15.0')).toBe('0.15.0');
    expect(chooseVendored(vendored, 'avm-res-network-virtualnetwork', '>= 0.15.0')).toBe('0.22.2');
    expect(chooseVendored(vendored, 'avm-res-network-virtualnetwork', '0.23.0')).toBeNull();
    expect(chooseVendored(vendored, 'avm-not-vendored', '')).toBeNull();
  });

  it('resolves the builder’s own spoke pin on the image, and nothing above what the image has', () => {
    const vendored = vendoredModules(LAB_IMAGE_AVM);
    expect(carried(SPOKE)).toContain(pinned(SPOKE));
    expect(chooseVendored(vendored, SPOKE, pinned(SPOKE))).toBe(pinned(SPOKE));
    expect(chooseVendored(vendored, SPOKE, absent(SPOKE))).toBeNull();
  });
});

describe('the module scan, as tf_rewrite.py does it', () => {
  const file = (path, content) => ({ path, content });

  it('takes depth-1 source and version lines only', () => {
    const [row] = labModuleReport([
      file(
        'main.tf',
        [
          'module "alz" {',
          '  source  = "Azure/avm-ptn-alz/azurerm"',
          `  version = "${pinned('avm-ptn-alz')}"`,
          '  nested = {',
          '    source  = "Azure/avm-res-network-virtualnetwork/azurerm"',
          '    version = "9.9.9"',
          '  }',
          '}',
        ].join('\n')
      ),
    ]);
    expect(row).toMatchObject({
      block: 'alz',
      module: 'avm-ptn-alz',
      constraint: pinned('avm-ptn-alz'),
      vendored: `avm-ptn-alz@${pinned('avm-ptn-alz')}`,
    });
  });

  it('reads registry-prefixed and sub-module sources, and leaves every other source out', () => {
    const report = labModuleReport([
      file(
        'main.tf',
        [
          'module "prefixed" {',
          '  source = "registry.terraform.io/Azure/avm-ptn-alz-management/azurerm"',
          `  version = "~> ${series(pinned('avm-ptn-alz-management'))}"`,
          '}',
          'module "sub" {',
          '  source = "Azure/avm-ptn-alz/azurerm//modules/x"',
          '}',
          'module "local" {',
          '  source = "./modules/local"',
          '}',
          'module "other" {',
          '  source  = "hashicorp/consul/aws"',
          '  version = "0.1.0"',
          '}',
        ].join('\n')
      ),
    ]);
    expect(report.map((r) => [r.block, r.vendored])).toEqual([
      ['prefixed', `avm-ptn-alz-management@${pinned('avm-ptn-alz-management')}`],
      ['sub', `avm-ptn-alz@${pinned('avm-ptn-alz')}`],
    ]);
  });

  it('scans .tf files only, skipping .terraform and .git, in path order', () => {
    const block = 'module "m" {\n  source = "Azure/avm-ptn-alz/azurerm"\n}\n';
    const report = labModuleReport([
      file('z.tf', block),
      file('README.md', block),
      file('terraform.tfvars.example', block),
      file('.terraform/modules/x.tf', block),
      file('a.tf', block),
    ]);
    expect(report.map((r) => r.path)).toEqual(['a.tf', 'z.tf']);
  });
});

describe('against the builder’s own output', () => {
  it('resolves every module the full default build calls, each spoke included', () => {
    const files = emitFiles(DEFAULT_STATE);
    const report = labModuleReport(files);
    const byModule = Object.fromEntries(report.map((r) => [r.module, r.vendored]));
    expect(byModule).toEqual(
      Object.fromEntries(Object.values(AVM_MODULES).map((m) => [m.name, `${m.name}@${m.version}`]))
    );
    // Every spoke, not one of them: three blocks call the virtual network module.
    expect(report.filter((r) => r.module === 'avm-res-network-virtualnetwork')).toHaveLength(3);
    expect(labResolution(files)).toEqual({ ok: true, unresolved: [] });
  });

  it('names a module version the image does not carry, once however many blocks call it', () => {
    const missing = absent(SPOKE);
    const spoke = (name) =>
      `module "${name}" {\n  source  = "Azure/${SPOKE}/azurerm"\n  version = "${missing}"\n}\n`;
    const { ok, unresolved } = labResolution([
      { path: 'a.tf', content: spoke('one') },
      { path: 'b.tf', content: spoke('two') },
    ]);
    expect(ok).toBe(false);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      module: SPOKE,
      constraint: missing,
      have: carried(SPOKE),
    });
    expect(carried(SPOKE)).toContain(pinned(SPOKE));
  });

  it('can validate a build with no spoke', () => {
    const files = emitFiles(state('lz=mg,policy,mgmt,hub,fw&corp=0&online=0'));
    expect(labResolution(files)).toEqual({ ok: true, unresolved: [] });
  });

  it('has nothing to resolve in an empty build', () => {
    const files = emitFiles({ selected: [] });
    expect(files.map((f) => f.path)).toEqual(['README.md']);
    expect(labModuleReport(files)).toEqual([]);
  });
});
