/**
 * platform-setting-newsletter.js — the newsletter settings normalizer
 * (#557): content, signup form, template, sender and schedule fields.
 * platform-settings.js re-exports normalizeNewsletterSettings.
 */
import {
  BUILT_IN_TEMPLATE_ID,
  DEFAULT_NEWSLETTER_SETTINGS,
  INTRO_TONE_IDS,
  MAX_POSTAL_ADDRESS_LENGTH,
  MAX_SECTION_ITEMS,
  MAX_SIGNUP_BLURB_LENGTH,
  MAX_SIGNUP_HEADING_LENGTH,
  MAX_WINDOW_DAYS,
  MIN_SECTION_ITEMS,
  MIN_WINDOW_DAYS,
  SEND_DAYS,
  SIGNUP_PLACEMENTS,
  TEMPLATE_ID_PATTERN,
  newsletterSettingsDefaults,
} from './newsletter/settings.js';
import { MAX_ITEMS_PER_SECTION, SECTIONS } from './newsletter/sections.js';
import { isValidSendTime, isValidTimeZone } from './newsletter/schedule.js';
import { normalizeEmail } from './newsletter/email.js';
import { fail, isPlainObject, assertOnlyKeys } from './platform-setting-checks.js';

// ── newsletter ─────────────────────────────────────────────────────────────

/** More rows than any registry will hold: a bound on work, not on sections. */
const MAX_SECTION_ROWS = 50;

/** A numeric string read as a number; anything else is returned as given. */
const toNumber = (raw) => (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw);

const clampInteger = (raw, min, max, where) => {
  const n = toNumber(raw);
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(`${where} must be a number`);
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/**
 * The ordered section list: `[{ id, enabled, maxItems }]`. Ids the registry
 * does not know are DROPPED rather than refused — a section retired from the
 * code must not make every saved document unreadable — and a repeated id keeps
 * its first place. Registry sections the list does not name are appended,
 * enabled, at the builder's limit, so a section added to the code shows up in
 * the next issue without anyone saving settings. maxItems is clamped to
 * MIN_SECTION_ITEMS..MAX_SECTION_ITEMS. At least one section must be on: an
 * issue with no sections is never built, and saving that would read as "the
 * newsletter is broken" on Monday rather than as a choice.
 */
function normalizeSectionSettings(raw) {
  if (!Array.isArray(raw)) fail('sections must be an array of { id, enabled, maxItems }');
  if (raw.length > MAX_SECTION_ROWS) fail(`sections may hold at most ${MAX_SECTION_ROWS} entries`);
  const known = new Set(SECTIONS.map((section) => section.id));
  const seen = new Set();
  const out = [];
  raw.forEach((entry, index) => {
    if (!isPlainObject(entry)) fail(`sections[${index}] must be an object`);
    if (typeof entry.id !== 'string') fail(`sections[${index}].id must be a string`);
    // Decide to drop BEFORE validating the rest: a retired or repeated section
    // row is discarded whatever else it carries, so it can never make the
    // whole document invalid.
    if (!known.has(entry.id) || seen.has(entry.id)) return;
    assertOnlyKeys(entry, ['id', 'enabled', 'maxItems'], `sections[${index}]`);
    // Only an absent `enabled` defaults; null is refused like any non-boolean.
    const enabled = entry.enabled === undefined ? true : entry.enabled;
    if (typeof enabled !== 'boolean') fail(`sections[${index}].enabled must be true or false`);
    const maxItems =
      entry.maxItems === undefined
        ? MAX_ITEMS_PER_SECTION
        : clampInteger(
            entry.maxItems,
            MIN_SECTION_ITEMS,
            MAX_SECTION_ITEMS,
            `sections[${index}].maxItems`
          );
    seen.add(entry.id);
    out.push({ id: entry.id, enabled, maxItems });
  });
  for (const id of known) {
    if (!seen.has(id)) out.push({ id, enabled: true, maxItems: MAX_ITEMS_PER_SECTION });
  }
  if (!out.some((entry) => entry.enabled)) fail('Turn on at least one section');
  return out;
}

/** The content fields (#557): sections, windowDays, introEnabled, introTone. */
function normalizeNewsletterContent(body, value) {
  if (body.sections !== undefined) value.sections = normalizeSectionSettings(body.sections);
  if (body.windowDays !== undefined) {
    value.windowDays = clampInteger(
      body.windowDays,
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
      'windowDays'
    );
  }
  if (body.introEnabled !== undefined) {
    if (typeof body.introEnabled !== 'boolean') fail('introEnabled must be true or false');
    value.introEnabled = body.introEnabled;
  }
  if (body.introTone !== undefined) {
    if (!INTRO_TONE_IDS.includes(body.introTone)) {
      fail(`introTone must be one of ${INTRO_TONE_IDS.join(', ')}`);
    }
    value.introTone = body.introTone;
  }
}

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
