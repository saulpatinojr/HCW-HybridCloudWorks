/**
 * Everything the Functions source asks of a client identity is something the
 * real helper has (#1387).
 *
 * The visitor lab sessions called `identity.fromRequest(request)`. The helper
 * `createClientIdentity()` returns an object with `anonymousKey(request)`,
 * `trustedClientIp(request)`, `viaCloudflare(request)` and `rateLimitKey(...)`
 * and has never had a `fromRequest`, so in production the call was skipped
 * (`identity?.fromRequest ? ... : null`) and every visitor was the same
 * person. The tests passed because they handed the code a hand-written
 * identity that did have the method: the code and its stand-in agreed with
 * each other and neither was the real thing.
 *
 * Three checks keep that from happening unseen, the same way
 * replace-doc-if-match-calls.test.js does for #1383:
 *  1. The names. This reads all of the Functions source and fails any property
 *     read from an `identity` that the real helper does not have, naming the
 *     file and line. The list of names is taken from the real object built
 *     here, never typed out in this file, so a method added to or removed from
 *     the helper is followed without an edit.
 *  2. The arguments. Every method takes the request. A call with none
 *     (`client.anonymousKey()`, as the old code made) cannot work.
 *  3. The stand-ins. A test that writes its own `identity = { ... }` may only
 *     give it methods the real helper has, so a stand-in cannot drift from the
 *     real thing the way the one in #1387 did (and the one the lab-start
 *     counter's tests were written with, until they were moved to the real
 *     helper in the same change).
 *
 * The visitor routes are held by a stronger check as well, in
 * lib/labs/visitor-session.test.js: they run on the real helper wrapped so that
 * reading any property it lacks throws, whatever the code calls the variable.
 *
 * It is a blunt reading of the text, not a parser, and errs towards failing: a
 * line it cannot tell apart from a mistake is reported with its place, and the
 * answer is to fix the call or to add the file to KNOWN_OTHER_IDENTITIES
 * with the reason. A call that no test reaches is still held to both.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClientIdentity } from './client-identity.js';

const SRC = path.resolve(import.meta.dirname, '..', '..');

/**
 * Files where a variable named `identity` is not a client identity, and the
 * properties read from it there. Each entry is checked to still be true (see
 * the last test), so this list cannot quietly go stale.
 */
const KNOWN_OTHER_IDENTITIES = Object.freeze({
  // The verified token's claims (the caller's oid, sub, scp and roles).
  'lib/auth/require-agent.js': ['oid', 'sub', 'scp', 'roles'],
});

/**
 * What a test's own `identity = { ... }` may hold besides the real helper's
 * methods: a verified token's claims, which some tests also call `identity`.
 */
const CLAIM_NAMES = ['oid', 'sub', 'scp', 'roles'];

/** The methods that take the request, and so are never called with nothing. */
const REQUEST_METHODS = ['anonymousKey', 'trustedClientIp', 'viaCloudflare', 'rateLimitKey'];

function* filesUnder(dir, wanted) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* filesUnder(full, wanted);
    } else if (wanted(entry.name)) {
      yield full;
    }
  }
}

const sourceFiles = (dir) =>
  filesUnder(dir, (name) => name.endsWith('.js') && !name.endsWith('.test.js'));
const testFiles = (dir) => filesUnder(dir, (name) => name.endsWith('.test.js'));

/**
 * The code of a source text, without the lines that are only a comment and
 * without a trailing `// ...` comment (when nothing before it is quoted).
 * Line numbers are kept: a dropped line becomes an empty one.
 */
function codeOf(source) {
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return '';
      const cut = line.indexOf(' //');
      return cut !== -1 && !/['"`]/.test(line.slice(0, cut)) ? line.slice(0, cut) : line;
    })
    .join('\n');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Every property read from something named `identity` in a source text:
 * `identity.x`, `identity?.x`, `deps.identity.x`, `identity['x']` and
 * `const { x } = identity`, with the line each is on.
 */
