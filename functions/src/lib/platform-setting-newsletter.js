/**
 * platform-setting-newsletter.js — the newsletter settings normalizer
 * (#557): content, signup form, template, sender and schedule fields.
 * platform-settings.js re-exports normalizeNewsletterSettings.
 */
import {
  BUILT_IN_TEMPLATE_ID,
  DEFAULT_NEWSLETTER_SETTINGS,
  MAX_POSTAL_ADDRESS_LENGTH,
  MAX_SIGNUP_BLURB_LENGTH,
  MAX_SIGNUP_HEADING_LENGTH,
  SEND_DAYS,
  SIGNUP_PLACEMENTS,
  TEMPLATE_ID_PATTERN,
  newsletterSettingsDefaults,
} from './newsletter/settings.js';
import { isValidSendTime, isValidTimeZone } from './newsletter/schedule.js';
import { normalizeEmail } from './newsletter/email.js';
import { fail, isPlainObject, assertOnlyKeys } from './platform-setting-checks.js';
import { normalizeNewsletterContent } from './platform-setting-newsletter-content.js';

// ── newsletter ─────────────────────────────────────────────────────────────

/**
 * One line of plain text: every run of whitespace or control characters,
 * line breaks included, becomes a single space, and the ends are trimmed.
 * The site renders it as text, so nothing here is escaped; what is refused is
 * only what could not be shown as one line in a box.
 */
function signupText(raw, field, maxLength) {
  if (typeof raw !== 'string') fail(`${field} must be a string`);
   
  const text = raw.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  if (text.length > maxLength) fail(`${field} must be at most ${maxLength} characters`);
  return text;
}

/**
 * The signup form fields (#557): signupPlacement, signupHeading, signupBlurb.
 * The placement is checked first and on its own, so a value the site cannot
 * place is refused by name before either string is looked at. A blank heading
 * is refused — the box would open on an empty title — while a blank blurb is
 * allowed and the site then shows no paragraph.
 */
function normalizeNewsletterSignup(body, value) {
  if (body.signupPlacement !== undefined) {
    if (!SIGNUP_PLACEMENTS.includes(body.signupPlacement)) {
      fail(`signupPlacement must be one of ${SIGNUP_PLACEMENTS.join(', ')}`);
    }
    value.signupPlacement = body.signupPlacement;
  }
  if (body.signupHeading !== undefined) {
    const heading = signupText(body.signupHeading, 'signupHeading', MAX_SIGNUP_HEADING_LENGTH);
    if (!heading) fail('signupHeading must not be blank');
    value.signupHeading = heading;
  }
  if (body.signupBlurb !== undefined) {
    value.signupBlurb = signupText(body.signupBlurb, 'signupBlurb', MAX_SIGNUP_BLURB_LENGTH);
  }
}

/**
 * The template field (#557): a Resend template id, or '' for the built-in
 * design. Trimmed, because it is pasted and read back from Resend's API.
 */
function normalizeNewsletterTemplate(body, value) {
  if (body.templateId === undefined) return;
  if (typeof body.templateId !== 'string') fail('templateId must be a string');
  const templateId = body.templateId.trim();
  if (templateId !== BUILT_IN_TEMPLATE_ID && !TEMPLATE_ID_PATTERN.test(templateId)) {
    fail('templateId must be empty (the built-in design) or a Resend template id');
  }
  value.templateId = templateId;
}

/**
 * `{ postalAddress, replyTo, sendDay, sendTime, timeZone, sections, windowDays,
 * introEnabled, introTone, signupPlacement, signupHeading, signupBlurb,
 * templateId }` →
 * the document the newsletter approval reads
 * (lib/newsletter/admin-handlers.js) and the issue builder reads for content
 * (lib/newsletter/issue.js). Blank address and reply-to are ALLOWED here, so
 * the page can save one before the other; approval is what refuses to send
 * without them (`missingForSending`). A field left out takes its default, so a
 * document saved before the content fields existed reads as the defaults.
 */
export function normalizeNewsletterSettings(body) {
  if (!isPlainObject(body)) fail('Body must be a JSON object');
  const keys = Object.keys(DEFAULT_NEWSLETTER_SETTINGS);
  assertOnlyKeys(body, keys, 'body');
  const value = newsletterSettingsDefaults();
  normalizeNewsletterContent(body, value);
  normalizeNewsletterSignup(body, value);
  normalizeNewsletterTemplate(body, value);
  normalizeNewsletterAddresses(body, value);
  normalizeNewsletterSchedule(body, value);
  return value;
}

/** The sender fields: postalAddress and replyTo. Blank is allowed for both (approval refuses to send without them). */
function normalizeNewsletterAddresses(body, value) {
  if (body.postalAddress !== undefined) {
    if (typeof body.postalAddress !== 'string') fail('postalAddress must be a string');
    const address = body.postalAddress.replace(/\r\n/g, '\n').trim();
    if (address.length > MAX_POSTAL_ADDRESS_LENGTH) {
      fail(`postalAddress must be at most ${MAX_POSTAL_ADDRESS_LENGTH} characters`);
    }
    value.postalAddress = address;
  }
  if (body.replyTo !== undefined) {
    if (typeof body.replyTo !== 'string') fail('replyTo must be a string');
    const trimmed = body.replyTo.trim();
    if (trimmed && !normalizeEmail(trimmed)) fail('replyTo must be an email address');
    // Replies to the sending subdomain go nowhere: receiving is off there.
    if (/@news\.hybridcloudworks\.com$/i.test(trimmed)) {
      fail('replyTo must be an inbox that receives mail; news.hybridcloudworks.com does not');
    }
    value.replyTo = trimmed;
  }
}

/** The schedule fields: sendDay, sendTime and timeZone. */
function normalizeNewsletterSchedule(body, value) {
  if (body.sendDay !== undefined) {
    if (!SEND_DAYS.includes(body.sendDay)) fail(`sendDay must be one of ${SEND_DAYS.join(', ')}`);
    value.sendDay = body.sendDay;
  }
  if (body.sendTime !== undefined) {
    if (!isValidSendTime(body.sendTime)) fail('sendTime must be HH:MM (24-hour)');
    value.sendTime = body.sendTime;
  }
  if (body.timeZone !== undefined) {
    if (!isValidTimeZone(body.timeZone))
      fail('timeZone must be an IANA time zone such as America/Chicago');
    value.timeZone = body.timeZone;
  }
}
