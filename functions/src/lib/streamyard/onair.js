/**
 * streamyard/onair.js — StreamYard On-Air webinar integration:
 *
 *   1. Auto-subscribe webinar registrants to the HCW Newsletter (double opt-in
 *      confirmation email via Resend).
 *   2. Public custom webinar registration endpoint (`POST /api/public/webinars/register`)
 *      with Cloudflare origin identity verification and rate limiting.
 *   3. Telegram notifications on new webinar registrations and attendance status
 *      updates (`registered`, `attended_live`, `watched_on_demand`).
 *   4. Admin Portal status & test-event endpoints (`GET /api/cms/streamyard/status`
 *      and `POST /api/cms/streamyard/test-event`) backing the Integrations
 *      beaker test and the StreamYard On-Air card panel.
 *
 * Telemetry is content-free: log lines record only the route/event kind and
 * status, never an email address, a registrant name, a webinar title or a key.
 * Stored recent registrant records in `admin_config/streamyard_onair` keep only
 * masked email addresses (`s***@example.com`).
 */
import { ADMIN_CONFIG_PARTITION } from "../cosmos-client.js";
import { readKey } from "../ai/router.js";
import { enforceSubmissionQuota } from "../submissions.js";
import { createResendClient } from "../newsletter/resend-client.js";
import { normalizeEmail } from "../newsletter/email.js";
import { sendConfirmationEmail } from "../newsletter/handlers.js";
import { resolveFromAddress } from "../newsletter/sender.js";
import { createSender, secretMatches } from "../telegram/bot.js";

export const STREAMYARD_ONAIR_CONFIG_ID = "streamyard_onair";
export const MAX_RECENT_REGISTRANTS = 25;
export const VALID_STATUSES = Object.freeze([
  "registered",
  "attended_live",
  "watched_on_demand",
]);

const ALLOWED_PAYLOAD_KEYS = new Set([
  "email",
  "firstName",
  "lastName",
  "name",
  "webinarId",
  "webinarTitle",
  "status",
  "subscribeNewsletter",
  "website",
]);

const ALLOWED_TEST_KEYS = new Set(["webinarTitle", "status"]);

