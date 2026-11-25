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
import { authoredMessage } from "../http/error-response.js";
import { readKey } from "../ai/router.js";
import { enforceSubmissionQuota } from "../submissions.js";
import { createResendClient } from "../newsletter/resend-client.js";
import { normalizeEmail } from "../newsletter/email.js";
import { createSender, secretMatches } from "../telegram/bot.js";
import {
  projectStoredState,
  recordRegistrantEvent,
  STREAMYARD_ONAIR_CONFIG_ID,
  VALID_STATUSES,
} from "./onair-record.js";

// What an accepted event does (invite, Telegram line, masked record) lives in
// onair-record.js; these are exported again so callers keep importing them
// from onair.js.
export {
  MAX_RECENT_REGISTRANTS,
  maskEmail,
  STREAMYARD_ONAIR_CONFIG_ID,
  VALID_STATUSES,
} from "./onair-record.js";

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

/** The refusal for a body that is not an object, or carries a field not in `allowed`; null when it is fine. */
function shapeError(body, allowed, notAnObject) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return notAnObject;
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  return unknown.length > 0 ? `Unknown field(s): ${unknown.join(", ")}` : null;
}

/** The refusal for a registrant's email, status or newsletter choice; null when all are fine. */
function registrantFieldError(body, email, status) {
  if (!email) return "A valid email address is required";
  if (!status) return `status must be one of ${VALID_STATUSES.join(", ")}`;
  if (
    body.subscribeNewsletter !== undefined &&
    typeof body.subscribeNewsletter !== "boolean"
  ) {
    return "subscribeNewsletter must be true or false";
  }
  return null;
}

/**
 * Validate a webinar registrant payload from either the webhook or the public
 * registration form. Unknown keys are refused with a 400 sentence.
 */
export function parseRegistrantPayload(body) {
  const shape = shapeError(body, ALLOWED_PAYLOAD_KEYS, "Send a JSON object with at least { email }");
  if (shape) return { error: shape };
  const honeypot = cleanText(body.website, 200);
  const email = normalizeEmail(body.email);
  const status = normalizeStatus(body.status);
  const fieldError = registrantFieldError(body, email, status);
  if (fieldError) return { error: fieldError };
  return {
    value: {
      email,
      firstName: cleanText(body.firstName, 80) || null,
      lastName: cleanText(body.lastName, 80) || null,
      webinarId: cleanText(body.webinarId, 80) || null,
      webinarTitle: cleanText(body.webinarTitle, 140) || "HCW On-Air Webinar",
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
  const shape = shapeError(body, ALLOWED_TEST_KEYS, "Send a JSON object { webinarTitle?, status? }");
  if (shape) return { error: shape };
  const status = normalizeStatus(body.status);
  if (!status) {
    return { error: `status must be one of ${VALID_STATUSES.join(", ")}` };
  }
  const webinarTitle =
    cleanText(body.webinarTitle, 140) || "HCW On-Air Test Webinar";
  return { value: { webinarTitle, status } };
}

async function getStatus({ guard, store, env }, request) {
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

async function testEvent({ guard, env, deps }, request, context) {
  const auth = await guard.requireRole(request, "editor");
  if (auth.error) return auth.error;

  const apiKey = readKey(env, "STREAMYARD_API_KEY");
  if (!apiKey) {
    return json(200, {
      ok: false,
      code: "INTEGRATION_NOT_CONFIGURED",
      error: "STREAMYARD_API_KEY is not set",
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

/** The refusal for a webhook call without the right key, or null when the key matches. */
function webhookRefusal(env, request, context) {
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
  return null;
}

async function webhook({ env, deps }, request, context) {
  const refused = webhookRefusal(env, request, context);
  if (refused) return refused;

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

/** `{ key }`: the visitor's anonymous key from a verified origin; null when the origin is not verified. */
function visitorKey(identity, request, context) {
  try {
    return { key: identity.anonymousKey(request).key };
  } catch {
    context.warn?.(
      "[streamyard] public registration rejected: unverified origin",
    );
    return null;
  }
}

/**
 * PUBLIC: a visitor registers for an On Air event. Every answer is a
 * visitor sentence; the rate-limit refusal is authored (#945).
 *
 * @param {object} h - the handlers' dependencies
 * @param {object} request - the HTTP request
 * @param {object} context - the invocation context
 * @returns {Promise<object>} the HTTP response
 */
async function publicRegister(h, request, context) {
  const { store, now, deps } = h;
  const visitor = visitorKey(h.identity, request, context);
  if (visitor === null) return json(403, { ok: false, error: "Forbidden" });
  const clientKey = visitor.key;

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
        {
          ok: false,
          error: authoredMessage(err, "Too many requests — try again later."),
        },
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
  const h = { guard, identity, store, env, now, deps };
  return {
    getStatus: (request) => getStatus(h, request),
    testEvent: (request, context) => testEvent(h, request, context),
    webhook: (request, context) => webhook(h, request, context),
    publicRegister: (request, context) => publicRegister(h, request, context),
  };
}
