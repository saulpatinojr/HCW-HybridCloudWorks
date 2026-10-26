/**
 * Every `replaceDocIfMatch(...)` call in the Functions source has the shape the
 * function takes (#1383).
 *
 * The runtime check in cosmos-call-shape.js refuses a mis-shaped call when it
 * is made, but only a call that runs can be refused. The visitor sessions' two
 * wrong calls were in the stop route and the reaper, code a test run reaches
 * only if someone wrote the test; this reads all of the source, so a call that
 * no test reaches is still held to the shape. It is deliberately a blunt
 * reading of the text, not a parser: it takes each call's arguments apart and
 * refuses the mistakes that have actually been made.
 *
 * What it refuses, with the message to act on:
 *  - more than three arguments (the old shape had four: container, id, document, ETag);
 *  - a second argument that is a string, or is named like an id (`session.id`, `jobId`),
 *    because the second argument is the document;
 *  - a third argument that is a string or an ETag (`doc._etag`): it is the options
 *    object `{ partitionKey }`, or a name holding one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '..');

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* sourceFiles(full);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      yield full;
    }
  }
}

/** The index just past the string literal that starts at `i`. */
function skipQuoted(source, i, quote) {
  let j = i + 1;
  while (j < source.length && source[j] !== quote) j += source[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** The index just past the template literal that starts at `i`, `${...}` included. */
function skipTemplate(source, i) {
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === '\\') j += 2;
    else if (source[j] === '`') return j + 1;
    else if (source[j] === '$' && source[j + 1] === '{') j = skipBraces(source, j + 2);
    else j += 1;
  }
  return j;
}

/** The index just past the `}` that closes a `${` whose contents start at `i`. */
function skipBraces(source, i) {
  let depth = 1;
  let j = i;
  while (j < source.length && depth > 0) {
    const ch = source[j];
    if (ch === "'" || ch === '"') j = skipQuoted(source, j, ch);
    else if (ch === '`') j = skipTemplate(source, j);
    else {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      j += 1;
    }
  }
  return j;
}

/**
 * The top-level arguments of the call whose `(` is at `open`, trimmed, with
 * comments left out. Only the call's own span is read, never a whole file, so
 * nothing outside it (a regular expression holding a quote, say) can derail it.
 */
function argumentsAt(source, open) {
  const args = [];
  let current = '';
  let depth = 0;
  let i = open + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const end = ch === '`' ? skipTemplate(source, i) : skipQuoted(source, i, ch);
      current += source.slice(i, end);
      i = end;
    } else if (depth === 0 && ch === ')') {
      args.push(current.trim());
      // A trailing comma leaves an empty last argument; it is not one.
      return args.length > 1 && args.at(-1) === '' ? args.slice(0, -1) : args;
    } else if (depth === 0 && ch === ',') {
      args.push(current.trim());
      current = '';
      i += 1;
    } else {
      if ('([{'.includes(ch)) depth += 1;
      if (')]}'.includes(ch)) depth -= 1;
      current += ch;
      i += 1;
    }
  }
  throw new Error('a replaceDocIfMatch call is not closed');
}

/**
 * Every call to `replaceDocIfMatch` (`store.replaceDocIfMatch(...)`, `x?.(...)`
 * or an imported bare name) in a source text, with its line and arguments.
 * Not the function's own definition, and not a call quoted in a comment on a
 * line of its own or after code. A call quoted inside a block comment on a line
 * that does not start with `*` would be read as a call; the test then fails and
 * says where, which is the safe side to be wrong on.
 */
function replaceDocIfMatchCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/(?<![\w$])replaceDocIfMatch\s*(?:\?\.)?\s*\(/g)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const before = source.slice(lineStart, match.index);
    if (/\bfunction\s*\*?\s*$/.test(before)) continue; // the definition
    if (/^\s*(\/\/|\/\*|\*)/.test(before)) continue; // quoted in a comment
    if (/\/\//.test(before.replace(/(['"`])(?:\.|(?!\1).)*\1/g, ''))) continue; // after `//`, outside any string
    const open = match.index + match[0].length - 1;
    calls.push({ line: source.slice(0, match.index).split('\n').length, args: argumentsAt(source, open) });
  }
  return calls;
}

