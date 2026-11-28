/**
 * The Ambassador hub page (ADR 0033 §4). What must hold: the header and five
 * tabs with Settings last; the not-provisioned state names the plan command
 * and nothing else; the Dashboard counts programs and pursuits and asks for
 * readiness; Programs starts an application; the workspace offers only the
 * allowed status moves and attaches evidence; the import picker marks what is
 * already in and posts the chosen ids; Settings disables with a PATCH.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

import AmbassadorPage from './AmbassadorPage';

const getJSON = vi.fn();
const postJSON = vi.fn();
const sendJSON = vi.fn();
const setSearchParams = vi.fn();
const navigate = vi.fn();
let searchParams = '';

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('react-router', () => ({
  useSearchParams: () => [new URLSearchParams(searchParams), setSearchParams],
  useLocation: () => ({ pathname: '/admin/ambassador' }),
  useNavigate: () => navigate,
  Link: ({ to, children, ...rest }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const PROGRAMS = [
  {
    id: 'program-first',
    docType: 'program',
    name: 'First Program',
    provider: 'Microsoft',
    category: 'community-expert',
    description: 'Community leadership.',
    enabled: true,
    order: 1,
    applicationWindow: { opens: null, closes: null, note: 'Rolling.' },
    requirements: [
      {
        id: 'talks',
        label: 'Speaking engagements',
        description: '',
        evidenceTypes: ['speaking'],
        minCount: 2,
        weight: 3,
      },
    ],
    eligibility: ['Nominated'],
    criteria: ['Impact'],
    recommendedActivities: [],
    reminders: { daysBeforeDeadline: 14, daysBeforeRenewal: 30 },
  },
  {
    id: 'program-another',
    docType: 'program',
    name: 'Another Program',
    provider: 'GitHub',
    category: 'community-expert',
    description: 'Another.',
    enabled: false,
    order: 2,
    applicationWindow: { opens: null, closes: null, note: '' },
    requirements: [],
  },
  // Additional to the first program: shown, and startable, only while the
  // first program's membership is Active (owner request 2026-10-05).
  {
    id: 'program-lead',
    docType: 'program',
    name: 'Leadership Role',
    provider: 'Microsoft',
    category: 'community-expert',
    description: 'Leads the region.',
    enabled: true,
    order: 3,
    parentProgramId: 'program-first',
    applicationWindow: { opens: null, closes: null, note: '' },
    requirements: [],
  },
];

/** The catalogue with the first program's membership Active, which opens the program additional to it. */
const PROGRAMS_FIRST_ACTIVE = PROGRAMS.map((p) =>
  p.id === 'program-first' ? { ...p, membershipStatus: 'active' } : p
);

const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const APPLICATIONS = [
  {
    id: 'application-1',
    docType: 'application',
    programId: 'program-first',
    title: 'First Program 2026',
    status: 'preparing',
    submissionDeadline: inDays(60),
    evidenceIds: [],
    responses: [],
    files: [],
    links: [],
    history: [
      {
        at: '2026-10-01T10:00:00.000Z',
        by: 'owner',
        from: null,
        to: 'interested',
        note: 'Created',
      },
    ],
    private: true,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
  },
];

const EVIDENCE = [
  {
    id: 'evidence-1',
    docType: 'evidence',
    title: 'KCDC talk',
    date: '2026-08-14',
    sourceModule: 'speaking',
    programIds: [],
    verificationStatus: 'unverified',
  },
];

const READINESS = {
  programId: 'program-first',
  score: 0,
  explanation:
    'Score is the weight of met requirements (0) over the total weight (3), as a percentage. Acceptance is decided by the program.',
  requirements: [
    {
      id: 'talks',
      label: 'Speaking engagements',
      minCount: 2,
      weight: 3,
      count: 1,
      met: false,
      items: [],
    },
  ],
  missing: [{ id: 'talks', label: 'Speaking engagements', shortfall: 1 }],
  expiring: [],
};

