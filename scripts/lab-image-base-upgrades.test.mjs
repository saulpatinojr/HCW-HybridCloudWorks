/**
 * The lab image's runner stage upgrades zlib1g from Debian's own
 * trixie-security (#1700), because the pinned python slim base had not been
 * republished with Debian's fix. These tests hold the step to the shape that
 * makes it safe: it guards the name, upgrades only, checks the version it got,
 * leaves no apt lists, and sits in `runner`, so both images carry it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = readFileSync(join(REPO, 'lab-image', 'Dockerfile'), 'utf8');
const runner = DOCKERFILE.slice(DOCKERFILE.indexOf(' AS runner'), DOCKERFILE.indexOf('FROM runner AS full'));
const WAIVERS = readFileSync(join(REPO, '.github', 'lab-image-scan-waivers.yaml'), 'utf8');

describe('lab-image/Dockerfile: the base packages the runner upgrades (#1700)', () => {
  const run = runner.slice(runner.indexOf('RUN set -eu; \\\n    for pkg in'), runner.indexOf('rm -rf /var/lib/apt/lists/*') + 30);

  it('guards and upgrades the same names, after apt-get update', () => {
    expect(run).not.toBe('');
    const guarded = run.match(/for pkg in ([^;]+); do/)[1].trim().split(/\s+/).sort();
    const upgraded = run.match(/apt-get install -y --no-install-recommends --only-upgrade ([^;]+);/)[1].trim().split(/\s+/).sort();
    expect(guarded).toEqual(['zlib1g']);
    expect(upgraded).toEqual(guarded);
    expect(run).toContain("[ \"$(dpkg-query -W -f='${db:Status-Status}' \"${pkg}\" 2> /dev/null)\" = installed ]");
    expect(run.indexOf('apt-get update;')).toBeGreaterThan(-1);
    expect(run.indexOf('apt-get update;')).toBeLessThan(run.indexOf('apt-get install -y --no-install-recommends --only-upgrade'));
  });

  it("fails the build when the version installed is older than Debian's fix", () => {
    expect(run).toMatch(/dpkg --compare-versions "\$\(dpkg-query -W -f='\$\{Version\}' zlib1g\)" ge '1:1\.3\.dfsg\+really1\.3\.1-1\+deb13u1'/);
    expect(run.indexOf('--compare-versions')).toBeGreaterThan(run.indexOf('apt-get install -y --no-install-recommends --only-upgrade'));
  });

  it('leaves no apt lists in the layer, and comes before the runner copies anything in', () => {
    expect(run).toContain('rm -rf /var/lib/apt/lists/*');
    expect(runner.indexOf('--only-upgrade zlib1g')).toBeLessThan(runner.indexOf('COPY --from=fetch /out/bin/'));
  });

  it('no longer waives the two zlib1g findings it fixes', () => {
    expect(WAIVERS).not.toContain('zlib1g');
    expect(WAIVERS).not.toContain('CVE-2026-76844');
    expect(WAIVERS).not.toContain('CVE-2026-85091');
  });
});
