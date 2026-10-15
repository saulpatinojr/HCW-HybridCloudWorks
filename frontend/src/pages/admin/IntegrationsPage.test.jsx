/**
 * The Integrations Hub page (#570): only the tab bar and the session's test
 * results live here. What must hold: `?tab=` picks the tab, a moved or unknown
 * id lands where its content went (Overview by default), a tab click writes
 * the URL, each tab fetches only its own data so one refusal never blanks
 * another, and a test result outlives a trip to another tab.
 *
 * The behaviour of each tab is tested beside it in
 * components/admin/integrations.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import IntegrationsPage from './IntegrationsPage';

const getJSON = vi.fn();
const postJSON = vi.fn();
const setSearchParams = vi.fn();
let searchParams = '';

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: vi.fn(),
  postJSON: (...args) => postJSON(...args),
}));
vi.mock('@/lib/adminSettings', () => ({
  getIntegrationSettings: async () => ({ sessionizeSpeakerId: 'speaker-42' }),
  saveIntegrationSettings: vi.fn(),
  getSessionizeSpeakerId: async () => 'speaker-42',
  DEFAULT_SESSIONIZE_SPEAKER_ID: 'default-speaker',
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-router', () => ({
  useSearchParams: () => [new URLSearchParams(searchParams), setSearchParams],
  // PageHeader reads the route to find its purpose sentence.
  useLocation: () => ({ pathname: '/admin/integrations', search: '' }),
  Link: ({ to, children, ...rest }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const SECRETS = {
  success: true,
  sections: [{ id: 'gen-ai', title: 'Gen AI', blurb: 'b' }],
  secrets: [
    {
      secret: 'GEMINI-API-KEY',
      section: 'gen-ai',
      label: 'Google Gemini',
      help: 'API key.',
      state: 'live',
      generatable: false,
      hasLivenessCheck: true,
    },
  ],
};

// The register's answer, cut to one credential (#1026).
const CREDENTIALS = {
  success: true,
  stores: [{ id: 'lab-file', label: 'Lab host file' }],
  counts: { ok: 0, 'due-soon': 0, overdue: 0, unknown: 1 },
  credentials: [
    {
      id: 'lab-agent-certificate',
      name: '/etc/hcw/labs-agent.pem',
      store: 'lab-file',
      consumer: 'The lab agent',
      issuer: 'Self-signed',
      renewal: 'hand',
      lifetimeDays: 730,
      recordable: true,
      ageDays: null,
      expiresAt: null,
      state: 'unknown',
      reason: 'No rotation date is known: record when it was last rotated.',
      reminder: null,
    },
  ],
  unavailable: [],
};

// The fetch stub must not leak into later files in the same worker.
afterEach(() => {
  vi.unstubAllGlobals();
});

const routes = () => getJSON.mock.calls.map(([route]) => route);
const hubTabs = () => within(screen.getByRole('tablist', { name: 'Integrations Hub' }));
const selectedTab = () => hubTabs().getByRole('tab', { selected: true }).textContent;

beforeEach(() => {
  searchParams = '';
  setSearchParams.mockReset();
  postJSON.mockReset().mockResolvedValue({ ok: true, status: 200, data: {} });
  // Sessionize's test is a plain public fetch; never let a test reach it.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ events: [] }) }))
  );
  getJSON.mockReset().mockImplementation(async (route) => {
    if (route === 'cms/secrets') return SECRETS;
    if (route === 'cms/credentials') return CREDENTIALS;
    if (route === 'getAuthExpectations') return { tenantId: 'tenant-guid' };
    throw new Error(`unexpected route ${route}`);
  });
});

describe('the header and tabs', () => {
  it('names the page Integrations, as the menu does, and offers its tabs, in order, the Directory last', () => {
    render(<IntegrationsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Integrations' })).toBeTruthy();
    expect(
      hubTabs()
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
    ).toEqual(['Overview', 'Services', 'Keys', 'Credentials', 'Identity', 'Directory']);
  });

  it('opens on Overview with no tab in the URL, which is where an old bookmark lands', async () => {
    render(<IntegrationsPage />);
    expect(selectedTab()).toBe('Overview');
    expect(await screen.findByRole('button', { name: /Test all/ })).toBeTruthy();
  });

  it.each([
    ['overview', 'Overview'],
    ['services', 'Services'],
    ['keys', 'Keys'],
    ['credentials', 'Credentials'],
    ['identity', 'Identity'],
  ])('deep-links ?tab=%s to the %s tab', (tab, label) => {
    searchParams = `tab=${tab}`;
    render(<IntegrationsPage />);
    expect(selectedTab()).toBe(label);
  });

  it.each([
    ['api-keys', 'Keys'],
    ['secrets', 'Keys'],
    ['connections', 'Overview'],
    ['entra', 'Identity'],
    ['no-such-tab', 'Overview'],
  ])('sends the moved or unknown tab id %s to %s', (tab, label) => {
    searchParams = `tab=${tab}`;
    render(<IntegrationsPage />);
    expect(selectedTab()).toBe(label);
  });

  it('writes the tab to the URL when one is clicked, so it can be linked', () => {
    render(<IntegrationsPage />);
    fireEvent.click(hubTabs().getByRole('tab', { name: 'Keys' }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: 'keys' });
  });

  it('keeps the chosen Services group, and a click on the active tab changes nothing', () => {
    searchParams = 'tab=services&group=gen-ai';
    render(<IntegrationsPage />);
    fireEvent.click(hubTabs().getByRole('tab', { name: 'Services' }));
    expect(setSearchParams).not.toHaveBeenCalled();
  });

  it('keeps the Services group in the URL when leaving Services for another tab', () => {
    searchParams = 'tab=services&group=gen-ai';
    render(<IntegrationsPage />);
    fireEvent.click(hubTabs().getByRole('tab', { name: 'Keys' }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: 'keys', group: 'gen-ai' });
  });

  it('carries the Services group back when returning from another tab', () => {
    searchParams = 'tab=keys&group=gen-ai';
    render(<IntegrationsPage />);
    fireEvent.click(hubTabs().getByRole('tab', { name: 'Services' }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: 'services', group: 'gen-ai' });
  });

  it('follows the ARIA tabs keyboard pattern: roving tabindex, arrows wrap, Home and End', () => {
    render(<IntegrationsPage />);
    const tabs = hubTabs().getAllByRole('tab');
    expect(tabs[0].getAttribute('tabindex')).toBe('0');
    expect(tabs[1].getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(setSearchParams).toHaveBeenLastCalledWith({ tab: 'services' });
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
    expect(setSearchParams).toHaveBeenLastCalledWith({ tab: 'directory' });
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(setSearchParams).toHaveBeenLastCalledWith({ tab: 'directory' });
  });
});

describe('each tab loads its own data', () => {
  it('the Keys tab reads key status and nothing else', async () => {
    searchParams = 'tab=keys';
    render(<IntegrationsPage />);
    await waitFor(() => expect(screen.getByText('Google Gemini')).toBeTruthy());
    expect(routes()).toEqual(['cms/secrets']);
  });

  it('the Identity tab reads auth expectations and nothing else', async () => {
    searchParams = 'tab=identity';
    render(<IntegrationsPage />);
    await waitFor(() => expect(screen.getByText('tenant-guid')).toBeTruthy());
    expect(routes()).toEqual(['getAuthExpectations']);
  });

  it('the Credentials tab reads the register and nothing else', async () => {
    searchParams = 'tab=credentials';
    render(<IntegrationsPage />);
    await waitFor(() => expect(screen.getByText('/etc/hcw/labs-agent.pem')).toBeTruthy());
    expect(routes()).toEqual(['cms/credentials']);
  });

  it('a refused key-status read stays inside the Keys tab and leaves Identity whole', async () => {
    getJSON.mockImplementation(async (route) => {
      if (route === 'cms/secrets') throw new Error('HTTP 403 from cms/secrets');
      return { tenantId: 'tenant-guid' };
    });

    searchParams = 'tab=keys';
    const { rerender } = render(<IntegrationsPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/HTTP 403/));
    // The page around the tab is still there.
    expect(screen.getByRole('heading', { level: 1, name: 'Integrations' })).toBeTruthy();
    expect(hubTabs().getAllByRole('tab')).toHaveLength(6);

    searchParams = 'tab=identity';
    rerender(<IntegrationsPage />);
    await waitFor(() => expect(screen.getByText('tenant-guid')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/did not answer/)).toBeNull();
  });

  it('a refused auth read stays inside Identity and leaves the Keys tab whole', async () => {
    getJSON.mockImplementation(async (route) => {
      if (route === 'getAuthExpectations') throw new Error('HTTP 401');
      return SECRETS;
    });

    searchParams = 'tab=identity';
    const { rerender } = render(<IntegrationsPage />);
    await waitFor(() => expect(screen.getByText(/did not answer/)).toBeTruthy());

    searchParams = 'tab=keys';
    rerender(<IntegrationsPage />);
    await waitFor(() => expect(screen.getByText('Google Gemini')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the session’s test results', () => {
  it('outlive a trip to another tab, and show on both Overview and Services', async () => {
    searchParams = 'tab=overview';
    const { rerender } = render(<IntegrationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Test all/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Test all/ }).disabled).toBe(false)
    );
    await waitFor(() =>
      expect(
        within(document.querySelector('[data-service="sessionize"]')).getByText(/tested/)
      ).toBeTruthy()
    );

    searchParams = 'tab=services&group=communication';
    rerender(<IntegrationsPage />);
    const resendCard = (await screen.findByText('Resend')).closest('.p-4');
    expect(within(resendCard).getByText('Healthy')).toBeTruthy();
    expect(within(resendCard).getByText(/tested just now/)).toBeTruthy();
  });
});
