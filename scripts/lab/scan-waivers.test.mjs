/**
 * The lab image scan waivers (#1650): the generator, and the committed file
 * the weekly scan reads.
 *
 * A waiver sets a finding aside, so these tests hold the lines that keep that
 * safe: every entry names the place it covers (an entry without one would set
 * the finding aside in every file of every image), names the maker the fix
 * waits on, and lapses within 31 days of being written, so it is looked at
 * again. The generator refuses a finding it cannot name a maker for.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MAKERS, parseArgs, placeOf, purlWithoutQualifiers, reasonFor, renderYaml, waiversFrom } from './scan-waivers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WAIVERS = join(REPO, '.github', 'lab-image-scan-waivers.yaml');
const DATES = { expires: '2026-12-12', checked: '2026-11-12' };

/** A Trivy JSON report with one result. */
const report = (result) => ({ Results: [result] });
const go = (target, ...ids) => ({ Target: target, Class: 'lang-pkgs', Type: 'gobinary', Vulnerabilities: ids.map((id) => ({ VulnerabilityID: id, PkgName: 'stdlib', PkgPath: '' })) });

describe('scan-waivers.mjs', () => {
  it('waives a Go finding in the program it was found in, with the maker the fix waits on', () => {
    const alz = 'opt/terraform/mirror/registry.terraform.io/azure/alz/0.22.1/linux_amd64/terraform-provider-alz_v0.22.1';
    const [entry] = waiversFrom([report(go(alz, 'CVE-2025-61726'))], DATES);
    expect(entry).toEqual({
      id: 'CVE-2025-61726',
      paths: [alz],
      purls: [],
      statement: 'Waits on Microsoft: Terraform provider Azure/alz 0.22.1 is its newest release and was built with these Go modules. Checked 2026-11-12.',
      expired_at: '2026-12-12',
    });
  });

  it('uses a Python package\'s METADATA path when it has one, and the package URL at its version when it has none', () => {
    const meta = 'opt/az/lib/python3.14/site-packages/oauthlib-3.2.2.dist-info/METADATA';
    expect(placeOf({ Type: 'python-pkg', Target: 'Python' }, { PkgPath: meta })).toEqual({ kind: 'paths', value: meta });
    const debian = { VulnerabilityID: 'CVE-1', PkgName: 'zlib1g', PkgIdentifier: { PURL: 'pkg:deb/debian/zlib1g@1.3.dfsg%2Breally1.3.1-1%2Bb1?arch=amd64&distro=debian-13.7&epoch=1' } };
    // Qualifiers go (they vary by build); the version stays, so the waiver ends when the package moves.
    expect(placeOf({ Type: 'debian', Target: 'img (debian 13.7)' }, debian)).toEqual({ kind: 'purls', value: 'pkg:deb/debian/zlib1g@1.3.dfsg%2Breally1.3.1-1%2Bb1' });
    expect(purlWithoutQualifiers('pkg:pypi/setuptools@70.3.0')).toBe('pkg:pypi/setuptools@70.3.0');
  });

  it('groups one finding id into one entry per maker, listing every place', () => {
    const entries = waiversFrom(
      [report(go('usr/bin/gh', 'CVE-2026-78661')), report(go('usr/libexec/docker/cli-plugins/docker-buildx', 'CVE-2026-78661')), report(go('usr/local/bin/helm', 'CVE-2026-78661'))],
      DATES
    );
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.statement.startsWith('Waits on Docker')).paths).toEqual(['usr/bin/gh', 'usr/libexec/docker/cli-plugins/docker-buildx']);
    expect(entries.find((e) => e.statement.startsWith('Waits on the Helm project')).paths).toEqual(['usr/local/bin/helm']);
  });

  it('refuses a finding no rule names a maker for, and names it', () => {
    expect(() => waiversFrom([report(go('usr/local/bin/something-new', 'CVE-9'))], DATES)).toThrow(/no maker is named for 1 finding\(s\)[\s\S]*CVE-9 in usr\/local\/bin\/something-new/);
  });

  it('refuses dates that are not YYYY-MM-DD, and a run with no report', () => {
    expect(() => waiversFrom([], { expires: 'next month', checked: '2026-11-12' })).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--expires', '2026-12-12'])).toThrow(/at least one Trivy JSON report/);
  });

  // One place each rule is for, in MAKERS order; a new rule needs its sample here.
  const SAMPLES = [
    'opt/terraform/mirror/registry.terraform.io/azure/azapi/2.13.0/linux_amd64/terraform-provider-azapi_v2.13.0',
    'opt/terraform/mirror/registry.terraform.io/hashicorp/random/3.9.1/linux_amd64/terraform-provider-random_v3.9.1_x5',
    'usr/local/bin/helm',
    'usr/local/bin/kubeconform',
    'usr/local/bin/kubectl',
    'opt/az/lib/python3.14/site-packages/cryptography-48.0.1.dist-info/METADATA',
    'pkg:pypi/setuptools@70.3.0',
    'pkg:deb/debian/zlib1g@1.3.dfsg%2Breally1.3.1-1%2Bb1',
    'usr/bin/pebble',
  ];

  it('every rule matches its own sample place and names who the fix waits on', () => {
    expect(SAMPLES).toHaveLength(MAKERS.length);
    MAKERS.forEach((rule, i) => {
      const m = SAMPLES[i].match(rule.match);
      expect(m, `rule ${i} does not match its sample ${SAMPLES[i]}`).not.toBeNull();
      expect(rule.reason(m)).toMatch(/^Waits on [^:]+: .+\.$/);
      // The first rule to match is the one used, so no earlier rule may claim this sample.
      expect(MAKERS.findIndex((r) => r.match.test(SAMPLES[i]))).toBe(i);
    });
    expect(reasonFor({ value: 'usr/local/bin/unknown' })).toBeNull();
  });

  it('renders YAML that a YAML reader returns unchanged', () => {
    const entries = waiversFrom([report(go('usr/local/bin/helm', 'CVE-2026-1'))], DATES);
    expect(parse(renderYaml(entries, DATES)).vulnerabilities).toEqual([
      { id: 'CVE-2026-1', paths: ['usr/local/bin/helm'], statement: entries[0].statement, expired_at: '2026-12-12' },
    ]);
  });
});

