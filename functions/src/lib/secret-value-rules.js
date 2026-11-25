/**
 * secret-value-rules.js — what a pasted credential must not look like before
 * it is written to Key Vault. Pure; split out of admin-secrets.js, which
 * re-exports MIN_SECRET_LENGTH and rejectSecretValue so callers and tests
 * import what they always did.
 */

/** Shortest value accepted. Every real credential in this estate is far longer. */
export const MIN_SECRET_LENGTH = 12;

/**
 * Values that are obviously not credentials.
 *
 * Required-Inputs §4.6's rule is "do not seed a placeholder to quiet a linter" — a
 * placeholder turns a gray light green while the feature stays just as broken,
 * which is strictly worse than absent because nobody looks at it again.
 */
const PLACEHOLDER_PATTERN =
  /^(changeme|change-me|placeholder|todo|tbd|test|example|your[-_]?key([-_]?here)?|xxx+|<.*>)$/i;

/*
 * THE PATTERNS BELOW NAME THEIR CODE POINTS AS NUMBERS, NEVER AS CHARACTERS.
 *
 * A file about invisible characters that contains invisible characters reads
 * as binary to git and to grep, and the one thing nobody can review is the
 * byte they cannot see. `integrations/rest-proxy.js` records the same trap
 * against its own control-character check, and made the same choice (#484).
 */

/**
 * Characters with no width, which a paste can carry and no eye can find.
 *
 * `String.prototype.trim()` is not a defence against any of these. It removes
 * U+00A0 and U+FEFF, and only at the ends; U+200B and the bidi marks it does
 * not touch even there, and nothing it does reaches the middle of a string.
 * So a key with a zero-width space in it stores clean, resolves clean, and is
 * refused upstream forever as "the key is wrong".
 *
 * U+FEFF appears here as well as in `trim`'s set because interior is exactly
 * where trim cannot help.
 */
const INVISIBLE_PATTERN =
  /[\u00ad\u200b\u200c\u200d\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/**
 * C0 and C1 control characters, and the DEL in between.
 *
 * A raw newline inside a value is the common one, and it survives `trim` when
 * it is not at an end. Anything in this range that reaches an outbound header
 * throws in `fetch` rather than being rejected by the provider, which is a
 * crash where a diagnosis should be — the measurement on 2026-09-09 caught
 * exactly that shape.
 */
 
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** The four a phone keyboard or a rich-text editor substitutes for ' and ". */
const SMART_QUOTE_PATTERN = /[\u2018\u2019\u201c\u201d]/;

/**
 * A value that arrived still wearing its quotes.
 *
 * Straight, curly and backtick, and only as a MATCHED pair — a credential is
 * allowed to contain a quote, just not to be wrapped in one. The curly pairs
 * are directional, so the opener and closer differ.
 */
const WRAPPED_IN_QUOTES = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
];

/**
 * A label that precedes a credential, pasted along with it.
 *
 * NOT called an auth-scheme pattern, and the message it produces does not say
 * "Authorization header", because only half of these come from one. `Bearer`,
 * `Basic` and `Bearer-API` are HTTP auth schemes; `token:` and `api_key:` are
 * far more often a key in a YAML file, a `.env` line or a form label. Claiming
 * a header for those would name the wrong source on a check whose entire
 * purpose is naming the right one — the same correction the whitespace message
 * needed. What is true of all of them is that they LABEL the credential
 * instead of being part of it, so that is what the sentence says.
 *
 * `Bearer-API` is listed before `Bearer` because these alternate left to
 * right: with `Bearer` first, a Publer value would match on the short one and
 * the message would quote a scheme the operator never pasted. The trailing
 * separator is required, so a credential that merely begins with these letters
 * is untouched.
 */
const CREDENTIAL_LABEL_PATTERN =
  /^(authorization\s*:|bearer-api|bearer|basic|token|api[-_]?key)[\s:]/i;

