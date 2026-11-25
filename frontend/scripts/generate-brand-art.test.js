/**
 * The generated brand art (#371, #351) is committed, so this checks the
 * committed files rather than re-rendering them: every file the generator owns
 * exists, is the size and format the pages expect (8-bit RGBA like
 * azure-hero/), and stays under the byte ceiling. The SVG side is checked for
 * determinism and self-containment, which is what makes `art:generate` a
 * reproducible step rather than a one-off.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import {
  COVER_PROVIDERS,
  COVER_SIZE,
  HERO_PROVIDERS,
  HERO_SIZE,
  HERO_VARIANTS,
  MAX_BYTES,
  PALETTES,
  buildCoverSvg,
  buildHeroSvg,
  encodePng,
  outputs,
} from './generate-brand-art.mjs';

/** Width, height, bit depth and colour type from the IHDR chunk. */
function pngHeader(file) {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    depth: bytes[24],
    colorType: bytes[25],
  };
}

describe('generated brand art', () => {
  it('owns five hero images for each provider whose set was missing, and nine covers', () => {
    const files = outputs().map((o) => o.publicPath);
    expect(files).toHaveLength(HERO_PROVIDERS.length * HERO_VARIANTS + COVER_PROVIDERS.length);
    // Docker's set since #775: its landing page had no hero art of its own.
    for (const provider of ['gcp', 'github', 'terraform', 'finops', 'docker']) {
      for (let i = 1; i <= 5; i += 1) expect(files).toContain(`/images/${provider}-hero/${i}.png`);
    }
    for (const provider of [
      'azure',
      'aws',
      'gcp',
      'github',
      'terraform',
      'ansible',
      'vmware',
      'docker',
      'multi',
    ]) {
      expect(files).toContain(`/images/default-heroes/${provider}.png`);
    }
  });

  it('has a palette for every provider it draws', () => {
    for (const provider of [...HERO_PROVIDERS, ...COVER_PROVIDERS]) {
      expect(PALETTES[provider], provider).toBeDefined();
      expect(PALETTES[provider].tones.length).toBeGreaterThanOrEqual(3);
    }
  });

  for (const target of outputs()) {
    it(`${target.publicPath} is committed at ${target.size.width}×${target.size.height} RGBA under the ceiling`, () => {
      expect(existsSync(target.file), `missing: run npm run art:generate`).toBe(true);
      expect(statSync(target.file).size).toBeLessThanOrEqual(MAX_BYTES);
      expect(pngHeader(target.file)).toEqual({
        width: target.size.width,
        height: target.size.height,
        depth: 8,
        colorType: 6,
      });
    });
  }

  it('builds the same SVG for the same provider and variant every time', () => {
    expect(buildHeroSvg('gcp', 3)).toBe(buildHeroSvg('gcp', 3));
    expect(buildCoverSvg('multi')).toBe(buildCoverSvg('multi'));
    expect(buildHeroSvg('gcp', 3)).not.toBe(buildHeroSvg('gcp', 4));
    expect(buildHeroSvg('gcp', 3)).not.toBe(buildHeroSvg('finops', 3));
  });

  it('references nothing outside the document', () => {
    const svgs = [
      ...HERO_PROVIDERS.flatMap((p) =>
        Array.from({ length: HERO_VARIANTS }, (_, i) => buildHeroSvg(p, i + 1))
      ),
      ...COVER_PROVIDERS.map((p) => buildCoverSvg(p)),
    ];
    for (const svg of svgs) {
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).not.toMatch(/href=|<image|@import|url\((?!#)/);
      expect(svg).toContain('font-family="Goldman"');
    }
    expect(buildHeroSvg('gcp', 1)).toContain(
      `width="${HERO_SIZE.width}" height="${HERO_SIZE.height}"`
    );
    expect(buildCoverSvg('aws')).toContain(
      `width="${COVER_SIZE.width}" height="${COVER_SIZE.height}"`
    );
  });

  it('rejects a provider without a palette and a variant out of range', () => {
    expect(() => buildHeroSvg('oracle', 1)).toThrow(/no palette/);
    expect(() => buildHeroSvg('gcp', 0)).toThrow(/variant/);
    expect(() => buildHeroSvg('gcp', HERO_VARIANTS + 1)).toThrow(/variant/);
    expect(() => buildCoverSvg('oracle')).toThrow(/no palette/);
  });

  it('encodes a valid 8-bit RGBA PNG and refuses a short pixel buffer', () => {
    const rgba = Buffer.alloc(2 * 2 * 4, 0xff);
    const png = encodePng(2, 2, rgba);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(2);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
    expect(() => encodePng(2, 2, Buffer.alloc(3))).toThrow(/expected 16/);
  });

  // Written before #1859 moved the Paeth predictor into its own function. A
  // PNG row is stored as the difference from a guess (the filter), and the
  // encoder picks the guess that makes the row smallest. This decodes the
  // file with the PNG specification's own rules, written separately here, so
  // a wrong guess anywhere in the encoder shows up as a wrong pixel.
  it('picks the smallest filter per row, and the pixels decode back exactly', () => {
    const width = 8;
    const height = 6;
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        rgba[i] = x * 20 + y * 7;
        rgba[i + 1] = (x * x + y * 3) & 0xff;
        rgba[i + 2] = (y * y * 5 + x) & 0xff;
        rgba[i + 3] = 255;
      }
    }
    const png = encodePng(width, height, rgba);
    const idat = [];
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at);
      if (png.subarray(at + 4, at + 8).toString('ascii') === 'IDAT') {
        idat.push(png.subarray(at + 8, at + 8 + length));
      }
      at += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * 4;
    const paeth = (a, b, c) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      if (pb <= pc) return b;
      return c;
    };
    const decoded = Buffer.alloc(stride * height);
    const filters = [];
    for (let y = 0; y < height; y += 1) {
      const filter = raw[y * (stride + 1)];
      filters.push(filter);
      for (let i = 0; i < stride; i += 1) {
        const a = i >= 4 ? decoded[y * stride + i - 4] : 0;
        const b = y > 0 ? decoded[(y - 1) * stride + i] : 0;
        const c = y > 0 && i >= 4 ? decoded[(y - 1) * stride + i - 4] : 0;
        const guess = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
        decoded[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + guess) & 0xff;
      }
    }
    expect(filters).toEqual([1, 4, 4, 4, 4, 4]);
    expect(decoded.equals(rgba)).toBe(true);
  });
});
