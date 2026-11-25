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
 * the PNG encoder below is fixed rather than whatever a library defaults to.
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
import { crc32, deflateSync } from 'node:zlib';

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
// Deterministic randomness
// ---------------------------------------------------------------------------

/** FNV-1a over the label so a seed follows from the name alone. */
function hashSeed(text) {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, well-distributed, and identical on every JS engine. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two decimals keeps the SVG small and its text stable across engines. */
const n = (value) => Number(value.toFixed(2));

const esc = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// Compositions. Each returns SVG markup for the area inside the frame.
// ctx: { w, h, p (palette), rng }
// ---------------------------------------------------------------------------

function pick(ctx, list) {
  return list[Math.floor(ctx.rng() * list.length)];
}

function glow(ctx, cx, cy, r, tone = 0, opacity = 0.5) {
  const id = `glow-${n(cx)}-${n(cy)}`.replace(/\./g, '_');
  return (
    `<radialGradient id="${id}"><stop offset="0" stop-color="${ctx.p.tones[tone]}" stop-opacity="${n(opacity)}"/>` +
    `<stop offset="1" stop-color="${ctx.p.tones[tone]}" stop-opacity="0"/></radialGradient>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="url(#${id})"/>`
  );
}

/** Diagonal bands sweeping in from the right, cut by a clean diagonal edge. */
function bands(ctx) {
  const { w, h, rng, p } = ctx;
  const angle = -(18 + rng() * 16);
  const edgeTop = w * (0.3 + rng() * 0.15);
  const edgeBottom = edgeTop - w * (0.15 + rng() * 0.1);
  let out = glow(ctx, w * 0.82, h * 0.22, h * 0.75, 1, 0.45);
  out += `<clipPath id="wedge"><polygon points="${n(edgeTop)},0 ${w},0 ${w},${h} ${n(edgeBottom)},${h}"/></clipPath>`;
  // Stripes live in a square about the centre just large enough to cover every
  // corner after rotation (the half-diagonal is 740 px). Geometry that runs far
  // off-canvas inside a clipped group makes resvg truncate the clipped layer.
  const reach = 760;
  out += `<g clip-path="url(#wedge)"><g transform="rotate(${n(angle)} ${w / 2} ${h / 2})">`;
  let x = w / 2 - reach;
  while (x < w / 2 + reach) {
    const width = 16 + rng() * 150;
    const gap = 8 + rng() * 70;
    out += `<rect x="${n(x)}" y="${n(h / 2 - reach)}" width="${n(width)}" height="${n(reach * 2)}" fill="${pick(ctx, p.tones)}" opacity="${n(0.07 + rng() * 0.33)}"/>`;
    x += width + gap;
  }
  out += '</g></g>';
  out += `<line x1="${n(edgeTop)}" y1="0" x2="${n(edgeBottom)}" y2="${h}" stroke="${p.tones[2]}" stroke-width="2" opacity="0.5"/>`;
  return out;
}

function annulusSector(cx, cy, rIn, rOut, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const px = (r, a) => `${n(cx + r * Math.cos(a))},${n(cy + r * Math.sin(a))}`;
  return (
    `M${px(rOut, a0)} A${n(rOut)},${n(rOut)} 0 ${large} 1 ${px(rOut, a1)} ` +
    `L${px(rIn, a1)} A${n(rIn)},${n(rIn)} 0 ${large} 0 ${px(rIn, a0)} Z`
  );
}

/** Concentric rings from a corner, some carrying filled arc segments. */
function rings(ctx, origin) {
  const { w, h, rng, p } = ctx;
  const cx = origin ? origin.x : w * (0.7 + rng() * 0.2);
  const cy = origin ? origin.y : h * (0.12 + rng() * 0.2);
  let out = glow(ctx, cx, cy, h * 0.6, 0, 0.55);
  const step = h * 0.07;
  for (let i = 1; i <= 15; i += 1) {
    const r = i * step + rng() * 12;
    const tone = p.tones[i % p.tones.length];
    const opacity = 0.08 + rng() * 0.28;
    out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke="${tone}" stroke-width="${n(1 + rng() * 6)}" opacity="${n(opacity)}"/>`;
    if (rng() < 0.4) {
      const a0 = rng() * Math.PI * 2;
      const a1 = a0 + 0.3 + rng() * 1.3;
      out += `<path d="${annulusSector(cx, cy, r, r + 14 + rng() * 44, a0, a1)}" fill="${tone}" opacity="${n(opacity + 0.18)}"/>`;
    }
  }
  return out;
}

/** A field of isometric cubes, back to front. */
function isogrid(ctx) {
  const { w, h, rng, p } = ctx;
  const s = 44 + rng() * 18;
  const rise = s * 0.5774;
  const lift = s * (0.7 + rng() * 0.5);
  const ox = w * (0.55 + rng() * 0.15);
  const oy = h * (0.35 + rng() * 0.15);
  let out = glow(ctx, ox, oy + h * 0.15, h * 0.7, 1, 0.35);
  const cubes = [];
  for (let i = -5; i <= 5; i += 1) {
    for (let j = -5; j <= 5; j += 1) {
      if (rng() < 0.55) continue;
      cubes.push({ i, j, z: rng() < 0.3 ? 2 : 1, opacity: 0.62 + rng() * 0.36 });
    }
  }
  cubes.sort((a, b) => a.i + a.j - (b.i + b.j));
  for (const { i, j, z, opacity } of cubes) {
    const x = ox + (i - j) * s;
    const y = oy + (i + j) * rise;
    const top = y - lift * z;
    const t = (px, py) => `${n(px)},${n(py)}`;
    out += `<g opacity="${n(opacity)}">`;
    out += `<polygon points="${t(x, top - rise)} ${t(x + s, top)} ${t(x, top + rise)} ${t(x - s, top)}" fill="${p.tones[2]}"/>`;
    out += `<polygon points="${t(x - s, top)} ${t(x, top + rise)} ${t(x, y + rise)} ${t(x - s, y)}" fill="${p.tones[0]}"/>`;
    out += `<polygon points="${t(x, top + rise)} ${t(x + s, top)} ${t(x + s, y)} ${t(x, y + rise)}" fill="${p.tones[1]}"/>`;
    out += '</g>';
  }
  return out;
}

/** Scattered nodes joined to their nearest neighbours, over a faint dot grid. */
function nodes(ctx) {
  const { w, h, rng, p } = ctx;
  let out =
    `<pattern id="dots" width="36" height="36" patternUnits="userSpaceOnUse">` +
    `<circle cx="18" cy="18" r="1.2" fill="${p.tones[2]}" opacity="0.18"/></pattern>` +
    `<rect width="${w}" height="${h}" fill="url(#dots)"/>` +
    `<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>`;
  out += glow(ctx, w * 0.3, h * 0.7, h * 0.7, 0, 0.35);
  const points = Array.from({ length: 44 }, () => ({
    x: w * (0.04 + rng() * 0.92),
    y: h * (0.06 + rng() * 0.88),
    r: 2 + rng() * 5,
    tone: pick(ctx, p.tones),
  }));
  const seen = new Set();
  for (let a = 0; a < points.length; a += 1) {
    const nearest = points
      .map((b, idx) => ({ idx, d: Math.hypot(points[a].x - b.x, points[a].y - b.y) }))
      .filter((c) => c.idx !== a)
      .sort((c, d) => c.d - d.d)
      .slice(0, 2);
    for (const { idx } of nearest) {
      const key = a < idx ? `${a}-${idx}` : `${idx}-${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out += `<line x1="${n(points[a].x)}" y1="${n(points[a].y)}" x2="${n(points[idx].x)}" y2="${n(points[idx].y)}" stroke="${p.tones[1]}" stroke-width="1.2" opacity="0.38"/>`;
    }
  }
  for (const pt of points) {
    if (pt.r > 5) {
      out += `<circle cx="${n(pt.x)}" cy="${n(pt.y)}" r="${n(pt.r * 3)}" fill="${pt.tone}" opacity="0.5" filter="url(#soft)"/>`;
    }
    out += `<circle cx="${n(pt.x)}" cy="${n(pt.y)}" r="${n(pt.r)}" fill="${pt.tone}" opacity="0.9"/>`;
  }
  return out;
}

/** Layered sine curves with a filled sea under the lowest. */
function waves(ctx) {
  const { w, h, rng, p } = ctx;
  let out = glow(ctx, w * 0.5, h * 0.55, w * 0.55, 1, 0.3);
  const layers = 9;
  for (let k = 0; k < layers; k += 1) {
    const base = h * (0.3 + k * 0.065);
    const amp = 24 + rng() * 70;
    const phase = rng() * Math.PI * 2;
    const freq = 0.8 + rng() * 1.6;
    const pts = [];
    for (let i = 0; i <= 90; i += 1) {
      const x = -20 + ((w + 40) * i) / 90;
      const y = base + amp * Math.sin((freq * 2 * Math.PI * x) / w + phase);
      pts.push(`${n(x)},${n(y)}`);
    }
    const tone = p.tones[k % p.tones.length];
    const line = `M${pts.join(' L')}`;
    if (k === layers - 1) {
      out += `<path d="${line} L${w + 20},${h + 20} L-20,${h + 20} Z" fill="${tone}" opacity="0.18"/>`;
    }
    out += `<path d="${line}" fill="none" stroke="${tone}" stroke-width="${n(1.2 + rng() * 3)}" opacity="${n(0.25 + rng() * 0.5)}"/>`;
  }
  return out;
}

export const HERO_COMPOSITIONS = [bands, rings, isogrid, nodes, waves];

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function frame({ width, height }, p, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${p.bg[0]}"/><stop offset="1" stop-color="${p.bg[1]}"/>` +
    `</linearGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#bg)"/>${body}</svg>`
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

/**
 * The PNG Paeth predictor: of the byte to the left (a), above (b) and above
 * left (c), the one nearest to a + b - c, preferring a, then b, on a tie.
 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Minimal PNG writer: 8-bit RGBA (colour type 6, like azure-hero/), one IDAT,
 * per-row filter chosen by the smallest sum of absolute residuals, deflate
 * level 9. Written here so the bytes depend on node:zlib alone and not on a
 * library's defaults.
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new Error(`pixel buffer is ${rgba.length} bytes, expected ${stride * height}`);
  }
  const raw = Buffer.alloc((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y += 1) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f += 1) {
      const out = candidates[f];
      let sum = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= 4 ? row[i - 4] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= 4 ? prev[i - 4] : 0;
        let predicted;
        if (f === 0) predicted = 0;
        else if (f === 1) predicted = a;
        else if (f === 2) predicted = b;
        else if (f === 3) predicted = (a + b) >> 1;
        else predicted = paeth(a, b, c);
        const v = (row[i] - predicted) & 0xff;
        out[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    candidates[best].copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(head) >>> 0);
    return Buffer.concat([len, head, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

async function main(argv) {
  const check = argv.includes('--check');
  for (const font of FONT_FILES) {
    if (!existsSync(font)) throw new Error(`font missing: ${font}`);
  }
  let total = 0;
  let stale = 0;
  for (const target of outputs()) {
    const png = await renderPng(target.svg(), target.size);
    total += png.length;
    const rel = target.file.slice(FRONTEND.length + 1);
    if (png.length > MAX_BYTES) {
      throw new Error(`${rel} is ${png.length} bytes, over the ${MAX_BYTES} ceiling`);
    }
    if (check) {
      const same = existsSync(target.file) && readFileSync(target.file).equals(png);
      if (!same) stale += 1;
      console.log(`[brand-art] ${same ? 'same ' : 'DIFF '} ${rel}`);
      continue;
    }
    mkdirSync(dirname(target.file), { recursive: true });
    writeFileSync(target.file, png);
    console.log(
      `[brand-art] ${rel} ${target.size.width}×${target.size.height} ${png.length} bytes`
    );
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
