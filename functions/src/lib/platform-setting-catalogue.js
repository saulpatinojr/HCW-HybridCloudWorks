/**
 * platform-setting-catalogue.js — the settings the Platform Settings hub
 * edits: each route segment's document, normalizer, empty shape, options and
 * merge. platform-settings.js serves them and re-exports these names.
 */
import { DEFAULT_HEROES_CONFIG_ID } from './triggers/ai-cover.js';
import { AUTOPOST_CONFIG_ID } from './triggers/social-caption-trigger.js';
import { PODCAST_FEEDS_CONFIG_ID } from './timers/podcasts.js';
import { PODCAST_HOSTS, PODCAST_VOICES_CONFIG_ID } from './podcast/voice-settings.js';
import { NEWSLETTER_SETTINGS_CONFIG_ID, newsletterContentOptions, newsletterSettingsDefaults } from './newsletter/settings.js';
import { CONTENT_TAXONOMY_CONFIG_ID, defaultTaxonomy, normalizeContentTaxonomy } from './cms/taxonomy.js';
import {
  REMINDERS_CONFIG_ID,
  emptyReminders,
  mergeStoredStamps,
  normalizeReminders,
} from './reminders/settings.js';
import {
  DEFAULT_SCHEDULE_DELAY_MINUTES,
  normalizeDefaultHeroes,
  normalizePodcastFeeds,
  normalizePodcastVoices,
  normalizeSocialAutopost,
} from './platform-setting-media.js';
import { normalizeNewsletterSettings } from './platform-setting-newsletter.js';

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
    // The taxonomy module throws its own authored error so it can be read
    // without this module; the PUT handler maps any authored error to a 400.
    normalize: (body) => normalizeContentTaxonomy(body),
    empty: defaultTaxonomy,
  }),
  // The owner's dated reminders, said on Telegram by the daily sendReminders
  // timer (owner request 2026-10-06). The timer's own stamps round-trip here.
  reminders: Object.freeze({
    docId: REMINDERS_CONFIG_ID,
    // RemindersValidationError is authored, so it reaches the handler's 400 as is.
    normalize: (body) => normalizeReminders(body),
    empty: emptyReminders,
    // The timer stamps `notified` between the page's load and its save; the
    // save keeps those stamps (review of #910). It also carries the
    // credential register's rows through exactly as stored: a save at this
    // page's role cannot add, change or remove one (review of #1039).
    merge: (value, stored) => mergeStoredStamps(value, stored),
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
