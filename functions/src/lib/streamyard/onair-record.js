/**
 * streamyard/onair-record.js — what one StreamYard On-Air registrant event
 * does once it is accepted (onair.js checks it first): the newsletter
 * invite, the owner's Telegram line, and the masked record kept in
 * `admin_config/streamyard_onair`. onair.js says why and exports maskEmail
 * and the record's shape again.
 */
import { ADMIN_CONFIG_PARTITION } from "../cosmos-client.js";
import { readKey } from "../ai/router.js";
import { sendConfirmationEmail } from "../newsletter/handlers.js";
import { resolveFromAddress } from "../newsletter/sender.js";

export const STREAMYARD_ONAIR_CONFIG_ID = "streamyard_onair";
export const MAX_RECENT_REGISTRANTS = 25;
export const VALID_STATUSES = Object.freeze([
  "registered",
  "attended_live",
  "watched_on_demand",
]);

/** Mask an email address for admin display and storage (`s***@example.com`). */
export function maskEmail(email) {
  const clean = String(email ?? "")
    .trim()
    .toLowerCase();
  const at = clean.indexOf("@");
  if (at <= 0) return "***";
  return `${clean[0]}***${clean.slice(at)}`;
}

/** Where a stored registrant row came from; anything unknown reads as the webhook. */
const ROW_SOURCES = new Set(["website", "test"]);

/** One stored registrant row, read defensively. */
function projectRow(row) {
  return {
    maskedEmail: String(row?.maskedEmail ?? "***"),
    webinarTitle: String(row?.webinarTitle ?? "HCW On-Air Webinar"),
    status: VALID_STATUSES.includes(row?.status) ? row.status : "registered",
    source: ROW_SOURCES.has(row?.source) ? row.source : "webhook",
    newsletterInvited: Boolean(row?.newsletterInvited),
    telegramSent: Boolean(row?.telegramSent),
    recordedAt: typeof row?.recordedAt === "string" ? row.recordedAt : null,
  };
}

const countOf = (value) => (Number.isInteger(value) ? value : 0);

export function projectStoredState(doc) {
  const recent = Array.isArray(doc?.recentRegistrants)
    ? doc.recentRegistrants.slice(0, MAX_RECENT_REGISTRANTS).map(projectRow)
    : [];
  return {
    totalRegistrants: countOf(doc?.totalRegistrants),
    totalAttended: countOf(doc?.totalAttended),
    lastEventAt: typeof doc?.lastEventAt === "string" ? doc.lastEventAt : null,
    recentRegistrants: recent,
  };
}

/** The label after "StreamYard On-Air" that says where an event came from. */
const ORIGIN_LABELS = new Map([
  ["test", " [Portal test]"],
  ["website", " [Website form]"],
]);

function buildTelegramText({
  status,
  webinarTitle,
  maskedEmail,
  source,
  newsletterInvited,
}) {
  const originLabel = ORIGIN_LABELS.get(source) ?? "";
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

/** Invite, tell the owner, and keep the masked record of one accepted event. */
export async function recordRegistrantEvent(deps, event, context) {
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

