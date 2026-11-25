/**
 * Generate the brand artwork under public/images/ from SVG templates.
 *
 * GENERATED ART. The PNGs in public/images/{gcp,github,terraform,finops,docker}-hero/
 * (landing hero rotations, #371) and public/images/default-heroes/ (default
 * social covers, #351) are drawn by this script — not bought, not stock, not
 * hand-made. Every file can be replaced one-for-one with real artwork later;
 * nothing in the site keys on it being generated. Regenerate from frontend/:
 *
 *     npm run art:generate
 *     npm run art:generate -- --check     (render, compare with the committed bytes)
 *
 * Output is deterministic. Each composition takes its randomness from a seed
 * derived from the provider and variant name, the only font is
 * public/fonts/other/goldman (OFL, already shipped with the site — no system
 * font is consulted, so a machine without Goldman renders the same pixels), and
 * the PNG encoder (brand-art-png.mjs) is fixed rather than whatever a library
 * defaults to.
 * The same commit of this file therefore yields byte-identical PNGs anywhere.
 *
 * Why SVG + @resvg/resvg-js: the site cannot pay for an image service (#371),
 * and SVG rasterized by a single dev-only native package is the cheapest thing
 * that is reviewable in a diff. It is a devDependency and this script is not
 * part of `npm run build`: the PNGs are committed and Vite copies public/ as-is.
 * generate-brand-art.test.js checks the committed files against the sizes and
 * formats the pages expect (1155×924 RGBA like azure-hero/, 1200×630 covers).
 *
 * Palettes come from the provider accents in src/index.css
 * (--color-<provider>-primary and the .theme-<provider> blocks).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HERO_COMPOSITIONS, rings } from './brand-art-compositions.mjs';
import { encodePng } from './brand-art-png.mjs';
import { esc, hashSeed, mulberry32, n } from './brand-art-seed.mjs';

// The compositions (brand-art-compositions.mjs and brand-art-networks.mjs),
// their helpers (brand-art-seed.mjs) and the PNG encoder (brand-art-png.mjs)
// live in sibling files; what this file exported from them before is
// re-exported here.
export { HERO_COMPOSITIONS } from './brand-art-compositions.mjs';
export { encodePng } from './brand-art-png.mjs';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES = join(FRONTEND, 'public', 'images');
const FONT_DIR = join(FRONTEND, 'public', 'fonts', 'other', 'goldman');
const FONT_FILES = [join(FONT_DIR, 'Goldman-Bold.ttf'), join(FONT_DIR, 'Goldman-Regular.ttf')];

/** azure-hero/1.png is 1155×924 8-bit RGBA; the carousel object-covers, but match it. */
export const HERO_SIZE = { width: 1155, height: 924 };
/** Open Graph / social card ratio. */
export const COVER_SIZE = { width: 1200, height: 630 };
export const HERO_VARIANTS = 5;
/** Ceiling per file — the largest azure-hero file is 277 KB. */
export const MAX_BYTES = 400 * 1024;

// Docker joined both lists with #775: its landing page gets a hero rotation
// like Terraform's, and the CMS a default cover (HERO_PROVIDERS in
// functions/src/lib/platform-settings.js names Docker).
export const HERO_PROVIDERS = ['gcp', 'github', 'terraform', 'finops', 'docker'];
export const COVER_PROVIDERS = [
  'azure',
  'aws',
  'gcp',
  'github',
  'terraform',
  'ansible',
  'vmware',
  'docker',
  'multi',
];

/**
 * bg: canvas gradient (dark, so the art sits beside the dark portal screenshots
 * in azure-hero/); tones: three accents drawn from, lightest last; name: the
 * wordmark, plain words rather than any logo.
 */