function identityReads(source) {
  const code = codeOf(source);
  const reads = [];
  for (const match of code.matchAll(/(?<![\w$/-])identity\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g)) {
    reads.push({ name: match[1], line: lineOf(code, match.index) });
  }
  for (const match of code.matchAll(/(?<![\w$/-])identity\s*(?:\?\.)?\[\s*(['"`])([^'"`]+)\1\s*\]/g)) {
    reads.push({ name: match[2], line: lineOf(code, match.index) });
  }
  for (const match of code.matchAll(/\{([^{}]*)\}\s*=\s*(?:[\w$]+\s*\.\s*)*identity(?![\w$.-])/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().replace(/^\.\.\./, '').split(/[:=\s]/)[0];
      if (name) reads.push({ name, line: lineOf(code, match.index) });
    }
  }
  return reads;
}

/**
 * The keys of every object literal written as `identity = { ... }` or
 * `identity: { ... }`: a test's own stand-in for the identity, with the line it
 * starts on. Keys are read at the top level of the braces only.
 */
function standInKeys(source) {
  const code = codeOf(source);
  const found = [];
  for (const match of code.matchAll(/(?<![\w$/-])identity\s*[:=]\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let part = '';
    const parts = [];
    for (let i = open; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        const end = code.indexOf(ch, i + 1);
        part += code.slice(i, end === -1 ? code.length : end + 1);
        i = end === -1 ? code.length : end;
        continue;
      }
      if ('{(['.includes(ch)) depth += 1;
      if ('})]'.includes(ch)) depth -= 1;
      if (depth === 0) break;
      if (ch === ',' && depth === 1) {
        parts.push(part);
        part = '';
      } else if (!(depth === 1 && i === open)) {
        part += ch;
      }
    }
    parts.push(part);
    for (const entry of parts) {
      const key = entry.trim().match(/^(?:\.\.\.)?(?:['"`]([^'"`]+)['"`]|([A-Za-z_$][\w$]*))/);
      if (key) found.push({ name: key[1] ?? key[2], line: lineOf(code, match.index) });
    }
  }
  return found;
}

/** Calls of a method that takes the request, made with nothing in the brackets. */
function callsWithoutTheRequest(source) {
  const code = codeOf(source);
  const pattern = new RegExp(`\\.(${REQUEST_METHODS.join('|')})\\s*(?:\\?\\.)?\\(\\s*\\)`, 'g');
  return [...code.matchAll(pattern)].map((match) => ({ name: match[1], line: lineOf(code, match.index) }));
}

describe('what the Functions source asks of a client identity (#1387)', () => {
  const real = createClientIdentity({ originSecret: 'origin-secret', ipSalt: 'salt' });
  const methods = Object.keys(real);

  const files = [...sourceFiles(SRC)].map((file) => ({
    file: path.relative(SRC, file).replaceAll('\\', '/'),
    source: readFileSync(file, 'utf8'),
  }));
  const reads = files.flatMap(({ file, source }) => identityReads(source).map((read) => ({ ...read, file })));

  it('is checking against the real helper: it has the methods the routes use, and no fromRequest', () => {
    expect(methods).toEqual(expect.arrayContaining(['anonymousKey', 'trustedClientIp', 'viaCloudflare']));
    expect(methods).not.toContain('fromRequest');
    // client-identity.js's own `identity` object is the helper itself, so it is not a caller.
    expect(files.find(({ file }) => file === 'lib/auth/client-identity.js')).toBeDefined();
  });

  it('finds the reads it is meant to hold (a sweep that finds nothing is not a pass)', () => {
    expect(reads.length).toBeGreaterThan(6);
    const readIn = (file) => reads.filter((read) => read.file === file).map((read) => read.name);
    expect(readIn('lib/labs/visitor-session.js')).toEqual(expect.arrayContaining(['anonymousKey', 'trustedClientIp']));
    expect(readIn('lib/labs/public-submit.js')).toEqual(expect.arrayContaining(['anonymousKey', 'trustedClientIp']));
    expect(readIn('lib/newsletter/handlers.js')).toContain('anonymousKey');
  });

  it('reads no property from an identity that the real helper lacks', () => {
    const problems = reads
      .filter(({ file, name }) => !methods.includes(name) && !KNOWN_OTHER_IDENTITIES[file]?.includes(name))
      .map(
        ({ file, line, name }) =>
          `${file}:${line}: identity.${name} is not a method of createClientIdentity() (it has: ${methods.join(', ')})`
      );
    expect(problems).toEqual([]);
  });

  it('calls no method that takes the request with nothing', () => {
    const problems = files.flatMap(({ file, source }) =>
      callsWithoutTheRequest(source).map(
        ({ line, name }) => `${file}:${line}: ${name}() is called without the request it reads the caller from`
      )
    );
    expect(problems).toEqual([]);
  });

  it('gives no test a stand-in identity with a method the real helper lacks', () => {
    const tests = [...testFiles(SRC)]
      .map((file) => ({ file: path.relative(SRC, file).replaceAll('\\', '/'), source: readFileSync(file, 'utf8') }))
      // This file quotes the old stand-in on purpose, to show the check finds it.
      .filter(({ file }) => file !== 'lib/auth/client-identity-calls.test.js');
    const standIns = tests.flatMap(({ file, source }) => standInKeys(source).map((key) => ({ ...key, file })));
    // The sweep must have found the stand-ins that exist (the explain, StreamYard and lab tests have one each).
    expect(standIns.filter(({ name }) => name === 'anonymousKey').length).toBeGreaterThan(3);

    const problems = standIns
      .filter(({ name }) => !methods.includes(name) && !CLAIM_NAMES.includes(name))
      .map(({ file, line, name }) => `${file}:${line}: a stand-in identity has ${name}, which createClientIdentity() does not`);
    expect(problems).toEqual([]);
  });

  it('keeps the list of other identities true: each file still exists and still reads those properties', () => {
    for (const [file, names] of Object.entries(KNOWN_OTHER_IDENTITIES)) {
      const entry = files.find((candidate) => candidate.file === file);
      expect(entry, `${file} is listed in KNOWN_OTHER_IDENTITIES but is not in the source`).toBeDefined();
      const readNames = identityReads(entry.source).map((read) => read.name);
      for (const name of names) {
        expect(readNames, `${file} no longer reads identity.${name}; remove it from KNOWN_OTHER_IDENTITIES`).toContain(name);
      }
    }
  });

  describe('the check itself', () => {
    const namesIn = (text) => identityReads(text).map((read) => read.name);

    it("finds the visitor sessions' old call, in the forms it was written", () => {
      expect(namesIn('const client = identity?.fromRequest ? identity.fromRequest(request) : null;')).toEqual([
        'fromRequest',
        'fromRequest',
      ]);
      expect(namesIn('const c = deps.identity.fromRequest(request);')).toEqual(['fromRequest']);
      expect(namesIn("const c = identity['fromRequest'](request);")).toEqual(['fromRequest']);
      expect(namesIn('const c = identity?.["fromRequest"]?.(request);')).toEqual(['fromRequest']);
    });

    it('finds a method taken out of the identity by destructuring', () => {
      expect(namesIn('const { fromRequest } = identity;')).toEqual(['fromRequest']);
      expect(namesIn('const { anonymousKey, fromRequest: from, ...rest } = deps.identity;')).toEqual([
        'anonymousKey',
        'fromRequest',
        'rest',
      ]);
      expect(namesIn('const {\n  anonymousKey,\n  fromRequest,\n} = identity;')).toEqual(['anonymousKey', 'fromRequest']);
    });

    it('reads the calls the routes make as the real methods', () => {
      expect(namesIn('state.clientKey = identity.anonymousKey(state.request).key;')).toEqual(['anonymousKey']);
      expect(namesIn('state.remoteIp = identity.trustedClientIp?.(state.request) ?? null;')).toEqual(['trustedClientIp']);
    });

    it('does not read a comment as code', () => {
      expect(namesIn('// identity.fromRequest(request)\n/* identity.fromRequest */\n * identity.fromRequest()')).toEqual([]);
      expect(namesIn('const k = identity.anonymousKey(request); // not identity.fromRequest')).toEqual(['anonymousKey']);
    });

    it('does not read other names that merely contain "identity"', () => {
      expect(namesIn('const a = adminIdentity.fromRequest(r); const b = identityMap.get(x);')).toEqual([]);
      expect(namesIn("import { resolvedSetting } from '../auth/client-identity.js';")).toEqual([]);
      expect(namesIn("import { handlers } from './admin-identity.js'; import x from '../identity.js';")).toEqual([]);
    });

    it('finds the keys of a test\'s own stand-in identity, and refuses the old one', () => {
      const keysIn = (text) => standInKeys(text).map((key) => key.name);
      expect(keysIn('const identity = { fromRequest: () => ({ anonymousKey: () => client }) };')).toEqual(['fromRequest']);
      expect(keysIn('createHandlers({ identity: { anonymousKey: vi.fn(() => ({ key: "k" })), trustedClientIp: () => null }, store })')).toEqual([
        'anonymousKey',
        'trustedClientIp',
      ]);
      expect(keysIn("handlers({ identity: { 'fromRequest': () => 1, oid }, other: { x: 1 } })")).toEqual(['fromRequest', 'oid']);
      expect(keysIn('const identity = createClientIdentity({ originSecret: "s" });')).toEqual([]);
    });

    it('reports where it found a read', () => {
      expect(identityReads('const a = 1;\n\nidentity.fromRequest(r);')).toEqual([{ name: 'fromRequest', line: 3 }]);
    });

    it("finds a call made with no request, as the old code's client.anonymousKey() was", () => {
      expect(callsWithoutTheRequest('const h = client.anonymousKey();')).toEqual([{ name: 'anonymousKey', line: 1 }]);
      expect(callsWithoutTheRequest('const ip = client?.trustedClientIp ? client.trustedClientIp() : null;')).toEqual([
        { name: 'trustedClientIp', line: 1 },
      ]);
      expect(callsWithoutTheRequest('x.trustedClientIp?.( )')).toEqual([{ name: 'trustedClientIp', line: 1 }]);
      expect(callsWithoutTheRequest('const k = identity.rateLimitKey();')).toEqual([{ name: 'rateLimitKey', line: 1 }]);
    });

    it('accepts a call that passes the request, and a mention in a comment', () => {
      expect(callsWithoutTheRequest('identity.anonymousKey(request).key;')).toEqual([]);
      expect(callsWithoutTheRequest('identity.trustedClientIp(state.request);')).toEqual([]);
      expect(callsWithoutTheRequest('// call identity.anonymousKey() with the request')).toEqual([]);
    });
  });
});
