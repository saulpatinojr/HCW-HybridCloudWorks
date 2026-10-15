/**
 * The voice list and the preview proxy behind the Podcast voices picker
 * (#725). Tests mock `fetch`.
 *
 * What is pinned, in order of what it would cost to get wrong:
 *
 *   1. The preview route is not an open proxy. Only
 *      https://storage.googleapis.com/eleven-public-prod/… is fetched: not a
 *      look-alike host, not another bucket on the same host, not a path that
 *      climbs out of the bucket, not a URL with a port, credentials or query.
 *      The URL comes from the account's listing, never the caller; the key is
 *      never sent to the preview host; redirects are refused; the body is
 *      capped and must be MP3.
 *   2. On the free plan a Voice Library voice is shown as unavailable, with
 *      the reason, rather than offered or hidden.
 *   3. The listing is the documented v2 endpoint, paginated, classified by
 *      the documented `voice_type` filter, cached, and a missing permission
 *      is reported with the permission's name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FREE_PLAN_RULE,
  MAX_PREVIEW_BYTES,
  MAX_VOICE_PAGES,
  PREVIEW_FAILED,
  PREVIEW_UNAVAILABLE,
  VOICES_CACHE_TTL_MS,
  VOICES_UNAVAILABLE,
  VOICES_URL,
  VOICE_NOT_LISTED,
  cachedVoiceNames,
  clearVoicesCache,
  fetchVoicePreview,
  isAllowedPreviewUrl,
  isElevenLabsVoiceId,
  looksLikeMp3,
  readVoices,
  voiceUsability,
  voicesForPlan,
} from './elevenlabs-voices.js';
import { API_KEYS_PAGE } from './elevenlabs-account.js';

const KEY = 'xi-test-key';
const noSleep = vi.fn(async () => {});

const PREVIEW = (id) =>
  `https://storage.googleapis.com/eleven-public-prod/premade/voices/${id}/abc.mp3`;

const raw = (over = {}) => ({
  voice_id: 'DefaultVoice00000001',
  name: 'Talia - Warm Soft Guide',
  category: 'premade',
  labels: { gender: 'female', accent: 'american', age: 'young', description: 'warm' },
  description: 'A warm, soft guide.',
  preview_url: PREVIEW('DefaultVoice00000001'),
  available_for_tiers: [],
  is_owner: false,
  is_legacy: false,
  ...over,
});

const DEFAULT = raw();
const OWN = raw({
  voice_id: 'OwnVoice000000000002',
  name: 'Designed Host',
  category: 'generated',
  is_owner: true,
  labels: { gender: 'female', accent: 'british' },
  preview_url:
    'https://storage.googleapis.com/eleven-public-prod/uid123/voices/OwnVoice000000000002/x.mp3',
});
const LIBRARY = raw({
  voice_id: 'LibraryVoice00000003',
  name: 'Emma',
  category: 'professional',
  labels: { gender: 'female', accent: 'american', use_case: 'narration' },
  preview_url: PREVIEW('LibraryVoice00000003'),
});

const page = (voices, { hasMore = false, token = null } = {}) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () =>
    JSON.stringify({ voices, has_more: hasMore, next_page_token: token, total_count: 0 }),
});

const refusal = (status, body) => ({
  ok: false,
  status,
  headers: { get: () => null },
  text: async () => body,
});

/** A listing stub: voice_type → the voices that listing returns. */
const listingFetch = (
  byType = { default: [DEFAULT], 'non-community': [OWN], community: [LIBRARY] }
) =>
  vi.fn(async (url) => {
    const type = new URL(url).searchParams.get('voice_type');
    return page(byType[type] ?? []);
  });

const FREE = { tier: 'free', freePlan: true };
const PAID = { tier: 'creator', freePlan: false };

beforeEach(() => {
  clearVoicesCache();
});

describe('voice ids', () => {
  it('look like every documented one: twenty letters and digits', () => {
    for (const id of ['EXAVITQu4vr4xnSDxMaL', '9BWtsMINqrJLrRacOk9x', 'sB1b5zUrxQVAFl2PhZFp']) {
      expect(isElevenLabsVoiceId(id)).toBe(true);
    }
    for (const bad of [
      'Kore',
      'en-US-AvaMultilingualNeural',
      '',
      ' EXAVITQu4vr4xnSDxMaL',
      'EXAVITQu4vr4xnSDxMa!',
      null,
      42,
    ]) {
      expect(isElevenLabsVoiceId(bad)).toBe(false);
    }
  });
});

