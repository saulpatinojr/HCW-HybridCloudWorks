/**
 * The five hero compositions behind generate-brand-art.mjs: bands, rings and
 * the isometric grid here, linked nodes and waves in brand-art-networks.mjs.
 * Split out of generate-brand-art.mjs, which explains the whole job in its
 * header and re-exports `HERO_COMPOSITIONS`.
 */
import { nodes, waves } from './brand-art-networks.mjs';
import { glow, n, pick } from './brand-art-seed.mjs';

// ---------------------------------------------------------------------------
// Compositions. Each returns SVG markup for the area inside the frame.
// ctx: { w, h, p (palette), rng }
// ---------------------------------------------------------------------------

/** Diagonal bands sweeping in from the right, cut by a clean diagonal edge. */
function bands(ctx) {
  const { w, h, rng, p } = ctx;
  const angle = -(18 + rng() * 16);
  const edgeTop = w * (0.3 + rng() * 0.15);
  const edgeBottom = edgeTop - w * (0.15 + rng() * 0.1);
  let out = glow(ctx, [w * 0.82, h * 0.22], h * 0.75, 1, 0.45);
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

/** An SVG path for a ring segment; `[cx, cy]` is the ring's centre. */
function annulusSector([cx, cy], rIn, rOut, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const px = (r, a) => `${n(cx + r * Math.cos(a))},${n(cy + r * Math.sin(a))}`;
  return (
    `M${px(rOut, a0)} A${n(rOut)},${n(rOut)} 0 ${large} 1 ${px(rOut, a1)} ` +
    `L${px(rIn, a1)} A${n(rIn)},${n(rIn)} 0 ${large} 0 ${px(rIn, a0)} Z`
  );
}

/** Concentric rings from a corner, some carrying filled arc segments. */
export function rings(ctx, origin) {
  const { w, h, rng, p } = ctx;
  const cx = origin ? origin.x : w * (0.7 + rng() * 0.2);
  const cy = origin ? origin.y : h * (0.12 + rng() * 0.2);
  let out = glow(ctx, [cx, cy], h * 0.6, 0, 0.55);
  const step = h * 0.07;
  for (let i = 1; i <= 15; i += 1) {
    const r = i * step + rng() * 12;
    const tone = p.tones[i % p.tones.length];
    const opacity = 0.08 + rng() * 0.28;
    out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke="${tone}" stroke-width="${n(1 + rng() * 6)}" opacity="${n(opacity)}"/>`;
    if (rng() < 0.4) {
      const a0 = rng() * Math.PI * 2;
      const a1 = a0 + 0.3 + rng() * 1.3;
      out += `<path d="${annulusSector([cx, cy], r, r + 14 + rng() * 44, a0, a1)}" fill="${tone}" opacity="${n(opacity + 0.18)}"/>`;
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
  let out = glow(ctx, [ox, oy + h * 0.15], h * 0.7, 1, 0.35);
  for (const { i, j, z, opacity } of scatterCubes(rng)) {
    const x = ox + (i - j) * s;
    const y = oy + (i + j) * rise;
    out += isoCube({ x, y, top: y - lift * z, s, rise }, p.tones, opacity);
  }
  return out;
}

/** Which grid cells hold a cube, how tall and how opaque, sorted back to front. */
function scatterCubes(rng) {
  const cubes = [];
  for (let i = -5; i <= 5; i += 1) {
    for (let j = -5; j <= 5; j += 1) {
      if (rng() < 0.55) continue;
      cubes.push({ i, j, z: rng() < 0.3 ? 2 : 1, opacity: 0.62 + rng() * 0.36 });
    }
  }
  return cubes.sort((a, b) => a.i + a.j - (b.i + b.j));
}

/** One cube's three faces: top, left and right. */
function isoCube({ x, y, top, s, rise }, tones, opacity) {
  const t = (px, py) => `${n(px)},${n(py)}`;
  return (
    `<g opacity="${n(opacity)}">` +
    `<polygon points="${t(x, top - rise)} ${t(x + s, top)} ${t(x, top + rise)} ${t(x - s, top)}" fill="${tones[2]}"/>` +
    `<polygon points="${t(x - s, top)} ${t(x, top + rise)} ${t(x, y + rise)} ${t(x - s, y)}" fill="${tones[0]}"/>` +
    `<polygon points="${t(x, top + rise)} ${t(x + s, top)} ${t(x + s, y)} ${t(x, y + rise)}" fill="${tones[1]}"/>` +
    '</g>'
  );
}

export const HERO_COMPOSITIONS = [bands, rings, isogrid, nodes, waves];
