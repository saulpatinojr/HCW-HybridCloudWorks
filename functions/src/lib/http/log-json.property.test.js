/**
 * Property tests for `jsonForLog` (./log-json.js), the one way a whole value
 * is printed in a log line: `JSON.stringify` with every field named like a
 * stored id left out, at any depth.
 *
 * A property test states a rule that must hold for every input, and a
 * library (fast-check) makes up hundreds of inputs to try to break it. A
 * failure prints the smallest input found and a seed that replays the run.
 *
 * The values printed are summaries built from stored documents and from
 * answers of outside services, so their shape is not this module's to choose.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { jsonForLog } from './log-json.js';

const RUNS = { numRuns: 300 };

/**
 * The naming rule, written out a second time from the module's comment and
 * NOT imported from it: a test that used the module's own pattern would
 * agree with it whatever it said.
 */
const EXACT_ID_NAMES = ['id', 'ids', '_id', 'oid', 'sub', 'uid'];
const ID_ENDINGS = ['Id', 'Ids', 'ID', 'IDs'];
const RUN_REFERENCES = ['invocationId', 'correlationId'];
const namedLikeAnId = (name) => EXACT_ID_NAMES.includes(name) || ID_ENDINGS.some((ending) => name.endsWith(ending));

const idName = fc.oneof(
  fc.constantFrom(...EXACT_ID_NAMES, ...RUN_REFERENCES, 'contentId', 'jobIds', 'tenantID', 'refusedIDs', 'Id', 'ID'),
  fc.tuple(fc.string({ unit: 'binary', maxLength: 6 }), fc.constantFrom(...ID_ENDINGS)).map(([stem, ending]) => stem + ending)
);
const plainName = fc.oneof(
  fc.constantFrom('valid', 'paid', 'idle', 'identity', 'subject', 'kind', 'user_id', 'IDS', 'iD', 'attempted', 'error', '__proto__', 'toJSON'),
  fc.string({ unit: 'binary', maxLength: 8 })
);
const name = fc.oneof(idName, plainName);

/** Any JSON value, nested a few levels, with id-shaped names at every level. */
const { value: summary } = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.oneof(fc.string({ unit: 'binary', maxLength: 12 }), fc.integer(), fc.boolean(), fc.constant(null)),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.array(fc.tuple(name, tie('value')), { maxLength: 5 }).map((pairs) => Object.fromEntries(pairs))
  ),
}));

/** Every field name in a parsed JSON value, at any depth. */
function namesIn(value, found = []) {
  if (Array.isArray(value)) for (const item of value) namesIn(item, found);
  else if (value && typeof value === 'object') {
    for (const [key, field] of Object.entries(value)) {
      found.push(key);
      namesIn(field, found);
    }
  }
  return found;
}

/** The same value with the id fields taken out by plain recursion: what the answer should be. */
function withoutIds(value, kept) {
  if (Array.isArray(value)) return value.map((item) => withoutIds(item, kept));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !namedLikeAnId(key) || kept.includes(key))
      .map(([key, field]) => [key, withoutIds(field, kept)])
  );
}

describe('jsonForLog (property)', () => {
  // Rule 1: no field named like a stored id is in the printed text, at any
  // depth, except the two run reference numbers the host adds to every line.
  it('prints no field named like a stored id, at any depth', () => {
    fc.assert(
      fc.property(summary, (value) => {
        const printed = JSON.parse(jsonForLog(value));
        for (const key of namesIn(printed)) {
          if (!RUN_REFERENCES.includes(key)) expect(namedLikeAnId(key), key).toBe(false);
        }
      }),
      RUNS
    );
  });

  // Rule 2: nothing else is lost or changed. The printed text is exactly
  // what `JSON.stringify` prints for the same value with the id fields taken
  // out, and a name the caller asks to keep is kept.
  it('changes nothing else, and keeps a name the caller asks for', () => {
    fc.assert(
      fc.property(summary, fc.array(idName, { maxLength: 3 }), (value, keep) => {
        expect(jsonForLog(value, { keep })).toBe(JSON.stringify(withoutIds(value, [...RUN_REFERENCES, ...keep])));
      }),
      RUNS
    );
  });

  // Rule 3: an id under an id-shaped name does not reach the log as a
  // value either. Each id field holds a marker; the marker is not in the text.
  it('prints no value that was held under an id-shaped name', () => {
    const MARKER = 'SECRET-MARKER-7f3a';
    const marked = (value) => {
      if (Array.isArray(value)) return value.map(marked);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, field]) => [key, namedLikeAnId(key) && !RUN_REFERENCES.includes(key) ? MARKER : marked(field)])
      );
    };
    fc.assert(
      fc.property(summary, (value) => {
        expect(jsonForLog(marked(value))).not.toContain(MARKER);
      }),
      RUNS
    );
  });
});
