/**
 * Platform settings — the load-bearing assertions: every stored document is
 * exactly the shape its consumer reads (pinned by running the consumers'
 * own readers over what the normalizer produces), unknown keys are refused
 * rather than dropped, the setting segment is allowlisted, and neither a
 * log line nor an audit row ever carries a document's contents.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  HERO_PROVIDERS,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  MAX_SCHEDULE_DELAY_MINUTES,
  PLATFORM_SETTING_AUDIT_ACTION,
  parseHistoryQuery,
  presentHistoryEntry,
  MERGE_WRITE_ATTEMPTS,
  PLATFORM_SETTINGS,
  PLATFORM_SETTING_NAMES,
  PlatformSettingValidationError,
  createPlatformSettingsHandlers,
  isAcceptableHeroUrl,
  normalizeDefaultHeroes,
  normalizeNewsletterSettings,
  normalizePodcastFeeds,
  normalizePodcastVoices,
  normalizeSocialAutopost,
  presentSetting,
  resolveSetting,
} from './platform-settings.js';
import { pickDefaultHero, DEFAULT_HEROES_CONFIG_ID } from './triggers/ai-cover.js';
import { AUTOPOST_CONFIG_ID } from './triggers/social-caption-trigger.js';
import {
  MAIN_FEED_PROVIDER,
  PODCAST_FEEDS_CONFIG_ID,
  resolvePodcastFeeds,
} from './timers/podcasts.js';
import { ADMIN_CONFIG_PARTITION } from './cosmos-client.js';
import { PODCAST_VOICES_CONFIG_ID, readStoredPodcastVoices } from './podcast/voice-settings.js';
import { MAX_ITEMS_PER_SECTION, SECTIONS } from './newsletter/sections.js';

const context = { log: vi.fn(), error: vi.fn() };

const allowGuard = {
  requireRole: vi.fn(async () => ({
    user: { oid: 'u1', email: 'owner@example.com' },
    role: 'editor',
    error: null,
  })),
};
const denyGuard = {
  requireRole: vi.fn(async () => ({ user: null, role: null, error: { status: 403, body: '{}' } })),
};

const makeRequest = ({ params = {}, body } = {}) => ({
  params,
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

function makeStore(over = {}) {
  return {
    readDoc: vi.fn(async () => null),
    upsertDoc: vi.fn(async (_c, d) => d),
    replaceDocIfMatch: vi.fn(async (_c, d) => d),
    createDoc: vi.fn(async (_c, d) => d),
    ...over,
  };
}

/** The admin_config document a save wrote, by whichever write it took. */
const writtenConfig = (store) =>
  [store.replaceDocIfMatch, store.createDoc, store.upsertDoc]
    .flatMap((fn) => fn?.mock?.calls ?? [])
    .find(([container]) => container === 'admin_config')?.[1];

const fixed = { now: () => new Date('2026-09-07T12:00:00.000Z'), uuid: () => 'fixed-uuid' };
const parse = (res) => JSON.parse(res.body);

const expectRejects = (fn, pattern) => {
  expect(fn).toThrow(PlatformSettingValidationError);
  expect(fn).toThrow(pattern);
};

describe('default heroes', () => {
  it('stores the canonical key for a case-insensitive provider, drops blanks, refuses unknown providers', () => {
    const out = normalizeDefaultHeroes({
      heroes: { azure: '/images/default-heroes/azure.png', AWS: '  ', gcp: '', Multi: '/m.png' },
    });
    expect(out).toEqual({
      heroes: { Azure: '/images/default-heroes/azure.png', Multi: '/m.png' },
    });
    expectRejects(
      () => normalizeDefaultHeroes({ heroes: { Oracle: '/o.png' } }),
      /Unknown hero provider "Oracle"/
    );
    expectRejects(
      () => normalizeDefaultHeroes({ heroes: {}, extra: 1 }),
      /Unknown field\(s\) in body/
    );
    expectRejects(() => normalizeDefaultHeroes({ heroes: [] }), /heroes must be an object/);
    expectRejects(
      () => normalizeDefaultHeroes({ heroes: { Azure: '/a.png', azure: '/b.png' } }),
      /given more than once/
    );
  });

  it('accepts same-origin paths, media routes and https; refuses everything else', () => {
    expect(isAcceptableHeroUrl('/images/default-heroes/azure.png')).toBe(true);
    expect(isAcceptableHeroUrl('/api/public/media/covers/azure.png')).toBe(true);
    expect(isAcceptableHeroUrl('https://cdn.example.com/a.png')).toBe(true);
    expect(isAcceptableHeroUrl('http://cdn.example.com/a.png')).toBe(false);
    expect(isAcceptableHeroUrl('//evil.example.com/a.png')).toBe(false);
    expect(isAcceptableHeroUrl('javascript:alert(1)')).toBe(false);
    expect(isAcceptableHeroUrl('/a b.png')).toBe(false);
    expect(isAcceptableHeroUrl('/a"onerror="x')).toBe(false);
    expect(isAcceptableHeroUrl(`/${'x'.repeat(2048)}`)).toBe(false);
    // A query string or fragment could carry a SAS token or signature, and
    // this value is copied onto published content documents.
    expect(isAcceptableHeroUrl('/api/public/media/covers/a.png?sv=2024&sig=abc')).toBe(false);
    expect(isAcceptableHeroUrl('/images/default-heroes/a.png#x')).toBe(false);
    expect(isAcceptableHeroUrl('https://cdn.example.com/a.png?sig=abc')).toBe(false);
    expect(isAcceptableHeroUrl('https://cdn.example.com/a.png#frag')).toBe(false);
    expectRejects(
      () => normalizeDefaultHeroes({ heroes: { AWS: 'https://cdn.example.com/a.png?sig=abc' } }),
      /no query string or fragment/
    );
    expectRejects(
      () => normalizeDefaultHeroes({ heroes: { Azure: 'http://x/a.png' } }),
      /heroes.Azure must be a same-origin path/
    );
    expectRejects(() => normalizeDefaultHeroes({ heroes: { Azure: 7 } }), /must be a string/);
  });

  it('produces exactly what pickDefaultHero reads', () => {
    const { heroes } = normalizeDefaultHeroes({
      heroes: Object.fromEntries(HERO_PROVIDERS.map((p) => [p, `/images/${p.toLowerCase()}.png`])),
    });
    expect(pickDefaultHero(heroes, 'Google Cloud')).toBe('/images/gcp.png');
    expect(pickDefaultHero(heroes, 'AWS')).toBe('/images/aws.png');
    expect(pickDefaultHero(heroes, 'unknown')).toBe('/images/multi.png');
    expect(pickDefaultHero(normalizeDefaultHeroes({ heroes: {} }).heroes, 'AWS')).toBeNull();
  });
});

describe('social autopost', () => {
  it('normalizes a good body and applies the consumer-facing defaults', () => {
    expect(
      normalizeSocialAutopost({
        enabled: true,
        accountIds: [
          { id: ' acc-1 ', provider: 'LinkedIn' },
          { id: 'acc-1', provider: 'linkedin' },
          { id: 'acc-2', provider: 'twitter' },
        ],
        scheduleDelayMinutes: '90',
      })
    ).toEqual({
      enabled: true,
      accountIds: [
        { id: 'acc-1', provider: 'linkedin' },
        { id: 'acc-2', provider: 'twitter' },
      ],
      scheduleDelayMinutes: 90,
    });
    expect(normalizeSocialAutopost({})).toEqual({
      enabled: false,
      accountIds: [],
      scheduleDelayMinutes: 60,
    });
  });

  it('refuses ambiguous booleans, bad delays, bad accounts and unknown keys', () => {
    expectRejects(
      () => normalizeSocialAutopost({ enabled: 'false' }),
      /enabled must be true or false/
    );
    expectRejects(
      () => normalizeSocialAutopost({ scheduleDelayMinutes: 0 }),
      /whole number from 1/
    );
    expectRejects(
      () => normalizeSocialAutopost({ scheduleDelayMinutes: 1.5 }),
      /whole number from 1/
    );
    expectRejects(
      () => normalizeSocialAutopost({ scheduleDelayMinutes: MAX_SCHEDULE_DELAY_MINUTES + 1 }),
      /whole number from 1/
    );
    expectRejects(
      () => normalizeSocialAutopost({ accountIds: 'x' }),
      /accountIds must be an array/
    );
    expectRejects(
      () => normalizeSocialAutopost({ accountIds: [{ provider: 'linkedin' }] }),
      /id is required/
    );
    expectRejects(
      () => normalizeSocialAutopost({ accountIds: [{ id: 'a', provider: 'myspace' }] }),
      /provider must be one of/
    );
    expectRejects(
      () =>
        normalizeSocialAutopost({ accountIds: [{ id: 'a', provider: 'linkedin', token: 'x' }] }),
      /Unknown field\(s\) in accountIds\[0\]/
    );
    expectRejects(
      () => normalizeSocialAutopost({ enabled: true, accountIds: [] }),
      /at least one account/
    );
    expectRejects(() => normalizeSocialAutopost({ foo: 1 }), /Unknown field\(s\) in body/);
  });
});

