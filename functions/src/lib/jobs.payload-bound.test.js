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
  const writers = sourceFiles()
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => /\b(?:upsertDoc|createDoc)\(\s*JOBS_CONTAINER\b/.test(text));
  const name = (file) => fileURLToPath(file).slice(fileURLToPath(SRC).length).replace(/\\/g, '/');

  it('finds the writers', () => {
    // enqueueJob, the export scheduler, the Telegram command, the Forge
    // Studio queue, Listen & Learn, the podcast routes and the publish step.
    expect(writers.length).toBeGreaterThanOrEqual(7);
  });

  it('none writes an object literal to the jobs container', () => {
    const literal = /\b(?:upsertDoc|createDoc)\(\s*JOBS_CONTAINER\s*,\s*\{/;
    expect(writers.filter(({ text }) => literal.test(text)).map(({ file }) => name(file))).toEqual([]);
  });

  it('every one builds its document with newJobDoc', () => {
    const importsNewJobDoc = /import\s*\{[^}]*\bnewJobDoc\b[^}]*\}\s*from\s*['"][^'"]*\/jobs\.js['"]/;
    const missing = writers
      .filter(({ file, text }) => name(file) !== 'lib/jobs.js' && !importsNewJobDoc.test(text))
      .map(({ file }) => name(file));
    expect(missing).toEqual([]);
  });
});
