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
const { agentKeyTab } = await import('./agentKeys');

const CATALOGUE = [
  { id: 'drafts.read', label: 'Read drafts', description: 'List and open.' },
  { id: 'drafts.write', label: 'Create and edit drafts', description: 'Create and save.' },
  { id: 'drafts.review', label: 'Send to review and back', description: 'Review.' },
];
const ENDPOINTS = [
  { method: 'GET', path: 'status', capability: null },
  { method: 'GET', path: 'drafts', capability: 'drafts.read' },
  { method: 'POST', path: 'drafts', capability: 'drafts.write' },
  { method: 'POST', path: 'drafts/{id}/send-to-review', capability: 'drafts.review' },
];
const ADMIN_ACCESS = [
  {
    id: 'admin.pipeline',
    label: 'Pipeline',
    on: true,
    routes: [
      { method: 'GET', path: '/api/cms/content' },
      {
        method: 'POST',
        path: '/api/transitionContentStatus',
        limit: 'newStatus must be one of approved, editing',
      },
    ],
  },
  {
    id: 'admin.brain',
    label: 'Second Brain',
    on: false,
    routes: [{ method: 'POST', path: '/api/cms/brain/items' }],
  },
];
const answer = (key) => ({
  ok: true,
  agent: 'koda',
  key,
  capabilities: CATALOGUE,
  limits: { requestsPerMinute: 120 },
  basePath: '/api/agent-content/v1',
  endpoints: ENDPOINTS,
  adminAccess: ADMIN_ACCESS,
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
  capabilities: { 'drafts.read': true, 'drafts.write': true, 'drafts.review': false },
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
    expect(screen.getByText('POST drafts/{id}/send-to-review')).toBeInTheDocument();
    // The admin routes the key may call, per section, with the section's switch state and a body limit.
    expect(screen.getByText('What Koda may do in the admin')).toBeInTheDocument();
    expect(screen.getByText('Second Brain (off)')).toBeInTheDocument();
    expect(screen.getByText(/POST \/api\/transitionContentStatus/)).toBeInTheDocument();
    expect(screen.getByText('(newStatus must be one of approved, editing)')).toBeInTheDocument();
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
      answer({ ...ACTIVE, capabilities: { ...ACTIVE.capabilities, 'drafts.review': true } })
    );
    renderTab();
    const toggle = await screen.findByRole('switch', { name: 'Send to review and back' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(setKodaCapabilities).toHaveBeenCalledWith({ 'drafts.review': true })
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

  it('a generate whose re-read fails still shows the key once, and says the card may be stale', async () => {
    readKodaKey.mockResolvedValueOnce(answer(NO_KEY)).mockRejectedValue(new Error('HTTP 503'));
    generateKodaKey.mockResolvedValue({ ...answer(ACTIVE), secret: SECRET, shownOnce: true });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Generate key/ }));
    expect(await screen.findByTestId('koda-secret')).toHaveTextContent(SECRET);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Saved, but the card could not be re-read' })
      )
    );
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Nothing was changed' })
    );
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

