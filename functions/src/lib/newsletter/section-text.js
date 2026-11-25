/**
 * section-text.js — the text rules every newsletter section shares: the
 * site's address, plain text with a length cap, and absolute https links.
 * sections.js says what a section is, and exports all of this again.
 */

export const SITE_ORIGIN = 'https://hybridcloudworks.com';

const MAX_SUMMARY_LENGTH = 280;

/** Trim, collapse whitespace, cap. Never returns markup — callers escape. */
export function plainText(value, max = MAX_SUMMARY_LENGTH) {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** An absolute https URL, or a site path made absolute; anything else is null. */
export function absoluteUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return `${SITE_ORIGIN}${raw}`;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

