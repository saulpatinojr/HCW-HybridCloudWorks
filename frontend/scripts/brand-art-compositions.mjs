/**
 * The five hero compositions generate-brand-art.mjs draws, one per variant
 * (#371; moved out of that file by #1845). Each returns SVG markup for the
 * area inside the frame. ctx: { w, h, p (palette), rng }
 *
 * The order of the rng() calls is part of the output: each composition takes
 * its random numbers from one seeded sequence, so drawing the same shapes in
 * a different order draws different art. Keep the calls where they are.
 */
import { annulusSector, glow, n, pick } from './brand-art-svg.mjs';

/** Diagonal bands sweeping in from the right, cut by a clean diagonal edge. */
function bands(ctx) {
  const { w, h, rng, p } = ctx;
  const angle = -(18 + rng() * 16);
  const edgeTop = w * (0.3 + rng() * 0.15);
  const edgeBottom = edgeTop - w * (0.15 + rng() * 0.1);
  let out = glow(ctx, { cx: w * 0.82, cy: h * 0.22, r: h * 0.75, tone: 1, opacity: 0.45 });
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

/** Concentric rings from a corner, some carrying filled arc segments. */
export function rings(ctx, origin) {
  const { w, h, rng, p } = ctx;
  const { x: cx, y: cy } = origin ?? { x: w * (0.7 + rng() * 0.2), y: h * (0.12 + rng() * 0.2) };
  let out = glow(ctx, { cx, cy, r: h * 0.6, tone: 0, opacity: 0.55 });
  const step = h * 0.07;
  for (let i = 1; i <= 15; i += 1) {
    const r = i * step + rng() * 12;
    const tone = p.tones[i % p.tones.length];
    const opacity = 0.08 + rng() * 0.28;
    out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke="${tone}" stroke-width="${n(1 + rng() * 6)}" opacity="${n(opacity)}"/>`;
    if (rng() < 0.4) {
      const a0 = rng() * Math.PI * 2;
      const a1 = a0 + 0.3 + rng() * 1.3;
      const sector = annulusSector({ cx, cy, rIn: r, rOut: r + 14 + rng() * 44, a0, a1 });
      out += `<path d="${sector}" fill="${tone}" opacity="${n(opacity + 0.18)}"/>`;
    }
  }
  return out;
}

/** Which cells of an 11×11 grid hold a cube, how tall and how opaque, back to front. */
function cubeField(rng) {
  const cubes = [];
  for (let i = -5; i <= 5; i += 1) {
    for (let j = -5; j <= 5; j += 1) {
      if (rng() < 0.55) continue;
      cubes.push({ i, j, z: rng() < 0.3 ? 2 : 1, opacity: 0.62 + rng() * 0.36 });
    }
  }
  return cubes.sort((a, b) => a.i + a.j - (b.i + b.j));
}

/** One isometric cube's three faces; `grid` is the field's origin, cell size, rise and lift. */
function cubeSvg({ i, j, z, opacity }, grid, tones) {
  const { ox, oy, s, rise, lift } = grid;
  const x = ox + (i - j) * s;
  const y = oy + (i + j) * rise;
  const top = y - lift * z;
  const t = (px, py) => `${n(px)},${n(py)}`;
  return (
    `<g opacity="${n(opacity)}">` +
    `<polygon points="${t(x, top - rise)} ${t(x + s, top)} ${t(x, top + rise)} ${t(x - s, top)}" fill="${tones[2]}"/>` +
    `<polygon points="${t(x - s, top)} ${t(x, top + rise)} ${t(x, y + rise)} ${t(x - s, y)}" fill="${tones[0]}"/>` +
    `<polygon points="${t(x, top + rise)} ${t(x + s, top)} ${t(x + s, y)} ${t(x, y + rise)}" fill="${tones[1]}"/>` +
    '</g>'
  );
}

/** A field of isometric cubes, back to front. */
function isogrid(ctx) {
  const { w, h, rng, p } = ctx;
  const s = 44 + rng() * 18;
  const grid = {
    s,
    rise: s * 0.5774,
    lift: s * (0.7 + rng() * 0.5),
    ox: w * (0.55 + rng() * 0.15),
    oy: h * (0.35 + rng() * 0.15),
  };
  const out = glow(ctx, {
    cx: grid.ox,
    cy: grid.oy + h * 0.15,
    r: h * 0.7,
    tone: 1,
    opacity: 0.35,
  });
  return (
    out +
    cubeField(rng)
      .map((cube) => cubeSvg(cube, grid, p.tones))
      .join('')
  );
}

/** The two nearest other points to points[a], nearest first. */
function nearestTwo(points, a) {
  return points
    .map((b, idx) => ({ idx, d: Math.hypot(points[a].x - b.x, points[a].y - b.y) }))
    .filter((c) => c.idx !== a)
    .sort((c, d) => c.d - d.d)
    .slice(0, 2);
}

/** A line from each point to its two nearest neighbours, each pair drawn once. */
function nodeLinks(points, stroke) {
  let out = '';
  const seen = new Set();
  for (let a = 0; a < points.length; a += 1) {
    for (const { idx } of nearestTwo(points, a)) {
      const key = `${Math.min(a, idx)}-${Math.max(a, idx)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out += `<line x1="${n(points[a].x)}" y1="${n(points[a].y)}" x2="${n(points[idx].x)}" y2="${n(points[idx].y)}" stroke="${stroke}" stroke-width="1.2" opacity="0.38"/>`;
    }
  }
  return out;
}

/** Each point as a dot, the larger ones with a blurred halo behind. */
function nodeDot(pt) {
  const halo =
    pt.r > 5
      ? `<circle cx="${n(pt.x)}" cy="${n(pt.y)}" r="${n(pt.r * 3)}" fill="${pt.tone}" opacity="0.5" filter="url(#soft)"/>`
      : '';
  return `${halo}<circle cx="${n(pt.x)}" cy="${n(pt.y)}" r="${n(pt.r)}" fill="${pt.tone}" opacity="0.9"/>`;
}

/** Scattered nodes joined to their nearest neighbours, over a faint dot grid. */
function nodes(ctx) {
  const { w, h, rng, p } = ctx;
  let out =
    `<pattern id="dots" width="36" height="36" patternUnits="userSpaceOnUse">` +
    `<circle cx="18" cy="18" r="1.2" fill="${p.tones[2]}" opacity="0.18"/></pattern>` +
    `<rect width="${w}" height="${h}" fill="url(#dots)"/>` +
    `<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>`;
  out += glow(ctx, { cx: w * 0.3, cy: h * 0.7, r: h * 0.7, tone: 0, opacity: 0.35 });
  const points = Array.from({ length: 44 }, () => ({
    x: w * (0.04 + rng() * 0.92),
    y: h * (0.06 + rng() * 0.88),
    r: 2 + rng() * 5,
    tone: pick(ctx, p.tones),
  }));
  return out + nodeLinks(points, p.tones[1]) + points.map(nodeDot).join('');
}

/** Layered sine curves with a filled sea under the lowest. */
function waves(ctx) {
  const { w, h, rng, p } = ctx;
  let out = glow(ctx, { cx: w * 0.5, cy: h * 0.55, r: w * 0.55, tone: 1, opacity: 0.3 });
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
