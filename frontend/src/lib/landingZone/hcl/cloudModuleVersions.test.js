/**
 * The AWS and Google Cloud packs pin registry modules, and `terraform init`
 * fails when a pinned module asks for a provider or Terraform version the
 * pack's own pins rule out. That happened twice: log-export 9.0.0 wanted
 * google `< 6` while the pack pinned `~> 6.15` (#1863), and the bucket
 * module under it called a kms module with the same limit. These tests read
 * each module's recorded `requires` (copied from its versions.tf files, see
 * moduleVersions.js) and fail before a release that cannot work is shipped.
 *
 * Offline on purpose: whether a pinned release exists at all (#1862, a 1.1.0
 * that was never published) needs the registry, which these tests do not
 * call. moduleVersions.js records the date the pins were read.
 */
import { describe, it, expect } from 'vitest';
import { TERRAFORM_REQUIRED_VERSION, emitFiles, parseVersion, satisfies } from '../index';
import { AWS_MODULES, AWS_PROVIDER_PIN } from './aws/moduleVersions';
import { GCP_MODULES, GCP_PROVIDER_PIN } from './gcp/moduleVersions';

const CLAUSE = /^(~>|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * A constraint as the range of versions it allows: `{ lo, loIn, hi, hiIn }`,
 * `hi` null for no upper bound. `~> 6.15` is `>= 6.15.0, < 7.0.0`;
 * `~> 6.15.1` is `>= 6.15.1, < 6.16.0`. Throws on a clause it cannot read.
 */
function constraintRange(constraint) {
  const range = { lo: [0, 0, 0], loIn: true, hi: null, hiIn: false };
  const raiseLo = (v, inclusive) => {
    const c = compare(v, range.lo);
    if (c > 0 || (c === 0 && !inclusive)) Object.assign(range, { lo: v, loIn: inclusive });
  };
  const lowerHi = (v, inclusive) => {
    const c = range.hi ? compare(v, range.hi) : -1;
    if (c < 0 || (c === 0 && !inclusive)) Object.assign(range, { hi: v, hiIn: inclusive });
  };
  for (const clause of String(constraint).split(',')) {
    const m = CLAUSE.exec(clause.trim());
    if (!m) throw new Error(`cannot read the constraint clause "${clause.trim()}"`);
    const op = m[1] || '=';
    const v = [m[2], m[3], m[4]].map((g) => (g ? Number(g) : 0));
    if (op === '>=' || op === '=') raiseLo(v, true);
    if (op === '>') raiseLo(v, false);
    if (op === '<=' || op === '=') lowerHi(v, true);
    if (op === '<') lowerHi(v, false);
    if (op === '~>') {
      raiseLo(v, true);
      lowerHi(m[4] ? [v[0], v[1] + 1, 0] : [v[0] + 1, 0, 0], false);
    }
  }
  return range;
}

/** Whether two ranges share at least one version. */
function overlaps(a, b) {
  const lo = compare(a.lo, b.lo) >= 0 ? a : b;
  const loIn = compare(a.lo, b.lo) === 0 ? a.loIn && b.loIn : lo.loIn;
  const his = [a, b].filter((r) => r.hi);
  if (!his.length) return true;
  const hi = his.reduce((x, y) => (compare(x.hi, y.hi) <= 0 ? x : y));
  const hiIn = his.every((r) => compare(r.hi, hi.hi) !== 0 || r.hiIn);
  const c = compare(lo.lo, hi.hi);
  return c < 0 || (c === 0 && loIn && hiIn);
}

/** Whether every version `inner` allows is one `outer` allows too. */
function contains(outer, inner) {
  const lo = compare(outer.lo, inner.lo);
  const loOk = lo < 0 || (lo === 0 && (outer.loIn || !inner.loIn));
  if (!outer.hi) return loOk;
  if (!inner.hi) return false;
  const hi = compare(inner.hi, outer.hi);
  return loOk && (hi < 0 || (hi === 0 && (outer.hiIn || !inner.hiIn)));
}

const PACKS = [
  { cloud: 'aws', modules: AWS_MODULES, provider: 'aws', pin: AWS_PROVIDER_PIN },
  { cloud: 'gcp', modules: GCP_MODULES, provider: 'google', pin: GCP_PROVIDER_PIN },
];

const rows = PACKS.flatMap((pack) =>
  Object.entries(pack.modules).map(([key, module]) => ({ ...pack, key, module }))
);

describe('the range helper these tests rely on', () => {
  it('reads the two constraints that broke the Google Cloud pack (#1863)', () => {
    const pin = constraintRange('~> 6.15');
    expect(contains(constraintRange('>= 3.53, < 6'), pin)).toBe(false);
    expect(overlaps(constraintRange('>= 3.53, < 6'), pin)).toBe(false);
    expect(contains(constraintRange('>= 5.27, < 7'), pin)).toBe(true);
  });

  it('treats ~> by the number of parts it is given', () => {
    expect(constraintRange('~> 6.15')).toMatchObject({ lo: [6, 15, 0], hi: [7, 0, 0] });
    expect(constraintRange('~> 6.15.1')).toMatchObject({ lo: [6, 15, 1], hi: [6, 16, 0] });
  });

  it('refuses a clause it cannot read rather than passing it', () => {
    expect(() => constraintRange('>= six')).toThrow(/cannot read/);
  });

  it('agrees with satisfies() at the edges of a range', () => {
    const range = constraintRange('>= 1.12, < 2.0');
    expect(satisfies([1, 12, 0], '>= 1.12, < 2.0')).toBe(range.loIn);
    expect(satisfies([2, 0, 0], '>= 1.12, < 2.0')).toBe(range.hiIn);
  });
});

describe.each(rows)('$cloud module $module.source $module.version', ({ module, provider, pin }) => {
  it('is pinned to one exact release', () => {
    expect(parseVersion(module.version)).not.toBeNull();
  });

  it(`accepts every ${provider} provider the pack's pin allows`, () => {
    const wanted = module.requires.providers[provider];
    expect(wanted, `${module.source} records no ${provider} constraint`).toBeTruthy();
    expect(contains(constraintRange(wanted), constraintRange(pin))).toBe(true);
  });

  // Every Terraform the packs' rule admits must satisfy the module, not just
  // some of them: a module asking for >= 1.14 would let a user on 1.12 pass
  // the pack's own check and then fail at `terraform init`.
  it('accepts every Terraform the shared rule admits', () => {
    expect(
      contains(
        constraintRange(module.requires.terraform),
        constraintRange(TERRAFORM_REQUIRED_VERSION)
      )
    ).toBe(true);
  });

  it('had its requirements read at the pinned version', () => {
    expect(module.requires.readAt).toBe(module.version);
  });
});

describe.each(PACKS)('the $cloud pack', ({ cloud, modules, provider }) => {
  it('leaves at least one version of each unpinned provider every module accepts', () => {
    const asked = {};
    for (const module of Object.values(modules)) {
      for (const [name, constraint] of Object.entries(module.requires.providers)) {
        if (name !== provider) (asked[name] ??= []).push(constraint);
      }
    }
    for (const [name, constraints] of Object.entries(asked)) {
      const ranges = constraints.map(constraintRange);
      for (const a of ranges) {
        for (const b of ranges) expect(overlaps(a, b), `${name}: ${constraints}`).toBe(true);
      }
    }
  });

  it('calls only pinned modules, each at its pinned version', () => {
    // A module typed straight into a generator escapes the checks above, as
    // the log bucket's `~> 6.0` did.
    const pinned = new Map(Object.values(modules).map((m) => [m.source, m.version]));
    const text = emitFiles({ cloud })
      .map((f) => f.content)
      .join('\n');
    const calls = [...text.matchAll(/source\s*=\s*"([^"]+)"\s*\n\s*version\s*=\s*"([^"]+)"/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, source, version] of calls) {
      if (source.startsWith('hashicorp/')) continue;
      expect(pinned.get(source), source).toBe(version);
    }
  });
});

describe('the AWS and Google Cloud packs write nested blocks as blocks', () => {
  // Each of these is a block in Terraform or its provider; written as
  // `name = { … }` it fails `terraform init` or `terraform validate`.
  const BLOCKS = [
    'required_providers',
    'default_tags',
    'rule',
    'apply_server_side_encryption_by_default',
    'spec',
    'rules',
    'match',
    'layer4_configs',
    'oidc',
  ];

  it.each(['aws', 'gcp'])('in the %s pack', (cloud) => {
    for (const { path, content } of emitFiles({ cloud })) {
      if (!path.endsWith('.tf')) continue;
      for (const name of BLOCKS) {
        expect(content, `${path}: ${name}`).not.toMatch(
          new RegExp(`^\\s*${name}\\s*=\\s*\\{`, 'm')
        );
      }
    }
  });
});