describe('KodaTab for another agent key', () => {
  const SECOND = agentKeyTab('claude');
  const OFF = { 'drafts.read': false, 'drafts.write': false, 'drafts.review': false };
  const MADE = { 'drafts.read': true, 'drafts.write': true, 'drafts.review': false };
  const second = (key) => ({
    ...answer(key),
    agent: 'claude',
    switchesOnWhenMade: ['drafts.read', 'drafts.write'],
  });
  const renderSecond = () =>
    render(
      <MemoryRouter>
        <AdminRoleProvider value="super_admin">
          <KodaTab agent={SECOND} />
        </AdminRoleProvider>
      </MemoryRouter>
    );

  it('reads its own key, says it creates drafts and what its switches start as, and never names the other key or its service', async () => {
    readKodaKey.mockResolvedValue(second({ ...NO_KEY, capabilities: MADE }));
    const { container } = renderSecond();
    expect(await screen.findByText('Claude Publisher’s key')).toBeInTheDocument();
    expect(readKodaKey).toHaveBeenCalledWith('claude');
    expect(screen.getByText(/Claude Publisher is a draft creator/)).toBeInTheDocument();
    expect(screen.getByText(/cannot publish, schedule or delete/)).toBeInTheDocument();
    expect(screen.getByText('What Claude Publisher may do')).toBeInTheDocument();
    expect(
      screen.getAllByText(
        /A new key starts with only Read drafts and Create and edit drafts on; everything else is off until you turn it on\./
      ).length
    ).toBeGreaterThan(0);
    expect(screen.getByRole('switch', { name: 'Read drafts' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('switch', { name: 'Send to review and back' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(container.textContent).not.toMatch(/Muse|Koda/);
  });

  it('reads a switch its answer does not carry as its starting value', async () => {
    readKodaKey.mockResolvedValue(second({ ...ACTIVE, capabilities: {} }));
    renderSecond();
    expect(await screen.findByRole('switch', { name: 'Read drafts' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('switch', { name: 'Send to review and back' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('switches, rotates and revokes its own key only', async () => {
    readKodaKey.mockResolvedValue(second({ ...ACTIVE, capabilities: OFF }));
    generateKodaKey.mockResolvedValue({
      ...second({ ...ACTIVE, capabilities: OFF }),
      secret: SECRET,
    });
    setKodaCapabilities.mockResolvedValue(
      second({ ...ACTIVE, capabilities: { ...OFF, 'drafts.write': true } })
    );
    revokeKodaKey.mockResolvedValue(second({ ...ACTIVE, active: false }));
    renderSecond();
    fireEvent.click(await screen.findByRole('switch', { name: 'Create and edit drafts' }));
    await waitFor(() =>
      expect(setKodaCapabilities).toHaveBeenCalledWith({ 'drafts.write': true }, 'claude')
    );
    fireEvent.click(screen.getByRole('button', { name: /Rotate key/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /Rotate key/ }).at(-1));
    await waitFor(() => expect(generateKodaKey).toHaveBeenCalledWith('claude'));
    const reveal = await screen.findByRole('region', { name: "Claude Publisher's new key" });
    expect(reveal).toHaveTextContent(
      'Copy it now and paste it into the secure field Claude Publisher asks for. The site keeps only its hash'
    );
    fireEvent.click(screen.getAllByRole('button', { name: /Revoke key/ })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /Revoke key/ }).at(-1));
    await waitFor(() => expect(revokeKodaKey).toHaveBeenCalledWith('claude'));
  });
});

describe('KodaTab for a key whose job is not drafts', () => {
  const NETWORK = agentKeyTab('claude-network');
  const CF_CATALOGUE = [
    ...CATALOGUE,
    { id: 'admin.cloudflare', label: 'Read Cloudflare', description: 'Read the zone.' },
    { id: 'admin.cloudflare.dns', label: 'Change DNS records', description: 'Add and edit.' },
  ];

  it('speaks about its own work, starts with only reading Cloudflare on, and never mentions the Drafts page', async () => {
    readKodaKey.mockResolvedValue({
      ...answer({ ...ACTIVE, capabilities: {} }),
      agent: 'claude-network',
      capabilities: CF_CATALOGUE,
    });
    const { container } = render(
      <MemoryRouter>
        <AdminRoleProvider value="super_admin">
          <KodaTab agent={NETWORK} />
        </AdminRoleProvider>
      </MemoryRouter>
    );
    expect(await screen.findByText('Claude Network Guy’s key')).toBeInTheDocument();
    expect(readKodaKey).toHaveBeenCalledWith('claude-network');
    expect(screen.getByRole('switch', { name: 'Read Cloudflare' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('switch', { name: 'Change DNS records' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.queryByRole('link', { name: 'Drafts page' })).toBeNull();
    expect(container.textContent).not.toMatch(/Review board|Muse|Koda/);
    expect(container.textContent).toMatch(/Deleting is not on this list/);
  });
});