export const PALETTES = {
  azure: { name: 'Azure', bg: ['#061225', '#0b2a4a'], tones: ['#0078d4', '#00a4ef', '#50e6ff'] },
  aws: { name: 'AWS', bg: ['#0f1720', '#232f3e'], tones: ['#ec7211', '#ff9900', '#ffc46b'] },
  gcp: {
    name: 'Google Cloud',
    bg: ['#0f1424', '#1a2238'],
    tones: ['#db4437', '#4285f4', '#f4b400', '#0f9d58'],
  },
  github: { name: 'GitHub', bg: ['#0d1117', '#161b22'], tones: ['#8b949e', '#58a6ff', '#e6edf3'] },
  terraform: {
    name: 'Terraform',
    bg: ['#120a22', '#1f1338'],
    tones: ['#7b42bc', '#844fba', '#c39ee8'],
  },
  finops: { name: 'FinOps', bg: ['#061a15', '#0d2b23'], tones: ['#1ea482', '#34d399', '#a7f3d0'] },
  ansible: {
    name: 'Ansible',
    bg: ['#1a0707', '#2b0d0d'],
    tones: ['#c00000', '#ee0000', '#ff8a8a'],
  },
  vmware: { name: 'VMware', bg: ['#06141e', '#0c2a3d'], tones: ['#0091da', '#00c1d5', '#8ee0f2'] },
  // --docker-blue (#1D63ED) from src/index.css, a lighter blue, then the lightest.
  docker: { name: 'Docker', bg: ['#050d1f', '#0a1a3a'], tones: ['#1d63ed', '#4d8af5', '#b3cefb'] },
  multi: {
    name: 'Hybrid Cloud',
    bg: ['#0f1219', '#1c2230'],
    tones: ['#64748b', '#38bdf8', '#e2e8f0'],
  },
};

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function frame({ width, height }, p, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${p.bg[0]}"/><stop offset="1" stop-color="${p.bg[1]}"/>` +
    `</linearGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#bg)"/>` +
    body +
    '</svg>'
  );
}

/** Wordmark sized so the longest name still fits the width. */
function fitSize(label, maxWidth, ideal) {
  return Math.min(ideal, maxWidth / (label.length * 0.78));
}

function heroText(ctx, variant) {
  const { w, h, p } = ctx;
  const label = p.name.toUpperCase();
  const size = fitSize(label, w * 0.88, h * 0.15);
  return (
    `<text x="${n(w * 0.06)}" y="${n(h * 0.9)}" font-family="Goldman" font-weight="700" font-size="${n(size)}" letter-spacing="${n(size * 0.08)}" fill="${p.tones[2]}" opacity="0.12">${esc(label)}</text>` +
    `<text x="${n(w * 0.94)}" y="${n(h * 0.09)}" text-anchor="end" font-family="Goldman" font-size="22" letter-spacing="6" fill="${p.tones[2]}" opacity="0.5">0${variant}</text>`
  );
}

export function buildHeroSvg(provider, variant) {
  const p = PALETTES[provider];
  if (!p) throw new Error(`no palette for provider "${provider}"`);
  if (!Number.isInteger(variant) || variant < 1 || variant > HERO_VARIANTS) {
    throw new Error(`variant must be 1..${HERO_VARIANTS}, got ${variant}`);
  }
  const ctx = {
    w: HERO_SIZE.width,
    h: HERO_SIZE.height,
    p,
    rng: mulberry32(hashSeed(`hero:${provider}:${variant}`)),
  };
  const compose = HERO_COMPOSITIONS[variant - 1];
  return frame(HERO_SIZE, p, compose(ctx) + heroText(ctx, variant));
}

