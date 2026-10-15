/**
 * The Certifications Hub page (#572). What must hold: `?tab=` picks the tab
 * and the old view ids land where their content went; a tab click writes the
 * URL; the list failing is an error on the tabs that show it while Publishing
 * carries on, and the snapshot failing never touches the others; and every
 * behaviour the one-scroll page had — stats, search, issuer filter, show/hide,
 * feature, delete with confirmation, add — is still reachable.
 *
 * The helpers, hooks and editor are tested beside them in
 * components/admin/certifications.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

import CertificationsPage from './CertificationsPage';

const getJSON = vi.fn();
const postJSON = vi.fn();
const sendJSON = vi.fn();
const fetchPublicSnapshot = vi.fn();
const setSearchParams = vi.fn();
let searchParams = '';

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/lib/publicApi', () => ({
  fetchPublicSnapshot: (...args) => fetchPublicSnapshot(...args),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-router', () => ({
  useSearchParams: () => [new URLSearchParams(searchParams), setSearchParams],
  // The header reads the route for its title (the registry's label).
  useLocation: () => ({ pathname: '/admin/certifications', search: '' }),
}));

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

const ITEMS = [
  {
    id: 'az',
    name: 'Azure Administrator',
    code: 'AZ-104',
    issuer: 'Microsoft',
    display: true,
    featured: true,
    certState: true,
    display_order: 1,
    expDate: inDays(30),
  },
  {
    id: 'saa',
    name: 'Solutions Architect',
    issuer: 'AWS',
    display: true,
    certState: true,
    display_order: 2,
  },
  {
    id: 'tf',
    name: 'Terraform Associate',
    issuer: 'HashiCorp',
    display: false,
    certState: false,
    display_order: 3,
    expDate: inDays(-5),
  },
];

const SNAPSHOT = {
  generatedAt: '2026-09-01T12:00:00Z',
  items: [{ id: 'az', name: 'Azure Administrator', code: 'AZ-104', issuer: 'Microsoft' }],
};

const hubTabs = () => within(screen.getByRole('tablist', { name: 'Certifications Hub' }));
const selectedTab = () => hubTabs().getByRole('tab', { selected: true }).textContent;
const panel = () => within(screen.getByRole('tabpanel'));
const cardFor = (name) => screen.getByText(name).closest('[data-testid="cert-card"]');

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  searchParams = '';
  setSearchParams.mockReset();
  getJSON.mockReset().mockImplementation(async (route) => {
    if (route === 'cms/certifications') return { items: ITEMS };
    throw new Error(`unexpected route ${route}`);
  });
  postJSON.mockReset();
  sendJSON.mockReset().mockResolvedValue({ success: true });
  fetchPublicSnapshot.mockReset().mockResolvedValue(SNAPSHOT);
});

describe('the header and tabs', () => {
  it('names the hub and its provider, and opens Catalog by default', async () => {
    render(<CertificationsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Certifications' })).toBeInTheDocument();
    expect(await screen.findByText('Cosmos DB connected')).toBeInTheDocument();
    // Update Cert Catalog is in the header, beside the Powered-by pill, on
    // every tab — not inside a panel (owner request 2026-10-05).
    const button = screen.getByRole('button', { name: 'Update Cert Catalog' });
    expect(button).toBeInTheDocument();
    expect(screen.getByText('Powered by Cosmos DB').parentElement).toContainElement(button);
    expect(panel().queryByRole('button', { name: /Update Cert Catalog/ })).toBeNull();
    expect(
      hubTabs()
        .getAllByRole('tab')
        .map((t) => t.textContent)
    ).toEqual(['Catalog', 'Featured', 'Renewals', 'Publishing', 'Settings']);
    expect(selectedTab()).toBe('Catalog');
  });

  it('writes the tab to the URL on click, and not for the tab already open', () => {
    const { rerender } = render(<CertificationsPage />);
    // Catalog is open: clicking it again writes nothing.
    fireEvent.click(hubTabs().getByRole('tab', { name: 'Catalog' }));
    expect(setSearchParams).not.toHaveBeenCalled();
    fireEvent.click(hubTabs().getByRole('tab', { name: 'Renewals' }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: 'renewals' });

    // Land the URL write, as the router would, so Renewals is the open tab.
    searchParams = 'tab=renewals';
    setSearchParams.mockReset();
    rerender(<CertificationsPage />);
    expect(selectedTab()).toBe('Renewals');
    fireEvent.click(hubTabs().getByRole('tab', { name: 'Renewals' }));
    expect(setSearchParams).not.toHaveBeenCalled();
    // And switching back to Catalog from there does write.
    fireEvent.click(hubTabs().getByRole('tab', { name: 'Catalog' }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: 'catalog' });
  });

  it.each([
    ['all', 'Catalog'],
    ['featured', 'Featured'],
    ['expiring', 'Renewals'],
    ['hidden', 'Settings'],
    ['publish', 'Publishing'],
    ['constructor', 'Catalog'],
  ])('deep link ?tab=%s opens %s', (tab, label) => {
    searchParams = `tab=${tab}`;
    render(<CertificationsPage />);
    expect(selectedTab()).toBe(label);
  });
});

describe('Catalog', () => {
  it('shows the stats and filters by search and issuer', async () => {
    render(<CertificationsPage />);
    await screen.findByText('Azure Administrator');
    const stats = within(screen.getByRole('group', { name: 'Catalog stats' }));
    expect(stats.getByText('Total').nextSibling.textContent).toBe('3');
    expect(stats.getByText('Showing').nextSibling.textContent).toBe('2');
    expect(stats.getByText('Expiring 90d').nextSibling.textContent).toBe('1');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'az-104' } });
    expect(screen.getAllByTestId('cert-card')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Issuer'), { target: { value: 'AWS' } });
    expect(screen.getAllByTestId('cert-card')).toHaveLength(1);
    expect(screen.getByText('Solutions Architect')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz' } });
    expect(screen.getByText('No certifications match these filters.')).toBeInTheDocument();
  });

  it('hides and features a cert through PATCH', async () => {
    render(<CertificationsPage />);
    await screen.findByText('Solutions Architect');
    const card = within(cardFor('Solutions Architect'));
    await act(async () => {
      fireEvent.click(card.getByTitle('Hide from About page'));
    });
    expect(sendJSON).toHaveBeenCalledWith('cms/certifications/saa', 'PATCH', { display: false });
    expect(await card.findByText('Hidden')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(card.getByTitle('Feature'));
    });
    expect(sendJSON).toHaveBeenCalledWith('cms/certifications/saa', 'PATCH', { featured: true });
  });

  it('deletes only after confirmation', async () => {
    render(<CertificationsPage />);
    await screen.findByText('Solutions Architect');
    fireEvent.click(within(cardFor('Solutions Architect')).getByTitle('Delete'));
    const dialog = within(screen.getByRole('alertdialog'));
    expect(sendJSON).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: 'Delete' }));
    });
    expect(sendJSON).toHaveBeenCalledWith('cms/certifications/saa', 'DELETE');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Solutions Architect')).not.toBeInTheDocument();
  });

  it('keeps the confirmation open when the delete is refused, so it can be retried', async () => {
    sendJSON.mockRejectedValueOnce(new Error('refused'));
    render(<CertificationsPage />);
    await screen.findByText('Solutions Architect');
    fireEvent.click(within(cardFor('Solutions Architect')).getByTitle('Delete'));
    const dialog = within(screen.getByRole('alertdialog'));
    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: 'Delete' }));
    });
    expect(sendJSON).toHaveBeenCalledWith('cms/certifications/saa', 'DELETE');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getAllByText('Solutions Architect').length).toBeGreaterThan(0);
  });

  it('opens the editor for a new cert and for an existing one', async () => {
    render(<CertificationsPage />);
    await screen.findByText('Azure Administrator');
    fireEvent.click(screen.getByRole('button', { name: /Add cert/ }));
    expect(screen.getByRole('heading', { name: 'Add Certification' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(cardFor('Azure Administrator')).getByRole('button', { name: /Edit/ }));
    expect(screen.getByRole('heading', { name: 'Edit Certification' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('AZ-104')).toBeInTheDocument();
  });
});

describe('the duty tabs', () => {
  it('Featured lists only featured certs', async () => {
    searchParams = 'tab=featured';
    render(<CertificationsPage />);
    await screen.findByText('Azure Administrator');
    expect(panel().getAllByTestId('cert-card')).toHaveLength(1);
  });

  it('Renewals lists an expiring and an expired cert with due dates', async () => {
    searchParams = 'tab=renewals';
    render(<CertificationsPage />);
    await screen.findByText('Azure Administrator');
    expect(panel().getAllByTestId('cert-card')).toHaveLength(2);
    expect(panel().getByText(/days? left/)).toBeInTheDocument();
    expect(panel().getByText(/days? ago/)).toBeInTheDocument();
    expect(panel().getByText('Marked inactive')).toBeInTheDocument();
    expect(panel().getByText('1 expired · 1 expiring')).toBeInTheDocument();
  });

  it('Settings shows image rules, verification sources and the hidden list', async () => {
    searchParams = 'tab=settings';
    render(<CertificationsPage />);
    expect(await panel().findByText(/Hidden from the About page \(1\)/)).toBeInTheDocument();
    expect(panel().getByText('Image rules')).toBeInTheDocument();
    expect(panel().getByText('No verify URL (3)')).toBeInTheDocument();
    expect(panel().getByText('Terraform Associate')).toBeInTheDocument();
  });

  it('Publishing shows the last publish and what changed since, and re-reads after a publish', async () => {
    searchParams = 'tab=publishing';
    postJSON.mockResolvedValue({ certifications: 2, speakerevents: 0, generatedAt: 'now' });
    const { rerender } = render(<CertificationsPage />);
    expect(await panel().findByText('Not yet public (1)')).toBeInTheDocument();
    expect(panel().getByText('Solutions Architect · AWS')).toBeInTheDocument();
    expect(fetchPublicSnapshot).toHaveBeenCalledWith('certifications', { fresh: false });

    // The button is the header's, not the tab's; the tab still re-reads.
    expect(
      panel().queryByRole('button', { name: /Publish snapshot|Update Cert Catalog/ })
    ).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update Cert Catalog' }));
    });
    expect(postJSON).toHaveBeenCalledWith('publishSnapshot', {});
    await waitFor(() =>
      expect(fetchPublicSnapshot).toHaveBeenLastCalledWith('certifications', { fresh: true })
    );
    expect(fetchPublicSnapshot).toHaveBeenCalledTimes(2);

    // Leave and come back (the URL write landed, as the router would): one
    // read, fresh — not a cached read plus a refresh.
    fetchPublicSnapshot.mockClear();
    searchParams = 'tab=catalog';
    rerender(<CertificationsPage />);
    expect(selectedTab()).toBe('Catalog');
    searchParams = 'tab=publishing';
    rerender(<CertificationsPage />);
    await waitFor(() => expect(fetchPublicSnapshot).toHaveBeenCalledTimes(1));
    expect(fetchPublicSnapshot).toHaveBeenLastCalledWith('certifications', { fresh: true });
  });
});

describe('each tab fails on its own', () => {
  it('a refused list is an error on Catalog with Try again, and the tab bar stays', async () => {
    getJSON.mockRejectedValueOnce(new Error('list refused'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<CertificationsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('list refused');
    expect(screen.getByRole('tablist', { name: 'Certifications Hub' })).toBeInTheDocument();
    expect(screen.getByText('Cosmos DB disconnected')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: /Try again/ }));
    });
    expect(await screen.findByText('Azure Administrator')).toBeInTheDocument();
    expect(fetchPublicSnapshot).not.toHaveBeenCalled();
  });

  it('a refused list leaves Publishing showing the snapshot', async () => {
    searchParams = 'tab=publishing';
    getJSON.mockRejectedValue(new Error('list refused'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<CertificationsPage />);
    expect(await panel().findByText('Certifications on the About page')).toBeInTheDocument();
    expect(panel().getByText('1')).toBeInTheDocument();
    expect((await panel().findByRole('alert')).textContent).toContain('list refused');
  });

  it('a refused snapshot is an error on Publishing only', async () => {
    searchParams = 'tab=publishing';
    fetchPublicSnapshot.mockRejectedValue(new Error('snapshot refused'));
    const { unmount } = render(<CertificationsPage />);
    expect((await panel().findByRole('alert')).textContent).toContain('snapshot refused');
    // The changes card names the failure and can retry, instead of a generic line.
    expect(
      panel().getByText(/Can.t compare until the public snapshot is read: snapshot refused/)
    ).toBeInTheDocument();
    expect(panel().queryByText('Needs the public snapshot.')).not.toBeInTheDocument();
    fetchPublicSnapshot.mockResolvedValue(SNAPSHOT);
    const retries = panel().getAllByRole('button', { name: /Try again/ });
    expect(retries).toHaveLength(2);
    await act(async () => {
      fireEvent.click(retries[1]);
    });
    expect(await panel().findByText('Certifications on the About page')).toBeInTheDocument();
    unmount();

    searchParams = 'tab=catalog';
    render(<CertificationsPage />);
    expect(await screen.findByText('Azure Administrator')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
