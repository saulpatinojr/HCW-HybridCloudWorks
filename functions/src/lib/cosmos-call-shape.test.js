import { describe, expect, it } from 'vitest';
import { assertReplaceDocIfMatchCall, replaceDocIfMatchProblem } from './cosmos-call-shape.js';

const stored = () => ({ id: 'sess-1', _etag: '"e1"', status: 'active' });

describe('replaceDocIfMatch call shape (#1383)', () => {
  describe('accepts the shape cosmos-client.js defines', () => {
    it.each([
      ['no options', ['lab_jobs', stored()]],
      ['undefined options', ['lab_jobs', stored(), undefined]],
      ['empty options', ['lab_jobs', stored(), {}]],
      ['a partition key', ['admin_config', stored(), { partitionKey: 'admin_config' }]],
    ])('%s', (_name, args) => {
      expect(replaceDocIfMatchProblem(...args)).toBeNull();
      expect(() => assertReplaceDocIfMatchCall(...args)).not.toThrow();
    });
  });

  describe('refuses a mis-shaped call, with a TypeError that says what to pass', () => {
    it('refuses the visitor sessions\' old shape: (container, id, document, etag)', () => {
      const session = stored();
      // The fourth argument is not part of the call at all; the id where the document belongs is the fault.
      expect(() => assertReplaceDocIfMatchCall('lab_jobs', session.id, { ...session, status: 'ended' })).toThrow(
        TypeError
      );
      expect(() => assertReplaceDocIfMatchCall('lab_jobs', session.id, { ...session, status: 'ended' })).toThrow(
        /document must be the whole document.*not a string/
      );
    });

    it('refuses an options object that is really a document', () => {
      const session = stored();
      expect(replaceDocIfMatchProblem('lab_jobs', session, { ...session, status: 'ended' })).toMatch(
        /options has 3 field\(s\) other than partitionKey/
      );
    });

    it.each([
      ['a bare partition key', 'sess-1'],
      ['an ETag', '"e1"'],
      ['an array', ['sess-1']],
      ['null', null],
    ])('refuses %s as the options', (_name, options) => {
      expect(replaceDocIfMatchProblem('lab_jobs', stored(), options)).toMatch(/options must be an object/);
    });

    it.each([
      ['an id', 'sess-1', /not a string/],
      ['undefined', undefined, /not undefined/],
      ['null', null, /not null/],
      ['an array', [stored()], /not an array/],
    ])('refuses %s as the document', (_name, document, expected) => {
      expect(replaceDocIfMatchProblem('lab_jobs', document)).toMatch(expected);
    });

    it('refuses a document with no id', () => {
      expect(replaceDocIfMatchProblem('lab_jobs', { _etag: '"e1"' })).toMatch(/document\.id/);
      expect(replaceDocIfMatchProblem('lab_jobs', { id: '', _etag: '"e1"' })).toMatch(/document\.id/);
    });

    it('refuses a document with no ETag, because the replace would not be conditional', () => {
      expect(replaceDocIfMatchProblem('lab_jobs', { id: 'sess-1' })).toMatch(/document\._etag.*not conditional/);
      expect(replaceDocIfMatchProblem('lab_jobs', { id: 'sess-1', _etag: '' })).toMatch(/document\._etag/);
      expect(replaceDocIfMatchProblem('lab_jobs', { id: 'sess-1', _etag: 7 })).toMatch(/document\._etag/);
    });

    it('refuses a missing container name', () => {
      expect(replaceDocIfMatchProblem(undefined, stored())).toMatch(/containerName/);
      expect(replaceDocIfMatchProblem('', stored())).toMatch(/containerName/);
    });
  });

  it('never puts a value from the call into its message', () => {
    const secret = 'do-not-log-this-value';
    const calls = [
      ['lab_jobs', secret],
      ['lab_jobs', { id: secret, _etag: '' }],
      ['lab_jobs', { id: 'x', _etag: secret, [secret]: secret }, secret],
      ['lab_jobs', { id: 'x', _etag: secret }, { [secret]: secret }],
    ];
    for (const args of calls) {
      const problem = replaceDocIfMatchProblem(...args);
      expect(problem).toBeTruthy();
      expect(problem).not.toContain(secret);
    }
  });
});
