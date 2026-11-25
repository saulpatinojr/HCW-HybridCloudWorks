/**
 * admin-test-route.js — sending one test email of an issue to the owner, at
 * most one a minute, and the opening every send route shares
 * (admin-handlers.js holds the approval and builds the routes).
 */
import { missingEtag, etagRequired, resendNotConfigured, json, staleView, changedElsewhere, invocationRef, errorMeta, describeForLog, describeForOwner } from './admin-responses.js';
import { readKey } from '../ai/router.js';
import { readForRoute, settingsIncomplete, isDraft, renderOr500 } from './admin-route-kit.js';
import { missingForSending } from './settings.js';
import { testRateLimit } from './admin-patch.js';
import { createResendClient } from './resend-client.js';

// ── Sending: the test email and the approval ────────────────────────────────

/**
 * The opening a test send and an approval share: the role, the etag, `gate`
 * (approve's sending switch; nothing for a test), the Resend key, then the
 * settings and the issue. `{ auth, body, apiKey, settings, issue }` or
 * `{ response }`.
 */
export async function openSend(ctx, request, context, { role, label, gate = () => null }) {
  const auth = await ctx.guard.requireRole(request, role);
  if (auth.error) return { response: auth.error };
  const body = await request.json().catch(() => null);
  if (missingEtag(body)) return { response: etagRequired() };
  const apiKey = readKey(ctx.env, 'RESEND_API_KEY');
  const refused = gate() ?? (apiKey ? null : resendNotConfigured());
  if (refused) return { response: refused };
  const loaded = await readForRoute(ctx, request, label, context, { withSettings: true });
  return loaded.response ? loaded : { ...loaded, auth, body, apiKey };
}

/**
 * What a test send refuses once the issue is read: incomplete settings, an
 * issue that is not a draft, a second test inside the minute — judged before
 * the stale check, so a second press is "too soon" whichever etag it
 * carries — and a stale view. The response, or null.
 */
export function refuseTest(settings, issue, body, at) {
  const missing = missingForSending(settings);
  if (missing.length) return settingsIncomplete(missing, 'sending a test');
  if (!isDraft(issue.status)) {
    return json(409, {
      ok: false,
      error: `Only a draft can be test-sent; this issue is ${issue.status}.`,
    });
  }
  return testRateLimit(issue, at) ?? (staleView(body, issue) ? changedElsewhere() : null);
}

/**
 * `lastTestAt` written with an ETag-conditional replace BEFORE Resend is
 * called, so a double click sends once. `{ claimed }` as stored, or
 * `{ response }`: the loser's 429 (or 409 when an edit got there first), or
 * the 500 for any other failure.
 */
export async function claimTestSlot({ store }, issue, at, context) {
  try {
    const claimed = await store.replaceDocIfMatch('newsletters', {
      ...issue,
      lastTestAt: at.toISOString(),
    });
    return { claimed };
  } catch (error) {
    if (error?.code !== 412) {
      context.error?.(`testNewsletter claim failed ${invocationRef(context)}: ${errorMeta(error)}`);
      return { response: json(500, { ok: false, error: 'Failed to send the test email' }) };
    }
    // Another test (or an edit) got there first; say which.
    const current = await store.readDoc('newsletters', issue.id, issue.id).catch(() => null);
    return { response: testRateLimit(current, at) ?? changedElsewhere() };
  }
}

/** The one test email, through Resend's single-email endpoint, and its answer. */
export async function sendTestEmail(ctx, { apiKey, settings, rendered, claimed }, context) {
  const ref = invocationRef(context);
  const sentTo = settings.replyTo;
  const client = createResendClient({ apiKey, fetch: ctx.fetchImpl });
  const sent = await client.sendEmail({
    from: await ctx.fromAddress(context),
    to: [sentTo],
    subject: `[TEST] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
  });
  const etag = claimed?._etag ?? null;
  const problem = rendered.templateProblem ? { templateProblem: rendered.templateProblem } : {};
  if (!sent.ok) {
    context.error?.(`testNewsletter not sent ${ref}: ${describeForLog(sent)}`);
    return json(502, {
      ok: false,
      etag,
      ...problem,
      error: `Resend did not accept the test email: ${describeForOwner(sent)}`,
    });
  }
  context.log?.(`testNewsletter sent ${ref}`);
  return json(200, { ok: true, sentTo, etag, ...problem });
}

/**
 * Email ONE test copy of a draft to the reply-to address in Newsletter
 * settings.
 *
 * This cannot reach a subscriber, which is why it is NOT gated on
 * NEWSLETTER_SENDING_ENABLED: the recipient is read from settings, never
 * from the request body, and the call is Resend's single-email endpoint,
 * not a broadcast to the segment. Publisher, because it still sends mail
 * from the newsletter's address.
 *
 * One test per issue per minute (claimTestSlot). A refused send still
 * counts toward the minute. The claim changes the issue's etag, so the
 * answer carries the new one for the page to keep editing with.
 */
export async function test(ctx, request, context) {
  const opened = await openSend(ctx, request, context, {
    role: 'publisher',
    label: 'testNewsletter',
  });
  if (opened.response) return opened.response;
  const { body, apiKey, settings, issue } = opened;
  const at = ctx.now();
  const refused = refuseTest(settings, issue, body, at);
  if (refused) return refused;
  // In the chosen design; an unusable template falls back to the built-in
  // one for a test, and the answer says so.
  const rendered = await renderOr500(
    ctx,
    'testNewsletter',
    { issue, renderSettings: { postalAddress: settings.postalAddress, testSend: true }, settings },
    context
  );
  if (rendered.response) return rendered.response;
  const claim = await claimTestSlot(ctx, issue, at, context);
  if (claim.response) return claim.response;
  return sendTestEmail(
    ctx,
    { apiKey, settings, rendered: rendered.rendered, claimed: claim.claimed },
    context
  );
}

