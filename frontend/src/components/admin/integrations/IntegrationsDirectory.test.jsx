/**
 * The Integrations directory: configuration held to the service registry,
 * search and filters over it, alphabetical order, and each card's status,
 * links and Set up (owner brief 2026-10-06, #919). The status guard from
 * the review: while the key status cannot be read, a keyed service with no
 * test is unknown, never connected.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import IntegrationsDirectory, {
  CONNECTION_FILTERS,
  filterDirectory,
} from './IntegrationsDirectory';
import {
  DIRECTORY,
  DIRECTORY_CATEGORIES,
  connectionOf,
  decorateEntries,
  directoryEntries,
  directoryStatus,
} from '@/config/integrationsDirectory';
import { SERVICES } from './serviceRegistry';

const secretStatus = vi.fn();
vi.mock('./useSecretStatus', () => ({ default: () => secretStatus() }));

const tests = () => ({
  results: {},
  // Telegram's last test passed, so its live keys read as connected; a
  // testable service with live keys and no test yet reads as not yet tested.
  persisted: { telegram: { lastOkAt: '2026-10-06T12:00:00.000Z' } },
  testing: new Set(),
  runningAll: false,
  runTest: vi.fn(),
  runAll: vi.fn(),
  persistedState: 'ok',
  ensurePersisted: vi.fn(),
});

beforeEach(() => {
  secretStatus.mockReset().mockReturnValue({
    data: {
      sections: [],
      secrets: [
        { secret: 'TELEGRAM-BOT-TOKEN', state: 'live', section: 'communication' },
        { secret: 'TELEGRAM-CHAT-ID', state: 'live', section: 'communication' },
        { secret: 'ANTHROPIC-API-KEY', state: 'never', section: 'gen-ai' },
      ],
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  });
});

describe('the configuration', () => {
  it('names a real service in every row, once, in a known category, with https links', () => {
    const ids = new Set(SERVICES.map((s) => s.id));
    const categories = new Set(DIRECTORY_CATEGORIES.map((c) => c.id));
    const seen = new Set();
    for (const row of DIRECTORY) {
      expect(ids.has(row.id), `${row.id} is not a service`).toBe(true);
      expect(seen.has(row.id), `${row.id} listed twice`).toBe(false);
      seen.add(row.id);
      expect(categories.has(row.category), `${row.id}: category ${row.category}`).toBe(true);
      expect(row.summary, row.id).toMatch(/\.$/);
      expect(row.powers, row.id).toMatch(/\.$/);
      if (row.docsUrl) expect(row.docsUrl, row.id).toMatch(/^https:\/\//);
    }
  });

  it('covers every service in the registry, so none is missing from the directory', () => {
    const listed = new Set(DIRECTORY.map((row) => row.id));
    for (const service of SERVICES) {
      expect(listed.has(service.id), `${service.id} (${service.name}) has no directory row`).toBe(
        true
      );
    }
  });

  it('merges name, usage, site and a Set up link from the registries', () => {
    const telegram = directoryEntries().find((entry) => entry.id === 'telegram');
    expect(telegram).toMatchObject({
      name: 'Telegram',
      group: 'communication',
      siteUrl: 'https://telegram.org',
      keyed: true,
      setupHref: '/admin/integrations?tab=services&group=communication',
    });
    expect(telegram.usedIn.length).toBeGreaterThan(0);
    expect(
      directoryEntries({
        directory: [{ id: 'ghost', category: 'ai', summary: 'x.', powers: 'y.' }],
      })
    ).toEqual([]);
    // The official site comes from the brand registry alone: a composite card
    // has none, rather than this site's own page or a vendor's docs.
    for (const id of ['cloud-pricing', 'hybrid-lab']) {
      expect(directoryEntries().find((entry) => entry.id === id).siteUrl).toBeNull();
    }
  });

  it('lists no provider that nothing on the site uses (Perplexity, retired in #1029)', () => {
    expect(DIRECTORY.find((row) => row.id === 'perplexity')).toBeUndefined();
  });

  it('reads a status key as connected, not connected, or unknown', () => {
    expect(connectionOf('ok')).toBe('connected');
    expect(connectionOf('link-only')).toBe('connected');
    expect(connectionOf('listed')).toBe('connected');
    expect(connectionOf('broken')).toBe('not-connected');
    expect(connectionOf('not-configured')).toBe('not-connected');
    expect(connectionOf('untested')).toBe('unknown');
    expect(connectionOf('pending')).toBe('unknown');
  });

  it('reads a keyed service as unknown, not connected, while the key status cannot be read', () => {
    const entry = { id: 'azure-speech', keyed: true };
    const card = { id: 'azure-speech', items: [], test: undefined };
    expect(directoryStatus({ entry, card, result: undefined, secretsKnown: false })).toBe(
      'untested'
    );
    expect(directoryStatus({ entry, card, result: undefined, secretsKnown: true })).toBe(
      'link-only'
    );
    expect(directoryStatus({ entry, card, result: { ok: true }, secretsKnown: false })).toBe('ok');
    expect(
      directoryStatus({
        entry: { id: 'credly', keyed: false },
        card: { id: 'credly', items: [] },
        result: undefined,
        secretsKnown: false,
      })
    ).toBe('link-only');
    expect(directoryStatus({ entry, card: undefined, result: undefined, secretsKnown: true })).toBe(
      'untested'
    );
    const decorated = decorateEntries([{ id: 'azure-speech', keyed: true, category: 'ai' }], {
      serviceCards: [card],
      results: {},
      secretsKnown: false,
    });
    expect(decorated[0]).toMatchObject({
      statusKey: 'untested',
      connection: 'unknown',
      categoryLabel: 'AI',
    });
  });
});

describe('filtering', () => {
  const entries = [
    {
      id: 'b',
      name: 'Beta',
      summary: 'Second.',
      powers: 'Posting.',
      category: 'ai',
      categoryLabel: 'AI',
      connection: 'connected',
      usedIn: ['Forge'],
    },
    {
      id: 'a',
      name: 'Alpha',
      summary: 'First.',
      powers: 'Mail.',
      category: 'communication',
      categoryLabel: 'Communication',
      connection: 'not-connected',
      usedIn: [],
    },
    {
      id: 'c',
      name: 'Gamma',
      summary: 'Third.',
      powers: 'Images.',
      category: 'ai',
      categoryLabel: 'AI',
      connection: 'unknown',
      usedIn: ['Gallery'],
    },
  ];
  it('sorts alphabetically and narrows by category, connection and words anywhere on the card', () => {
    expect(filterDirectory(entries).map((e) => e.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(filterDirectory(entries, { category: 'ai' }).map((e) => e.name)).toEqual([
      'Beta',
      'Gamma',
    ]);
    expect(filterDirectory(entries, { connection: 'not-connected' }).map((e) => e.name)).toEqual([
      'Alpha',
    ]);
    expect(filterDirectory(entries, { query: 'gallery' }).map((e) => e.name)).toEqual(['Gamma']);
    expect(filterDirectory(entries, { query: 'MAIL' }).map((e) => e.name)).toEqual(['Alpha']);
    expect(filterDirectory(entries, { query: 'communication' }).map((e) => e.name)).toEqual([
      'Alpha',
    ]);
    expect(
      filterDirectory(entries, { category: 'ai', connection: 'connected' }).map((e) => e.name)
    ).toEqual(['Beta']);
  });
});

describe('the tab', () => {
  const renderTab = () =>
    render(
      <MemoryRouter>
        <IntegrationsDirectory tests={tests()} />
      </MemoryRouter>
    );

  it('lists every directory row as a card with its badge, category, status and links, alphabetically', () => {
    renderTab();
    const list = screen.getByRole('list', { name: 'Integrations directory' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(DIRECTORY.length);
    const names = items.map((item) => within(item).getByRole('heading', { level: 3 }).textContent);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    const telegram = items.find((item) =>
      within(item).queryByRole('heading', { name: 'Telegram' })
    );
    expect(within(telegram).getByText(/Powered by Telegram/)).toBeTruthy();
    expect(within(telegram).getByText('Communication')).toBeTruthy();
    expect(within(telegram).getByText('Messaging and notification delivery.')).toBeTruthy();
    expect(
      within(telegram)
        .getByRole('link', { name: /Set up/ })
        .getAttribute('href')
    ).toBe('/admin/integrations?tab=services&group=communication');
    expect(within(telegram).getByRole('link', { name: /Docs/ }).getAttribute('href')).toBe(
      'https://core.telegram.org/bots/api'
    );
    expect(
      within(telegram)
        .getByRole('link', { name: /Official site/ })
        .getAttribute('href')
    ).toBe('https://telegram.org');
    // A composite card offers no Official site.
    const pricing = items.find((item) =>
      within(item).queryByRole('heading', { name: 'Cloud pricing cache' })
    );
    expect(within(pricing).queryByRole('link', { name: /Official site/ })).toBeNull();
  });

  it('shows connection from the key lights and tests: a recorded pass reads as connected, an unset key as not connected', () => {
    renderTab();
    expect(screen.getByText(/of \d+ connected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not connected' }));
    const names = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names).toContain('Anthropic');
    expect(names).not.toContain('Telegram');
    fireEvent.click(screen.getByRole('button', { name: 'Connected' }));
    const connected = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(connected).toContain('Telegram');
    expect(connected).not.toContain('Anthropic');
  });

  it('keeps recorded verdicts and reads keyed services without one as unknown while the key status read has failed', () => {
    secretStatus.mockReturnValue({
      data: null,
      loading: false,
      error: 'HTTP 403',
      reload: vi.fn(),
    });
    renderTab();
    expect(screen.getByRole('alert').textContent).toMatch(/Key status could not be read/);
    fireEvent.click(screen.getByRole('button', { name: 'Connected' }));
    const connected = screen.queryAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    // Telegram's recorded pass still counts; a keyed service with no test does not.
    expect(connected).toContain('Telegram');
    expect(connected).not.toContain('Azure AI Speech');
  });

  it('searches and filters by category, and says so when nothing matches', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'AI' }));
    const ai = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(ai).toContain('Anthropic');
    expect(ai).not.toContain('Telegram');
    fireEvent.change(screen.getByLabelText('Search integrations'), {
      target: { value: 'podcast voices' },
    });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'ElevenLabs',
    ]);
    fireEvent.change(screen.getByLabelText('Search integrations'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/No integration matches/)).toBeTruthy();
  });

  it('offers the four connection filters and only the categories in use', () => {
    renderTab();
    for (const filter of CONNECTION_FILTERS) {
      expect(screen.getByRole('button', { name: filter.label })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'Payments' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'All categories' }).getAttribute('aria-pressed')
    ).toBe('true');
  });
});
