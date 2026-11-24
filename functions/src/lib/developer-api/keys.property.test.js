/**
 * Property tests for the organizer key parser of the Developer API
 * (./keys.js): the code that decides whether text presented as a key has the
 * shape `hcdk_<keyId>_<secret>`, before anything is read from the database.
 *
 * A property test states a rule that must hold for every input, and a
 * library (fast-check) makes up hundreds of inputs to try to break it. A
 * failure prints the smallest input found and a seed that replays the run.
 *
 * The key arrives in a request header from the internet, so these rules are
 * about text this site did not write. No key here is real: each is made from
 * the test's own random bytes.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  KEY_HINT_CHARS,
  KEY_ID_BYTES,
  KEY_PREFIX,
  KEY_SECRET_BYTES,
  developerKeyFrom,
  generateKey,
  hashKey,
  hashMatches,
  isKeyId,
  keyHint,
  looksLikeKey,
  parseKey,
} from './keys.js';

const RUNS = { numRuns: 300 };

const idBytes = fc.uint8Array({ minLength: KEY_ID_BYTES, maxLength: KEY_ID_BYTES });
const secretBytes = fc.uint8Array({ minLength: KEY_SECRET_BYTES, maxLength: KEY_SECRET_BYTES });

/**
 * A key exactly as generateKey makes one, from bytes the test chose. Secrets
 * that begin with `_` or `-` are produced on purpose (first byte 0xFC to
 * 0xFF, or 0xF8 to 0xFB): `_` is also the separator between the id and the
 * secret, and a test went flaky on that once.
 */
const key = fc
  .tuple(idBytes, fc.oneof(secretBytes, secretBytes.map((bytes) => Uint8Array.from([0xfc | (bytes[0] & 3), ...bytes.slice(1)]))))
  .map(([id, secret]) => generateKey({ random: (size) => Buffer.from(size === KEY_ID_BYTES ? id : secret) }));

const headersOf = (values) => ({ headers: { get: (name) => (Object.hasOwn(values, name) ? values[name] : null) } });
/** Blanks a header value can carry around or inside it. */
const blank = fc.stringMatching(/^[ \t]{0,3}$/);

describe('organizer key shape (property)', () => {
  // Rule 1: every key this site makes is read back as its own id, whatever
  // the random bytes were, and the three parts put together are the key.
  it('reads every generated key back as its own id', () => {
    fc.assert(
      fc.property(key, ({ keyId, secret }) => {
        const parsed = parseKey(secret);
        expect(parsed).not.toBeNull();
        expect(parsed.keyId).toBe(keyId);
        expect(isKeyId(parsed.keyId)).toBe(true);
        expect(`${KEY_PREFIX}${parsed.keyId}_${parsed.rest}`).toBe(secret);
        expect(looksLikeKey(secret)).toBe(true);
      }),
      RUNS
    );
  });

  // Rule 2: the hint the admin shows is the start of the key and stops
  // KEY_HINT_CHARS into the secret, so it is never enough to use.
  it('shows a hint that is only the start of the key', () => {
    fc.assert(
      fc.property(key, ({ keyId, secret }) => {
        const hint = keyHint(secret);
        expect(secret.startsWith(hint)).toBe(true);
        expect(hint).toHaveLength(KEY_PREFIX.length + keyId.length + 1 + KEY_HINT_CHARS);
        expect(looksLikeKey(hint)).toBe(false);
      }),
      RUNS
    );
  });

  // Rule 3: for any value at all, the parser answers and does not throw;
  // and when it accepts one, the value is exactly prefix + id + `_` + rest,
  // with nothing before, after or in between (no stray line break or space).
  it('never throws, and accepts only text that is the three parts and nothing more', () => {
    const lookalike = fc.stringMatching(/^(hcdk_|hcwk_|HCDK_)?[0-9a-fA-F]{14,18}[_-]?[A-Za-z0-9_-]{38,66}[\n ]?$/);
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 120 }), lookalike, fc.anything()), (value) => {
        const parsed = parseKey(value);
        expect(keyHint(value) === null).toBe(parsed === null);
        if (parsed === null) return;
        expect(value).toBe(`${KEY_PREFIX}${parsed.keyId}_${parsed.rest}`);
        expect(parsed.keyId).toMatch(/^[0-9a-f]{16}$/);
        expect(parsed.rest).toMatch(/^[A-Za-z0-9_-]{40,64}$/);
      }),
      RUNS
    );
  });

  // Rule 4: a real key with one character added that a key cannot hold (a
  // space, a line break, a dot, a slash, any non-ASCII character) is refused,
  // wherever the character lands.
  it('refuses a real key with one foreign character added anywhere', () => {
    const foreign = fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }).filter((c) => !/^[A-Za-z0-9_-]$/.test(c));
    fc.assert(
      fc.property(key, foreign, fc.nat(), ({ secret }, extra, at) => {
        const cut = at % (secret.length + 1);
        expect(parseKey(secret.slice(0, cut) + extra + secret.slice(cut))).toBeNull();
      }),
      RUNS
    );
  });

  // Rule 5: a real key cut short anywhere inside its prefix or id is refused.
  it('refuses a real key cut short before its secret', () => {
    fc.assert(
      fc.property(key, fc.nat(), ({ keyId, secret }, at) => {
        const cut = at % (KEY_PREFIX.length + keyId.length + 1);
        expect(parseKey(secret.slice(0, cut))).toBeNull();
        expect(parseKey(secret.slice(cut + 1))).toBeNull();
      }),
      RUNS
    );
  });
});

