/**
 * platform-settings.js — the Admin → Platform settings page's read and write
 * of six `admin_config` documents, three of which until now could only be
 * seeded by an operator holding a Cosmos data-plane role (#351, #352, and the
 * feed list from #348/#349):
 *
 *   default-heroes          → admin_config/default_heroes          read by triggers/ai-cover.js
 *   social-autopost         → admin_config/social_autopost         read by triggers/social-caption-trigger.js
 *   podcast-feeds           → admin_config/podcast_feeds           read by timers/podcasts.js
 *   (listen-and-learn-speech → admin_config/listen_and_learn_speech left this page with ADR 0034
 *                             slice 5, #860: the model is chosen under AI Engine → Tasks, and the
 *                             stored document is read once by lib/ai/ai-config.js as the migration's input)
 *   podcast-voices          → admin_config/podcast_voices          read by podcast/voice-settings.js, for
 *                             every podcast render (episodes and the live check, #725)
 *   newsletter-settings     → admin_config/newsletter_settings     read by lib/newsletter/admin-handlers.js
 *                             and lib/newsletter/issue.js (content: sections, window, intro)
 *                             and lib/newsletter/signup-config.js (the public signup box)
 *                             (to be edited from the Mailing List page, not Platform settings)
 *   reminders               → admin_config/reminders               read by timers/reminders.js, daily, which says
 *                             each dated reminder on Telegram (owner, 2026-10-06; lib/reminders/settings.js)
 *
 * Every write is normalized to EXACTLY the shape its consumer reads — the
 * whole point of a screen over a hand-seeded document is that the shape can
 * no longer drift from the code that reads it. Unknown keys are refused, not
 * dropped, so a typo in a hand-made request is a 400 rather than a document
 * that silently governs nothing. The podcast rows are validated with the
 * timer's own `isValidFeedEntry`, so a row this module accepts is a row the
 * timer will fetch.
 *
 * The write is a full replace: each document is owned entirely by this page,
 * so replacing it is also how a drifted document gets repaired. It is a
 * conditional replace (#946). The read hands the page the document's ETag,
 * the save sends it back as If-Match, and a document saved elsewhere in
 * between is a 412 that the page answers by reloading, never an overwrite. A
 * save that names no version may only create the document; replacing a stored
 * one without naming its version is a 428. The reminders sheet is the
 * exception, guarded by its own read instead (writeMerged).
 * Nothing here logs document contents; the audit row carries counts only.
 *
 * The same module reads those audit rows back for the page's Change history
 * tab (#571): `platform_setting_updated` rows, newest first, projected to who,
 * when, which setting and the recorded summary — never the email the row
 * also holds.
 */
import { ADMIN_CONFIG_PARTITION } from './cosmos-client.js';
import { DEFAULT_HEROES_CONFIG_ID } from './triggers/ai-cover.js';
import { AUTOPOST_CONFIG_ID } from './triggers/social-caption-trigger.js';
import {
  MAIN_FEED_PROVIDER,
  PODCAST_FEEDS_CONFIG_ID,
  dedupeFeedsByProvider,
  isValidFeedEntry,
} from './timers/podcasts.js';
import { isElevenLabsVoiceId } from './listen-and-learn/speech/elevenlabs-voice-plan.js';
import { PODCAST_HOSTS, PODCAST_VOICES_CONFIG_ID } from './podcast/voice-settings.js';
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
  NEWSLETTER_SETTINGS_CONFIG_ID,
  SEND_DAYS,
  SIGNUP_PLACEMENTS,
  TEMPLATE_ID_PATTERN,
  newsletterContentOptions,
  newsletterSettingsDefaults,
} from './newsletter/settings.js';
import { MAX_ITEMS_PER_SECTION, SECTIONS } from './newsletter/sections.js';
import { isValidSendTime, isValidTimeZone } from './newsletter/schedule.js';
import { normalizeEmail } from './newsletter/email.js';
import { sharedTemplateCache } from './newsletter/template-source.js';
import {
  CONTENT_TAXONOMY_CONFIG_ID,
  defaultTaxonomy,
  normalizeContentTaxonomy,
} from './cms/taxonomy.js';
import {
  REMINDERS_CONFIG_ID,
  RemindersValidationError,
  emptyReminders,
  mergeStoredStamps,
  normalizeReminders,
  summarizeReminders,
} from './reminders/settings.js';

/**
 * A JSON response, with the stored document's ETag as an `ETag` header when
 * there is one (#946). The body carries the same value as `etag`, and that is
 * the copy the page reads: cors.js exposes the header, but App Service's own
 * CORS takes precedence over code where it handles a request, so what a
 * browser may read of the headers is not decided here alone.
 *
 * @param {number} status
 * @param {object} body
 * @param {string|null} [etag] Cosmos's `_etag`, already a quoted entity-tag
 */
const json = (status, body, etag = null) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) },
  body: JSON.stringify(body),
});

const MAX_BODY_JSON = 60_000;

/** Thrown by a normalizer; the handler turns it into a 400 with the message. */
export class PlatformSettingValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlatformSettingValidationError';
  }
}

const fail = (message) => {
  throw new PlatformSettingValidationError(message);
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Refuse keys outside `allowed` — an allowlisted shape, not a filtered one. */
function assertOnlyKeys(object, allowed, where) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`Unknown field(s) in ${where}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}`);
  }
}

// ── default heroes ─────────────────────────────────────────────────────────

