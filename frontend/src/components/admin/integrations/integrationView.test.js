/**
 * The joins behind the tabs. The first block moved from IntegrationsPage.test.jsx
 * (#570) and holds the merge: a service's connection status and its credential
 * are one subject. The rest holds the Keys tab's "used by" join and the
 * Overview's worst-first sort.
 */
import { describe, it, expect } from 'vitest';

import {
  SERVICE_STATUS,
  buildIntegrationView,
  buildKeyGroups,
  resultStatus,
  serviceStatus,
  sortByStatus,
} from './integrationView';
import { SERVICES } from './serviceRegistry';

const item = (overrides = {}) => ({
  secret: 'GEMINI-API-KEY',
  setting: 'GEMINI_API_KEY',
  section: 'gen-ai',
  label: 'Google Gemini',
  help: 'API key. The first model the site asks to write.',
  state: 'never',
  generatable: false,
  hasLivenessCheck: true,
  lastWriteAt: null,
  ...overrides,
});

// ── The merge: a service and its credential are one subject ──────────────────

describe('joining services to credentials', () => {
  // Section ids ARE group ids now - one taxonomy for services and credentials
  // alike, so a key is never under a different heading from the service it
  // unlocks.
  const sections = [
    { id: 'communication', title: 'Communication', blurb: 'Publishing credentials.' },
    { id: 'gen-ai', title: 'Gen AI', blurb: 'AI keys.' },
  ];
  // Publer, because it is a card with TWO credentials, which is the case the
  // claiming rules below have to get right.
  const publerKey = item({
    secret: 'PUBLER-API-KEY',
    section: 'communication',
    label: 'Publer — API key',
  });
  const publerWorkspace = item({
    secret: 'PUBLER-WORKSPACE-ID',
    section: 'communication',
    label: 'Publer — workspace id',
  });
  // Claimed by the Telegram card, so it is no longer a loose credential.
  const telegram = item({
    secret: 'TELEGRAM-BOT-TOKEN',
    section: 'communication',
    label: 'Telegram — bot token',
  });
  // A site-platform value, which no service card claims (since ADR 0033
  // every AI key has a card, so Firecrawl no longer serves as the example;
  // since #1905 the origin secret is on the Cloudflare card, so the salt is).
  const originSecret = item({
    secret: 'CLIENT-IP-SALT',
    section: 'platform',
    label: 'Client IP salt',
  });

  // ── grouping ────────────────────────────────────────────────────────────
  // The fallback below exists so a card cannot silently disappear, and an
  // untested guarantee is not one (Copilot review of 658b9407).

  const GROUPS = [
    { id: 'alpha', title: 'Alpha', blurb: 'a' },
    { id: 'omega', title: 'Omega', blurb: 'o' },
  ];
  const svc = (id, group) => ({ id, group, name: id, url: 'https://x.test', secrets: [] });

  it('sorts cards under their group, in registry order', () => {
    const { serviceGroups } = buildIntegrationView({
      services: [svc('one', 'alpha'), svc('two', 'omega'), svc('three', 'alpha')],
      groups: GROUPS,
    });
    expect(serviceGroups.map((group) => group.id)).toEqual(['alpha', 'omega']);
    expect(serviceGroups[0].cards.map((card) => card.id)).toEqual(['one', 'three']);
    expect(serviceGroups[1].cards.map((card) => card.id)).toEqual(['two']);
  });

  it('drops a group with no cards rather than rendering a bare heading', () => {
    const { serviceGroups } = buildIntegrationView({
      services: [svc('one', 'alpha')],
      groups: GROUPS,
    });
    expect(serviceGroups.map((group) => group.id)).toEqual(['alpha']);
  });

  it('NEVER drops a card whose group does not exist - it falls into the last group', () => {
    // The failure this guards: a typo in `group`, or a group removed from
    // SERVICE_GROUPS, quietly removing a service from the page. A card in the
    // wrong place is visible and fixable; a card that is gone is neither.
    const { serviceGroups } = buildIntegrationView({
      services: [svc('one', 'alpha'), svc('stray', 'nonesuch'), svc('none', undefined)],
      groups: GROUPS,
    });
    const placed = serviceGroups.flatMap((group) => group.cards.map((card) => card.id));
    expect(placed).toContain('stray');
    expect(placed).toContain('none');
    expect(serviceGroups.find((group) => group.id === 'omega').cards.map((c) => c.id)).toEqual([
      'stray',
      'none',
    ]);
  });

  it('places every service exactly once, whatever its group says', () => {
    // The property that matters more than any individual placement rule.
    const services = [
      svc('a', 'alpha'),
      svc('b', 'omega'),
      svc('c', 'nonesuch'),
      svc('d', 'alpha'),
    ];
    const { serviceGroups, serviceCards } = buildIntegrationView({ services, groups: GROUPS });
    const placed = serviceGroups.flatMap((group) => group.cards.map((card) => card.id)).sort();
    expect(placed).toEqual(['a', 'b', 'c', 'd']);
    expect(serviceCards).toHaveLength(4);
  });

  it('survives an empty group list without losing the cards from the page', () => {
    // No groups means nothing can be rendered under a heading, so the caller
    // still has `serviceCards`; what must not happen is a crash.
    const { serviceGroups, serviceCards } = buildIntegrationView({
      services: [svc('one', 'alpha')],
      groups: [],
    });
    expect(serviceGroups).toEqual([]);
    expect(serviceCards.map((card) => card.id)).toEqual(['one']);
  });

  it('groups the real registry with nothing left over', () => {
    const { serviceGroups } = buildIntegrationView({});
    const placed = serviceGroups.flatMap((group) => group.cards.map((card) => card.id));
    expect(placed.sort()).toEqual(SERVICES.map((service) => service.id).sort());
  });

  it('gives a credential to the service that owns it', () => {
    const { serviceCards } = buildIntegrationView({
      sections,
      secrets: [publerKey, publerWorkspace, telegram],
    });
    const publer = serviceCards.find((service) => service.id === 'publer');
    expect(publer.items.map((row) => row.secret)).toEqual([
      'PUBLER-API-KEY',
      'PUBLER-WORKSPACE-ID',
    ]);
  });

  it('never shows a claimed credential twice - on its card and loose in the group', () => {
    // The whole point of the merge. Rotating Publer from the card and from a
    // duplicate row further down would be two paths to one write, and the
    // second would look like a different credential.
    const { serviceGroups } = buildIntegrationView({
      sections,
      secrets: [publerKey, publerWorkspace, telegram, originSecret],
    });
    const communication = serviceGroups.find((group) => group.id === 'communication');
    const onCards = communication.cards.flatMap((card) => card.items.map((row) => row.secret));
    expect(onCards).toContain('PUBLER-API-KEY');
    expect(onCards).toContain('TELEGRAM-BOT-TOKEN');
    // Everything in this group belongs to a card, so nothing is left loose.
    expect(communication.loose).toEqual([]);
  });

  it('shows a credential with no service card as a loose row in its own group', () => {
    // The salt has no card. It must still appear, under Site platform,
    // rather than falling off the page because nothing claimed it.
    const { serviceGroups } = buildIntegrationView({ sections, secrets: [originSecret] });
    const platform = serviceGroups.find((group) => group.id === 'platform');
    expect(platform.loose.map((row) => row.secret)).toEqual(['CLIENT-IP-SALT']);
    // The group's cards list Azure sign-ins, the agent keys the site issues
    // and Cloudflare's keys; none claims the salt, so it stays loose beside them.
    expect(platform.cards.map((card) => card.id)).toEqual(['azure', 'agent-keys', 'cloudflare']);
    for (const card of platform.cards) expect(card.items).toEqual([]);
  });

  it('gives a credential whose group this page does not know a heading of its own', () => {
    // The safety net. A key nobody can see is a key nobody can rotate, so an
    // unknown section gets its own heading rather than silence.
    const stray = item({ secret: 'STRAY-KEY', section: 'nowhere', label: 'Stray' });
    const { orphanSections, serviceGroups } = buildIntegrationView({
      sections,
      secrets: [stray],
    });
    expect(orphanSections.map((section) => section.id)).toEqual(['nowhere']);
    expect(orphanSections[0].items.map((row) => row.secret)).toEqual(['STRAY-KEY']);
    const placed = serviceGroups.flatMap((group) => group.loose.map((row) => row.secret));
    expect(placed).not.toContain('STRAY-KEY');
  });

  it('leaves nothing loose when every credential went to a service card', () => {
    const { serviceGroups, orphanSections } = buildIntegrationView({
      sections,
      secrets: [publerKey, publerWorkspace],
    });
    expect(orphanSections).toEqual([]);
    for (const group of serviceGroups) {
      expect(group.loose, `${group.id} has loose credentials`).toEqual([]);
    }
  });

  it('renders nothing for a credential a service names but the API did not return', () => {
    // The catalogue can grow a name this page has not been taught yet, and an
    // empty row would read as "not set" for a credential that does not exist.
    const { serviceCards } = buildIntegrationView({ sections, secrets: [] });
    expect(serviceCards.every((service) => service.items.length === 0)).toBe(true);
    expect(serviceCards.map((service) => service.id)).toContain('publer');
  });
});

