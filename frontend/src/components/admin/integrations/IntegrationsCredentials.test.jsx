/**
 * The Credentials tab (#1026). What must hold: every credential shows under
 * its store with its columns, overdue is red, the filter keeps one store, a
 * recorded rotation is the PUT the API reads and its answer replaces the
 * rows, Update reminders appears only when a reminder is missing, one write
 * runs at a time, a failed load leaves no stale rows, and no value renders.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import IntegrationsCredentials from './IntegrationsCredentials';

const getJSON = vi.fn();
const sendJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
  postJSON: vi.fn(),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

// The API's real shape (functions/src/lib/credentials/handlers.js).
const row = (overrides = {}) => ({
  id: 'lab-agent-certificate',
  name: '/etc/hcw/labs-agent.pem (sp-labs-agent-lab-hybrid-prod-cus-01)',
  store: 'lab-file',
  consumer: 'The lab agent’s calls to the API',
  issuer: 'Self-signed on the lab host, registered in Entra',
  renewal: 'hand',
  lifetimeDays: 730,
  rotate: 'Generate the next pair on the host.',
  recordable: true,
  dueSoonDays: 30,
  lastRotatedAt: null,
  lastRotatedSource: null,
  recordedOn: null,
  connection: null,
  ageDays: null,
  expiresAt: null,
  expiryEstimated: false,
  daysLeft: null,
  state: 'unknown',
  reason: 'No rotation date is known: record when it was last rotated.',
  reminder: null,
  ...overrides,
});

const STORES = [
  { id: 'key-vault', label: 'Key Vault kv-site-prod-cus-01' },
  { id: 'lab-file', label: 'Lab host file' },
];

const payload = (credentials, extra = {}) => ({
  success: true,
  generatedAt: '2026-10-09T12:00:00.000Z',
  stores: STORES,
  counts: { ok: 0, 'due-soon': 0, overdue: 0, unknown: 0 },
  credentials,
  unavailable: [],
  ...extra,
});

const overdueKey = row({
  id: 'kv-anthropic-api-key',
  name: 'ANTHROPIC-API-KEY',
  store: 'key-vault',
  consumer: 'AI router',
  issuer: 'Anthropic Console',
  lifetimeDays: 180,
  ageDays: 400,
  lastRotatedSource: 'key-vault',
  expiresAt: '2026-09-04T00:00:00.000Z',
  expiryEstimated: true,
  daysLeft: -35,
  state: 'overdue',
  reason: 'Rotation was due on 2026-09-04.',
  reminder: {
    id: 'credential-kv-anthropic-api-key',
    dueDate: '2026-09-04',
    leadDays: 30,
    inSheet: true,
  },
});

beforeEach(() => {
  getJSON.mockReset().mockResolvedValue(payload([row(), overdueKey]));
  sendJSON.mockReset();
  toast.mockReset();
});

const rowFor = (name) => screen.getByText(name).closest('tr');
const recordCertificate = () =>
  fireEvent.click(
    screen.getByRole('button', { name: /Record rotation of \/etc\/hcw\/labs-agent\.pem/ })
  );

describe('the register', () => {
  it('loads once auth is ready and shows each credential under its store, with every column', async () => {
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC-API-KEY')).toBeTruthy());
    expect(getJSON).toHaveBeenCalledWith('cms/credentials');
    const vault = screen.getByRole('region', { name: 'Key Vault kv-site-prod-cus-01' });
    expect(within(vault).getByText('ANTHROPIC-API-KEY')).toBeTruthy();
    const lab = screen.getByRole('region', { name: 'Lab host file' });
    expect(within(lab).getByText('Self-signed on the lab host, registered in Entra')).toBeTruthy();

    const key = rowFor('ANTHROPIC-API-KEY');
    expect(within(key).getByText('AI router')).toBeTruthy();
    expect(within(key).getByText('Anthropic Console')).toBeTruthy();
    expect(within(key).getByText('400 days')).toBeTruthy();
    expect(within(key).getByText('Keys tab')).toBeTruthy();
    expect(within(key).getByText('2026-09-04')).toBeTruthy();
    expect(within(key).getByText('rotation due')).toBeTruthy();
    expect(within(key).getByText('By hand')).toBeTruthy();
    expect(within(key).getByText('every 180 days')).toBeTruthy();
    expect(within(key).getByText('Rotation reminder, due 2026-09-04')).toBeTruthy();
  });

  it('shows an overdue credential in red, with the word as well as the colour', async () => {
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC-API-KEY')).toBeTruthy());
    const key = rowFor('ANTHROPIC-API-KEY');
    expect(key.getAttribute('data-state')).toBe('overdue');
    expect(key.className).toContain('bg-rose-50');
    expect(within(key).getByText('Overdue').getAttribute('data-status')).toBe('overdue');
    expect(within(key).getByText('2026-09-04').className).toContain('text-destructive');
    expect(
      rowFor('/etc/hcw/labs-agent.pem (sp-labs-agent-lab-hybrid-prod-cus-01)').className
    ).not.toContain('bg-rose-50');
  });

  it('filters to one store', async () => {
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC-API-KEY')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Show credentials from'), {
      target: { value: 'lab-file' },
    });
    expect(screen.queryByText('ANTHROPIC-API-KEY')).toBeNull();
    expect(screen.getByRole('region', { name: 'Lab host file' })).toBeTruthy();
  });

  it('shows the reminder that asks for a date on a credential with a rule and none yet (#1026)', async () => {
    getJSON.mockResolvedValue(
      payload([
        row({
          reminder: {
            id: 'credential-lab-agent-certificate',
            kind: 'record',
            dueDate: '2026-10-09',
            leadDays: 0,
            inSheet: true,
          },
        }),
      ])
    );
    render(<IntegrationsCredentials />);
    await waitFor(() =>
      expect(screen.getByText('Reminder to record its rotation date, due 2026-10-09')).toBeTruthy()
    );
  });

  it('names a source it could not read', async () => {
    getJSON.mockResolvedValue(
      payload([row()], {
        unavailable: [{ id: 'coder-automation', label: 'the lab host’s Coder report' }],
      })
    );
    render(<IntegrationsCredentials />);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('the lab host’s Coder report')
    );
  });

  it('clears the rows when a refresh fails, rather than leaving dates that are no longer true', async () => {
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC-API-KEY')).toBeTruthy());
    getJSON.mockRejectedValueOnce(new Error('Forbidden'));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Forbidden'));
    expect(screen.queryByText('ANTHROPIC-API-KEY')).toBeNull();
  });

  it('never renders a value, even one that arrived in the response', async () => {
    const LEAK = 'sk-live-THIS-MUST-NEVER-RENDER-0123456789';
    getJSON.mockResolvedValue(payload([row({ value: LEAK, oauthToken: LEAK })]));
    const { container } = render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText(/labs-agent\.pem/)).toBeTruthy());
    expect(container.innerHTML).not.toContain(LEAK);
  });
});

describe('recording a rotation', () => {
  it('offers Record only where the owner renews it', async () => {
    getJSON.mockResolvedValue(
      payload([
        row(),
        row({
          id: 'kv-coder-status-token',
          name: 'CODER-STATUS-TOKEN',
          store: 'key-vault',
          renewal: 'automation',
          recordable: false,
        }),
      ])
    );
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText('CODER-STATUS-TOKEN')).toBeTruthy());
    expect(within(rowFor('CODER-STATUS-TOKEN')).queryByRole('button')).toBeNull();
    expect(
      screen.getByRole('button', { name: /Record rotation of \/etc\/hcw\/labs-agent\.pem/ })
    ).toBeTruthy();
  });

  it('PUTs the id and the chosen date, and the answer replaces the rows', async () => {
    const recorded = row({
      recordedOn: '2026-09-29',
      lastRotatedSource: 'owner',
      ageDays: 10,
      expiresAt: '2028-09-28T00:00:00.000Z',
      expiryEstimated: true,
      state: 'ok',
      reason: 'Next rotation due on 2028-09-28.',
      reminder: {
        id: 'credential-lab-agent-certificate',
        dueDate: '2028-09-28',
        leadDays: 30,
        inSheet: true,
      },
    });
    sendJSON.mockResolvedValue({
      ...payload([recorded, overdueKey]),
      recorded: { credentialId: 'lab-agent-certificate', rotatedOn: '2026-09-29' },
      reminders: { synced: true, changed: true, reminders: 2 },
    });
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC-API-KEY')).toBeTruthy());

    recordCertificate();
    const date = screen.getByLabelText(
      'Rotation date for /etc/hcw/labs-agent.pem (sp-labs-agent-lab-hybrid-prod-cus-01)'
    );
    fireEvent.change(date, { target: { value: '2026-09-29' } });
    fireEvent.submit(date.closest('form'));

    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/credentials', 'PUT', {
        credentialId: 'lab-agent-certificate',
        rotatedOn: '2026-09-29',
      })
    );
    await waitFor(() => expect(screen.getByText('Rotation reminder, due 2028-09-28')).toBeTruthy());
    expect(screen.getByText('recorded 2026-09-29')).toBeTruthy();
    expect(screen.queryByLabelText(/Rotation date for/)).toBeNull();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'The reminders sheet was updated.' })
    );
    // One read, on load: the write's answer is the new register.
    expect(getJSON).toHaveBeenCalledTimes(1);
  });

  it('defaults the date to this browser’s day when nothing is recorded', async () => {
    getJSON.mockResolvedValue(payload([row()]));
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText(/labs-agent\.pem/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Record rotation of/ }));
    const local = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    expect(screen.getByLabelText(/Rotation date for/).value).toBe(
      `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
    );
  });

  it('shows the stored date on the row and opens on it, allows the API’s day of grace, and clears with null', async () => {
    getJSON.mockResolvedValue(
      payload([row({ recordedOn: '2026-09-29', lastRotatedSource: 'owner', ageDays: 10 })])
    );
    sendJSON.mockResolvedValue(payload([row()]));
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText(/labs-agent\.pem/)).toBeTruthy());
    expect(screen.getByText('recorded 2026-09-29')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Record rotation of/ }));
    const input = screen.getByLabelText(/Rotation date for/);
    expect(input.value).toBe('2026-09-29');
    // The API accepts up to the UTC day plus one (handlers.js parseRotationBody),
    // so the picker does too, and an owner ahead of or behind UTC can pick their day.
    expect(input.getAttribute('max')).toBe(
      new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear recorded date' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/credentials', 'PUT', {
        credentialId: 'lab-agent-certificate',
        rotatedOn: null,
      })
    );
  });

  it('says a refused write changed nothing, and keeps the form open', async () => {
    sendJSON.mockRejectedValue(
      new Error('rotatedOn is in the future: record a rotation once it is done')
    );
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText(/labs-agent\.pem/)).toBeTruthy());
    recordCertificate();
    fireEvent.submit(screen.getByLabelText(/Rotation date for/).closest('form'));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Nothing was changed', variant: 'destructive' })
      )
    );
    expect(screen.getByLabelText(/Rotation date for/)).toBeTruthy();
  });

  it('sends one write at a time', async () => {
    let resolve;
    sendJSON.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText(/labs-agent\.pem/)).toBeTruthy());
    recordCertificate();
    const form = screen.getByLabelText(/Rotation date for/).closest('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(sendJSON).toHaveBeenCalledTimes(1);
    resolve(payload([row()]));
    await waitFor(() => expect(toast).toHaveBeenCalled());
  });
});

describe('Update reminders', () => {
  it('does not appear while every reminder is on the sheet', async () => {
    render(<IntegrationsCredentials />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC-API-KEY')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Update reminders' })).toBeNull();
  });

  it('POSTs the sync and takes its answer', async () => {
    getJSON.mockResolvedValue(
      payload([
        row({
          expiresAt: '2028-09-28T00:00:00.000Z',
          reminder: {
            id: 'credential-lab-agent-certificate',
            dueDate: '2028-09-28',
            leadDays: 30,
            inSheet: false,
          },
        }),
      ])
    );
    sendJSON.mockResolvedValue({
      ...payload([
        row({
          expiresAt: '2028-09-28T00:00:00.000Z',
          reminder: {
            id: 'credential-lab-agent-certificate',
            dueDate: '2028-09-28',
            leadDays: 30,
            inSheet: true,
          },
        }),
      ]),
      reminders: { synced: true, changed: true, reminders: 1 },
    });
    render(<IntegrationsCredentials />);
    await waitFor(() =>
      expect(
        screen.getByText('Rotation reminder, due 2028-09-28, not on the sheet yet')
      ).toBeTruthy()
    );
    expect(screen.getByText(/1 reminder is not on the reminders sheet yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update reminders' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/credentials/reminders', 'POST', {})
    );
    await waitFor(() => expect(screen.getByText('Rotation reminder, due 2028-09-28')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Update reminders' })).toBeNull();
  });
});