describe('the preview allowlist', () => {
  it('admits ElevenLabs’s preview host and bucket, as the reference documents them', () => {
    expect(
      isAllowedPreviewUrl(
        'https://storage.googleapis.com/eleven-public-prod/premade/voices/9BWtsMINqrJLrRacOk9x/405766b8-1f4e-4d3c-aba1-6f25333823ec.mp3'
      )
    ).toBe(true);
    expect(
      isAllowedPreviewUrl(
        'https://storage.googleapis.com/eleven-public-prod/wqkMCd9huxXHX1dy5mLJn4QEQHj1/voices/sB1b5zUrxQVAFl2PhZFp/55e71aac-5cb7-4b3d-8241-429388160509.mp3'
      )
    ).toBe(true);
  });

  it('refuses everything else: other hosts, look-alikes, other buckets, climbs out, ports, credentials, queries', () => {
    const refused = [
      'http://storage.googleapis.com/eleven-public-prod/premade/a.mp3', // not https
      'https://storage.googleapis.com.evil.example/eleven-public-prod/a.mp3', // look-alike suffix
      'https://evil.example/storage.googleapis.com/eleven-public-prod/a.mp3', // host in the path
      'https://storage.googleapis.com@evil.example/eleven-public-prod/a.mp3', // userinfo trick
      'https://www.googleapis.com/eleven-public-prod/a.mp3', // a sibling Google host
      'https://evilstorage.googleapis.com/eleven-public-prod/a.mp3', // a subdomain look-alike
      'https://eleven-public-prod.storage.googleapis.com/a.mp3', // virtual-host style: not the allowlisted host
      'https://user:pw@storage.googleapis.com/eleven-public-prod/a.mp3', // credentials
      'https://user@storage.googleapis.com/eleven-public-prod/a.mp3', // a user name alone
      'https://storage.googleapis.com:8443/eleven-public-prod/a.mp3', // a port
      'https://storage.googleapis.com/someone-elses-bucket/a.mp3', // same host, other bucket
      'https://storage.googleapis.com/eleven-public-prod-evil/a.mp3', // prefix look-alike
      'https://storage.googleapis.com/eleven-public-prod/../other-bucket/a.mp3', // climbs out
      'https://storage.googleapis.com/eleven-public-prod/%2e%2e/other-bucket/a.mp3', // encoded climb
      'https://storage.googleapis.com/eleven-public-prod/', // the bucket root itself
      'https://storage.googleapis.com/eleven-public-prod/a.mp3?alt=media', // a query
      'https://storage.googleapis.com/eleven-public-prod/a.mp3#x', // a fragment
      'https://api.elevenlabs.io/v1/voices', // the API is not a preview host
      'https://169.254.169.254/eleven-public-prod/a.mp3', // metadata endpoint
      'file:///etc/passwd',
      'not a url',
      '',
      null,
      `https://storage.googleapis.com/eleven-public-prod/${'a'.repeat(2100)}.mp3`,
    ];
    for (const url of refused) expect(isAllowedPreviewUrl(url), String(url)).toBe(false);
  });
});

