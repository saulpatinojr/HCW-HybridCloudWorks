/**
 * The small drawing helpers generate-brand-art.mjs and its compositions share
 * (#1845 moved them out of that file): the seeded random numbers, number and
 * text formatting for SVG, and the two shapes more than one composition uses.
 * Nothing here reads a file; every value follows from its arguments, which is
 * what keeps the generated PNGs byte-identical from one run to the next.
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

// ---------------------------------------------------------------------------
// SVG text
// ---------------------------------------------------------------------------

/** Two decimals keeps the SVG small and its text stable across engines. */
export const n = (value) => Number(value.toFixed(2));

export const esc = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// Shared shapes. ctx: { w, h, p (palette), rng }
// ---------------------------------------------------------------------------

/** One item of `list`, chosen with the composition's own random numbers. */
export function pick(ctx, list) {
  return list[Math.floor(ctx.rng() * list.length)];
}

/** A soft radial light of one palette tone at (cx, cy), fading out at radius r. */
export function glow(ctx, { cx, cy, r, tone = 0, opacity = 0.5 }) {
  const id = `glow-${n(cx)}-${n(cy)}`.replace(/\./g, '_');
  return (
    `<radialGradient id="${id}"><stop offset="0" stop-color="${ctx.p.tones[tone]}" stop-opacity="${n(opacity)}"/>` +
    `<stop offset="1" stop-color="${ctx.p.tones[tone]}" stop-opacity="0"/></radialGradient>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="url(#${id})"/>`
  );
}

/** The path of a ring segment around (cx, cy), between radii rIn and rOut and angles a0 and a1. */
export function annulusSector({ cx, cy, rIn, rOut, a0, a1 }) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const px = (r, a) => `${n(cx + r * Math.cos(a))},${n(cy + r * Math.sin(a))}`;
  return (
    `M${px(rOut, a0)} A${n(rOut)},${n(rOut)} 0 ${large} 1 ${px(rOut, a1)} ` +
    `L${px(rIn, a1)} A${n(rIn)},${n(rIn)} 0 ${large} 0 ${px(rIn, a0)} Z`
  );
}