export function buildCoverSvg(provider) {
  const p = PALETTES[provider];
  if (!p) throw new Error(`no palette for provider "${provider}"`);
  const { width: w, height: h } = COVER_SIZE;
  const ctx = { w, h, p, rng: mulberry32(hashSeed(`cover:${provider}`)) };
  const edgeTop = w * 0.5;
  const edgeBottom = w * 0.38;
  let body =
    `<pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse">` +
    `<circle cx="16" cy="16" r="1.1" fill="${p.tones[2]}" opacity="0.14"/></pattern>` +
    `<rect width="${w}" height="${h}" fill="url(#dots)"/>`;
  body += `<clipPath id="side"><polygon points="${n(edgeTop)},0 ${w},0 ${w},${h} ${n(edgeBottom)},${h}"/></clipPath>`;
  body += `<g clip-path="url(#side)">${rings(ctx, { x: w * 0.86, y: h * 0.3 })}</g>`;
  body += `<line x1="${n(edgeTop)}" y1="0" x2="${n(edgeBottom)}" y2="${h}" stroke="${p.tones[2]}" stroke-width="2" opacity="0.45"/>`;
  const label = p.name;
  const size = fitSize(label.toUpperCase(), w * 0.42, 84);
  body +=
    `<rect x="72" y="${n(h * 0.34)}" width="6" height="${n(h * 0.3)}" fill="${p.tones[1]}"/>` +
    `<text x="100" y="${n(h * 0.55)}" font-family="Goldman" font-weight="700" font-size="${n(size)}" letter-spacing="2" fill="${p.tones[2]}">${esc(label)}</text>` +
    `<text x="100" y="${n(h * 0.55 + 46)}" font-family="Goldman" font-size="20" letter-spacing="7" fill="${p.tones[1]}" opacity="0.9">HYBRIDCLOUDWORKS</text>`;
  return frame(COVER_SIZE, p, body);
}

// ---------------------------------------------------------------------------
// Raster + PNG
// ---------------------------------------------------------------------------

/** Every file this script owns, with its builder and expected size. */
export function outputs() {
  const list = [];
  for (const provider of HERO_PROVIDERS) {
    for (let variant = 1; variant <= HERO_VARIANTS; variant += 1) {
      list.push({
        file: join(IMAGES, `${provider}-hero`, `${variant}.png`),
        publicPath: `/images/${provider}-hero/${variant}.png`,
        size: HERO_SIZE,
        svg: () => buildHeroSvg(provider, variant),
      });
    }
  }
  for (const provider of COVER_PROVIDERS) {
    list.push({
      file: join(IMAGES, 'default-heroes', `${provider}.png`),
      publicPath: `/images/default-heroes/${provider}.png`,
      size: COVER_SIZE,
      svg: () => buildCoverSvg(provider),
    });
  }
  return list;
}

export async function renderPng(svg, size) {
  const { Resvg } = await import('@resvg/resvg-js');
  const image = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: 'Goldman' },
  }).render();
  if (image.width !== size.width || image.height !== size.height) {
    throw new Error(
      `rendered ${image.width}×${image.height}, expected ${size.width}×${size.height}`
    );
  }
  return encodePng(image.width, image.height, image.pixels);
}

/**
 * Renders one output and either compares it with the committed file (`check`)
 * or writes it. Returns its size and whether it differs from the committed one.
 */
async function renderTarget(target, check) {
  const png = await renderPng(target.svg(), target.size);
  const rel = target.file.slice(FRONTEND.length + 1);
  if (png.length > MAX_BYTES) {
    throw new Error(`${rel} is ${png.length} bytes, over the ${MAX_BYTES} ceiling`);
  }
  if (check) {
    const same = existsSync(target.file) && readFileSync(target.file).equals(png);
    console.log(`[brand-art] ${same ? 'same ' : 'DIFF '} ${rel}`);
    return { bytes: png.length, stale: !same };
  }
  mkdirSync(dirname(target.file), { recursive: true });
  writeFileSync(target.file, png);
  console.log(`[brand-art] ${rel} ${target.size.width}×${target.size.height} ${png.length} bytes`);
  return { bytes: png.length, stale: false };
}

async function main(argv) {
  const check = argv.includes('--check');
  for (const font of FONT_FILES) {
    if (!existsSync(font)) throw new Error(`font missing: ${font}`);
  }
  let total = 0;
  let stale = 0;
  for (const target of outputs()) {
    const result = await renderTarget(target, check);
    total += result.bytes;
    if (result.stale) stale += 1;
  }
  console.log(
    `[brand-art] ${outputs().length} files, ${total} bytes${check ? `, ${stale} differ` : ''}`
  );
  if (check && stale > 0) process.exit(1);
}

const invokedDirectly =
  import.meta.url.startsWith('file:') &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[brand-art] ${error.message}`);
    process.exit(1);
  });
}
