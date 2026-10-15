/**
 * connection-probe.test.js — the closed probe table, and the credential that
 * must not escape it (#483).
 *
 * The interesting assertions here are the negative ones. Two of the three
 * probes authenticate in the URL, so "the response did not contain the token"
 * is a security property, not a nicety, and it is asserted on every path that
 * can produce a string: a rejection, an unparseable body and a transport
 * failure.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PODBEAN_TOKEN_URL,
  PROBES,
  PROBE_FAILURE_FIELDS,
  PROBE_NAMES,
  assertUrlSafe,
  createConnectionProbe,
  createTokenExchange,
  redactSecrets,
} from './connection-probe.js';

// DELIBERATELY UNLIKE REAL CREDENTIALS. The first drafts read
// `123456789:AAH…` and `AIzaSy…`, which are the genuine Telegram and Google
// key shapes — fake values that secret scanners cannot tell from live ones,
// and the cost of that is a false positive that forces a real rotation
// (Copilot review of 89288f8a). These keep the only property the tests
// actually need: long enough to be redacted, and a colon in the Telegram one
// so its percent-encoded form differs from its raw form.
const TOKEN = 'not-a-real-telegram-token:EXAMPLE-VALUE-FOR-TESTS';
const YT_KEY = 'not-a-real-youtube-key-EXAMPLE-VALUE-FOR-TESTS';
const PODBEAN_ID = 'not-a-real-podbean-client-id-EXAMPLE';
const PODBEAN_SECRET = 'not-a-real-podbean-client-secret-EXAMPLE-VALUE-FOR-TESTS';
const PODBEAN_TOKEN = 'not-a-real-podbean-access-token-EXAMPLE-VALUE';
const RESEND_KEY = 'not-a-real-resend-key-EXAMPLE-VALUE-FOR-TESTS';
const QLTY_TOKEN = 'not-a-real-qlty-token-EXAMPLE-VALUE-FOR-TESTS';

const ENV = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_CHAT_ID: '-1001234567890',
  PODBEAN_CLIENT_ID: PODBEAN_ID,
  PODBEAN_CLIENT_SECRET: PODBEAN_SECRET,
  YOUTUBE_API_KEY: YT_KEY,
  RESEND_API_KEY: RESEND_KEY,
  QLTY_API_TOKEN: QLTY_TOKEN,
  REPLICATE_API_KEY: 'not-a-real-replicate-key-EXAMPLE-VALUE-FOR-TESTS',
  FIRECRAWL_API_KEY: 'not-a-real-firecrawl-key-EXAMPLE-VALUE-FOR-TESTS',
};

const readKey = (env, name) => (typeof env?.[name] === 'string' ? env[name].trim() : '');

const allow = {
  requireRole: vi.fn(async () => ({ user: { role: 'editor' } })),
};
const ctx = () => ({ error: vi.fn(), warn: vi.fn(), log: vi.fn() });

const req = (body) => ({ json: async () => body });

/** The parsed body of whatever the handler returned. */
const bodyOf = (res) => JSON.parse(res.body);

function respond({ ok = true, status = 200, text = '{}' }) {
  return vi.fn(async () => ({ ok, status, text: async () => text }));
}

describe('redactSecrets', () => {
  it('blanks a credential wherever it appears', () => {
    expect(redactSecrets(`GET /bot${TOKEN}/getMe failed`, [TOKEN])).toBe(
      'GET /bot***/getMe failed'
    );
  });

  it('leaves a short value alone rather than corrupting the sentence', () => {
    // Blanking every occurrence of "ab" would turn unrelated prose to noise,
    // and no real credential is two characters.
    expect(redactSecrets('a fabulous cabbage', ['ab'])).toBe('a fabulous cabbage');
  });

  it('survives a non-string and an absent secret', () => {
    expect(redactSecrets(undefined, [undefined, null, 12])).toBe('');
  });

  it('blanks the percent-encoded form too', () => {
    // A credential that travels in a URL is encoded on the way out, so an
    // upstream quoting its request target back shows `%3A` where the raw
    // value has a colon. Redacting only the raw string sails past it, which
    // is the leak this case exists to pin.
    const encoded = encodeURIComponent(TOKEN);
    expect(encoded).not.toBe(TOKEN);
    expect(redactSecrets(`target: /bot${encoded}/getMe`, [TOKEN])).toBe('target: /bot***/getMe');
  });
});