/**
 * The checks rejectSecretValue runs on a non-empty string, in order: each
 * answers the sentence refusing the value, or null to pass it on.
 */
const SECRET_VALUE_RULES = [
  // Copying from a terminal or a PDF picks up a trailing newline or NBSP.
  // The vault stores it happily and the upstream service rejects it, which
  // presents as "the key is wrong" rather than "the key has a space on it".
  (raw) =>
    raw !== raw.trim()
      ? 'the value has leading or trailing whitespace — copy it again without the surrounding space'
      : null,
  (raw) =>
    raw.startsWith('@Microsoft.KeyVault(')
      ? 'that is a Key Vault REFERENCE, not a secret value — paste the credential itself'
      : null,
  (raw) =>
    raw.length < MIN_SECRET_LENGTH
      ? `the value is shorter than ${MIN_SECRET_LENGTH} characters, which no credential in this estate is`
      : null,
  (raw) =>
    PLACEHOLDER_PATTERN.test(raw)
      ? 'that looks like a placeholder — a placeholder turns the light green while the feature stays broken'
      : null,

  // Everything below is #484, and it runs AFTER every check above so that a
  // placeholder still reads as a placeholder. Each names WHAT WAS FOUND: the
  // whole failure this guards against is a value that stores clean and is
  // refused upstream forever as "the key is wrong", so "invalid" here would
  // reproduce the same uselessness one layer earlier.
  //
  // Ordered most specific first. A pasted `Authorization: Bearer abc` trips
  // three of these, and the useful sentence is the one about the header, not
  // the one about a space.
  (raw) =>
    INVISIBLE_PATTERN.test(raw)
      ? 'the value contains an invisible character (a zero-width space or a text-direction mark) — retype it, or paste it through a plain-text editor first'
      : null,
  (raw) =>
    CONTROL_PATTERN.test(raw)
      ? 'the value contains a control character, such as a line break inside it — copy the credential on its own, without the line it sits on'
      : null,
  (raw) =>
    raw.length > 1 && WRAPPED_IN_QUOTES.some(([open, close]) => raw.startsWith(open) && raw.endsWith(close))
      ? 'the value is wrapped in quotes — paste the credential itself, without the quotes around it'
      : null,
  (raw) =>
    SMART_QUOTE_PATTERN.test(raw)
      ? 'the value contains a curly quote, which a phone keyboard or a rich-text editor substitutes for a straight one — retype it in a plain-text field'
      : null,
  (raw) => {
    const label = raw.match(CREDENTIAL_LABEL_PATTERN);
    return label
      ? `the value starts with "${label[1]}", which labels the credential rather than being part of it — paste only what comes after it`
      : null;
  },
  // Reached only for whitespace in the MIDDLE: the leading and trailing case
  // is caught by the trim comparison above, which gives a better sentence.
  //
  // "whitespace", not "a space", because `\s` is wider than the space bar
  // and what survives to this line is the wide part. Every ASCII whitespace
  // character is a control character and was refused above; what reaches
  // here is U+0020 and the Unicode spaces beyond it — U+00A0, U+2000-U+200A,
  // U+2028, U+3000. Calling U+2028 "a space" would name the wrong thing, on
  // a check whose entire purpose is naming the right one.
  (raw) =>
    /\s/.test(raw)
      ? 'the value has whitespace inside it — a credential in this estate has none, so part of the surrounding text was copied with it'
      : null,
];

/**
 * Reject a value before it reaches the vault.
 *
 * Ported from `06-seed-secret.ps1`, which refuses the same things for the same
 * reasons. A bad value written to the vault is worse than a rejected paste: it
 * shows green and fails upstream.
 *
 * @returns {string|null} the reason it is unacceptable, or null
 */
export function rejectSecretValue(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'no value was supplied';
  for (const rule of SECRET_VALUE_RULES) {
    const reason = rule(raw);
    if (reason) return reason;
  }
  return null;
}
