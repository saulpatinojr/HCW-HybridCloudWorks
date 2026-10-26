export const PALETTES = {
  cloud: {
    label: 'Cloud',
    background: '#f1f5fb',
    glow: '#ffffff',
    text: '#26364d',
    muted: '#52657b',
    edge: '#52657b',
    border: '#cbd5e1',
    nodes: {
      note: '#0369a1',
      conflict: '#b45309',
      topic: '#7c3aed',
      project: '#047857',
      reference: '#64748b',
    },
  },
  paper: {
    label: 'Paper',
    background: '#ffffff',
    glow: '#f8fafc',
    text: '#253247',
    muted: '#52657b',
    edge: '#52657b',
    border: '#d5dce5',
    nodes: {
      note: '#1d4ed8',
      conflict: '#b45309',
      topic: '#7e22ce',
      project: '#047857',
      reference: '#64748b',
    },
  },
  warm: {
    label: 'Warm',
    background: '#faf5eb',
    glow: '#fffdf7',
    text: '#493c32',
    muted: '#756252',
    edge: '#756252',
    border: '#ddd0b9',
    nodes: {
      note: '#0369a1',
      conflict: '#a64714',
      topic: '#9333a3',
      project: '#3f6d36',
      reference: '#776659',
    },
  },
  night: {
    label: 'Night',
    background: '#172338',
    glow: '#263952',
    text: '#e2e8f0',
    muted: '#b0bfd1',
    edge: '#94a3b8',
    border: '#46566e',
    nodes: {
      note: '#38bdf8',
      conflict: '#fb923c',
      topic: '#c084fc',
      project: '#34d399',
      reference: '#a6b5ca',
    },
  },
};
export const DEFAULT_APPEARANCE = { palette: 'cloud', fontSize: 11, colors: {} };
const KEY = 'hcw.brain.map.appearance.v1';
export function normalizeAppearance(value) {
  const palette = Object.hasOwn(PALETTES, value?.palette) ? value.palette : 'cloud';
  const fontSize = Number.isFinite(value?.fontSize)
    ? Math.max(9, Math.min(14, value.fontSize))
    : 11;
  const colors = Object.fromEntries(
    Object.entries(value?.colors || {}).filter(
      ([key, color]) => Object.hasOwn(PALETTES.cloud.nodes, key) && /^#[\da-f]{6}$/i.test(color)
    )
  );
  return { palette, fontSize, colors };
}
export function loadAppearance() {
  try {
    return normalizeAppearance(JSON.parse(localStorage.getItem(KEY)));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}
export function saveAppearance(value) {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizeAppearance(value)));
  } catch {
    /* Styles still work when browser storage is unavailable. */
  }
}
export function nodeHeading(item) {
  const explicit =
    typeof item.properties?.heading === 'string' ? item.properties.heading.trim() : '';
  return (explicit || item.title || 'Untitled note').split(/\s+/).slice(0, 4).join(' ');
}
