/**
 * archive-classification-fields.js — how the yearly archive reads a field
 * (archive-classification.js): which field NAMES look like a secret or
 * someone's contact details, and how each kind of kept field is copied.
 *
 * Moved out of archive-classification.js without a change to what it
 * decides. That file still re-exports what it exported before, and its
 * fingerprint still covers the code here.
 */

// ── Names that look like a secret or a person's contact details ─────────────

/**
 * Does a field NAME look like it holds a secret or someone's contact details?
 * The name is read, never the value.
 *
 * The name is first folded to lower-case letters and digits (`api_key`,
 * `apiKey` and `API-KEY` all become `apikey`). It matches when that contains
 * one of the WORDS below, or is one of the EXACT names. The list is wide on
 * purpose: a harmless name that matches (`contentHash`, `apiKeyEnvVar`) costs
 * a line in a report, and a missed one could cost a key in a permanent copy.
 *
 * Used in two places: the dry run counts the records that carry such a name,
 * at any depth, so the owner sees them before anything is archived
 * (archive-report.js); and the keep lists below drop such a name from inside
 * a kept field, so a token cannot ride in one level down.
 */
export const SENSITIVE_NAME_WORDS = Object.freeze([
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'apikey',
  'accesskey',
  'privatekey',
  'signingkey',
  'clientkey',
  'authorization',
  'credential',
  'cookie',
  'bearer',
  'hash',
  'salt',
  'signature',
  'email',
  'phone',
]);
/** Short names that only count when they are the whole name: `sas` and `sig` (signed web addresses), `key`, `pwd`, `auth`, `pin`. */
export const SENSITIVE_EXACT_NAMES = Object.freeze(['sas', 'sig', 'key', 'keys', 'pwd', 'auth', 'pin', 'otp', 'ssn']);

/**
 * The tests a name is put to, in order; the first that says yes decides.
 * Each gets the name as written and the name folded (lower-case letters and
 * digits only).
 */
export const SENSITIVE_NAME_TESTS = Object.freeze([
  (name, folded) => SENSITIVE_EXACT_NAMES.includes(folded),
  // `sas` and `sig` as their own word in a longer name: sasToken, url_sig.
  (name) => /(^|[^a-z])(sas|sig)([^a-z]|$)/.test(name.toLowerCase()),
  (name) => /(^|[a-z])(Sas|Sig)([A-Z]|$)/.test(name),
  (name, folded) => SENSITIVE_NAME_WORDS.some((word) => folded.includes(word)),
]);

/** @param {unknown} name */
export function looksSensitive(name) {
  if (typeof name !== 'string' || !name) return false;
  const folded = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return Boolean(folded) && SENSITIVE_NAME_TESTS.some((test) => test(name, folded));
}

/** How deep a kept field is read, and how many values of one field, before the rest is dropped. */
const MAX_KEPT_DEPTH = 6;
const MAX_KEPT_NODES = 5000;

/**
 * A copy of a kept field's value with every key that looks sensitive taken
 * out, at any depth. Bounded: past the depth or the size limit the rest is
 * dropped, never kept unread. Returns `{ value, dropped }`.
 */
export function withoutSensitiveKeys(input) {
  let nodes = 0;
  let dropped = false;
  const walk = (value, depth) => {
    nodes += 1;
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_KEPT_DEPTH || nodes > MAX_KEPT_NODES) {
      dropped = true;
      return undefined;
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1)).filter((item) => item !== undefined);
    }
    const copy = {};
    for (const [key, inner] of Object.entries(value)) {
      if (looksSensitive(key)) {
        dropped = true;
        continue;
      }
      const kept = walk(inner, depth + 1);
      if (kept !== undefined) copy[key] = kept;
    }
    return copy;
  };
  const value = walk(input, 0);
  return { value, dropped };
}

// ── Keep lists: what is kept from a record, field by field ─────────────────

const isScalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** The name of an app setting, as the site spells them: `SOME_SETTING_NAME`. Never a key's value. */
const SETTING_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * A web address with everything that can carry a key cut off: the query
 * string (`?api_key=...`), the fragment (`#...`) and any user name and
 * password (`user:pass@`). An address that cannot be read, or is not http or
 * https, is dropped whole (`null`).
 * @param {unknown} value
 * @returns {string|null}
 */
export function addressWithoutSecrets(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/**
 * How one kept field is copied. Each returns the value to keep, or
 * `undefined` to drop the field.
 *
 *   scalar   text, a number, true/false or null; anything nested is dropped
 *   name     the NAME of an app setting (`SOME_SETTING_NAME`); anything else is dropped
 *   address  a web address without its query string, fragment or user name
 *   strings  a list of text items; other items are dropped
 *   tools    a list of tools as `{ name, description }`; nothing else of a tool is kept
 *   nested   any value, with every key that looks sensitive taken out at any depth
 */
export const KINDS = Object.freeze({
  scalar: (value) => (isScalar(value) ? value : undefined),
  name: (value) => (typeof value === 'string' && SETTING_NAME.test(value) ? value : undefined),
  address: (value) => addressWithoutSecrets(value) ?? undefined,
  strings: (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : undefined),
  tools: (value) =>
    Array.isArray(value)
      ? value
          .filter((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string')
          .map((tool) => ({
            name: tool.name,
            ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          }))
      : undefined,
  nested: (value) => withoutSensitiveKeys(value).value,
});

export const keep = (kind, names) => Object.fromEntries(names.map((name) => [name, kind]));