describe('.github/lab-image-scan-waivers.yaml, as committed', () => {
  const text = readFileSync(WAIVERS, 'utf8');
  const entries = parse(text).vulnerabilities;
  const written = text.match(/^# Written by scripts\/lab\/scan-waivers\.mjs on (\d{4}-\d{2}-\d{2});/m)?.[1];

  it('says when it was written', () => {
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('holds only vulnerability waivers, never misconfigurations, secrets or licences', () => {
    expect(Object.keys(parse(text))).toEqual(['vulnerabilities']);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('names the place every waiver covers, so none sets a finding aside everywhere', () => {
    for (const e of entries) {
      expect((e.paths?.length ?? 0) + (e.purls?.length ?? 0), `${e.id} names no path or package`).toBeGreaterThan(0);
      for (const p of e.purls ?? []) expect(p, `${e.id}: a package URL without a version would cover every version`).toMatch(/@[^@]+$/);
    }
  });

  it('gives every waiver a reason naming who the fix waits on', () => {
    for (const e of entries) expect(e.statement, e.id).toMatch(/^Waits on .+\. Checked \d{4}-\d{2}-\d{2}\.$/);
  });

  it('ends every waiver within 31 days of being written, so each is looked at again', () => {
    const start = Date.parse(`${written}T00:00:00Z`);
    for (const e of entries) {
      const end = Date.parse(`${e.expired_at}T00:00:00Z`);
      expect(Number.isFinite(end), `${e.id} has no readable expired_at`).toBe(true);
      expect(end, e.id).toBeGreaterThan(start);
      expect((end - start) / 86400000, e.id).toBeLessThanOrEqual(31);
    }
  });

  it('is read by the weekly scan, which still fails on anything it does not cover', () => {
    const workflow = readFileSync(join(REPO, '.github', 'workflows', 'lab-supply-chain.yml'), 'utf8');
    expect(workflow).toContain('waivers=".github/lab-image-scan-waivers.yaml"');
    expect(workflow).toContain('test -s "$waivers"');
    expect(workflow).toContain('waive=(--ignorefile "$waivers" --show-suppressed)');
    expect(workflow).toContain('--ignore-unfixed "${waive[@]}" --exit-code 1');
  });
});
