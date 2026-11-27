/**
 * The Cloudflare page (#1905): its tabs, what an editor may see and not
 * change, the locks on the records and phases that keep the site running,
 * that nothing offers a delete, and that a write cannot be sent twice.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
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
const { REDACTED_VALUE } = await import('@/components/admin/cloudflare/cloudflareLocks');
const { HIDDEN_VALUE_NOTE } = await import('@/components/admin/cloudflare/CloudflareRules');

/** The zone every call names when the address names none: the site's (#1911). */
const SITE = 'hybridcloudworks.com';
const LAB = 'hybridcloudinsights.com';

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
    ownerOnlySettings: [{ setting: 'ssl', reason: 'An agent key may not change this.' }],
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
    expect(screen.getByTestId('family-rules')).toHaveTextContent(
      'refused (the token lacks this permission)'
    );
    expect(screen.getByTestId('family-dns')).toHaveTextContent('can be read');
    expect(screen.getByText('docs.example.com')).toBeInTheDocument();
    // The API rate limit is changed here since #1903; only the origin rule is Terraform's.
    expect(screen.getByTestId('locked-phases')).toHaveTextContent('http_request_late_transform');
    expect(screen.getByTestId('locked-phases')).not.toHaveTextContent('http_ratelimit');
    expect(screen.getByTestId('open-phases')).toHaveTextContent(
      'http_ratelimit — Rate limiting: limit how many requests one address can make, for example to the API.'
    );
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
    // The rate limit line (#1909) is not shown, and its read not made, until Cloudflare is set up.
    expect(screen.queryByTestId('rate-limit-check')).not.toBeInTheDocument();
    expect(api.readCloudflarePhase).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'DNS' }));
    expect(await screen.findByText('Cloudflare is not set up here yet')).toBeInTheDocument();
  });

  it('names only the zone id when only the zone id is missing, and sends no one to paste a token', async () => {
    api.readCloudflareStatus.mockResolvedValue({
      configured: false,
      missing: ['zoneId'],
      message: 'Cloudflare is not set up yet: the zone id (CF_ZONE_ID) is not set.',
      zone: null,
      families: [],
      protected: { dnsNames: [], phases: [] },
    });
    api.readCloudflareSettings.mockRejectedValue(
      Object.assign(
        new Error('Cloudflare is not set up yet: the zone id (CF_ZONE_ID) is not set.'),
        {
          code: 'CLOUDFLARE_NOT_CONFIGURED',
          status: 503,
        }
      )
    );
    renderAt();
    expect(await screen.findByText('Cloudflare is not set up here yet')).toBeInTheDocument();
    expect(screen.getByText(/the zone id \(CF_ZONE_ID\).*Terraform sets it/)).toBeInTheDocument();
    expect(screen.queryByText(/paste it on Integrations → Keys/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open Integrations → Keys' })).toBeNull();
    expect(
      screen.getByText('Not set up yet: the zone id is missing (Terraform sets the zone id).')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(
      await screen.findByText(/the zone id \(CF_ZONE_ID\).*Terraform sets it/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Integrations → Keys' })).toBeNull();
  });

  it('names both, and links the Keys tab, when the token and the zone id are missing', async () => {
    api.readCloudflareStatus.mockResolvedValue({
      configured: false,
      missing: ['token', 'zoneId'],
      zone: null,
      families: [],
      protected: { dnsNames: [], phases: [] },
    });
    renderAt();
    expect(await screen.findByText(/paste it on Integrations → Keys/)).toHaveTextContent(
      /CF_ZONE_ID.*Terraform/
    );
    expect(screen.getByRole('link', { name: 'Open Integrations → Keys' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Not set up yet: the admin token and the zone id are missing (Terraform sets the zone id).'
      )
    ).toBeInTheDocument();
  });

  it('says when a family could not be checked, and shows the server’s sentence for the zone', async () => {
    api.readCloudflareStatus.mockResolvedValue({
      ...STATUS,
      zone: null,
      zoneError: 'Cloudflare is limiting requests right now. Wait a minute and try again.',
      families: [{ id: 'cache', label: 'Cache', readable: null }],
    });
    renderAt();
    expect(await screen.findByTestId('zone-error')).toHaveTextContent(/limiting requests/);
    expect(screen.getByTestId('family-cache')).toHaveTextContent('could not check right now');
    expect(screen.queryByText(/Zone Read permission/)).toBeNull();
  });

  it('lists the certificate-check prefix, the wildcard rule and the phases that can change', async () => {
    renderAt();
    await screen.findByText('Free Website');
    expect(screen.getByText('_acme-challenge…')).toBeInTheDocument();
    expect(screen.getByText(/covers every name under it/)).toBeInTheDocument();
    expect(screen.getByText('http_request_dynamic_redirect')).toBeInTheDocument();
    expect(screen.getByText(/No DNS record or ruleset can be deleted/)).toBeInTheDocument();
  });

  it('lands an old word on its tab', async () => {
    renderAt('/admin/cloudflare?tab=records');
    expect(await screen.findByRole('tab', { selected: true })).toHaveTextContent('DNS');
  });
});

describe('the Overview’s API rate limit line (#1909)', () => {
  /** The line once its read has landed. */
  async function rateLimitLine() {
    renderAt();
    const line = await screen.findByTestId('rate-limit-check');
    await waitFor(() => expect(line).not.toHaveTextContent('Checking…'));
    return line;
  }

  it('is green when a rule is on, naming how many, and links the Rules tab', async () => {
    api.readCloudflarePhase.mockResolvedValue({
      ruleset: { rules: [{ id: 'r1', enabled: true }] },
    });
    const line = await rateLimitLine();
    expect(api.readCloudflarePhase).toHaveBeenCalledWith('http_ratelimit');
    expect(line).toHaveTextContent('1 API rate limit rule is on.');
    expect(line.querySelector('[data-status]')).toHaveAttribute('data-status', 'healthy');
    expect(within(line).getByRole('link', { name: 'Open the Rules tab' })).toHaveAttribute(
      'href',
      '/admin/cloudflare?tab=rules'
    );
    expect(within(line).queryByRole('link', { name: /Part 4/ })).toBeNull();
  });

  it('is amber when no rule is on, and links Part 4 of the runbook', async () => {
    api.readCloudflarePhase.mockResolvedValue({ ruleset: null, version: null });
    const line = await rateLimitLine();
    expect(line).toHaveTextContent('No API rate limit rule is on.');
    expect(line.querySelector('[data-status]')).toHaveAttribute('data-status', 'degraded');
    expect(
      within(line).getByRole('link', { name: 'Part 4 of the Cloudflare admin runbook' })
    ).toHaveAttribute(
      'href',
      'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/cloudflare-admin.md#part-4-making-the-api-rate-limit-rule'
    );
  });

  it('says it was not checked, with the server’s sentence, when the phase read is not set up', async () => {
    api.readCloudflarePhase.mockRejectedValue(
      Object.assign(new Error('Cloudflare is not set up yet.'), {
        status: 503,
        code: 'CLOUDFLARE_NOT_CONFIGURED',
      })
    );
    const line = await rateLimitLine();
    expect(line).toHaveTextContent('Not checked. Cloudflare is not set up yet.');
    expect(line.querySelector('[data-status]')).toHaveAttribute('data-status', 'unknown');
  });

  it('is red with the error’s sentence when the read fails', async () => {
    api.readCloudflarePhase.mockRejectedValue(
      Object.assign(new Error('Cloudflare answered with an error.'), { status: 500 })
    );
    const line = await rateLimitLine();
    expect(line).toHaveTextContent(
      'The rate limiting rules could not be read: Cloudflare answered with an error.'
    );
    expect(line.querySelector('[data-status]')).toHaveAttribute('data-status', 'critical');
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
    expect(api.createCloudflareDnsRecord).toHaveBeenCalledWith(
      {
        type: 'A',
        name: 'status',
        content: '192.0.2.20',
        ttl: 1,
        proxied: false,
      },
      SITE
    );
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
      expect(api.updateCloudflareDnsRecord).toHaveBeenCalledWith(
        'rec2',
        { content: '192.0.2.11' },
        SITE
      )
    );
  });
});

describe('the DNS tab, a page at a time (#1907)', () => {
  const REC3 = {
    id: 'rec3',
    type: 'TXT',
    name: 'note.example.com',
    content: 'hello',
    proxied: false,
    ttl: 1,
    comment: '',
    locked: false,
  };
  const FIRST = {
    records: RECORDS,
    page: 1,
    perPage: 100,
    totalPages: 2,
    totalCount: 3,
    hasMore: true,
  };
  const LAST = {
    records: [REC3],
    page: 2,
    perPage: 100,
    totalPages: 2,
    totalCount: 3,
    hasMore: false,
  };
  const byPage =
    (pages) =>
    (zone, page = 1) =>
      Promise.resolve(pages[page]);
  const loadMore = () => screen.queryByRole('button', { name: 'Load more' });

  it('loads page 1, says how many records there are, and appends the next page', async () => {
    api.readCloudflareDns.mockImplementation(byPage({ 1: FIRST, 2: LAST }));
    renderAt('/admin/cloudflare?tab=dns');
    await screen.findByTestId('dns-row-rec2');
    expect(api.readCloudflareDns).toHaveBeenCalledTimes(1);
    expect(api.readCloudflareDns.mock.calls[0]).toEqual([SITE]);
    expect(screen.getByTestId('dns-count')).toHaveTextContent("Showing 2 of the zone's 3 records");
    expect(screen.queryByTestId('dns-row-rec3')).toBeNull();
    fireEvent.click(loadMore());
    expect(await screen.findByTestId('dns-row-rec3')).toBeInTheDocument();
    expect(api.readCloudflareDns).toHaveBeenLastCalledWith(SITE, 2);
    // Appended, not replaced: page 1's rows and their locks are still there.
    expect(within(screen.getByTestId('dns-row-rec1')).getByText('Locked.')).toBeInTheDocument();
    expect(screen.getByTestId('dns-row-rec2')).toBeInTheDocument();
    expect(screen.getByTestId('dns-count')).toHaveTextContent('The zone has 3 records.');
    // The last page: no button.
    expect(loadMore()).toBeNull();
  });

  it('shows no Load more when the first page is the last', async () => {
    api.readCloudflareDns.mockResolvedValue({
      ...FIRST,
      totalPages: 1,
      totalCount: 2,
      hasMore: false,
    });
    renderAt('/admin/cloudflare?tab=dns');
    await screen.findByTestId('dns-row-rec2');
    expect(loadMore()).toBeNull();
    expect(screen.getByTestId('dns-count')).toHaveTextContent('The zone has 2 records.');
  });

  it('disables Load more while the page is on its way, and asks for it once', async () => {
    const pending = deferred();
    api.readCloudflareDns.mockImplementation((zone, page = 1) =>
      page === 1 ? Promise.resolve(FIRST) : pending.promise
    );
    renderAt('/admin/cloudflare?tab=dns');
    await screen.findByTestId('dns-row-rec2');
    const button = loadMore();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(api.readCloudflareDns).toHaveBeenCalledTimes(2);
    pending.resolve(LAST);
    expect(await screen.findByTestId('dns-row-rec3')).toBeInTheDocument();
    expect(loadMore()).toBeNull();
  });

  it('says why a page could not be read and keeps the rows it has', async () => {
    api.readCloudflareDns.mockImplementation((zone, page = 1) =>
      page === 1
        ? Promise.resolve(FIRST)
        : Promise.reject(new Error('Cloudflare could not be reached.'))
    );
    renderAt('/admin/cloudflare?tab=dns');
    await screen.findByTestId('dns-row-rec2');
    fireEvent.click(loadMore());
    expect(await screen.findByText('Cloudflare could not be reached.')).toBeInTheDocument();
    expect(screen.getByTestId('dns-row-rec1')).toBeInTheDocument();
    expect(loadMore()).toBeEnabled();
  });

  it('reads again from page 1 after a change', async () => {
    api.readCloudflareDns.mockImplementation(byPage({ 1: FIRST, 2: LAST }));
    api.updateCloudflareDnsRecord.mockResolvedValue({ record: {} });
    renderAt('/admin/cloudflare?tab=dns');
    await screen.findByTestId('dns-row-rec2');
    fireEvent.click(loadMore());
    await screen.findByTestId('dns-row-rec3');
    fireEvent.click(screen.getByRole('button', { name: 'Change A lab.example.com' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Content'), {
      target: { value: '192.0.2.11' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save the change/ }));
    // Longer than the 1 s default: save, re-read and re-render are three steps,
    // and the whole suite runs these files side by side.
    const slow = { timeout: 5000 };
    await waitFor(() => expect(api.readCloudflareDns).toHaveBeenCalledTimes(3), slow);
    await waitFor(() => expect(screen.queryByTestId('dns-row-rec3')).toBeNull(), slow);
    expect(api.readCloudflareDns.mock.calls).toEqual([[SITE], [SITE, 2], [SITE]]);
    expect(screen.getByTestId('dns-row-rec2')).toBeInTheDocument();
    expect(loadMore()).toBeEnabled();
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

  it('replaces an unlocked phase’s rules after asking, once, with the version it read', async () => {
    api.readCloudflarePhase.mockResolvedValue({
      ruleset: {
        name: 'Custom rules',
        rules: [{ id: 'r1', version: '2', expression: 'true', action: 'block' }],
      },
      version: '5',
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
      expect(api.replaceCloudflarePhase).toHaveBeenCalledWith(
        'http_request_firewall_custom',
        {
          rules: [{ id: 'r1', expression: 'true', action: 'block' }],
          expectedVersion: '5',
        },
        SITE
      )
    );
    expect(api.replaceCloudflarePhase).toHaveBeenCalledTimes(1);
  });

  it('locks every phase not on the allow-list, with the sentence about traffic', async () => {
    api.readCloudflareRulesets.mockResolvedValue({
      rulesets: [
        ...RULESETS,
        { id: 'rs4', name: 'Origin rules', phase: 'http_request_origin', kind: 'zone' },
      ],
    });
    api.readCloudflarePhase.mockResolvedValue({
      ruleset: { name: 'Origin rules', rules: [{ id: 'o', expression: 'true', action: 'route' }] },
      version: '1',
    });
    renderAt('/admin/cloudflare?tab=rules');
    const row = await screen.findByTestId('ruleset-http_request_origin');
    expect(row).toHaveTextContent(/can send or store the site's traffic elsewhere/);
    fireEvent.click(within(row).getByRole('button', { name: 'Open http_request_origin' }));
    const panel = await screen.findByTestId('phase-http_request_origin');
    await waitFor(() => expect(panel).toHaveTextContent('"action": "route"'));
    expect(within(panel).queryByRole('button', { name: /Edit these rules/ })).toBeNull();
  });

  it('lists the six phases that can be changed, and opens one with no rules yet', async () => {
    api.readCloudflarePhase.mockResolvedValue({ ruleset: null, version: null });
    api.replaceCloudflarePhase.mockResolvedValue({ ruleset: {} });
    renderAt('/admin/cloudflare?tab=rules');
    await screen.findByTestId('editable-http_request_dynamic_redirect');
    expect(screen.getAllByTestId(/^editable-/)).toHaveLength(6);
    expect(screen.getByTestId('editable-http_ratelimit')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open http_request_dynamic_redirect from the list of what can be changed',
      })
    );
    const panel = await screen.findByTestId('phase-http_request_dynamic_redirect');
    fireEvent.click(await within(panel).findByRole('button', { name: /Edit these rules/ }));
    const editor = within(panel).getByLabelText('Rules for http_request_dynamic_redirect');
    // An empty list is refused before anything is sent.
    expect(within(panel).getByRole('alert')).toHaveTextContent(/delete every rule/);
    expect(within(panel).getByRole('button', { name: 'Replace the rules' })).toBeDisabled();
    fireEvent.change(editor, {
      target: { value: '[{"expression":"true","action":"redirect"}]' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Replace the rules' }));
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Replace the rules' }));
    await waitFor(() =>
      expect(api.replaceCloudflarePhase).toHaveBeenCalledWith(
        'http_request_dynamic_redirect',
        {
          rules: [{ expression: 'true', action: 'redirect' }],
          expectedVersion: null,
        },
        SITE
      )
    );
  });

  it('offers no editor for a list holding a hidden value', async () => {
    api.readCloudflarePhase.mockResolvedValue({
      ruleset: {
        name: 'Custom rules',
        rules: [
          {
            id: 'h',
            expression: 'true',
            action: 'block',
            action_parameters: { headers: { 'x-api-key': { value: REDACTED_VALUE } } },
          },
        ],
      },
      version: '2',
    });
    renderAt('/admin/cloudflare?tab=rules');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open http_request_firewall_custom' })
    );
    const panel = await screen.findByTestId('phase-http_request_firewall_custom');
    await waitFor(() => expect(panel).toHaveTextContent(HIDDEN_VALUE_NOTE));
    expect(within(panel).queryByRole('button', { name: /Edit these rules/ })).toBeNull();
  });

  it('asks for the phase name typed before removing a custom security rule', async () => {
    api.readCloudflarePhase.mockResolvedValue({
      ruleset: {
        name: 'Custom rules',
        rules: [
          { id: 'r1', expression: 'true', action: 'block' },
          { id: 'r2', expression: 'false', action: 'challenge' },
        ],
      },
      version: '3',
    });
    api.replaceCloudflarePhase.mockResolvedValue({ ruleset: {} });
    renderAt('/admin/cloudflare?tab=rules');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open http_request_firewall_custom' })
    );
    const panel = await screen.findByTestId('phase-http_request_firewall_custom');
    fireEvent.click(await within(panel).findByRole('button', { name: /Edit these rules/ }));
    fireEvent.change(within(panel).getByLabelText('Rules for http_request_firewall_custom'), {
      target: { value: '[{"id":"r1","expression":"true","action":"block"}]' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Replace the rules' }));
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(confirm).toHaveTextContent(/removes 1 custom security rule/);
    const go = within(confirm).getByRole('button', { name: 'Replace the rules' });
    expect(go).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText('Type the phase name to confirm'), {
      target: { value: 'http_request_firewall_custom' },
    });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(api.replaceCloudflarePhase).toHaveBeenCalledTimes(1));
  });

  it('asks for the phase name typed before removing a rate limiting rule', async () => {
    // Two rules, as a paid plan allows; the Free plan has one, and an empty list is refused.
    const limit = (id, path, requests) => ({
      id,
      expression: `(lower(http.request.uri.path) contains "${path}")`,
      action: 'block',
      enabled: true,
      ratelimit: {
        characteristics: ['cf.colo.id', 'ip.src'],
        period: 10,
        requests_per_period: requests,
        mitigation_timeout: 10,
      },
    });
    const kept = limit('limit-2', '/api/public/', 50);
    api.readCloudflarePhase.mockResolvedValue({
      ruleset: { name: 'Rate limits', rules: [limit('limit-1', '/api/', 200), kept] },
      version: '2',
    });
    api.replaceCloudflarePhase.mockResolvedValue({ ruleset: {} });
    renderAt('/admin/cloudflare?tab=rules');
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open http_ratelimit from the list of what can be changed',
      })
    );
    const panel = await screen.findByTestId('phase-http_ratelimit');
    fireEvent.click(await within(panel).findByRole('button', { name: /Edit these rules/ }));
    fireEvent.change(within(panel).getByLabelText('Rules for http_ratelimit'), {
      target: { value: JSON.stringify([kept]) },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Replace the rules' }));
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(confirm).toHaveTextContent(
      /removes 1 rate limiting rule\(s\), so the requests they limited, such as calls to the API, will no longer be limited/
    );
    const go = within(confirm).getByRole('button', { name: 'Replace the rules' });
    expect(go).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText('Type the phase name to confirm'), {
      target: { value: 'http_ratelimit' },
    });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() =>
      expect(api.replaceCloudflarePhase).toHaveBeenCalledWith(
        'http_ratelimit',
        {
          rules: [kept],
          expectedVersion: '2',
        },
        SITE
      )
    );
  });

  it('shows the server’s sentence when the phase changed since it was opened, and keeps the edit', async () => {
    api.readCloudflarePhase.mockResolvedValue({
      ruleset: { name: 'Custom rules', rules: [{ id: 'r1', expression: 'true', action: 'block' }] },
      version: '3',
    });
    const stale = 'This phase changed since you opened it; reload it and make your change again.';
    api.replaceCloudflarePhase.mockRejectedValue(
      Object.assign(new Error(stale), { status: 409, code: 'CLOUDFLARE_STALE' })
    );
    renderAt('/admin/cloudflare?tab=rules');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open http_request_firewall_custom' })
    );
    const panel = await screen.findByTestId('phase-http_request_firewall_custom');
    fireEvent.click(await within(panel).findByRole('button', { name: /Edit these rules/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Replace the rules' }));
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Replace the rules' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: stale }))
    );
    expect(
      within(panel).getByLabelText('Rules for http_request_firewall_custom')
    ).toBeInTheDocument();
  });
});

describe('a change the server accepted but flagged', () => {
  it('shows a warning, not “Saved”, when the audit row could not be written', async () => {
    api.saveCloudflareSetting.mockResolvedValue({ setting: {}, audited: false });
    renderAt('/admin/cloudflare?tab=settings');
    const row = await screen.findByTestId('setting-brotli');
    fireEvent.click(within(row).getByRole('switch', { name: 'Brotli' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Save Brotli' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Saved, but check it',
        variant: 'warning',
        description: expect.stringMatching(/audit row could not be written/),
      })
    );
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Saved' }));
  });

  it('says “Saved” when the audit row was written', async () => {
    api.saveCloudflareSetting.mockResolvedValue({ setting: {}, audited: true });
    renderAt('/admin/cloudflare?tab=settings');
    const row = await screen.findByTestId('setting-brotli');
    fireEvent.click(within(row).getByRole('switch', { name: 'Brotli' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Save Brotli' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Saved' }))
    );
    expect(toast.mock.calls[0][0].variant).toBeUndefined();
  });

  it('warns when a DNS edit came back under a protected name', async () => {
    api.updateCloudflareDnsRecord.mockResolvedValue({
      record: {},
      audited: true,
      protectedAfterWrite: true,
    });
    renderAt('/admin/cloudflare?tab=dns');
    fireEvent.click(await screen.findByRole('button', { name: 'Change A lab.example.com' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Content'), {
      target: { value: '192.0.2.11' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save the change/ }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'warning',
          description: expect.stringMatching(/came back with a protected name/),
        })
      )
    );
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
    await waitFor(() =>
      expect(api.saveCloudflareSetting).toHaveBeenCalledWith('brotli', 'off', SITE)
    );
    const ipv6 = screen.getByTestId('setting-ipv6');
    expect(within(ipv6).queryByRole('button')).toBeNull();
    expect(within(ipv6).getByText(/does not allow this one to be changed/)).toBeInTheDocument();
  });

  it('marks the settings only the owner changes, with the server’s reason', async () => {
    renderAt('/admin/cloudflare?tab=settings');
    const row = await screen.findByTestId('setting-ssl');
    await waitFor(() => expect(row).toHaveTextContent('Owner only.'));
    expect(row).toHaveTextContent('An agent key may not change this.');
    expect(screen.getByTestId('setting-brotli')).not.toHaveTextContent('Owner only.');
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
    await waitFor(() =>
      expect(api.saveCloudflareSetting).toHaveBeenCalledWith('ssl', 'full', SITE)
    );
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
      expect(api.purgeCloudflareCache).toHaveBeenCalledWith({ everything: true }, SITE)
    );
  });

  it('purges a list of the zone’s own addresses, and refuses another site’s', async () => {
    api.purgeCloudflareCache.mockResolvedValue({ ok: true });
    renderAt('/admin/cloudflare?tab=cache');
    const box = await screen.findByLabelText('Addresses to purge');
    await waitFor(() =>
      expect(screen.getByText(`and on ${SITE}`, { exact: false })).toBeInTheDocument()
    );
    fireEvent.change(box, { target: { value: `https://${LAB}/a` } });
    expect(screen.getByRole('alert')).toHaveTextContent(`not on ${SITE}`);
    fireEvent.change(box, {
      target: { value: `https://${SITE}/a\nhttps://www.${SITE}/b` },
    });
    fireEvent.click(screen.getByRole('button', { name: /Purge 2 addresses/ }));
    await waitFor(() =>
      expect(api.purgeCloudflareCache).toHaveBeenCalledWith(
        { files: [`https://${SITE}/a`, `https://www.${SITE}/b`] },
        SITE
      )
    );
  });
});

describe('the zone picker (#1911)', () => {
  const SITE_ROLE = "The site's own zone: the website and its API.";
  const LAB_ROLE = "The lab's certificate zone: Caddy writes its certificate checks here.";
  const CADDY = 'A certificate check the lab host’s Caddy writes. Caddy owns these names.';
  const APEX = 'The lab zone’s own address. Nothing lives there.';
  const SUBTREE = 'Where the lab’s certificate checks live.';
  const WILDCARDS = 'A wildcard in the lab zone could answer the lab’s certificate check.';
  const statusFor = (zone) =>
    zone === LAB
      ? {
          ...STATUS,
          zone: { id: 'z2', name: LAB, status: 'active', plan: 'Free Website' },
          managed: { name: LAB, role: LAB_ROLE },
          protected: {
            dnsNames: [
              { name: LAB, reason: APEX },
              { name: `lab.${LAB}`, reason: SUBTREE },
              { name: `*.lab.${LAB}`, reason: SUBTREE },
            ],
            dnsPrefixes: [{ prefix: '_', reason: CADDY }],
            wildcardReason: WILDCARDS,
            phases: [],
            ownerOnlySettings: STATUS.protected.ownerOnlySettings,
          },
        }
      : { ...STATUS, managed: { name: SITE, role: SITE_ROLE } };

  function Where() {
    const location = useLocation();
    return <output data-testid="where">{location.search}</output>;
  }

  function renderWithAddress(path) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <AdminRoleProvider value="super_admin">
          <Routes>
            <Route
              path="/admin/cloudflare"
              element={
                <>
                  <CloudflarePage />
                  <Where />
                </>
              }
            />
          </Routes>
        </AdminRoleProvider>
      </MemoryRouter>
    );
  }

  beforeEach(() => {
    api.readCloudflareStatus.mockImplementation(async (zone) => statusFor(zone));
  });

  it('offers exactly the two managed zones, starts on the site’s, and says what it is for', async () => {
    renderWithAddress('/admin/cloudflare');
    const picker = screen.getByLabelText('Zone');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.value)
    ).toEqual([SITE, LAB]);
    expect(picker).toHaveValue(SITE);
    await screen.findByText('Free Website');
    expect(screen.queryByTestId('all-wildcards')).toBeNull();
    expect(await screen.findByTestId('zone-role')).toHaveTextContent(SITE_ROLE);
    expect(api.readCloudflareStatus).toHaveBeenCalledWith(SITE);
    expect(screen.getByTestId('where')).toHaveTextContent(/^$/);
  });

  it('keeps the picked zone in the address, reads every tab in it, and keeps it across tabs', async () => {
    renderWithAddress('/admin/cloudflare?tab=dns');
    await screen.findByTestId('dns-row-rec2');
    expect(api.readCloudflareDns).toHaveBeenLastCalledWith(SITE);
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: LAB } });
    expect(screen.getByTestId('where')).toHaveTextContent(`?tab=dns&zone=${LAB}`);
    await waitFor(() => expect(api.readCloudflareDns).toHaveBeenLastCalledWith(LAB));
    expect(await screen.findByTestId('zone-role')).toHaveTextContent(LAB_ROLE);
    fireEvent.click(screen.getByRole('tab', { name: 'Rules' }));
    expect(screen.getByTestId('where')).toHaveTextContent(`?tab=rules&zone=${LAB}`);
    await waitFor(() => expect(api.readCloudflareRulesets).toHaveBeenLastCalledWith(LAB));
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: SITE } });
    expect(screen.getByTestId('where')).toHaveTextContent(/^\?tab=rules$/);
  });

  it('starts again at page 1 when the zone changes, and asks for the next page of the picked zone (#1907)', async () => {
    const row = (id, name) => ({ ...RECORDS[1], id, name });
    const pages = {
      [SITE]: {
        1: { records: RECORDS, page: 1, totalPages: 2, totalCount: 3, hasMore: true },
        2: { records: [row('rec3', 'note.example.com')], page: 2, totalPages: 2, hasMore: false },
      },
      [LAB]: {
        1: {
          records: [row('lab1', `www.${LAB}`)],
          page: 1,
          totalPages: 2,
          totalCount: 2,
          hasMore: true,
        },
        2: { records: [row('lab2', `note.${LAB}`)], page: 2, totalPages: 2, hasMore: false },
      },
    };
    api.readCloudflareDns.mockImplementation(async (zone, page = 1) => pages[zone][page]);
    renderWithAddress('/admin/cloudflare?tab=dns');
    await screen.findByTestId('dns-row-rec2');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByTestId('dns-row-rec3');
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: LAB } });
    await screen.findByTestId('dns-row-lab1');
    // Page 1 of the lab zone alone: nothing of the site's pages is left.
    expect(screen.queryByTestId('dns-row-rec3')).toBeNull();
    expect(screen.queryByTestId('dns-row-rec2')).toBeNull();
    expect(api.readCloudflareDns.mock.calls).toEqual([[SITE], [SITE, 2], [LAB]]);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByTestId('dns-row-lab2');
    expect(api.readCloudflareDns).toHaveBeenLastCalledWith(LAB, 2);
    expect(screen.getByTestId('dns-row-lab1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('opens the zone a link names, in any letter case, and the site’s for any other name', async () => {
    const first = renderWithAddress('/admin/cloudflare?tab=settings&zone=HybridCloudInsights.com');
    expect(screen.getByLabelText('Zone')).toHaveValue(LAB);
    await waitFor(() => expect(api.readCloudflareSettings).toHaveBeenCalledWith(LAB));
    first.unmount();
    api.readCloudflareSettings.mockClear();
    renderWithAddress('/admin/cloudflare?tab=settings&zone=example.com');
    expect(screen.getByLabelText('Zone')).toHaveValue(SITE);
    await waitFor(() => expect(api.readCloudflareSettings).toHaveBeenCalledWith(SITE));
    expect(api.readCloudflareSettings).not.toHaveBeenCalledWith('example.com');
  });

  it('locks the lab zone’s certificate names, its apex and every wildcard, and sends a lab record to the lab zone', async () => {
    api.createCloudflareDnsRecord.mockResolvedValue({ record: {} });
    renderWithAddress(`/admin/cloudflare?tab=dns&zone=${LAB}`);
    await screen.findByTestId('dns-row-rec2');
    await screen.findByTestId('zone-role');
    fireEvent.click(screen.getByRole('button', { name: /Add a record/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: '_acme-challenge.lab' },
    });
    fireEvent.change(within(dialog).getByLabelText('Content'), { target: { value: 'x' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(`That name is locked. ${SUBTREE}`);
    for (const [name, reason] of [
      ['_acme-challenge', CADDY],
      ['_dmarc', CADDY],
      ['x.lab', SUBTREE],
      ['@', APEX],
      ['*.foo', WILDCARDS],
    ]) {
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: name } });
      expect(within(dialog).getByRole('alert')).toHaveTextContent(`That name is locked. ${reason}`);
    }
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: `x.${SITE}.` } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      `That name ends with ${SITE}, which is its own zone: pick ${SITE} above and add it there.`
    );
    expect(within(dialog).getByRole('button', { name: /Add the record/ })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'www' } });
    fireEvent.change(within(dialog).getByLabelText('Content'), { target: { value: '192.0.2.30' } });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /Add the record/ }));
    await waitFor(() => expect(api.createCloudflareDnsRecord).toHaveBeenCalledTimes(1));
    expect(api.createCloudflareDnsRecord.mock.calls[0][1]).toBe(LAB);
  });

  it('shows no Terraform phase in the lab zone', async () => {
    renderWithAddress(`/admin/cloudflare?zone=${LAB}`);
    expect(
      await screen.findByText(/None in this zone: Terraform writes no rules here/)
    ).toBeInTheDocument();
    expect(screen.getByTestId('locked-phases')).toBeEmptyDOMElement();
    expect(screen.getByTestId('all-wildcards')).toHaveTextContent(WILDCARDS);
  });

  it('shows the API rate limit line only on the site’s zone, since the rule is the site’s (#1909)', async () => {
    renderWithAddress(`/admin/cloudflare?zone=${LAB}`);
    await screen.findByText(/None in this zone: Terraform writes no rules here/);
    expect(screen.queryByTestId('rate-limit-check')).not.toBeInTheDocument();
    expect(api.readCloudflarePhase).not.toHaveBeenCalledWith('http_ratelimit');
  });

  it('shows a note in place of the tabs when the server answers for another zone, and offers no change', async () => {
    // A server older than #1911 ignores ?zone= and answers for the site's zone, without `managed`.
    api.readCloudflareStatus.mockResolvedValue(STATUS);
    renderWithAddress(`/admin/cloudflare?tab=dns&zone=${LAB}`);
    expect(await screen.findByText(`The server does not manage ${LAB} yet`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a record/ })).toBeNull();
    expect(screen.queryByTestId('dns-row-rec2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Go back to ${SITE}` }));
    expect(screen.getByLabelText('Zone')).toHaveValue(SITE);
    expect(await screen.findByTestId('dns-row-rec2')).toBeInTheDocument();
  });

  it('mounts no tab for the lab zone until the server has said which zone it answered for (#1913 review)', async () => {
    const held = deferred();
    api.readCloudflareStatus.mockReturnValue(held.promise);
    renderWithAddress(`/admin/cloudflare?tab=dns&zone=${LAB}`);
    // While the status is in flight, nothing reads DNS and no write control exists.
    expect(screen.queryByRole('button', { name: /Add a record/ })).toBeNull();
    expect(api.readCloudflareDns).not.toHaveBeenCalled();
    // An older server answers for the site's zone: the note replaces the tabs, still no DNS read.
    held.resolve(STATUS);
    expect(await screen.findByText(`The server does not manage ${LAB} yet`)).toBeInTheDocument();
    expect(api.readCloudflareDns).not.toHaveBeenCalled();
  });
});
