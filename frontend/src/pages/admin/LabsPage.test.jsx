/**
 * The Labs Hub's shell and its tabs (#577; the Catalogue and the Concepts
 * panel since ADR 0033 "Labs").
 *
 * This page had no tests at all before #577 — 693 lines, including the agent
 * staleness rendering that T-309 was filed against. These cover what the
 * reorganisation decides: which panel a `?tab=` picks, that a job's output is
 * reachable outside the Console, that a stale agent is told to restart
 * rather than reinstall, that the Catalogue lists every lab with a working
 * Validate, and that the Dashboard defines Agent, Desktop and Lab with a
 * live state for each.
 *
 * react-router is mocked rather than wrapped, as the other hub tests do, so a
 * tab click can be asserted as the `setSearchParams` call it is.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LabsPage from './LabsPage';
import { DIFFICULTY_LABELS, labs } from '@/data/labs/catalogue';

const postJSON = vi.fn();
const getJSON = vi.fn();
const fetchCoderStatus = vi.fn();
let searchParams = '';
const setSearchParams = vi.fn();

vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: vi.fn(),
}));
vi.mock('@/lib/publicApi', () => ({
  fetchCoderStatus: () => fetchCoderStatus(),
}));
vi.mock('react-router', () => ({
  useSearchParams: () => [new URLSearchParams(searchParams), setSearchParams],
  useLocation: () => ({ pathname: '/admin/labs' }),
  Link: ({ to, children, ...rest }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
}));

const RECENT = new Date(Date.now() - 5_000).toISOString();
const LONG_AGO = new Date(Date.now() - 600_000).toISOString();

const snapshot = (over = {}) => ({
  agents: [{ id: 'vps-1', agentId: 'vps-1', lastSeenAt: RECENT }],
  jobs: [
    {
      id: 'job-1',
      type: 'shell-echo',
      status: 'succeeded',
      agentId: 'vps-1',
      createdAt: '2026-09-16T12:00:00Z',
      claimedAt: '2026-09-16T12:00:00Z',
      finishedAt: '2026-09-16T12:00:02Z',
      exitCode: 0,
      output: 'hello vps',
    },
  ],
  jobTypes: [{ type: 'shell-echo' }],
  ...over,
});

beforeEach(() => {
  searchParams = '';
  setSearchParams.mockReset();
  postJSON.mockReset().mockResolvedValue(snapshot());
  getJSON.mockReset().mockResolvedValue({
    since: '2026-10-26',
    today: '2026-10-26',
    counts: { today: 0, last7: 0, last30: 0, total: 0 },
    perLab: [],
  });
  fetchCoderStatus.mockReset().mockResolvedValue({
    configured: true,
    reachable: true,
    templates: [{ name: 'hcw-lab', activeVersion: 'v0.3.1' }],
    capacity: { running: 1, max: 5 },
    asOf: '2026-10-03T12:00:00Z',
  });
  window.localStorage.clear();
});

const hubTabs = () => screen.getByRole('tablist', { name: 'Labs Hub' });

describe('which panel the page shows', () => {
  it('opens on the Catalogue when there is no ?tab= (ADR 0033)', async () => {
    render(<LabsPage />);
    expect(await screen.findByText(labs[0].title)).toBeInTheDocument();
    expect(screen.queryByText('Jobs queued')).not.toBeInTheDocument();
  });

  it('shows the Dashboard on ?tab=dashboard', async () => {
    searchParams = 'tab=dashboard';
    render(<LabsPage />);
    expect(await screen.findByText('Jobs queued')).toBeInTheDocument();
  });

  it('shows the lab sessions started card on the Dashboard only', async () => {
    searchParams = 'tab=dashboard';
    const { unmount } = render(<LabsPage />);
    expect(await screen.findByTestId('lab-starts-card')).toBeInTheDocument();
    expect(getJSON).toHaveBeenCalledWith('cms/labs/starts');
    unmount();

    getJSON.mockClear();
    searchParams = 'tab=jobs';
    render(<LabsPage />);
    expect(await screen.findByText('Jobs')).toBeInTheDocument();
    expect(screen.queryByTestId('lab-starts-card')).not.toBeInTheDocument();
    expect(getJSON).not.toHaveBeenCalled();
  });

  it('sends the old `setup` id to Settings, where the steps went', async () => {
    // `setup` was a real tab id, so links naming it exist. It used to fall
    // through to Dashboard silently.
    searchParams = 'tab=setup';
    render(<LabsPage />);
    expect(await screen.findByText(/Harden the host/)).toBeInTheDocument();
  });

  it('shows the Catalogue for an unknown tab', async () => {
    searchParams = 'tab=nope';
    render(<LabsPage />);
    expect(await screen.findByText(labs[0].title)).toBeInTheDocument();
  });

  it('puts the selected tab in the URL rather than local state', async () => {
    render(<LabsPage />);
    await screen.findByText(labs[0].title);
    fireEvent.click(within(hubTabs()).getByRole('tab', { name: 'Jobs' }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: 'jobs' });
  });

  it('opens the same way every admin page does: a PageHeader with help', async () => {
    render(<LabsPage />);
    expect(await screen.findByRole('heading', { level: 1, name: /Labs/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }));
    expect(screen.getByText(/A Lab is a catalogue row/)).toBeInTheDocument();
    expect(screen.getByText(/The Desktop is the Coder workspace/)).toBeInTheDocument();
    expect(screen.getByText(/The Agent is the job runner/)).toBeInTheDocument();
  });
});

describe('the Catalogue tab (ADR 0033)', () => {
  it('lists every lab with its providers, difficulty, duration, steps, status and public page', async () => {
    render(<LabsPage />);
    await screen.findByText(labs[0].title);
    for (const lab of labs) {
      const row = document.querySelector(`tr[data-lab="${lab.id}"]`);
      expect(row).not.toBeNull();
      expect(row).toHaveTextContent(lab.title);
      expect(row).toHaveTextContent(DIFFICULTY_LABELS[lab.difficulty]);
      expect(row).toHaveTextContent(`${lab.estimatedMinutes} min`);
      expect(row).toHaveTextContent(String(lab.steps.length));
      expect(within(row).getByText('Available')).toBeInTheDocument();
      expect(within(row).getByRole('link', { name: /Public page/ })).toHaveAttribute(
        'href',
        `/${lab.providers[0]}/education/labs/${lab.id}`
      );
    }
    const lzb = document.querySelector('tr[data-lab="landing-zone-builder-output"]');
    expect(lzb).toHaveTextContent('Azure, Terraform');
    expect(lzb).toHaveTextContent('terraform-validate');
  });

  it('Validate enqueues the lab’s check with its sample payload and opens the Console on the job', async () => {
    postJSON.mockImplementation(async (fn) =>
      fn === 'enqueueLabJob'
        ? { jobId: 'job-9', type: 'ansible-check', status: 'queued' }
        : snapshot({ jobTypes: [{ type: 'shell-echo' }, { type: 'ansible-check' }] })
    );
    render(<LabsPage />);
    await screen.findByText(labs[0].title);
    const lab = labs.find((entry) => entry.id === 'ansible-syntax-check-walkthrough');
    // Offered once the snapshot's allowlist carries the lab's job type.
    fireEvent.click(await screen.findByRole('button', { name: `Validate ${lab.title}` }));

    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('enqueueLabJob', {
        type: 'ansible-check',
        payload: lab.validation.samplePayload,
        payloadEncoding: 'text',
      })
    );
    await waitFor(() =>
      expect(setSearchParams).toHaveBeenCalledWith({
        tab: 'console',
        job: 'job-9',
        type: 'ansible-check',
      })
    );
  });

  it('offers no Validate for a check the runner does not list, and says so', async () => {
    // The snapshot's allowlist carries only shell-echo here, so every lab's
    // check is missing from it.
    render(<LabsPage />);
    await screen.findByText(labs[0].title);
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith('getLabsSnapshot', {}));
    expect(screen.queryAllByRole('button', { name: /^Validate / })).toHaveLength(0);
    expect(screen.getAllByText(/not offered$/).length).toBe(labs.length);
  });
});

describe('the Console, opened on a job (ADR 0033)', () => {
  it('watches the job the URL names', async () => {
    postJSON.mockImplementation(async (fn) =>
      fn === 'getLabJob'
        ? { job: { id: 'job-9', type: 'ansible-check', status: 'claimed', agentId: 'vps-1' } }
        : snapshot({ jobTypes: [{ type: 'shell-echo' }, { type: 'ansible-check' }] })
    );
    searchParams = 'tab=console&job=job-9&type=ansible-check';
    render(<LabsPage />);
    expect(await screen.findByText('job-9')).toBeInTheDocument();
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith('getLabJob', { jobId: 'job-9' }));
    expect(screen.getByLabelText('Job type')).toHaveValue('ansible-check');
  });
});

describe('the Concepts panel on the Dashboard (ADR 0033)', () => {
  it('defines Agent, Desktop and Lab, each with its live state in the shared vocabulary', async () => {
    searchParams = 'tab=dashboard';
    render(<LabsPage />);
    const panel = (await screen.findByRole('heading', { name: 'Concepts' })).closest('section');

    const agent = within(panel).getByRole('heading', { name: 'Agent' }).closest('[data-concept]');
    expect(agent).toHaveTextContent('1 agent(s) connected');
    expect(agent.querySelector('[data-status]')).toHaveAttribute('data-status', 'healthy');

    const desktop = within(panel)
      .getByRole('heading', { name: 'Desktop' })
      .closest('[data-concept]');
    await waitFor(() =>
      expect(desktop.querySelector('[data-status]')).toHaveAttribute('data-status', 'healthy')
    );
    expect(desktop).toHaveTextContent('1 of 5 workspaces running');

    const lab = within(panel).getByRole('heading', { name: 'Lab' }).closest('[data-concept]');
    expect(lab).toHaveTextContent(`${labs.length} listed`);
    expect(within(lab).getByRole('link', { name: 'Catalogue tab' })).toHaveAttribute(
      'href',
      '/admin/labs?tab=catalogue'
    );
  });

  it('reads the Agent as degraded for a stale fleet and offline for none', async () => {
    postJSON.mockResolvedValue(
      snapshot({ agents: [{ id: 'vps-1', agentId: 'vps-1', lastSeenAt: LONG_AGO }] })
    );
    searchParams = 'tab=dashboard';
    const first = render(<LabsPage />);
    const stale = await screen.findByRole('heading', { name: 'Agent' });
    await waitFor(() =>
      expect(stale.closest('[data-concept]').querySelector('[data-status]')).toHaveAttribute(
        'data-status',
        'degraded'
      )
    );
    first.unmount();

    postJSON.mockResolvedValue(snapshot({ agents: [] }));
    render(<LabsPage />);
    const none = await screen.findByRole('heading', { name: 'Agent' });
    await waitFor(() =>
      expect(none.closest('[data-concept]').querySelector('[data-status]')).toHaveAttribute(
        'data-status',
        'offline'
      )
    );
    expect(screen.getByText('No agent has ever connected')).toBeInTheDocument();
  });

  it('counts only claimed jobs as in flight: the runner writes no running status', async () => {
    postJSON.mockResolvedValue(
      snapshot({
        jobs: [
          { id: 'a', type: 'shell-echo', status: 'claimed' },
          { id: 'b', type: 'shell-echo', status: 'queued' },
          { id: 'c', type: 'shell-echo', status: 'succeeded' },
        ],
      })
    );
    searchParams = 'tab=dashboard';
    render(<LabsPage />);
    const inFlight = (await screen.findByText('Jobs in flight')).previousElementSibling;
    expect(inFlight).toHaveTextContent('1');
  });
});

describe('the Settings tab', () => {
  it('describes the systemd environment file, not a .env, and a lifecycle without running', async () => {
    searchParams = 'tab=settings';
    render(<LabsPage />);
    await screen.findByText(/Harden the host/);
    const page = document.body.textContent;
    expect(page).toMatch(/EnvironmentFile=\/etc\/hcw\/labs-agent\.env/);
    expect(page).toMatch(/There is no \.env file/);
    expect(page).toMatch(/queued → claimed → succeeded/);
    expect(page).not.toMatch(/claimed → running/);
    expect(page).not.toMatch(/copy \.env\.example/);
  });
});

describe('the Jobs tab (new in #577)', () => {
  it('lists a run and expands it to what it printed', async () => {
    searchParams = 'tab=jobs';
    render(<LabsPage />);

    expect(await screen.findByText('shell-echo')).toBeInTheDocument();
    expect(screen.getByText('2.0s')).toBeInTheDocument();
    // The output is the point: before #577 it existed only for whichever job
    // the Console had just submitted.
    expect(screen.queryByText('hello vps')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show output for shell-echo/i }));
    expect(await screen.findByText('hello vps')).toBeInTheDocument();
  });

  it('says a finished job printed nothing, rather than showing an empty box', async () => {
    postJSON.mockResolvedValue(
      snapshot({
        jobs: [{ id: 'j2', type: 'terraform-plan', status: 'succeeded', exitCode: 0 }],
      })
    );
    searchParams = 'tab=jobs';
    render(<LabsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Show output for terraform-plan/i }));
    expect(await screen.findByText('(no output)')).toBeInTheDocument();
  });

  it('distinguishes a job still with the agent from one that finished silently', async () => {
    postJSON.mockResolvedValue(
      snapshot({ jobs: [{ id: 'j3', type: 'shell-echo', status: 'claimed' }] })
    );
    searchParams = 'tab=jobs';
    render(<LabsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Show output for shell-echo/i }));
    expect(await screen.findByText(/Still running/)).toBeInTheDocument();
  });

  it('is empty, not broken, when no job has ever run', async () => {
    postJSON.mockResolvedValue(snapshot({ jobs: [] }));
    searchParams = 'tab=jobs';
    render(<LabsPage />);
    expect(await screen.findByText(/No jobs yet/)).toBeInTheDocument();
  });
});

describe('the Agents tab (new in #577)', () => {
  it('tells a stale agent to restart, not to reinstall', async () => {
    // The distinction the tab exists for: this agent IS installed. Sending an
    // operator through six provisioning steps is the wrong fix.
    postJSON.mockResolvedValue(
      snapshot({ agents: [{ id: 'vps-1', agentId: 'vps-1', lastSeenAt: LONG_AGO }] })
    );
    searchParams = 'tab=agents';
    render(<LabsPage />);

    expect(await screen.findByText(/registered but offline/i)).toBeInTheDocument();
    expect(screen.getByText(/systemctl restart hcw-labs-agent/)).toBeInTheDocument();
    expect(screen.getAllByText(/journalctl/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Harden the host/)).not.toBeInTheDocument();
  });

  it('sends a never-connected estate to the provisioning steps instead', async () => {
    postJSON.mockResolvedValue(snapshot({ agents: [] }));
    searchParams = 'tab=agents';
    render(<LabsPage />);

    expect(await screen.findByText(/Nothing has ever connected/)).toBeInTheDocument();
    // No reconnect advice: there is nothing to reconnect.
    expect(screen.queryByText(/systemctl restart/)).not.toBeInTheDocument();
  });

  it('says nothing to fix when an agent is heartbeating', async () => {
    searchParams = 'tab=agents';
    render(<LabsPage />);

    expect(await screen.findByText(/1 agent\(s\) connected/)).toBeInTheDocument();
    expect(screen.queryByText(/systemctl restart/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing has ever connected/)).not.toBeInTheDocument();
  });

  it('offers Register agent with the server job types ticked, and Deactivate on a registered agent (#740)', async () => {
    postJSON.mockResolvedValue(
      snapshot({
        agents: [
          {
            agentId: 'vps-1',
            active: true,
            oid: '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b',
            lastSeenAt: RECENT,
          },
        ],
        jobTypes: [{ type: 'shell-echo' }, { type: 'kubeconform' }],
      })
    );
    searchParams = 'tab=agents';
    render(<LabsPage />);

    const form = await screen.findByRole('form', { name: 'Register agent' });
    await waitFor(() => expect(within(form).getByLabelText('kubeconform')).toBeChecked());
    expect(within(form).getByLabelText('shell-echo')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Deactivate vps-1' })).toBeInTheDocument();
  });
});

describe('the snapshot', () => {
  it('is read once for the whole page', async () => {
    render(<LabsPage />);
    await screen.findByText(labs[0].title);
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith('getLabsSnapshot', {}));
    expect(postJSON.mock.calls.filter(([fn]) => fn === 'getLabsSnapshot')).toHaveLength(1);
  });
});