/**
 * The provider keys ai-cover.js's PROVIDER_STYLES knows, in the casing the
 * hand-seeded document used. `pickDefaultHero` matches case-insensitively and
 * maps Google → GCP, so these are the canonical spellings, not a constraint
 * on the lookup.
 */
export const HERO_PROVIDERS = Object.freeze([
  'Azure',
  'AWS',
  'GCP',
  'GitHub',
  'Terraform',
  'Ansible',
  'VMware',
  // Docker since #775; its bundled cover is /images/default-heroes/docker.png.
  'Docker',
  'Multi',
]);

const MAX_URL_LENGTH = 2048;

/**
 * A hero URL: a same-origin path (`/images/…`, `/api/public/media/…`) or an
 * https URL. `//host/path` is protocol-relative — an off-origin reference in
 * a path's clothing — and is refused with the rest. No query string or
 * fragment on either form: this value is copied onto content documents and
 * served publicly (ai-cover.js writes it to `altCoverImage` and
 * `contentImageUrl`), so a SAS token or signature in a `?` would be
 * published with the post.
 */
export function isAcceptableHeroUrl(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  if (/[\s<>"'`\\?#]/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  return /^https:\/\/[^/]+/.test(value);
}

/**
 * `{ heroes: { <Provider>: url } }` → the document body ai-cover.js reads.
 * Keys are matched case-insensitively to HERO_PROVIDERS and stored under the
 * canonical spelling; a blank value means "no default for this provider" and
 * the key is omitted, which is what `pickDefaultHero` treats as no fallback.
 */
export function normalizeDefaultHeroes(body) {
  if (!isPlainObject(body)) fail('Body must be a JSON object');
  assertOnlyKeys(body, ['heroes'], 'body');
  const heroes = body.heroes ?? {};
  if (!isPlainObject(heroes)) fail('heroes must be an object keyed by provider');

  const out = {};
  for (const [rawKey, rawValue] of Object.entries(heroes)) {
    const canonical = HERO_PROVIDERS.find((p) => p.toLowerCase() === String(rawKey).toLowerCase());
    if (!canonical) {
      fail(`Unknown hero provider "${rawKey}". Allowed: ${HERO_PROVIDERS.join(', ')}`);
    }
    if (rawValue === null || rawValue === undefined) continue;
    if (typeof rawValue !== 'string') fail(`heroes.${canonical} must be a string`);
    const value = rawValue.trim();
    if (value === '') continue;
    if (!isAcceptableHeroUrl(value)) {
      fail(
        `heroes.${canonical} must be a same-origin path (/images/… or /api/public/media/…) or an https URL, with no query string or fragment`
      );
    }
    if (canonical in out) fail(`heroes.${canonical} given more than once`);
    out[canonical] = value;
  }
  return { heroes: out };
}

// ── social autopost ────────────────────────────────────────────────────────

/** The networks the Social Hub composes to (SocialHubPage PLATFORM_META). */
export const SOCIAL_PROVIDERS = Object.freeze([
  'linkedin',
  'twitter',
  'facebook',
  'instagram',
  'youtube',
]);

export const DEFAULT_SCHEDULE_DELAY_MINUTES = 60;
/** One week. Anything longer is a scheduling mistake, not an undo window. */
export const MAX_SCHEDULE_DELAY_MINUTES = 7 * 24 * 60;
const MAX_ACCOUNTS = 20;
const MAX_ACCOUNT_ID_LENGTH = 200;

/**
 * `{ enabled, accountIds: [{ id, provider }], scheduleDelayMinutes }` → the
 * document social-caption-trigger.js reads. `enabled` must be a real boolean
 * (the consumer tests truthiness, so "false" would read as ON); the delay is
 * a whole number of minutes from 1 to a week (the consumer treats 0 as
 * "use the default", which is not something a form should be able to say by
 * accident); accounts are deduplicated by id.
 */
export function normalizeSocialAutopost(body) {
  if (!isPlainObject(body)) fail('Body must be a JSON object');
  assertOnlyKeys(body, ['enabled', 'accountIds', 'scheduleDelayMinutes'], 'body');

  const enabled = body.enabled ?? false;
  if (typeof enabled !== 'boolean') fail('enabled must be true or false');

  const delayRaw = body.scheduleDelayMinutes ?? DEFAULT_SCHEDULE_DELAY_MINUTES;
  const delay =
    typeof delayRaw === 'string' && delayRaw.trim() !== '' ? Number(delayRaw) : delayRaw;
  if (!Number.isInteger(delay) || delay < 1 || delay > MAX_SCHEDULE_DELAY_MINUTES) {
    fail(`scheduleDelayMinutes must be a whole number from 1 to ${MAX_SCHEDULE_DELAY_MINUTES}`);
  }

  const accountsRaw = body.accountIds ?? [];
  if (!Array.isArray(accountsRaw)) fail('accountIds must be an array of { id, provider }');
  if (accountsRaw.length > MAX_ACCOUNTS)
    fail(`accountIds may hold at most ${MAX_ACCOUNTS} entries`);

  const seen = new Set();
  const accountIds = [];
  accountsRaw.forEach((entry, index) => {
    if (!isPlainObject(entry)) fail(`accountIds[${index}] must be an object`);
    assertOnlyKeys(entry, ['id', 'provider'], `accountIds[${index}]`);
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id === '') fail(`accountIds[${index}].id is required`);
    if (id.length > MAX_ACCOUNT_ID_LENGTH || /[\s]/.test(id)) {
      fail(`accountIds[${index}].id is not a valid account id`);
    }
    const provider = String(entry.provider ?? '')
      .trim()
      .toLowerCase();
    if (!SOCIAL_PROVIDERS.includes(provider)) {
      fail(`accountIds[${index}].provider must be one of ${SOCIAL_PROVIDERS.join(', ')}`);
    }
    if (seen.has(id)) return;
    seen.add(id);
    accountIds.push({ id, provider });
  });

  if (enabled && accountIds.length === 0) {
    fail('Add at least one account before enabling autoposting');
  }

  return { enabled, accountIds, scheduleDelayMinutes: delay };
}

// ── podcast feeds ──────────────────────────────────────────────────────────

/** The rows the page always shows; the document may carry others. */
export const PODCAST_PROVIDERS = Object.freeze([
  'azure',
  'aws',
  'gcp',
  'github',
  'terraform',
  'finops',
  'vmware',
  'ansible',
  // #777: /docker/audio renders the shared podcast page like every provider's.
  'docker',
]);

const MAX_FEEDS = 50;

/**
 * `{ mainFeedUrl, feeds: [{ provider, url }] }` → the document
 * timers/podcasts.js reads.
 *
 * `mainFeedUrl` is the site's own show — one feed that belongs to the site
 * rather than to a provider, ingested under the reserved provider `main` and
 * shown on every provider's audio page. Blank means the site has no show yet
 * and the key is omitted, which is what `resolveMainFeedEntry` treats as none.
 *
 * A `feeds` row with a blank URL means "no feed for this provider" and is
 * dropped. Every kept row passes the timer's own `isValidFeedEntry` (lowercase
 * slug provider, https URL) and the list is deduplicated the way the timer
 * would dedupe it, so what is stored is exactly what will run.
 *
 * Two rules exist only because the main feed does:
 *
 *   - `main` is not accepted as a provider row. There is one way to name the
 *     site's show, so the page cannot write a document that says it twice.
 *   - No provider row may repeat the main feed's URL. Both ingests would build
 *     the same episode ids from the same guids and each run would overwrite
 *     the other's `provider`, so the same episode would flip between the show
 *     and a provider from one firing to the next — a duplicate that never
 *     appears as two rows, only as a page that changes under the reader.
 */
export function normalizePodcastFeeds(body) {
  if (!isPlainObject(body)) fail('Body must be a JSON object');
  assertOnlyKeys(body, ['mainFeedUrl', 'feeds'], 'body');

  const mainRaw = body.mainFeedUrl ?? '';
  if (typeof mainRaw !== 'string') fail('mainFeedUrl must be a string');
  const mainFeedUrl = mainRaw.trim();
  if (mainFeedUrl !== '') {
    if (mainFeedUrl.length > MAX_URL_LENGTH || /[\s<>"'`\\]/.test(mainFeedUrl)) {
      fail('mainFeedUrl is not a valid URL');
    }
    if (!isValidFeedEntry({ provider: MAIN_FEED_PROVIDER, url: mainFeedUrl })) {
      fail('mainFeedUrl must be an https URL');
    }
  }

  const feedsRaw = body.feeds ?? [];
  if (!Array.isArray(feedsRaw)) fail('feeds must be an array of { provider, url }');
  if (feedsRaw.length > MAX_FEEDS) fail(`feeds may hold at most ${MAX_FEEDS} entries`);

  const feeds = [];
  feedsRaw.forEach((entry, index) => {
    if (!isPlainObject(entry)) fail(`feeds[${index}] must be an object`);
    assertOnlyKeys(entry, ['provider', 'url'], `feeds[${index}]`);
    const provider = String(entry.provider ?? '')
      .trim()
      .toLowerCase();
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (url === '') return;
    if (!/^[a-z0-9-]+$/.test(provider)) {
      fail(`feeds[${index}].provider must be a lowercase slug (letters, digits, dashes)`);
    }
    if (provider === MAIN_FEED_PROVIDER) {
      fail(`feeds[${index}].provider is reserved — the site's show is the Main feed field`);
    }
    if (url.length > MAX_URL_LENGTH || /[\s<>"'`\\]/.test(url)) {
      fail(`feeds[${index}].url is not a valid URL`);
    }
    if (mainFeedUrl !== '' && url === mainFeedUrl) {
      fail(`feeds[${index}].url is already the main feed — one feed cannot be both`);
    }
    const row = { provider, url };
    if (!isValidFeedEntry(row)) fail(`feeds[${index}].url must be an https URL`);
    feeds.push(row);
  });

  const deduped = dedupeFeedsByProvider(feeds);
  if (deduped.length !== feeds.length) {
    fail('Each provider may have only one feed');
  }
  return mainFeedUrl === '' ? { feeds: deduped } : { mainFeedUrl, feeds: deduped };
}

// ── podcast voices ─────────────────────────────────────────────────────────

/**
 * `{ Maya, Elena }` → the document every podcast render reads
 * (podcast/voice-settings.js, #725). Both hosts are required, each must look
 * like an ElevenLabs voice id, and the two must differ: a listener has to
 * tell the hosts apart. The value is sent to a paid API as `voice_id`, so it
 * is trimmed and nothing more; a near-miss is refused, not corrected.
 *
 * Whether the plan allows a voice is not checked here, because that is the
 * account's answer and this has no network. The picker offers only voices
 * the listing marks usable, and a render with any other meets ElevenLabs's
 * own 402, whose sentence points back at the picker.
 */
export function normalizePodcastVoices(body) {
  if (!isPlainObject(body)) fail('Body must be a JSON object');
  assertOnlyKeys(body, PODCAST_HOSTS, 'body');
  const voices = {};
  for (const host of PODCAST_HOSTS) {
    const raw = body[host];
    if (typeof raw !== 'string' || raw.trim() === '') {
      fail(`${host} needs a voice: choose one for each host`);
    }
    const id = raw.trim();
    if (!isElevenLabsVoiceId(id)) {
      fail(
        `${host} must be an ElevenLabs voice id, 20 letters and digits as the voice list shows it`
      );
    }
    voices[host] = id;
  }
  if (new Set(Object.values(voices)).size !== PODCAST_HOSTS.length) {
    fail(
      `${PODCAST_HOSTS.join(' and ')} must have different voices, so a listener can tell the hosts apart`
    );
  }
  return voices;
}

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
  return value;
}

// ── the catalogue ──────────────────────────────────────────────────────────

/**
 * Route segment → document. The segment is the only caller-chosen part of the
 * path and it resolves here or 404s before Cosmos is touched, the same
 * pattern admin-integrations.js uses for cms/config/{collection}.
 *
 * `options`, where a spec has it, is what the page may choose from; it rides
 * on the GET and PUT responses beside the value, priced by the server so the
 * card and the queued toast use the same figure. `merge`, where a spec has
 * it, folds the stored document into a PUT's value before the write, for a
 * document another writer also touches.
 */
export const PLATFORM_SETTINGS = Object.freeze({
  'default-heroes': Object.freeze({
    docId: DEFAULT_HEROES_CONFIG_ID,
    normalize: normalizeDefaultHeroes,
    empty: () => ({ heroes: {} }),
  }),
  'social-autopost': Object.freeze({
    docId: AUTOPOST_CONFIG_ID,
    normalize: normalizeSocialAutopost,
    empty: () => ({
      enabled: false,
      accountIds: [],
      scheduleDelayMinutes: DEFAULT_SCHEDULE_DELAY_MINUTES,
    }),
  }),
  'podcast-feeds': Object.freeze({
    docId: PODCAST_FEEDS_CONFIG_ID,
    normalize: normalizePodcastFeeds,
    empty: () => ({ feeds: [] }),
  }),
  'podcast-voices': Object.freeze({
    docId: PODCAST_VOICES_CONFIG_ID,
    normalize: normalizePodcastVoices,
    // Nothing chosen: the code has no default voice (speech/elevenlabs.js),
    // so the page shows both hosts unset and a render says to choose first.
    empty: () => Object.fromEntries(PODCAST_HOSTS.map((host) => [host, ''])),
  }),
  'newsletter-settings': Object.freeze({
    docId: NEWSLETTER_SETTINGS_CONFIG_ID,
    normalize: normalizeNewsletterSettings,
    empty: newsletterSettingsDefaults,
    // Section titles, tones and bounds for the Content form (#557).
    options: newsletterContentOptions,
  }),
  // ADR 0033 §4: what an item becomes and how it became an idea, read by
  // every picker and list that classifies content (lib/cms/taxonomy.js).
  'content-taxonomy': Object.freeze({
    docId: CONTENT_TAXONOMY_CONFIG_ID,
    // The taxonomy module throws its own 400-shaped error so it can be read
    // without this module; re-raised here as the error the PUT handler maps.
    normalize: (body) => {
      try {
        return normalizeContentTaxonomy(body);
      } catch (error) {
        if (error?.status === 400) fail(error.message);
        throw error;
      }
    },
    empty: defaultTaxonomy,
  }),
  // The owner's dated reminders, said on Telegram by the daily sendReminders
  // timer (owner request 2026-10-06). The timer's own stamps round-trip here.
  reminders: Object.freeze({
    docId: REMINDERS_CONFIG_ID,
    normalize: (body) => {
      try {
        return normalizeReminders(body);
      } catch (error) {
        if (error instanceof RemindersValidationError) fail(error.message);
        throw error;
      }
    },
    empty: emptyReminders,
    // The timer stamps `notified` between the page's load and its save; the
    // save keeps those stamps (review of #910). It also carries the
    // credential register's rows through exactly as stored: a save at this
    // page's role cannot add, change or remove one (review of #1039).
    merge: (value, stored) => {
      try {
        return mergeStoredStamps(value, stored);
      } catch (error) {
        if (error instanceof RemindersValidationError) fail(error.message);
        throw error;
      }
    },
  }),
});

export const PLATFORM_SETTING_NAMES = Object.freeze(Object.keys(PLATFORM_SETTINGS));

/**
 * The setting spec for a route segment, or null. An OWN-key lookup: on a
 * plain object, `PLATFORM_SETTINGS['constructor']` is `Object` and
 * `PLATFORM_SETTINGS['__proto__']` is `Object.prototype` — both truthy — so a
 * bracket lookup alone would treat those segments as known settings and
 * carry an undefined docId to Cosmos. Frozen, so nothing can be written
 * through it either; this is the read-side half of that.
 */
export function resolveSetting(name) {
  const key = String(name ?? '');
  return Object.hasOwn(PLATFORM_SETTINGS, key) ? PLATFORM_SETTINGS[key] : null;
}

/** Keys this module writes beside the value; not part of the shape. */
const PRESENTATION_METADATA = new Set(['id', 'configScope', 'updatedAt', 'updatedBy']);
/** Cosmos's own fields, by exact name (the set jobs.js strips too). */
const COSMOS_SYSTEM_FIELDS = new Set(['_rid', '_self', '_etag', '_attachments', '_ts']);

/**
 * What a stored document looks like through this page: the normalized shape
 * when it normalizes, else the empty shape. A hand-seeded document that does
 * not validate is shown empty rather than failing the read — the page's job
 * is to let the owner write a good one, and the consumer will keep reading
 * whatever is there until they do. `stored` says which happened.
 */
export function presentSetting(name, doc) {
  const spec = resolveSetting(name);
  if (!spec) throw new Error(`Unknown platform setting: ${name}`);
  if (!doc) return { value: spec.empty(), exists: false, stored: null, updatedAt: null };
  const updatedAt = doc.updatedAt;
  // A null-prototype object, filled by defineProperty from the document's OWN
  // keys: a hand-seeded document carrying `__proto__` or `constructor` (a
  // JSON.parse'd document holds those as ordinary own keys) becomes an own
  // key here too — never a prototype write — and is then refused by the
  // normalizer as unknown, the same as any other key the shape does not name.
  // Only Cosmos's own system fields are stripped, by exact name; a stray
  // `_foo` is reported, not hidden.
  const candidate = Object.create(null);
  for (const key of Object.keys(doc)) {
    if (PRESENTATION_METADATA.has(key) || COSMOS_SYSTEM_FIELDS.has(key)) continue;
    Object.defineProperty(candidate, key, {
      value: doc[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  try {
    return {
      value: spec.normalize(candidate),
      exists: true,
      stored: 'valid',
      updatedAt: updatedAt ?? null,
    };
  } catch (error) {
    if (error instanceof PlatformSettingValidationError) {
      return {
        value: spec.empty(),
        exists: true,
        stored: 'invalid',
        updatedAt: updatedAt ?? null,
        problem: error.message,
      };
    }
    throw error;
  }
}

// ── change history ─────────────────────────────────────────────────────────

/** The audit action every successful PUT writes. */
export const PLATFORM_SETTING_AUDIT_ACTION = 'platform_setting_updated';
export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 100;

/** A timestamp as the audit writer stores it: `Date#toISOString()`. */
// Exactly Date#toISOString()'s shape, milliseconds included: the cursor is
// compared as a string against stored `.sssZ` timestamps, so any other shape
// would sort differently and skip or repeat rows.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * `?setting=&limit=&after=` → `{ setting, limit, after }` or `{ error }`.
 * Every refusal happens here, before the store is touched: `setting` must be
 * a name in the spec registry (an own key, so `constructor` is refused like
 * any typo), `limit` a whole number 1..100 when given, and `after` an ISO
 * timestamp of the shape the audit writer stores.
 */
export function parseHistoryQuery(query) {
  const get = (key) => {
    const raw = query?.get?.(key);
    return raw === null || raw === undefined ? '' : String(raw).trim();
  };
  const setting = get('setting');
  if (setting !== '' && !resolveSetting(setting)) {
    return { error: `setting must be one of ${PLATFORM_SETTING_NAMES.join(', ')}` };
  }
  const limitRaw = get('limit');
  let limit = HISTORY_DEFAULT_LIMIT;
  if (limitRaw !== '') {
    limit = /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT) {
      return { error: `limit must be a whole number from 1 to ${HISTORY_MAX_LIMIT}` };
    }
  }
  const after = get('after');
  if (after !== '' && (!ISO_TIMESTAMP.test(after) || !Number.isFinite(Date.parse(after)))) {
    return { error: 'after must be an ISO timestamp such as 2026-09-14T12:00:00.000Z' };
  }
  return { setting: setting || null, limit, after: after || null };
}

/**
 * Who made a change, as the row stored it: the display name when the row has
 * one, else the Entra object id. Never the email — the row carries
 * `userEmail`, and this view has no need of it — and never anything shaped
 * like one, since a display name can be an address for an account that never
 * set a name.
 */
function actorOf(row) {
  for (const candidate of [row.userName, row.userId]) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed !== '' && !trimmed.includes('@')) return trimmed;
  }
  return null;
}

const isSummaryScalar = (value) =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

/**
 * One audit row → `{ id, at, actor, setting, summary }`, and nothing else.
 * `summary` is the recorded details minus `setting`, limited to scalars and
 * lists of scalars — which is all `summarize` writes — so a hand-written row
 * with a nested object cannot carry more than the table shows.
 */
export function presentHistoryEntry(row) {
  const details = isPlainObject(row?.details) ? row.details : {};
  const summary = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === 'setting') continue;
    if (isSummaryScalar(value)) summary[key] = value;
    else if (Array.isArray(value) && value.every(isSummaryScalar)) summary[key] = [...value];
  }
  return {
    id: String(row?.id ?? ''),
    at: typeof row?.timestamp === 'string' ? row.timestamp : null,
    actor: actorOf(row ?? {}),
    setting: typeof details.setting === 'string' ? details.setting : null,
    summary,
  };
}

/**
 * The history query. `action` and `timestamp` are both indexed on
 * `admin_audit_logs` (scripts/generate-cosmos-container-spec.mjs), so the
 * action is an index seek and the order and the `after` cursor use the range
 * index. `details.setting` is not indexed; it is evaluated only over the rows
 * the action already matched, which is a few per save.
 *
 * Paging is by timestamp: `after` is the `at` of the last row a page returned,
 * and the next page is the rows strictly older. Two saves in the same
 * millisecond could straddle a page boundary and one would be skipped, which
 * for a person clicking Save is not a case that arises.
 */
export function buildHistoryQuery({ setting, limit, after }) {
  const where = ['c.action = @action'];
  const parameters = [
    { name: '@limit', value: limit },
    { name: '@action', value: PLATFORM_SETTING_AUDIT_ACTION },
  ];
  if (setting) {
    where.push('c.details.setting = @setting');
    parameters.push({ name: '@setting', value: setting });
  }
  if (after) {
    where.push('c.timestamp < @after');
    parameters.push({ name: '@after', value: after });
  }
  return {
    query: `SELECT TOP @limit c.id, c.timestamp, c.userId, c.userName, c.details FROM c WHERE ${where.join(' AND ')} ORDER BY c.timestamp DESC`,
    parameters,
  };
}

/**
 * What the audit row records for each setting: counts and ids, never
 * contents. A setting not listed here records nothing beyond its name.
 */
const AUDIT_SUMMARIES = Object.freeze({
  'default-heroes': (value) => ({ providers: Object.keys(value.heroes).length }),
  'social-autopost': (value) => ({
    enabled: value.enabled,
    accounts: value.accountIds.length,
    scheduleDelayMinutes: value.scheduleDelayMinutes,
  }),
  // Whether a main feed is set, never which one: the audit row records
  // counts, and a URL is content.
  'podcast-feeds': (value) => ({ feeds: value.feeds.length, mainFeed: Boolean(value.mainFeedUrl) }),
  // Ids are settings; labels and descriptions are content, so only
  // which entries exist and which are on is recorded.
  'content-taxonomy': (value) => ({
    kinds: value.kinds.length,
    kindsEnabled: value.kinds.filter((k) => k.enabled).map((k) => k.id),
    ideaOrigins: value.ideaOrigins.length,
    ideaOriginsEnabled: value.ideaOrigins.filter((o) => o.enabled).map((o) => o.id),
  }),
  // Voice ids are settings, not content, and which ones were chosen is
  // the point of the row: a change of voice is what a listener hears.
  'podcast-voices': (value) => ({ ...value }),
  // Whether each is set, never the address or the inbox: those are
  // personal details, and the audit row records settings, not content.
  'newsletter-settings': (value) => ({
    postalAddress: Boolean(value.postalAddress),
    replyTo: Boolean(value.replyTo),
    sendDay: value.sendDay,
    sendTime: value.sendTime,
    timeZone: value.timeZone,
    sections: value.sections.filter((entry) => entry.enabled).map((entry) => entry.id),
    windowDays: value.windowDays,
    introEnabled: value.introEnabled,
    introTone: value.introTone,
    // Where the box shows is a setting; its wording is content, so only
    // whether it differs from the default is recorded.
    signupPlacement: value.signupPlacement,
    signupHeadingCustom: value.signupHeading !== DEFAULT_NEWSLETTER_SETTINGS.signupHeading,
    signupBlurbCustom: value.signupBlurb !== DEFAULT_NEWSLETTER_SETTINGS.signupBlurb,
    // An id, not content: which design the email uses.
    templateId: value.templateId || null,
  }),
  // Counts and the next date; titles and notes are content.
  reminders: summarizeReminders,
});

/** What the audit row records: counts, never contents. */
const summarize = (name, value) => AUDIT_SUMMARIES[name]?.(value) ?? {};

/** What a spec offers to choose from, or nothing. */
const optionsFor = (spec) =>
  typeof spec.options === 'function' ? { options: spec.options() } : {};

/**
 * The audit details as a log line may carry them: the row may keep the
 * template id, telemetry says only whether a template is chosen.
 */
const auditDetailsForLog = (details) =>
  details.templateId === undefined
    ? details
    : { ...details, templateId: details.templateId ? '[set]' : null };

/**
 * A PUT body as the value the setting stores, or the 400 refusing it: not a
 * JSON object (or past MAX_BODY_JSON), then whatever the spec's normalizer
 * refuses. Any other error the normalizer throws is the handler's 500.
 */
function normalizedSettingValue(spec, body) {
  if (!isPlainObject(body) || JSON.stringify(body).length > MAX_BODY_JSON) {
    return { error: json(400, { error: 'Body must be a JSON object' }) };
  }
  try {
    return { value: spec.normalize(body) };
  } catch (error) {
    if (error instanceof PlatformSettingValidationError) {
      return { error: json(400, { error: error.message }) };
    }
    throw error;
  }
}

/**
 * GET /api/cms/platform-settings/history?setting=&limit=&after=
 *
 * The `platform_setting_updated` audit rows, newest first. Editor, the same
 * as reading a setting. The response carries `{ id, at, actor, setting,
 * summary }` per row and `nextAfter` when a full page came back; the log
 * line on failure names no query value.
 */
async function getHistory({ guard, store }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const parsed = parseHistoryQuery(request.query);
  if (parsed.error) return json(400, { error: parsed.error });
  try {
    const { query, parameters } = buildHistoryQuery(parsed);
    const rows = await store.queryDocs('admin_audit_logs', query, parameters);
    const entries = (rows ?? []).slice(0, parsed.limit).map(presentHistoryEntry);
    const last = entries.at(-1);
    return json(200, {
      success: true,
      entries,
      nextAfter: entries.length === parsed.limit && last?.at ? last.at : null,
    });
  } catch (error) {
    context.error(`getPlatformSettingHistory failed: ${error?.message || error}`);
    return json(500, { error: 'Failed to read platform settings history' });
  }
}

/** How many times a merged save re-reads after a conflicting write before answering 409. */
export const MERGE_WRITE_ATTEMPTS = 3;

/** 412: replaced since the read. 409: created since a read that found nothing. */
const isWriteConflict = (error) => {
  const status = error?.code ?? error?.statusCode;
  return status === 412 || status === 409;
};

/**
 * The entity-tags an If-Match header names (#946), or null when there is no
 * header. `*` comes back as `['*']`. Weak tags are dropped: If-Match uses the
 * strong comparison (RFC 9110 §13.1.1), so `W/"…"` can never match, and a
 * header naming nothing else matches nothing.
 *
 * @param {string|null|undefined} header the raw If-Match value
 * @returns {string[]|null}
 */
export function parseIfMatch(header) {
  const raw = String(header ?? '').trim();
  if (!raw) return null;
  if (raw === '*') return ['*'];
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag && !tag.startsWith('W/'));
}

