/**
 * A job document's payload is bounded by its type's `maxPayloadBytes` at
 * every door (#942 follow-up), not only at POST /api/enqueueJob.
 *
 * The sweeper reads whole job documents (#1198), which is cheap only while
 * that bound holds. enqueueJob enforced it; the routes, the
 * Forge Studio queue, the Cosmos export scheduler and the Telegram /approve
 * command wrote job documents of their own, and two of them as object
 * literals that checked nothing. newJobDoc now enforces the bound, and this
 * file holds both halves: what newJobDoc refuses, and that every write of a
 * new job document under src/ goes through it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jobPayloadBytes, newJobDoc, registerJobType, resetJobTypes } from './jobs.js';

const fields = (payload, over = {}) => ({
  id: 'job-1',
  type: 'noop',
  payload,
  requestedBy: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  ...over,
});

afterEach(() => resetJobTypes());

describe('newJobDoc holds the payload bound', () => {
  it('refuses a payload over its registered type’s maxPayloadBytes, with a 413', () => {
    // noop is registered with a 1 KiB limit.
    const over = { echo: 'x'.repeat(1100) };
    expect(() => newJobDoc(fields(over))).toThrow(/Payload too large \(\d+ bytes; max 1024 for noop\)/);
    try {
      newJobDoc(fields(over));
    } catch (error) {
      expect(error).toMatchObject({ code: 'JOB_PAYLOAD_TOO_LARGE', status: 413 });
    }
  });

  it('accepts a payload of exactly the limit, measured in UTF-8 bytes of its JSON', () => {
    registerJobType('bounded', { role: 'editor', worker: async () => {}, maxPayloadBytes: 20 });
    const fits = { a: 'é'.repeat(6) };
    expect(jobPayloadBytes(fits)).toBe(20);
    expect(newJobDoc(fields(fits, { type: 'bounded' }))).toMatchObject({ status: 'queued', payload: fits });
    expect(() => newJobDoc(fields({ a: 'é'.repeat(7) }, { type: 'bounded' }))).toThrow(/max 20/);
  });

  it('takes a limit it is given over the registry’s, and the 64 KiB default for an unregistered type', () => {
    expect(() => newJobDoc(fields({ a: 'x'.repeat(50) }, { maxPayloadBytes: 16 }))).toThrow(/max 16/);
    const big = { a: 'x'.repeat(60 * 1024) };
    expect(newJobDoc(fields(big, { type: 'not-registered-here' })).payload).toBe(big);
    expect(() => newJobDoc(fields({ a: 'x'.repeat(65 * 1024) }, { type: 'not-registered-here' }))).toThrow(
      /max 65536/
    );
  });

  it('measures an absent payload as null, and stores it as given (jobPayloadBytes JSDoc)', () => {
    expect(jobPayloadBytes(undefined)).toBe(4);
    expect(newJobDoc(fields(undefined)).payload).toBeUndefined();
  });
});

describe('every new job document under src/ is built by newJobDoc', () => {
  const SRC = new URL('../', import.meta.url);
  /** Every .js file under `dir`, tests excluded. */
  const sourceFiles = (dir = SRC) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, dir));
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) return [];
      return [new URL(entry.name, dir)];
    });
  const name = (file) => fileURLToPath(file).slice(fileURLToPath(SRC).length).replace(/\\/g, '/');

  /** Source with its comments removed; strings stay, since the container may be a 'jobs' literal. */
  const withoutComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

  /**
   * The top-level arguments of the call whose `(` is at `open`, as trimmed
   * source text, or null when the parenthesis never closes. Nested brackets
   * and string literals are stepped over whole.
   */
  function callArguments(code, open) {
    const args = [];
    let depth = 0;
    let start = open + 1;
    for (let i = open; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        for (i += 1; i < code.length && code[i] !== ch; i += 1) if (code[i] === '\\') i += 1;
      } else if ('([{'.includes(ch)) {
        depth += 1;
      } else if (')]}'.includes(ch)) {
        depth -= 1;
        if (depth === 0) {
          args.push(code.slice(start, i).trim());
          return args.filter((arg) => arg !== '');
        }
      } else if (ch === ',' && depth === 1) {
        args.push(code.slice(start, i).trim());
        start = i + 1;
      }
    }
    return null;
  }

  /**
   * Every write of a document to the jobs container in `text`, and whether
   * newJobDoc built its document. The container counts as the jobs container
   * when it is `JOBS_CONTAINER`, a `'jobs'` literal, or a name this file
   * binds to one. The document counts as built when it is a call to
   * newJobDoc, or to a builder this file defines as returning one, or a name
   * whose last assignment before the write is such a call. Importing
   * newJobDoc is not enough: a separately built object fails here.
   *
   * @param {string} text a module's source
   * @returns {{ write: string, built: boolean }[]} each write, abbreviated
   */
  function jobWritesIn(text) {
    const code = withoutComments(text);
    const containers = new Set(['JOBS_CONTAINER']);
    for (const [, local] of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(['"`])jobs\2/g)) {
      containers.add(local);
    }
    // A local builder: `const f = (…) => newJobDoc(…)` or `function f(…) { return newJobDoc(…) }`.
    const builders = new Set(['newJobDoc']);
    const builderForms = [
      /\b(?:const|let|var)\s+([\w$]+)\s*=\s*\([^)]*\)\s*=>\s*newJobDoc\s*\(/g,
      /\bfunction\s+([\w$]+)\s*\([^)]*\)\s*\{\s*return\s+newJobDoc\s*\(/g,
    ];
    for (const form of builderForms) {
      for (const [, builder] of code.matchAll(form)) builders.add(builder);
    }
    const isBuilt = (expression) =>
      [...builders].some((builder) => new RegExp(`^${builder}\\s*\\(`).test(expression));

    /** Is `document`, at the write starting at `at`, a job document newJobDoc built? */
    const builtAt = (document, at) => {
      if (isBuilt(document)) return true;
      if (!/^[\w$]+$/.test(document)) return false;
      const assignments = [
        ...code.slice(0, at).matchAll(new RegExp(`(?:^|[^\\w$.])${document}\\s*=(?![=>])\\s*`, 'g')),
      ];
      const last = assignments.at(-1);
      return Boolean(last) && isBuilt(code.slice(last.index + last[0].length));
    };

    const writes = [];
    for (const match of code.matchAll(/\b(upsertDoc|createDoc)\s*\(/g)) {
      const args = callArguments(code, match.index + match[0].length - 1);
      if (!args || args.length < 2) continue;
      const [container, document] = args;
      if (!containers.has(container) && !/^(['"`])jobs\1$/.test(container)) continue;
      writes.push({
        write: `${match[1]}(${container}, ${document.slice(0, 40)})`,
        built: builtAt(document, match.index),
      });
    }
    return writes;
  }

  /** The writes in `text` whose job document newJobDoc did not build. */
  const unboundJobWrites = (text) =>
    jobWritesIn(text)
      .filter(({ built }) => !built)
      .map(({ write }) => write);

  const sources = sourceFiles().map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  it('the check catches a jobs literal, a local name for it, and a separately built object', () => {
    const fixture = (body) => `import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';\n${body}`;
    // Refused: a 'jobs' literal, an alias of it, an object literal, and an
    // object built apart in a file that does import newJobDoc.
    expect(unboundJobWrites(fixture("await store.upsertDoc('jobs', { id, type });"))).toHaveLength(1);
    expect(unboundJobWrites(fixture('const Q = "jobs";\nawait store.createDoc(Q, { id });'))).toHaveLength(1);
    expect(unboundJobWrites(fixture('await store.upsertDoc(JOBS_CONTAINER, { id });'))).toHaveLength(1);
    expect(
      unboundJobWrites(fixture('const doc = { id, type, status: "queued" };\nawait store.upsertDoc(JOBS_CONTAINER, doc);'))
    ).toHaveLength(1);
    expect(
      unboundJobWrites(
        fixture('let doc = newJobDoc({ id });\ndoc = { ...doc, payload: big };\nawait store.upsertDoc(JOBS_CONTAINER, doc);')
      )
    ).toHaveLength(1);
    // Accepted: newJobDoc inline across lines, by name, and through a builder.
    expect(unboundJobWrites(fixture('await store.upsertDoc(\n  JOBS_CONTAINER,\n  newJobDoc({ id, type })\n);'))).toEqual([]);
    expect(unboundJobWrites(fixture("const doc = newJobDoc({ id });\nawait store.upsertDoc('jobs', doc);"))).toEqual([]);
    expect(
      unboundJobWrites(
        fixture('const jobFor = (item) =>\n  newJobDoc({ id: item.id });\nlet jobDoc;\njobDoc = jobFor(entry);\nawait store.upsertDoc(JOBS_CONTAINER, jobDoc);')
      )
    ).toEqual([]);
    // Not a jobs write at all, and a comment that only names one.
    expect(unboundJobWrites(fixture("await store.upsertDoc('content', { id });\n// upsertDoc('jobs', { id })"))).toEqual([]);
  });

  it('finds the writers', () => {
    // enqueueJob, the export scheduler, the Telegram command, the Forge
    // Studio queue, Listen & Learn, the podcast routes and recordings, the
    // publish step and the pricing refresh: one write in each of nine files.
    const writers = sources.filter(({ text }) => jobWritesIn(text).length > 0);
    expect(writers.length).toBeGreaterThanOrEqual(9);
  });

  it('every write of a job document under src/ builds it with newJobDoc', () => {
    const offending = sources.flatMap(({ file, text }) =>
      unboundJobWrites(text).map((write) => `${name(file)}: ${write}`)
    );
    expect(offending).toEqual([]);
  });
});
