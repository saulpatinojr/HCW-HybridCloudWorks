/**
 * The owner's voice, editable (Blog Machine T-604, the T-409 remainder):
 * getForgeConfig and updateForgeConfig over `admin_config/forge_profile`
 * and `admin_config/forge_prompts` (PR #841 split of forge-studio.js).
 *
 * updateForgeConfig is a whitelist-validated partial update of either
 * document. The whitelist is the normalizers the PIPELINE already trusts
 * (normalizeProfile / normalizePrompts), so nothing can be stored that the
 * forge would not read back the same way. Audited.
 *
 * Cache note: the pipeline's config loader caches for 5 minutes per process.
 * An update clears the cache in THIS process; other warm workers converge
 * within the TTL, which is acceptable for voice configuration and is the
 * same staleness the manual-Cosmos-seeding era had.
 */
import { ADMIN_CONFIG_PARTITION } from '../../cosmos-client.js';
import { failureFields } from '../../http/error-response.js';
import { actorName as nameActor } from '../../auth/actor-name.js';
import { normalizeProfile, normalizePrompts } from '../forge-config.js';
import { FORMAT_LIBRARY } from '../voice.js';

export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const actorName = (user) => nameActor(user, 'editor');

/** The only fields an update may carry, per document. Anything else in the
 * request body is dropped, not stored — the difference between a whitelist
 * and a denylist is what happens to the field nobody thought of. */
const PROFILE_FIELDS = ['certifications', 'speakingTopics', 'interestAreas', 'wordSoup'];
const PROMPT_FIELDS = [
  'masterPrompt',
  'extraBannedPhrases',
  'styleRules',
  'publishThreshold',
  'autoForge',
];

export const MAX_WORD_SOUP_CHARS = 20000;
export const MAX_SUGGESTIONS = 20;