describe('the Keys tab join (#570)', () => {
  const sections = [{ id: 'gen-ai', title: 'Gen AI', blurb: 'AI keys.' }];

  it('keeps a claimed key in its group and names the service that uses it', () => {
    // The Keys tab is where EVERY key lives, so unlike the Services join a
    // key a card claims is not removed from the list.
    const { groups } = buildKeyGroups({
      sections,
      secrets: [
        item({ secret: 'PUBLER-API-KEY', section: 'communication' }),
        item({ secret: 'FIRECRAWL-API-KEY', section: 'ai-services' }),
        item({ secret: 'CLIENT-IP-SALT', section: 'platform' }),
      ],
    });
    const communication = groups.find((group) => group.id === 'communication');
    expect(communication.items.map((row) => row.secret)).toEqual(['PUBLER-API-KEY']);
    expect(communication.items[0].usedBy).toEqual(['Publer']);
    // And which service test exercises it, for the row's wording (ADR 0033).
    expect(communication.items[0].testedBy).toEqual(['Publer']);
    const aiServices = groups.find((group) => group.id === 'ai-services');
    expect(aiServices.items[0].usedBy).toEqual(['Firecrawl']);
    const platform = groups.find((group) => group.id === 'platform');
    expect(platform.items[0].usedBy).toEqual([]);
    expect(platform.items[0].testedBy).toEqual([]);
  });

  it('says a Cloudflare key is checked by the card’s test only when the test reads it (#1905)', () => {
    const { groups } = buildKeyGroups({
      sections,
      secrets: [
        item({ secret: 'CLOUDFLARE-ADMIN-TOKEN', section: 'platform' }),
        item({ secret: 'CF-ORIGIN-SECRET', section: 'platform' }),
      ],
    });
    const platform = groups.find((group) => group.id === 'platform');
    const row = (name) => platform.items.find((entry) => entry.secret === name);
    expect(row('CLOUDFLARE-ADMIN-TOKEN').usedBy).toEqual(['Cloudflare']);
    expect(row('CLOUDFLARE-ADMIN-TOKEN').testedBy).toEqual(['Cloudflare']);
    expect(row('CF-ORIGIN-SECRET').usedBy).toEqual(['Cloudflare']);
    expect(row('CF-ORIGIN-SECRET').testedBy).toEqual([]);
  });

  it('drops a group with no keys and puts an unknown section under Other credentials', () => {
    const { groups, otherSections } = buildKeyGroups({
      sections: [{ id: 'nowhere', title: 'Somewhere new', blurb: 'b' }],
      secrets: [item({ secret: 'STRAY-KEY', section: 'nowhere' })],
    });
    expect(groups).toEqual([]);
    expect(otherSections).toHaveLength(1);
    expect(otherSections[0].title).toBe('Somewhere new');
    expect(otherSections[0].items.map((row) => row.secret)).toEqual(['STRAY-KEY']);
  });

  it('lists every key it was given exactly once', () => {
    const secrets = [
      item({ secret: 'A', section: 'gen-ai' }),
      item({ secret: 'B', section: 'communication' }),
      item({ secret: 'C', section: 'mystery' }),
    ];
    const { groups, otherSections } = buildKeyGroups({ sections, secrets });
    const listed = [...groups, ...otherSections].flatMap((g) => g.items.map((row) => row.secret));
    expect(listed.sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('the Overview status (#570)', () => {
  const card = (over = {}) => ({ id: 'x', test: () => 'ok', items: [], ...over });

  it('calls a failed test broken even when every key is green', () => {
    expect(serviceStatus(card({ items: [item({ state: 'live' })] }), { ok: false })).toBe('broken');
  });

  it('calls a test that could not reach the service offline, not broken (#1010)', () => {
    const failed = { ok: false, message: 'Failed to fetch' };
    expect(serviceStatus(card(), failed)).toBe('offline');
    expect(SERVICE_STATUS.offline.badge.id).toBe('offline');
    expect(SERVICE_STATUS.broken.badge.id).toBe('critical');
    expect(SERVICE_STATUS['not-configured'].badge.id).toBe('critical');
    expect(resultStatus(failed).id).toBe('offline');
    expect(resultStatus({ ok: false, message: 'Unauthorized' }).id).toBe('critical');
    expect(resultStatus({ ok: false, message: 'RESEND_API_KEY is not set' }).id).toBe('critical');
  });

  it('calls a rejected key broken, and a passing test does not hide it', () => {
    // Telegram's getMe never reads the chat id, so a pass cannot vouch for it.
    const withRejected = card({ items: [item({ state: 'live' }), item({ state: 'failing' })] });
    expect(serviceStatus(withRejected, { ok: true })).toBe('broken');
  });

  it('calls an unset key not configured, and a going-live one pending', () => {
    expect(serviceStatus(card({ items: [item({ state: 'never' })] }))).toBe('not-configured');
    expect(serviceStatus(card({ items: [item({ state: 'pending' })] }))).toBe('pending');
  });

  it('separates untested, working and a plain profile link', () => {
    expect(serviceStatus(card({ items: [item({ state: 'live' })] }))).toBe('untested');
    expect(serviceStatus(card(), { ok: true })).toBe('ok');
    expect(serviceStatus(card({ test: null }))).toBe('link-only');
  });

  it('calls a card of sign-ins the site lists and does not hold “listed”, not a profile link', () => {
    const listed = card({ test: null, keyGroups: [{ title: 'A sign-in', panel: 'museReader' }] });
    expect(serviceStatus(listed)).toBe('listed');
    expect(SERVICE_STATUS.listed.badge.label).toBe('Listed, not held');
    expect(SERVICE_STATUS.listed.badge.help).toMatch(/cannot test/);
    // A box of real keys with no panel is still judged by its lights.
    const keyed = card({ test: null, keyGroups: [{ title: 'Keys', secrets: ['A'] }] });
    expect(serviceStatus(keyed)).toBe('link-only');
    // The three cards that are only listed today.
    for (const id of ['azure', 'hostinger', 'copilot-review']) {
      const service = SERVICES.find((entry) => entry.id === id);
      expect(serviceStatus({ ...service, items: [] }), id).toBe('listed');
    }
    expect(serviceStatus({ ...SERVICES.find((entry) => entry.id === 'credly'), items: [] })).toBe(
      'link-only'
    );
  });

  it('sorts broken first, then not configured, keeping registry order within a status', () => {
    const cards = [
      card({ id: 'fine', test: null, items: [item({ state: 'live' })] }),
      card({ id: 'unset', items: [item({ state: 'never' })] }),
      card({ id: 'profile', test: null }),
      card({ id: 'tested-bad' }),
      card({ id: 'rejected', items: [item({ state: 'failing' })] }),
    ];
    const sorted = sortByStatus(cards, { 'tested-bad': { ok: false, message: 'nope' } });
    expect(sorted.map((c) => c.id)).toEqual(['tested-bad', 'rejected', 'unset', 'fine', 'profile']);
    expect(sorted[0].status).toBe('broken');
  });
});