describe('readVoices', () => {
  it('lists the documented v2 endpoint once per voice_type, with the key header and the page size', async () => {
    const fetchImpl = listingFetch();
    await readVoices({ key: KEY, fetchImpl, sleep: noSleep });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const urls = fetchImpl.mock.calls.map(([url]) => new URL(url));
    for (const url of urls) {
      expect(`${url.origin}${url.pathname}`).toBe(VOICES_URL);
      expect(VOICES_URL).toBe('https://api.elevenlabs.io/v2/voices');
      expect(url.searchParams.get('page_size')).toBe('100');
      expect(url.searchParams.get('include_total_count')).toBe('false');
    }
    expect(urls.map((u) => u.searchParams.get('voice_type'))).toEqual([
      'default',
      'non-community',
      'community',
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', headers: { 'xi-api-key': KEY } });
    }
  });

  it('labels each voice by the listing that returned it, and keeps the preview URL to itself', async () => {
    const { voices, previews } = await readVoices({
      key: KEY,
      fetchImpl: listingFetch(),
      sleep: noSleep,
    });
    expect(voices.map((v) => [v.voiceId, v.type])).toEqual([
      ['DefaultVoice00000001', 'default'],
      ['OwnVoice000000000002', 'own'],
      ['LibraryVoice00000003', 'library'],
    ]);
    expect(voices[0]).toEqual({
      voiceId: 'DefaultVoice00000001',
      name: 'Talia - Warm Soft Guide',
      category: 'premade',
      type: 'default',
      labels: {
        gender: 'female',
        accent: 'american',
        age: 'young',
        description: 'warm',
        useCase: null,
      },
      description: 'A warm, soft guide.',
      legacy: false,
      tiers: [],
      hasPreview: true,
    });
    expect(voices[2].labels.useCase).toBe('narration');
    expect(JSON.stringify(voices)).not.toContain('storage.googleapis.com');
    expect(previews.get('LibraryVoice00000003')).toBe(PREVIEW('LibraryVoice00000003'));
  });

  it('follows next_page_token while has_more, and says when it stopped at the page cap', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const params = new URL(url).searchParams;
      if (params.get('voice_type') !== 'default') return page([]);
      const n = Number(params.get('next_page_token') || 0);
      return page([raw({ voice_id: `PagedVoice${String(n).padStart(10, '0')}` })], {
        hasMore: true,
        token: String(n + 1),
      });
    });
    const { voices, truncated } = await readVoices({ key: KEY, fetchImpl, sleep: noSleep });
    expect(voices).toHaveLength(MAX_VOICE_PAGES);
    expect(truncated).toBe(true);
    const tokens = fetchImpl.mock.calls
      .map(([url]) => new URL(url).searchParams)
      .filter((p) => p.get('voice_type') === 'default')
      .map((p) => p.get('next_page_token'));
    expect(tokens).toEqual([null, '1', '2', '3', '4']);
  });

  it('keeps the first label for a voice two listings return, and drops a voice with no id', async () => {
    const fetchImpl = listingFetch({
      default: [DEFAULT, raw({ voice_id: '' })],
      'non-community': [],
      community: [DEFAULT],
    });
    const { voices } = await readVoices({ key: KEY, fetchImpl, sleep: noSleep });
    expect(voices.map((v) => [v.voiceId, v.type])).toEqual([['DefaultVoice00000001', 'default']]);
  });

  it('drops a preview on a host outside the allowlist, so the voice has none', async () => {
    const fetchImpl = listingFetch({
      default: [raw({ preview_url: 'https://evil.example/eleven-public-prod/a.mp3' })],
    });
    const { voices, previews } = await readVoices({ key: KEY, fetchImpl, sleep: noSleep });
    expect(voices[0].hasPreview).toBe(false);
    expect(previews.size).toBe(0);
  });

  it('caches per key for five minutes, and reads again after', async () => {
    const fetchImpl = listingFetch();
    let clock = 1_000;
    const now = () => clock;
    await readVoices({ key: KEY, fetchImpl, sleep: noSleep, now });
    await readVoices({ key: KEY, fetchImpl, sleep: noSleep, now });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(VOICES_CACHE_TTL_MS).toBe(300_000);
    clock += VOICES_CACHE_TTL_MS + 1;
    await readVoices({ key: KEY, fetchImpl, sleep: noSleep, now });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('gives the cached names by id without listing, and nothing once the listing expires', async () => {
    let clock = 1_000;
    const now = () => clock;
    // Nothing cached yet: an empty map, and no request.
    expect(cachedVoiceNames(KEY, now)).toEqual(new Map());
    expect(cachedVoiceNames('', now)).toEqual(new Map());

    const fetchImpl = listingFetch();
    await readVoices({ key: KEY, fetchImpl, sleep: noSleep, now });
    const names = cachedVoiceNames(KEY, now);
    expect(names.get('DefaultVoice00000001')).toBe('Talia - Warm Soft Guide');
    expect(names.get('OwnVoice000000000002')).toBe('Designed Host');
    expect(cachedVoiceNames('another-key', now)).toEqual(new Map());
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    clock += VOICES_CACHE_TTL_MS;
    expect(cachedVoiceNames(KEY, now)).toEqual(new Map());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('names the Voices → Read permission when the key lacks it, and never the key', async () => {
    const fetchImpl = vi.fn(async () =>
      refusal(
        401,
        JSON.stringify({ detail: { status: 'missing_permissions', message: 'voices_read' } })
      )
    );
    let caught;
    try {
      await readVoices({ key: KEY, fetchImpl, sleep: noSleep });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: VOICES_UNAVAILABLE, status: 401, provider: 'elevenlabs' });
    // The sentence names the permission and where to set it, in this
    // module's words; ElevenLabs's own sentence no longer follows (#945).
    expect(caught.message).toBe(
      `Could not list the ElevenLabs voices (HTTP 401 missing_permissions: the key needs the Voices → Read permission (voices_read), set at ${API_KEYS_PAGE}).`
    );
    expect(caught.message).not.toContain(KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // a permission is not retried
  });

  // The live answer on 2026-09-26 was a 401 whose code was only
  // `unauthorized`; read alone it said "rejected the key" to an owner whose
  // key had just read the subscription.
  it('names the permission when only the sentence says so, without repeating the sentence', async () => {
    const sentence = 'The API key you used is missing the permission voices_read to execute this operation.';
    const fetchImpl = vi.fn(async () =>
      refusal(401, JSON.stringify({ detail: { code: 'unauthorized', message: sentence } }))
    );
    let caught;
    try {
      await readVoices({ key: 'permission-key', fetchImpl, sleep: noSleep });
    } catch (err) {
      caught = err;
    }
    expect(caught.message).toContain(
      `HTTP 401 unauthorized: the key needs the Voices → Read permission (voices_read), set at ${API_KEYS_PAGE})`
    );
    expect(caught.message).not.toContain(sentence);
  });

  it('says a refused key is refused, and never carries ElevenLabs\'s sentence or anything shaped like a key', async () => {
    const fetchImpl = vi.fn(async () =>
      refusal(401, JSON.stringify({ detail: { code: 'invalid_api_key', message: 'Invalid API key: sk_0123456789abcdef0123' } }))
    );
    let caught;
    try {
      await readVoices({ key: 'masked-key', fetchImpl, sleep: noSleep });
    } catch (err) {
      caught = err;
    }
    expect(caught.message).toBe('Could not list the ElevenLabs voices (HTTP 401 invalid_api_key: ElevenLabs rejected the key).');
    expect(caught.message).not.toContain('sk_0123456789abcdef0123');
  });

  it('names the status alone when the refusal\'s code echoes the request (#945)', async () => {
    const fetchImpl = vi.fn(async () =>
      refusal(400, JSON.stringify({ detail: { code: 'bad request: GET /v1/voices?page_size=100 key=sk_abcdef0123456789' } }))
    );
    const caught = await readVoices({ key: 'echo-key', fetchImpl, sleep: noSleep }).catch((e) => e);
    expect(caught.message).toBe('Could not list the ElevenLabs voices (HTTP 400).');
    expect(caught.message).not.toMatch(/page_size|sk_/);
  });

  it('retries a 429 and a 5xx, and reports a refused key and a non-JSON answer', async () => {
    let calls = 0;
    const flaky = vi.fn(async (url) => {
      calls += 1;
      if (calls === 1) return refusal(429, 'slow down');
      if (calls === 2) return refusal(503, 'busy');
      return listingFetch()(url);
    });
    const { voices } = await readVoices({ key: KEY, fetchImpl: flaky, sleep: noSleep });
    expect(voices).toHaveLength(3);

    await expect(
      readVoices({
        key: 'other-key',
        fetchImpl: vi.fn(async () =>
          refusal(401, JSON.stringify({ detail: { code: 'invalid_api_key' } }))
        ),
        sleep: noSleep,
      })
    ).rejects.toThrow(/HTTP 401 invalid_api_key: ElevenLabs rejected the key/);

    await expect(
      readVoices({
        key: 'third-key',
        fetchImpl: vi.fn(async () => ({ ok: true, status: 200, text: async () => '<html>' })),
        sleep: noSleep,
      })
    ).rejects.toThrow(/the answer was not JSON/);

    await expect(readVoices({ key: '', fetchImpl: vi.fn() })).rejects.toMatchObject({
      code: VOICES_UNAVAILABLE,
    });
  });
});

describe('which voices the plan allows', () => {
  const present = async () =>
    (await readVoices({ key: KEY, fetchImpl: listingFetch(), sleep: noSleep })).voices;

  it('on the free plan: default and own voices yes, a Voice Library voice no, with the reason shown', async () => {
    const listed = voicesForPlan(await present(), FREE);
    expect(listed.map((v) => [v.name, v.usable])).toEqual([
      ['Talia - Warm Soft Guide', true],
      ['Designed Host', true],
      ['Emma', false],
    ]);
    expect(listed[2].unavailableReason).toBe(
      'Voice Library voice: the free plan cannot use it through the API (HTTP 402 paid_plan_required).'
    );
    expect(listed[0].unavailableReason).toBeNull();
    expect(FREE_PLAN_RULE).toMatch(/own voices and its default voices, not Voice Library voices/);
  });

  it('on a paid plan the library voice is usable too', async () => {
    expect(voicesForPlan(await present(), PAID).every((v) => v.usable)).toBe(true);
  });

  it('with the plan unreadable, treats a library voice as the free plan would', async () => {
    const emma = voicesForPlan(await present(), null).find((v) => v.name === 'Emma');
    expect(emma.usable).toBe(false);
    expect(emma.unavailableReason).toMatch(/plan could not be read/);
  });

  it('marks a Legacy voice, a tier-restricted one and a malformed id unavailable, each with its reason', () => {
    const base = {
      voiceId: 'AnyVoice000000000009',
      name: 'x',
      type: 'default',
      legacy: false,
      tiers: [],
    };
    expect(voiceUsability({ ...base, legacy: true }, FREE)).toEqual({
      usable: false,
      reason:
        'Legacy voice: ElevenLabs routes its id to a replacement, so it would not sound like this preview.',
    });
    expect(voiceUsability({ ...base, tiers: ['creator', 'pro'] }, FREE)).toEqual({
      usable: false,
      reason: 'ElevenLabs offers it on the creator, pro plans only.',
    });
    expect(voiceUsability({ ...base, tiers: ['Free', 'starter'] }, FREE).usable).toBe(true);
    expect(voiceUsability({ ...base, voiceId: 'short' }, FREE).usable).toBe(false);
  });
});

describe('fetchVoicePreview', () => {
  const mp3 = () => Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]); // "ID3…"
  const audioResponse = (bytes = mp3(), headers = { 'content-type': 'audio/mpeg' }) => ({
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer,
  });

  /** Listing requests go to the listing stub; anything else to `preview`. */
  const fetchFor = (preview, byType) => {
    const listing = listingFetch(byType);
    return vi.fn(async (url, init) =>
      String(url).startsWith(VOICES_URL) ? listing(url, init) : preview(url, init)
    );
  };

  it('fetches the listed voice’s preview from the preview host, without the key and without redirects', async () => {
    const preview = vi.fn(async () => audioResponse());
    const fetchImpl = fetchFor(preview);
    const result = await fetchVoicePreview({
      key: KEY,
      voiceId: 'LibraryVoice00000003',
      fetchImpl,
      sleep: noSleep,
    });

    expect(result.contentType).toBe('audio/mpeg');
    expect(Buffer.isBuffer(result.audio)).toBe(true);
    expect([...result.audio.subarray(0, 3)]).toEqual([0x49, 0x44, 0x33]);

    expect(preview).toHaveBeenCalledTimes(1);
    const [url, init] = preview.mock.calls[0];
    expect(url).toBe(PREVIEW('LibraryVoice00000003'));
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(init)).not.toContain(KEY);
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('xi-api-key');
  });

  it('refuses an id that is not one, and an id the key cannot list, fetching no preview', async () => {
    const preview = vi.fn();
    const fetchImpl = fetchFor(preview);
    await expect(
      fetchVoicePreview({ key: KEY, voiceId: '../../etc', fetchImpl, sleep: noSleep })
    ).rejects.toMatchObject({ code: VOICE_NOT_LISTED, status: 400 });
    await expect(
      fetchVoicePreview({ key: KEY, voiceId: 'NotListedVoice000009', fetchImpl, sleep: noSleep })
    ).rejects.toMatchObject({ code: VOICE_NOT_LISTED, status: 404 });
    expect(preview).not.toHaveBeenCalled();
  });

  it('will not fetch a listed voice whose preview is off the allowlist', async () => {
    const preview = vi.fn();
    const fetchImpl = fetchFor(preview, {
      default: [raw({ preview_url: 'https://storage.googleapis.com/another-bucket/a.mp3' })],
    });
    await expect(
      fetchVoicePreview({ key: KEY, voiceId: 'DefaultVoice00000001', fetchImpl, sleep: noSleep })
    ).rejects.toMatchObject({ code: PREVIEW_UNAVAILABLE });
    expect(preview).not.toHaveBeenCalled();
  });

  it('checks the allowlist again at the point of use, whatever the listing handed back', async () => {
    const listVoices = vi.fn(async () => ({
      voices: [{ voiceId: 'DefaultVoice00000001' }],
      previews: new Map([['DefaultVoice00000001', 'https://evil.example/x.mp3']]),
    }));
    const fetchImpl = vi.fn();
    await expect(
      fetchVoicePreview({ key: KEY, voiceId: 'DefaultVoice00000001', fetchImpl, listVoices })
    ).rejects.toMatchObject({ code: PREVIEW_UNAVAILABLE });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a redirect, a failure, a non-audio answer and bytes that are not MP3', async () => {
    const cases = [
      [
        vi.fn(async () => {
          throw new TypeError('fetch failed: redirect mode is set to error');
        }),
        /Could not fetch the preview/,
      ],
      [
        vi.fn(async () => ({ ok: false, status: 403, headers: { get: () => null } })),
        /answered HTTP 403/,
      ],
      [
        vi.fn(async () => audioResponse(mp3(), { 'content-type': 'text/html' })),
        /text\/html, not audio/,
      ],
      [
        // A header that is not a media type is not repeated (#945).
        vi.fn(async () => audioResponse(mp3(), { 'content-type': 'text/<img src=x onerror=alert(1)>' })),
        /answered an unexpected content type, not audio/,
      ],
      [vi.fn(async () => audioResponse(Uint8Array.from([0x3c, 0x68, 0x74, 0x6d]))), /not MP3/],
    ];
    for (const [preview, message] of cases) {
      clearVoicesCache();
      await expect(
        fetchVoicePreview({
          key: KEY,
          voiceId: 'DefaultVoice00000001',
          fetchImpl: fetchFor(preview),
          sleep: noSleep,
        })
      ).rejects.toMatchObject({ code: PREVIEW_FAILED, message: expect.stringMatching(message) });
    }
  });

  it('caps the size: a declared length over the cap is not read, and a stream is cut off at it', async () => {
    const arrayBuffer = vi.fn();
    const oversized = {
      'content-type': 'audio/mpeg',
      'content-length': String(MAX_PREVIEW_BYTES + 1),
    };
    const declared = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => oversized[name.toLowerCase()] ?? null },
      arrayBuffer,
    }));
    await expect(
      fetchVoicePreview({
        key: KEY,
        voiceId: 'DefaultVoice00000001',
        fetchImpl: fetchFor(declared),
        sleep: noSleep,
      })
    ).rejects.toThrow(/over the 2097152-byte cap/);
    expect(arrayBuffer).not.toHaveBeenCalled();

    // No declared length: the stream is read chunk by chunk and cancelled past the cap.
    const cancel = vi.fn(async () => {});
    const chunk = new Uint8Array(1024 * 1024).fill(0xff);
    let reads = 0;
    const streamed = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return reads > 10 ? { done: true } : { done: false, value: chunk };
          },
          cancel,
        }),
      },
    }));
    clearVoicesCache();
    await expect(
      fetchVoicePreview({
        key: KEY,
        voiceId: 'DefaultVoice00000001',
        fetchImpl: fetchFor(streamed),
        sleep: noSleep,
      })
    ).rejects.toMatchObject({ code: PREVIEW_FAILED });
    expect(cancel).toHaveBeenCalled();
    expect(reads).toBe(3); // 1 MiB, 2 MiB, then over
  });

  it('reads a stream that fits, and accepts an MPEG frame sync as MP3', async () => {
    const frame = Uint8Array.from([0xff, 0xfb, 0x90, 0x64]);
    let sent = false;
    const streamed = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            sent ? { done: true } : ((sent = true), { done: false, value: frame }),
          cancel: async () => {},
        }),
      },
    }));
    const { audio } = await fetchVoicePreview({
      key: KEY,
      voiceId: 'DefaultVoice00000001',
      fetchImpl: fetchFor(streamed),
      sleep: noSleep,
    });
    expect([...audio]).toEqual([0xff, 0xfb, 0x90, 0x64]);
    expect(looksLikeMp3(Uint8Array.from([0xff, 0xe3, 0]))).toBe(true);
    expect(looksLikeMp3(Uint8Array.from([0xff, 0x00, 0]))).toBe(false);
    expect(looksLikeMp3(Uint8Array.from([]))).toBe(false);
  });
});