describe('assertUrlSafe', () => {
  it('passes a real bot token, colon and all', () => {
    // The colon MUST survive: Telegram's path is `/bot<digits>:<rest>/getMe`
    // and percent-encoding it would rely on the far end decoding before it
    // routes. A 404 from that would read as "your token is bad", which is a
    // wrong answer to the only question this button asks.
    expect(assertUrlSafe(TOKEN)).toBe(TOKEN);
  });

  it('refuses a value that could reshape the request target', () => {
    for (const bad of ['\n', '/x', '?a=1', '#f', ' ', '\\y'].map((tail) => `${TOKEN}${tail}`)) {
      expect(() => assertUrlSafe(bad), JSON.stringify(bad)).toThrow(/cannot appear in a URL/);
    }
  });

  it('refuses a percent-escape, which becomes a delimiter at the far end', () => {
    // The subtle one. `%2F` passes every literal-delimiter check above and is
    // then decoded by the upstream server into the `/` that check just
    // refused, so blocking the slash while allowing its escape is a gap
    // rather than a boundary (Copilot review of 89288f8a). `%25` is the same
    // argument one level down.
    for (const bad of ['%2Fgetupdates', '%3Fx', '%25'].map((tail) => `${TOKEN}${tail}`)) {
      expect(() => assertUrlSafe(bad), bad).toThrow(/cannot appear in a URL/);
    }
  });
});

