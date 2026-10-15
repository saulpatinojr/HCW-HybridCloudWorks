/**
 * What a failed request tells the caller (#498).
 *
 * Several handlers answer `{ error: <label>, message: <why> }`, and the client
 * used to throw only `error`. The Social Hub caption button therefore showed
 * "Failed to generate caption" and nothing else while the sentence naming the
 * real cause — a provider with no key, a rejected credential — sat one line
 * away and was discarded. That is the same shape that cost #358 two days on
 * Publer: the status code shown, the reason dropped.
 *
 * Kept separate from api.test.js, which is about token handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/entraAuth', () => ({ acquireApiToken: async () => 'token' }));
vi.mock('@/lib/functionsBase', () => ({
  requireFunctionsBase: () => 'https://api.example.test/api',
  getFunctionsBase: () => 'https://api.example.test/api',
}));

import { postJSON, parseWwwAuthenticate } from '@/lib/api';

const failing = (body) => ({ ok: false, status: 500, json: async () => body });

/** A refusal that carries an RFC 6750 challenge, the way the API does since #517. */
const refusing = (header) => ({
  ok: false,
  status: 401,
  headers: { get: (n) => (n.toLowerCase() === 'www-authenticate' ? header : null) },
  json: async () => ({ error: 'Authentication required' }),
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a failed call surfaces the cause, not only the label', () => {
  it('appends the message the API put beside the error', async () => {
    fetch.mockResolvedValue(
      failing({ error: 'Failed to generate caption', message: 'No AI provider is configured' })
    );
    await expect(postJSON('generateSocialCaption', {})).rejects.toThrow(
      'Failed to generate caption — No AI provider is configured'
    );
  });

  it('does not repeat a message that only restates the error', async () => {
    fetch.mockResolvedValue(failing({ error: 'Nope', message: 'Nope' }));
    await expect(postJSON('x', {})).rejects.toThrow(/^Nope$/);
  });

  it('still works when the API sends no message at all', async () => {
    fetch.mockResolvedValue(failing({ error: 'Just the label' }));
    await expect(postJSON('x', {})).rejects.toThrow(/^Just the label$/);
  });

  it('keeps details after the cause when both are present', async () => {
    fetch.mockResolvedValue(failing({ error: 'E', message: 'why', details: { code: 7 } }));
    await expect(postJSON('x', {})).rejects.toThrow('E — why Details: {"code":7}');
  });

  it('ignores a message that is not a string', async () => {
    fetch.mockResolvedValue(failing({ error: 'E', message: { nested: true } }));
    await expect(postJSON('x', {})).rejects.toThrow(/^E$/);
  });
});

describe('a failure names its reference, not the cause, since #945', () => {
  it('appends the correlation id the API sent beside its safe sentence, and attaches it', async () => {
    fetch.mockResolvedValue(
      failing({ ok: false, error: 'Failed to publish content', correlationId: 'inv-1234-abcd' })
    );
    const error = await postJSON('publishContent', {}).catch((err) => err);
    expect(error.message).toBe('Failed to publish content (reference inv-1234-abcd)');
    expect(error.correlationId).toBe('inv-1234-abcd');
    expect(error.status).toBe(500);
  });

  it('keeps an authored cause before the reference', async () => {
    fetch.mockResolvedValue(
      failing({
        error: 'Failed X',
        message: 'Image generation paused: $10.00 of the $10 budget used',
        correlationId: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      })
    );
    await expect(postJSON('x', {})).rejects.toThrow(
      'Failed X — Image generation paused: $10.00 of the $10 budget used (reference 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01)'
    );
  });

  it('ignores a correlation id that is not shaped like one', async () => {
    fetch.mockResolvedValue(failing({ error: 'E', correlationId: 'not an id <script>' }));
    const error = await postJSON('x', {}).catch((err) => err);
    expect(error.message).toBe('E');
    expect(error).not.toHaveProperty('correlationId');
  });
});

describe('parseWwwAuthenticate (#517)', () => {
  it('reads the parameters the API sends', () => {
    expect(
      parseWwwAuthenticate(
        'Bearer realm="", error="insufficient_scope", error_description="Missing the scope."'
      )
    ).toEqual({ realm: '', error: 'insufficient_scope', error_description: 'Missing the scope.' });
  });

  // A caller that learns nothing must behave as it did before the header
  // existed, not throw — these are the shapes a proxy or an older API produces.
  it.each([null, undefined, '', '   ', 'Basic realm="x"', 'Bearer', 'nonsense'])(
    'returns {} rather than throwing for %p',
    (header) => {
      expect(parseWwwAuthenticate(header)).toEqual({});
    }
  );

  it('ignores an unquoted parameter rather than half-parsing it', () => {
    expect(parseWwwAuthenticate('Bearer error=invalid_token')).toEqual({});
  });

  // A quoted-string may contain an escaped quote. Stopping at the first one
  // would return a truncated value that looks complete, which is worse than
  // returning nothing.
  it('unescapes a quoted-string rather than stopping at the first inner quote', () => {
    expect(
      parseWwwAuthenticate(
        'Bearer error="invalid_token", error_description="the \\"aud\\" claim is wrong"'
      )
    ).toEqual({ error: 'invalid_token', error_description: 'the "aud" claim is wrong' });
  });

  // This API does not send claims challenges, but Entra's shape is the reason
  // the parser is general: it is the seam a Conditional Access authentication
  // context would arrive through.
  it('reads an Entra-shaped claims challenge', () => {
    const header =
      'Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", ' +
      'error="insufficient_claims", claims="eyJhY2Nlc3NfdG9rZW4iOnt9fQ=="';
    expect(parseWwwAuthenticate(header)).toMatchObject({
      error: 'insufficient_claims',
      claims: 'eyJhY2Nlc3NfdG9rZW4iOnt9fQ==',
    });
  });
});

describe('a refusal carries the reason to the caller (#517)', () => {
  it('attaches the parsed challenge to the thrown error', async () => {
    fetch.mockResolvedValue(
      refusing(
        'Bearer realm="", error="insufficient_scope", error_description="Missing the scope."'
      )
    );

    // The status told a caller the request failed; this tells them what would
    // fix it, which is what lets useAdminAuth stop retrying what cannot work.
    await expect(postJSON('x', {})).rejects.toMatchObject({
      status: 401,
      wwwAuthenticate: { error: 'insufficient_scope' },
    });
  });

  it('leaves an empty object when the header is absent', async () => {
    fetch.mockResolvedValue(refusing(null));
    await expect(postJSON('x', {})).rejects.toMatchObject({ wwwAuthenticate: {} });
  });
});

describe('a rate limit carries the wait to the caller (#504)', () => {
  it('attaches retryAfterSeconds and the code from the body', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ ok: false, retryAfterSeconds: 7, code: 'RATE', error: 'Too many' }),
    });
    await expect(postJSON('x', {})).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 7,
      code: 'RATE',
    });
  });

  it('leaves them off when the body has none, or a wait that is not a positive number', async () => {
    fetch.mockResolvedValue(failing({ error: 'E', retryAfterSeconds: '7' }));
    const error = await postJSON('x', {}).catch((err) => err);
    expect(error).not.toHaveProperty('retryAfterSeconds');
    expect(error).not.toHaveProperty('code');
  });
});
