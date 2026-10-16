/**
 * The Agents tab's registry writes (#740): Register agent, and Deactivate /
 * Activate on each card; and Remove on a deactivated card (owner request
 * 2026-09-28).
 *
 * What these pin is what the go-live depends on. The form starts with every
 * job type ticked and sends exactly what is ticked; it refuses a value the
 * API would refuse, before the round trip; deactivating asks first and
 * activating does not; removing is offered only on a deactivated card and
 * always asks; and every write refreshes the snapshot so the card changes
 * when the toast appears.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentsTab from './AgentsTab';

const postJSON = vi.fn();
const sendJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api', () => ({
  postJSON: (...args) => postJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));

const AGENT_ID = 'vps-hostinger-01';
const OID = '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b';
const JOB_TYPES = [
  'shell-echo',
  'terraform-validate',
  'ansible-check',
  'helm-template',
  'kubeconform',
].map((type) => ({ type }));
const NOW = Date.parse('2026-09-27T12:00:00Z');

const hub = (over = {}) => ({
  agents: [],
  now: NOW,
  jobTypes: JOB_TYPES,
  refresh: vi.fn(),
  ...over,
});

const agent = (over = {}) => ({
  agentId: AGENT_ID,
  oid: OID,
  active: true,
  capabilities: ['shell-echo'],
  lastSeenAt: new Date(NOW - 5_000).toISOString(),
  ...over,
});

const form = () => screen.getByRole('form', { name: 'Register agent' });
const fill = (label, value) =>
  fireEvent.change(within(form()).getByLabelText(label), { target: { value } });
const submit = () =>
  fireEvent.click(within(form()).getByRole('button', { name: /Register agent/ }));

beforeEach(() => {
  postJSON.mockReset();
  sendJSON.mockReset();
  toast.mockReset();
});

describe('Register agent', () => {
  it('says where the two values come from, and starts with every job type ticked', () => {
    render(<AgentsTab hub={hub()} />);

    expect(within(form()).getByLabelText('Agent id')).toHaveValue('');
    expect(within(form()).getByLabelText('Object id')).toHaveValue('');
    expect(screen.getAllByText('scripts/lab/Register-LabAgent.ps1').length).toBeGreaterThan(0);
    expect(screen.getByText(/prints both values/)).toBeInTheDocument();
    for (const { type } of JOB_TYPES) {
      expect(within(form()).getByLabelText(type)).toBeChecked();
    }
  });

  it('posts the pasted values, trimmed, with every job type, then toasts and refreshes', async () => {
    postJSON.mockResolvedValue({
      ok: true,
      created: true,
      changed: true,
      agent: { id: AGENT_ID, agentId: AGENT_ID, oid: OID, active: true },
    });
    const state = hub();
    render(<AgentsTab hub={state} />);

    fill('Agent id', `  ${AGENT_ID} `);
    fill('Object id', `${OID}\n`);
    submit();

    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
    expect(postJSON).toHaveBeenCalledWith('cms/labs/agents', {
      agentId: AGENT_ID,
      oid: OID,
      jobTypes: JOB_TYPES.map((jt) => jt.type),
    });
    await waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Agent registered',
        description: expect.stringContaining(OID),
      })
    );
    // Cleared, so a second click is not an accidental second registration.
    expect(within(form()).getByLabelText('Agent id')).toHaveValue('');
  });

  it('sends only the job types left ticked', async () => {
    postJSON.mockResolvedValue({
      ok: true,
      created: true,
      changed: true,
      agent: { agentId: AGENT_ID, oid: OID },
    });
    render(<AgentsTab hub={hub()} />);

    fill('Agent id', AGENT_ID);
    fill('Object id', OID);
    fireEvent.click(within(form()).getByLabelText('helm-template'));
    fireEvent.click(within(form()).getByLabelText('kubeconform'));
    submit();

    await waitFor(() => expect(postJSON).toHaveBeenCalled());
    expect(postJSON.mock.calls[0][1].jobTypes).toEqual([
      'shell-echo',
      'terraform-validate',
      'ansible-check',
    ]);
  });

  it.each([
    ['an agent id in capitals', 'VPS-Hostinger-01', OID, /certificate CN/],
    ['an object id that is not a GUID', AGENT_ID, 'not-a-guid', /GUID/],
    ['an object id in braces', AGENT_ID, `{${OID}}`, /GUID/],
  ])('refuses %s without sending it', async (_label, agentId, oid, message) => {
    render(<AgentsTab hub={hub()} />);
    fill('Agent id', agentId);
    fill('Object id', oid);
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('refuses a registration with no job type ticked', async () => {
    render(<AgentsTab hub={hub()} />);
    fill('Agent id', AGENT_ID);
    fill('Object id', OID);
    for (const { type } of JOB_TYPES) fireEvent.click(within(form()).getByLabelText(type));
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one job type/);
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('says a re-registered agent is still deactivated', async () => {
    postJSON.mockResolvedValue({
      ok: true,
      created: false,
      changed: true,
      agent: { agentId: AGENT_ID, oid: OID, active: false },
    });
    render(<AgentsTab hub={hub()} />);
    fill('Agent id', AGENT_ID);
    fill('Object id', OID);
    submit();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: 'Agent updated',
      description: expect.stringContaining('still deactivated'),
    });
  });

  it('shows what the API said when it refuses', async () => {
    postJSON.mockRejectedValue(new Error('Requires editor or higher'));
    const state = hub();
    render(<AgentsTab hub={state} />);
    fill('Agent id', AGENT_ID);
    fill('Object id', OID);
    submit();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: 'Registration failed',
      description: 'Requires editor or higher',
      variant: 'destructive',
    });
    expect(state.refresh).not.toHaveBeenCalled();
    // Kept, so the owner can correct and resend.
    expect(within(form()).getByLabelText('Agent id')).toHaveValue(AGENT_ID);
  });
});

describe('Deactivate and Activate', () => {
  it('asks before deactivating, and sends nothing when cancelled', async () => {
    render(<AgentsTab hub={hub({ agents: [agent()] })} />);

    fireEvent.click(screen.getByRole('button', { name: `Deactivate ${AGENT_ID}` }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`Deactivate ${AGENT_ID}?`)).toBeInTheDocument();
    expect(within(dialog).getByText(/Agent access required/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sendJSON).not.toHaveBeenCalled();
  });

  it('deactivates on confirm, then toasts and refreshes', async () => {
    sendJSON.mockResolvedValue({ ok: true, changed: true, agent: agent({ active: false }) });
    const state = hub({ agents: [agent()] });
    render(<AgentsTab hub={state} />);

    fireEvent.click(screen.getByRole('button', { name: `Deactivate ${AGENT_ID}` }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(`cms/labs/agents/${AGENT_ID}`, 'PATCH', {
        active: false,
      })
    );
    await waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Agent deactivated' }));
  });

  it('activates a deactivated agent without asking, and marks it Deactivated until then', async () => {
    sendJSON.mockResolvedValue({ ok: true, changed: true, agent: agent() });
    const state = hub({ agents: [agent({ active: false })] });
    render(<AgentsTab hub={state} />);

    expect(screen.getByText('Deactivated')).toBeInTheDocument();
    // The bound principal, which tells "bound to another object id" apart
    // from the other two ways gate 2 refuses an agent.
    expect(screen.getByText(`object id ${OID}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Activate ${AGENT_ID}` }));

    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(`cms/labs/agents/${AGENT_ID}`, 'PATCH', {
        active: true,
      })
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Agent activated' }))
    );
  });

  it('offers neither for a snapshot that does not say whether the agent is active', () => {
    // An API from before #740 sends no `active`; guessing which button to
    // show would offer to "activate" an agent that is already working.
    render(<AgentsTab hub={hub({ agents: [agent({ active: undefined })] })} />);
    expect(screen.queryByRole('button', { name: /Deactivate|Activate/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivated')).not.toBeInTheDocument();
  });

  it('shows the API error when the toggle fails', async () => {
    sendJSON.mockRejectedValue(new Error('No lab agent vps-hostinger-01 is registered'));
    render(<AgentsTab hub={hub({ agents: [agent({ active: false })] })} />);

    fireEvent.click(screen.getByRole('button', { name: `Activate ${AGENT_ID}` }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: 'Activate failed',
      variant: 'destructive',
    });
  });
});

describe('Remove', () => {
  // The card the owner asked about: the pre-reinstall host's agent.
  const OLD_ID = 'srv939861';
  const old = () =>
    agent({
      agentId: OLD_ID,
      active: false,
      version: '0.1.0',
      lastSeenAt: '2026-08-20T09:30:00.000Z',
    });

  const openRemove = async () => {
    fireEvent.click(screen.getByRole('button', { name: `Remove ${OLD_ID}` }));
    return screen.findByRole('dialog');
  };

  it('is offered on a deactivated card only: not on an active one, nor one that does not say', () => {
    render(
      <AgentsTab
        hub={hub({
          agents: [agent(), old(), agent({ agentId: 'vps-legacy-01', active: undefined })],
        })}
      />
    );

    const removes = screen.getAllByRole('button', { name: /^Remove / });
    expect(removes).toHaveLength(1);
    expect(removes[0]).toHaveAccessibleName(`Remove ${OLD_ID}`);
    expect(screen.queryByRole('button', { name: `Remove ${AGENT_ID}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove vps-legacy-01' })).not.toBeInTheDocument();
  });

  it('asks first, naming the agent and saying it can be registered again; Cancel sends nothing', async () => {
    const state = hub({ agents: [agent(), old()] });
    render(<AgentsTab hub={state} />);

    const dialog = await openRemove();
    expect(within(dialog).getByText(`Remove ${OLD_ID}?`)).toBeInTheDocument();
    expect(within(dialog).getByText(/registration is deleted/)).toHaveTextContent(OLD_ID);
    expect(within(dialog).getByText(/Register agent can add it back later/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sendJSON).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    // Still there, still offered.
    expect(screen.getByRole('button', { name: `Remove ${OLD_ID}` })).toBeEnabled();
  });

  it('sends DELETE with no body on confirm, then toasts and refreshes', async () => {
    sendJSON.mockResolvedValue({ ok: true, removed: true, agentId: OLD_ID });
    const state = hub({ agents: [agent(), old()] });
    render(<AgentsTab hub={state} />);

    const dialog = await openRemove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
    expect(sendJSON.mock.calls[0]).toEqual([`cms/labs/agents/${OLD_ID}`, 'DELETE']);
    await waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Agent removed',
        description: expect.stringContaining(OLD_ID),
      })
    );
    // The other agent was never touched.
    expect(sendJSON).not.toHaveBeenCalledWith(
      expect.stringContaining(AGENT_ID),
      expect.anything(),
      expect.anything()
    );
  });

  it('shows what the API said when it refuses, and does not refresh', async () => {
    sendJSON.mockRejectedValue(new Error(`${OLD_ID} still holds job-1 (claimed).`));
    const state = hub({ agents: [old()] });
    render(<AgentsTab hub={state} />);

    const dialog = await openRemove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: 'Remove failed',
      description: `${OLD_ID} still holds job-1 (claimed).`,
      variant: 'destructive',
    });
    expect(state.refresh).not.toHaveBeenCalled();
  });
});

describe('The applied commit and the drift verdict (#1009)', () => {
  const applied = {
    commit: '0123456789abcdef0123456789abcdef01234567',
    committedAt: '2026-09-26T10:00:00.000Z',
    appliedAt: '2026-09-27T04:31:07.000Z',
  };

  it('shows the commit the host converged from and the server’s verdict on it, in its colour', () => {
    const drift = {
      status: 'critical',
      summary: `${AGENT_ID} is behind main: 2 changes under lab-host/ or vps-agent/ merged after 01234567, the oldest 2 d ago. Run bootstrap.sh on the lab host.`,
    };
    render(<AgentsTab hub={hub({ agents: [agent({ applied, drift })] })} />);

    expect(screen.getByText(/^commit 01234567 · converged /)).toBeInTheDocument();
    const line = screen.getByTestId('agent-drift');
    expect(line).toHaveTextContent(drift.summary);
    expect(line).toHaveAttribute('data-status', 'critical');
    expect(line.className).toMatch(/text-rose-600/);
  });

  it('says a host that never reported is behind, with no commit line to show', () => {
    const drift = {
      status: 'critical',
      summary: `${AGENT_ID} has not reported the commit it converged from.`,
    };
    render(<AgentsTab hub={hub({ agents: [agent({ applied: null, drift })] })} />);
    expect(screen.queryByText(/^commit /)).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-drift')).toHaveTextContent('has not reported the commit');
  });

  it('shows nothing for an API that sends neither', () => {
    render(<AgentsTab hub={hub({ agents: [agent()] })} />);
    expect(screen.queryByTestId('agent-drift')).not.toBeInTheDocument();
    expect(screen.queryByText(/^commit /)).not.toBeInTheDocument();
  });
});

describe('AgentCard: certificate expiry (#957)', () => {
  it('shows certificate valid line when expiry is well in the future', () => {
    const certExp = new Date(NOW + 120 * 86_400_000).toISOString();
    render(<AgentsTab hub={hub({ agents: [agent({ certificateExpiresAt: certExp })] })} />);

    const line = screen.getByTestId('agent-cert-expiry');
    expect(line).toHaveTextContent(/Certificate valid for 120d/);
    expect(screen.queryByTestId('agent-cert-warning-badge')).not.toBeInTheDocument();
  });

  it('shows amber warning badge and text when expiry is within 60 days', () => {
    const certExp = new Date(NOW + 30 * 86_400_000).toISOString();
    render(<AgentsTab hub={hub({ agents: [agent({ certificateExpiresAt: certExp })] })} />);

    const line = screen.getByTestId('agent-cert-expiry');
    expect(line).toHaveTextContent(/Certificate expires in 30d/);
    expect(line.className).toMatch(/text-amber-600/);

    const badge = screen.getByTestId('agent-cert-warning-badge');
    expect(badge).toHaveTextContent('Cert expires in 30d');
  });

  it('shows red warning badge and text when certificate is expired', () => {
    const certExp = new Date(NOW - 5 * 86_400_000).toISOString();
    render(<AgentsTab hub={hub({ agents: [agent({ certificateExpiresAt: certExp })] })} />);

    const line = screen.getByTestId('agent-cert-expiry');
    expect(line).toHaveTextContent(/Certificate expired 5d ago/);
    expect(line.className).toMatch(/text-rose-600/);

    const badge = screen.getByTestId('agent-cert-warning-badge');
    expect(badge).toHaveTextContent('Cert expired');
  });

  it('renders nothing when certificateExpiresAt is absent or malformed', () => {
    render(<AgentsTab hub={hub({ agents: [agent({ certificateExpiresAt: null })] })} />);
    expect(screen.queryByTestId('agent-cert-expiry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-cert-warning-badge')).not.toBeInTheDocument();
  });
});
