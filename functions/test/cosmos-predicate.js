/**
 * Evaluate the WHERE predicates the public reads and the content manifest run,
 * as written, against one document. A test cannot run Cosmos SQL
 * (test/memory-store.js), and a predicate checked only as a string says
 * nothing about which documents it lets through.
 *
 * Only the forms those predicates use are understood, and anything else
 * throws, so a predicate that grows a new form fails its test rather than
 * being skipped by it:
 *
 *   - conjuncts joined by AND, each a parenthesized group of terms joined by
 *     OR, or a single term;
 *   - `c.X = literal` (true, false, a number or a quoted string);
 *   - `c.X IN (literal, ...)` and `NOT (c.X IN (literal, ...))`;
 *   - `NOT IS_DEFINED(c.X)`, `IS_NULL(c.X)` and `NOT IS_STRING(c.X)`.
 *
 * Cosmos's third truth value is kept where it can change an answer: a
 * comparison with a field the document does not carry is undefined, which a
 * WHERE treats as false, and NOT of undefined is still undefined. So
 * `NOT (c.X IN (...))` on a missing field is false here too, as it is there.
 *
 * Moved here from cms/drafts.test.js, which understood OR groups only, when
 * the manifest's predicate became the public clause joined by AND (AP-F13,
 * #937).
 */

const literal = (raw) => {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (!quoted) throw new Error(`unreadable literal ${value}`);
  return quoted[2];
};

const listOf = (raw) => raw.split(',').map(literal);

function term(text, doc) {
  const t = text.trim();
  let m = /^NOT \(c\.(\w+) IN \((.*)\)\)$/.exec(t);
  if (m) return doc[m[1]] !== undefined && !listOf(m[2]).includes(doc[m[1]]);
  m = /^c\.(\w+) IN \((.*)\)$/.exec(t);
  if (m) return listOf(m[2]).includes(doc[m[1]]);
  m = /^c\.(\w+) = (.+)$/.exec(t);
  if (m) return doc[m[1]] === literal(m[2]);
  m = /^NOT IS_DEFINED\(c\.(\w+)\)$/.exec(t);
  if (m) return doc[m[1]] === undefined;
  m = /^IS_NULL\(c\.(\w+)\)$/.exec(t);
  if (m) return doc[m[1]] === null;
  m = /^NOT IS_STRING\(c\.(\w+)\)$/.exec(t);
  if (m) return typeof doc[m[1]] !== 'string';
  throw new Error(`unreadable predicate term ${t}`);
}

/**
 * @param {string} predicate a WHERE clause, without the WHERE
 * @param {object} doc
 * @returns {boolean} whether Cosmos would return the document
 */
export function evaluatePredicate(predicate, doc) {
  return predicate.split(/\s+AND\s+/).every((conjunct) => {
    const body = conjunct.trim().replace(/^\((.*)\)$/s, '$1');
    return body.split(/\s+OR\s+/).some((part) => term(part, doc));
  });
}
