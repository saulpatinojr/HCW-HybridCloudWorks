/**
 * The Cloudflare page (#1905): its tabs, what an editor may see and not
 * change, the locks on the records and phases that keep the site running,
 * that nothing offers a delete, and that a write cannot be sent twice.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AdminRoleProvider } from '@/hooks/useAdminRole';

const api = {
  readCloudflareStatus: vi.fn(),
  readCloudflareSettings: vi.fn(),
  saveCloudflareSetting: vi.fn(),
  purgeCloudflareCache: vi.fn(),
  readCloudflareDns: vi.fn(),
  createCloudflareDnsRecord: vi.fn(),
  updateCloudflareDnsRecord: vi.fn(),
  readCloudflareRulesets: vi.fn(),
  readCloudflarePhase: vi.fn(),
  replaceCloudflarePhase: vi.fn(),
};
vi.mock('@/lib/cloudflare', async (importOriginal) => {
  const actual = await importOriginal();
  return Object.fromEntries(
    Object.keys(actual).map((name) => [
      name,
      name in api ? (...args) => api[name](...args) : actual[name],
    ])
  );
});
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const { default: CloudflarePage } = await import('./CloudflarePage');

const STATUS = {
  configured: true,
  zone: { id: 'z1', name: 'example.com', status: 'active', plan: 'Free Website' },
  families: [
    { id: 'settings', label: 'Zone settings', readable: true },
    { id: 'dns', label: 'DNS records', readable: true },
    { id: 'rules', label: 'Rules', readable: false },
    { id: 'cache', label: 'Cache', readable: true },
  ],
  protected: {
    dnsNames: [
      {
        name: 'example.com',
        reason: 'The site itself, on the Static Web App (infra/frontend.tf).',
      },
      { name: 'docs.example.com', reason: 'Managed by Terraform in infra/frontend.tf.' },
    ],
    phases: [
      {
        phase: 'http_request_late_transform',
        reason: 'The origin secret rule. Changing it locks every visitor out of the API.',
      },
    ],
  },
};
const RECORDS = [
  {
    id: 'rec1',
    type: 'CNAME',
    name: 'docs.example.com',
    content: 'docs.host.net',
    proxied: true,
    ttl: 1,
    comment: '',
    locked: true,
    lockedReason: 'Managed by Terraform in infra/frontend.tf.',
  },
  {
    id: 'rec2',
    type: 'A',
    name: 'lab.example.com',
    content: '192.0.2.10',
    proxied: false,
    ttl: 300,
    comment: 'the lab host',
    locked: false,
  },
];
const RULESETS = [
  {
    id: 'rs1',
    name: 'Origin secret',
    phase: 'http_request_late_transform',
    kind: 'zone',
    description: '',
    locked: true,
    lockedReason: 'The origin secret rule. Changing it locks every visitor out of the API.',
  },
  {
    id: 'rs2',
    name: 'Custom rules',
    phase: 'http_request_firewall_custom',
    kind: 'zone',
    description: '',
    locked: false,
  },
  { id: 'rs3', name: 'Managed', phase: 'http_request_firewall_managed', kind: 'managed' },
];

function renderAt(path = '/admin/cloudflare', role = 'super_admin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AdminRoleProvider value={role}>
        <Routes>
          <Route path="/admin/cloudflare" element={<CloudflarePage />} />
        </Routes>
      </AdminRoleProvider>
    </MemoryRouter>
  );
}

/** A promise the test settles, to hold a request in flight. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  toast.mockReset();
  api.readCloudflareStatus.mockResolvedValue(STATUS);
  api.readCloudflareDns.mockResolvedValue({ records: RECORDS });
  api.readCloudflareRulesets.mockResolvedValue({ rulesets: RULESETS });
  api.readCloudflareSettings.mockResolvedValue({
    settings: [
      { id: 'brotli', value: 'on', editable: true, modifiedOn: null },
      { id: 'ssl', value: 'strict', editable: true, modifiedOn: null },
      { id: 'ipv6', value: 'on', editable: false, modifiedOn: null },
    ],
  });
});

describe('the Cloudflare page', () => {
  it('opens on the Overview with the zone, what the token reads and what is locked', async () => {
    renderAt();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Settings',
      'DNS',
      'Rules',
      'Cache',
    ]);
    expect(screen.getByRole('heading', { level: 1, name: /Cloudflare/ })).toBeInTheDocument();
    expect(await screen.findByText('Free Website')).toBeInTheDocument();
    expect(screen.getByTestId('family-rules')).toHaveTextContent('refused');
    expect(screen.getByTestId('family-dns')).toHaveTextContent('can be read');
    expect(screen.getByText('docs.example.com')).toBeInTheDocument();
    expect(screen.getByText('http_ratelimit')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Agents → Claude Network Guy' })).toHaveAttribute(
      'href',
      '/admin/agents?tab=claude-network'
    );
  });

  it('says where to paste the token while it is not set, and every tab says the same', async () => {
    api.readCloudflareStatus.mockResolvedValue({
      configured: false,
      zone: null,
      families: [],
      protected: { dnsNames: [], phases: [] },
    });
    const err = Object.assign(new Error('Cloudflare is not set up.'), {
      code: 'CLOUDFLARE_NOT_CONFIGURED',
      status: 503,
    });
    api.readCloudflareDns.mockRejectedValue(err);
    renderAt();
    expect(await screen.findByText('Cloudflare is not set up here yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Integrations → Keys' })).toHaveAttribute(
      'href',
      '/admin/integrations?tab=keys'
    );
    fireEvent.click(screen.getByRole('tab', { name: 'DNS' }));
    expect(await screen.findByText('Cloudflare is not set up here yet')).toBeInTheDocument();
  });

  it('lands an old word on its tab', async () => {
    renderAt('/admin/cloudflare?tab=records');
    expect(await screen.findByRole('tab', { selected: true })).toHaveTextContent('DNS');
  });
});

describe('the DNS tab', () => {
  it('locks a protected record with its reason and no change button, and offers no delete anywhere', async () => {
    renderAt('/admin/cloudflare?tab=dns');
    const locked = await screen.findByTestId('dns-row-rec1');
    expect(within(locked).getByText('Locked.')).toBeInTheDocument();
    expect(within(locked).getByText(/infra\/frontend\.tf/)).toBeInTheDocument();
    expect(within(locked).queryByRole('button')).toBeNull();
    const open = screen.getByTestId('dns-row-rec2');
    expect(within(open).getByRole('button', { name: 'Change A lab.example.com' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
  });

  it('shows an editor the records and gates every change with the reason', async () => {
    renderAt('/admin/cloudflare?tab=dns', 'editor');
    await screen.findByTestId('dns-row-rec2');
    const add = screen.getByRole('button', { name: /Add a record/ });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByText(/needs the super admin role/).length).toBeGreaterThan(0);
    fireEvent.click(add);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.createCloudflareDnsRecord).not.toHaveBeenCalled();
  });

  it('adds a record once, with its button disabled while the request is out', async () => {
    const pending = deferred();
    api.createCloudflareDnsRecord.mockReturnValue(pending.promise);
    renderAt('/admin/cloudflare?tab=dns');
    await screen.findByTestId('dns-row-rec2');
    fireEvent.click(screen.getByRole('button', { name: /Add a record/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'status' } });
    fireEvent.change(within(dialog).getByLabelText('Content'), {
      target: { value: '192.0.2.20' },
    });
    const save = within(dialog).getByRole('button', { name: /Add the record/ });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    expect(api.createCloudflareDnsRecord).toHaveBeenCalledTimes(1);
    expect(api.createCloudflareDnsRecord).toHaveBeenCalledWith({
      type: 'A',
      name: 'status',
      content: '192.0.2.20',
      ttl: 1,
      proxied: false,
    });
    pending.resolve({ record: { id: 'rec3' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.readCloudflareDns).toHaveBeenCalledTimes(2);
  });

  it('refuses a protected name in the add form before sending', async () => {
    renderAt('/admin/cloudflare?tab=dns');
    await screen.findByTestId('dns-row-rec2');
    await waitFor(() => expect(api.readCloudflareStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Add a record/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'docs' } });
    fireEvent.change(within(dialog).getByLabelText('Content'), { target: { value: 'x.net' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/That name is locked/);
    expect(within(dialog).getByRole('button', { name: /Add the record/ })).toBeDisabled();
  });

  it('sends only the changed fields when a record is edited', async () => {
    api.updateCloudflareDnsRecord.mockResolvedValue({ record: {} });
    renderAt('/admin/cloudflare?tab=dns');
    fireEvent.click(await screen.findByRole('button', { name: 'Change A lab.example.com' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Content'), {
      target: { value: '192.0.2.11' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save the change/ }));
    await waitFor(() =>
      expect(api.updateCloudflareDnsRecord).toHaveBeenCalledWith('rec2', { content: '192.0.2.11' })
    );
  });
});

describe('the Rules tab', () => {
  it('shows a locked phase’s rules with its reason and no edit', async () => {
    api.readCloudflarePhase.mockResolvedValue({
      ruleset: {
        name: 'Origin secret',
        rules: [{ id: 'r', expression: 'true', action: 'rewrite' }],
      },
    });
    renderAt('/admin/cloudflare?tab=rules');
    const row = await screen.findByTestId('ruleset-http_request_late_transform');
    expect(within(row).getByText('Locked.')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Open http_request_late_transform' }));
    const panel = await screen.findByTestId('phase-http_request_late_transform');
    await waitFor(() => expect(panel).toHaveTextContent('"action": "rewrite"'));
    expect(within(panel).queryByRole('button', { name: /Edit these rules/ })).toBeNull();
    expect(screen.getByText('Managed')).toBeInTheDocument();
  });

  it('replaces an unlocked phase’s rules after asking, once', async () => {
    api.readCloudflarePhase.mockResolvedValue({
      ruleset: {
        name: 'Custom rules',
        rules: [{ id: 'r1', version: '2', expression: 'true', action: 'block' }],
      },
    });
    api.replaceCloudflarePhase.mockResolvedValue({ ruleset: {} });
    renderAt('/admin/cloudflare?tab=rules');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open http_request_firewall_custom' })
    );
    const panel = await screen.findByTestId('phase-http_request_firewall_custom');
    fireEvent.click(await within(panel).findByRole('button', { name: /Edit these rules/ }));
    const editor = within(panel).getByLabelText('Rules for http_request_firewall_custom');
    expect(editor.value).not.toMatch(/version/);
    fireEvent.click(within(panel).getByRole('button', { name: 'Replace the rules' }));
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Replace the rules' }));
    await waitFor(() =>
      expect(api.replaceCloudflarePhase).toHaveBeenCalledWith('http_request_firewall_custom', {
        rules: [{ id: 'r1', expression: 'true', action: 'block' }],
      })
    );
    expect(api.replaceCloudflarePhase).toHaveBeenCalledTimes(1);
  });
});

describe('the Settings tab', () => {
  it('saves one setting, and keeps a read-only one unchangeable', async () => {
    api.saveCloudflareSetting.mockResolvedValue({ setting: {} });
    renderAt('/admin/cloudflare?tab=settings');
    const row = await screen.findByTestId('setting-brotli');
    const save = within(row).getByRole('button', { name: 'Save Brotli' });
    expect(save).toBeDisabled();
    fireEvent.click(within(row).getByRole('switch', { name: 'Brotli' }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.saveCloudflareSetting).toHaveBeenCalledWith('brotli', 'off'));
    const ipv6 = screen.getByTestId('setting-ipv6');
    expect(within(ipv6).queryByRole('button')).toBeNull();
    expect(within(ipv6).getByText(/does not allow this one to be changed/)).toBeInTheDocument();
  });

  it('asks before changing a setting that can lock visitors out', async () => {
    api.saveCloudflareSetting.mockResolvedValue({ setting: {} });
    renderAt('/admin/cloudflare?tab=settings');
    const row = await screen.findByTestId('setting-ssl');
    fireEvent.change(within(row).getByRole('combobox', { name: 'Ssl' }), {
      target: { value: 'full' },
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Save Ssl' }));
    expect(api.saveCloudflareSetting).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Change it' }));
    await waitFor(() => expect(api.saveCloudflareSetting).toHaveBeenCalledWith('ssl', 'full'));
  });
});

describe('the Cache tab', () => {
  it('purges everything after asking, and an editor cannot', async () => {
    api.purgeCloudflareCache.mockResolvedValue({ ok: true });
    const { unmount } = renderAt('/admin/cloudflare?tab=cache', 'editor');
    await waitFor(() => expect(api.readCloudflareStatus).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Purge everything/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    unmount();

    renderAt('/admin/cloudflare?tab=cache');
    fireEvent.click(await screen.findByRole('button', { name: /Purge everything/ }));
    expect(api.purgeCloudflareCache).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Purge everything' }));
    await waitFor(() =>
      expect(api.purgeCloudflareCache).toHaveBeenCalledWith({ everything: true })
    );
  });

  it('purges a list of the zone’s own addresses, and refuses another site’s', async () => {
    api.purgeCloudflareCache.mockResolvedValue({ ok: true });
    renderAt('/admin/cloudflare?tab=cache');
    const box = await screen.findByLabelText('Addresses to purge');
    await waitFor(() => expect(screen.getByText(/and on example\.com/)).toBeInTheDocument());
    fireEvent.change(box, { target: { value: 'https://other.net/a' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/not on example\.com/);
    fireEvent.change(box, {
      target: { value: 'https://example.com/a\nhttps://www.example.com/b' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Purge 2 addresses/ }));
    await waitFor(() =>
      expect(api.purgeCloudflareCache).toHaveBeenCalledWith({
        files: ['https://example.com/a', 'https://www.example.com/b'],
      })
    );
  });
});