const routes =
  (over = {}) =>
  async (route) => {
    const table = {
      'cms/ambassador/programs': { items: PROGRAMS },
      'cms/ambassador/applications': { items: APPLICATIONS },
      'cms/ambassador/evidence': { items: EVIDENCE },
      'cms/ambassador/readiness/program-first': { readiness: READINESS },
      // The Pipeline pieces a program started (#1886): none unless a test says so.
      'cms/content': { success: true, items: [] },
      'cms/ambassador/evidence/sources/speaking': {
        items: [
          { id: 'event-1', title: 'KCDC talk', date: '2026-08-14', imported: true },
          { id: 'event-2', title: 'Meetup talk', date: '2026-09-01', imported: false },
        ],
      },
      ...over,
    };
    if (route in table) return table[route];
    if (route.split('?')[0] in table) return table[route.split('?')[0]];
    throw new Error(`unexpected route ${route}`);
  };

const hubTabs = () => within(screen.getByRole('tablist', { name: 'Ambassador Hub' }));
const panel = () => within(screen.getByRole('tabpanel'));

beforeEach(() => {
  searchParams = '';
  setSearchParams.mockReset();
  navigate.mockReset();
  toast.mockReset();
  getJSON.mockReset().mockImplementation(routes());
  postJSON
    .mockReset()
    .mockResolvedValue({ success: true, id: 'application-new', item: { id: 'application-new' } });
  sendJSON.mockReset().mockResolvedValue({ success: true, item: {} });
});

describe('header, tabs and the not-provisioned state', () => {
  it('names the hub, explains the goal in its help, and offers five tabs with Settings last', () => {
    render(<AmbassadorPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Ambassador' })).toBeInTheDocument();
    expect(
      hubTabs()
        .getAllByRole('tab')
        .map((t) => t.textContent)
    ).toEqual(['Dashboard', 'Programs', 'Applications', 'Evidence', 'Settings']);
    fireEvent.click(screen.getByRole('button', { name: /How this works/ }));
    expect(screen.getByText(/culminate in a credible application/)).toBeInTheDocument();
  });

  it('shows the plan command, and nothing else, when the API says NOT_PROVISIONED', async () => {
    getJSON.mockImplementation(async () => {
      const error = new Error('Run terraform apply for the ambassador container');
      error.status = 503;
      error.code = 'NOT_PROVISIONED';
      throw error;
    });
    render(<AmbassadorPage />);
    expect(await screen.findByText(/not provisioned yet/)).toBeInTheDocument();
    expect(screen.getByText('terraform -chdir=infra plan')).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load/)).not.toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Ambassador Hub' })).toBeInTheDocument();
  });
});

describe('Dashboard', () => {
  it('counts programs and pursuits, asks for readiness per pursued program, and lists what to do next', async () => {
    render(<AmbassadorPage />);
    const overview = within(await screen.findByRole('group', { name: 'Overview' }));
    expect(overview.getByText('Programs').nextSibling.textContent).toBe('1');
    expect(overview.getByText('Pursued').nextSibling.textContent).toBe('1');
    expect(await panel().findByText(/1 more speaking engagements needed/)).toBeInTheDocument();
    expect(getJSON).toHaveBeenCalledWith('cms/ambassador/readiness/program-first');
    expect(panel().getByText(/submission deadline/)).toBeInTheDocument();
  });
});

