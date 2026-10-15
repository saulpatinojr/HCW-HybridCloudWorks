/**
 * Update-payload validation for updateContentItem — pure, no I/O.
 *
 * Ported verbatim from Site-Main cms-functions.js (:767-1040): the assertion
 * helpers, the protected-field denylist, the per-field-type normalizers, and
 * validateAndNormalizeUpdateContentItemUpdates itself. This layer is the only
 * thing standing between an authenticated editor's arbitrary JSON and the
 * content document, so its rules are carried exactly:
 *
 *   - Workflow state (contentStatus, Live, approvedForNews, review*) and
 *     backend-owned identity/timestamps are FORBIDDEN — the transition
 *     handler is the state machine's single writer.
 *   - slug/Slug are FORBIDDEN too, added here rather than ported: the site
 *     URL's single writer is POST cms/content/slug (#400). See the note on
 *     the denylist itself for what this route did with a slug before that.
 *   - Field-name and payload-size ceilings (80 fields, 120-char names,
 *     12k/120k string caps, 500-item arrays, 120k JSON payloads).
 *   - Dual-casing fields (title/Title, summary/Summary, tags/Tags,
 *     cloudProvider/'Cloud Provider') are always written as a pair so the
 *     legacy readers and the new readers never diverge.
 *
 * One serialization note rather than adaptation: date-like fields normalize to
 * Date instances exactly as the source did; Cosmos JSON-serializes a Date to
 * its ISO string on write, which is the same shape the migration writes.
 */
import { AuthoredError } from "../http/error-response.js";
import { PROVIDER_ALIASES } from "../public-reads.js";
import { normalizePublishTarget } from "./publish-targets.js";

/**
 * A refusal written here for the editor: every sentence this module throws.
 * Typed so a handler can show it (`authoredMessage`) while anything else
 * that escapes a validation block — a Cosmos read, a serialisation fault —
 * is answered with the handler's own safe sentence (#945).
 */
export class ContentValidationError extends AuthoredError {}

/**
 * A string field within its length.
 *
 * @param {unknown} value - the field
 * @param {string} fieldName - its name, for the refusal
 * @param {number} maxLength - the ceiling
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string}
 * @throws {ContentValidationError}
 */
export function assertStringLength(
  value,
  fieldName,
  maxLength,
  { allowEmpty = true } = {},
) {
  const normalized = String(value || "");
  if (!allowEmpty && !normalized.trim()) {
    throw new ContentValidationError(`${fieldName} is required`);
  }
  if (normalized.length > maxLength) {
    throw new ContentValidationError(`${fieldName} exceeds ${maxLength} characters`);
  }
  return normalized;
}

/**
 * An optional date field as a Date, or null when empty.
 *
 * @param {unknown} value - the field
 * @param {string} fieldName - its name, for the refusal
 * @returns {Date|null}
 * @throws {ContentValidationError}
 */
export function assertOptionalDateString(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new ContentValidationError(`${fieldName} must be a valid date`);
  }
  return parsed;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * An optional http(s) URL field, trimmed.
 *
 * @param {unknown} value - the field
 * @param {string} fieldName - its name, for the refusal
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string}
 * @throws {ContentValidationError}
 */
