import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readAddonPins, toMatrix } from './lab/read-addon-pins.mjs';

const GROUP_VARS = readFileSync(new URL('../lab-host/ansible/group_vars/all.yml', import.meta.url), 'utf8');
const D1 = `sha256:${'a'.repeat(64)}`;
const D2 = `sha256:${'b'.repeat(64)}`;

const fixture = (rows) => `addons_enabled: true\naddons:\n${rows}\nnext_key: 1\n`;
const row = (id, { enabled = 'true', image = `docker.io/hybridcloudworks/img-${id}-lab-addon`, digest = D1 } = {}) =>
  `  - id: ${id}\n    enabled: ${enabled}\n    image: ${image}\n    image_tag: "v1"\n    image_digest: "${digest}"\n    port: 18081\n`;

describe('read-addon-pins: the add-on images the lab host runs', () => {
  it('reads the real group_vars: the three deployed add-ons, each a hybridcloudworks image by digest', () => {
    const pins = readAddonPins(GROUP_VARS);
    expect(pins.map((p) => p.id)).toEqual(expect.arrayContaining(['migration', 'network-assessment', 'cloud-assessment']));
    for (const p of pins) {
      expect(p.image).toMatch(/^docker\.io\/hybridcloudworks\/img-[a-z]+-lab-addon$/);
      expect(p.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('turns pins into a matrix whose image is repository@digest', () => {
    const matrix = toMatrix(readAddonPins(fixture(row('mo') + row('ne', { digest: D2 }))));
    expect(matrix).toEqual({
      include: [
        { id: 'mo', image: `docker.io/hybridcloudworks/img-mo-lab-addon@${D1}` },
        { id: 'ne', image: `docker.io/hybridcloudworks/img-ne-lab-addon@${D2}` },
      ],
    });
  });

  it('skips a row with no digest or that is disabled, as the addons role does not deploy it', () => {
    const pins = readAddonPins(fixture(row('mo') + row('cc', { digest: '' }) + row('off', { enabled: 'false' })));
    expect(pins.map((p) => p.id)).toEqual(['mo']);
  });

  it('reads a bare or single-quoted digest as the same pin the addons role reads, not as an empty one', () => {
    const bare = row('mo').replace(`image_digest: "${D1}"`, `image_digest: ${D1}`);
    const single = row('ne').replace(`image_digest: "${D1}"`, `image_digest: '${D2}'`);
    const commented = row('ca').replace(`image_digest: "${D1}"`, `image_digest: ${D1} # pinned 2026-10-25`);
    expect(bare).toContain(`image_digest: ${D1}\n`);
    expect(readAddonPins(fixture(bare + single + commented)).map((p) => [p.id, p.digest])).toEqual([
      ['mo', D1],
      ['ne', D2],
      ['ca', D1],
    ]);
    // A bare value that is not a digest still stops the run.
    expect(() => readAddonPins(fixture(row('mo').replace(`image_digest: "${D1}"`, 'image_digest: latest')))).toThrow(/image_digest/);
  });

  it('stops on a malformed pin instead of skipping it', () => {
    expect(() => readAddonPins(fixture(row('mo', { digest: 'sha256:abc' })))).toThrow(/image_digest/);
    expect(() => readAddonPins(fixture(row('mo', { image: 'ghcr.io/someone/else' })))).toThrow(/is not docker\.io\/hybridcloudworks/);
  });

  it('stops when there is nothing to check', () => {
    expect(() => readAddonPins('other: 1\n')).toThrow(/no `addons:` block/);
    expect(() => readAddonPins(fixture(row('cc', { digest: '' })))).toThrow(/nothing to check/);
  });

  it('reads CRLF files the same way', () => {
    expect(readAddonPins(fixture(row('mo')).replace(/\n/g, '\r\n')).map((p) => p.id)).toEqual(['mo']);
  });
});
