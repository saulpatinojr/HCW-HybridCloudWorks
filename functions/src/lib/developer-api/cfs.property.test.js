/**
 * Property tests for the paging inputs of the Developer API's proposal list
 * (./cfs.js): the `cursor` and `limit` an organizer's code sends back.
 *
 * A property test states a rule that must hold for every input, and a
 * library (fast-check) makes up hundreds of inputs to try to break it. When
 * one does, the failure message prints the smallest input found and a seed
 * (a number that replays the same run), so the case can be repeated.
 *
 * Both values arrive from the internet in a query string, so the rules here
 * are about what happens to text this site did not write.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_CURSOR_CHARS, MAX_LISTED, REVIEW_DECISIONS, decodeListCursor, encodeListCursor, readListPaging } from './cfs.js';
import { DeveloperApiInputError } from './keys.js';

const RUNS = { numRuns: 300 };
const PRINTABLE = /^[\x20-\x7E]+$/;

/** A continuation value as the database gives it: printable ASCII, not empty. */
const token = fc.stringMatching(/^[\x20-\x7E]{1,400}$/);
/** The status filter a list is read with: one of the review decisions, or none. */
const status = fc.constantFrom(null, ...REVIEW_DECISIONS);
/** A query string as the handler sees it: `get(name)` answers the value or null. */
const queryOf = (values) => ({ get: (name) => (Object.hasOwn(values, name) ? values[name] : null) });

/** Run `fn`; the only error it may throw is the 400 one. Returns its answer, or `refused`. */
const refused = Symbol('refused');
function answerOr400(fn) {
  try {
    return fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DeveloperApiInputError);
    return refused;
  }
}

describe('list cursor (property)', () => {
  // Rule 1: a cursor this site made reads back as the value it was made
  // from, as long as the same status filter is sent with it.
  it('reads back what was put in, under the same status filter', () => {
    fc.assert(
      fc.property(token, status, (t, s) => {
        const cursor = encodeListCursor({ token: t, status: s });
        expect(cursor.length).toBeLessThanOrEqual(MAX_CURSOR_CHARS);
        expect(decodeListCursor(cursor, s)).toBe(t);
      }),
      RUNS
    );
  });

  // Rule 2: a cursor made under one status filter is refused under any
  // other, so a page marker cannot be replayed against a different list.
  it('is refused under a different status filter', () => {
    fc.assert(
      fc.property(token, status, status, (t, made, sent) => {
        fc.pre(made !== sent);
        expect(() => decodeListCursor(encodeListCursor({ token: t, status: made }), sent)).toThrow(DeveloperApiInputError);
      }),
      RUNS
    );
  });

  // Rule 3: whatever is sent as a cursor (any text, any value at all), the
  // answer is either a printable value safe to put in a request header, or
  // the 400 error. Never a crash, never another kind of error.
  it('answers any value with a printable token or the 400 error, nothing else', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 200 }), fc.anything()), status, (value, s) => {
        const answer = answerOr400(() => decodeListCursor(value, s));
        if (answer !== refused) expect(answer).toMatch(PRINTABLE);
      }),
      RUNS
    );
  });

  // Rule 4: the same holds for a forged cursor, one that is well-formed on
  // the outside (base64url text holding JSON) with anything inside. When
  // one is accepted, it is because the inside has exactly the shape this
  // site writes, and the answer is the `t` field unchanged.
  it('accepts a forged cursor only when its inside is exactly the shape this site writes', () => {
    const inside = fc.oneof(
      fc.jsonValue(),
      fc.record(
        {
          v: fc.oneof(fc.constant(1), fc.jsonValue()),
          s: fc.oneof(status, fc.jsonValue()),
          t: fc.oneof(token, fc.string({ unit: 'binary', maxLength: 50 }), fc.jsonValue()),
        },
        { requiredKeys: [] }
      )
    );
    fc.assert(
      fc.property(inside, status, (body, s) => {
        const forged = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
        const answer = answerOr400(() => decodeListCursor(forged, s));
        if (answer === refused) return;
        expect(answer).toMatch(PRINTABLE);
        expect(body.v).toBe(1);
        expect(body.t).toBe(answer);
        expect(body.s ?? null).toBe(s);
      }),
      RUNS
    );
  });
});

describe('readListPaging (property)', () => {
  // Rule 5: for any `limit` and `cursor` text, the answer is a whole number
  // from 1 to MAX_LISTED and a printable token (or none), or the 400 error.
  it('answers any limit and cursor with values in range or the 400 error', () => {
    const text = fc.oneof(fc.string({ unit: 'binary', maxLength: 40 }), fc.integer().map(String), fc.constantFrom(null, undefined, ''));
    fc.assert(
      fc.property(text, text, status, (limit, cursor, s) => {
        const answer = answerOr400(() => readListPaging(queryOf({ limit, cursor }), s));
        if (answer === refused) return;
        expect(Number.isInteger(answer.limit)).toBe(true);
        expect(answer.limit).toBeGreaterThanOrEqual(1);
        expect(answer.limit).toBeLessThanOrEqual(MAX_LISTED);
        if (answer.continuationToken !== null) expect(answer.continuationToken).toMatch(PRINTABLE);
      }),
      RUNS
    );
  });

  // Rule 6: a whole number is accepted exactly when it is from 1 to
  // MAX_LISTED, and then it is the number that comes back.
  it('accepts a whole number exactly when it is from 1 to the maximum', () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer({ min: -5, max: MAX_LISTED + 5 }), fc.integer()), (n) => {
        const answer = answerOr400(() => readListPaging(queryOf({ limit: String(n) })));
        if (n >= 1 && n <= MAX_LISTED) expect(answer).toEqual({ limit: n, continuationToken: null });
        else expect(answer).toBe(refused);
      }),
      RUNS
    );
  });

  // Rule 7: a limit that is not plain digits is never read as a number,
  // however a looser parser would read it ("1e2", " 7", "0x10", "5.0").
  it('refuses a limit that is not plain digits', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', minLength: 1, maxLength: 12 }).filter((s) => !/^[0-9]+$/.test(s)),
        (limit) => {
          expect(answerOr400(() => readListPaging(queryOf({ limit })))).toBe(refused);
        }
      ),
      RUNS
    );
  });

  // Rule 8: paging round trip. The cursor one answer gives is read back by
  // the next request as the same token.
  it('reads back the cursor a previous answer gave', () => {
    fc.assert(
      fc.property(token, status, fc.integer({ min: 1, max: MAX_LISTED }), (t, s, n) => {
        const cursor = encodeListCursor({ token: t, status: s });
        expect(readListPaging(queryOf({ limit: String(n), cursor }), s)).toEqual({ limit: n, continuationToken: t });
      }),
      RUNS
    );
  });
});