describe('Programs', () => {
  it('lists the catalogue with disabled programs marked, and starts an application', async () => {
    searchParams = 'tab=programs';
    render(<AmbassadorPage />);
    const cards = await panel().findAllByTestId('program-card');
    // The program additional to the first program is not a card while that
    // membership is not Active.
    expect(cards).toHaveLength(2);
    expect(panel().queryByText('Leadership Role')).not.toBeInTheDocument();
    expect(panel().getByTestId('additional-programs')).toHaveTextContent(
      'Additional requirements — Leadership Role — open when this membership is Active.'
    );
    expect(panel().getByText('Disabled')).toBeInTheDocument();
    const first = within(cards.find((c) => c.textContent.includes('First Program')));
    await act(async () => {
      fireEvent.click(first.getByRole('button', { name: /Start application/ }));
    });
    expect(postJSON).toHaveBeenCalledWith('cms/ambassador/applications', {
      programId: 'program-first',
    });
    await waitFor(() =>
      expect(setSearchParams).toHaveBeenCalledWith({
        tab: 'applications',
        application: 'application-new',
      })
    );
  });

  it('shows the program additional to the first program as its own card once its membership is Active', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(
      routes({ 'cms/ambassador/programs': { items: PROGRAMS_FIRST_ACTIVE } })
    );
    render(<AmbassadorPage />);
    const cards = await panel().findAllByTestId('program-card');
    // The additional program follows its parent, ahead of the disabled one.
    const names = ['First Program', 'Leadership Role', 'Another Program'];
    expect(cards.map((c) => names.find((n) => c.textContent.startsWith(n)))).toEqual(names);
    const lead = within(cards[1]);
    expect(lead.getByText(/additional to First Program/)).toBeInTheDocument();
    expect(panel().getByTestId('additional-programs')).toHaveTextContent(
      'Additional requirements open: Leadership Role.'
    );
    await act(async () => {
      fireEvent.click(lead.getByRole('button', { name: /Start application/ }));
    });
    expect(postJSON).toHaveBeenCalledWith('cms/ambassador/applications', {
      programId: 'program-lead',
    });
  });
});

// A held membership whose program asks for regular contributions each quarter.
const today = new Date();
const pad = (v) => String(v).padStart(2, '0');
const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const quarter = `Q${Math.floor(today.getMonth() / 3) + 1} ${today.getFullYear()}`;
const UPKEEP_PROGRAM = {
  id: 'program-example',
  docType: 'program',
  name: 'Example Program',
  provider: 'Example',
  category: 'developer-advocacy',
  description: 'Ambassadors.',
  enabled: true,
  order: 4,
  membershipStatus: 'active',
  applicationWindow: { opens: null, closes: null, note: 'Rolling applications.' },
  requirements: [],
  upkeep: { period: 'quarter', minCount: 2, evidenceTypes: [], note: 'Log each piece.' },
  contributionTrackerUrl: 'https://example.com/tracker',
};
const FILED = [
  { ...EVIDENCE[0], id: 'evidence-gk-1', date: day, programIds: ['program-example'] },
  // General evidence is not filed under the program, so it is not counted.
  { ...EVIDENCE[0], id: 'evidence-general', date: day, programIds: [] },
];

describe('Programs: a held membership’s activity requirement (2026-10-11)', () => {
  it('shows this quarter’s count and the tracker on a held membership’s card, and the rule in its details', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(
      routes({
        'cms/ambassador/programs': { items: [...PROGRAMS, UPKEEP_PROGRAM] },
        'cms/ambassador/evidence': { items: FILED },
        'cms/ambassador/readiness/program-example': {
          readiness: { ...READINESS, programId: 'program-example', requirements: [], missing: [] },
        },
      })
    );
    render(<AmbassadorPage />);
    const line = await panel().findByTestId('program-upkeep');
    expect(line).toHaveTextContent(`${quarter}: 1 of 2 filed here`);
    expect(within(line).getByRole('link', { name: /Contribution tracker/ })).toHaveAttribute(
      'href',
      'https://example.com/tracker'
    );
    const card = panel()
      .getAllByTestId('program-card')
      .find((c) => c.textContent.startsWith('Example Program'));
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Details' }));
    });
    const details = await screen.findByTestId('program-upkeep-details');
    expect(details).toHaveTextContent('At least 2 every quarter. Log each piece.');
    expect(details).toHaveTextContent(`${quarter}: 1 of 2 filed under this program`);
  });

  it('shows no count on a program that is not held', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(
      routes({
        'cms/ambassador/programs': {
          items: [...PROGRAMS, { ...UPKEEP_PROGRAM, membershipStatus: 'none' }],
        },
        'cms/ambassador/evidence': { items: FILED },
      })
    );
    render(<AmbassadorPage />);
    await panel().findAllByTestId('program-card');
    expect(panel().queryByTestId('program-upkeep')).not.toBeInTheDocument();
  });
});

