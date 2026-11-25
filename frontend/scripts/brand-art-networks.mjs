/**
 * Two of the five hero compositions: linked nodes and flowing waves. Split
 * out of brand-art-compositions.mjs, which lists all five in
 * `HERO_COMPOSITIONS`.
 */
import { glow, n, pick } from './brand-art-seed.mjs';

/** Scattered nodes joined to their nearest neighbours, over a faint dot grid. */
export function nodes(ctx) {
  const { w, h, rng, p } = ctx;
  let out =
    `<pattern id="dots" width="36" height="36" patternUnits="userSpaceOnUse">` +
    `<circle cx="18" cy="18" r="1.2" fill="${p.tones[2]}" opacity="0.18"/></pattern>` +
    `<rect width="${w}" height="${h}" fill="url(#dots)"/>` +
    `<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>`;
  out += glow(ctx, [w * 0.3, h * 0.7], h * 0.7, 0, 0.35);
  const points = Array.from({ length: 44 }, () => ({
    x: w * (0.04 + rng() * 0.92),
    y: h * (0.06 + rng() * 0.88),
    r: 2 + rng() * 5,
    tone: pick(ctx, p.tones),
  }));
  out += nearestLinks(points, p.tones[1]);
  for (const pt of points) out += nodeDot(pt);
  return out;
}

/** A line from each point to its two nearest neighbours, each pair drawn once. */
function nearestLinks(points, stroke) {
  const seen = new Set();
  let out = '';
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
      out += `<line x1="${n(points[a].x)}" y1="${n(points[a].y)}" x2="${n(points[idx].x)}" y2="${n(points[idx].y)}" stroke="${stroke}" stroke-width="1.2" opacity="0.38"/>`;
    }
  }
  return out;
}

/** One node: a dot, with a blurred halo behind the larger ones. */
function nodeDot(pt) {
  const halo =
    pt.r > 5
      ? `<circle cx="${n(pt.x)}" cy="${n(pt.y)}" r="${n(pt.r * 3)}" fill="${pt.tone}" opacity="0.5" filter="url(#soft)"/>`
      : '';
  return `${halo}<circle cx="${n(pt.x)}" cy="${n(pt.y)}" r="${n(pt.r)}" fill="${pt.tone}" opacity="0.9"/>`;
}

/** Layered sine curves with a filled sea under the lowest. */
export function waves(ctx) {
  const { w, h, rng, p } = ctx;
  let out = glow(ctx, [w * 0.5, h * 0.55], w * 0.55, 1, 0.3);
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