/**
 * Whether the stored document is a version the If-Match tags name: any stored
 * document for `*`, else the one whose `_etag` is listed. When nothing is
 * stored, no If-Match is satisfied, `*` included.
 *
 * @param {string[]} tags from parseIfMatch
 * @param {object|null} stored the document as read, `_etag` included
 * @returns {boolean}
 */
export function satisfiesIfMatch(tags, stored) {
  if (!stored) return false;
  if (tags.includes('*')) return true;
  return Boolean(stored._etag) && tags.includes(stored._etag);
}

/** The 412 for a save naming a version that is no longer stored. Nothing was written. */
const settingChanged = () =>
  json(412, {
    code: 'CONFLICT',
    error:
      'This setting was saved somewhere else since this page loaded it. Nothing was saved; reload it to see what is stored now.',
  });

/** The 428 for a save that would replace a stored document without naming its version. */
const versionRequired = () =>
  json(428, {
    code: 'PRECONDITION_REQUIRED',
    error:
      'This setting is already stored, and the save did not say which version it replaces. Nothing was saved; reload the page and save again.',
  });

/**
 * The Platform settings routes' handlers: read a setting, save it, and read
 * the change history.
 *
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function, replaceDocIfMatch: Function, createDoc: Function, queryDocs?: Function }} deps.store
 *        a setting with a merge (the reminders sheet) is written under the
 *        ETag of the read it was merged from; every other setting is written
 *        under the version the save's If-Match names (replaceDocIfMatch), or
 *        created when it names none (createDoc). No setting is upserted: an
 *        upsert is the unconditional overwrite #946 removed. upsertDoc writes
 *        the audit rows only.
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {{ select: Function }} [deps.templateCache] the newsletter template cache (template-source.js)
 * @returns {{ getHistory: Function, getSetting: Function, putSetting: Function }}
 */
