/**
 * cert-values.js — the value checks a certification write is cleaned with:
 * calendar days, http(s) links, badge references and link lists. Pure, and
 * split out of certification-rules.js so that file holds the rules only;
 * certification-rules.js re-exports toCalendarDate for its callers.
 */

/**
 * A calendar date as plain `YYYY-MM-DD`, from a day, a timestamp (its
 * leading day) or a Date; null for nothing usable. Dates used to be stored
 * as UTC midnight and shown a day early west of Greenwich (ADR 0033 §1).
 */
export function toCalendarDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = value instanceof Date ? value.toISOString() : String(value).trim();
  const head = text.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return null;
  const [y, m, d] = head.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === head ? head : null;
}

export const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim());
/** An uploaded badge is stored site-relative (`/api/public/media/…`, blob-paths.js). */
export const isImageRef = (value) =>
  isHttpUrl(value) || (typeof value === 'string' && /^\/[^\s]+$/.test(value.trim()));

/** One evidence or related-learning entry as `{ label, url }`, or null for an unusable one. */
function cleanLink(item) {
  if (typeof item === 'string') {
    return isHttpUrl(item) ? { label: item.trim(), url: item.trim() } : null;
  }
  if (!item || typeof item !== 'object' || !isHttpUrl(item.url)) return null;
  const url = String(item.url).trim();
  return {
    label:
      String(item.label || '')
        .trim()
        .slice(0, 200) || url,
    url,
  };
}

export function cleanLinkList(value, max = 50) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanLink).filter(Boolean).slice(0, max);
}
