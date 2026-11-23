/**
 * The Developer API tab (DeveloperApiTab.jsx, ADR 0042): the list it draws
 * from the API, making a key and its one-time reveal, the confirmed rotate
 * and revoke, re-scoping, and the controls an editor sees gated.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AdminRoleProvider } from '@/hooks/useAdminRole';

const listDeveloperKeys = vi.fn();
const createDeveloperKey = vi.fn();
const rotateDeveloperKey = vi.fn();
const updateDeveloperKey = vi.fn();
const revokeDeveloperKey = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/developerApi', async (importOriginal) => ({
  ...(await importOriginal()),
  listDeveloperKeys: (...a) => listDeveloperKeys(...a),
  createDeveloperKey: (...a) => createDeveloperKey(...a),
  rotateDeveloperKey: (...a) => rotateDeveloperKey(...a),
  updateDeveloperKey: (...a) => updateDeveloperKey(...a),
  revokeDeveloperKey: (...a) => revokeDeveloperKey(...a),
}));
vi.mock('@/lib/functionsBase', () => ({
  getFunctionsBase: () => 'https://api-azure.hybridcloudworks.com/api',
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const { default: DeveloperApiTab } = await import('./DeveloperApiTab.jsx');

const SCOPES = [
  { id: 'events:read', label: 'Read events', description: 'Read.' },
  { id: 'events:write', label: 'Create and edit events', description: 'Write.' },
  { id: 'cfs:manage', label: 'Manage calls for speakers', description: 'CfS.' },
];
const ENDPOINTS = [
  { method: 'GET', path: 'status', who: 'key' },
  { method: 'GET', path: 'published-events', who: 'public' },
  { method: 'GET', path: 'events/{eventId}/call-for-speakers/submissions', who: 'cfs:manage' },
];
const ID = '0123456789abcdef';
const ACTIVE = {
  keyId: ID,
  organizerName: 'Cloud Day',
  organizerContact: 'team@example.org',
  scopes: ['events:read', 'cfs:manage'],
  active: true,
  keyHint: 'hcdk_0123456789abcdef_abcdefgh',
  createdAt: '2026-11-20T17:00:00.000Z',
  createdBy: 'owner@hcw.dev',
  rotatedAt: null,
  rotatedBy: null,
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
};
const REVOKED = {
  ...ACTIVE,
  active: false,
  revokedAt: '2026-11-21T10:00:00.000Z',
  revokedBy: 'owner@hcw.dev',
};
const answer = (keys) => ({
  ok: true,
  keys,
  scopes: SCOPES,
  limits: { keyedRequestsPerMinute: 120 },
  basePath: '/api/developer/v1',
  endpoints: ENDPOINTS,
});
const SECRET = 'hcdk_0123456789abcdef_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

function renderTab(role = 'super_admin') {
  return render(
    <MemoryRouter>
      <AdminRoleProvider value={role}>
        <DeveloperApiTab />
      </AdminRoleProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  for (const fn of [
    listDeveloperKeys,
    createDeveloperKey,
    rotateDeveloperKey,
    updateDeveloperKey,
    revokeDeveloperKey,
    toast,
  ]) {
    fn.mockReset();
  }
});

describe('DeveloperApiTab', () => {
  it('with no keys, says so and shows the base URL, the endpoints and that no key publishes', async () => {
    listDeveloperKeys.mockResolvedValue(answer([]));
    renderTab();
    expect(await screen.findByText(/No organizer keys yet/)).toBeInTheDocument();
    expect(
      screen.getByText('https://api-azure.hybridcloudworks.com/api/developer/v1')
    ).toBeInTheDocument();
    expect(
      screen.getByText('GET https://api-azure.hybridcloudworks.com/api/developer/v1/status')
    ).toBeInTheDocument();
    expect(screen.getByText('GET published-events')).toBeInTheDocument();
    expect(screen.getByText('Anyone, no key needed')).toBeInTheDocument();
    expect(screen.getByText('A key with “Manage calls for speakers”')).toBeInTheDocument();
    expect(screen.getByText(/No key can publish anything/)).toBeInTheDocument();
  });

  it('refuses to make a key without a name or a scope, before any call', async () => {
    listDeveloperKeys.mockResolvedValue(answer([]));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Make key/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Give the organizer’s name.');
    fireEvent.change(screen.getByLabelText('Organizer name'), { target: { value: 'Cloud Day' } });
    fireEvent.click(screen.getByRole('button', { name: /Make key/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one/);
    expect(createDeveloperKey).not.toHaveBeenCalled();
  });

  it('makes a key, shows it once, and hides it on dismiss', async () => {
    listDeveloperKeys.mockResolvedValueOnce(answer([])).mockResolvedValue(answer([ACTIVE]));
    createDeveloperKey.mockResolvedValue({
      ok: true,
      key: ACTIVE,
      secret: SECRET,
      shownOnce: true,
    });
    renderTab();
    fireEvent.change(await screen.findByLabelText('Organizer name'), {
      target: { value: ' Cloud Day ' },
    });
    fireEvent.change(screen.getByLabelText(/Contact \(optional/), {
      target: { value: 'team@example.org' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Manage calls for speakers' }));
    fireEvent.click(screen.getByRole('button', { name: /Make key/ }));
    await waitFor(() =>
      expect(createDeveloperKey).toHaveBeenCalledWith({
        organizerName: 'Cloud Day',
        organizerContact: 'team@example.org',
        scopes: ['cfs:manage'],
      })
    );
    const reveal = await screen.findByRole('region', { name: "The organizer's new key" });
    expect(within(reveal).getByTestId('developer-secret')).toHaveTextContent(SECRET);
    expect(within(reveal).getByText(/new key for Cloud Day/)).toBeInTheDocument();
    // The re-read landed: the list now shows the key.
    expect(await screen.findByRole('listitem', { name: 'Key for Cloud Day' })).toBeInTheDocument();
    // The secret never reaches a toast.
    expect(JSON.stringify(toast.mock.calls)).not.toContain(SECRET);
    fireEvent.click(within(reveal).getByRole('button', { name: /I have handed it over/ }));
    expect(screen.queryByTestId('developer-secret')).toBeNull();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it('rotating asks first, says the old key stops at once, then shows the new key', async () => {
    listDeveloperKeys.mockResolvedValue(answer([ACTIVE]));
    rotateDeveloperKey.mockResolvedValue({
      ok: true,
      key: ACTIVE,
      secret: SECRET,
      shownOnce: true,
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Rotate key/ }));
    expect(rotateDeveloperKey).not.toHaveBeenCalled();
    expect(screen.getByText(/stops working straight away/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Rotate key/ }).at(-1));
    await waitFor(() => expect(rotateDeveloperKey).toHaveBeenCalledWith(ID));
    expect(await screen.findByTestId('developer-secret')).toHaveTextContent(SECRET);
  });

  it('revokes after a confirmation', async () => {
    listDeveloperKeys.mockResolvedValueOnce(answer([ACTIVE])).mockResolvedValue(answer([REVOKED]));
    revokeDeveloperKey.mockResolvedValue({ ok: true, key: REVOKED });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Revoke key/ }));
    expect(revokeDeveloperKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /Revoke key/ }).at(-1));
    await waitFor(() => expect(revokeDeveloperKey).toHaveBeenCalledWith(ID));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Make a new key/ })).toBeInTheDocument();
  });

  it('makes a new key for a revoked organizer instead of rotating the revoked one', async () => {
    listDeveloperKeys.mockResolvedValue(answer([REVOKED]));
    createDeveloperKey.mockResolvedValue({
      ok: true,
      key: { ...ACTIVE, keyId: 'fedcba9876543210' },
      secret: 'hcdk_fedcba9876543210_newsecret',
      shownOnce: true,
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Make a new key/ }));
    await waitFor(() =>
      expect(createDeveloperKey).toHaveBeenCalledWith({
        organizerName: 'Cloud Day',
        organizerContact: 'team@example.org',
        scopes: ['events:read', 'cfs:manage'],
      })
    );
    expect(rotateDeveloperKey).not.toHaveBeenCalled();
  });

  it('switches a scope through the API with the whole list, and keeps the last scope on', async () => {
    listDeveloperKeys.mockResolvedValue(answer([ACTIVE]));
    updateDeveloperKey.mockResolvedValue({ ok: true, key: ACTIVE });
    renderTab();
    const row = await screen.findByRole('listitem', { name: 'Key for Cloud Day' });
    fireEvent.click(within(row).getByRole('switch', { name: 'Create and edit events' }));
    await waitFor(() =>
      expect(updateDeveloperKey).toHaveBeenCalledWith(ID, {
        scopes: ['events:read', 'events:write', 'cfs:manage'],
      })
    );
    expect(listDeveloperKeys).toHaveBeenCalledTimes(2);
  });

  it('cannot switch off a key’s only scope', async () => {
    listDeveloperKeys.mockResolvedValue(answer([{ ...ACTIVE, scopes: ['cfs:manage'] }]));
    renderTab();
    const row = await screen.findByRole('listitem', { name: 'Key for Cloud Day' });
    expect(within(row).getByRole('switch', { name: 'Manage calls for speakers' })).toBeDisabled();
    expect(within(row).getByText(/needs at least one scope/)).toBeInTheDocument();
  });

  it('edits the organizer name and contact', async () => {
    listDeveloperKeys.mockResolvedValue(answer([ACTIVE]));
    updateDeveloperKey.mockResolvedValue({ ok: true, key: ACTIVE });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Edit name or contact/ }));
    const row = screen.getByRole('listitem', { name: 'Key for Cloud Day' });
    fireEvent.change(within(row).getByLabelText('Organizer name'), {
      target: { value: 'Cloud Day 2027' },
    });
    fireEvent.change(within(row).getByLabelText('Contact'), { target: { value: '' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateDeveloperKey).toHaveBeenCalledWith(ID, {
        organizerName: 'Cloud Day 2027',
        organizerContact: null,
      })
    );
  });

  it('a failed write says nothing changed and shows no key', async () => {
    listDeveloperKeys.mockResolvedValue(answer([ACTIVE]));
    rotateDeveloperKey.mockRejectedValue(new Error('Requires super_admin or higher'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Rotate key/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /Rotate key/ }).at(-1));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Nothing was changed', variant: 'destructive' })
      )
    );
    expect(screen.queryByTestId('developer-secret')).toBeNull();
  });

  it('a make whose re-read fails still shows the key once, and says the list may be stale', async () => {
    listDeveloperKeys.mockResolvedValueOnce(answer([])).mockRejectedValue(new Error('HTTP 503'));
    createDeveloperKey.mockResolvedValue({
      ok: true,
      key: ACTIVE,
      secret: SECRET,
      shownOnce: true,
    });
    renderTab();
    fireEvent.change(await screen.findByLabelText('Organizer name'), {
      target: { value: 'Cloud Day' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Read events' }));
    fireEvent.click(screen.getByRole('button', { name: /Make key/ }));
    expect(await screen.findByTestId('developer-secret')).toHaveTextContent(SECRET);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Saved, but the list could not be re-read' })
      )
    );
  });

  it('an editor sees the list and gated controls, and no call is made on a click', async () => {
    listDeveloperKeys.mockResolvedValue(answer([ACTIVE]));
    renderTab('editor');
    const rotate = await screen.findByRole('button', { name: /Rotate key/ });
    expect(rotate).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(rotate);
    const make = screen.getByRole('button', { name: /Make key/ });
    expect(make).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(make);
    expect(rotateDeveloperKey).not.toHaveBeenCalled();
    expect(createDeveloperKey).not.toHaveBeenCalled();
    expect(screen.getAllByText(/needs the super_admin role/).length).toBeGreaterThan(0);
  });

  it('a failed read offers a retry', async () => {
    listDeveloperKeys.mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue(answer([]));
    renderTab();
    expect(await screen.findByText('The organizer keys could not be read')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again|Retry/ }));
    expect(await screen.findByText(/No organizer keys yet/)).toBeInTheDocument();
  });
});
