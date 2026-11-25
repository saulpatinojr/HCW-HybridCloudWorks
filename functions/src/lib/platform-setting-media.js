/**
 * platform-setting-media.js — the normalizers of the media settings on the
 * Platform Settings hub: default heroes, social autopost, podcast feeds and
 * podcast voices. Each turns a PUT body into the stored document or throws
 * PlatformSettingValidationError naming the field. platform-settings.js
 * re-exports the public names.
 */
import {
  fail,
  isPlainObject,
  assertOnlyKeys,
  MAX_URL_LENGTH,
} from './platform-setting-checks.js';

export {
  PODCAST_PROVIDERS,
  normalizePodcastFeeds,
  normalizePodcastVoices,
} from './platform-setting-podcast.js';

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
