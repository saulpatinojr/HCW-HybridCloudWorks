/**
 * handlers.js — newsletter signup with double opt-in, on Resend (ADR 0030).
 *
 *   POST /api/public/newsletter/subscribe  { email, source, website }
 *     → validates, rate-limits, and emails a confirmation link. Writes nothing
 *       to the list.
 *   POST /api/public/newsletter/confirm    { token }
 *     → verifies the signed link, adds the contact to the Newsletter segment,
 *       and READS IT BACK before saying yes.
 *
 * ## Subscribe says the same thing whether or not the address is on the list
 *
 * It never asks Resend who is subscribed. Answering "already subscribed" would
 * make the form an oracle for whether an address is on the list, and sending
 * the link again to someone already confirmed is harmless: confirming twice
 * leaves them exactly where they were.
 *
 * ## It is also a way to make this site email a stranger, so it is limited twice
 *
 * Per caller (the same Cloudflare-verified, hashed identity `public/submissions`
 * uses) and per address. The second limit is the one that matters for abuse:
 * without it, anyone rotating through addresses could use the site to send
 * confirmation emails at a victim.
 *
 * ## Confirm does not trust the write
 *
 * ADR 0030 names `resend/resend-node#458`: a contact created with
 * `unsubscribed: false` reported as coming back unsubscribed. If that happened
 * here, a subscriber would be told they are in and then skipped by every
 * broadcast — silent loss, the failure #504 was wrongly thought to be. So after
 * writing, confirm reads the contact and its segments and answers success only
 * when both say subscribed. Creating a contact that already exists is not
 * documented either, and the same read-back covers that: whatever create did,
 * the state is repaired and then checked.
 *
 * No email address is ever logged. Log lines say what happened, not to whom.
 */
import { createHash } from 'node:crypto';
import { readKey } from '../ai/router.js';
import { errorCode } from '../http/error-response.js';
import { enforceSubmissionQuota } from '../submissions.js';
import { createResendClient } from './resend-client.js';
import { normalizeEmail } from './email.js';
import { DEFAULT_NEWSLETTER_FROM, resolveFromAddress } from './sender.js';
import {
  buildConfirmationToken,
  deriveConfirmationKey,
  verifyConfirmationToken,
} from './confirmation-token.js';

export { normalizeEmail };

/**
 * Where newsletters come from unless the owner chose otherwise in Newsletter
 * Hub → Settings (sender.js, ADR 0033 Amplify slice). Kept under this name
 * because the broadcast tests pin it as the default.
 */
export const NEWSLETTER_FROM = DEFAULT_NEWSLETTER_FROM;

/** The segment every confirmed subscriber is added to. Created if missing. */
export const NEWSLETTER_SEGMENT_NAME = 'Newsletter';

/** The page the confirmation email links to. */
export const CONFIRM_PAGE_URL = 'https://hybridcloudworks.com/newsletter/confirm';

/** Signup attempts per caller per hour. A person needs one; a typo needs two. */
export const SUBSCRIBE_PER_CALLER_PER_HOUR = 5;
/** Confirmation emails per address per hour — the anti-harassment limit. */
export const SUBSCRIBE_PER_ADDRESS_PER_HOUR = 2;
/** Confirm attempts per caller per hour. Generous: a double click is two. */
export const CONFIRM_PER_CALLER_PER_HOUR = 10;

