/**
 * The Agents page (#1905): an Overview that says what an agent key is and
 * lists every key with its job, its switches and its state, and one tab per
 * key, which is the same key tab the AI Engine used to hold.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AdminRoleProvider } from '@/hooks/useAdminRole';

const readKodaKey = vi.fn();
const generateKodaKey = vi.fn();
vi.mock('@/lib/agentContent', async (importOriginal) => ({
  ...(await importOriginal()),
  readKodaKey: (...args) => readKodaKey(...args),
  generateKodaKey: (...args) => generateKodaKey(...args),
  setKodaCapabilities: vi.fn(),
  revokeKodaKey: vi.fn(),
}));
vi.mock('@/lib/functionsBase', () => ({ getFunctionsBase: () => 'https://api.example.test/api' }));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { default: AgentsPage } = await import('./AgentsPage');
const { default: AIEnginePage } = await import('./AIEnginePage');

const CATALOGUE = [
  { id: 'drafts.read', label: 'Read drafts', description: 'List and open.' },
  { id: 'drafts.write', label: 'Create and edit drafts', description: 'Create and save.' },
  { id: 'admin.cloudflare', label: 'Read Cloudflare', description: 'Read the zone.' },
];
const answer = (agent, key) => ({
  ok: true,
  agent,
  key,
  capabilities: CATALOGUE,
  limits: { requestsPerMinute: 120 },
  basePath: '/api/agent-content/v1',
  endpoints: [],
  adminAccess: [],
});
const ACTIVE = {
  present: true,
  active: true,
  keyHint: 'hcwk_abcd',
  createdAt: '2026-11-01T17:00:00.000Z',
  lastUsedAt: '2026-11-20T17:00:00.000Z',
  capabilities: { 'drafts.read': true, 'drafts.write': false },
};

function renderAt(path, role = 'editor') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AdminRoleProvider value={role}>
        <Routes>
          <Route path="/admin/agents" element={<AgentsPage />} />
          <Route path="/admin/ai-engine" element={<AIEnginePage />} />
        </Routes>
      </AdminRoleProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  readKodaKey.mockReset().mockImplementation(async (agent) => {
    if (agent === 'claude') throw new Error('HTTP 500');
    if (agent === 'claude-network') {
      return answer(agent, { present: false, active: false, capabilities: {} });
    }
    return answer('koda', ACTIVE);
  });
  generateKodaKey.mockReset();
});

describe('the Agents page', () => {
  it('has an Overview, then one tab per agent key', () => {
    renderAt('/admin/agents');
    expect(screen.getByRole('heading', { level: 1, name: /Agents/ })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Koda',
      'Claude Publisher',
      'Claude Network Guy',
    ]);
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Overview');
  });

  it('explains an agent key and lists every key with its job, switches and state, one failure on its own row', async () => {
    renderAt('/admin/agents');
    expect(screen.getByText('What an agent key is')).toBeInTheDocument();
    const koda = await screen.findByTestId('agent-row-koda');
    await waitFor(() => expect(within(koda).getByText('Active')).toBeInTheDocument());
    // Koda's stored switches: one of the three on.
    expect(within(koda).getByText('1 of 3 on')).toBeInTheDocument();
    expect(within(koda).getByText(/content agent/)).toBeInTheDocument();
    expect(within(koda).getByRole('link', { name: 'Koda' })).toHaveAttribute(
      'href',
      '/admin/agents?tab=koda'
    );

    const network = screen.getByTestId('agent-row-claude-network');
    expect(within(network).getByText('No key yet')).toBeInTheDocument();
    expect(within(network).getByText(/Cloudflare zone/)).toBeInTheDocument();

    const publisher = screen.getByTestId('agent-row-claude');
    expect(within(publisher).getByText(/Could not be read: HTTP 500/)).toBeInTheDocument();
    expect(readKodaKey.mock.calls.map(([agent]) => agent)).toEqual([
      'koda',
      'claude',
      'claude-network',
    ]);
  });

  it('opens a key’s own tab from its row, reading that key only, with its writes gated for an editor', async () => {
    renderAt('/admin/agents');
    fireEvent.click(await screen.findByRole('link', { name: 'Claude Network Guy' }));
    expect(await screen.findByText('Claude Network Guy’s key')).toBeInTheDocument();
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Claude Network Guy');
    expect(readKodaKey).toHaveBeenLastCalledWith('claude-network');
    const generate = screen.getByRole('button', { name: /Generate key/ });
    expect(generate).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(generate);
    expect(generateKodaKey).not.toHaveBeenCalled();
  });

  it('lands an old word for a key on its tab', async () => {
    renderAt('/admin/agents?tab=muse');
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Koda');
    expect(await screen.findByText('Koda’s key')).toBeInTheDocument();
  });
});

describe('the AI Engine’s old key tab addresses', () => {
  it.each([
    ['/admin/ai-engine?tab=koda', 'Koda'],
    ['/admin/ai-engine?tab=claude', 'Claude Publisher'],
    ['/admin/ai-engine?tab=claude-network', 'Claude Network Guy'],
    ['/admin/ai-engine?tab=agent-content', 'Koda'],
  ])('%s opens the Agents page on %s', async (path, tab) => {
    renderAt(path);
    expect(await screen.findByRole('tab', { selected: true })).toHaveTextContent(tab);
    expect(screen.getByRole('heading', { level: 1, name: /Agents/ })).toBeInTheDocument();
  });
});