const json = (status, body, headers = {}) => ({
  status,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

/** Mask an email address for admin display and storage (`s***@example.com`). */
export function maskEmail(email) {
  const clean = String(email ?? "")
    .trim()
    .toLowerCase();
  const at = clean.indexOf("@");
  if (at <= 0) return "***";
  return `${clean[0]}***${clean.slice(at)}`;
}

/** Extract the API key from `X-StreamYard-Api-Key` or `Authorization: Bearer`. */
export function extractWebhookKey(request) {
  const direct = request.headers?.get?.("x-streamyard-api-key");
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const auth = request.headers?.get?.("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? match[1].trim() : "";
}

function normalizeStatus(raw) {
  if (raw === undefined || raw === null || raw === "") return "registered";
  const clean = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return VALID_STATUSES.includes(clean) ? clean : null;
}

function cleanText(value, maxLen = 120) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

/**
 * Validate a webinar registrant payload from either the webhook or the public
 * registration form. Unknown keys are refused with a 400 sentence.
 */
export function parseRegistrantPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Send a JSON object with at least { email }" };
  }
  const unknown = Object.keys(body).filter(
    (key) => !ALLOWED_PAYLOAD_KEYS.has(key),
  );
  if (unknown.length > 0) {
    return { error: `Unknown field(s): ${unknown.join(", ")}` };
  }
  const honeypot = cleanText(body.website, 200);
  const email = normalizeEmail(body.email);
  if (!email) {
    return { error: "A valid email address is required" };
  }
  const status = normalizeStatus(body.status);
  if (!status) {
    return { error: `status must be one of ${VALID_STATUSES.join(", ")}` };
  }
  if (
    body.subscribeNewsletter !== undefined &&
    typeof body.subscribeNewsletter !== "boolean"
  ) {
    return { error: "subscribeNewsletter must be true or false" };
  }
  const webinarTitle =
    cleanText(body.webinarTitle, 140) || "HCW On-Air Webinar";
  const webinarId = cleanText(body.webinarId, 80) || null;
  const firstName = cleanText(body.firstName, 80) || null;
  const lastName = cleanText(body.lastName, 80) || null;
  return {
    value: {
      email,
      firstName,
      lastName,
      webinarId,
      webinarTitle,
      status,
      subscribeNewsletter: body.subscribeNewsletter ?? true,
      honeypot,
    },
  };
}

function parseTestPayload(body) {
  if (body === null || body === undefined) {
    return {
      value: { webinarTitle: "HCW On-Air Test Webinar", status: "registered" },
    };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return { error: "Send a JSON object { webinarTitle?, status? }" };
  }
  const unknown = Object.keys(body).filter(
    (key) => !ALLOWED_TEST_KEYS.has(key),
  );
  if (unknown.length > 0) {
    return { error: `Unknown field(s): ${unknown.join(", ")}` };
  }
  const status = normalizeStatus(body.status);
  if (!status) {
    return { error: `status must be one of ${VALID_STATUSES.join(", ")}` };
  }
  const webinarTitle =
    cleanText(body.webinarTitle, 140) || "HCW On-Air Test Webinar";
  return { value: { webinarTitle, status } };
}

function projectStoredState(doc) {
  const recent = Array.isArray(doc?.recentRegistrants)
    ? doc.recentRegistrants.slice(0, MAX_RECENT_REGISTRANTS).map((row) => ({
        maskedEmail: String(row?.maskedEmail ?? "***"),
        webinarTitle: String(row?.webinarTitle ?? "HCW On-Air Webinar"),
        status: VALID_STATUSES.includes(row?.status)
          ? row.status
          : "registered",
        source:
          row?.source === "website" || row?.source === "test"
            ? row.source
            : "webhook",
        newsletterInvited: Boolean(row?.newsletterInvited),
        telegramSent: Boolean(row?.telegramSent),
        recordedAt: typeof row?.recordedAt === "string" ? row.recordedAt : null,
      }))
    : [];
  return {
    totalRegistrants: Number.isInteger(doc?.totalRegistrants)
      ? doc.totalRegistrants
      : 0,
    totalAttended: Number.isInteger(doc?.totalAttended) ? doc.totalAttended : 0,
    lastEventAt: typeof doc?.lastEventAt === "string" ? doc.lastEventAt : null,
    recentRegistrants: recent,
  };
}

function buildTelegramText({
  status,
  webinarTitle,
  maskedEmail,
  source,
  newsletterInvited,
}) {
  const originLabel =
    source === "test"
      ? " [Portal test]"
      : source === "website"
        ? " [Website form]"
        : "";
  if (status === "registered") {
    const inviteNote = newsletterInvited
      ? " Newsletter confirmation link emailed."
      : "";
    return `🎙️ StreamYard On-Air${originLabel} — New registrant (${maskedEmail}) for "${webinarTitle}".${inviteNote}`;
  }
  const label =
    status === "attended_live" ? "Attended live" : "Watched on demand";
  return `📺 StreamYard On-Air${originLabel} — ${label}: ${maskedEmail} for "${webinarTitle}".`;
}

async function tryNewsletterInvite(
  { env, store, createResend, now },
  { email, status, subscribeNewsletter, skipEmail },
  context,
) {
  if (skipEmail || status !== "registered" || !subscribeNewsletter)
    return false;
  const resendKey = readKey(env, "RESEND_API_KEY");
  if (!resendKey) return false;
  try {
    const client = createResend(resendKey);
    const from = await resolveFromAddress(store, context);
    const result = await sendConfirmationEmail({
      client,
      apiKey: resendKey,
      email,
      source: "website",
      now,
      from,
    });
    return Boolean(result?.ok);
  } catch {
    context.warn?.("[streamyard] newsletter confirmation email failed");
    return false;
  }
}

async function tryTelegramAlert(sendTelegram, message, context) {
  try {
    const res = await sendTelegram(message);
    return Boolean(res?.sent);
  } catch {
    context.warn?.("[streamyard] telegram notification failed");
    return false;
  }
}

async function recordRegistrantEvent(deps, event, context) {
  const { store, now } = deps;
  const nowIso = new Date(now()).toISOString();
  const maskedEmail = maskEmail(event.email);
  const newsletterInvited = await tryNewsletterInvite(deps, event, context);
  const telegramText = buildTelegramText({
    status: event.status,
    webinarTitle: event.webinarTitle,
    maskedEmail,
    source: event.source,
    newsletterInvited,
  });
  const telegramSent = await tryTelegramAlert(
    deps.sendTelegram,
    telegramText,
    context,
  );

  const existing = await store.readDoc(
    ADMIN_CONFIG_PARTITION,
    STREAMYARD_ONAIR_CONFIG_ID,
    ADMIN_CONFIG_PARTITION,
  );
  const current = projectStoredState(existing);
  const isRegistration = event.status === "registered";
  const isAttendance =
    event.status === "attended_live" || event.status === "watched_on_demand";

  const entry = {
    maskedEmail,
    webinarTitle: event.webinarTitle,
    status: event.status,
    source: event.source,
    newsletterInvited,
    telegramSent,
    recordedAt: nowIso,
  };

  const updated = {
    id: STREAMYARD_ONAIR_CONFIG_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    docType: "streamyard_onair",
    totalRegistrants: current.totalRegistrants + (isRegistration ? 1 : 0),
    totalAttended: current.totalAttended + (isAttendance ? 1 : 0),
    lastEventAt: nowIso,
    recentRegistrants: [entry, ...current.recentRegistrants].slice(
      0,
      MAX_RECENT_REGISTRANTS,
    ),
    updatedAt: nowIso,
  };

  await store.upsertDoc(ADMIN_CONFIG_PARTITION, updated);
  return { entry, state: projectStoredState(updated) };
}

/**
 * Factory for the four StreamYard On-Air routes.
 */
export function createStreamYardHandlers({
  guard,
  identity,
  store,
  env = process.env,
  createResend = (apiKey) => createResendClient({ apiKey }),
  sendTelegram = null,
  now = Date.now,
} = {}) {
  const telegramSender = sendTelegram ?? createSender({ env });
  const deps = { store, env, createResend, sendTelegram: telegramSender, now };

  async function getStatus(request) {
    const auth = await guard.requireRole(request, "editor");
    if (auth.error) return auth.error;

    const configured = Boolean(readKey(env, "STREAMYARD_API_KEY"));
    const newsletterConfigured = Boolean(readKey(env, "RESEND_API_KEY"));
    const telegramConfigured = Boolean(
      readKey(env, "TELEGRAM_BOT_TOKEN") && readKey(env, "TELEGRAM_CHAT_ID"),
    );
    const stored = await store.readDoc(
      ADMIN_CONFIG_PARTITION,
      STREAMYARD_ONAIR_CONFIG_ID,
      ADMIN_CONFIG_PARTITION,
    );
    return json(200, {
      ok: true,
      configured,
      newsletterConfigured,
      telegramConfigured,
      ...projectStoredState(stored),
    });
  }

  async function testEvent(request, context) {
    const auth = await guard.requireRole(request, "editor");
    if (auth.error) return auth.error;

    const apiKey = readKey(env, "STREAMYARD_API_KEY");
    if (!apiKey) {
      return json(200, {
        ok: false,
        code: "INTEGRATION_NOT_CONFIGURED",
        error:
          "StreamYard On-Air is not configured: STREAMYARD_API_KEY is not set",
      });
    }

    const body = await request.json().catch(() => null);
    const parsed = parseTestPayload(body);
    if (parsed.error) return json(400, { ok: false, error: parsed.error });

    const { entry, state } = await recordRegistrantEvent(
      deps,
      {
        email: "test-registrant@hybridcloudworks.com",
        webinarTitle: parsed.value.webinarTitle,
        status: parsed.value.status,
        subscribeNewsletter: false,
        skipEmail: true,
        source: "test",
      },
      context,
    );
    context.log?.(`[streamyard] test event recorded: status=${entry.status}`);
    return json(200, { ok: true, event: entry, ...state });
  }

  async function webhook(request, context) {
    const expected = readKey(env, "STREAMYARD_API_KEY");
    if (!expected) {
      context.warn?.(
        "[streamyard] STREAMYARD_API_KEY is not configured; refusing webhook.",
      );
      return json(404, { ok: false, error: "Not found" });
    }

    const provided = extractWebhookKey(request);
    if (!secretMatches(provided, expected)) {
      context.warn?.("[streamyard] rejected webhook with invalid API key.");
      return json(401, { ok: false, error: "Unauthorized" });
    }

    const body = await request.json().catch(() => null);
    const parsed = parseRegistrantPayload(body);
    if (parsed.error) return json(400, { ok: false, error: parsed.error });

    const { entry } = await recordRegistrantEvent(
      deps,
      { ...parsed.value, skipEmail: false, source: "webhook" },
      context,
    );
    context.log?.(`[streamyard] webhook processed: status=${entry.status}`);
    return json(200, {
      ok: true,
      status: entry.status,
      newsletterInvited: entry.newsletterInvited,
      telegramSent: entry.telegramSent,
    });
  }

  async function publicRegister(request, context) {
    let clientKey;
    try {
      clientKey = identity.anonymousKey(request).key;
    } catch {
      context.warn?.(
        "[streamyard] public registration rejected: unverified origin",
      );
      return json(403, { ok: false, error: "Forbidden" });
    }

    const body = await request.json().catch(() => null);
    const parsed = parseRegistrantPayload(body);
    if (parsed.error) return json(400, { ok: false, error: parsed.error });

    // Honeypot filled by a bot: answer 200 without writing or sending anything.
    if (parsed.value.honeypot) {
      return json(200, {
        ok: true,
        message:
          "Registration received. Check your email for confirmation details.",
      });
    }

    try {
      await enforceSubmissionQuota(store, clientKey, { now: now() });
    } catch (err) {
      if (err.code === "SUBMISSION_RATE_LIMIT") {
        return json(
          429,
          { ok: false, error: err.message },
          { "Retry-After": "3600" },
        );
      }
      throw err;
    }

    const { entry } = await recordRegistrantEvent(
      deps,
      {
        ...parsed.value,
        status: "registered",
        skipEmail: false,
        source: "website",
      },
      context,
    );
    context.log?.("[streamyard] public webinar registration recorded");
    return json(201, {
      ok: true,
      newsletterInvited: entry.newsletterInvited,
      message:
        "Registration received. Check your email for confirmation details.",
    });
  }

  return { getStatus, testEvent, webhook, publicRegister };
}