export function assertOptionalHttpUrl(
  value,
  fieldName,
  { allowEmpty = true } = {},
) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    if (!allowEmpty) throw new ContentValidationError(`${fieldName} is required`);
    return "";
  }
  if (normalized.length > 2048) {
    throw new ContentValidationError(`${fieldName} exceeds 2048 characters`);
  }
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new ContentValidationError(`${fieldName} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ContentValidationError(`${fieldName} must be an http(s) URL`);
  }
  return normalized;
}

/**
 * An optional list of strings within its item count and item length.
 *
 * @param {unknown} value - the field
 * @param {string} fieldName - its name, for the refusal
 * @param {{ maxItems?: number, maxItemLength?: number }} [options]
 * @returns {string[]|null}
 * @throws {ContentValidationError}
 */
export function assertStringArray(
  value,
  fieldName,
  { maxItems = 50, maxItemLength = 120 } = {},
) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new ContentValidationError(`${fieldName} must be an array`);
  }
  if (value.length > maxItems) {
    throw new ContentValidationError(`${fieldName} exceeds ${maxItems} items`);
  }
  return value.map((entry) => {
    const normalized = String(entry || "").trim();
    if (normalized.length > maxItemLength) {
      throw new ContentValidationError(
        `${fieldName} contains an entry that exceeds ${maxItemLength} characters`,
      );
    }
    return normalized;
  });
}

/**
 * A JSON value within its serialised size.
 *
 * @param {unknown} value - the field
 * @param {string} fieldName - its name, for the refusal
 * @param {number} [maxChars] - the ceiling
 * @returns {unknown}
 * @throws {ContentValidationError}
 */
export function assertJsonSize(value, fieldName, maxChars = 120_000) {
  if (value === null || value === undefined) return value;
  // Defensive: only JSON-friendly values should be stored.
  const serialized = JSON.stringify(value);
  if (serialized.length > maxChars) {
    throw new ContentValidationError(`${fieldName} payload exceeds ${maxChars} characters`);
  }
  return value;
}

/**
 * The value the CMS stores in `Cloud Provider` for each provider the site
 * routes: the route key with its first letter capitalised ('Aws', 'Gcp',
 * 'Finops', 'Vmware', 'Docker').
 *
 * Derived from PROVIDER_ALIASES in public-reads.js, the server's provider
 * registry, whose keys public-section-counts.test.js holds to VALID_PROVIDERS.
 * A provider added there is publishable here with no second edit. Until this
 * was derived, the list was hand-kept and stopped at FinOps, so a Docker,
 * VMware or Ansible article normalised to '' and could be neither filed nor
 * published, although each has had a /<provider>/blog/<slug> route.
 */
export const STORED_PROVIDER_VALUES = Object.freeze(
  Object.fromEntries(
    Object.keys(PROVIDER_ALIASES).map((key) => [
      key,
      key.charAt(0).toUpperCase() + key.slice(1),
    ]),
  ),
);

const squashProvider = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Every spelling the registry lists ('Google Cloud', 'GitHub', ...), squashed -> its key. */
const PROVIDER_BY_SPELLING = new Map(
  Object.entries(PROVIDER_ALIASES).flatMap(([key, labels]) => [
    [key, key],
    ...labels.map((label) => [squashProvider(label), key]),
  ]),
);

/**
 * A provider spelling -> the canonical value the CMS stores in
 * `Cloud Provider`, or '' for one it cannot publish under. publish.js
 * lower-cases the result into the URL, so 'Docker' lands at
 * /docker/blog/<slug> and 'Vmware' at /vmware/blog/<slug>.
 */
export function normalizeProviderName(value) {
  const key = PROVIDER_BY_SPELLING.get(squashProvider(value));
  return key ? STORED_PROVIDER_VALUES[key] : "";
}

export const FORBIDDEN_CONTENT_UPDATE_KEYS = new Set([
  // Workflow/state machine is authoritative via transition handlers.
  "contentStatus",
  "Status",
  "Live",

  "approvedForNews",
  "reviewedAt",
  "reviewedBy",
  "reviewNotes",
  "publishedToBlogs",
  "publishedBlogId",
  "movedToBlogsAt",
  // Timestamps/identity are backend-owned.
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "publishedAt",
  "Published At",
  // The site URL has ONE writer, POST cms/content/slug (../cms/set-slug.js).
  // Added 2026-09-07 with that route (#400) after establishing what this file
  // did with a slug before it: nothing. `slug` matches no normalizer above, so
  // it fell through to normalizeGenericField and was stored EXACTLY as sent —
  // '  Hello World!!  ' kept its spaces, its capitals and its punctuation —
  // and no caller here probes whether another document already holds the
  // value. Three articles sharing one URL is what that costs, so an editor
  // reaching this route can no longer assign one: the dedicated route
  // slugifies and probes `c.slug OR c.Slug` before it writes, and republishes
  // so the URLs follow. The publish pipeline patches slug/Slug directly and is
  // unaffected — it never passes through this validator.
  "slug",
  "Slug",
]);

// Per-field-type normalizers used by validateAndNormalizeUpdateContentItemUpdates.
// KNOWN_FIELD_NORMALIZERS below pairs each field test with what it writes;
// the first whose test holds consumes the entry, and none holding falls
// through to the generic normalizer.

/** `url`, `sourceUrl`, `diagramUrl`, any `…Url`/`…URL`, and `docLink`. */
function isUrlField(field) {
  return /Url$/i.test(field) || field === "docLink";
}

function isDateLikeField(field) {
  return /At$/.test(field) || /Date$/.test(field) || field === "publishedDate";
}

/** A date-like field with a value the date normalizer can take; any other value falls through. */
function isDateLikeEntry(field, value) {
  return (
    isDateLikeField(field) &&
    (typeof value === "string" || value instanceof Date)
  );
}

/**
 * The dual-casing text fields, either spelling -> the pair that is always
 * written together and the length the pair shares. A Map, so a field named
 * like an Object prototype member cannot read as a pair.
 */
const PAIRED_TEXT_FIELDS = new Map([
  ["title", { keys: ["title", "Title"], maxLength: 240 }],
  ["Title", { keys: ["title", "Title"], maxLength: 240 }],
  ["summary", { keys: ["summary", "Summary"], maxLength: 10_000 }],
  ["Summary", { keys: ["summary", "Summary"], maxLength: 10_000 }],
]);

function normalizeUrlField(normalized, field, value) {
  normalized[field] = assertOptionalHttpUrl(value, field, {
    allowEmpty: true,
  });
}

function normalizeDateLikeField(normalized, field, value) {
  normalized[field] =
    typeof value === "string" ? assertOptionalDateString(value, field) : value;
}

function normalizePairedTextField(normalized, field, value) {
  const pair = PAIRED_TEXT_FIELDS.get(field);
  const text = assertStringLength(value, pair.keys[0], pair.maxLength, {
    allowEmpty: true,
  }).trim();
  Object.assign(
    normalized,
    Object.fromEntries(pair.keys.map((key) => [key, text])),
  );
}

/**
 * `cloudProvider` as a stored provider value, written as a pair.
 *
 * @param {object} normalized - the updates being built
 * @param {string} _field - the field name (unused)
 * @param {unknown} value - the value sent
 * @throws {ContentValidationError}
 */
function normalizeCloudProviderField(normalized, _field, value) {
  const provider = normalizeProviderName(value);
  if (!provider) {
    throw new ContentValidationError(
      `cloudProvider must be one of: ${Object.values(STORED_PROVIDER_VALUES).join(", ")}`,
    );
  }
  normalized.cloudProvider = provider;
  normalized["Cloud Provider"] = provider;
}

function normalizePublishTargetField(normalized, _field, value) {
  normalized.publishTarget = normalizePublishTarget(value);
}

/** The id shape taxonomy.js enforces when the lists are saved. */
const TAXONOMY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

/**
 * Shape only — a slug id, as taxonomy.js stores them. Membership in the
 * saved taxonomy is checked by the handler, which has the store and the
 * current record (content-update.js, ADR 0033 §4).
 */
function normalizeTaxonomyIdField(normalized, field, value) {
  const id = String(value || "")
    .trim()
    .toLowerCase();
  if (!TAXONOMY_ID_PATTERN.test(id)) {
    throw new ContentValidationError(
      `${field} must be a taxonomy id (2-40 lower-case letters, digits or hyphens)`,
    );
  }
  normalized[field] = id;
}

function normalizeTagsField(normalized, _field, value) {
  const tags =
    assertStringArray(value, "tags", { maxItems: 60, maxItemLength: 60 }) || [];
  const cleaned = tags.map((t) => String(t || "").trim()).filter(Boolean);
  normalized.tags = cleaned;
  normalized.Tags = cleaned;
}

function normalizeKeyTopicsField(normalized, _field, value) {
  const topics =
    assertStringArray(value, "keyTopics", {
      maxItems: 40,
      maxItemLength: 120,
    }) || [];
  normalized.keyTopics = topics
    .map((t) => String(t || "").trim())
    .filter(Boolean);
}

function normalizeFrameworkSourceUrlsField(normalized, _field, value) {
  const urls =
    assertStringArray(value, "frameworkSourceUrls", {
      maxItems: 30,
      maxItemLength: 2048,
    }) || [];
  urls.forEach((u) => {
    if (u)
      assertOptionalHttpUrl(u, "frameworkSourceUrls", { allowEmpty: true });
  });
  normalized.frameworkSourceUrls = urls.filter(Boolean);
}

const isOneOf =
  (...names) =>
  (field) =>
    names.includes(field);

/**
 * [matches(field, value), normalize(normalized, field, value)], in the order
 * the fields are tried: the first match consumes the entry.
 */
const KNOWN_FIELD_NORMALIZERS = [
  [isUrlField, normalizeUrlField],
  [isDateLikeEntry, normalizeDateLikeField],
  [(field) => PAIRED_TEXT_FIELDS.has(field), normalizePairedTextField],
  [isOneOf("cloudProvider", "Cloud Provider"), normalizeCloudProviderField],
  [isOneOf("publishTarget"), normalizePublishTargetField],
  [isOneOf("kind", "ideaOrigin"), normalizeTaxonomyIdField],
  [isOneOf("tags", "Tags"), normalizeTagsField],
  [isOneOf("keyTopics"), normalizeKeyTopicsField],
  [isOneOf("frameworkSourceUrls"), normalizeFrameworkSourceUrlsField],
];

/** True when a known-field normalizer consumed the entry. */
function tryNormalizeKnownField(normalized, field, value) {
  const match = KNOWN_FIELD_NORMALIZERS.find(([matches]) =>
    matches(field, value),
  );
  if (!match) return false;
  match[1](normalized, field, value);
  return true;
}

const MAX_STRING_DEFAULT = 12_000;
const MAX_STRING_LARGE = 120_000;

/** `overviewHtml`, `terraformCode`, `blogDraft` and every other `…Html`/`…Code`/`…Draft`. */
function isLargeStringField(field) {
  return /(Html|Code|Draft)$/i.test(field);
}

/**
 * Any other field: a primitive, a bounded string, or bounded JSON.
 *
 * @param {object} normalized - the updates being built
 * @param {string} field - the field name
 * @param {unknown} value - the value sent
 * @throws {ContentValidationError}
 */
function normalizeGenericField(normalized, field, value) {
  if (typeof value === "boolean" || typeof value === "number") {
    normalized[field] = value;
    return;
  }
  if (typeof value === "string") {
    const max = isLargeStringField(field)
      ? MAX_STRING_LARGE
      : MAX_STRING_DEFAULT;
    normalized[field] = assertStringLength(value, field, max, {
      allowEmpty: true,
    });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) {
      throw new ContentValidationError(`${field} exceeds 500 items`);
    }
    normalized[field] = assertJsonSize(value, field);
    return;
  }
  if (isPlainObject(value)) {
    normalized[field] = assertJsonSize(value, field);
    return;
  }
  throw new ContentValidationError(`Unsupported value type for ${field}`);
}

/**
 * An editor's updates object, validated and normalised field by field.
 *
 * @param {object} [updates] - the body's `updates`
 * @returns {object} the normalised updates
 * @throws {ContentValidationError} with a sentence naming the field (authored, #945)
 */
export function validateAndNormalizeUpdateContentItemUpdates(updates = {}) {
  if (!isPlainObject(updates)) {
    throw new ContentValidationError("updates must be an object");
  }
  const entries = Object.entries(updates);
  if (entries.length === 0) {
    throw new ContentValidationError("updates must include at least one field");
  }
  if (entries.length > 80) {
    throw new ContentValidationError("updates exceeds 80 fields");
  }

  const normalized = {};
  for (const [key, value] of entries) {
    const field = String(key || "").trim();
    if (!field) continue;
    normalizeEntry(normalized, field, value);
  }
  return normalized;
}

/**
 * One update entry onto `normalized`: the name checked against the length
 * ceiling and the denylist, an undefined value skipped, a null kept as a
 * deletion, then the known-field normalizers before the generic one.
 */
function normalizeEntry(normalized, field, value) {
  if (field.length > 120) {
    throw new ContentValidationError(
      `updates contains a field name that exceeds 120 characters`,
    );
  }
  if (FORBIDDEN_CONTENT_UPDATE_KEYS.has(field)) {
    throw new ContentValidationError(`updates cannot modify protected field: ${field}`);
  }
  if (value === undefined) return;
  if (value === null) {
    normalized[field] = null;
    return;
  }
  if (tryNormalizeKnownField(normalized, field, value)) return;
  normalizeGenericField(normalized, field, value);
}

/**
 * Blog-only-era shaping applied after validation (source :262): re-resolve the
 * publish target with the doc type as fallback, collapse legacy statuses, and
 * force the retired approvedForNews flag off.
 */
export function normalizeContentUpdatesForBlogOnly(updates = {}) {
  const normalized = { ...updates };

  if (Object.prototype.hasOwnProperty.call(normalized, "publishTarget")) {
    normalized.publishTarget = normalizePublishTarget(
      normalized.publishTarget,
      normalized.type || normalized.contentType,
    );
  }

  if (typeof normalized.contentStatus === "string") {
    normalized.contentStatus = normalizeStatusForBlogOnly(
      normalized.contentStatus,
    );
  }

  if (normalized.approvedForNews === true) {
    normalized.approvedForNews = false;
  }

  return normalized;
}

/**
 * Collapse the retired news-era statuses onto their blog equivalents.
 *
 * `approved_blog` and `published_blog` are the Firestore-era names the admin
 * pages kept sending after the port normalised the stored values to
 * `approved` and `published`. Until 2026-10-03 neither was mapped here, so
 * every Approve button — queue, review boards, editor — reached the
 * transition table with a status it does not know and got back 400
 * "Invalid transition" (ADR 0033 §1). The pages now send the canonical
 * names; the aliases stay so an old tab, the Telegram bot or a bookmarked
 * request keeps working.
 */
const STATUS_ALIASES = Object.freeze({
  published_news: "published",
  published_both: "published",
  published_blog: "published",
  approved_news: "approved",
  approved_blog: "approved",
});

export function normalizeStatusForBlogOnly(status) {
  return Object.hasOwn(STATUS_ALIASES, status)
    ? STATUS_ALIASES[status]
    : status;
}

export function normalizeCurrentStatusForBlogOnly(status) {
  return normalizeStatusForBlogOnly(status || "ingested");
}
