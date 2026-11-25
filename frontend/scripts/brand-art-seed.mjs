/**
 * The small helpers every brand-art composition uses: the seeded randomness
 * that makes each image the same on every run, number and text formatting
 * for SVG, and two drawing helpers. Split out of generate-brand-art.mjs.
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

export function pick(ctx, list) {
  return list[Math.floor(ctx.rng() * list.length)];
}

/** A soft radial glow; `[cx, cy]` is its centre. */
export function glow(ctx, [cx, cy], r, tone = 0, opacity = 0.5) {
  const id = `glow-${n(cx)}-${n(cy)}`.replace(/\./g, '_');
  return (
    `<radialGradient id="${id}"><stop offset="0" stop-color="${ctx.p.tones[tone]}" stop-opacity="${n(opacity)}"/>` +
    `<stop offset="1" stop-color="${ctx.p.tones[tone]}" stop-opacity="0"/></radialGradient>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="url(#${id})"/>`
  );
}
