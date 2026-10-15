/**
 * sender.js — the address newsletters come from (ADR 0033 Amplify slice).
 *
 * `NEWSLETTER_FROM` was a code constant; it is now the DEFAULT, and the owner
 * can set another sender in Newsletter Hub → Settings. The chosen address is
 * stored in `admin_config/newsletter_sender` and read by every send: the
 * confirmation email, the test send and the broadcast. Nothing stored, or a
 * stored value that no longer validates, means the default — so a bad save
 * can never stop the newsletter.
 *
 * A sender must be on a domain Resend will send from. The default's domain is
 * always accepted; another domain is accepted only when Resend lists it as
 * verified, checked at save time by the handler, because a sender on an
 * unverified domain is refused by Resend at send time with a 403 that reads
 * like a key problem.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { normalizeEmail } from './email.js';

/** Where newsletters come from unless the owner sets otherwise — the domain verified in Resend on 2026-09-13. */
export const DEFAULT_NEWSLETTER_FROM = 'HybridCloudWorks <newsletter@news.hybridcloudworks.com>';

export const NEWSLETTER_SENDER_CONFIG_ID = 'newsletter_sender';
export const MAX_SENDER_NAME_LENGTH = 80;

/**
 * `Name <local@domain>` or `local@domain` as `{ name, email, domain, from }`,
 * or null when it is neither. `from` is the RFC 5322 form Resend takes.
 */
export function parseFromAddress(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = raw.match(/^(?:"?([^"<>]{0,120}?)"?\s*)?<([^<>\s]+)>$/);
  const name = match ? (match[1]?.trim() ?? '') : '';
  // Lower-cased whole: these are the site's own addresses, and Resend's
  // domain list compares case-insensitively.
  const email = normalizeEmail(match ? match[2] : raw)?.toLowerCase() ?? null;
  if (!email) return null;
  if (name.length > MAX_SENDER_NAME_LENGTH) return null;
  const domain = email.slice(email.indexOf('@') + 1);
  return { name, email, domain, from: name ? `${name} <${email}>` : email };
}

/** The default sender's domain: always allowed. */
export const DEFAULT_SENDING_DOMAIN = parseFromAddress(DEFAULT_NEWSLETTER_FROM).domain;

/**
 * The stored sender document as the page sees it. `from` is what sends:
 * the stored address when it parses, the default otherwise.
 */
export function presentSender(doc) {
  const stored = parseFromAddress(doc?.from);
  return {
    from: stored?.from ?? DEFAULT_NEWSLETTER_FROM,
    isDefault: !stored,
    defaultFrom: DEFAULT_NEWSLETTER_FROM,
    sendingDomain: stored?.domain ?? DEFAULT_SENDING_DOMAIN,
    updatedAt: doc?.updatedAt ?? null,
    updatedBy: doc?.updatedBy ?? null,
  };
}

/**
 * The address a send should use. Never throws: a store that cannot be read
 * costs the owner's choice for this send, not the send.
 */
export async function resolveFromAddress(store, log) {
  try {
    const doc = await store.readDoc(
      'admin_config',
      NEWSLETTER_SENDER_CONFIG_ID,
      ADMIN_CONFIG_PARTITION
    );
    return presentSender(doc).from;
  } catch (error) {
    log?.warn?.(`[newsletter] sender not read, default used: ${error?.name ?? 'Error'}`);
    return DEFAULT_NEWSLETTER_FROM;
  }
}

/**
 * Whether `domain` may send: the default domain, or a domain Resend lists
 * as verified. `listDomains` is the Resend client's; a refused listing is
 * reported as a reason rather than thrown.
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function checkSendingDomain(domain, client) {
  if (domain === DEFAULT_SENDING_DOMAIN) return { ok: true };
  if (!client) {
    return {
      ok: false,
      reason: `Only ${DEFAULT_SENDING_DOMAIN} can be checked without a Resend key.`,
    };
  }
  const listed = await client.listDomains();
  return listed.ok ? domainVerdict(domain, listed.data?.data) : listingRefusal(listed);
}

/** The reason a Resend domain listing could not be read. */
function listingRefusal(listed) {
  // The status and Resend's error name; its own sentence stays out (#945).
  const name = typeof listed.data?.name === 'string' ? ` ${listed.data.name}` : '';
  return {
    ok: false,
    reason: `Resend could not list sending domains (HTTP ${listed.status}${name})`,
  };
}

/** Whether `domain` is among `rows` and verified. */
function domainVerdict(domain, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const match = list.find((row) => String(row?.name ?? '').toLowerCase() === domain.toLowerCase());
  if (!match) {
    return {
      ok: false,
      reason: `${domain} is not a sending domain in Resend. Add and verify it there first.`,
    };
  }
  const verified = String(match.status ?? '').toLowerCase() === 'verified';
  return verified
    ? { ok: true }
    : {
        ok: false,
        reason: `${domain} is in Resend but its status is "${match.status}", not verified.`,
      };
}
