/**
 * The five hero compositions behind generate-brand-art.mjs, and the seeded
 * randomness that makes each one the same on every run. Split out of
 * generate-brand-art.mjs, which explains the whole job in its header and
 * re-exports `HERO_COMPOSITIONS`.
 */

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** FNV-1a over the label so a seed follows from the name alone. */
export function hashSeed(text) {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, well-distributed, and identical on every JS engine. */
export function mulberry32(seed) {
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
export const n = (value) => Number(value.toFixed(2));

export const esc = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// Compositions. Each returns SVG markup for the area inside the frame.
// ctx: { w, h, p (palette), rng }
// ---------------------------------------------------------------------------

function pick(ctx, list) {
  return list[Math.floor(ctx.rng() * list.length)];
}

/** A soft radial glow; `[cx, cy]` is its centre. */
function glow(ctx, [cx, cy], r, tone = 0, opacity = 0.5) {
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

/** Scattered nodes joined to their nearest neighbours, over a faint dot grid. */
function nodes(ctx) {
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
function waves(ctx) {
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

export const HERO_COMPOSITIONS = [bands, rings, isogrid, nodes, waves];