describe('Programs: into the Pipeline and back (#1886)', () => {
  const LIVE_PIECE = {
    id: 'content-live',
    Title: 'Reading a busy commit graph',
    contentStatus: 'published',
    Live: true,
    originRef: { page: 'ambassador', id: 'program-example', part: null, label: 'Example Program' },
  };
  const DRAFT_PIECE = {
    id: 'content-draft',
    Title: 'Merge conflicts, calmly',
    contentStatus: 'drafting',
    Live: false,
    originRef: LIVE_PIECE.originRef,
  };
  const upkeepRoutes = (over = {}) =>
    routes({
      'cms/ambassador/programs': { items: [...PROGRAMS, UPKEEP_PROGRAM] },
      'cms/ambassador/evidence': { items: FILED },
      'cms/ambassador/readiness/program-example': {
        readiness: { ...READINESS, programId: 'program-example', requirements: [], missing: [] },
      },
      ...over,
    });
  const exampleCard = () =>
    panel()
      .getAllByTestId('program-card')
      .find((c) => c.textContent.startsWith('Example Program'));

  it('starts a draft for a held program from its card, tagged to the program, and opens it on Drafts', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(upkeepRoutes());
    postJSON.mockResolvedValue({ ok: true, draft: { id: 'draft-1' } });
    render(<AmbassadorPage />);
    await panel().findByTestId('program-upkeep');
    await act(async () => {
      fireEvent.click(within(exampleCard()).getByRole('button', { name: /Draft a piece/ }));
    });
    fireEvent.change(screen.getByLabelText('Working title'), {
      target: { value: 'Reading a busy commit graph' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    });
    expect(postJSON).toHaveBeenCalledWith('cms/drafts', {
      fields: { title: 'Reading a busy commit graph', tags: [] },
      originRef: { page: 'ambassador', id: 'program-example' },
    });
    expect(navigate).toHaveBeenCalledWith('/admin/drafts?draft=draft-1');
  });

  it('offers the draft button on a held program with no activity rule too (review of #1891)', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(
      upkeepRoutes({
        'cms/ambassador/programs': {
          items: [...PROGRAMS, { ...UPKEEP_PROGRAM, upkeep: null }],
        },
      })
    );
    render(<AmbassadorPage />);
    await panel().findAllByTestId('program-card');
    expect(
      within(exampleCard()).getByRole('button', { name: /Draft a piece/ })
    ).toBeInTheDocument();
  });

  it('offers no draft button on a program that is not held', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(
      upkeepRoutes({
        'cms/ambassador/programs': {
          items: [...PROGRAMS, { ...UPKEEP_PROGRAM, membershipStatus: 'none' }],
        },
      })
    );
    render(<AmbassadorPage />);
    await panel().findAllByTestId('program-card');
    expect(
      within(exampleCard()).queryByRole('button', { name: /Draft a piece/ })
    ).not.toBeInTheDocument();
  });

  it('lists the program’s pieces with their stage, and files a live one as evidence once', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(
      upkeepRoutes({ 'cms/content': { success: true, items: [LIVE_PIECE, DRAFT_PIECE] } })
    );
    // The route's real answer: the created rows, the existing ids, the missing ids.
    postJSON.mockResolvedValue({
      success: true,
      created: [{ id: 'evidence-import-x', sourceId: 'content-live' }],
      existing: [],
      missing: [],
    });
    render(<AmbassadorPage />);
    await panel().findByTestId('program-upkeep');
    await act(async () => {
      fireEvent.click(within(exampleCard()).getByRole('button', { name: 'Details' }));
    });
    const pipeline = await screen.findByTestId('program-pipeline');
    await within(pipeline).findByText('Reading a busy commit graph');
    expect(getJSON).toHaveBeenCalledWith(
      'cms/content?originPage=ambassador&originId=program-example&sort=updatedAt&limit=500'
    );
    expect(within(pipeline).getByText('Merge conflicts, calmly')).toBeInTheDocument();
    // Only the live piece can be filed; the draft is still in the Pipeline.
    const fileButtons = within(pipeline).getAllByRole('button', { name: /File as evidence/ });
    expect(fileButtons).toHaveLength(1);
    await act(async () => {
      fireEvent.click(fileButtons[0]);
    });
    expect(postJSON).toHaveBeenCalledWith('cms/ambassador/evidence/import', {
      sourceModule: 'content',
      ids: ['content-live'],
      programIds: ['program-example'],
    });
  });

  it('says "filed" only when the import filed this piece, and "not filed" when it was no longer live', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(
      upkeepRoutes({ 'cms/content': { success: true, items: [LIVE_PIECE] } })
    );
    render(<AmbassadorPage />);
    await panel().findByTestId('program-upkeep');
    await act(async () => {
      fireEvent.click(within(exampleCard()).getByRole('button', { name: 'Details' }));
    });
    const pipeline = await screen.findByTestId('program-pipeline');
    const fileButton = await within(pipeline).findByRole('button', { name: /File as evidence/ });

    postJSON.mockResolvedValueOnce({
      success: true,
      created: [],
      existing: [],
      missing: ['content-live'],
    });
    await act(async () => {
      fireEvent.click(fileButton);
    });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not filed' }));
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Filed as evidence for Example Program' })
    );

    postJSON.mockResolvedValueOnce({
      success: true,
      created: [{ id: 'evidence-import-z', sourceId: 'content-live' }],
      existing: [],
      missing: [],
    });
    await act(async () => {
      fireEvent.click(within(pipeline).getByRole('button', { name: /File as evidence/ }));
    });
    expect(toast).toHaveBeenCalledWith({ title: 'Filed as evidence for Example Program' });
  });

  it('marks a live piece already filed instead of offering it again', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(
      upkeepRoutes({
        'cms/content': { success: true, items: [LIVE_PIECE] },
        'cms/ambassador/evidence': {
          items: [
            ...FILED,
            {
              id: 'evidence-import-x',
              title: LIVE_PIECE.Title,
              date: '2026-11-20',
              sourceModule: 'content',
              sourceId: 'content-live',
              programIds: ['program-example'],
            },
          ],
        },
      })
    );
    render(<AmbassadorPage />);
    await panel().findByTestId('program-upkeep');
    await act(async () => {
      fireEvent.click(within(exampleCard()).getByRole('button', { name: 'Details' }));
    });
    const pipeline = await screen.findByTestId('program-pipeline');
    await within(pipeline).findByText('Filed as evidence');
    expect(
      within(pipeline).queryByRole('button', { name: /File as evidence/ })
    ).not.toBeInTheDocument();
  });

  it('points a piece filed under another program to Evidence instead of offering a filing that would change nothing', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(
      upkeepRoutes({
        'cms/content': { success: true, items: [LIVE_PIECE] },
        'cms/ambassador/evidence': {
          items: [
            ...FILED,
            {
              id: 'evidence-import-y',
              title: LIVE_PIECE.Title,
              date: '2026-11-20',
              sourceModule: 'content',
              sourceId: 'content-live',
              programIds: [],
            },
          ],
        },
      })
    );
    render(<AmbassadorPage />);
    await panel().findByTestId('program-upkeep');
    await act(async () => {
      fireEvent.click(within(exampleCard()).getByRole('button', { name: 'Details' }));
    });
    const pipeline = await screen.findByTestId('program-pipeline');
    const link = await within(pipeline).findByRole('link', { name: /not under this program/ });
    expect(link).toHaveAttribute('href', '/admin/ambassador?tab=evidence');
    expect(
      within(pipeline).queryByRole('button', { name: /File as evidence/ })
    ).not.toBeInTheDocument();
  });

  it('offers filing for a piece marked live the older way, as the import accepts it (review of #1891)', async () => {
    searchParams = 'tab=programs&program=program-example';
    getJSON.mockImplementation(
      upkeepRoutes({
        'cms/content': {
          success: true,
          items: [{ ...LIVE_PIECE, Live: undefined, contentStatus: 'approved', Status: 'Live' }],
        },
      })
    );
    render(<AmbassadorPage />);
    const pipeline = await screen.findByTestId('program-pipeline');
    expect(
      await within(pipeline).findByRole('button', { name: /File as evidence/ })
    ).toBeInTheDocument();
  });

  it('writes the open program into the address, and takes it out on close (review of #1891)', async () => {
    searchParams = 'tab=programs';
    getJSON.mockImplementation(upkeepRoutes());
    render(<AmbassadorPage />);
    await panel().findByTestId('program-upkeep');
    await act(async () => {
      fireEvent.click(within(exampleCard()).getByRole('button', { name: 'Details' }));
    });
    const opened = setSearchParams.mock.calls.at(-1)[0](new URLSearchParams('tab=programs'));
    expect(opened.get('program')).toBe('program-example');
    await act(async () => {
      fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    });
    const closed = setSearchParams.mock.calls.at(-1)[0](
      new URLSearchParams('tab=programs&program=program-example')
    );
    expect(closed.get('program')).toBeNull();
    expect(closed.get('tab')).toBe('programs');
  });

  it('says so when a link names a program no longer in the catalogue', async () => {
    searchParams = 'tab=programs&program=program-gone';
    window.history.pushState({}, '', '/admin/ambassador?tab=programs&program=program-gone');
    getJSON.mockImplementation(upkeepRoutes());
    try {
      render(<AmbassadorPage />);
      expect(
        await panel().findByText('The program that link names is no longer in the catalogue.')
      ).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('opens a program’s details from a Pipeline chip’s link (?program=)', async () => {
    searchParams = 'tab=programs&program=program-example';
    window.history.pushState({}, '', '/admin/ambassador?tab=programs&program=program-example');
    getJSON.mockImplementation(upkeepRoutes());
    try {
      render(<AmbassadorPage />);
      expect(await screen.findByTestId('program-pipeline')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('Applications', () => {
  it('opens the workspace with the allowed moves only, attaches evidence from the checklist, and records a status change with its note', async () => {
    searchParams = 'tab=applications&application=application-1';
    render(<AmbassadorPage />);
    const workspace = within(await screen.findByTestId('application-workspace'));
    const moves = within(workspace.getByLabelText('Move to'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(moves).toEqual(['Choose…', 'Ready', 'Interested', 'Withdrawn']);

    await act(async () => {
      fireEvent.click(await workspace.findByLabelText(/KCDC talk/));
    });
    expect(sendJSON).toHaveBeenCalledWith('cms/ambassador/applications/application-1', 'PATCH', {
      evidenceIds: ['evidence-1'],
    });

    fireEvent.change(workspace.getByLabelText('Move to'), { target: { value: 'ready' } });
    fireEvent.change(workspace.getByLabelText('Note for the history'), {
      target: { value: 'Two talks in' },
    });
    await act(async () => {
      fireEvent.click(workspace.getByRole('button', { name: 'Apply' }));
    });
    expect(sendJSON).toHaveBeenCalledWith('cms/ambassador/applications/application-1', 'PATCH', {
      status: 'ready',
      statusNote: 'Two talks in',
    });
    expect(workspace.getByText(/— Created/)).toBeInTheDocument(); // the history row
  });
});

describe('Evidence', () => {
  it('imports from Speaking through a picker that marks what is already in', async () => {
    searchParams = 'tab=evidence';
    postJSON.mockResolvedValue({
      success: true,
      created: [{ id: 'evidence-2' }],
      existing: [],
      missing: [],
    });
    render(<AmbassadorPage />);
    await panel().findAllByTestId('evidence-card');
    fireEvent.click(panel().getByRole('button', { name: /Import from Speaking/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByText('1 available · 1 already imported')).toBeInTheDocument();
    expect(dialog.getByLabelText(/KCDC talk/)).toBeDisabled();
    fireEvent.click(dialog.getByLabelText(/Meetup talk/));
    await act(async () => {
      fireEvent.click(dialog.getByRole('button', { name: /Import 1 item/ }));
    });
    expect(postJSON).toHaveBeenCalledWith('cms/ambassador/evidence/import', {
      sourceModule: 'speaking',
      ids: ['event-2'],
      programIds: [],
    });
  });
});

describe('Settings', () => {
  it('is last, and disables a program with a PATCH rather than a delete', async () => {
    searchParams = 'tab=settings';
    render(<AmbassadorPage />);
    const row = (await panel().findByText('First Program')).closest('tr');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Disable' }));
    });
    expect(sendJSON).toHaveBeenCalledWith('cms/ambassador/programs/program-first', 'PATCH', {
      enabled: false,
    });
    expect(sendJSON).not.toHaveBeenCalledWith(expect.anything(), 'DELETE');
  });

  it('sets membership on the program and the application state as an override, from the row', async () => {
    searchParams = 'tab=settings';
    render(<AmbassadorPage />);
    const row = (await panel().findByText('First Program')).closest('tr');
    await act(async () => {
      fireEvent.change(within(row).getByLabelText('Membership status for First Program'), {
        target: { value: 'working' },
      });
    });
    expect(sendJSON).toHaveBeenCalledWith('cms/ambassador/programs/program-first', 'PATCH', {
      membershipStatus: 'working',
    });
    // The latest application for the program is the one set, outside the funnel.
    const state = within(row).getByLabelText('Application state for First Program');
    expect(state).toHaveValue('preparing');
    await act(async () => {
      fireEvent.change(state, { target: { value: 'active' } });
    });
    expect(sendJSON).toHaveBeenCalledWith('cms/ambassador/applications/application-1', 'PATCH', {
      status: 'active',
      statusNote: 'Set from Settings',
      statusOverride: true,
    });
    // A program additional to another cannot be given an application state until
    // that membership is Active; the row says so and the API would refuse it.
    const lead = (await panel().findByText('Leadership Role')).closest('tr');
    expect(
      within(lead).getByText(/additional to First Program \(opens when Active\)/)
    ).toBeInTheDocument();
    expect(within(lead).getByLabelText('Application state for Leadership Role')).toBeDisabled();
    // A program with no application starts one at the chosen state.
    const another = (await panel().findByText('Another Program')).closest('tr');
    await act(async () => {
      fireEvent.change(within(another).getByLabelText('Application state for Another Program'), {
        target: { value: 'denied' },
      });
    });
    expect(postJSON).toHaveBeenCalledWith('cms/ambassador/applications', {
      programId: 'program-another',
      status: 'denied',
    });
  });
});

describe('saved qualification dates', () => {
  it('sends the same application period from the dashboard and workspace', async () => {
    const application = {
      ...APPLICATIONS[0],
      qualificationPeriod: { start: '2026-01-01', end: '2026-03-31' },
    };
    const route = 'cms/ambassador/readiness/program-first?period=2026-01-01..2026-03-31';
    getJSON.mockImplementation(
      routes({
        'cms/ambassador/applications': { items: [application] },
        [route]: { readiness: READINESS },
      })
    );
    const view = render(<AmbassadorPage />);
    await waitFor(() => expect(getJSON).toHaveBeenCalledWith(route));
    view.unmount();
    getJSON.mockClear();
    searchParams = 'tab=applications&application=application-1';
    render(<AmbassadorPage />);
    await waitFor(() => expect(getJSON).toHaveBeenCalledWith(route));
  });
});