describe('podcast feeds', () => {
  it('drops blank rows, keeps rows the timer accepts, refuses the rest', () => {
    expect(
      normalizePodcastFeeds({
        feeds: [
          { provider: 'azure', url: 'https://feeds.example.com/azure.xml' },
          { provider: 'aws', url: '' },
          { provider: 'gcp', url: '   ' },
        ],
      })
    ).toEqual({ feeds: [{ provider: 'azure', url: 'https://feeds.example.com/azure.xml' }] });
    expectRejects(
      () => normalizePodcastFeeds({ feeds: [{ provider: 'azure', url: 'http://x.example/f' }] }),
      /must be an https URL/
    );
    expectRejects(
      () =>
        normalizePodcastFeeds({ feeds: [{ provider: 'Azure Cloud', url: 'https://x.example/f' }] }),
      /lowercase slug/
    );
    expectRejects(
      () =>
        normalizePodcastFeeds({
          feeds: [
            { provider: 'azure', url: 'https://x.example/a' },
            { provider: 'azure', url: 'https://x.example/b' },
          ],
        }),
      /only one feed/
    );
    expectRejects(
      () =>
        normalizePodcastFeeds({
          feeds: [{ provider: 'azure', url: 'https://x.example/f', extra: 1 }],
        }),
      /Unknown field/
    );
    expectRejects(() => normalizePodcastFeeds({ feeds: {} }), /feeds must be an array/);
  });

  it('produces exactly what resolvePodcastFeeds runs', async () => {
    const value = normalizePodcastFeeds({
      feeds: [{ provider: 'finops', url: 'https://x.example/finops.rss' }],
    });
    const store = { readDoc: vi.fn(async () => ({ id: PODCAST_FEEDS_CONFIG_ID, ...value })) };
    await expect(resolvePodcastFeeds(store)).resolves.toEqual({
      feeds: [{ provider: 'finops', url: 'https://x.example/finops.rss' }],
      source: 'admin_config',
    });
  });

  it('keeps the main feed beside the provider rows, and omits it when blank', () => {
    // The compatibility rule this shape exists for: a document stored before
    // the field existed still normalizes, unchanged, and is not reported as
    // drifted.
    expect(
      normalizePodcastFeeds({
        mainFeedUrl: '  https://media.rss.com/hybrid-cloud-insights/feed.xml  ',
        feeds: [{ provider: 'azure', url: 'https://x.example/azure.xml' }],
      })
    ).toEqual({
      mainFeedUrl: 'https://media.rss.com/hybrid-cloud-insights/feed.xml',
      feeds: [{ provider: 'azure', url: 'https://x.example/azure.xml' }],
    });
    expect(normalizePodcastFeeds({ mainFeedUrl: '   ', feeds: [] })).toEqual({ feeds: [] });
    expect(normalizePodcastFeeds({ feeds: [] })).toEqual({ feeds: [] });
    expectRejects(
      () => normalizePodcastFeeds({ mainFeedUrl: 'http://insecure.example/feed.xml' }),
      /mainFeedUrl must be an https URL/
    );
    expectRejects(() => normalizePodcastFeeds({ mainFeedUrl: 7 }), /mainFeedUrl must be a string/);
  });

  it('refuses the two ways one feed could become two shows', () => {
    // `main` as a provider row: two places to say the same thing, one of
    // which the page cannot edit.
    expectRejects(
      () => normalizePodcastFeeds({ feeds: [{ provider: 'main', url: 'https://x.example/f' }] }),
      /reserved/
    );
    // The same URL in both: both ingests build the same episode ids from the
    // same guids, so each run would overwrite the other's `provider` and the
    // episode would flip between the show and a provider every two hours.
    expectRejects(
      () =>
        normalizePodcastFeeds({
          mainFeedUrl: 'https://x.example/f',
          feeds: [{ provider: 'azure', url: 'https://x.example/f' }],
        }),
      /already the main feed/
    );
  });

  it('runs the main feed as an ordinary entry under the reserved provider', async () => {
    const value = normalizePodcastFeeds({
      mainFeedUrl: 'https://media.rss.com/hybrid-cloud-insights/feed.xml',
      feeds: [{ provider: 'finops', url: 'https://x.example/finops.rss' }],
    });
    const store = { readDoc: vi.fn(async () => ({ id: PODCAST_FEEDS_CONFIG_ID, ...value })) };
    await expect(resolvePodcastFeeds(store)).resolves.toEqual({
      feeds: [
        {
          provider: MAIN_FEED_PROVIDER,
          url: 'https://media.rss.com/hybrid-cloud-insights/feed.xml',
        },
        { provider: 'finops', url: 'https://x.example/finops.rss' },
      ],
      source: 'admin_config',
    });
  });
});

