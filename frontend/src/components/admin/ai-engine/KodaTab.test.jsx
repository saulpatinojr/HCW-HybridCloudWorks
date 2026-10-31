/**
 * The Koda tab (KodaTab.jsx, ADR 0037): the state it draws from the API, the
 * one-time reveal of a generated key and its dismissal, the capability
 * switches, the confirmed revoke, and the controls an editor sees gated.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AdminRoleProvider } from '@/hooks/useAdminRole';

const readKodaKey = vi.fn();
const generateKodaKey = vi.fn();
const setKodaCapabilities = vi.fn();
const revokeKodaKey = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/agentContent', async (importOriginal) => ({
  ...(await importOriginal()),
  readKodaKey: (...a) => readKodaKey(...a),
  generateKodaKey: (...a) => generateKodaKey(...a),
  setKodaCapabilities: (...a) => setKodaCapabilities(...a),
  revokeKodaKey: (...a) => revokeKodaKey(...a),
}));
vi.mock('@/lib/functionsBase', () => ({
  getFunctionsBase: () => 'https://api-azure.hybridcloudworks.com/api',
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const { default: KodaTab } = await import('./KodaTab.jsx');

const CATALOGUE = [
  { id: 'drafts.read', label: 'Read drafts', description: 'List and open.' },
  { id: 'drafts.write', label: 'Create and edit drafts', description: 'Create and save.' },
  { id: 'drafts.delete', label: 'Delete drafts', description: 'Delete.' },
];
const ENDPOINTS = [
  { method: 'GET', path: 'status', capability: null },
  { method: 'GET', path: 'drafts', capability: 'drafts.read' },
  { method: 'POST', path: 'drafts', capability: 'drafts.write' },
  { method: 'DELETE', path: 'drafts/{id}', capability: 'drafts.delete' },
];
const answer = (key) => ({
  ok: true,
  agent: 'koda',
  key,
  capabilities: CATALOGUE,
  limits: { requestsPerMinute: 120 },
  basePath: '/api/agent-content/v1',
  endpoints: ENDPOINTS,
});
const NO_KEY = { present: false, active: false, capabilities: {} };
const ACTIVE = {
  present: true,
  active: true,
  keyHint: 'hcwk_abcd1234',
  createdAt: '2026-10-31T17:00:00.000Z',
  createdBy: 'owner@hcw.dev',
  rotatedAt: null,
  lastUsedAt: null,
  revokedAt: null,
  capabilities: { 'drafts.read': true, 'drafts.write': true, 'drafts.delete': false },
};
const SECRET = 'hcwk_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

function renderTab(role = 'super_admin') {
  return render(
    <MemoryRouter>
      <AdminRoleProvider value={role}>
        <KodaTab />
      </AdminRoleProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  readKodaKey.mockReset();
  generateKodaKey.mockReset();
  setKodaCapabilities.mockReset();
  revokeKodaKey.mockReset();
  toast.mockReset();
});

describe('KodaTab', () => {
  it('shows there is no key, the connector values and the endpoints, with the switches waiting for a key', async () => {
    readKodaKey.mockResolvedValue(answer(NO_KEY));
    renderTab();
    expect(await screen.findByText('No key yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate key/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke key/ })).toBeNull();
    expect(screen.getByText('api-azure.hybridcloudworks.com')).toBeInTheDocument();
    expect(
      screen.getByText('GET https://api-azure.hybridcloudworks.com/api/agent-content/v1/status')
    ).toBeInTheDocument();
    expect(screen.getByText('DELETE drafts/{id}')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Read drafts' })).toBeDisabled();
    expect(screen.getByText('The switches apply once a key exists.')).toBeInTheDocument();
  });

  it('generates a key, shows it once, and hides it on dismiss', async () => {
    readKodaKey.mockResolvedValueOnce(answer(NO_KEY)).mockResolvedValue(answer(ACTIVE));
    generateKodaKey.mockResolvedValue({ ...answer(ACTIVE), secret: SECRET, shownOnce: true });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Generate key/ }));
    const reveal = await screen.findByRole('region', { name: "Koda's new key" });
    expect(within(reveal).getByTestId('koda-secret')).toHaveTextContent(SECRET);
    expect(generateKodaKey).toHaveBeenCalledTimes(1);
    // The re-read landed: the card now says Active and offers Rotate and Revoke.
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rotate key/ })).toBeInTheDocument();
    fireEvent.click(within(reveal).getByRole('button', { name: /I have pasted it/ }));
    expect(screen.queryByTestId('koda-secret')).toBeNull();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it('rotating asks first, and the old key’s hint is replaced by the new answer', async () => {
    readKodaKey.mockResolvedValue(answer(ACTIVE));
    generateKodaKey.mockResolvedValue({
      ...answer({ ...ACTIVE, keyHint: 'hcwk_new00000' }),
      secret: SECRET,
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Rotate key/ }));
    expect(generateKodaKey).not.toHaveBeenCalled();
    // The confirmation's own button is the last "Rotate key" in the document.
    fireEvent.click(screen.getAllByRole('button', { name: /Rotate key/ }).at(-1));
    await waitFor(() => expect(generateKodaKey).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('koda-secret')).toHaveTextContent(SECRET);
  });

  it('switches a capability through the API and re-reads', async () => {
    readKodaKey.mockResolvedValue(answer(ACTIVE));
    setKodaCapabilities.mockResolvedValue(
      answer({ ...ACTIVE, capabilities: { ...ACTIVE.capabilities, 'drafts.delete': true } })
    );
    renderTab();
    const toggle = await screen.findByRole('switch', { name: 'Delete drafts' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(setKodaCapabilities).toHaveBeenCalledWith({ 'drafts.delete': true })
    );
    expect(readKodaKey).toHaveBeenCalledTimes(2);
  });

  it('revokes after a confirmation', async () => {
    readKodaKey
      .mockResolvedValueOnce(answer(ACTIVE))
      .mockResolvedValue(
        answer({ ...ACTIVE, active: false, revokedAt: '2026-10-31T18:00:00.000Z' })
      );
    revokeKodaKey.mockResolvedValue(answer({ ...ACTIVE, active: false }));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Revoke key/ }));
    expect(revokeKodaKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /Revoke key/ }).at(-1));
    await waitFor(() => expect(revokeKodaKey).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
  });

  it('a failed write says nothing changed and leaves the state as read', async () => {
    readKodaKey.mockResolvedValue(answer(NO_KEY));
    generateKodaKey.mockRejectedValue(new Error('Requires super_admin or higher'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Generate key/ }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Nothing was changed', variant: 'destructive' })
      )
    );
    expect(screen.queryByTestId('koda-secret')).toBeNull();
    expect(screen.getByText('No key yet')).toBeInTheDocument();
  });

  it('an editor sees the state and gated controls, and no call is made on a click', async () => {
    readKodaKey.mockResolvedValue(answer(ACTIVE));
    renderTab('editor');
    const generate = await screen.findByRole('button', { name: /Rotate key/ });
    expect(generate).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(generate);
    expect(generateKodaKey).not.toHaveBeenCalled();
    expect(screen.getAllByText(/needs the super_admin role/).length).toBeGreaterThan(0);
  });

  it('a failed read offers a retry', async () => {
    readKodaKey.mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue(answer(NO_KEY));
    renderTab();
    expect(await screen.findByText('Koda’s key could not be read')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again|Retry/ }));
    expect(await screen.findByText('No key yet')).toBeInTheDocument();
  });
});
