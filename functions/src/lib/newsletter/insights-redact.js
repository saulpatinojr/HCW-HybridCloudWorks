/**
 * insights-redact.js — taking addresses, keys and tokens out of what Resend
 * sends back, before the Mailing List page or a log line sees it
 * (insights-handlers.js exports all of this again).
 */

// ── Redaction ───────────────────────────────────────────────────────────────

/** An address, with its at-sign literal or percent-encoded (`%40`), as a path built with encodeURIComponent carries it. */
export const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gi;
export const BEARER_IN_TEXT = /\bBearer\s+[^\s"',;]+/gi;
/** Resend keys start `re_`; anything that looks like one goes. */
export const RESEND_KEY_IN_TEXT = /\bre_[A-Za-z0-9_-]{8,}/g;
export const SENSITIVE_KEY = /authorization|api[-_]?key|secret|token|password|cookie|^key$/i;
export const REDACTED = '[redacted]';
export const REDACTED_EMAIL = '[redacted email]';
export const MAX_REDACT_DEPTH = 20;

/** A string with bearer tokens, Resend keys and email addresses removed. */
export function redactText(text) {
  return String(text)
    .replace(BEARER_IN_TEXT, `Bearer ${REDACTED}`)
    .replace(RESEND_KEY_IN_TEXT, REDACTED)
    .replace(EMAIL_IN_TEXT, REDACTED_EMAIL);
}

/**
 * A deep copy of a log body with credentials and addresses removed: any value
 * under a key that names a credential is replaced whole, and every string (and
 * every key) has bearer tokens, Resend keys and email addresses taken out.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced with the REDACTED
 * marker rather than walked.
 */
export function redactSensitive(value, depth = 0) {
  if (depth > MAX_REDACT_DEPTH) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      const safeKey = redactText(key);
      out[safeKey] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/** `jane@example.com` → `j***@example.com`. Anything unrecognisable is fully masked. */
export function maskEmail(value) {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return '***';
  return `${value[0]}***@${value.slice(at + 1)}`;
}