/** Where on the site a signup may say it came from. Anything else is `website`. */
export const SIGNUP_SOURCES = Object.freeze(['footer', 'blog-post', 'website']);

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** @param {unknown} value */
export function normalizeSource(value) {
  return SIGNUP_SOURCES.includes(value) ? value : 'website';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The confirmation email. Plain, because it has one job: the button. */
export function confirmationEmail({ email, link }) {
  const subject = 'Confirm your subscription to the HybridCloudWorks newsletter';
  const text = [
    'Thanks for signing up to the HybridCloudWorks newsletter.',
    '',
    'Confirm your subscription by opening this link within 48 hours:',
    link,
    '',
    `If you did not sign up with ${email}, ignore this email and you will not be added.`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">Confirm your subscription</h1>
<p>Thanks for signing up to the HybridCloudWorks newsletter. Confirm within 48 hours and you are in.</p>
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Confirm subscription</a></p>
<p style="font-size:13px;color:#555">If you did not sign up with ${escapeHtml(email)}, ignore this email and you will not be added.</p>
</body></html>`;
  return { subject, text, html };
}

/** sha256 of a lower-cased address, salted, so a quota document names no one. */
function addressKey(email, salt) {
  return createHash('sha256').update(`${salt}:newsletter:${email.toLowerCase()}`).digest('hex');
}

/**
 * The first step of a response Resend gave, as an operator-safe sentence: a
 * status and Resend's `name`, never the body, which can echo the address.
 */
function describe(result) {
  const name = typeof result?.data?.name === 'string' ? ` ${result.data.name}` : '';
  return `HTTP ${result?.status ?? 0}${name}`;
}

/**
 * Email one confirmation link. Shared by the public signup and the admin's
 * "add a subscriber" (insights-handlers.js), so both links are signed the
 * same way and carry the same 48-hour expiry.
 */
export async function sendConfirmationEmail({
  client,
  apiKey,
  email,
  source = 'website',
  now = Date.now,
  from = NEWSLETTER_FROM,
}) {
  const token = buildConfirmationToken(
    deriveConfirmationKey(apiKey),
    { email, source: normalizeSource(source) },
    { now }
  );
  const link = `${CONFIRM_PAGE_URL}#t=${token}`;
  const { subject, text, html } = confirmationEmail({ email, link });
  return client.sendEmail({ from, to: [email], subject, text, html });
}

/**
 * Put `email` in the Newsletter segment, subscribed, and READ IT BACK before
 * saying so (the header's "Confirm does not trust the write"). Shared by the
 * public confirm and the admin's consent-recorded add.
 *
 * @returns {Promise<{ ok: true } | { ok: false, why: string }>} `why` is operator-safe: statuses and names, never the address.
 */
export async function ensureConfirmedContact(deps) {
  for (const step of [ensureContactExists, ensureInSegment, ensureSubscribed]) {
    const outcome = await step(deps);
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}

const OK = Object.freeze({ ok: true });

/** Step 1: the contact exists, resubscribed if it had opted out. */
async function ensureContactExists({ client, email, segmentId }) {
  const created = await client.createContact({ email, segmentId });
  if (created.ok) return OK;
  // Resend does not document which status means "already exists", so the
  // status is not guessed at: the contact is looked up. Only a contact that
  // really exists is resubscribed — someone who unsubscribed and is now
  // choosing to come back, which is exactly the consent this records. A
  // 401, a 5xx or a transport failure finds no contact and is reported as
  // the create failure it was, not masked by a PATCH.
  const existing = await client.getContact(email);
  if (!existing.ok) {
    return {
      ok: false,
      why: `create ${describe(created)}; no existing contact (${describe(existing)})`,
    };
  }
  const resubscribed = await client.resubscribeContact(email);
  return resubscribed.ok
    ? OK
    : { ok: false, why: `create ${describe(created)}, then update ${describe(resubscribed)}` };
}

/** Step 2: the contact is in the Newsletter segment, read back after adding. */
async function ensureInSegment({ client, email, segmentId }) {
  const inSegment = async () => {
    const listed = await client.listContactSegments(email);
    return (
      listed.ok &&
      Array.isArray(listed.data?.data) &&
      listed.data.data.some((row) => row?.id === segmentId)
    );
  };
  if (await inSegment()) return OK;
  const added = await client.addContactToSegment(email, segmentId);
  const present = added.ok && (await inSegment());
  return present
    ? OK
    : {
        ok: false,
        why: `the contact is not in the ${NEWSLETTER_SEGMENT_NAME} segment after adding it (${describe(added)})`,
      };
}

/** Step 3: the contact reads back as subscribed, repaired once if not. */
async function ensureSubscribed({ client, email }) {
  const stored = await client.getContact(email);
  if (!stored.ok) return { ok: false, why: `reading the contact back ${describe(stored)}` };
  if (stored.data?.unsubscribed === false) return OK;
  // resend/resend-node#458's shape. Repair once, then check again.
  const repaired = await client.resubscribeContact(email);
  const reread = repaired.ok ? await client.getContact(email) : repaired;
  return reread.ok && reread.data?.unsubscribed === false
    ? OK
    : { ok: false, why: 'the contact reads back as unsubscribed after confirming' };
}

/**
 * The Newsletter segment id: found by name, created if missing. Used by
 * confirm to add a contact, and exported for the send step to reuse.
 */
export async function findSegmentId(client) {
  let after;
  for (let page = 0; page < 20; page += 1) {
    const listed = await client.listSegments(after);
    if (!listed.ok) throw new Error(`listing segments failed: ${describe(listed)}`);
    const rows = Array.isArray(listed.data?.data) ? listed.data.data : [];
    const found = rows.find((row) => row?.name === NEWSLETTER_SEGMENT_NAME);
    if (found?.id) return found.id;
    if (!listed.data?.has_more || rows.length === 0) break;
    after = rows[rows.length - 1].id;
  }
  return null;
}

export async function resolveSegmentId(client) {
  const existing = await findSegmentId(client);
  if (existing) return existing;
  const created = await client.createSegment(NEWSLETTER_SEGMENT_NAME);
  if (created.ok && created.data?.id) return created.data.id;
  // Two cold instances confirming at once can both find no segment and both
  // create; the loser's failure is not a failure if the winner's segment now
  // exists. Look once more before giving the subscriber a 502.
  const raced = await findSegmentId(client);
  if (raced) return raced;
  throw new Error(`creating the ${NEWSLETTER_SEGMENT_NAME} segment failed: ${describe(created)}`);
}

// ── The two routes, hoisted out of the factory (PR #841 quality round) ──────
//
// Each takes the factory's `ctx` first: `{ identity, store, env, fetchImpl,
// now, segmentId }`. What is refused, in what order and with which answer,
// is what it was inside the factory; the steps are only named.

const unavailable = () =>
  json(503, { ok: false, error: 'Newsletter signup is temporarily unavailable.' });

const invalidAddress = () => json(400, { ok: false, error: 'Please enter a valid email address.' });

const tooMany = () =>
  json(
    429,
    { ok: false, error: 'Too many attempts. Please try again later.' },
    { 'Retry-After': '3600' }
  );

/** The Resend key and a client on it, or null without the key. */
function configuredResend(env, fetchImpl) {
  const apiKey = readKey(env, 'RESEND_API_KEY');
  return apiKey ? { apiKey, client: createResendClient({ apiKey, fetch: fetchImpl }) } : null;
}

/** Who is calling, or a ready 403 when the origin is not verifiably Cloudflare. */
function callerKey({ identity }, request, context) {
  try {
    return { key: identity.anonymousKey(request).key };
  } catch {
    context.warn?.('newsletter request rejected: unverified origin');
    return { refused: json(403, { ok: false, error: 'Forbidden' }) };
  }
}

async function withinQuota({ store, now }, key, limit) {
  try {
    await enforceSubmissionQuota(store, key, { now: now(), limit });
    return true;
  } catch (error) {
    if (error?.code === 'SUBMISSION_RATE_LIMIT') return false;
    throw error;
  }
}

/**
 * The signup body read: `{ email, source }`, or `{ response }` for a body
 * that is not one, an address that cannot be one, or a filled honeypot —
 * answered exactly like a real signup, so a bot learns nothing, and nothing
 * is sent or counted.
 */
function readSignup(body, context) {
  if (!body || typeof body !== 'object') return { response: invalidAddress() };
  if (typeof body.website === 'string' && body.website.trim()) {
    context.log?.('newsletter signup ignored: honeypot filled');
    return { response: json(202, { ok: true }) };
  }
  const email = normalizeEmail(body.email);
  if (!email) return { response: invalidAddress() };
  return { email, source: normalizeSource(body.source) };
}

/**
 * What a signup needs from the environment: Resend, and the salt. FAIL
 * CLOSED without the salt: the per-address quota document's id is a hash of
 * the address and is persisted in Cosmos; unsalted, it is a
 * dictionary-reversible list of everyone who tried to subscribe.
 * `{ apiKey, client, salt }` or `{ response }`.
 */
function signupSetup({ env, fetchImpl }, context) {
  const setup = configuredResend(env, fetchImpl);
  if (!setup) {
    context.error?.('newsletter signup refused: RESEND_API_KEY is not set');
    return { response: unavailable() };
  }
  const salt = readKey(env, 'CLIENT_IP_SALT');
  if (!salt) {
    context.error?.('newsletter signup refused: CLIENT_IP_SALT is not set');
    return { response: unavailable() };
  }
  return { ...setup, salt };
}

/** The header's two limits, caller then address: the 429, or null when both allow. */
async function signupLimited(ctx, caller, email, salt) {
  if (!(await withinQuota(ctx, `newsletter-caller:${caller}`, SUBSCRIBE_PER_CALLER_PER_HOUR))) {
    return tooMany();
  }
  const address = `newsletter-address:${addressKey(email, salt)}`;
  if (!(await withinQuota(ctx, address, SUBSCRIBE_PER_ADDRESS_PER_HOUR))) return tooMany();
  return null;
}

/** The confirmation link emailed, and the answer. */
async function sendSignupConfirmation({ store, now }, { setup, email, source }, context) {
  const sent = await sendConfirmationEmail({
    client: setup.client,
    apiKey: setup.apiKey,
    email,
    source,
    now,
    from: await resolveFromAddress(store, context),
  });
  if (!sent.ok) {
    context.error?.(`newsletter confirmation email failed: ${describe(sent)}`);
    return json(502, {
      ok: false,
      error: 'We could not send the confirmation email. Please try again.',
    });
  }
  context.log?.(`newsletter confirmation sent: source=${source}`);
  return json(202, { ok: true });
}

async function subscribe(ctx, request, context) {
  const caller = callerKey(ctx, request, context);
  if (caller.refused) return caller.refused;
  const body = await request.json().catch(() => null);
  const signup = readSignup(body, context);
  if (signup.response) return signup.response;
  const setup = signupSetup(ctx, context);
  if (setup.response) return setup.response;
  const limited = await signupLimited(ctx, caller.key, signup.email, setup.salt);
  if (limited) return limited;
  return sendSignupConfirmation(ctx, { setup, ...signup }, context);
}

/**
 * What a confirm needs before the token is even read: the salt — fail
 * closed without it, BEFORE the quota write, because the caller key is an
 * address hash persisted as a document id, and unsalted it is reversible —
 * then the caller's quota, then Resend. `{ setup }` or `{ response }`.
 */
async function admitConfirm(ctx, caller, context) {
  if (!readKey(ctx.env, 'CLIENT_IP_SALT')) {
    context.error?.('newsletter confirm refused: CLIENT_IP_SALT is not set');
    return { response: unavailable() };
  }
  if (!(await withinQuota(ctx, `newsletter-confirm:${caller}`, CONFIRM_PER_CALLER_PER_HOUR))) {
    return { response: tooMany() };
  }
  const setup = configuredResend(ctx.env, ctx.fetchImpl);
  if (!setup) {
    context.error?.('newsletter confirm refused: RESEND_API_KEY is not set');
    return { response: unavailable() };
  }
  return { setup };
}

/** The subscriber put in the segment and read back (ensureConfirmedContact), and the answer. */
async function confirmSubscriber(ctx, client, subscriber, context) {
  const failed = (why) => {
    context.error?.(`newsletter confirm failed: ${why}`);
    return json(502, {
      ok: false,
      error: 'We could not confirm your subscription right now. Please try again in a few minutes.',
    });
  };
  let segment;
  try {
    segment = await ctx.segmentId(client);
  } catch (error) {
    return failed(errorCode(error));
  }
  const ensured = await ensureConfirmedContact({
    client,
    email: subscriber.email,
    segmentId: segment,
  });
  if (!ensured.ok) return failed(ensured.why);
  context.log?.(`newsletter subscription confirmed: source=${subscriber.source}`);
  return json(200, { ok: true });
}

async function confirm(ctx, request, context) {
  const caller = callerKey(ctx, request, context);
  if (caller.refused) return caller.refused;
  const admitted = await admitConfirm(ctx, caller.key, context);
  if (admitted.response) return admitted.response;
  const body = await request.json().catch(() => null);
  const subscriber = verifyConfirmationToken(
    deriveConfirmationKey(admitted.setup.apiKey),
    body?.token,
    ctx.now()
  );
  if (!subscriber) {
    return json(400, {
      ok: false,
      code: 'INVALID_OR_EXPIRED',
      error: 'This confirmation link is invalid or has expired. Please sign up again.',
    });
  }
  return confirmSubscriber(ctx, admitted.setup.client, subscriber, context);
}

/**
 * The Newsletter segment's id, resolved once per process: a segment id does
 * not change, and listing on every confirm is waste. A failure must not be
 * cached, or one bad minute poisons the process.
 */
function segmentIdCache() {
  let promise = null;
  return (client) => {
    if (!promise) {
      promise = resolveSegmentId(client).catch((error) => {
        promise = null;
        throw error;
      });
    }
    return promise;
  };
}

/**
 * @param {object} deps
 * @param {{ anonymousKey: Function }} deps.identity
 * @param {object} deps.store the quota store `enforceSubmissionQuota` needs
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetch]
 * @param {() => number} [deps.now]
 */
export function createNewsletterHandlers({
  identity,
  store,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  const ctx = { identity, store, env, fetchImpl, now, segmentId: segmentIdCache() };
  return {
    subscribe: (request, context) => subscribe(ctx, request, context),
    confirm: (request, context) => confirm(ctx, request, context),
  };
}
