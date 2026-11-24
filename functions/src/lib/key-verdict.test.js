/**
 * The shared verdict path (#358).
 *
 * The reporter's rules are what the AI router used to hold privately and what
 * the Publer client and proxy now share. `router.test.js` proves the router
 * still behaves; this file proves the rules themselves, and that the
 * process-wide writer really reaches the secret-state document — through the
 * catalogue, under the vault name — and really dedupes per worker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The state document is written under its ETag since the review of #1030
// (admin-secrets.js updateSecretRecord): createDoc for the first write,
// replaceDocIfMatch after. readDoc answers null here, so every verdict below
// is a create, and `createDoc` is the write to look at.
vi.mock('./cosmos-client.js', () => ({
  ADMIN_CONFIG_PARTITION: 'admin',
  readDoc: vi.fn(async () => null),
  createDoc: vi.fn(async (_container, doc) => doc),
  replaceDocIfMatch: vi.fn(async (_container, doc) => doc),
}));

import { createKeyVerdictReporter, isCredentialRejected, recordKeyVerdict } from './key-verdict.js';
import { createDoc, readDoc } from './cosmos-client.js';

const quiet = () => ({ warn: vi.fn() });

describe('isCredentialRejected', () => {
  it('is true for exactly the statuses that say the credential is wrong', () => {
    expect(isCredentialRejected(401)).toBe(true);
    expect(isCredentialRejected(403)).toBe(true);
    expect(isCredentialRejected('401')).toBe(true);
  });

  it('is false for a wrong path, a busy account, a server fault, and nothing at all', () => {
    // A 404 is a wrong path or model id and a 429 a busy account; turning the
    // light red for those sends the operator rotating a key that is fine.
    for (const status of [200, 400, 404, 408, 429, 500, 503, undefined, null, NaN]) {
      expect(isCredentialRejected(status), `status ${status}`).toBe(false);
    }
  });
});

describe('createKeyVerdictReporter', () => {
  it('reports every failure', async () => {
    const onKeyVerdict = vi.fn();
    const report = createKeyVerdictReporter({ onKeyVerdict, log: quiet() });
    await report('PUBLER_API_KEY', { ok: false, status: 401 });
    await report('PUBLER_API_KEY', { ok: false, status: 401 });
    expect(onKeyVerdict).toHaveBeenCalledTimes(2);
    expect(onKeyVerdict).toHaveBeenCalledWith('PUBLER_API_KEY', { ok: false, status: 401 });
  });

  it('reports a success once per setting, however many follow', async () => {
    const onKeyVerdict = vi.fn();
    const report = createKeyVerdictReporter({ onKeyVerdict, log: quiet() });
    await report('PUBLER_API_KEY', { ok: true });
    await report('PUBLER_API_KEY', { ok: true });
    await report('GEMINI_API_KEY', { ok: true });
    await report('GEMINI_API_KEY', { ok: true });
    expect(onKeyVerdict.mock.calls).toEqual([
      ['PUBLER_API_KEY', { ok: true }],
      ['GEMINI_API_KEY', { ok: true }],
    ]);
  });

  it('re-arms the success report after a failure, so a rotated key turns the light green again', async () => {
    // Dedupe is for successes only, and only until something goes wrong. A key
    // that stops working must be able to say so, and the FIRST success after
    // that — the rotation — must be written, or the light stays red until the
    // worker restarts. Copilot caught the original version of this test never
    // making the third call.
    const onKeyVerdict = vi.fn();
    const report = createKeyVerdictReporter({ onKeyVerdict, log: quiet() });
    await report('PUBLER_API_KEY', { ok: true });
    await report('PUBLER_API_KEY', { ok: false, status: 403 });
    await report('PUBLER_API_KEY', { ok: true });
    await report('PUBLER_API_KEY', { ok: true });
    expect(onKeyVerdict.mock.calls).toEqual([
      ['PUBLER_API_KEY', { ok: true }],
      ['PUBLER_API_KEY', { ok: false, status: 403 }],
      ['PUBLER_API_KEY', { ok: true }],
    ]);
  });

  it('warns and swallows a writer that throws, naming the source', async () => {
    const log = quiet();
    const report = createKeyVerdictReporter({
      onKeyVerdict: vi.fn(async () => {
        throw new Error('Cosmos is having a day');
      }),
      log,
      source: 'publer',
    });
    await expect(report('PUBLER_API_KEY', { ok: false, status: 401 })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/^\[publer\] could not record a key verdict: name=Error\b/);
  });

  it('retries a success whose write failed, and dedupes only once one has landed', async () => {
    // Marking the success before the write would let one Cosmos hiccup leave
    // the light red until the next failure or a restart.
    const log = quiet();
    const onKeyVerdict = vi
      .fn()
      .mockRejectedValueOnce(new Error('503 from Cosmos'))
      .mockResolvedValue(undefined);
    const report = createKeyVerdictReporter({ onKeyVerdict, log });
    await report('PUBLER_API_KEY', { ok: true });
    await report('PUBLER_API_KEY', { ok: true });
    await report('PUBLER_API_KEY', { ok: true });
    expect(onKeyVerdict).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without a writer, which is how every unit test builds a client', async () => {
    const report = createKeyVerdictReporter({ log: quiet() });
    await expect(report('PUBLER_API_KEY', { ok: false, status: 401 })).resolves.toBeUndefined();
  });
});

describe('recordKeyVerdict — the process-wide writer', () => {
  beforeEach(() => {
    readDoc.mockClear();
    createDoc.mockClear();
    readDoc.mockImplementation(async () => null);
    createDoc.mockImplementation(async (_container, doc) => doc);
  });

  it('records a rejection against the vault secret the catalogue names, not the setting', async () => {
    await recordKeyVerdict('PUBLER_API_KEY', { ok: false, status: 401 });
    expect(createDoc).toHaveBeenCalledTimes(1);
    const [container, doc] = createDoc.mock.calls[0];
    expect(container).toBe('admin_config');
    expect(doc.secrets['PUBLER-API-KEY']).toMatchObject({ lastFailStatus: 401 });
    expect(doc.secrets['PUBLER-API-KEY'].lastFailAt).toEqual(expect.any(String));
    expect(doc.secrets.PUBLER_API_KEY).toBeUndefined();
  });

  it('writes a success once per worker per setting — the timer builds a client every five minutes', async () => {
    await recordKeyVerdict('OPENAI_API_KEY', { ok: true });
    await recordKeyVerdict('OPENAI_API_KEY', { ok: true });
    await recordKeyVerdict('OPENAI_API_KEY', { ok: true });
    expect(createDoc).toHaveBeenCalledTimes(1);
    expect(createDoc.mock.calls[0][1].secrets['OPENAI-API-KEY'].lastOkAt).toEqual(expect.any(String));
  });

  it('writes the first success after a failure, so the same worker can turn a light green again', async () => {
    await recordKeyVerdict('ANTHROPIC_API_KEY', { ok: true });
    await recordKeyVerdict('ANTHROPIC_API_KEY', { ok: false, status: 401 });
    await recordKeyVerdict('ANTHROPIC_API_KEY', { ok: true });
    await recordKeyVerdict('ANTHROPIC_API_KEY', { ok: true });
    expect(createDoc).toHaveBeenCalledTimes(3);
    expect(createDoc.mock.calls[2][1].secrets['ANTHROPIC-API-KEY'].lastOkAt).toEqual(expect.any(String));
  });

  it('records nothing for a setting outside the catalogue', async () => {
    await recordKeyVerdict('NOT_A_SETTING', { ok: false, status: 401 });
    expect(createDoc).not.toHaveBeenCalled();
  });

  it('never rejects when Cosmos does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createDoc.mockImplementationOnce(async () => {
        throw new Error('503 from Cosmos');
      });
      await expect(
        recordKeyVerdict('PUBLER_API_KEY', { ok: false, status: 403 })
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/could not record a key verdict: name=Error\b/);
    } finally {
      warn.mockRestore();
    }
  });
});
