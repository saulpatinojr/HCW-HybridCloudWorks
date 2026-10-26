/**
 * The shape of a call to `replaceDocIfMatch(containerName, document, options)`
 * in cosmos-client.js, checked in one place (#1383).
 *
 * WHY THIS EXISTS. The visitor lab sessions called
 * `replaceDocIfMatch('lab_jobs', session.id, { ...session, status }, session._etag)`:
 * an id, the document, then the ETag. The real function takes the whole document
 * (its `id` and the `_etag` it was read with inside it) and an options object.
 * The call was wrong in production, and every test passed, because the tests'
 * own store had been written to the same wrong shape. A hand-written store
 * that agrees with the code under test proves nothing about the real one.
 *
 * So the check is a function of its own, and two things call it: the real
 * `replaceDocIfMatch`, which refuses a mis-shaped call before it reaches the
 * SDK, and `test/memory-store.js`, whose `replaceDocIfMatch` is the one the
 * tests share. A test that calls the store in the old shape now fails at the
 * call, with the message below, instead of passing against a fake.
 *
 * This file imports nothing, on purpose: the test store loads it, and it must
 * not drag the Cosmos SDK into every test that uses the store.
 *
 * The messages name types, never values: a document can hold personal or
 * secret data and an error message ends up in logs.
 */

/** The only field `replaceDocIfMatch` reads from its options. */
const OPTION_FIELDS = Object.freeze(['partitionKey']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const nonEmptyString = (value) => typeof value === 'string' && value !== '';

/** What a value is, for a message: its type, never its content. */
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'undefined' ? 'undefined' : `a ${typeof value}`;
}

/**
 * Why a call is not shaped like `replaceDocIfMatch(containerName, document, options)`,
 * or null when it is.
 *
 * @param {unknown} containerName
 * @param {unknown} document
 * @param {unknown} [options]
 * @returns {string | null}
 */
export function replaceDocIfMatchProblem(containerName, document, options) {
  if (!nonEmptyString(containerName)) {
    return `containerName must be the container's name (a non-empty string), not ${kindOf(containerName)}.`;
  }
  if (!isObject(document)) {
    return (
      `document must be the whole document, as an object that carries its id and the _etag it was read with, ` +
      `not ${kindOf(document)}. The second argument is not an id: pass { ...document, _etag } there, ` +
      `and the partition key in options.`
    );
  }
  if (!nonEmptyString(document.id)) {
    return 'document.id must be the document id (a non-empty string).';
  }
  if (!nonEmptyString(document._etag)) {
    return (
      'document._etag must be the ETag the document was read with (a non-empty string); ' +
      'without it the replace is not conditional.'
    );
  }
  if (options !== undefined) {
    if (!isObject(options)) {
      return (
        `options must be an object such as { partitionKey }, not ${kindOf(options)}. ` +
        'The ETag goes inside the document, not after it.'
      );
    }
    const unknown = Object.keys(options).filter((field) => !OPTION_FIELDS.includes(field));
    if (unknown.length > 0) {
      return (
        `options has ${unknown.length} field(s) other than ${OPTION_FIELDS.join(', ')}. ` +
        'A document goes in the second argument, not in options.'
      );
    }
  }
  return null;
}

/**
 * Throw a TypeError when a call is not shaped like
 * `replaceDocIfMatch(containerName, document, options)`.
 *
 * @param {unknown} containerName
 * @param {unknown} document
 * @param {unknown} [options]
 * @returns {void}
 * @throws {TypeError}
 */
export function assertReplaceDocIfMatchCall(containerName, document, options) {
  const problem = replaceDocIfMatchProblem(containerName, document, options);
  if (problem) throw new TypeError(`replaceDocIfMatch(containerName, document, options): ${problem}`);
}
