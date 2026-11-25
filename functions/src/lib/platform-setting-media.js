/**
 * platform-setting-media.js — the normalizers of the media settings on the
 * Platform Settings hub: default heroes, social autopost, podcast feeds and
 * podcast voices. Each turns a PUT body into the stored document or throws
 * PlatformSettingValidationError naming the field. platform-settings.js
 * re-exports the public names.
 */
import { MAIN_FEED_PROVIDER, dedupeFeedsByProvider, isValidFeedEntry } from './timers/podcasts.js';
import { isElevenLabsVoiceId } from './listen-and-learn/speech/elevenlabs-voice-plan.js';
import { PODCAST_HOSTS } from './podcast/voice-settings.js';
import { fail, isPlainObject, assertOnlyKeys, MAX_URL_LENGTH } from './platform-setting-checks.js';

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
    const { canonical, value } = heroEntry(rawKey, rawValue);
    if (!value) continue;
    if (canonical in out) fail(`heroes.${canonical} given more than once`);
    out[canonical] = value;
  }
  return { heroes: out };
}

/** One `heroes` entry: its canonical provider, and its URL ('' or null for none). */
function heroEntry(rawKey, rawValue) {
  const canonical = HERO_PROVIDERS.find((p) => p.toLowerCase() === String(rawKey).toLowerCase());
  if (!canonical) {
    fail(`Unknown hero provider "${rawKey}". Allowed: ${HERO_PROVIDERS.join(', ')}`);
  }
  if (rawValue === null || rawValue === undefined) return { canonical, value: null };
  if (typeof rawValue !== 'string') fail(`heroes.${canonical} must be a string`);
  const value = rawValue.trim();
  if (value !== '' && !isAcceptableHeroUrl(value)) {
    fail(
      `heroes.${canonical} must be a same-origin path (/images/… or /api/public/media/…) or an https URL, with no query string or fragment`
    );
  }
  return { canonical, value };
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
    const account = socialAccount(entry, index);
    if (seen.has(account.id)) return;
    seen.add(account.id);
    accountIds.push(account);
  });

  if (enabled && accountIds.length === 0) {
    fail('Add at least one account before enabling autoposting');
  }

  return { enabled, accountIds, scheduleDelayMinutes: delay };
}

/** One `accountIds` entry, checked: `{ id, provider }`. */
function socialAccount(entry, index) {
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
  return { id, provider };
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

  const mainFeedUrl = mainFeedUrlOf(body.mainFeedUrl ?? '');

  const feedsRaw = body.feeds ?? [];
  if (!Array.isArray(feedsRaw)) fail('feeds must be an array of { provider, url }');
  if (feedsRaw.length > MAX_FEEDS) fail(`feeds may hold at most ${MAX_FEEDS} entries`);

  const feeds = feedsRaw.map((entry, index) => feedRow(entry, index, mainFeedUrl)).filter(Boolean);

  const deduped = dedupeFeedsByProvider(feeds);
  if (deduped.length !== feeds.length) {
    fail('Each provider may have only one feed');
  }
  return mainFeedUrl === '' ? { feeds: deduped } : { mainFeedUrl, feeds: deduped };
}

/** A URL a feed may name: within the length cap and free of spaces, quotes and angle brackets. */
const isPlainFeedUrl = (url) => url.length <= MAX_URL_LENGTH && !/[\s<>"'`\\]/.test(url);

/** The main feed URL, trimmed and checked; '' when the site has no show yet. */
function mainFeedUrlOf(mainRaw) {
  if (typeof mainRaw !== 'string') fail('mainFeedUrl must be a string');
  const mainFeedUrl = mainRaw.trim();
  if (mainFeedUrl === '') return mainFeedUrl;
  if (!isPlainFeedUrl(mainFeedUrl)) fail('mainFeedUrl is not a valid URL');
  if (!isValidFeedEntry({ provider: MAIN_FEED_PROVIDER, url: mainFeedUrl })) {
    fail('mainFeedUrl must be an https URL');
  }
  return mainFeedUrl;
}

/** One `feeds` row, checked: `{ provider, url }`, or null for a row with no URL. */
function feedRow(entry, index, mainFeedUrl) {
  if (!isPlainObject(entry)) fail(`feeds[${index}] must be an object`);
  assertOnlyKeys(entry, ['provider', 'url'], `feeds[${index}]`);
  const provider = String(entry.provider ?? '')
    .trim()
    .toLowerCase();
  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (url === '') return null;
  if (!/^[a-z0-9-]+$/.test(provider)) {
    fail(`feeds[${index}].provider must be a lowercase slug (letters, digits, dashes)`);
  }
  if (provider === MAIN_FEED_PROVIDER) {
    fail(`feeds[${index}].provider is reserved — the site's show is the Main feed field`);
  }
  if (!isPlainFeedUrl(url)) fail(`feeds[${index}].url is not a valid URL`);
  if (mainFeedUrl !== '' && url === mainFeedUrl) {
    fail(`feeds[${index}].url is already the main feed — one feed cannot be both`);
  }
  const row = { provider, url };
  if (!isValidFeedEntry(row)) fail(`feeds[${index}].url must be an https URL`);
  return row;
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
