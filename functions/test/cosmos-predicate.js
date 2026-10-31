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
 *   - `NOT IS_DEFINED(c.X)`, `IS_NULL(c.X)` and `NOT IS_STRING(c.X)`;
 *   - with `parameters` given (the `[{ name, value }]` list queryDocs takes):
 *     `c.X <op> @name` for `=`, `!=`, `<`, `<=`, `>` and `>=`, and
 *     `ARRAY_CONTAINS(@name, c.X)`. A name with no value throws. Comparing
 *     values of two different types, or a missing field, is undefined, as in
 *     Cosmos, and so not a match (the visitor sessions' queries, #1403 item 8).
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

/** The literals of an IN list. */
const listOf = (raw) => raw.split(',').map(literal);

/** The value of `@name` in a queryDocs parameter list; a name with none throws. */
const parameterValue = (parameters, name) => {
  const found = parameters.find((p) => p.name === name);
  if (!found) throw new Error(`the query names ${name} and no parameter gives it`);
  return found.value;
};

/** Cosmos compares only values of one type; anything else (a missing field included) is undefined. */
const comparable = (a, b) =>
  a !== undefined && b !== undefined && a !== null && b !== null && typeof a === typeof b && typeof a !== 'object';

const COMPARE = {
  '=': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

/**
 * One OR operand's truth for `doc`, in the shapes the header lists; any other
 * shape throws, so a term this cannot read never passes silently.
 */
function term(text, doc, parameters) {
  const t = text.trim();
  let m = /^ARRAY_CONTAINS\((@\w+), c\.(\w+)\)$/.exec(t);
  if (m) {
    const list = parameterValue(parameters, m[1]);
    if (!Array.isArray(list)) throw new Error(`${m[1]} is not a list`);
    return doc[m[2]] !== undefined && list.includes(doc[m[2]]);
  }
  m = /^c\.(\w+) (=|!=|<=|>=|<|>) (@\w+)$/.exec(t);
  if (m) {
    const value = parameterValue(parameters, m[3]);
    return comparable(doc[m[1]], value) && COMPARE[m[2]](doc[m[1]], value);
  }
  m = /^NOT \(c\.(\w+) IN \((.*)\)\)$/.exec(t);
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
 * @param {Array<{ name: string, value: unknown }>} [parameters] the query's parameters
 * @returns {boolean} whether Cosmos would return the document
 */
export function evaluatePredicate(predicate, doc, parameters = []) {
  return predicate.split(/\s+AND\s+/).every((conjunct) => {
    const body = conjunct.trim().replace(/^\((.*)\)$/s, '$1');
    return body.split(/\s+OR\s+/).some((part) => term(part, doc, parameters));
  });
}

/**
 * Run a whole `SELECT * FROM c WHERE ...` against a container's documents,
 * with its parameters, as the `query` option of test/memory-store.js takes it:
 * `({ query, parameters, docs }) => rows`. Any other shape of query throws, so
 * a query that grows a form this does not read fails its test.
 */
export function runCosmosQuery({ query, parameters = [], docs }) {
  const m = /^SELECT \* FROM c WHERE (.+)$/s.exec(String(query).trim());
  if (!m) throw new Error(`unreadable query ${query}`);
  return docs.filter((doc) => evaluatePredicate(m[1], doc, parameters));
}