export function createPlatformSettingsHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
  templateCache = sharedTemplateCache,
}) {
  const resolve = (request) => resolveSetting(request.params?.setting);

  /**
   * Save a setting whose value is decided from the stored document (the
   * reminders sheet: the timer's stamps and the credential register's rows
   * come from the stored copy). The write is guarded by the ETag of the read
   * it was merged from, so a sync or a timer stamp that lands in between is
   * never written over: a 412 (replaced since the read) or 409 (created since
   * an absent read) re-reads and re-merges, up to MERGE_WRITE_ATTEMPTS times,
   * then answers 409 (CodeRabbit, review of #1039).
   *
   * The page does not send If-Match here, and the read does not offer an ETag
   * for this setting: the writers expected between the page's load and its
   * save are the timer and the register sync, whose fields the merge keeps, so
   * a version check would refuse saves the merge makes safe (review of #910).
   * A caller that does name a version gets exactly that version or a 412,
   * with no re-read: a retry would apply the save to a version it did not
   * name (#946).
   *
   * @param {object} spec the setting's registry entry, with `merge`
   * @param {object} requested the normalized value the caller sent
   * @param {{ updatedAt: string, updatedBy: string|null }} meta
   * @param {string[]|null} tags the If-Match tags, or null for none
   * @returns {Promise<{ value: object } | { error: object }>} the value
   *   written, or the response refusing the save
   */
  async function writeMerged(spec, requested, meta, tags) {
    const attempts = tags ? 1 : MERGE_WRITE_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const stored = await store.readDoc('admin_config', spec.docId, ADMIN_CONFIG_PARTITION);
      if (tags && !satisfiesIfMatch(tags, stored)) return { error: settingChanged() };
      let value;
      // A merge that refuses (the reminders sheet past its limit once the
      // register's rows are counted) is the caller's 400, like a
      // normalizer's refusal, never a 500.
      try {
        value = spec.merge(requested, stored);
      } catch (error) {
        if (error instanceof PlatformSettingValidationError) {
          return { error: json(400, { error: error.message }) };
        }
        throw error;
      }
      const doc = { id: spec.docId, configScope: ADMIN_CONFIG_PARTITION, ...value, ...meta };
      try {
        if (stored) {
          await store.replaceDocIfMatch(
            'admin_config',
            { ...doc, _etag: stored._etag },
            { partitionKey: ADMIN_CONFIG_PARTITION }
          );
        } else {
          await store.createDoc('admin_config', doc);
        }
        return { value };
      } catch (error) {
        if (!isWriteConflict(error)) throw error;
        if (tags) return { error: settingChanged() };
      }
    }
    return {
      error: json(409, {
        error: 'This setting changed while it was being saved. Reload the page and save again.',
      }),
    };
  }

  /**
   * Save a setting whose value is the caller's alone, conditioned on the
   * version the caller read (#946).
   *
   * With If-Match, the stored document must be a version it names, and the
   * replace is conditional on that document's ETag, so a save from a page
   * that loaded an older version is a 412 whether the other write landed
   * before this read or between this read and the replace.
   *
   * Without If-Match, the save may only create: the caller is saying nothing
   * was stored when it read. If a document exists by the time it writes, the
   * create's 409 becomes a 428, because the caller has not said which version
   * it would replace. That is what makes the precondition required: no
   * request can overwrite a stored setting without naming the version it
   * read.
   *
   * @param {object} spec the setting's registry entry
   * @param {object} value the normalized value to store
   * @param {{ updatedAt: string, updatedBy: string|null }} meta
   * @param {string[]|null} tags the If-Match tags, or null for none
   * @returns {Promise<{ written: object|null } | { error: object }>} the
   *   document as written (its `_etag` the next save's If-Match), or the
   *   response refusing the save
   */
  async function writeConditional(spec, value, meta, tags) {
    const doc = { id: spec.docId, configScope: ADMIN_CONFIG_PARTITION, ...value, ...meta };
    try {
      if (!tags) return { written: await store.createDoc('admin_config', doc) };
      const stored = await store.readDoc('admin_config', spec.docId, ADMIN_CONFIG_PARTITION);
      if (!satisfiesIfMatch(tags, stored)) return { error: settingChanged() };
      const written = await store.replaceDocIfMatch(
        'admin_config',
        { ...doc, _etag: stored._etag },
        { partitionKey: ADMIN_CONFIG_PARTITION }
      );
      return { written };
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
      return { error: tags ? settingChanged() : versionRequired() };
    }
  }

  async function audit(action, user, details) {
    await store.upsertDoc('admin_audit_logs', {
      id: uuid(),
      action,
      userId: user?.oid || user?.sub || null,
      // The display name, so the Change history tab can say who without
      // showing the email. Rows written before this field existed show the id.
      userName: user?.name || null,
      userEmail: user?.email || user?.preferred_username || null,
      timestamp: now().toISOString(),
      details,
    });
  }

  const history = (request, context) => getHistory({ guard, store }, request, context);

  return {
    getHistory: history,

    /** GET /api/cms/platform-settings/{setting} */
    async getSetting(request, context) {
      // `history` has its own literal route, but the host's choice between a
      // literal and this template is not guaranteed (platform-settings-http.js),
      // so the segment reaches the history reader from here too. No setting
      // is named `history`.
      if (request.params?.setting === 'history') return history(request, context);
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const name = String(request.params?.setting || '');
      const spec = resolve(request);
      if (!spec) return json(404, { error: 'Unknown platform setting' });
      try {
        const doc = await store.readDoc('admin_config', spec.docId, ADMIN_CONFIG_PARTITION);
        // The version the page's save names in If-Match (#946): null when
        // nothing is stored (the save creates), and null for a merged setting,
        // whose save is guarded by its own read (writeMerged).
        const etag = spec.merge ? null : (doc?._etag ?? null);
        return json(
          200,
          {
            success: true,
            setting: name,
            ...presentSetting(name, doc),
            etag,
            ...optionsFor(spec),
          },
          etag
        );
      } catch (error) {
        context.error(`getPlatformSetting(${name}) failed:`, error);
        return json(500, { error: 'Failed to read platform setting' });
      }
    },

    /**
     * PUT /api/cms/platform-settings/{setting} — body is the value itself;
     * If-Match names the version it replaces (#946). Answers the stored value
     * and its new ETag, which the next save from the same page names; 412
     * when the named version is no longer stored, 428 when a stored document
     * would be replaced without naming one.
     */
    async putSetting(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const name = String(request.params?.setting || '');
      const spec = resolve(request);
      if (!spec) return json(404, { error: 'Unknown platform setting' });

      const parsed = normalizedSettingValue(spec, await request.json().catch(() => null));
      if (parsed.error) return parsed.error;
      let { value } = parsed;
      const tags = parseIfMatch(request.headers?.get?.('if-match'));

      try {
        const updatedAt = now().toISOString();
        const meta = { updatedAt, updatedBy: auth.user?.oid || auth.user?.sub || null };
        let etag = null;
        if (spec.merge) {
          const merged = await writeMerged(spec, value, meta, tags);
          if (merged.error) return merged.error;
          ({ value } = merged);
        } else {
          const result = await writeConditional(spec, value, meta, tags);
          if (result.error) return result.error;
          etag = result.written?._etag ?? null;
        }
        // A different newsletter template takes effect on the next preview,
        // not when the cached copy of the previous one expires.
        if (name === 'newsletter-settings') templateCache.select(value.templateId);
        // Best effort, like forge-stats bumps: the setting is already saved,
        // so a failed audit row must not turn into a 500 that makes the page
        // report a failure (and the owner retry) for a write that took.
        const details = { setting: name, ...summarize(name, value) };
        try {
          await audit(PLATFORM_SETTING_AUDIT_ACTION, auth.user, details);
        } catch (auditError) {
          context.warn?.(
            `putPlatformSetting(${name}) saved but the audit row failed (${JSON.stringify(auditDetailsForLog(details))}): ${auditError?.message || auditError}`
          );
        }
        return json(
          200,
          {
            success: true,
            setting: name,
            value,
            exists: true,
            stored: 'valid',
            updatedAt,
            etag,
            ...optionsFor(spec),
          },
          etag
        );
      } catch (error) {
        context.error(`putPlatformSetting(${name}) failed:`, error);
        return json(500, { error: 'Failed to save platform setting' });
      }
    },
  };
}
