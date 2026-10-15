/**
 * `/education/labs` and `/:provider/education/labs` (#681, ADR 0033): the
 * cards come from the catalogue and nothing else, grouped by home provider
 * on the index and filtered on a provider's list; every card opens its own
 * lab's page under a provider (#751); a provider with no lab gets an honest
 * empty section; the two "Run it locally" lines are exactly the two from
 * #658; the two status cards say the two explicit unprovisioned sentences
 * when both routes answer `{ configured: false }` — and render full data when
 * they answer with it; the agent slot points at the sandbox recipe's page in
 * the Docker hub (#774, which moved it there from here); the article slot
 * lists the published articles; a tab returning from GitHub sign-in goes on
 * to the pane it came from; Coder is credited beside the intro on the index;
 * and nothing claims the host is onboarded to Azure Arc before it is (#663).
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { HelmetProvider } from 'react-helmet-async';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUN_LOCALLY_COMMANDS,
  allLabArticles,
  labs,
  labsForProvider,
  primaryProvider,
} from '@/data/labs/catalogue';
import {
  SIGN_IN_PENDING_KEY,
  markSignInStarted,
  readSignedInAt,
} from '@/components/labs/labSignIn';
import { NOT_PROVISIONED_SENTENCE } from '@/components/labs/LabsEstateCard';
import { CODER_NOT_PROVISIONED_SENTENCE } from '@/components/labs/CoderStatusCard';

const fetchLabsEstate = vi.fn();
const fetchCoderStatus = vi.fn();
vi.mock('@/lib/publicApi', () => ({
  fetchLabsEstate: () => fetchLabsEstate(),
  fetchCoderStatus: () => fetchCoderStatus(),
}));

import LabsLearnPage from './LabsLearnPage';

const NOW = Date.parse('2026-09-25T12:00:00Z');

const ESTATE = {
  configured: true,
  arc: {
    status: 'Connected',
    statusSince: new Date(NOW - 4 * 60_000).toISOString(),
    agentVersion: '1.52.02988.2222',
    osName: 'Ubuntu 24.04.3 LTS',
  },
  policy: { compliant: 12, nonCompliant: 1, notApplicable: 0 },
  agent: { online: true, queued: 0, lastHeartbeatAt: new Date(NOW - 10_000).toISOString() },
  coder: { reachable: true, running: 1, max: 5 },
  // Every age is measured from this, so "4 minutes ago" is exact.
  asOf: new Date(NOW).toISOString(),
};

const CODER = {
  configured: true,
  reachable: true,
  templates: [{ name: 'hcw-lab', activeVersion: 'v0.3.1' }],
  capacity: { running: 1, max: 5 },
  asOf: new Date(NOW - 20_000).toISOString(),
};

function renderPage(path = '/education/labs') {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/education/labs" element={<LabsLearnPage />} />
          <Route path="/:provider/education/labs" element={<LabsLearnPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>
  );
}

const unprovisioned = () => {
  fetchLabsEstate.mockResolvedValue({ configured: false });
  fetchCoderStatus.mockResolvedValue({ configured: false });
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOW));
  window.localStorage.clear();
  fetchLabsEstate.mockReset();
  fetchCoderStatus.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LabsLearnPage', () => {
  it('says both are unprovisioned when both routes answer configured: false', async () => {
    fetchLabsEstate.mockResolvedValue({ configured: false });
    fetchCoderStatus.mockResolvedValue({ configured: false });
    renderPage();

    expect(await screen.findByText(NOT_PROVISIONED_SENTENCE)).toBeInTheDocument();
    expect(await screen.findByText(CODER_NOT_PROVISIONED_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByTestId('estate-facts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('coder-templates')).not.toBeInTheDocument();
    expect(fetchLabsEstate).toHaveBeenCalledTimes(1);
    expect(fetchCoderStatus).toHaveBeenCalledTimes(1);
  });

  it('renders full data from both routes', async () => {
    fetchLabsEstate.mockResolvedValue(ESTATE);
    fetchCoderStatus.mockResolvedValue(CODER);
    renderPage();

    expect(await screen.findByTestId('estate-facts')).toBeInTheDocument();
    expect(screen.getByTestId('estate-arc-status')).toHaveTextContent('connected');
    expect(screen.getByTestId('estate-arc-since')).toHaveTextContent('4 minutes ago');
    expect(screen.getByTestId('estate-runner-heartbeat')).toHaveTextContent('just now');
    expect(screen.getByTestId('estate-coder')).toHaveTextContent('1 of 5 workspaces running');

    expect(await screen.findByTestId('coder-templates')).toBeInTheDocument();
    expect(screen.getByTestId('coder-status')).toHaveTextContent('1 of 5 workspaces running');
    expect(within(screen.getByTestId('coder-templates')).getByText('hcw-lab')).toBeInTheDocument();
  });

  it('renders one card per catalogue row, once each, grouped by home provider, with its facts', async () => {
    unprovisioned();
    const { container } = renderPage();

    const cards = [...container.querySelectorAll('li[data-lab]')];
    expect(cards.map((card) => card.dataset.lab)).toEqual(labs.map((lab) => lab.id));
    // Each group is headed by its provider and links to that provider's list.
    for (const provider of ['azure', 'aws', 'gcp', 'vmware', 'terraform', 'ansible', 'docker']) {
      const group = screen.getByTestId(`labs-group-${provider}`);
      expect(within(group).getByRole('heading', { level: 3 })).toBeInTheDocument();
      expect(within(group).getByRole('link', { name: /^All .* labs$/ })).toHaveAttribute(
        'href',
        `/${provider}/education/labs`
      );
    }

    for (const lab of labs) {
      const card = container.querySelector(`li[data-lab="${lab.id}"]`);
      // h4 under the group's h3, so the outline stays in order.
      expect(within(card).getByRole('heading', { level: 4 })).toHaveTextContent(lab.title);
      expect(within(card).getByText(lab.summary)).toBeInTheDocument();
      expect(within(card).getByText(lab.tools.join(', '))).toBeInTheDocument();
      expect(within(card).getByTestId('lab-minutes')).toHaveTextContent(
        `about ${lab.estimatedMinutes} minutes`
      );
      expect(within(card).getByTestId('lab-difficulty')).toBeInTheDocument();
    }
    await screen.findByText(NOT_PROVISIONED_SENTENCE);
  });

  it('sends each card to its own lab’s page under its home provider', async () => {
    unprovisioned();
    const { container } = renderPage();

    for (const lab of labs) {
      const card = container.querySelector(`li[data-lab="${lab.id}"]`);
      const link = within(card).getByTestId('open-lab-workspace');
      expect(link).toHaveAttribute('href', `/${primaryProvider(lab)}/education/labs/${lab.id}`);
      expect(link).not.toHaveAttribute('target');
    }
    // Since #750 a top-level visit to the workspace host lands back here, so
    // the page offers no link to it, in a card or in the prose.
    const labHosts = [...container.querySelectorAll('a[href]')]
      .map((a) => new URL(a.getAttribute('href'), 'https://hybridcloudworks.com').hostname)
      .filter(
        (host) => host === 'lab.hybridcloudworks.com' || host.endsWith('.lab.hybridcloudworks.com')
      );
    expect(labHosts).toEqual([]);
    expect(container.querySelector('header')).toHaveTextContent(/Open lab opens the lab/);
    await screen.findByText(NOT_PROVISIONED_SENTENCE);
  });

  it('sends a tab returning from GitHub sign-in on to the pane it started from, under the lab’s provider', async () => {
    unprovisioned();
    const [, lab] = labs;
    markSignInStarted(lab.id);
    render(
      <HelmetProvider>
        <MemoryRouter initialEntries={['/education/labs']}>
          <Routes>
            <Route path="/education/labs" element={<LabsLearnPage />} />
            <Route path="/:provider/education/labs/:labId" element={<p>pane for the lab</p>} />
            <Route path="/education/labs/:labId" element={<p>index pane</p>} />
          </Routes>
        </MemoryRouter>
      </HelmetProvider>
    );
    expect(await screen.findByText('pane for the lab')).toBeInTheDocument();
    expect(window.localStorage.getItem(SIGN_IN_PENDING_KEY)).toBeNull();
    expect(readSignedInAt()).toBeGreaterThanOrEqual(NOW);
  });

  it('explains Lab, Desktop and Agent in a learner’s words', async () => {
    unprovisioned();
    renderPage();
    const panel = screen.getByTestId('how-labs-work');
    expect(within(panel).getByRole('heading', { name: 'How labs work' })).toBeInTheDocument();
    for (const term of ['Lab', 'Desktop', 'Agent']) {
      expect(within(panel).getByText(term, { selector: 'dt' })).toBeInTheDocument();
    }
    // Visitor words: the panel names the workspace and the runner, never the
    // tools behind them (public-copy.test.js scans the component too).
    expect(panel.textContent).not.toMatch(/\bcoder\b|code-server|\bvps\b|hostinger/i);
    await screen.findByText(NOT_PROVISIONED_SENTENCE);
  });

  it('renders the hybrid lab pre-flight card before the lab catalogue (#Audit P2-2)', async () => {
    unprovisioned();
    renderPage();
    const card = screen.getByTestId('lab-preflight-card');
    expect(card).toBeInTheDocument();
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Hybrid Lab Pre-Flight Briefing'
    );
    expect(card).toHaveTextContent('15-Min Scenarios');
    expect(card).toHaveTextContent('read:user scope');
    await screen.findByText(NOT_PROVISIONED_SENTENCE);
  });

  it('says in one word how the workspaces are doing, in the shared vocabulary', async () => {
    fetchLabsEstate.mockResolvedValue({ configured: false });
    fetchCoderStatus.mockResolvedValue(CODER);
    renderPage();
    const badge = await screen.findByTestId('workspace-status');
    await waitFor(() => expect(badge).toHaveAttribute('data-status', 'healthy'));
    expect(badge).toHaveTextContent('Healthy');
  });

  it('prints the two Run it locally lines on every card, PowerShell then bash', async () => {
    fetchLabsEstate.mockResolvedValue({ configured: false });
    fetchCoderStatus.mockResolvedValue({ configured: false });
    const { container } = renderPage();

    for (const lab of labs) {
      const card = container.querySelector(`li[data-lab="${lab.id}"]`);
      expect(within(card).getByText('Run it locally')).toBeInTheDocument();
      const lines = [...card.querySelectorAll('pre code')];
      expect(lines.map((line) => line.dataset.shell)).toEqual(['PowerShell', 'bash']);
      expect(lines.map((line) => line.textContent)).toEqual(
        RUN_LOCALLY_COMMANDS.map((entry) => entry.command)
      );
      expect(lines[0].textContent).toBe(
        'docker run --rm -it -v ${PWD}:/workspace hybridcloudworks/hcw-lab:latest'
      );
      expect(lines[1].textContent).toBe(
        'docker run --rm -it -v "$PWD":/workspace hybridcloudworks/hcw-lab:latest'
      );
    }
    await screen.findByText(NOT_PROVISIONED_SENTENCE);
  });

  it('keeps the agent slot and its heading id, pointing at the recipe’s page in the Docker hub', async () => {
    fetchLabsEstate.mockResolvedValue({ configured: false });
    fetchCoderStatus.mockResolvedValue({ configured: false });
    renderPage();

    // An old link to /education/labs#agent-heading still lands on this heading.
    const agent = screen.getByTestId('labs-slot-agent');
    const heading = within(agent).getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('Run an agent against your landing zone');
    expect(heading).toHaveAttribute('id', 'agent-heading');
    expect(agent).not.toHaveTextContent('Coming soon');

    // One line and one link; the recipe itself is no longer here.
    expect(within(agent).getByRole('link', { name: 'Run an agent in a sandbox' })).toHaveAttribute(
      'href',
      '/docker/sandboxes'
    );
    expect(within(agent).queryAllByTestId('sandbox-step')).toHaveLength(0);
    expect(agent.querySelectorAll('pre code')).toHaveLength(0);
    await screen.findByText(NOT_PROVISIONED_SENTENCE);
  });

  it('lists the published articles the labs point at, once each, and promises nothing', async () => {
    unprovisioned();
    renderPage();

    const articles = screen.getByTestId('labs-slot-articles');
    expect(within(articles).getByRole('heading', { level: 2 })).toBeInTheDocument();
    const links = within(articles).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/azure/blog/build-a-landing-zone-you-can-read',
      '/terraform/blog/follow-along-in-one-container',
      '/terraform/blog/let-an-agent-explain-it',
    ]);
    expect(links).toHaveLength(allLabArticles().length);
    expect(articles).not.toHaveTextContent(/coming soon|#\d|issue/i);
    await screen.findByText(NOT_PROVISIONED_SENTENCE);
  });

  it('credits Coder beside the intro, in the header, after the intro paragraphs', async () => {
    fetchLabsEstate.mockResolvedValue({ configured: false });
    fetchCoderStatus.mockResolvedValue({ configured: false });
    const { container } = renderPage();

    const header = container.querySelector('header');
    const credit = within(header).getByTestId('coder-credit');
    const link = within(credit).getByRole('link', { name: 'Coder (opens in a new tab)' });
    expect(link).toHaveAttribute('href', 'https://coder.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(credit).getByRole('img', { name: 'Coder' })).toBeInTheDocument();
    expect(credit.querySelector('.coder-cursor')).not.toBeNull();

    // The intro and the credit share one row; the intro comes first, so it
    // reads first and sits in the left column.
    const intro = within(header).getByText(/Each lab below opens in VS Code/);
    expect(intro.parentElement.nextElementSibling).toBe(credit);
    expect(intro).toHaveClass('max-w-3xl');
    await screen.findByText(NOT_PROVISIONED_SENTENCE);
  });

  it('points to the estate card for the Arc state rather than asserting the host is onboarded', async () => {
    fetchLabsEstate.mockResolvedValue({ configured: false });
    fetchCoderStatus.mockResolvedValue({ configured: false });
    const { container } = renderPage();

    const header = container.querySelector('header');
    expect(header).toHaveTextContent(
      'a single server whose Azure Arc status is on the live card further down this page.'
    );
    // Onboarding (#663) has not run: nothing on the page may say it has.
    expect(container).not.toHaveTextContent(/onboarded/i);
    await screen.findByText(NOT_PROVISIONED_SENTENCE);
  });

  it('links back to the Learn index', async () => {
    fetchLabsEstate.mockResolvedValue({ configured: false });
    fetchCoderStatus.mockResolvedValue({ configured: false });
    renderPage();
    expect(screen.getByRole('link', { name: 'Learn any cloud' })).toHaveAttribute(
      'href',
      '/education'
    );
    await screen.findByText(NOT_PROVISIONED_SENTENCE);
  });
});

describe('a provider’s labs (/:provider/education/labs, ADR 0033)', () => {
  it('lists only the labs under that provider, linking each under it', async () => {
    unprovisioned();
    const { container } = renderPage('/terraform/education/labs');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Terraform labs');
    const cards = [...container.querySelectorAll('li[data-lab]')];
    expect(cards.map((card) => card.dataset.lab)).toEqual(
      labsForProvider('terraform').map((lab) => lab.id)
    );
    for (const card of cards) {
      expect(within(card).getByTestId('open-lab-workspace')).toHaveAttribute(
        'href',
        `/terraform/education/labs/${card.dataset.lab}`
      );
    }
    // The breadcrumb goes back through the provider's Learn page.
    expect(screen.getByRole('link', { name: 'Terraform Learn' })).toHaveAttribute(
      'href',
      '/terraform/education'
    );
    // The estate card and the Coder credit are the index's.
    expect(screen.queryByTestId('estate-card')).toBeNull();
    expect(screen.queryByTestId('coder-credit')).toBeNull();
    expect(fetchLabsEstate).not.toHaveBeenCalled();
    expect(screen.getByTestId('how-labs-work')).toBeInTheDocument();
    await waitFor(() => expect(fetchCoderStatus).toHaveBeenCalledTimes(1));
  });

  it('lists a lab shared by two hubs under both', async () => {
    unprovisioned();
    const { container } = renderPage('/azure/education/labs');
    const card = container.querySelector('li[data-lab="landing-zone-builder-output"]');
    expect(card).not.toBeNull();
    expect(within(card).getByTestId('open-lab-workspace')).toHaveAttribute(
      'href',
      '/azure/education/labs/landing-zone-builder-output'
    );
    await waitFor(() => expect(fetchCoderStatus).toHaveBeenCalledTimes(1));
  });

  it('says honestly when a provider has no lab yet, and points at the ones that do', async () => {
    unprovisioned();
    const { container } = renderPage('/github/education/labs');

    expect(container.querySelectorAll('li[data-lab]')).toHaveLength(0);
    const empty = screen.getByTestId('labs-empty');
    expect(empty).toHaveTextContent('There is no GitHub lab yet.');
    expect(within(empty).getByRole('link', { name: 'Azure' })).toHaveAttribute(
      'href',
      '/azure/education/labs'
    );
    expect(within(empty).getByRole('link', { name: 'Ansible' })).toHaveAttribute(
      'href',
      '/ansible/education/labs'
    );
    expect(within(empty).getByRole('link', { name: 'full list' })).toHaveAttribute(
      'href',
      '/education/labs'
    );
    expect(empty).not.toHaveTextContent(/coming soon/i);
    // No article slot either: nothing on this page points at one.
    expect(screen.queryByTestId('labs-slot-articles')).toBeNull();
    await waitFor(() => expect(fetchCoderStatus).toHaveBeenCalledTimes(1));
  });
});