describe('podcast voices (#725)', () => {
  const MAYA = 'MayaVoice00000000001';
  const ELENA = 'ElenaVoice0000000002';

  it('stores the two hosts’ ElevenLabs voice ids, trimmed', () => {
    expect(normalizePodcastVoices({ Maya: ` ${MAYA} `, Elena: ELENA })).toEqual({
      Maya: MAYA,
      Elena: ELENA,
    });
  });

  it('refuses a missing host, a blank one, a non-id, the same voice twice and an unknown key', () => {
    expectRejects(() => normalizePodcastVoices({ Maya: MAYA }), /Elena needs a voice/);
    expectRejects(() => normalizePodcastVoices({ Maya: '  ', Elena: ELENA }), /Maya needs a voice/);
    // A Gemini name, an Azure name, a URL: none is an ElevenLabs voice id.
    for (const bad of ['Kore', 'en-US-AvaMultilingualNeural', 'https://evil.example/a.mp3', 42]) {
      expect(() => normalizePodcastVoices({ Maya: bad, Elena: ELENA }), String(bad)).toThrow(
        PlatformSettingValidationError
      );
    }
    expectRejects(
      () => normalizePodcastVoices({ Maya: 'Kore', Elena: ELENA }),
      'Maya must be an ElevenLabs voice id, 20 letters and digits as the voice list shows it'
    );
    expectRejects(
      () => normalizePodcastVoices({ Maya: MAYA, Elena: MAYA }),
      'Maya and Elena must have different voices, so a listener can tell the hosts apart'
    );
    expectRejects(
      () => normalizePodcastVoices({ Maya: MAYA, Elena: ELENA, Narrator: ELENA }),
      /Unknown field\(s\) in body: Narrator/
    );
    expectRejects(() => normalizePodcastVoices(null), /Body must be a JSON object/);
  });

  it('produces exactly what every podcast render reads back', async () => {
    const value = normalizePodcastVoices({ Maya: MAYA, Elena: ELENA });
    const readDoc = vi.fn(async () => ({
      id: PODCAST_VOICES_CONFIG_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      ...value,
    }));
    expect(await readStoredPodcastVoices(readDoc)).toEqual({ Maya: MAYA, Elena: ELENA });
  });

  it('shows both hosts unset when nothing is stored: the code has no default voice', () => {
    expect(presentSetting('podcast-voices', null)).toEqual({
      value: { Maya: '', Elena: '' },
      exists: false,
      stored: null,
      updatedAt: null,
    });
  });

  it('PUT stores the choice at admin_config/podcast_voices and audits both ids', async () => {
    const store = makeStore();
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.putSetting(
      makeRequest({ params: { setting: 'podcast-voices' }, body: { Maya: MAYA, Elena: ELENA } }),
      context
    );
    expect(res.status).toBe(200);
    expect(parse(res)).toMatchObject({ value: { Maya: MAYA, Elena: ELENA }, stored: 'valid' });
    const [configCall, auditCall] = store.upsertDoc.mock.calls;
    expect(configCall).toEqual([
      'admin_config',
      {
        id: PODCAST_VOICES_CONFIG_ID,
        configScope: ADMIN_CONFIG_PARTITION,
        Maya: MAYA,
        Elena: ELENA,
        updatedAt: '2026-09-07T12:00:00.000Z',
        updatedBy: 'u1',
      },
    ]);
    expect(auditCall[1].details).toEqual({ setting: 'podcast-voices', Maya: MAYA, Elena: ELENA });
  });

  it('PUT answers 400 for two identical voices and writes nothing', async () => {
    const store = makeStore();
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.putSetting(
      makeRequest({ params: { setting: 'podcast-voices' }, body: { Maya: MAYA, Elena: MAYA } }),
      context
    );
    expect(res.status).toBe(400);
    expect(parse(res).error).toMatch(/must have different voices/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});

describe('newsletter settings', () => {
  const DEFAULT_CONTENT = {
    sections: [
      { id: 'articles', enabled: true, maxItems: 12 },
      { id: 'certification-news', enabled: true, maxItems: 12 },
      { id: 'episodes', enabled: true, maxItems: 12 },
      { id: 'cloud-price-changes', enabled: true, maxItems: 12 },
      { id: 'lab-this-week', enabled: true, maxItems: 12 },
    ],
    windowDays: 7,
    introEnabled: true,
    introTone: 'professional',
  };

  const DEFAULT_SIGNUP = {
    signupPlacement: 'both',
    signupHeading: 'Stay ahead of the cloud curve.',
    signupBlurb:
      'Practical hybrid & multi-cloud insights, straight to your inbox. No spam — unsubscribe anytime.',
    // The built-in design (#557): no Resend template chosen.
    templateId: '',
  };

  it('defaults to Tuesday 09:00 Central with nothing personal filled in, and every section', () => {
    expect(normalizeNewsletterSettings({})).toEqual({
      postalAddress: '',
      replyTo: '',
      sendDay: 'tuesday',
      sendTime: '09:00',
      timeZone: 'America/Chicago',
      ...DEFAULT_CONTENT,
      ...DEFAULT_SIGNUP,
    });
  });

  it('defaults the content to every registered section in registry order at the builder limit', () => {
    expect(DEFAULT_CONTENT.sections.map((s) => s.id)).toEqual(SECTIONS.map((s) => s.id));
    expect(DEFAULT_CONTENT.sections.every((s) => s.maxItems === MAX_ITEMS_PER_SECTION)).toBe(true);
  });

  it('reads a document saved before the content fields existed as the defaults, with no migration', () => {
    const legacy = {
      id: 'newsletter_settings',
      configScope: ADMIN_CONFIG_PARTITION,
      postalAddress: 'PO Box 1',
      replyTo: 'owner@example.com',
      sendDay: 'thursday',
      sendTime: '07:30',
      timeZone: 'Europe/London',
      updatedAt: '2026-09-01T00:00:00Z',
    };
    const shown = presentSetting('newsletter-settings', legacy);
    expect(shown.stored).toBe('valid');
    expect(shown.value).toMatchObject(DEFAULT_CONTENT);
    expect(shown.value).toMatchObject(DEFAULT_SIGNUP);
    expect(shown.value.postalAddress).toBe('PO Box 1');
  });

  it('keeps a saved order, on/off and item counts', () => {
    const value = normalizeNewsletterSettings({
      sections: [
        { id: 'episodes', enabled: true, maxItems: 3 },
        { id: 'cloud-price-changes', enabled: false, maxItems: 4 },
        { id: 'articles', enabled: false, maxItems: 5 },
        { id: 'certification-news', enabled: true, maxItems: 20 },
      ],
      windowDays: 14,
      introEnabled: false,
      introTone: 'concise',
    });
    expect(value).toMatchObject({
      sections: [
        { id: 'episodes', enabled: true, maxItems: 3 },
        { id: 'cloud-price-changes', enabled: false, maxItems: 4 },
        { id: 'articles', enabled: false, maxItems: 5 },
        { id: 'certification-news', enabled: true, maxItems: 20 },
        { id: 'lab-this-week', enabled: true, maxItems: 12 },
      ],
      windowDays: 14,
      introEnabled: false,
      introTone: 'concise',
    });
  });

  it('drops unknown and repeated section ids, and appends missing ones enabled at the default', () => {
    expect(
      normalizeNewsletterSettings({
        sections: [
          { id: 'retired-section', enabled: true, maxItems: 4 },
          { id: 'episodes', enabled: false, maxItems: 2 },
          { id: 'episodes', enabled: true, maxItems: 9 },
          { id: 'articles', enabled: true, maxItems: 6 },
        ],
      }).sections
    ).toEqual([
      { id: 'episodes', enabled: false, maxItems: 2 },
      { id: 'articles', enabled: true, maxItems: 6 },
      { id: 'certification-news', enabled: true, maxItems: 12 },
      { id: 'cloud-price-changes', enabled: true, maxItems: 12 },
      { id: 'lab-this-week', enabled: true, maxItems: 12 },
    ]);
  });

  it('drops a retired section row before validating it, so its extra keys never invalidate the document', () => {
    expect(
      normalizeNewsletterSettings({
        sections: [
          { id: 'retired-section', enabled: null, maxItems: 'lots', legacyFlag: true },
          { id: 'articles', enabled: true, maxItems: 5 },
          { id: 'articles', enabled: 'yes', extra: 1 },
        ],
      }).sections
    ).toEqual([
      { id: 'articles', enabled: true, maxItems: 5 },
      { id: 'certification-news', enabled: true, maxItems: 12 },
      { id: 'episodes', enabled: true, maxItems: 12 },
      { id: 'cloud-price-changes', enabled: true, maxItems: 12 },
      { id: 'lab-this-week', enabled: true, maxItems: 12 },
    ]);
  });

  it('refuses enabled: null on a known section rather than treating it as on', () => {
    expect(() =>
      normalizeNewsletterSettings({ sections: [{ id: 'articles', enabled: null, maxItems: 5 }] })
    ).toThrow(/enabled must be true or false/);
  });

  it('clamps item counts to 1..20 and the window to 1..31', () => {
    const value = normalizeNewsletterSettings({
      sections: [
        { id: 'articles', enabled: true, maxItems: 0 },
        { id: 'certification-news', enabled: true, maxItems: 99 },
        { id: 'episodes', enabled: true, maxItems: '7.8' },
        { id: 'cloud-price-changes', enabled: true, maxItems: 21 },
        { id: 'lab-this-week', enabled: true, maxItems: 2 },
      ],
      windowDays: 400,
    });
    expect(value.sections.map((s) => s.maxItems)).toEqual([1, 20, 7, 20, 2]);
    expect(value.windowDays).toBe(31);
    expect(normalizeNewsletterSettings({ windowDays: -3 }).windowDays).toBe(1);
    expect(normalizeNewsletterSettings({ windowDays: '10' }).windowDays).toBe(10);
  });

  it('requires at least one section to be on, counting the appended ones', () => {
    expect(() =>
      normalizeNewsletterSettings({
        sections: [
          { id: 'articles', enabled: false },
          { id: 'certification-news', enabled: false },
          { id: 'episodes', enabled: false },
          { id: 'cloud-price-changes', enabled: false },
          { id: 'lab-this-week', enabled: false },
        ],
      })
    ).toThrow(/at least one section/);
    // A list naming only one section, turned off, still has the other four appended on.
    expect(
      normalizeNewsletterSettings({
        sections: [{ id: 'articles', enabled: false }],
      }).sections.filter((s) => s.enabled)
    ).toHaveLength(4);
  });

  it('refuses content values that cannot be read', () => {
    for (const bad of [
      { sections: 'articles' },
      { sections: [{ id: 'articles', enabled: 'yes' }] },
      { sections: [{ id: 'articles', maxItems: 'lots' }] },
      { sections: [{ id: 'articles', colour: 'red' }] },
      { sections: [{ id: 7 }] },
      { windowDays: 'a week' },
      { introEnabled: 'false' },
      { introTone: 'sarcastic' },
    ]) {
      expect(() => normalizeNewsletterSettings(bad), JSON.stringify(bad)).toThrow(
        PlatformSettingValidationError
      );
    }
  });

  it('accepts exactly the offered tones', () => {
    for (const tone of ['professional', 'friendly', 'concise', 'enthusiastic']) {
      expect(normalizeNewsletterSettings({ introTone: tone }).introTone).toBe(tone);
    }
    expect(() => normalizeNewsletterSettings({ introTone: 'Professional' })).toThrow(/introTone/);
  });

  it('offers the section titles, tones and bounds beside the value', () => {
    expect(PLATFORM_SETTINGS['newsletter-settings'].options()).toEqual({
      sections: SECTIONS.map((s) => ({ id: s.id, title: s.title })),
      introTones: ['professional', 'friendly', 'concise', 'enthusiastic'],
      windowDays: { min: 1, max: 31 },
      maxItems: { min: 1, max: 20 },
      signupPlacements: ['footer', 'blogEnd', 'both', 'none'],
      signupHeading: { maxLength: 80 },
      signupBlurb: { maxLength: 240 },
    });
  });

  describe('template', () => {
    it('defaults to the built-in design, including for a document saved before the field existed', () => {
      expect(normalizeNewsletterSettings({}).templateId).toBe('');
      const legacy = {
        id: 'newsletter_settings',
        postalAddress: 'PO Box 1',
        signupPlacement: 'footer',
      };
      const shown = presentSetting('newsletter-settings', legacy);
      expect(shown.stored).toBe('valid');
      expect(shown.value.templateId).toBe('');
    });

    it('keeps a Resend template id, trimmed, and an explicit empty string', () => {
      expect(
        normalizeNewsletterSettings({ templateId: ' 34a080c9-b17d-4187-ad80-5af20266e535 ' })
          .templateId
      ).toBe('34a080c9-b17d-4187-ad80-5af20266e535');
      expect(normalizeNewsletterSettings({ templateId: 'x'.repeat(64) }).templateId).toBe(
        'x'.repeat(64)
      );
      expect(normalizeNewsletterSettings({ templateId: '   ' }).templateId).toBe('');
    });

    it('refuses anything that is not an id or not a string', () => {
      for (const bad of ['a/b', '../templates', 'a.b', 'a b', 'x'.repeat(65), 'id?x=1']) {
        expectRejects(
          () => normalizeNewsletterSettings({ templateId: bad }),
          /templateId must be empty/
        );
      }
      expectRejects(
        () => normalizeNewsletterSettings({ templateId: 7 }),
        /templateId must be a string/
      );
      expectRejects(
        () => normalizeNewsletterSettings({ templateId: null }),
        /templateId must be a string/
      );
    });
  });

  describe('signup form', () => {
    it('defaults to the box in both places with the wording the site carried before', () => {
      expect(normalizeNewsletterSettings({})).toMatchObject(DEFAULT_SIGNUP);
    });

    it('keeps each placement it offers', () => {
      for (const placement of ['footer', 'blogEnd', 'both', 'none']) {
        expect(normalizeNewsletterSettings({ signupPlacement: placement }).signupPlacement).toBe(
          placement
        );
      }
    });

    it('refuses a placement it does not offer, by name, before reading the wording', () => {
      for (const bad of ['Footer', 'sidebar', '', null, 1, ['footer']]) {
        expectRejects(
          () =>
            normalizeNewsletterSettings({
              signupPlacement: bad,
              signupHeading: 42,
              signupBlurb: {},
            }),
          /signupPlacement must be one of footer, blogEnd, both, none/
        );
      }
    });

    it('trims the heading and blurb and folds line breaks and runs of spaces into one space', () => {
      const value = normalizeNewsletterSettings({
        signupHeading: '  Get the\r\nweekly   brief  ',
        signupBlurb: '\tOne email.\n\nEvery Tuesday. \u0007',
      });
      expect(value.signupHeading).toBe('Get the weekly brief');
      expect(value.signupBlurb).toBe('One email. Every Tuesday.');
    });

    it('keeps markup as the literal text it is', () => {
      expect(
        normalizeNewsletterSettings({ signupHeading: '<b>Bold</b> & more' }).signupHeading
      ).toBe('<b>Bold</b> & more');
    });

    it('accepts the heading at 80 characters and the blurb at 240, measured after trimming', () => {
      const value = normalizeNewsletterSettings({
        signupHeading: ` ${'h'.repeat(80)} `,
        signupBlurb: ` ${'b'.repeat(240)} `,
      });
      expect(value.signupHeading).toHaveLength(80);
      expect(value.signupBlurb).toHaveLength(240);
    });

    it('refuses a heading over 80 characters or a blurb over 240', () => {
      expectRejects(
        () => normalizeNewsletterSettings({ signupHeading: 'h'.repeat(81) }),
        /signupHeading must be at most 80 characters/
      );
      expectRejects(
        () => normalizeNewsletterSettings({ signupBlurb: 'b'.repeat(241) }),
        /signupBlurb must be at most 240 characters/
      );
    });

    it('refuses a blank heading but allows a blank blurb', () => {
      expectRejects(
        () => normalizeNewsletterSettings({ signupHeading: '  \n ' }),
        /must not be blank/
      );
      expect(normalizeNewsletterSettings({ signupBlurb: '   ' }).signupBlurb).toBe('');
    });

    it('refuses wording that is not a string', () => {
      expectRejects(
        () => normalizeNewsletterSettings({ signupHeading: 7 }),
        /signupHeading must be a string/
      );
      expectRejects(
        () => normalizeNewsletterSettings({ signupBlurb: null }),
        /signupBlurb must be a string/
      );
    });
  });

  it('keeps a multi-line postal address and a real reply-to', () => {
    expect(
      normalizeNewsletterSettings({
        postalAddress: ' PO Box 1\r\nAustin, TX 78701 ',
        replyTo: 'owner@example.com',
        sendDay: 'thursday',
        sendTime: '07:30',
        timeZone: 'Europe/London',
      })
    ).toEqual({
      postalAddress: 'PO Box 1\nAustin, TX 78701',
      replyTo: 'owner@example.com',
      sendDay: 'thursday',
      sendTime: '07:30',
      timeZone: 'Europe/London',
      ...DEFAULT_CONTENT,
      ...DEFAULT_SIGNUP,
    });
  });

  it('refuses a reply-to on the sending subdomain, which receives no mail', () => {
    expect(() =>
      normalizeNewsletterSettings({ replyTo: 'hello@news.hybridcloudworks.com' })
    ).toThrow(/does not/);
  });

  it('refuses what cannot describe a send', () => {
    for (const bad of [
      { replyTo: 'not an address' },
      { sendDay: 'someday' },
      { sendTime: '9am' },
      { timeZone: 'Central' },
      { postalAddress: 'x'.repeat(301) },
      { unexpected: true },
    ]) {
      expect(() => normalizeNewsletterSettings(bad), JSON.stringify(bad)).toThrow(
        PlatformSettingValidationError
      );
    }
  });
});

describe('presentSetting', () => {
  it('names the seven settings and nothing else — the Listen & Learn voice left for AI Engine → Tasks (ADR 0034 slice 5); reminders joined 2026-10-06', () => {
    expect(PLATFORM_SETTING_NAMES).toEqual([
      'default-heroes',
      'social-autopost',
      'podcast-feeds',
      'podcast-voices',
      'newsletter-settings',
      'content-taxonomy',
      'reminders',
    ]);
  });

  it('shows an empty shape for a missing document and a repaired view for an invalid one', () => {
    expect(presentSetting('social-autopost', null)).toEqual({
      value: { enabled: false, accountIds: [], scheduleDelayMinutes: 60 },
      exists: false,
      stored: null,
      updatedAt: null,
    });
    const shown = presentSetting('social-autopost', {
      id: AUTOPOST_CONFIG_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      _rid: 'x',
      _etag: 'y',
      enabled: 'yes',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(shown.stored).toBe('invalid');
    expect(shown.exists).toBe(true);
    expect(shown.value).toEqual({ enabled: false, accountIds: [], scheduleDelayMinutes: 60 });
    expect(shown.problem).toMatch(/enabled must be true or false/);
  });

  it('a hand-seeded document with __proto__ or constructor keys is invalid, and nothing is polluted', () => {
    // An object literal `{ __proto__: … }` would set the prototype rather than
    // an own key; JSON.parse holds it as an ordinary own key, which is exactly
    // how a Cosmos document arrives.
    const poisoned = JSON.parse(
      '{"id":"default_heroes","configScope":"admin_config","heroes":{"Azure":"/a.png"},"__proto__":{"polluted":true}}'
    );
    expect(Object.keys(poisoned)).toContain('__proto__');
    const shown = presentSetting('default-heroes', poisoned);
    expect(shown.stored).toBe('invalid');
    expect(shown.problem).toMatch(/Unknown field\(s\) in body: __proto__/);
    expect(shown.value).toEqual({ heroes: {} });
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();

    const viaConstructor = JSON.parse(
      '{"id":"podcast_feeds","feeds":[],"constructor":{"prototype":{"polluted":true}}}'
    );
    expect(presentSetting('podcast-feeds', viaConstructor)).toMatchObject({
      stored: 'invalid',
      problem: expect.stringMatching(/Unknown field\(s\) in body: constructor/),
    });
    expect({}.polluted).toBeUndefined();
  });

  it('reports a stray underscore key rather than hiding it', () => {
    const shown = presentSetting('podcast-feeds', { id: 'podcast_feeds', feeds: [], _legacy: 1 });
    expect(shown.stored).toBe('invalid');
    expect(shown.problem).toMatch(/Unknown field\(s\) in body: _legacy/);
  });

  it('strips Cosmos system fields and the partition from a valid document', () => {
    const shown = presentSetting('default-heroes', {
      id: DEFAULT_HEROES_CONFIG_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      _rid: 'x',
      _self: 'y',
      _etag: 'z',
      _attachments: 'a',
      _ts: 1,
      heroes: { Azure: '/a.png' },
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'u1',
    });
    expect(shown).toEqual({
      value: { heroes: { Azure: '/a.png' } },
      exists: true,
      stored: 'valid',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
  });
});

describe('handlers', () => {
  it('passes guard denials through with zero store calls', async () => {
    const store = makeStore();
    const h = createPlatformSettingsHandlers({ guard: denyGuard, store, ...fixed });
    const get = await h.getSetting(makeRequest({ params: { setting: 'default-heroes' } }), context);
    const put = await h.putSetting(
      makeRequest({ params: { setting: 'default-heroes' }, body: { heroes: {} } }),
      context
    );
    expect(get.status).toBe(403);
    expect(put.status).toBe(403);
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('404s an unknown setting segment before touching the store', async () => {
    const store = makeStore();
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    expect(
      (await h.getSetting(makeRequest({ params: { setting: 'forge-prompts' } }), context)).status
    ).toBe(404);
    expect(
      (await h.putSetting(makeRequest({ params: { setting: '../x' }, body: {} }), context)).status
    ).toBe(404);
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('404s inherited-key segments (__proto__, constructor, prototype) with no store call or side effect', async () => {
    // On a plain object PLATFORM_SETTINGS['constructor'] is Object and
    // PLATFORM_SETTINGS['__proto__'] is Object.prototype — both truthy — so a
    // bare bracket lookup would have carried an undefined docId to Cosmos.
    expect(resolveSetting('__proto__')).toBeNull();
    expect(resolveSetting('constructor')).toBeNull();
    expect(resolveSetting('prototype')).toBeNull();
    expect(resolveSetting('default-heroes')).not.toBeNull();

    const store = makeStore();
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    for (const setting of ['__proto__', 'constructor', 'prototype']) {
      const get = await h.getSetting(makeRequest({ params: { setting } }), context);
      expect(get.status, `GET ${setting}`).toBe(404);
      const put = await h.putSetting(
        makeRequest({ params: { setting }, body: { polluted: true } }),
        context
      );
      expect(put.status, `PUT ${setting}`).toBe(404);
      expect(() => presentSetting(setting, { id: 'x' })).toThrow(/Unknown platform setting/);
    }
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
    expect(typeof Object.prototype.docId).toBe('undefined');
  });

  it('keeps a reminder stamp the timer wrote while the sheet was open, and reads the stored document only for a spec with merge (review of #910)', async () => {
    const stamp = '2026-12-28T13:00:00.000Z';
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'reminders',
        reminders: [{ id: 'a', title: 'T', dueDate: '2027-01-04', notified: { ahead: stamp } }],
      })),
    });
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const put = await h.putSetting(
      makeRequest({
        params: { setting: 'reminders' },
        body: {
          reminders: [
            { id: 'a', title: 'T renamed', dueDate: '2027-01-04', notified: {} },
            { id: 'b', title: 'New', dueDate: '2027-02-01' },
          ],
        },
      }),
      context
    );
    expect(put.status).toBe(200);
    const written = writtenConfig(store);
    expect(written.reminders[0]).toMatchObject({ title: 'T renamed', notified: { ahead: stamp } });
    expect(written.reminders[1].notified).toEqual({});
    expect(parse(put).value.reminders[0].notified).toEqual({ ahead: stamp });

    const plain = makeStore();
    await createPlatformSettingsHandlers({ guard: allowGuard, store: plain, ...fixed }).putSetting(
      makeRequest({ params: { setting: 'podcast-feeds' }, body: { feeds: [] } }),
      context
    );
    expect(plain.readDoc).not.toHaveBeenCalled();
  });

  describe('a merged save is written under the ETag of the read it merged (CodeRabbit, review of #1039)', () => {
    const stamp = '2026-12-28T13:00:00.000Z';
    const sheet = (etag, notified = {}) => ({
      id: 'reminders',
      _etag: etag,
      reminders: [{ id: 'a', title: 'T', dueDate: '2027-01-04', notified }],
    });
    const request = () =>
      makeRequest({
        params: { setting: 'reminders' },
        body: { reminders: [{ id: 'a', title: 'T renamed', dueDate: '2027-01-04', notified: {} }] },
      });
    const conflict = (code) => Object.assign(new Error('conflict'), { code });

    it('replaces the stored sheet only if its ETag still matches, and never upserts it', async () => {
      const store = makeStore({ readDoc: vi.fn(async () => sheet('"e1"')) });
      const put = await createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed }).putSetting(
        request(),
        context
      );
      expect(put.status).toBe(200);
      const [container, doc, options] = store.replaceDocIfMatch.mock.calls[0];
      expect(container).toBe('admin_config');
      expect(doc._etag).toBe('"e1"');
      expect(options).toEqual({ partitionKey: ADMIN_CONFIG_PARTITION });
      expect(store.upsertDoc.mock.calls.some(([c]) => c === 'admin_config')).toBe(false);
    });

    it('creates the sheet when none is stored, and never upserts it', async () => {
      const store = makeStore();
      const put = await createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed }).putSetting(
        request(),
        context
      );
      expect(put.status).toBe(200);
      expect(store.createDoc).toHaveBeenCalledTimes(1);
      expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
      expect(store.upsertDoc.mock.calls.some(([c]) => c === 'admin_config')).toBe(false);
    });

    it('on a 412 re-reads and re-merges, so a stamp the timer wrote meanwhile is kept', async () => {
      const readDoc = vi
        .fn()
        .mockResolvedValueOnce(sheet('"e1"'))
        .mockResolvedValueOnce(sheet('"e2"', { ahead: stamp }));
      const replaceDocIfMatch = vi
        .fn()
        .mockRejectedValueOnce(conflict(412))
        .mockImplementationOnce(async (_c, d) => d);
      const store = makeStore({ readDoc, replaceDocIfMatch });
      const put = await createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed }).putSetting(
        request(),
        context
      );
      expect(put.status).toBe(200);
      expect(readDoc).toHaveBeenCalledTimes(2);
      const [, written] = replaceDocIfMatch.mock.calls[1];
      expect(written._etag).toBe('"e2"');
      expect(written.reminders[0]).toMatchObject({ title: 'T renamed', notified: { ahead: stamp } });
    });

    it('a 409 on create (written since an absent read) re-reads too', async () => {
      const readDoc = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(sheet('"e1"'));
      const store = makeStore({
        readDoc,
        createDoc: vi.fn().mockRejectedValueOnce(conflict(409)),
      });
      const put = await createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed }).putSetting(
        request(),
        context
      );
      expect(put.status).toBe(200);
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
      expect(store.replaceDocIfMatch.mock.calls[0][1]._etag).toBe('"e1"');
    });

    it(`answers 409 after ${MERGE_WRITE_ATTEMPTS} conflicting writes, writing nothing`, async () => {
      const store = makeStore({
        readDoc: vi.fn(async () => sheet('"e1"')),
        replaceDocIfMatch: vi.fn(async () => {
          throw conflict(412);
        }),
      });
      const put = await createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed }).putSetting(
        request(),
        context
      );
      expect(put.status).toBe(409);
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(MERGE_WRITE_ATTEMPTS);
      expect(store.upsertDoc.mock.calls.some(([c]) => c === 'admin_config')).toBe(false);
    });

    it('lets any other write error through as before (500)', async () => {
      const store = makeStore({
        readDoc: vi.fn(async () => sheet('"e1"')),
        replaceDocIfMatch: vi.fn(async () => {
          throw conflict(503);
        }),
      });
      const put = await createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed }).putSetting(
        request(),
        context
      );
      expect(put.status).toBe(500);
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('the credential register’s rows on the reminders sheet (review of #1039)', () => {
    const stamp = '2026-10-09T13:00:00.000Z';
    // As the register's sync writes them (lib/credentials/reminders.js).
    const registerRow = {
      id: 'credential-lab-agent-certificate',
      title: 'Rotate /etc/hcw/labs-agent.pem',
      dueDate: '2028-09-28',
      leadDays: 30,
      notes: 'Generate the next pair on the host.',
      url: 'https://hybridcloudworks.com/admin/integrations?tab=credentials',
      done: false,
      notified: { due: stamp },
    };
    const ownerRow = { id: 'a', title: 'T', dueDate: '2027-01-04', leadDays: 7, notified: { ahead: stamp } };
    const storedSheet = () => ({ id: 'reminders', reminders: [ownerRow, registerRow] });

    async function save(rows) {
      const store = makeStore({ readDoc: vi.fn(async () => storedSheet()) });
      const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
      const put = await h.putSetting(
        makeRequest({ params: { setting: 'reminders' }, body: { reminders: rows } }),
        context
      );
      const written = writtenConfig(store);
      return { put, written };
    }
    const registerRowOf = (written) => written.reminders.find((r) => r.id === registerRow.id);

    it('is saved at editor, the role an edit here needs', async () => {
      const store = makeStore({ readDoc: vi.fn(async () => storedSheet()) });
      const guard = { requireRole: vi.fn(allowGuard.requireRole) };
      await createPlatformSettingsHandlers({ guard, store, ...fixed }).putSetting(
        makeRequest({ params: { setting: 'reminders' }, body: { reminders: [ownerRow] } }),
        context
      );
      expect(guard.requireRole).toHaveBeenCalledWith(expect.anything(), 'editor');
    });

    it('cannot mark one done, re-date it, rewrite it or forge a stamp on it', async () => {
      const { put, written } = await save([
        ownerRow,
        {
          ...registerRow,
          title: 'Silenced',
          dueDate: '2099-01-01',
          leadDays: 0,
          notes: 'nothing to see',
          url: 'https://example.com/elsewhere',
          done: true,
          notified: { overdue: '2099-01-01T00:00:00.000Z' },
        },
      ]);
      expect(put.status).toBe(200);
      expect(registerRowOf(written)).toEqual(registerRow);
      expect(registerRowOf(parse(put).value)).toEqual(registerRow);
    });

    it('cannot remove one: a save that leaves it out keeps it as stored', async () => {
      const { written } = await save([ownerRow]);
      expect(registerRowOf(written)).toEqual(registerRow);
    });

    it('cannot add one: a register row the sheet does not hold is dropped', async () => {
      const forged = { ...registerRow, id: 'credential-kv-anthropic-api-key', title: 'Made up' };
      const { written } = await save([ownerRow, registerRow, forged]);
      expect(written.reminders.map((r) => r.id)).toEqual(['a', registerRow.id]);
    });

    it('leaves the owner’s own rows exactly as before: edits saved, stamps merged, removals kept', async () => {
      const { written } = await save([
        { ...ownerRow, title: 'T renamed', done: true, notified: {} },
        { id: 'b', title: 'New', dueDate: '2027-02-01' },
      ]);
      expect(written.reminders.find((r) => r.id === 'a')).toMatchObject({
        title: 'T renamed',
        done: true,
        notified: { ahead: stamp },
      });
      expect(written.reminders.find((r) => r.id === 'b').notified).toEqual({});

      const { written: removed } = await save([registerRow]);
      expect(removed.reminders.map((r) => r.id)).toEqual([registerRow.id]);
    });

    it('answers 400, and writes nothing, when the owner’s rows and the register’s pass the limit', async () => {
      const rows = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, title: 'T', dueDate: '2027-01-04' }));
      const { put, written } = await save(rows);
      expect(put.status).toBe(400);
      // The owner's share runs out first: REGISTER_RESERVED_ROWS stay the register's (review of #1039).
      expect(parse(put).error).toMatch(/at most 180 of your own entries; 20 are kept for the credential register/);
      expect(written).toBeUndefined();
    });
  });

  it('selects the saved newsletter template in the template cache, so a different one shows on the next preview', async () => {
    const templateCache = { select: vi.fn() };
    const h = createPlatformSettingsHandlers({
      guard: allowGuard,
      store: makeStore(),
      ...fixed,
      templateCache,
    });
    const put = await h.putSetting(
      makeRequest({ params: { setting: 'newsletter-settings' }, body: { templateId: 'tpl-1' } }),
      context
    );
    expect(put.status).toBe(200);
    expect(templateCache.select).toHaveBeenCalledWith('tpl-1');
    await h.putSetting(
      makeRequest({ params: { setting: 'podcast-feeds' }, body: { feeds: [] } }),
      context
    );
    expect(templateCache.select).toHaveBeenCalledTimes(1);
  });

  it('GET reads the document at the admin_config partition', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: PODCAST_FEEDS_CONFIG_ID,
        configScope: ADMIN_CONFIG_PARTITION,
        feeds: [{ provider: 'azure', url: 'https://x.example/a' }],
      })),
    });
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.getSetting(makeRequest({ params: { setting: 'podcast-feeds' } }), context);
    expect(store.readDoc).toHaveBeenCalledWith(
      'admin_config',
      PODCAST_FEEDS_CONFIG_ID,
      ADMIN_CONFIG_PARTITION
    );
    expect(parse(res)).toEqual({
      success: true,
      setting: 'podcast-feeds',
      value: { feeds: [{ provider: 'azure', url: 'https://x.example/a' }] },
      exists: true,
      stored: 'valid',
      updatedAt: null,
    });
  });

  it('PUT replaces the document with the normalized shape, the partition and provenance, then audits counts only', async () => {
    const store = makeStore();
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.putSetting(
      makeRequest({
        params: { setting: 'social-autopost' },
        body: {
          enabled: true,
          accountIds: [{ id: 'acc-secret-looking-id', provider: 'linkedin' }],
          scheduleDelayMinutes: 45,
        },
      }),
      context
    );
    expect(res.status).toBe(200);
    expect(parse(res).value).toEqual({
      enabled: true,
      accountIds: [{ id: 'acc-secret-looking-id', provider: 'linkedin' }],
      scheduleDelayMinutes: 45,
    });

    const [configCall, auditCall] = store.upsertDoc.mock.calls;
    expect(configCall[0]).toBe('admin_config');
    expect(configCall[1]).toEqual({
      id: AUTOPOST_CONFIG_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      enabled: true,
      accountIds: [{ id: 'acc-secret-looking-id', provider: 'linkedin' }],
      scheduleDelayMinutes: 45,
      updatedAt: '2026-09-07T12:00:00.000Z',
      updatedBy: 'u1',
    });

    expect(auditCall[0]).toBe('admin_audit_logs');
    expect(auditCall[1]).toEqual({
      id: 'fixed-uuid',
      action: 'platform_setting_updated',
      userId: 'u1',
      userName: null,
      userEmail: 'owner@example.com',
      timestamp: '2026-09-07T12:00:00.000Z',
      details: { setting: 'social-autopost', enabled: true, accounts: 1, scheduleDelayMinutes: 45 },
    });
    expect(JSON.stringify(auditCall[1])).not.toContain('acc-secret-looking-id');
    expect(context.error).not.toHaveBeenCalled();
  });

  it('PUT answers 400 with the validation message and writes nothing', async () => {
    const store = makeStore();
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.putSetting(
      makeRequest({
        params: { setting: 'default-heroes' },
        body: { heroes: { Azure: 'ftp://x' } },
      }),
      context
    );
    expect(res.status).toBe(400);
    expect(parse(res).error).toMatch(/heroes.Azure must be/);
    expect(store.upsertDoc).not.toHaveBeenCalled();

    expect(
      (await h.putSetting(makeRequest({ params: { setting: 'default-heroes' } }), context)).status
    ).toBe(400);
    expect(
      (
        await h.putSetting(
          makeRequest({ params: { setting: 'default-heroes' }, body: [] }),
          context
        )
      ).status
    ).toBe(400);
  });

  it('a failed audit row is a warning, not a 500: the setting was saved', async () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // The config write (first upsert) succeeds; the audit write (second) fails.
    const store = makeStore({
      upsertDoc: vi.fn(async (container, doc) => {
        if (container === 'admin_audit_logs') throw new Error('audit container throttled');
        return doc;
      }),
    });
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.putSetting(
      makeRequest({
        params: { setting: 'podcast-feeds' },
        body: { feeds: [{ provider: 'azure', url: 'https://x.example/private-feed' }] },
      }),
      log
    );
    expect(res.status).toBe(200);
    expect(parse(res)).toMatchObject({
      success: true,
      setting: 'podcast-feeds',
      value: { feeds: [{ provider: 'azure', url: 'https://x.example/private-feed' }] },
      stored: 'valid',
    });
    expect(store.upsertDoc.mock.calls.map(([container]) => container)).toEqual([
      'admin_config',
      'admin_audit_logs',
    ]);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const line = String(log.warn.mock.calls[0][0]);
    expect(line).toContain('"feeds":1');
    expect(line).toContain('audit container throttled');
    expect(line).not.toContain('private-feed');
  });

  it('a failed audit row for newsletter settings logs that a template is set, never its id', async () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = makeStore({
      upsertDoc: vi.fn(async (container, doc) => {
        if (container === 'admin_audit_logs') throw new Error('audit container throttled');
        return doc;
      }),
    });
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.putSetting(
      makeRequest({
        params: { setting: 'newsletter-settings' },
        body: { templateId: 'tpl-secret-design-1234' },
      }),
      log
    );
    expect(res.status).toBe(200);
    const line = String(log.warn.mock.calls[0][0]);
    expect(line).toContain('"templateId":"[set]"');
    expect(line).not.toContain('tpl-secret-design-1234');
  });

  it('a failed config write is a 500 whose log line names the setting, not the document', async () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // The first upsert is the config document itself; nothing was saved.
    const store = makeStore({
      upsertDoc: vi.fn(async () => {
        throw new Error('cosmos down');
      }),
    });
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.putSetting(
      makeRequest({
        params: { setting: 'podcast-feeds' },
        body: { feeds: [{ provider: 'azure', url: 'https://x.example/private-feed' }] },
      }),
      log
    );
    expect(res.status).toBe(500);
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.error.mock.calls[0])).not.toContain('private-feed');
  });

  it('enforces If-Match header with replaceDocIfMatch and 412s on mismatch (AP-B11)', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: AUTOPOST_CONFIG_ID,
        _etag: '"etag-valid"',
      })),
      replaceDocIfMatch: vi.fn(async (_c, doc) => doc),
    });
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });

    // Mismatched ETag returns 412
    const failRes = await h.putSetting(
      {
        params: { setting: 'social-autopost' },
        headers: { get: (k) => (k.toLowerCase() === 'if-match' ? '"etag-stale"' : null) },
        json: async () => ({ enabled: false }),
      },
      context
    );
    expect(failRes.status).toBe(412);
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();

    // Matching ETag succeeds with replaceDocIfMatch
    const okRes = await h.putSetting(
      {
        params: { setting: 'social-autopost' },
        headers: { get: (k) => (k.toLowerCase() === 'if-match' ? '"etag-valid"' : null) },
        json: async () => ({ enabled: false }),
      },
      context
    );
    expect(okRes.status).toBe(200);
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
    expect(store.replaceDocIfMatch.mock.calls[0][1]._etag).toBe('"etag-valid"');
  });
});

