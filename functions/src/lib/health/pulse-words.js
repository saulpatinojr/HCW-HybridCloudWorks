/**
 * pulse-words.js — the words and clock arithmetic every health pulse check
 * shares (pulse-checks.js and the files beside it): a result in the shared
 * vocabulary (status-model.js), a counted noun, a time as epoch ms, and how
 * long ago it was, as the Health page says it.
 */

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export const result = (status, summary, extra = {}) => ({ status, summary, ...extra });
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Epoch ms of an ISO string, a Date or a Firestore-shaped time; NaN otherwise. */
export function toMillis(value) {
  if (!value) return Number.NaN;
  return millisReader(value)();
}

/** How to read epoch ms off a value that is there: by its own method when it has one, else as an ISO string. */
function millisReader(value) {
  if (value instanceof Date) return () => value.getTime();
  if (typeof value.toMillis === 'function') return () => value.toMillis();
  if (typeof value.toDate === 'function') return () => value.toDate().getTime();
  if (typeof value === 'object' && typeof value.seconds === 'number') return () => value.seconds * 1000;
  return () => Date.parse(String(value));
}

/** "just now", "12 min ago", "3 h ago", "2 d ago" (frontend/src/lib/status.js describeAge). */
export function ago(value, now) {
  const then = toMillis(value);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.round(Math.max(0, now - then) / MINUTE_MS);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
