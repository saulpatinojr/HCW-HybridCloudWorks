/**
 * confirmation-token.js — the signed link in a double opt-in email (ADR 0030).
 *
 * A subscriber is written to Resend only when they confirm, and ADR 0030 §4
 * keeps the list at Resend rather than mirrored in Cosmos. So the pending state
 * lives in the link itself: the address, where they signed up, and an expiry,
 * signed so nobody can mint a confirmation for an address they do not receive
 * mail at.
 *
 *   token = base64url(JSON { v, e, s, x }) + "." + base64url(HMAC-SHA256(key, payload))
 *
 * ## Why the key is derived from RESEND_API_KEY rather than a new secret
 *
 * A dedicated secret would be one more value for the owner to generate, one
 * more Key Vault reference and one more Terraform run before signup works. The
 * derivation costs none of that and gives up nothing:
 *
 *   - HKDF is one-way, so a leaked token or signature says nothing about the
 *     API key.
 *   - Whoever holds the Resend key can already add contacts to the list
 *     directly, so being able to forge a confirmation grants them nothing new.
 *   - Rotating the key invalidates links that are still pending, and a pending
 *     link lives for 48 hours. Someone mid-signup at the moment of a rotation
 *     signs up again, which is the right outcome for a key that was rotated
 *     because it may have leaked.
 *
 * ## Why the link carries the token in the fragment
 *
 * The email links to `/newsletter/confirm#t=<token>`. A fragment is never sent
 * to a server, so the address inside the token does not land in Cloudflare or
 * Static Web Apps request logs; the page reads it and POSTs it. The POST is also
 * what keeps a mail scanner that pre-fetches links from confirming on the
 * subscriber's behalf: fetching the page confirms nothing.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const CONFIRMATION_TTL_MS = 48 * 60 * 60 * 1000;

const TOKEN_VERSION = 1;

/** HKDF salt and info: fixed labels, so this key is useless for anything else. */
const KEY_SALT = 'hcw-newsletter';
const KEY_INFO = 'double-opt-in-confirmation-v1';

/** @param {string} apiKey */
export function deriveConfirmationKey(apiKey) {
  if (!apiKey) throw new Error('a Resend API key is required to sign confirmations');
  return Buffer.from(hkdfSync('sha256', apiKey, KEY_SALT, KEY_INFO, 32));
}

const encode = (value) => Buffer.from(value).toString('base64url');
const sign = (key, payload) => createHmac('sha256', key).update(payload).digest('base64url');

/**
 * @param {Buffer} key from deriveConfirmationKey
 * @param {{ email: string, source: string }} subscriber
 * @param {{ now?: () => number, ttlMs?: number }} [options]
 */
export function buildConfirmationToken(
  key,
  { email, source },
  { now = Date.now, ttlMs = CONFIRMATION_TTL_MS } = {}
) {
  const payload = encode(JSON.stringify({ v: TOKEN_VERSION, e: email, s: source, x: now() + ttlMs }));
  return `${payload}.${sign(key, payload)}`;
}

/**
 * The subscriber a token names, or null for anything that is not an unexpired
 * token this key signed. One answer for every kind of failure, so a caller
 * cannot learn which part of a forged token was wrong.
 *
 * @returns {{ email: string, source: string } | null}
 */
export function verifyConfirmationToken(key, token, nowMs) {
  const payload = signedPayload(key, token);
  if (payload === null) return null;
  const claims = readClaims(payload);
  if (!claimsValid(claims, nowMs)) return null;
  return { email: claims.e, source: typeof claims.s === 'string' ? claims.s : 'website' };
}

/** The payload of a token this key signed, or null. */
function signedPayload(key, token) {
  if (!key || typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(key, payload));
  // Length is not secret: every signature is 43 base64url characters.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return payload;
}

/** The payload's claims, or null when it is not JSON. */
function readClaims(payload) {
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Whether the claims are this version's, unexpired, and name an email. */
function claimsValid(claims, nowMs) {
  if (claims?.v !== TOKEN_VERSION) return false;
  if (!Number.isFinite(claims.x) || claims.x <= nowMs) return false;
  return typeof claims.e === 'string' && Boolean(claims.e);
}
