/**
 * Reading the credentialed-proxy envelope.
 *
 * The case that matters most is the first one: the exact response the live
 * estate was returning while the Integrations page's Test Connection button
 * reported "Connected". If that reads as success again, this file fails.
 */
import { describe, it, expect } from 'vitest';
import { countList, readUpstreamMessage, unwrapProxy } from './proxyEnvelope';

describe('unwrapProxy', () => {
  it('THROWS on the envelope that was being read as success', () => {
    // publerProxy, 2026-09-10: Publer answering 403 for a bad key. The old
    // runner did `Array.isArray(envelope)` -> false -> count 0 -> "Connected
    // - 0 social account(s)". The proxy answers HTTP 200, so nothing else
    // caught it either.
    const refused = {
      ok: false,
      status: 403,
      data: { errors: ['Invalid API key or not active for this account.'] },
    };
    expect(() => unwrapProxy(refused, 'Publer')).toThrow(
      /Publer answered 403 .* Invalid API key or not active for this account\./
    );
  });

  it('names the workspace sentence on a 401, which is a different fix', () => {
    const refused = {
      ok: false,
      status: 401,
      data: { errors: ["You don't have access on this workspace"] },
    };
    expect(() => unwrapProxy(refused, 'Publer')).toThrow(/401 .* workspace/);
  });

  it("prefers the proxy's own explanation when it never called upstream", () => {
    expect(() =>
      unwrapProxy(
        {
          ok: false,
          code: 'INTEGRATION_NOT_CONFIGURED',
          error: 'Publer is not configured: PUBLER_WORKSPACE_ID is not set',
        },
        'Publer'
      )
    ).toThrow(/PUBLER_WORKSPACE_ID is not set/);
  });

  it("says a connection probe's failure as the server wrote it, once (#945)", () => {
    // connectionProbe answers a failure with { ok, status, error } and no
    // upstream body since #1200's review; its sentence already names the
    // service and the status.
    expect(() =>
      unwrapProxy({ ok: false, status: 401, error: 'Telegram answered HTTP 401.' }, 'Telegram')
    ).toThrow(/^Telegram answered HTTP 401\.$/);
    expect(() =>
      unwrapProxy(
        { ok: false, error: 'Podbean could not be reached (ENOTFOUND).', correlationId: 'inv-7' },
        'Podbean'
      )
    ).toThrow(/^Podbean could not be reached \(ENOTFOUND\)\. \(reference inv-7\)$/);
  });

  it('still throws when the failure carried no words at all', () => {
    expect(() => unwrapProxy({ ok: false, status: 500, data: {} }, 'Linkie')).toThrow(
      /Linkie answered 500/
    );
  });

  it('returns the upstream body on success', () => {
    expect(unwrapProxy({ ok: true, status: 200, data: [{ id: 'a' }] }, 'Publer')).toEqual([
      { id: 'a' },
    ]);
    expect(unwrapProxy({ ok: true, status: 200, data: { data: [] } }, 'Klaviyo')).toEqual({
      data: [],
    });
  });

  it('refuses a shape that is not the envelope, rather than assuming success', () => {
    // Reading `undefined` as "zero of them" is precisely how the old runners
    // reported success for a refusal.
    for (const value of [
      null,
      undefined,
      'text',
      42,
      {},
      [],
      // The likeliest accident, and the one a "has a data property" check
      // would have waved through: an already-unwrapped JSON:API body, which
      // would then be unwrapped a second time.
      { data: [] },
      { data: { profiles: [] } },
      // `ok` present but not the boolean the proxy sets.
      { ok: 'true', data: [] },
    ]) {
      expect(() => unwrapProxy(value, 'Klaviyo')).toThrow(/unrecognised response/);
    }
  });
});

describe('countList', () => {
  it('counts the shapes these APIs actually use', () => {
    expect(countList([1, 2, 3])).toBe(3);
    expect(countList({ data: [1, 2] })).toBe(2);
    expect(countList({ accounts: [1] }, 'accounts')).toBe(1);
    expect(countList({ items: [] })).toBe(0);
  });

  it('returns null rather than inventing a zero', () => {
    // "Connected - 0 accounts" and "connected, count unknown" are different
    // sentences, and reporting the first for the second is how a broken
    // integration looked healthy.
    expect(countList({ hello: 'world' })).toBeNull();
    expect(countList(null)).toBeNull();
    expect(countList('nope')).toBeNull();
  });
});

describe('readUpstreamMessage', () => {
  it.each([
    [{ errors: ['first', 'second'] }, 'first'],
    [{ errors: [{ detail: 'Invalid API key' }] }, 'Invalid API key'],
    [{ message: 'nope' }, 'nope'],
    [{ error: 'bad' }, 'bad'],
    [{ raw: '<html>502</html>' }, '<html>502</html>'],
  ])('reads %j', (body, expected) => {
    expect(readUpstreamMessage(body)).toBe(expected);
  });

  it('invents nothing when there is nothing', () => {
    for (const body of [null, {}, { errors: [] }, { errors: [{}] }, 42]) {
      expect(readUpstreamMessage(body)).toBe('');
    }
  });
});

describe('Telegram’s description field (#483)', () => {
  it('reads the sentence Telegram sends, so the browser mirror does not drift', () => {
    expect(readUpstreamMessage({ ok: false, error_code: 401, description: 'Unauthorized' })).toBe(
      'Unauthorized'
    );
  });

  it('still prefers the fields the other providers use', () => {
    expect(readUpstreamMessage({ message: 'the real one', description: 'the vaguer one' })).toBe(
      'the real one'
    );
  });
});
