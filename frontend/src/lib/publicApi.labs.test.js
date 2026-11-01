/**
 * The two labs reads (#664, #680): cached GETs like the pricing read, whose
 * one hard rule is that the body says `configured` one way or the other.
 * A 404 is "the route is not published" and comes back null; anything else
 * without the flag is refused, so a card can never render a shape it was
 * not promised.
 */
import {
  clearPublicGetCache,
  fetchCoderStatus,
  fetchLabsEstate,
  fetchVisitorSessionStatus,
  startVisitorSession,
  stopVisitorSession,
} from './publicApi.js';

vi.mock('@/lib/functionsBase', () => ({
  requireFunctionsBase: () => 'https://api.test',
}));

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  clearPublicGetCache();
  vi.restoreAllMocks();
});
afterEach(() => {
  clearPublicGetCache();
  vi.unstubAllGlobals();
});

describe.each([
  ['fetchLabsEstate', fetchLabsEstate, 'public/labs/estate', 'Labs estate'],
  ['fetchCoderStatus', fetchCoderStatus, 'public/labs/coder-status', 'Coder status'],
])('%s', (_name, fetcher, path, what) => {
  it('GETs its route once and passes the body through', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ configured: false }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetcher()).toEqual({ configured: false });
    await fetcher();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://api.test/${path}`);
  });

  it('returns null when the route is not published (404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 404))
    );
    expect(await fetcher()).toBeNull();
  });

  it('throws the server sentence on a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'Resource Graph timed out' }, 502))
    );
    await expect(fetcher()).rejects.toThrow('Resource Graph timed out');
  });

  it('refuses a body with no configured flag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: true }))
    );
    await expect(fetcher()).rejects.toThrow(`${what} response carried no configured flag`);
  });
});

it('fetchLabsEstate returns the configured shape untouched', async () => {
  const estate = {
    configured: true,
    arc: {
      status: 'Connected',
      statusSince: '2026-09-25T10:00:00Z',
      agentVersion: '1.52.02988.2222',
      osName: 'Ubuntu 24.04.3 LTS',
    },
    policy: { compliant: 12, nonCompliant: 1, notApplicable: 5 },
    agent: { online: true, queued: 0, lastHeartbeatAt: '2026-09-25T10:03:50Z' },
    coder: { reachable: true, running: 1, max: 5 },
    asOf: '2026-09-25T10:04:00Z',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(estate))
  );
  expect(await fetchLabsEstate()).toEqual(estate);
});

describe('fetchVisitorSessionStatus', () => {
  it('GETs public/labs/visitor-session and returns configured data', async () => {
    const data = {
      configured: true,
      open: true,
      code: 'OPEN',
      reason: 'Visitor session available',
    };
    const fetchMock = vi.fn(async () => jsonResponse(data));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchVisitorSessionStatus();
    expect(res).toEqual(data);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.test/public/labs/visitor-session');
  });

  it('returns null on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 404))
    );
    expect(await fetchVisitorSessionStatus()).toBeNull();
  });

  it('throws when missing configured flag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ open: true }))
    );
    await expect(fetchVisitorSessionStatus()).rejects.toThrow(
      'Visitor session status response carried no configured flag'
    );
  });
});

describe('startVisitorSession', () => {
  it('POSTs labId and turnstileToken to public/labs/visitor-session', async () => {
    const sessionRes = {
      ok: true,
      sessionId: 'sess-123',
      labId: 'landing-zone-builder-output',
      accessUrl: 'https://v-123.lab.example.com',
      expiresAt: '2026-10-17T03:00:00Z',
    };
    const fetchMock = vi.fn(async () => jsonResponse(sessionRes, 201));
    vi.stubGlobal('fetch', fetchMock);

    const res = await startVisitorSession({
      labId: 'landing-zone-builder-output',
      turnstileToken: 't-tok',
    });
    expect(res).toEqual(sessionRes);
    expect(fetchMock).toHaveBeenCalledWith('https://api.test/public/labs/visitor-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ labId: 'landing-zone-builder-output', turnstileToken: 't-tok' }),
    });
  });

  it('throws on missing sessionId in response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true }))
    );
    await expect(
      startVisitorSession({ labId: 'landing-zone-builder-output', turnstileToken: 't-tok' })
    ).rejects.toThrow('Visitor session response carried no session id');
  });
});

describe('visitor session refusals carry the sentence the server wrote (#1464)', () => {
  it.each([
    [
      409,
      'VISITOR_START_IN_PROGRESS',
      'Your visitor lab session is still being set up. Please wait a moment.',
    ],
    [
      429,
      'TURNSTILE_RATE_LIMITED',
      'Too many attempts to start a lab from this browser in the last few minutes.',
    ],
    [429, 'VISITOR_RATE_LIMITED', 'You have reached your visitor lab session limit for today.'],
  ])(
    'a %i %s start throws with the reason as its message, not the HTTP status',
    async (status, code, reason) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse({ ok: false, code, reason }, status))
      );
      const error = await startVisitorSession({
        labId: 'landing-zone-builder-output',
        turnstileToken: 't',
      }).catch((e) => e);
      expect(error).toMatchObject({ message: reason, status, code });
    }
  );

  it('a 429 status read throws with the reason, so the pane can show it', async () => {
    const reason =
      'Too many requests from this browser in the last few minutes. Try again in about ten minutes.';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { ok: false, configured: true, open: false, code: 'VISITOR_READS_RATE_LIMITED', reason },
          429
        )
      )
    );
    await expect(fetchVisitorSessionStatus()).rejects.toMatchObject({
      message: reason,
      status: 429,
    });
  });

  it("still prefers the server's error, and falls back to the status only when neither is there", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, error: 'Session not found', reason: 'x' }, 404))
    );
    await expect(stopVisitorSession('s')).rejects.toThrow('Session not found');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false }, 502))
    );
    await expect(startVisitorSession({ labId: 'l', turnstileToken: 't' })).rejects.toThrow(
      'Start visitor session failed with HTTP 502'
    );
  });
});

describe('stopVisitorSession', () => {
  it('DELETEs public/labs/visitor-session with sessionId query param', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, status: 'ended' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await stopVisitorSession('sess-123');
    expect(res).toEqual({ ok: true, status: 'ended' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/public/labs/visitor-session?sessionId=sess-123',
      {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      }
    );
  });
});
