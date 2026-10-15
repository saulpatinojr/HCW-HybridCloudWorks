/**
 * The service registry every tab reads (moved from IntegrationsPage.test.jsx,
 * #570): which services exist, where each lives, and that each browser-side
 * test reads the proxy envelope's `ok` rather than reporting Connected for a
 * refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SERVICES, SERVICE_GROUPS } from './serviceRegistry';

const postJSON = vi.fn();
const getJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: vi.fn(),
  postJSON: (...args) => postJSON(...args),
}));
const fetchCloudPricing = vi.fn();
vi.mock('@/lib/publicApi', () => ({
  fetchCloudPricing: (...args) => fetchCloudPricing(...args),
}));

describe('the service registry', () => {
  it('still names every service the old Connections page did', () => {
    // The original seven, less Klaviyo, which was removed on purpose when
    // Resend replaced it (ADR 0030). The order changed when the cards were
    // sorted into groups and three education profiles were added, so this
    // asserts PRESENCE rather than sequence - dropping one is the failure it
    // guards.
    const names = SERVICES.map((service) => service.name);
    for (const name of ['Publer', 'Plaud', 'Sessionize', 'Credly', 'Linkie', 'YouTube']) {
      expect(names, `${name} disappeared from the registry`).toContain(name);
    }
  });

  it('lists exactly the services it means to, in group order', () => {
    expect(SERVICES.map((service) => service.name)).toEqual([
      'Publer',
      'Resend',
      'Linkie',
      'Telegram',
      'Podbean',
      'StreamYard On-Air',
      'YouTube',
      'Plaud',
      'Sessionize',
      'Credly',
      'Microsoft Learn',
      'AWS Skill Builder',
      'Google Developer',
      // ADR 0033: the AI keys that used to be loose rows on the Keys tab.
      'Google Gemini',
      'Anthropic',
      'OpenAI',
      'NVIDIA API',
      'ElevenLabs',
      'Azure AI Speech',
      'Firecrawl',
      'Replicate',
      'Cloud pricing cache',
      'Qlty',
      'Hybrid Lab (Coder and Turnstile)',
      // ADR 0035: the first tool add-on, read through the status proxy.
      'Migration add-on',
    ]);
  });

  it('groups every Coder key on the Hybrid Lab card under Coder, with the automatic renewal, and Turnstile apart', () => {
    const lab = SERVICES.find((service) => service.id === 'hybrid-lab');
    expect(lab.keyGroups).toEqual([
      { title: 'Coder', secrets: ['CODER-URL', 'CODER-STATUS-TOKEN'], panel: 'coderAutomation' },
      { title: 'Turnstile', secrets: ['TURNSTILE-SECRET-KEY'] },
    ]);
  });

  it('only groups keys a card actually uses, each once, and only names panels the Services tab draws', () => {
    // IntegrationsServices.jsx KEY_GROUP_PANELS: a name not there would draw
    // an empty box; a grouped key the card does not use would never show.
    const KNOWN_PANELS = ['coderAutomation'];
    for (const service of SERVICES.filter((s) => s.keyGroups)) {
      const grouped = service.keyGroups.flatMap((group) => group.secrets ?? []);
      expect(new Set(grouped).size, `${service.name} groups a key twice`).toBe(grouped.length);
      for (const name of grouped) {
        expect(service.secrets, `${service.name} groups ${name}, which it does not use`).toContain(
          name
        );
      }
      for (const group of service.keyGroups) {
        expect(group.title, `${service.name} has an untitled key group`).toMatch(/\w/);
        if (group.panel) expect(KNOWN_PANELS).toContain(group.panel);
      }
    }
  });

  it('gives every service a URL, since that is the one thing they all have', () => {
    // A card with no globe is a dead end: no key to rotate, no test to run and
    // nowhere to go. Education profiles have only the globe, which is the
    // whole reason they are on the page.
    for (const service of SERVICES) {
      expect(service.url, `${service.name} has no url`).toMatch(/^https:\/\//);
    }
  });

  it('sends a credential with no test straight to the page that manages it', () => {
    // No beaker means the globe is the only thing this page can do about a red
    // light, so it has to land where the credential is minted - not on the
    // vendor's front door. A bare host would be a shrug.
    //
    // This used to assert the set was non-empty, because a vacuous rule is its
    // own kind of broken. #483 emptied it legitimately - Telegram, the podcast
    // host and YouTube were the last three and they all have server-side tests now - so
    // that guard would fail for the right reason, which makes it the wrong
    // guard. It is replaced by the test below, which pins the set to empty
    // rather than to non-empty. The rule here still stands and starts holding
    // again the moment anything joins the set.
    const untestable = SERVICES.filter(
      (service) => !service.test && (service.secrets ?? []).length > 0
    );
    for (const service of untestable) {
      const { pathname } = new URL(service.url);
      expect(
        pathname.replace(/\/+$/, '').length,
        `${service.name} points at a bare host (${service.url}) with no test beside it`
      ).toBeGreaterThan(0);
    }
  });

  it('names exactly the credentialed services with no test, and says why on each (ADR 0033)', () => {
    // #483 emptied this set. ADR 0033 added a card for every AI key, and one
    // of them has no cheap read to test with: Azure Speech is unprovisioned on
    // purpose (Perplexity, the other, went with its key in #1029). It is a
    // decision made HERE, in the open, and the card says so in words.
    const untestable = SERVICES.filter(
      (service) => !service.test && (service.secrets ?? []).length > 0
    );
    expect(untestable.map((service) => service.name)).toEqual(['Azure AI Speech']);
    for (const service of untestable) {
      expect(service.untestedReason, `${service.name} says nothing`).toMatch(/\w{10,}/);
    }
  });

  it('says what every service is for, where it is used and which way data flows (ADR 0033)', () => {
    for (const service of SERVICES) {
      expect(Array.isArray(service.usedIn), `${service.name} has no usedIn`).toBe(true);
      expect(service.dataDirection, `${service.name} has no dataDirection`).toMatch(/\w/);
      if ((service.secrets ?? []).length > 0) {
        expect(service.securityNote, `${service.name} has no securityNote`).toMatch(/\w/);
      }
    }
  });

  describe('the AI and lab cards (ADR 0033)', () => {
    const runnerFor = (id) => SERVICES.find((service) => service.id === id).test;
    beforeEach(() => {
      postJSON.mockReset();
      getJSON.mockReset();
    });

    it('tests each language model through the AI Engine’s own testAiProvider', async () => {
      for (const id of ['gemini', 'anthropic', 'openai', 'nvidia']) {
        postJSON.mockResolvedValueOnce({ status: 'connected', latencyMs: 812 });
        await expect(runnerFor(id)()).resolves.toBe('Connected — answered in 812 ms.');
        expect(postJSON).toHaveBeenLastCalledWith('testAiProvider', { providerId: id });
      }
      postJSON.mockResolvedValueOnce({ status: 'error', error: 'timeout after 45000 ms' });
      await expect(runnerFor('nvidia')()).rejects.toThrow('timeout after 45000 ms');
    });

    it('reads ElevenLabs’ plan without synthesising anything', async () => {
      getJSON.mockResolvedValueOnce({
        configured: true,
        subscription: { tier: 'free', creditsLeft: 7000, creditLimit: 10000 },
      });
      await expect(runnerFor('elevenlabs')()).resolves.toBe(
        'Connected on the free plan — 7000 of 10000 credits left.'
      );
      expect(getJSON).toHaveBeenCalledWith('cms/podcast/elevenlabs');
      getJSON.mockResolvedValueOnce({ configured: false, reason: 'ELEVENLABS_API_KEY is not set' });
      await expect(runnerFor('elevenlabs')()).rejects.toThrow(/not set/);
      getJSON.mockResolvedValueOnce({ configured: true, subscriptionError: 'missing_permissions' });
      await expect(runnerFor('elevenlabs')()).rejects.toThrow('missing_permissions');
    });

    it('posts the Replicate and Firecrawl probe names and reads the envelope’s ok', async () => {
      postJSON.mockResolvedValueOnce({ ok: true, status: 200, data: { username: 'hcw' } });
      await expect(runnerFor('replicate')()).resolves.toBe('Connected as hcw.');
      expect(postJSON).toHaveBeenLastCalledWith('connectionProbe', { probe: 'replicate' });
      postJSON.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: { remaining_credits: 412 } },
      });
      await expect(runnerFor('firecrawl')()).resolves.toBe('Connected — 412 credits remaining.');
      expect(postJSON).toHaveBeenLastCalledWith('connectionProbe', { probe: 'firecrawl' });
      postJSON.mockResolvedValueOnce({ ok: false, status: 401, error: 'Unauthenticated' });
      await expect(runnerFor('replicate')()).rejects.toThrow(/Unauthenticated/);
    });

    it('tests the Hybrid Lab through the public coder-status read, then says when the token expires', async () => {
      const healthy = {
        configured: true,
        reachable: true,
        templates: [{ name: 'a' }],
        capacity: { running: 1, max: 4 },
      };
      getJSON.mockResolvedValueOnce(healthy).mockResolvedValueOnce({
        configured: true,
        warningDays: 30,
        token: {
          known: true,
          expiresAt: '2027-09-28T10:00:00.000Z',
          daysLeft: 357,
          renewSoon: false,
        },
      });
      await expect(runnerFor('hybrid-lab')()).resolves.toBe(
        'Connected — 1 template(s), 1 of 4 workspaces running. Status token expires on 2027-09-28 (357 days).'
      );
      expect(getJSON).toHaveBeenCalledWith('public/labs/coder-status');
      expect(getJSON).toHaveBeenCalledWith('cms/labs/coder-token');

      // Inside the warning window the card goes red and names the steps.
      getJSON.mockResolvedValueOnce(healthy).mockResolvedValueOnce({
        configured: true,
        token: {
          known: true,
          expiresAt: '2026-10-20T10:00:00.000Z',
          daysLeft: 15,
          renewSoon: true,
        },
      });
      await expect(runnerFor('hybrid-lab')()).rejects.toThrow(
        /expires on 2026-10-20 \(15 days\): renew it/
      );

      // A token without the api_key:read scope (Coder answers its own-record
      // read 403, or 404 since v2.38): still green, says to re-issue it.
      getJSON.mockResolvedValueOnce(healthy).mockResolvedValueOnce({
        configured: true,
        token: { known: false, reason: 'scope', scope: 'api_key:read' },
      });
      await expect(runnerFor('hybrid-lab')()).resolves.toMatch(
        /expiry unknown: .*Re-issue the token with api_key:read added/
      );

      // Expired or revoked: red.
      getJSON.mockResolvedValueOnce(healthy).mockResolvedValueOnce({
        configured: true,
        token: { known: false, reason: 'refused' },
      });
      await expect(runnerFor('hybrid-lab')()).rejects.toThrow(/expired or been revoked/);

      // A failed token read leaves the Coder sentence as it was.
      getJSON.mockResolvedValueOnce(healthy).mockRejectedValueOnce(new Error('403'));
      await expect(runnerFor('hybrid-lab')()).resolves.toBe(
        'Connected — 1 template(s), 1 of 4 workspaces running.'
      );

      getJSON.mockResolvedValueOnce({ configured: false });
      await expect(runnerFor('hybrid-lab')()).rejects.toThrow(/CODER_URL/);
      getJSON.mockResolvedValueOnce({ configured: true, reachable: false });
      await expect(runnerFor('hybrid-lab')()).rejects.toThrow(/did not answer/);
    });

    it('sends Plaud’s Reconnect to the Recording Hub’s own sign-in', () => {
      const plaud = SERVICES.find((service) => service.id === 'plaud');
      expect(plaud.reconnectHref).toBe('/admin/recording-hub?tab=settings');
      expect(SERVICES.filter((service) => service.reconnectHref)).toHaveLength(1);
    });
  });

  describe('the server-side probes (#483, #569)', () => {
    // Exercised through SERVICES rather than by importing the runners, because
    // the field IS the contract: the card calls whatever sits in `test`.
    const runnerFor = (id) => SERVICES.find((service) => service.id === id).test;

    beforeEach(() => postJSON.mockReset());

    it('posts a probe NAME, never a path or a method', async () => {
      // The whole security argument for this route is that the caller supplies
      // no part of the outbound request. A runner that started sending a path
      // would silently undo it, so the shape is pinned here.
      for (const [id, probe] of [
        ['telegram', 'telegram'],
        ['podbean', 'podbean'],
        ['youtube', 'youtube'],
        ['resend', 'resend'],
        ['qlty', 'qlty'],
      ]) {
        postJSON.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
        await runnerFor(id)();
        expect(postJSON).toHaveBeenLastCalledWith('connectionProbe', { probe });
      }
    });

    it('throws on a refusal instead of reporting Connected', async () => {
      // #463 item 1 and #479: the proxies answer HTTP 200 for every outcome,
      // so a runner that does not read `ok` says Connected for a 401. That
      // defect has now been written three times in this file's history, which
      // is why every new runner gets this test.
      for (const id of ['telegram', 'podbean', 'youtube', 'qlty', 'replicate', 'firecrawl']) {
        postJSON.mockResolvedValueOnce({
          ok: false,
          status: 401,
          error: 'Unauthorized',
          data: { description: 'Unauthorized' },
        });
        await expect(runnerFor(id)(), id).rejects.toThrow(/Unauthorized/);
      }
    });

    it('reports Plaud broken when mcpProxy answers ok: false with HTTP 200', async () => {
      postJSON.mockResolvedValueOnce({ ok: false, error: 'Plaud refused the token' });
      await expect(runnerFor('plaud')()).rejects.toThrow(/Plaud refused the token/);

      postJSON.mockResolvedValueOnce({ ok: true, result: '[]', raw: {} });
      await expect(runnerFor('plaud')()).resolves.toMatch(/Connected/);
    });

    it('names the bot a Telegram token belongs to, which is the useful half', async () => {
      postJSON.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { ok: true, result: { username: 'hcw_bot' } },
      });
      await expect(runnerFor('telegram')()).resolves.toContain('@hcw_bot');
    });

    it('names the Podbean show the client credentials are for, and says Connected without one', async () => {
      postJSON.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { podcast: { id: 'p1', title: 'Hybrid Cloud Insights' } },
      });
      await expect(runnerFor('podbean')()).resolves.toBe('Connected — Hybrid Cloud Insights.');

      postJSON.mockResolvedValueOnce({ ok: true, status: 200, data: { podcast: {} } });
      await expect(runnerFor('podbean')()).resolves.toBe('Connected to Podbean.');
    });

    it('names the Qlty login a token belongs to, and says Connected without one', async () => {
      postJSON.mockResolvedValueOnce({ ok: true, status: 200, data: { login: 'saulpatinojr' } });
      await expect(runnerFor('qlty')()).resolves.toBe('Connected as saulpatinojr.');

      // A login that is not a string is not echoed; the verdict still stands.
      postJSON.mockResolvedValueOnce({ ok: true, status: 200, data: { login: { name: 'x' } } });
      await expect(runnerFor('qlty')()).resolves.toBe('Connected to Qlty.');
      postJSON.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
      await expect(runnerFor('qlty')()).resolves.toBe('Connected to Qlty.');
    });

    it('refuses a Qlty token Qlty rejected, naming Qlty and its status', async () => {
      // The probe's failure shape since #945: its own sentence, no upstream body.
      postJSON.mockResolvedValueOnce({ ok: false, status: 401, error: 'Qlty answered HTTP 401.' });
      await expect(runnerFor('qlty')()).rejects.toThrow(/^Qlty answered HTTP 401\.$/);
    });

    it('says what a YouTube press costs, because pressing it spends quota', async () => {
      postJSON.mockResolvedValueOnce({ ok: true, status: 200, data: { items: [] } });
      await expect(runnerFor('youtube')()).resolves.toMatch(/quota/i);
    });
  });

  describe('the Cloud pricing cache card (#613)', () => {
    const cloudPricing = () => SERVICES.find((service) => service.id === 'cloud-pricing');
    const cached = (over = {}) => ({
      region: 'us-east-1',
      regions: [],
      refreshedAt: '2026-09-14T06:00:00.000Z',
      ttlMinutes: 1440,
      ageMinutes: 95,
      stale: false,
      counts: { live: 22, baseline: 0, unavailable: 2 },
      services: [],
      ...over,
    });

    beforeEach(() => fetchCloudPricing.mockReset());

    it('sits under Cloud with the two provider keys the refresh spends, and carries the Refresh action', () => {
      const card = cloudPricing();
      expect(card.group).toBe('cloud');
      expect(card.secrets).toEqual([
        'AWS-ACCESS-KEY-ID',
        'AWS-SECRET-ACCESS-KEY',
        'GCP-BILLING-API-KEY',
      ]);
      expect(card.action).toBe('refreshCloudPricing');
      expect(card.url).toBe('https://hybridcloudworks.com/tools/comparison');
    });

    it('reads the default region FRESH and reports age and counts', async () => {
      fetchCloudPricing.mockResolvedValueOnce(cached());
      await expect(cloudPricing().test()).resolves.toBe(
        'Fresh: refreshed 2 hours ago (22 live, 0 catalogue, 2 unavailable).'
      );
      // Fresh, or the card would read the browser's pre-refresh copy for
      // fifteen minutes after Refresh now.
      expect(fetchCloudPricing).toHaveBeenCalledWith('us-east-1', { fresh: true });
    });

    it('is red when the cache is stale, saying how late and what it holds', async () => {
      fetchCloudPricing.mockResolvedValueOnce(cached({ stale: true, ageMinutes: 30 * 60 }));
      await expect(cloudPricing().test()).rejects.toThrow(
        'Stale: last refreshed 30 hours ago (22 live, 0 catalogue, 2 unavailable).'
      );
    });

    it('is red before the first refresh, and says which button fills it', async () => {
      fetchCloudPricing.mockResolvedValueOnce(cached({ refreshedAt: null, ageMinutes: null }));
      await expect(cloudPricing().test()).rejects.toThrow(/Refresh now/);
    });

    it('is red when the route is missing rather than Connected to nothing', async () => {
      fetchCloudPricing.mockResolvedValueOnce(null);
      await expect(cloudPricing().test()).rejects.toThrow(/404/);
    });
  });

  it('files Qlty under Code quality, with the key the catalogue declares', () => {
    expect(SERVICE_GROUPS.map((group) => group.id)).toContain('code-quality');
    const qlty = SERVICES.find((service) => service.id === 'qlty');
    expect(qlty.group).toBe('code-quality');
    expect(qlty.secrets).toEqual(['QLTY-API-TOKEN']);
    expect(qlty.url).toBe('https://qlty.sh/user/settings/tokens');
  });

  it('puts every service in a group that exists', () => {
    const ids = new Set(SERVICE_GROUPS.map((group) => group.id));
    for (const service of SERVICES) {
      expect(ids, `${service.name} is in group '${service.group}'`).toContain(service.group);
    }
  });

  it('leaves only YouTube out of Test all, and says why in words', () => {
    // Test all presses every beaker at once; YouTube's spends daily quota.
    const skipped = SERVICES.filter((service) => service.skipInTestAll);
    expect(skipped.map((service) => service.id)).toEqual(['youtube']);
    expect(skipped[0].skipInTestAll).toMatch(/quota/i);
  });
});