describe('change history', () => {
  const historyRequest = (query = {}, params = {}) => ({
    params,
    query: new URLSearchParams(query),
    json: async () => null,
  });

  const auditRow = (over = {}) => ({
    id: 'a1',
    action: 'platform_setting_updated',
    userId: 'oid-1',
    userName: 'Saul Patino',
    userEmail: 'owner@example.com',
    timestamp: '2026-09-14T10:00:00.000Z',
    details: { setting: 'social-autopost', enabled: true, accounts: 2, scheduleDelayMinutes: 60 },
    _rid: 'rid',
    _ts: 1,
    ...over,
  });

  const historyStore = (rows = [auditRow()]) => makeStore({ queryDocs: vi.fn(async () => rows) });

  it('no setting is named history, so the literal route and the template cannot mean two things', () => {
    expect(resolveSetting('history')).toBeNull();
    expect(PLATFORM_SETTING_NAMES).not.toContain('history');
  });

  it('passes a guard denial through with no query, from either route', async () => {
    const store = historyStore();
    const h = createPlatformSettingsHandlers({ guard: denyGuard, store, ...fixed });
    expect((await h.getHistory(historyRequest(), context)).status).toBe(403);
    expect((await h.getSetting(historyRequest({}, { setting: 'history' }), context)).status).toBe(
      403
    );
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('requires the editor role', async () => {
    const guard = { requireRole: vi.fn(async () => ({ user: { oid: 'u1' }, error: null })) };
    const h = createPlatformSettingsHandlers({ guard, store: historyStore(), ...fixed });
    await h.getHistory(historyRequest(), context);
    expect(guard.requireRole).toHaveBeenCalledWith(expect.anything(), 'editor');
  });

  it('answers 400 before any query for a setting, limit or cursor it cannot use', async () => {
    const store = historyStore();
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const bad = [
      { setting: 'forge-prompts' },
      { setting: 'constructor' },
      { setting: '__proto__' },
      { limit: '0' },
      { limit: '101' },
      { limit: '10.5' },
      { limit: '-1' },
      { limit: 'ten' },
      { limit: '1e2' },
      { after: 'yesterday' },
      { after: '2026-09-14' },
      { after: "2026-09-14T10:00:00.000Z' OR 1=1" },
      { after: '2026-13-45T99:99:99.000Z' },
      // Not the stored .sssZ shape: string comparison would page wrongly.
      { after: '2026-09-14T10:00:00Z' },
      { after: '2026-09-14T10:00:00.5Z' },
      { after: '2026-09-14T10:00:00.123456Z' },
    ];
    for (const query of bad) {
      const res = await h.getHistory(historyRequest(query), context);
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(parse(res).error).toBeTruthy();
    }
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('parses the defaults and the bounds', () => {
    expect(parseHistoryQuery(new URLSearchParams())).toEqual({
      setting: null,
      limit: HISTORY_DEFAULT_LIMIT,
      after: null,
    });
    expect(
      parseHistoryQuery(
        new URLSearchParams({
          setting: 'podcast-feeds',
          limit: String(HISTORY_MAX_LIMIT),
          after: '2026-09-14T10:00:00.000Z',
        })
      )
    ).toEqual({ setting: 'podcast-feeds', limit: 100, after: '2026-09-14T10:00:00.000Z' });
    expect(parseHistoryQuery(new URLSearchParams({ limit: '1' })).limit).toBe(1);
  });

  it('queries only the audit action, newest first, with every value a parameter', async () => {
    const store = historyStore([]);
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    await h.getHistory(historyRequest(), context);
    const [container, query, parameters] = store.queryDocs.mock.calls[0];
    expect(container).toBe('admin_audit_logs');
    expect(query).toBe(
      'SELECT TOP @limit c.id, c.timestamp, c.userId, c.userName, c.details FROM c WHERE c.action = @action ORDER BY c.timestamp DESC'
    );
    expect(parameters).toEqual([
      { name: '@limit', value: 50 },
      { name: '@action', value: PLATFORM_SETTING_AUDIT_ACTION },
    ]);
  });

  it('filters by exact setting and pages strictly older than the cursor', async () => {
    const store = historyStore([]);
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    await h.getHistory(
      historyRequest({ setting: 'podcast-feeds', limit: '10', after: '2026-09-14T10:00:00.000Z' }),
      context
    );
    const [, query, parameters] = store.queryDocs.mock.calls[0];
    expect(query).toContain('c.details.setting = @setting');
    expect(query).toContain('c.timestamp < @after');
    expect(query).not.toContain('podcast-feeds');
    expect(query).not.toContain('2026-09-14');
    expect(parameters).toEqual([
      { name: '@limit', value: 10 },
      { name: '@action', value: PLATFORM_SETTING_AUDIT_ACTION },
      { name: '@setting', value: 'podcast-feeds' },
      { name: '@after', value: '2026-09-14T10:00:00.000Z' },
    ]);
  });

  it('projects each row to id, at, actor, setting and summary, and nothing more', async () => {
    const h = createPlatformSettingsHandlers({
      guard: allowGuard,
      store: historyStore(),
      ...fixed,
    });
    const res = await h.getHistory(historyRequest(), context);
    expect(res.status).toBe(200);
    expect(parse(res)).toEqual({
      success: true,
      entries: [
        {
          id: 'a1',
          at: '2026-09-14T10:00:00.000Z',
          actor: 'Saul Patino',
          setting: 'social-autopost',
          summary: { enabled: true, accounts: 2, scheduleDelayMinutes: 60 },
        },
      ],
      nextAfter: null,
    });
    expect(res.body).not.toContain('owner@example.com');
    expect(res.body).not.toContain('_rid');
  });

  it('shows the object id for a row with no display name, and never an email-shaped actor', () => {
    expect(presentHistoryEntry(auditRow({ userName: undefined })).actor).toBe('oid-1');
    expect(presentHistoryEntry(auditRow({ userName: 'owner@example.com' })).actor).toBe('oid-1');
    expect(
      presentHistoryEntry(auditRow({ userName: null, userId: 'someone@example.com' })).actor
    ).toBeNull();
    expect(
      JSON.stringify(presentHistoryEntry(auditRow({ userName: 'owner@example.com' })))
    ).not.toContain('@');
  });

  it('keeps scalar and list summaries and drops anything nested', () => {
    const entry = presentHistoryEntry(
      auditRow({
        details: {
          setting: 'newsletter-settings',
          sections: ['articles', 'podcasts'],
          templateId: null,
          nested: { postalAddress: '1 Main St' },
          mixed: ['a', { b: 1 }],
        },
      })
    );
    expect(entry.summary).toEqual({ sections: ['articles', 'podcasts'], templateId: null });
    expect(presentHistoryEntry({ id: 'x' })).toEqual({
      id: 'x',
      at: null,
      actor: null,
      setting: null,
      summary: {},
    });
  });

  it('returns nextAfter as the last row’s time when a full page came back', async () => {
    const rows = [
      auditRow({ id: 'a1', timestamp: '2026-09-14T10:00:00.000Z' }),
      auditRow({ id: 'a2', timestamp: '2026-09-13T10:00:00.000Z' }),
    ];
    const h = createPlatformSettingsHandlers({
      guard: allowGuard,
      store: historyStore(rows),
      ...fixed,
    });
    const full = parse(await h.getHistory(historyRequest({ limit: '2' }), context));
    expect(full.nextAfter).toBe('2026-09-13T10:00:00.000Z');
    const short = parse(await h.getHistory(historyRequest({ limit: '3' }), context));
    expect(short.nextAfter).toBeNull();
  });

  it('serves history from the {setting} template too, the same as the literal route', async () => {
    const store = historyStore();
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.getSetting(
      historyRequest({ setting: 'podcast-feeds' }, { setting: 'history' }),
      context
    );
    expect(res.status).toBe(200);
    expect(parse(res).entries).toHaveLength(1);
    expect(store.readDoc).not.toHaveBeenCalled();
  });

  it('a failed query is a 500 whose log line carries no query value', async () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = makeStore({
      queryDocs: vi.fn(async () => {
        throw new Error('cosmos down');
      }),
    });
    const h = createPlatformSettingsHandlers({ guard: allowGuard, store, ...fixed });
    const res = await h.getHistory(
      historyRequest({ setting: 'podcast-feeds', after: '2026-09-14T10:00:00.000Z' }),
      log
    );
    expect(res.status).toBe(500);
    expect(log.error).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(log.error.mock.calls[0]);
    expect(line).not.toContain('podcast-feeds');
    expect(line).not.toContain('2026-09-14');
  });

  it('records the display name on new audit rows, and the history view reads it back', async () => {
    const store = makeStore();
    const guard = {
      requireRole: vi.fn(async () => ({
        user: { oid: 'u1', name: 'Saul Patino', email: 'owner@example.com' },
        error: null,
      })),
    };
    const h = createPlatformSettingsHandlers({ guard, store, ...fixed });
    await h.putSetting(
      makeRequest({ params: { setting: 'podcast-feeds' }, body: { feeds: [] } }),
      context
    );
    const audit = store.upsertDoc.mock.calls.find(([c]) => c === 'admin_audit_logs')[1];
    expect(audit.userName).toBe('Saul Patino');
    expect(presentHistoryEntry(audit)).toEqual({
      id: 'fixed-uuid',
      at: '2026-09-07T12:00:00.000Z',
      actor: 'Saul Patino',
      setting: 'podcast-feeds',
      summary: { feeds: 0, mainFeed: false },
    });
  });
});