/** Calibration output, sanitized: short strings only, capped counts. */
export function normalizeSuggestions(raw = {}) {
  const list = (value, maxLen) =>
    (Array.isArray(value) ? value : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .map((entry) => entry.slice(0, maxLen))
      .slice(0, MAX_SUGGESTIONS);
  return {
    generatedAt: String(raw.generatedAt || ''),
    postCount: Math.max(0, Number(raw.postCount) || 0),
    wordSoupAdditions: list(raw.wordSoupAdditions, 300),
    styleHints: list(raw.styleHints, 300),
    recurringPhrases: list(raw.recurringPhrases, 120),
  };
}

const readConfigDoc = (store, id) => store.readDoc('admin_config', id, ADMIN_CONFIG_PARTITION);

/** `current` with every whitelisted field the body names; the names changed. */
function mergeFields(current, incoming, fields, changed) {
  const merged = { ...current };
  for (const field of fields) {
    if (field in incoming) {
      merged[field] = incoming[field];
      changed.push(field);
    }
  }
  return merged;
}

/**
 * The profile as the body edits it: the whitelisted fields, the word soup
 * bounded, and the calibration suggestions trimmed or cleared — accepting
 * or dismissing chips trims the list; the job is the only writer that ever
 * grows it.
 */
function mergedProfile(current, body, changed) {
  const merged = mergeFields(current, body.profile, PROFILE_FIELDS, changed);
  if ('wordSoup' in body.profile) {
    merged.wordSoup = String(body.profile.wordSoup || '').slice(0, MAX_WORD_SOUP_CHARS);
  }
  if (body.clearSuggestions === true) {
    merged.suggestions = null;
    changed.push('suggestions:cleared');
  } else if (Array.isArray(body.profile.suggestionsKept)) {
    merged.suggestions = normalizeSuggestions({
      ...(current.suggestions || {}),
      wordSoupAdditions: body.profile.suggestionsKept,
    });
    changed.push('suggestions:trimmed');
  }
  return merged;
}

async function writeProfile({ store, now }, body, user, changed) {
  const current = (await readConfigDoc(store, 'forge_profile')) || {};
  const merged = mergedProfile(current, body, changed);
  const normalized = normalizeProfile(merged);
  // merged.suggestions is authoritative here: it starts as the current
  // value and clearSuggestions sets it to null DELIBERATELY, so no
  // nullish fallback to the old value.
  await store.upsertDoc('admin_config', {
    ...current,
    ...normalized,
    suggestions: 'suggestions' in merged ? merged.suggestions : null,
    id: 'forge_profile',
    configScope: ADMIN_CONFIG_PARTITION,
    updatedAt: now().toISOString(),
    updatedBy: actorName(user),
  });
}

async function writePrompts({ store, now }, body, user, changed) {
  const current = (await readConfigDoc(store, 'forge_prompts')) || {};
  const merged = mergeFields(current, body.prompts, PROMPT_FIELDS, changed);
  const normalized = normalizePrompts(merged);
  normalized.version = (Number(current.version) || 0) + 1;
  await store.upsertDoc('admin_config', {
    ...current,
    ...normalized,
    id: 'forge_prompts',
    configScope: ADMIN_CONFIG_PARTITION,
    updatedAt: now().toISOString(),
    updatedBy: actorName(user),
  });
}

async function audit({ store, now, uuid }, action, user, details) {
  await store.upsertDoc('admin_audit_logs', {
    id: uuid(),
    action,
    userId: user?.oid || user?.sub || null,
    userEmail: user?.email || user?.preferred_username || null,
    timestamp: now().toISOString(),
    details,
  });
}

const isObject = (value) => Boolean(value) && typeof value === 'object';

/** GET/POST /api/getForgeConfig */
async function getForgeConfig({ guard, store }, request) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;

  const [profileRaw, promptsRaw, statsRaw] = await Promise.all([
    readConfigDoc(store, 'forge_profile').catch(() => null),
    readConfigDoc(store, 'forge_prompts').catch(() => null),
    readConfigDoc(store, 'forge_stats').catch(() => null),
  ]);

  return json(200, {
    ok: true,
    profile: normalizeProfile(profileRaw || {}),
    suggestions: normalizeSuggestions(profileRaw?.suggestions || {}),
    prompts: normalizePrompts(promptsRaw || {}),
    // Read-only context: what the rotation can pick, and what it has done.
    formats: FORMAT_LIBRARY.map((format) => ({
      key: format.key,
      label: format.label,
      wordRange: format.wordRange,
    })),
    stats: {
      totals: statsRaw?.totals || {},
      formats: statsRaw?.formats || {},
      // The rolling day bucket (forge.js bumpForgeStats) — the queue page's
      // forged-today n/dailyLimit indicator reads it (T-607).
      today: statsRaw?.today || null,
      updatedAt: statsRaw?.updatedAt || null,
    },
  });
}

/** POST /api/updateForgeConfig — { profile?, prompts?, clearSuggestions? } */
async function updateForgeConfig(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!isObject(body) || (!body.profile && !body.prompts)) {
    return json(400, {
      ok: false,
      error: 'Provide profile and/or prompts fields to update.',
    });
  }
  const changed = { profile: [], prompts: [] };
  try {
    if (isObject(body.profile)) await writeProfile(ctx, body, auth.user, changed.profile);
    if (isObject(body.prompts)) await writePrompts(ctx, body, auth.user, changed.prompts);
  } catch (error) {
    return json(502, failureFields(context, 'The Forge configuration could not be saved.', error));
  }

  ctx.config?.clearForgeConfigCache?.();
  await audit(ctx, 'forge_config_updated', auth.user, changed).catch(() => {});
  return getForgeConfig(ctx, request);
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function }} deps.store
 * @param {{ clearForgeConfigCache: Function }} [deps.config] the pipeline's
 *   loader, so an update takes effect in this process immediately
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createForgeStudioHandlers({
  guard,
  store,
  config = null,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
}) {
  const ctx = { guard, store, config, now, uuid };
  return {
    getForgeConfig: (request) => getForgeConfig(ctx, request),
    updateForgeConfig: (request, context) => updateForgeConfig(ctx, request, context),
  };
}
