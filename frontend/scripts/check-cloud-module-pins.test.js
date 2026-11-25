// @vitest-environment node
/**
 * The weekly AWS and Google Cloud pin check (#1869). Every registry and
 * GitHub answer here is made up; nothing reaches the network. The last
 * block starts plain Node (not the test runner) on the script, because the
 * workflow runs it that way and Node, unlike the test runner, refuses an
 * import written without its `.js` ending.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CheckError,
  PACKS,
  checkPin,
  checkPins,
  exitCodeFor,
  fetchText,
  judgePin,
  listedVersions,
  logLines,
  normalizeConstraint,
  parseArgs,
  parseVersionsTf,
  registryAddress,
  requiresDrift,
  summarize,
  versionsTfUrl,
  versionsUrl,
} from './check-cloud-module-pins.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const FIREWALL = {
  source: 'terraform-aws-modules/network-firewall/aws',
  version: '1.0.2',
  requires: { terraform: '>= 1.0', readAt: '1.0.2', providers: { aws: '>= 5.2' } },
};
const BUCKET = {
  source: 'terraform-google-modules/cloud-storage/google//modules/simple_bucket',
  version: '7.0.0',
  requires: { terraform: '>= 0.13', readAt: '7.0.0', providers: { google: '>= 5.43, < 7' } },
};

const versionsDoc = (...versions) =>
  JSON.stringify({ modules: [{ versions: versions.map((version) => ({ version })) }] });

/** A fetch that answers from a map of URL to `[status, body]`, or throws the given error. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (!route) return new Response('not found', { status: 404 });
    const [status, body] = route;
    return new Response(body, { status });
  };
  impl.calls = calls;
  return impl;
}

const FIREWALL_VERSIONS =
  'https://registry.terraform.io/v1/modules/terraform-aws-modules/network-firewall/aws/versions';
const FIREWALL_230 =
  'https://registry.terraform.io/v1/modules/terraform-aws-modules/network-firewall/aws/2.3.0';
const FIREWALL_TF =
  'https://raw.githubusercontent.com/terraform-aws-modules/terraform-aws-network-firewall/v2.3.0/versions.tf';

// Retries wait between tries; the tests do not need to.
const noWait = () => null;

describe('reading a registry source', () => {
  it('splits the three parts and keeps the submodule apart', () => {
    expect(registryAddress(BUCKET.source)).toEqual({
      namespace: 'terraform-google-modules',
      name: 'cloud-storage',
      provider: 'google',
      submodule: 'modules/simple_bucket',
    });
  });

  it('asks the registry for the module, not the submodule', () => {
    expect(versionsUrl(registryAddress(BUCKET.source))).toBe(
      'https://registry.terraform.io/v1/modules/terraform-google-modules/cloud-storage/google/versions'
    );
  });

  it('refuses a source that is not namespace/name/provider', () => {
    expect(() => registryAddress('terraform-aws-modules/vpc')).toThrow(CheckError);
    expect(() => registryAddress('a/b/c//../../x')).toThrow(/leaves the module/);
  });

  it('covers every pin the builder ships', () => {
    const sources = PACKS.flatMap(({ modules }) => Object.values(modules).map((m) => m.source));
    expect(sources.length).toBeGreaterThanOrEqual(7);
    for (const source of sources) expect(() => registryAddress(source)).not.toThrow();
  });
});

describe('judging a pin against the registry list', () => {
  it('fails a release that was never published (#1862)', () => {
    const versions = listedVersions(JSON.parse(versionsDoc('1.0.0', '1.0.2', '2.3.0')), 'x');
    expect(judgePin('1.1.0', versions)).toEqual({
      published: false,
      newest: '2.3.0',
      newer: false,
    });
  });

  it('passes a published pin and says when a newer one exists', () => {
    const versions = ['1.0.2', '2.3.0', '2.10.0', '3.0.0-beta1'];
    expect(judgePin('1.0.2', versions)).toEqual({
      published: true,
      newest: '2.10.0',
      newer: true,
    });
    expect(judgePin('2.10.0', versions).newer).toBe(false);
  });

  it('refuses a registry answer it cannot read rather than calling the pin missing', () => {
    expect(() => listedVersions({}, 'x')).toThrow(CheckError);
    expect(() => listedVersions({ modules: [{ versions: [] }] }, 'x')).toThrow(/empty/);
  });
});

describe('reading a versions.tf', () => {
  const TF = `
/* licence header */
terraform {
  required_version = ">= 1.5.7" # comment
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.28"
    }
    // a provider with no version
    random = {
      source = "hashicorp/random"
    }
  }
  provider_meta "google" {
    module_name = "blueprints/terraform/x/v1.0.0"
  }
}`;

  it('reads required_version and each provider', () => {
    expect(parseVersionsTf(TF)).toEqual({
      terraform: '>= 1.5.7',
      providers: { aws: '>= 6.28', random: null },
    });
  });

  it('reads a file with no providers', () => {
    expect(parseVersionsTf('terraform {\n  required_version = ">= 1.0"\n}\n')).toEqual({
      terraform: '>= 1.0',
      providers: {},
    });
  });

  it('builds the raw GitHub address from the repository and tag the registry names', () => {
    expect(
      versionsTfUrl(
        'https://github.com/terraform-google-modules/terraform-google-cloud-storage',
        'v12.4.1',
        'modules/simple_bucket'
      )
    ).toBe(
      'https://raw.githubusercontent.com/terraform-google-modules/terraform-google-cloud-storage/v12.4.1/modules/simple_bucket/versions.tf'
    );
    expect(versionsTfUrl('https://gitlab.com/x/y', 'v1.0.0')).toBeNull();
    expect(versionsTfUrl('https://github.com/x/y', '')).toBeNull();
  });
});

describe('comparing with the recorded requires', () => {
  it('treats >= 5.43.0 and >= 5.43 as the same, but not ~> 5.0 and ~> 5', () => {
    expect(normalizeConstraint('>=5.43.0,  < 7')).toBe('>= 5.43, < 7');
    expect(normalizeConstraint('~> 5.0')).not.toBe(normalizeConstraint('~> 5'));
  });

  it('names each line that differs and ignores what the file does not declare', () => {
    const drift = requiresDrift(
      { terraform: '>= 1.0', providers: { aws: '>= 5.2', 'google-beta': '>= 6.13, < 7' } },
      { terraform: '>= 1.5.7', providers: { aws: '>= 5.2.0', time: '>= 0.9' } }
    );
    expect(drift).toEqual([
      { what: 'Terraform', recorded: '>= 1.0', read: '>= 1.5.7' },
      { what: 'provider time', recorded: null, read: '>= 0.9' },
    ]);
  });
});

describe('checking a pin against made-up answers', () => {
  it('fails the #1862 pin, naming the module and the newest release', async () => {
    const fetchImpl = fakeFetch({ [FIREWALL_VERSIONS]: [200, versionsDoc('1.0.2', '2.3.0')] });
    const result = await checkPin(
      'AWS',
      'networkFirewall',
      { ...FIREWALL, version: '1.1.0' },
      { fetchImpl }
    );
    expect(result.status).toBe('missing');
    expect(result.message).toBe(
      '1.1.0 is not a published release of terraform-aws-modules/network-firewall/aws; the newest is 2.3.0.'
    );
    expect(exitCodeFor([result])).toBe(1);
    expect(logLines([result])[0]).toMatch(/^FAIL {2}AWS networkFirewall/);
    expect(summarize([result])).toMatch(/A pinned release is not published/);
  });

  it('fails a source the registry does not know', async () => {
    const result = await checkPin(
      'AWS',
      'x',
      { ...FIREWALL, source: 'a/b/c' },
      { fetchImpl: fakeFetch({}) }
    );
    expect(result).toMatchObject({ status: 'missing' });
    expect(result.message).toMatch(/no module called a\/b\/c/);
  });

  it('passes a current pin with no further requests', async () => {
    const fetchImpl = fakeFetch({ [FIREWALL_VERSIONS]: [200, versionsDoc('1.0.1', '1.0.2')] });
    const result = await checkPin('AWS', 'networkFirewall', FIREWALL, { fetchImpl });
    expect(result).toMatchObject({ status: 'ok', newest: '1.0.2', newer: false, warnings: [] });
    expect(fetchImpl.calls).toEqual([FIREWALL_VERSIONS]);
    expect(exitCodeFor([result])).toBe(0);
  });

  it('warns, without failing, when a newer release asks for something else', async () => {
    const fetchImpl = fakeFetch({
      [FIREWALL_VERSIONS]: [200, versionsDoc('1.0.2', '2.3.0')],
      [FIREWALL_230]: [
        200,
        JSON.stringify({
          source: 'https://github.com/terraform-aws-modules/terraform-aws-network-firewall',
          tag: 'v2.3.0',
        }),
      ],
      [FIREWALL_TF]: [200, 'terraform {\n  required_version = ">= 1.5.7"\n}\n'],
    });
    const result = await checkPin('AWS', 'networkFirewall', FIREWALL, { fetchImpl });
    expect(result.status).toBe('ok');
    expect(result.warnings[0]).toMatch(/2\.3\.0 is newer than the pinned 1\.0\.2/);
    expect(result.warnings[0]).toMatch(/Terraform: recorded `>= 1\.0`, 2\.3\.0 asks `>= 1\.5\.7`/);
    expect(exitCodeFor([result])).toBe(0);
    expect(summarize([result])).toMatch(/Worth a look/);
  });

  it('warns when a newer release has no versions.tf, rather than failing', async () => {
    const fetchImpl = fakeFetch({
      [FIREWALL_VERSIONS]: [200, versionsDoc('1.0.2', '2.3.0')],
      [FIREWALL_230]: [
        200,
        JSON.stringify({
          source: 'https://github.com/terraform-aws-modules/terraform-aws-network-firewall',
          tag: 'v2.3.0',
        }),
      ],
    });
    const result = await checkPin('AWS', 'networkFirewall', FIREWALL, { fetchImpl });
    expect(result.status).toBe('ok');
    expect(result.warnings[0]).toMatch(/has no versions\.tf/);
  });

  it('reports a registry outage as "could not finish", never as fine', async () => {
    const fetchImpl = fakeFetch({ [FIREWALL_VERSIONS]: [503, 'down'] });
    const result = await checkPin('AWS', 'networkFirewall', FIREWALL, {
      fetchImpl,
      attempts: 2,
      sleep: noWait,
    });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/answered HTTP 503/);
    expect(fetchImpl.calls).toHaveLength(2);
    expect(exitCodeFor([result])).toBe(2);
    expect(summarize([result])).toMatch(/could not finish/);
  });

  it('reports a GitHub failure while reading a newer release as "could not finish"', async () => {
    const fetchImpl = fakeFetch({
      [FIREWALL_VERSIONS]: [200, versionsDoc('1.0.2', '2.3.0')],
      [FIREWALL_230]: [
        200,
        JSON.stringify({
          source: 'https://github.com/terraform-aws-modules/terraform-aws-network-firewall',
          tag: 'v2.3.0',
        }),
      ],
      [FIREWALL_TF]: [500, 'oops'],
    });
    const result = await checkPin('AWS', 'networkFirewall', FIREWALL, { fetchImpl, attempts: 1 });
    expect(result.status).toBe('error');
  });

  it('reports an answer that is not JSON as "could not finish"', async () => {
    const fetchImpl = fakeFetch({ [FIREWALL_VERSIONS]: [200, '<html>'] });
    const result = await checkPin('AWS', 'networkFirewall', FIREWALL, { fetchImpl });
    expect(result).toMatchObject({ status: 'error' });
    expect(result.message).toMatch(/did not answer with JSON/);
  });

  it('a missing pin outranks an outage in the exit code', () => {
    expect(exitCodeFor([{ status: 'error' }, { status: 'missing' }, { status: 'ok' }])).toBe(1);
  });

  it('checks every module of every pack it is given', async () => {
    const fetchImpl = fakeFetch({ [FIREWALL_VERSIONS]: [200, versionsDoc('1.0.2')] });
    const results = await checkPins({
      packs: [{ cloud: 'AWS', modules: { a: FIREWALL, b: FIREWALL } }],
      fetchImpl,
    });
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
  });
});

describe('fetching', () => {
  it('turns a timeout into a sentence after the retries', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const fetchImpl = fakeFetch({ 'https://x.test/a': timeout });
    await expect(
      fetchText('https://x.test/a', { fetchImpl, timeoutMs: 1000, attempts: 2, sleep: noWait })
    ).rejects.toThrow('https://x.test/a could not be read: no answer within 1 seconds.');
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('does not retry a 403', async () => {
    const fetchImpl = fakeFetch({ 'https://x.test/a': [403, 'no'] });
    await expect(
      fetchText('https://x.test/a', { fetchImpl, attempts: 3, sleep: noWait })
    ).rejects.toThrow(/HTTP 403/);
    expect(fetchImpl.calls).toHaveLength(1);
  });
});

describe('the command line', () => {
  it('takes --summary and nothing else', () => {
    expect(parseArgs(['--summary', 'r.md'])).toEqual({ summary: 'r.md' });
    expect(() => parseArgs(['--fix'])).toThrow(/Unknown argument/);
  });

  // The workflow runs `node scripts/check-cloud-module-pins.mjs`, not the
  // test runner. Node needs every relative import written with its `.js`
  // ending; the test runner does not, so only this catches one written
  // without it in the files the script loads.
  it('loads under plain Node, as the workflow runs it', () => {
    const script = pathToFileURL(join(HERE, 'check-cloud-module-pins.mjs')).href;
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(script)}); console.log(m.PACKS.map((p) => Object.keys(p.modules).length).join(','));`,
      ],
      { encoding: 'utf8' }
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+,\d+$/);
  });
});
