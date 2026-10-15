/**
 * The Social Hub's shell: which panel a `?tab=` picks, and that a tab click is
 * a URL change rather than local state (#575).
 *
 * The tabs' own behaviour is tested beside them in components/admin/social;
 * what is asserted here is only what the page decides — the resolver's answer,
 * the deep link it hands Compose, and the tab bar it renders.
 *
 * react-router is mocked rather than wrapped, as ListenAndLearnPage.test does,
 * so a tab click can be asserted as the `setSearchParams` call it is.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SocialHubPage from './SocialHubPage';

let searchParams = '';
const setSearchParams = vi.fn();

vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));

vi.mock('react-router', async () => {
  const React_ = await vi.importActual('react');
  return {
    // PageHeader reads the route to find its purpose sentence.
    useLocation: () => ({ pathname: '/admin/social-hub', search: '' }),
    useSearchParams: () => [new URLSearchParams(searchParams), setSearchParams],
    Link: ({ to, children }) => React_.createElement('a', { href: to }, children),
  };
});

// The header's connection state is the accounts call's answer (ADR 0033);
// `accountsStatus` is what one test moves.
let accountsStatus = 'ready';
vi.mock('@/components/admin/social/usePublerAccounts', () => ({
  default: () => ({ accounts: [], status: accountsStatus, error: '', reason: '' }),
}));

// Every panel is a stub: this file is about which one the page mounts and with
// what, not about what any of them renders.
vi.mock('@/components/admin/social/ComposeTab', () => ({
  default: ({ contentId }) => <div data-testid="panel-compose">compose:{contentId}</div>,
}));
vi.mock('@/components/admin/social/QueueTab', () => ({
  default: () => <div data-testid="panel-queue">queue</div>,
}));
vi.mock('@/components/admin/social/PublishedTab', () => ({
  default: () => <div data-testid="panel-published">published</div>,
}));
vi.mock('@/components/admin/social/AccountsTab', () => ({
  default: () => <div data-testid="panel-accounts">accounts</div>,
}));
vi.mock('@/components/admin/social/SettingsTab', () => ({
  default: () => <div data-testid="panel-settings">settings</div>,
}));

/** The hub's own tab bar. */
const hubTabs = () => screen.getByRole('tablist', { name: 'Social Hub' });
const selectedTab = () =>
  within(hubTabs())
    .getAllByRole('tab')
    .find((tab) => tab.getAttribute('aria-selected') === 'true');

beforeEach(() => {
  searchParams = '';
  accountsStatus = 'ready';
  setSearchParams.mockReset();
});

describe('which panel the page shows', () => {
  it('opens on Compose when there is no ?tab=', () => {
    render(<SocialHubPage />);
    expect(screen.getByTestId('panel-compose')).toBeTruthy();
    expect(selectedTab().textContent).toBe('Compose');
  });

  it('shows the tab a deep link names', () => {
    searchParams = 'tab=queue';
    render(<SocialHubPage />);
    expect(screen.getByTestId('panel-queue')).toBeTruthy();
    expect(selectedTab().textContent).toBe('Queue');
  });

  it('sends an old address to where its content went', () => {
    // `connection` was the word on the old tab bar ("Connection Settings").
    searchParams = 'tab=connection';
    render(<SocialHubPage />);
    expect(screen.getByTestId('panel-settings')).toBeTruthy();
  });

  it('shows Compose for an unknown tab rather than a header with nothing under it', () => {
    // The old page tested `activeTab === '...'` four times over an unvalidated
    // `searchParams.get('tab')`, so an unknown id rendered no panel at all.
    searchParams = 'tab=nope';
    render(<SocialHubPage />);
    expect(screen.getByTestId('panel-compose')).toBeTruthy();
  });

  it('hands Compose the ?contentId= a publish-flow deep link carries', () => {
    searchParams = 'tab=compose&contentId=article-7';
    render(<SocialHubPage />);
    expect(screen.getByTestId('panel-compose').textContent).toBe('compose:article-7');
  });

  it('has one panel per tab, so no tab is a dead end', () => {
    for (const [tab, panel] of [
      ['compose', 'panel-compose'],
      ['queue', 'panel-queue'],
      ['published', 'panel-published'],
      ['accounts', 'panel-accounts'],
      ['settings', 'panel-settings'],
    ]) {
      searchParams = `tab=${tab}`;
      const { unmount } = render(<SocialHubPage />);
      expect(screen.getByTestId(panel)).toBeTruthy();
      unmount();
    }
  });
});

describe('the tab bar', () => {
  it('puts the selected tab in the URL rather than in local state', () => {
    render(<SocialHubPage />);
    fireEvent.click(within(hubTabs()).getByRole('tab', { name: 'Accounts' }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: 'accounts' });
  });

  it('does not rewrite the URL when the selected tab is clicked again', () => {
    // A no-op push would still be a history entry, so Back would appear stuck.
    searchParams = 'tab=queue';
    render(<SocialHubPage />);
    fireEvent.click(within(hubTabs()).getByRole('tab', { name: 'Queue' }));
    expect(setSearchParams).not.toHaveBeenCalled();
  });

  it('names Publer in the page header', () => {
    // The Newsletter Hub standard: the provider is named on the page, not left
    // to the sidebar.
    render(<SocialHubPage />);
    expect(screen.getAllByText(/Publer/).length).toBeGreaterThan(0);
  });
});

describe('the header connection state', () => {
  it('is the accounts call’s answer, never a constant (ADR 0033 §1 Amplify)', () => {
    render(<SocialHubPage />);
    expect(screen.getByText('Publer connected')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });

  it('says not connected when the proxy has no key, and unreachable when the call failed', () => {
    accountsStatus = 'not_configured';
    const { unmount } = render(<SocialHubPage />);
    expect(screen.getByText(/Publer not connected/)).toBeInTheDocument();
    expect(screen.getByText('Critical')).toBeInTheDocument();
    unmount();
    accountsStatus = 'error';
    render(<SocialHubPage />);
    expect(screen.getByText('Publer could not be reached')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });
});