describe('the probe table', () => {
  it('is closed, and every entry is a GET with no caller-supplied component', () => {
    expect(PROBE_NAMES).toEqual([
      'telegram',
      'podbean',
      'youtube',
      'resend',
      'qlty',
      'replicate',
      'firecrawl',
    ]);
    for (const name of PROBE_NAMES) {
      const probe = PROBES[name];
      const { url, headers } = probe.buildRequest({ values: ENV });
      expect(url, `${name} must be https`).toMatch(/^https:\/\//);
      expect(headers).toBeTypeOf('object');
      // No `method` field anywhere: a probe that is not a GET is not a probe.
      expect(probe).not.toHaveProperty('method');
    }
  });

  it('reports a key verdict for Telegram alone', () => {
    // Podbean's refusals are unmeasured and YouTube answers 403 for an
    // exceeded quota as well as a bad key. Wiring either would turn a light
    // red for a reason that is not the key, which is #358.
    expect(PROBES.telegram.reportsKeyVerdict).toBe(true);
    expect(PROBES.podbean.reportsKeyVerdict).toBe(false);
    expect(PROBES.youtube.reportsKeyVerdict).toBe(false);
    // Resend refuses a sending-only key as well as a wrong one, and only the
    // wrong one means remint.
    expect(PROBES.resend.reportsKeyVerdict).toBe(false);
    // A Qlty 403 could be the token's scope rather than a dead token.
    expect(PROBES.qlty.reportsKeyVerdict).toBe(false);
    // Neither provider's 401/403 split has been measured here (ADR 0033).
    expect(PROBES.replicate.reportsKeyVerdict).toBe(false);
    expect(PROBES.firecrawl.reportsKeyVerdict).toBe(false);
  });

  it('asks Replicate and Firecrawl read-only questions that spend nothing', () => {
    expect(PROBES.replicate.settings).toEqual(['REPLICATE_API_KEY']);
    expect(PROBES.replicate.buildRequest({ values: ENV }).url).toBe(
      'https://api.replicate.com/v1/account'
    );
    expect(PROBES.firecrawl.settings).toEqual(['FIRECRAWL_API_KEY']);
    expect(PROBES.firecrawl.buildRequest({ values: ENV }).url).toBe(
      'https://api.firecrawl.dev/v1/team/credit-usage'
    );
  });

  it('asks Qlty who the token belongs to, a read that depends on no project', () => {
    expect(PROBES.qlty.settings).toEqual(['QLTY_API_TOKEN']);
    const { url, headers } = PROBES.qlty.buildRequest({ values: ENV });
    expect(url).toBe('https://api.qlty.sh/user');
    expect(headers.Authorization).toBe(`Bearer ${QLTY_TOKEN}`);
  });

  it('asks Resend a read-only question that a sending-only key cannot answer', () => {
    // GET /domains spends nothing on either meter, and a pass means the key
    // can manage contacts and broadcasts, which a sending-only key cannot.
    expect(PROBES.resend.settings).toEqual(['RESEND_API_KEY']);
    const { url, headers } = PROBES.resend.buildRequest({ values: ENV });
    expect(url).toBe('https://api.resend.com/domains');
    expect(headers.Authorization).toBe(`Bearer ${RESEND_KEY}`);
  });

  it('judges Telegram on the token alone, never the chat id', () => {
    // getMe does not read the chat id, so a success must not turn its light
    // green and a 401 must not turn it red.
    expect(PROBES.telegram.settings).toEqual(['TELEGRAM_BOT_TOKEN']);
  });

  it('asks Podbean for the show, with no credential in the URL the table builds', () => {
    // The token is minted by the authenticate step and added by the handler;
    // the table's own request carries nothing.
    expect(PROBES.podbean.settings).toEqual(['PODBEAN_CLIENT_ID', 'PODBEAN_CLIENT_SECRET']);
    const { url, headers } = PROBES.podbean.buildRequest({ values: ENV });
    expect(url).toBe('https://api.podbean.com/v1/podcast');
    expect(JSON.stringify(headers)).not.toContain(PODBEAN_SECRET);
    expect(typeof PROBES.podbean.authenticate).toBe('function');
    // Only Podbean exchanges a token; every other probe goes straight to its GET.
    for (const name of PROBE_NAMES.filter((n) => n !== 'podbean')) {
      expect(PROBES[name].authenticate, name).toBeNull();
    }
  });

  it('keeps the YouTube probe to one result, because search.list costs ~100 units', () => {
    const { url } = PROBES.youtube.buildRequest({ values: ENV });
    expect(new URL(url).searchParams.get('maxResults')).toBe('1');
  });
});

describe('createConnectionProbe', () => {
  const build = (over = {}) =>
    createConnectionProbe({
      guard: allow,
      env: ENV,
      readKey,
      fetch: respond({ text: '{"ok":true,"result":{"username":"hcw_bot"}}' }),
      ...over,
    });

  it('refuses a name outside the table before reading anything', async () => {
    const fetchImpl = vi.fn();
    const res = await build({ fetch: fetchImpl })(req({ probe: 'evil' }), ctx());
    expect(res.status).toBe(400);
    expect(bodyOf(res).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an inherited property name', async () => {
    // `PROBES[requested]` would resolve `constructor` to something that is not
    // a probe; `Object.hasOwn` is why it does not.
    const fetchImpl = vi.fn();
    for (const name of ['constructor', '__proto__', 'toString']) {
      const res = await build({ fetch: fetchImpl })(req({ probe: name }), ctx());
      expect(res.status, name).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses before the call when the credential is not seeded', async () => {
    const fetchImpl = vi.fn();
    const handler = createConnectionProbe({
      guard: allow,
      env: { ...ENV, TELEGRAM_BOT_TOKEN: '' },
      readKey,
      fetch: fetchImpl,
    });
    const res = await handler(req({ probe: 'telegram' }), ctx());
    // 200, not 5xx: an unseeded key is a configuration state the page renders
    // as not-connected, not a fault.
    expect(res.status).toBe(200);
    expect(bodyOf(res)).toMatchObject({
      ok: false,
      code: 'INTEGRATION_NOT_CONFIGURED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a token that cannot go in a URL, naming the setting not the value', async () => {
    // A trailing newline on a pasted secret is the common version of this.
    // Without the guard the URL silently changes shape and Telegram answers
    // 404, which the page would report as a bad token.
    const fetchImpl = vi.fn();
    const handler = createConnectionProbe({
      guard: allow,
      env: { ...ENV, TELEGRAM_BOT_TOKEN: `${TOKEN}/evil.test` },
      readKey: (env, name) => env?.[name] ?? '',
      fetch: fetchImpl,
    });
    const res = await handler(req({ probe: 'telegram' }), ctx());
    const parsed = bodyOf(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('TELEGRAM_BOT_TOKEN');
    expect(res.body).not.toContain(TOKEN);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes the guard verdict through when the caller is not an editor', async () => {
    const denied = { error: { status: 403 } };
    const handler = createConnectionProbe({
      guard: { requireRole: vi.fn(async () => denied) },
      env: ENV,
      readKey,
      fetch: vi.fn(),
    });
    expect(await handler(req({ probe: 'telegram' }), ctx())).toBe(denied.error);
  });

  it('answers ok with the upstream body on success', async () => {
    const res = await build()(req({ probe: 'telegram' }), ctx());
    expect(bodyOf(res)).toMatchObject({
      ok: true,
      status: 200,
      data: { ok: true, result: { username: 'hcw_bot' } },
    });
  });

  it('names the service and status on a failure, and answers with nothing of the upstream body', async () => {
    // The upstream's own sentence is not copied into `error` (#945, as the AI
    // proxy in #1198), and since #1200's review (L2) the redacted body is not
    // relayed either: this route is editor-level and the page never read it
    // on a failure. The key verdict keeps the provider's sentence for the
    // super_admin API-keys page (#463).
    const res = await build({
      fetch: respond({
        ok: false,
        status: 401,
        text: '{"ok":false,"error_code":401,"description":"Unauthorized: bot token 12345 echoed"}',
      }),
    })(req({ probe: 'telegram' }), ctx());
    const body = bodyOf(res);
    expect(body).toEqual({ ok: false, status: 401, error: 'Telegram answered HTTP 401.' });
    expect(Object.keys(body).sort()).toEqual([...PROBE_FAILURE_FIELDS].sort());
    expect(res.body).not.toMatch(/Unauthorized|echoed/);
  });

  it('still relays the redacted answer on a success, which the Test runners read', async () => {
    const res = await build({
      fetch: respond({ ok: true, status: 200, text: '{"ok":true,"result":{"username":"hcw_bot"}}' }),
    })(req({ probe: 'telegram' }), ctx());
    expect(bodyOf(res)).toEqual({ ok: true, status: 200, data: { ok: true, result: { username: 'hcw_bot' } } });
  });

  it('records a Telegram rejection against the bot token', async () => {
    const onKeyVerdict = vi.fn(async () => {});
    await build({
      onKeyVerdict,
      fetch: respond({
        ok: false,
        status: 401,
        text: '{"description":"Unauthorized"}',
      }),
    })(req({ probe: 'telegram' }), ctx());
    expect(onKeyVerdict).toHaveBeenCalledWith(
      'TELEGRAM_BOT_TOKEN',
      expect.objectContaining({
        ok: false,
        status: 401,
        detail: 'Unauthorized',
      })
    );
  });

  it('does not record a verdict for Podbean, YouTube or Resend', async () => {
    for (const probe of ['podbean', 'youtube', 'resend']) {
      const onKeyVerdict = vi.fn(async () => {});
      await build({
        onKeyVerdict,
        fetch: respond({
          ok: false,
          status: 403,
          text: '{"message":"quotaExceeded"}',
        }),
      })(req({ probe }), ctx());
      expect(onKeyVerdict, probe).not.toHaveBeenCalled();
    }
  });

  it('does not turn a light red for a 404 or a 500', async () => {
    for (const status of [404, 429, 500]) {
      const onKeyVerdict = vi.fn(async () => {});
      await build({
        onKeyVerdict,
        fetch: respond({ ok: false, status, text: '{"description":"nope"}' }),
      })(req({ probe: 'telegram' }), ctx());
      expect(onKeyVerdict, String(status)).not.toHaveBeenCalled();
    }
  });

  it('never returns the credential, on any failure path', async () => {
    const cases = [
      // A provider that echoes the request line back in its error body.
      {
        probe: 'telegram',
        secret: TOKEN,
        fetch: respond({
          ok: false,
          status: 401,
          text: `{"description":"bad request to /bot${TOKEN}/getMe"}`,
        }),
      },
      // A header credential echoed back in a JSON error sentence.
      {
        probe: 'resend',
        secret: RESEND_KEY,
        fetch: respond({
          ok: false,
          status: 401,
          text: `{"name":"restricted_api_key","message":"Key ${RESEND_KEY} can only send"}`,
        }),
      },
      // A body that is not JSON at all, parked in `raw`.
      {
        probe: 'youtube',
        secret: YT_KEY,
        fetch: respond({
          ok: false,
          status: 400,
          text: `<html>API key ${YT_KEY} not valid</html>`,
        }),
      },
      // A transport error whose message quotes the target.
      {
        probe: 'youtube',
        secret: YT_KEY,
        fetch: vi.fn(async () => {
          throw new Error(`connect ECONNREFUSED for ?key=${YT_KEY}`);
        }),
      },
    ];
    for (const { probe, secret, fetch: fetchImpl } of cases) {
      const context = ctx();
      const res = await build({ fetch: fetchImpl })(req({ probe }), context);
      expect(res.body, `${probe} leaked its credential`).not.toContain(secret);
      const logged = context.error.mock.calls.flat().join(' ');
      expect(logged, `${probe} logged its credential`).not.toContain(secret);
    }
  });

  it('reports an unreachable upstream without inventing a status', async () => {
    const res = await build({
      fetch: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    })(req({ probe: 'podbean' }), ctx());
    const parsed = bodyOf(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBeUndefined();
    expect(parsed.error).toContain('Podbean could not be reached');
  });
});

describe('createTokenExchange', () => {
  it('sends one POST, redacts the answer before parsing it, and refuses a second call', async () => {
    const secrets = [PODBEAN_SECRET];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => `{"access_token":"t0ken-value-long-enough","echo":"${PODBEAN_SECRET}"}`,
    }));
    const exchange = createTokenExchange({ fetch: fetchImpl, secrets });
    const out = await exchange('https://auth.example/token', {
      headers: { A: 'b' },
      body: 'grant_type=client_credentials',
      secrets: ['extra-secret-value'],
    });
    expect(out).toEqual({
      ok: true,
      status: 200,
      data: { access_token: 't0ken-value-long-enough', echo: '***' },
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('grant_type=client_credentials');
    // What the step passed joins the handler's list, so it stays redacted after.
    expect(secrets).toContain('extra-secret-value');

    await expect(exchange('https://auth.example/token')).rejects.toThrow(/at most one token exchange/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a token endpoint that is not https, before sending', async () => {
    const fetchImpl = vi.fn();
    const exchange = createTokenExchange({ fetch: fetchImpl, secrets: [] });
    await expect(exchange('http://auth.example/token')).rejects.toThrow(/must be https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the Podbean probe', () => {
  const BASIC = Buffer.from(`${PODBEAN_ID}:${PODBEAN_SECRET}`).toString('base64');

  /** Answers the token exchange, then the GET, in order. An Error is thrown instead. */
  const sequence = (...answers) => {
    const queue = [...answers];
    return vi.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { ok: next.status < 300, status: next.status, text: async () => next.text };
    });
  };
  const tokenOk = {
    status: 200,
    text: `{"access_token":"${PODBEAN_TOKEN}","token_type":"Bearer","expires_in":604800}`,
  };

  const run = (fetchImpl, env = ENV, context = ctx()) =>
    createConnectionProbe({ guard: allow, env, readKey, fetch: fetchImpl })(
      req({ probe: 'podbean' }),
      context
    );

  it('exchanges the client credentials for a token, then GETs the show with it', async () => {
    const fetchImpl = sequence(tokenOk, {
      status: 200,
      text: '{"podcast":{"id":"p1","title":"Hybrid Cloud Insights"}}',
    });
    const res = await run(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [[tokenUrl, tokenInit], [getUrl, getInit]] = fetchImpl.mock.calls;
    expect(tokenUrl).toBe(PODBEAN_TOKEN_URL);
    expect(tokenInit.method).toBe('POST');
    expect(tokenInit.headers.Authorization).toBe(`Basic ${BASIC}`);
    expect(tokenInit.body).toBe('grant_type=client_credentials');
    const parsed = new URL(getUrl);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://api.podbean.com/v1/podcast');
    expect(parsed.searchParams.get('access_token')).toBe(PODBEAN_TOKEN);
    expect(getInit.method).toBe('GET');

    expect(bodyOf(res)).toEqual({
      ok: true,
      status: 200,
      data: { podcast: { id: 'p1', title: 'Hybrid Cloud Insights' } },
    });
    // Neither the token nor the secret nor a URL carrying them reaches the browser.
    for (const secret of [PODBEAN_TOKEN, PODBEAN_SECRET, BASIC]) {
      expect(res.body).not.toContain(secret);
    }
    expect(res.body).not.toContain('access_token');
  });

  it('a refused exchange is a clear not-connected answer, and the GET is never sent', async () => {
    const fetchImpl = sequence({
      status: 400,
      text: '{"error":"invalid_grant","error_description":"The grant type is unauthorized for this client_id"}',
    });
    const res = await run(fetchImpl);
    expect(res.status).toBe(200);
    // This module's sentence; the token endpoint's own words stay out (#945).
    expect(bodyOf(res)).toEqual({
      ok: false,
      status: 400,
      error: 'Podbean refused the client ID and secret.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an exchange answered without a token says so, and sends no GET', async () => {
    const fetchImpl = sequence({ status: 200, text: '{"token_type":"Bearer"}' });
    const res = await run(fetchImpl);
    expect(bodyOf(res)).toMatchObject({
      ok: false,
      error: 'Podbean answered the token request without an access token.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('names the missing setting before any call', async () => {
    const fetchImpl = vi.fn();
    const res = await run(fetchImpl, { ...ENV, PODBEAN_CLIENT_SECRET: '' });
    expect(bodyOf(res)).toEqual({
      ok: false,
      error: 'Podbean is not configured: PODBEAN_CLIENT_SECRET is not set',
      code: 'INTEGRATION_NOT_CONFIGURED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never returns or logs the token, the secret or the Basic header, on any failure path', async () => {
    const cases = [
      // The token endpoint echoing the credentials it was sent.
      sequence({
        status: 401,
        text: `{"error":"invalid_client","error_description":"Basic ${BASIC} for ${PODBEAN_SECRET}"}`,
      }),
      // The GET echoing its request line, token and all.
      sequence(tokenOk, {
        status: 400,
        text: `{"error":"invalid_token","error_description":"GET /v1/podcast?access_token=${PODBEAN_TOKEN}"}`,
      }),
      // A non-JSON GET body, parked in `raw`.
      sequence(tokenOk, { status: 502, text: `<html>${PODBEAN_TOKEN}</html>` }),
      // A transport error on the GET quoting its target.
      sequence(
        tokenOk,
        new Error(`request to https://api.podbean.com/v1/podcast?access_token=${PODBEAN_TOKEN} failed`)
      ),
      // A transport error on the exchange.
      sequence(new Error(`connect ECONNREFUSED with ${PODBEAN_SECRET}`)),
    ];
    for (const fetchImpl of cases) {
      const context = ctx();
      const res = await run(fetchImpl, ENV, context);
      const logged = [...context.error.mock.calls, ...context.warn.mock.calls].flat().join(' ');
      for (const secret of [PODBEAN_TOKEN, PODBEAN_SECRET, BASIC]) {
        expect(res.body).not.toContain(secret);
        expect(logged).not.toContain(secret);
      }
      expect(bodyOf(res).ok).toBe(false);
    }
  });

  it('never reports a key verdict, even for a refused exchange', async () => {
    const onKeyVerdict = vi.fn(async () => {});
    await createConnectionProbe({
      guard: allow,
      env: ENV,
      readKey,
      onKeyVerdict,
      fetch: sequence({ status: 401, text: '{"error":"invalid_client"}' }),
    })(req({ probe: 'podbean' }), ctx());
    expect(onKeyVerdict).not.toHaveBeenCalled();
  });
});