describe('reading the key from a request (property)', () => {
  // Rule 6: whatever the two headers hold, reading the key does not throw,
  // and the answer is nothing or non-empty text with no blanks at its ends.
  it('answers any header values with nothing or trimmed text', () => {
    const header = fc.oneof(fc.string({ unit: 'binary', maxLength: 80 }), fc.constantFrom(null, undefined, '', '   ', 'Bearer', 'Bearer   '), fc.anything());
    fc.assert(
      fc.property(header, header, (authorization, apiKey) => {
        const found = developerKeyFrom(headersOf({ authorization, 'x-api-key': apiKey }));
        if (found === null) return;
        expect(typeof found).toBe('string');
        expect(found.length).toBeGreaterThan(0);
        expect(found).toBe(found.trim());
      }),
      RUNS
    );
  });

  // Rule 7: a real key is found unchanged in each of the three places a
  // client may put it, whatever blanks surround it and however "Bearer" is
  // capitalised.
  it('finds a real key in each place a client may put it', () => {
    const bearer = fc.constantFrom('Bearer', 'bearer', 'BEARER', 'bEaReR');
    fc.assert(
      fc.property(key, bearer, blank, blank, blank, ({ secret }, word, a, b, c) => {
        expect(developerKeyFrom(headersOf({ authorization: `${a}${word} ${b}${secret}${c}` }))).toBe(secret);
        expect(developerKeyFrom(headersOf({ authorization: `${a}${secret}${c}` }))).toBe(secret);
        expect(developerKeyFrom(headersOf({ authorization: a, 'x-api-key': `${b}${secret}${c}` }))).toBe(secret);
      }),
      RUNS
    );
  });

  // Rule 8: a non-empty Authorization header wins. When it holds something
  // that is neither "Bearer ..." nor a key, a key in X-API-Key is not used.
  it('does not fall back to X-API-Key when Authorization holds something else', () => {
    const other = fc
      .string({ unit: 'binary', minLength: 1, maxLength: 40 })
      .filter((s) => s.trim() !== '' && !/^Bearer\s/i.test(s.trim()) && !looksLikeKey(s.trim()));
    fc.assert(
      fc.property(key, other, ({ secret }, authorization) => {
        expect(developerKeyFrom(headersOf({ authorization, 'x-api-key': secret }))).toBeNull();
      }),
      RUNS
    );
  });
});

describe('comparing a key with its stored hash (property)', () => {
  // Rule 9: a key matches the hash of itself and of no other key, and
  // anything that is not a 64-character lower-case hex hash matches nothing.
  it('matches a key only against its own hash', () => {
    fc.assert(
      fc.property(key, key, fc.oneof(fc.string({ unit: 'binary', maxLength: 80 }), fc.anything()), (one, two, junk) => {
        expect(hashMatches(one.secret, hashKey(one.secret))).toBe(true);
        expect(hashMatches(one.secret, hashKey(two.secret))).toBe(one.secret === two.secret);
        expect(hashMatches(one.secret, hashKey(one.secret).toUpperCase())).toBe(/^[0-9]+$/.test(hashKey(one.secret)));
        if (junk !== hashKey(one.secret)) expect(hashMatches(one.secret, junk)).toBe(false);
      }),
      RUNS
    );
  });
});