const isString = (arg) => /^['"`]/.test(arg);
const namedLikeAnId = (arg) => /(^|\.)id$|[a-z]Id$/.test(arg);

/** Why a call is not shaped like `(containerName, document, options)`, or null. */
function problemWith({ args }) {
  if (args.length < 2 || args.length > 3) {
    return `it has ${args.length} arguments; replaceDocIfMatch takes (containerName, document, options)`;
  }
  const [, document, options] = args;
  if (isString(document) || namedLikeAnId(document)) {
    return `its second argument (${document}) is an id; it is the whole document, with its _etag inside`;
  }
  const isOptionsLike = options?.startsWith('{') || /^[A-Za-z_$][\w$]*$/.test(options ?? '');
  if (options !== undefined && (!isOptionsLike || /etag/i.test(options))) {
    return `its third argument (${options}) is not the options object { partitionKey } or a name holding one`;
  }
  return null;
}

describe('replaceDocIfMatch calls in the Functions source (#1383)', () => {
  const calls = [];
  for (const file of sourceFiles(SRC)) {
    for (const call of replaceDocIfMatchCalls(readFileSync(file, 'utf8'))) {
      calls.push({ ...call, file: path.relative(SRC, file).replaceAll('\\', '/') });
    }
  }

  it('finds the calls it is meant to hold to the shape (a sweep that finds nothing is not a pass)', () => {
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.map((c) => c.file)).toContain('lib/labs/visitor-session.js');
  });

  it('has none that is shaped otherwise', () => {
    const problems = calls
      .map((call) => ({ call, problem: problemWith(call) }))
      .filter(({ problem }) => problem)
      .map(({ call, problem }) => `${call.file}:${call.line}: ${problem}`);
    expect(problems).toEqual([]);
  });

  describe('the check itself', () => {
    const problemOf = (text) => {
      const [call] = replaceDocIfMatchCalls(text);
      return problemWith(call);
    };

    it("refuses the visitor sessions' old call, in the forms it was written", () => {
      expect(
        problemOf(
          "await store.replaceDocIfMatch('lab_jobs', session.id, { ...session, status: 'expired' }, session._etag);"
        )
      ).toMatch(/4 arguments/);
      expect(problemOf("await store.replaceDocIfMatch('lab_jobs', sessionId, { ...doc, status: 'ended' })")).toMatch(
        /second argument \(sessionId\) is an id/
      );
      expect(problemOf("await store.replaceDocIfMatch('lab_jobs', session.id, doc)")).toMatch(/is an id/);
      expect(problemOf("await store.replaceDocIfMatch('lab_jobs', 'sess-1', doc)")).toMatch(/is an id/);
    });

    it('refuses an ETag or a bare key as the options', () => {
      expect(problemOf("store.replaceDocIfMatch('lab_jobs', doc, doc._etag)")).toMatch(/third argument/);
      expect(problemOf("store.replaceDocIfMatch('lab_jobs', doc, etag)")).toMatch(/third argument/);
      expect(problemOf("store.replaceDocIfMatch('lab_jobs', doc, 'sess-1')")).toMatch(/third argument/);
    });

    it('reads a call made with optional chaining or by its imported name', () => {
      expect(problemOf("await store.replaceDocIfMatch?.('lab_jobs', session.id, doc, etag)")).toMatch(/4 arguments/);
      expect(problemOf("await replaceDocIfMatch('lab_jobs', session.id, doc, etag)")).toMatch(/4 arguments/);
      expect(problemOf("await replaceDocIfMatch('lab_jobs', doc, options)")).toBeNull();
    });

    it("does not read the function's own definition as a call", () => {
      expect(replaceDocIfMatchCalls('export async function replaceDocIfMatch(containerName, document, options = {}) {')).toEqual([]);
    });

    it('accepts the shapes in use', () => {
      expect(problemOf("store.replaceDocIfMatch('newsletters', doc)")).toBeNull();
      expect(problemOf("store.replaceDocIfMatch('newsletters', { ...next, _etag: current._etag })")).toBeNull();
      expect(
        problemOf("store.replaceDocIfMatch(\n  'lab_jobs',\n  { ...job, status: 'x' },\n  { partitionKey: job.id }\n)")
      ).toBeNull();
      expect(problemOf('store.replaceDocIfMatch(CONTAINER, { ...next, _etag: current._etag }, PK)')).toBeNull();
      expect(problemOf('store.replaceDocIfMatch(CONTAINER, { ...next }, partition)')).toBeNull();
      expect(
        problemOf("store.replaceDocIfMatch('c', { ...d, note: `a, b (${x(1, 2)})` }, { partitionKey: 'p' },)")
      ).toBeNull();
    });

    it('does not read a call quoted in a comment as a call', () => {
      expect(replaceDocIfMatchCalls("// store.replaceDocIfMatch('a', id, d, e)\n/* x.replaceDocIfMatch(1) */")).toEqual([]);
      expect(replaceDocIfMatchCalls("/**\n * Calls store.replaceDocIfMatch('a', id, d, e).\n */")).toEqual([]);
      expect(replaceDocIfMatchCalls("await save(); // not store.replaceDocIfMatch('a', id, d, e)")).toEqual([]);
    });

    it('ignores a comment inside the arguments', () => {
      expect(
        problemOf("store.replaceDocIfMatch('c', // the whole document, (not an id)\n  { ...d },\n  /* pk, */ { partitionKey: 'p' })")
      ).toBeNull();
    });
  });
});
