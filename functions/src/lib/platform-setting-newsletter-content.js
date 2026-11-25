/**
 * platform-setting-newsletter-content.js — the newsletter's content fields
 * (#557): the ordered section list, the window and the intro.
 * platform-setting-newsletter.js applies them with the other fields.
 */
import {
  INTRO_TONE_IDS,
  MAX_SECTION_ITEMS,
  MAX_WINDOW_DAYS,
  MIN_SECTION_ITEMS,
  MIN_WINDOW_DAYS,
} from './newsletter/settings.js';
import { MAX_ITEMS_PER_SECTION, SECTIONS } from './newsletter/sections.js';
import { fail, isPlainObject, assertOnlyKeys } from './platform-setting-checks.js';

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
    seen.add(entry.id);
    out.push(sectionRow(entry, index));
  });
  for (const id of known) {
    if (!seen.has(id)) out.push({ id, enabled: true, maxItems: MAX_ITEMS_PER_SECTION });
  }
  if (!out.some((entry) => entry.enabled)) fail('Turn on at least one section');
  return out;
}

/** One kept section row, checked: `{ id, enabled, maxItems }`. */
function sectionRow(entry, index) {
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
  return { id: entry.id, enabled, maxItems };
}

/** The content fields (#557): sections, windowDays, introEnabled, introTone. */
export function normalizeNewsletterContent(body, value) {
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
