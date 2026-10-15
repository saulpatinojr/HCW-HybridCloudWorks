/**
 * The Platform Settings Hub's frame (#571): one tab per concern, `?tab=` deep
 * links, and each tab loading only its own settings when it is opened. What
 * each card sends on Save is tested beside the card, in
 * components/admin/platform-settings.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

import PlatformSettingsPage, { TABS, resolveTab } from './PlatformSettingsPage';
import { SETTINGS_INDEX } from '@/components/admin/platform-settings/AllSettingsTab';
import { NAV_ITEMS } from '@/config/adminNav';
import { settingRoute } from '@/components/admin/platform-settings/settingShared';
import { HISTORY_ROUTE } from '@/components/admin/platform-settings/ChangeHistoryTab';
import { ELEVENLABS_STATUS_ROUTE } from '@/components/admin/platform-settings/ElevenLabsCard';

// The Radix Switch measures its thumb with ResizeObserver, which jsdom lacks.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const getJSON = vi.fn();
const postJSON = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: vi.fn(),
  postJSON: (...args) => postJSON(...args),
  authedFetch: vi.fn(),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const empty = {
  'default-heroes': { heroes: {} },
  'social-autopost': { enabled: false, accountIds: [], scheduleDelayMinutes: 60 },
  'podcast-feeds': { feeds: [] },
  'listen-and-learn-speech': { geminiModel: 'gemini-3.1-flash-tts-preview' },
  'podcast-voices': { Maya: '', Elena: '' },
  reminders: { reminders: [] },
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

const renderAt = (url) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <PlatformSettingsPage />
      <LocationProbe />
    </MemoryRouter>
  );

const routesAsked = () => getJSON.mock.calls.map(([route]) => route.split('?')[0]);

beforeEach(() => {
  getJSON.mockReset().mockImplementation(async (route) => {
    if (route.startsWith(HISTORY_ROUTE)) return { success: true, entries: [], nextAfter: null };
    if (route === ELEVENLABS_STATUS_ROUTE) {
      return { success: true, configured: false, reason: 'ELEVENLABS_API_KEY is not configured.' };
    }
    const setting = route.replace('cms/platform-settings/', '');
    return { success: true, setting, value: empty[setting], exists: false };
  });
  postJSON.mockReset().mockResolvedValue({ ok: false, code: 'INTEGRATION_NOT_CONFIGURED' });
});

describe('tabs', () => {
  it('are one per concern, the index first and Change history last', () => {
    expect(TABS.map((tab) => [tab.id, tab.label])).toEqual([
      ['index', 'All settings'],
      ['content', 'Content defaults'],
      ['taxonomy', 'Content types & origins'],
      ['social', 'Social automation'],
      ['audio', 'Audio'],
      ['reminders', 'Reminders'],
      ['history', 'Change history'],
    ]);
    expect(resolveTab('audio').id).toBe('audio');
    expect(resolveTab('nope').id).toBe('index');
    expect(resolveTab(null).id).toBe('index');
  });

  it('opens the All settings index with no ?tab=, reading nothing (ADR 0033)', async () => {
    renderAt('/admin/platform-settings');
    expect(screen.getByRole('heading', { level: 1, name: 'Platform Settings' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'All settings' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    // Every setting document, with where it is edited and a real link.
    const table = screen.getByRole('table');
    for (const label of [
      'Default covers',
      'Newsletter settings',
      'AI providers and models',
      'Sessionize speaker id',
      'Gallery folders',
      'Plaud sign-in',
      'Labs agents',
    ]) {
      expect(within(table).getByText(label)).toBeTruthy();
    }
    expect(
      within(table).getByRole('link', { name: 'Open Sessionize speaker id' }).getAttribute('href')
    ).toBe('/admin/integrations?tab=services&group=content');
    expect(
      within(table).getByRole('link', { name: 'Open Newsletter settings' }).getAttribute('href')
    ).toBe('/admin/newsletter-hub?tab=settings');
    expect(routesAsked()).toEqual([]);
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('every index row links to a route the sidebar declares', () => {
    const routes = new Set(NAV_ITEMS.map((item) => item.to));
    for (const row of SETTINGS_INDEX) {
      const [path] = row.href.split('?');
      expect(routes, `${row.label} links to ${path}`).toContain(path);
    }
  });

  it('opens Content defaults from ?tab=content, loading only the covers', async () => {
    renderAt('/admin/platform-settings?tab=content');
    await screen.findByText('Default covers');
    expect(
      screen.getByRole('tab', { name: 'Content defaults' }).getAttribute('aria-selected')
    ).toBe('true');
    expect(routesAsked()).toEqual([settingRoute('default-heroes')]);
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('deep-links each tab, and each loads only its own data', async () => {
    renderAt('/admin/platform-settings?tab=audio');
    await screen.findByText('Podcast feeds');
    await screen.findByText('Listen & Learn voice');
    await screen.findByText('Not configured');
    // Its two settings and the podcast voice's status (ElevenLabs,
    // 2026-09-26; the podcast voices, #725). No key, so no voice list. The
    // Listen & Learn voice card loads nothing: the model is chosen under AI
    // Engine → Tasks (ADR 0034 slice 5).
    await waitFor(() => expect(routesAsked()).toHaveLength(3));
    expect(routesAsked().sort()).toEqual(
      [
        settingRoute('podcast-feeds'),
        settingRoute('podcast-voices'),
        ELEVENLABS_STATUS_ROUTE,
      ].sort()
    );
    expect(screen.queryByText('Default covers')).toBeNull();
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('deep-links Social automation, which alone asks Publer', async () => {
    renderAt('/admin/platform-settings?tab=social');
    await screen.findByText('Social autoposting');
    expect(routesAsked()).toEqual([settingRoute('social-autopost')]);
    expect(postJSON).toHaveBeenCalledWith('publerProxy', { path: '/accounts', method: 'GET' });
  });

  it('deep-links Reminders, which reads the reminders document only', async () => {
    renderAt('/admin/platform-settings?tab=reminders');
    await screen.findByText(/Nothing here yet/);
    expect(routesAsked()).toEqual([settingRoute('reminders')]);
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('deep-links Change history, which reads the history route only', async () => {
    renderAt('/admin/platform-settings?tab=history');
    expect(await screen.findByText(/No settings changes recorded yet/)).toBeTruthy();
    expect(routesAsked()).toEqual([HISTORY_ROUTE]);
  });

  it('lands an unknown ?tab= on the index rather than a blank page', async () => {
    renderAt('/admin/platform-settings?tab=covers');
    expect(screen.getByRole('tab', { name: 'All settings' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('switching tabs writes ?tab= and mounts the new tab fresh', async () => {
    renderAt('/admin/platform-settings?tab=content');
    await screen.findByText('Default covers');
    fireEvent.click(screen.getByRole('tab', { name: 'Change history' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/admin/platform-settings?tab=history'
      )
    );
    expect(await screen.findByText(/No settings changes recorded yet/)).toBeTruthy();
    expect(screen.queryByLabelText('Azure')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Content defaults' }));
    await screen.findByText('Default covers');
    // Opened twice, loaded twice: a tab reads what is stored now, not what it
    // held when it was last open.
    expect(routesAsked().filter((r) => r === settingRoute('default-heroes'))).toHaveLength(2);
  });

  it('follows the ARIA tabs keyboard pattern: roving tabindex, arrows wrap, Home and End', async () => {
    renderAt('/admin/platform-settings?tab=content');
    await screen.findByText('Default covers');
    const tab = (name) => screen.getByRole('tab', { name });
    expect(tab('Content defaults').getAttribute('tabindex')).toBe('0');
    expect(tab('Audio').getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(tab('Content defaults'), { key: 'ArrowRight' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/admin/platform-settings?tab=taxonomy'
      )
    );
    expect(document.activeElement).toBe(tab('Content types & origins'));
    expect(tab('Content types & origins').getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(tab('Content types & origins'), { key: 'End' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/admin/platform-settings?tab=history'
      )
    );
    // Wraps to the index, which is first now.
    fireEvent.keyDown(tab('Change history'), { key: 'ArrowRight' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/admin/platform-settings?tab=index')
    );
    fireEvent.keyDown(tab('All settings'), { key: 'ArrowLeft' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/admin/platform-settings?tab=history'
      )
    );
    fireEvent.keyDown(tab('Change history'), { key: 'Home' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/admin/platform-settings?tab=index')
    );
  });

  it('a failure in one tab does not reach another', async () => {
    getJSON.mockImplementation(async (route) => {
      if (route === settingRoute('default-heroes')) throw new Error('HTTP 500');
      const setting = route.replace('cms/platform-settings/', '');
      return { success: true, value: empty[setting], exists: false };
    });
    renderAt('/admin/platform-settings?tab=content');
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 500');
    fireEvent.click(screen.getByRole('tab', { name: 'Audio' }));
    await screen.findByText('Podcast feeds');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
