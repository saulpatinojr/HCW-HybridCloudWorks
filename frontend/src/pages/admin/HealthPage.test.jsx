/**
 * The Health Hub: the observed half and the verified half, a tab apart (#569).
 *
 * Most of what is held here is absence — the raw token, `oid`, `sub` and
 * `email` never reach the DOM, the report, or the clipboard. The pure halves
 * of the probes are tested in `health/probes.test.jsx`, the tab ids in
 * `health/tabs.test.js` and the snapshot's ordering in
 * `health/useOpsSnapshot.test.jsx`; this file is about what the page does with
 * them, and about the halves still being one hub: shared state, so a check run
 * on Checks is the check the strip and the report describe.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import HealthPage from './HealthPage';
import { LABS_PROBE_JOB } from './health/probes';
import { CODE_QUALITY } from './health/codeQuality.fixture';

const authedFetch = vi.fn();
const getJSON = vi.fn();
const postJSON = vi.fn();
// The stored-results PUT (cms/health/probe-results, #1011).
const sendJSON = vi.fn();
const acquireApiToken = vi.fn();
const getEndpoint = vi.fn((name) => `https://api.example.test/api/${name}`);
const runJob = vi.fn();
const toast = vi.fn();
const setSearchParams = vi.fn();
let searchParams = '';

vi.mock('@/lib/api', () => ({
  authedFetch: (...args) => authedFetch(...args),
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  getEndpoint: (...args) => getEndpoint(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/lib/jobs', () => ({ runJob: (...args) => runJob(...args) }));
vi.mock('@/lib/entraAuth', () => ({ acquireApiToken: (...args) => acquireApiToken(...args) }));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
// The URL is state here, not a fixed string: a tab click must actually move
// the page to that tab, or a test could never carry a result from Checks to
// Report. `setSearchParams` stays a spy so the write itself is asserted.
vi.mock('react-router', async () => {
  const { useState } = await import('react');
  return {
    // PageHeader reads the route to find its purpose sentence.
    useLocation: () => ({ pathname: '/admin/health', search: '' }),
    useSearchParams: () => {
      const [params, setParams] = useState(() => new URLSearchParams(searchParams));
      const set = (next) => {
        setSearchParams(next);
        setParams(new URLSearchParams(next));
      };
      return [params, set];
    },
    // The Code and Security tab's not-configured notice links to Integrations.
    Link: ({ to, children, ...rest }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  };
});

// ── A token that would be a disclosure if any of it leaked ───────────────────

const OID = 'a1b2c3d4-oid-of-the-person';
const EMAIL = 'owner@hcw.example';
const NOW_SECONDS = 1_800_000_000;

const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const CLAIMS = {
  aud: 'api://api-app-id',
  iss: 'https://login.microsoftonline.com/tenant-1/v2.0',
  tid: 'tenant-1',
  oid: OID,
  sub: 'sub-pairwise-id',
  email: EMAIL,
  preferred_username: EMAIL,
  name: 'The Owner',
  roles: ['Admin'],
  // Since #515 a token that reaches this page necessarily carries both.
  scp: 'access_as_admin',
  ver: '2.0',
  azp: 'spa-client-id',
  exp: NOW_SECONDS + 3600,
  iat: NOW_SECONDS,
};
const TOKEN = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(CLAIMS)}.signature-bytes`;

const EXPECTATIONS = {
  requiredScope: 'access_as_admin',
  requiredTokenVersion: '2.0',
  labAgentAppRole: 'LabAgent',
  expectedAudience: 'api://api-app-id',
  tenantId: 'tenant-1',
  adminAppRole: 'Admin',
  registryContainer: 'admins',
};

const ADMIN_STATUS = {
  isAdmin: true,
  uid: OID,
  email: EMAIL,
  role: 'super_admin',
  permissions: ['read:content', 'manage:admins'],
  active: true,
};

/** The observed half's one read. */
const SNAPSHOT = {
  success: true,
  readiness: {
    functionsConfigured: true,
    publishedItems: 14,
    missingSlugCount: 2,
    rssSources: 11,
  },
  digest: {
    digestDate: '2026-04-12',
    totalQueued: 8,
    recentRssCount: 5,
    publishingOps: {
      status: 'degraded',
      due: 4,
      published: 3,
      skipped: 1,
      failed: 1,
      // Every run is recorded now (#1010), so a last run is minutes old.
      lastRunAt: { toDate: () => new Date(Date.now() - 5 * 60 * 1000) },
    },
    publishingWatchdog: {
      overdueScheduledCount: 2,
      stagedTooLongCount: 1,
    },
  },
  alerts: [],
  operationalSignals: {
    queueBreachCount: 3,
    oldestStagedHours: 18,
    openAlertAgeHours: 6,
    publishFailureCount: 1,
    orphanedGeneratedImages: 2,
    lastSchedulerSuccessAt: { toDate: () => new Date('2026-04-12T09:00:00Z') },
  },
};

const jsonResponse = (status, body) => ({ status, ok: status < 400, json: async () => body });

/** Every string that must never appear on screen or in the report. */
const SECRETS = [TOKEN, OID, EMAIL, 'sub-pairwise-id', 'The Owner'];
const expectNoSecrets = (text) => {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
};

/**
 * The snapshot read shares `postJSON` with the Labs probe, so the probe's
 * call sequence is asserted on the lab calls rather than on every call the
 * page makes.
 */
const LAB_ROUTES = new Set(['getLabJob', 'cancelLabJob']);
const labCallNames = () =>
  postJSON.mock.calls.map(([name]) => name).filter((name) => LAB_ROUTES.has(name));

const snapshotAware = (impl) => async (name, body) => {
  if (name === 'getOpsHealthSnapshot') return SNAPSHOT;
  return impl(name, body);
};

beforeEach(() => {
  searchParams = '';
  window.sessionStorage.clear();
  setSearchParams.mockReset();
  acquireApiToken.mockReset().mockResolvedValue(TOKEN);
  getJSON.mockReset().mockResolvedValue(EXPECTATIONS);
  // The server stamps a recorded result with its own time and answers it back.
  sendJSON.mockReset().mockImplementation(async (_route, _method, body) => ({
    success: true,
    written: true,
    result: { ...body, checkedAt: new Date().toISOString(), checkedBy: 'admin' },
  }));
  runJob.mockReset();
  authedFetch.mockReset().mockImplementation(async (name) => {
    if (name === 'getCurrentAdminStatus') return jsonResponse(200, ADMIN_STATUS);
    if (name === 'enqueueLabJob') {
      return jsonResponse(200, { jobId: 'job-123', type: 'shell-echo', status: 'queued' });
    }
    throw new Error(`unexpected authedFetch ${name}`);
  });
  postJSON.mockReset().mockImplementation(
    snapshotAware(async (name, body) => {
      if (name === 'getLabJob') return { job: { id: body.jobId, status: postJSON.jobStatus } };
      if (name === 'cancelLabJob') {
        postJSON.jobStatus = 'cancelled';
        return { jobId: body.jobId, status: 'cancelled' };
      }
      throw new Error(`unexpected postJSON ${name}`);
    })
  );
  postJSON.jobStatus = 'queued';
  toast.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render the hub as a `?tab=` deep link would open it. */
const renderAt = (tab) => {
  searchParams = tab ? `tab=${tab}` : '';
  return render(<HealthPage />);
};
const hubTabs = () => within(screen.getByRole('tablist', { name: 'Health Hub' }));
const openTab = (label) => fireEvent.click(hubTabs().getByRole('tab', { name: label }));
const selectedTab = () => hubTabs().getByRole('tab', { selected: true }).textContent;
const copyButton = () => screen.getByText('Copy report').closest('button');
const reportText = () => screen.getByLabelText('Diagnostics report').textContent;

// A verdict line on the Checks tab that appears exactly once there, so it is
// waited on rather than a value the rows repeat.
const identityLoaded = () =>
  waitFor(() => expect(screen.getByText('Caller is an admin per the registry')).toBeTruthy());
const seen = (pattern) => expect(screen.getAllByText(pattern).length).toBeGreaterThan(0);
/** The identity run's own read, apart from the stored-results read the page also makes. */
const expectationReads = () =>
  getJSON.mock.calls.filter(([name]) => name === 'getAuthExpectations');
/** Every result the page recorded on the server, by probe id. */
const recorded = () =>
  sendJSON.mock.calls
    .filter(([route, method]) => route === 'cms/health/probe-results' && method === 'PUT')
    .map(([, , body]) => body);

/**
 * The verdict badge beside a given verdict line.
 *
 * `Verdict` renders `<Badge/>` and its sentence as siblings, and a tab can
 * hold more than one badge with the same word — so a panel-wide
 * `getByText('FAIL')` can match twice. Scoping to the row asserts the badge is
 * on the check it is about, which is what the assertion always meant.
 *
 * The same sentence appears in the report `<pre>` on the Report tab, so the
 * row is picked by element: `Verdict` puts its sentence in a `<span>`.
 */
const verdictBadge = (pattern) => {
  const sentence = screen.getAllByText(pattern).find((el) => el.tagName === 'SPAN');
  expect(sentence, `no verdict row matched ${pattern}`).toBeTruthy();
  return within(sentence.closest('div'));
};

// ── One hub, a tab per duty ──────────────────────────────────────────────────

describe('the hub', () => {
  it('always renders the header and the five tabs, Overview first', async () => {
    renderAt();
    expect(screen.getByRole('heading', { level: 1, name: 'Health' })).toBeTruthy();
    expect(
      hubTabs()
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
    ).toEqual(['Overview', 'Alerts', 'Checks', 'Code and Security', 'Report']);
    expect(selectedTab()).toBe('Overview');
    await screen.findByText('Queue SLA Breaches');
  });

  it('renders what the estate reports and what this session can prove, a tab apart', async () => {
    renderAt();

    // Observed: written by a timer, read once, nobody asked.
    expect(await screen.findByText('Queue SLA Breaches')).toBeTruthy();
    expect(screen.getByText('Publishing Operations')).toBeTruthy();
    openTab('Alerts');
    expect(screen.getByText('Workflow Alerts')).toBeTruthy();

    // Verified: nothing here was true until a button made it true.
    openTab('Checks');
    await identityLoaded();
    expect(screen.getByText('Token claims')).toBeTruthy();
    expect(screen.getByText('Admin registry')).toBeTruthy();
    expect(screen.getByText('Labs no-op probe')).toBeTruthy();
    expect(screen.queryByText('Queue SLA Breaches')).toBeNull();
  });

  it('opens the tab named in ?tab=, a moved id where its content went, and writes clicks', async () => {
    renderAt('report');
    expect(selectedTab()).toBe('Report');
    expect(screen.getByLabelText('Diagnostics report')).toBeTruthy();
    expect(screen.getByText('Copy report')).toBeTruthy();
    // Overview's cards and strip are not rendered behind it.
    expect(screen.queryByRole('group', { name: 'Health at a glance' })).toBeNull();
    expect(screen.queryByText('Pipeline Readiness')).toBeNull();
    expect(screen.queryByText('Token claims')).toBeNull();

    // A click on the tab already open writes nothing.
    openTab('Report');
    expect(setSearchParams).not.toHaveBeenCalled();
    openTab('Alerts');
    expect(setSearchParams).toHaveBeenCalledWith({ tab: 'alerts' });
    await waitFor(() => expect(screen.getByText('Workflow Alerts')).toBeTruthy());
  });

  it('lands the old Diagnostics id on Checks', async () => {
    renderAt('diagnostics');
    expect(selectedTab()).toBe('Checks');
    await identityLoaded();
  });

  it('puts the pipeline smoke tests on Checks, not among the metrics', async () => {
    // They fetch every RSS feed and write real documents. On the old Ops
    // Health page they sat among live counters and read as status.
    renderAt('checks');
    await identityLoaded();
    expect(screen.getByText('Pipeline Smoke Tests')).toBeTruthy();
    // By the tiles' own controls: "Reviewer Digest" names two different
    // things in this hub — the action here, and the readiness row on Overview
    // that reports the digest the action wrote.
    expect(screen.getByLabelText('Toggle RSS Fetch explanation')).toBeTruthy();
    expect(screen.getByLabelText('Toggle Batch Inspect explanation')).toBeTruthy();
    expect(screen.getByLabelText('Toggle Reviewer Digest explanation')).toBeTruthy();

    openTab('Overview');
    await screen.findByText('Pipeline Readiness');
    expect(screen.queryByText('Pipeline Smoke Tests')).toBeNull();
  });

  it('shows a live signal beside a probe verdict in the strip at the top of Overview', async () => {
    // The one place the two halves meet, and the reason they are one hub:
    // "Functions URL Ready" next to "Identity UNKNOWN" is a real state, and
    // it is invisible when the two live on different pages.
    renderAt();

    const glance = screen.getByRole('group', { name: 'Health at a glance' });
    // The identity run happens on load whatever tab is open. One vocabulary
    // (ADR 0033 §2): the words are lib/status.js's, here and on Integrations.
    await waitFor(() => expect(glance.textContent).toContain('Healthy'));
    // An observed signal…
    expect(glance.textContent).toContain('Runtime config');
    expect(glance.textContent).toContain('Open alerts');
    // …and a verified one, in the same strip.
    expect(glance.textContent).toContain('Identity');
    expect(glance.textContent).toContain('Labs probe');
    expect(glance.textContent).toContain('Unknown');
    expect(glance.textContent).not.toMatch(/PASS|FAIL|UNKNOWN/);
  });

  it('renders readiness and publishing metrics from the backend snapshot', async () => {
    renderAt();

    expect(await screen.findByRole('heading', { level: 1, name: 'Health' })).toBeInTheDocument();
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith('getOpsHealthSnapshot', {}));

    expect(await screen.findByText('14')).toBeInTheDocument();
    expect(screen.getAllByText('Degraded').length).toBeGreaterThanOrEqual(1);
    // Every block says when it was read (ADR 0033 §1 Platform), as a real time.
    expect(screen.getAllByText(/^Checked /).length).toBeGreaterThanOrEqual(3);
    // In the strip and on the readiness card: the placeholder "Functions URL
    // Ready" is gone from both.
    expect(screen.getAllByText('Runtime config').length).toBe(2);
    expect(screen.queryByText('Functions URL')).toBeNull();
    expect(screen.getByText('Queue SLA Breaches')).toBeInTheDocument();
    expect(screen.getByText('18h')).toBeInTheDocument();

    openTab('Alerts');
    expect(screen.getByText('No alerts in this filter.')).toBeInTheDocument();
  });

  it('does not refetch the snapshot or rerun identity when switching tabs', async () => {
    renderAt('checks');
    await identityLoaded();
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith('getOpsHealthSnapshot', {}));
    for (const label of ['Overview', 'Alerts', 'Report', 'Checks']) openTab(label);
    await identityLoaded();
    const snapshotReads = postJSON.mock.calls.filter(([name]) => name === 'getOpsHealthSnapshot');
    expect(snapshotReads).toHaveLength(1);
    expect(acquireApiToken).toHaveBeenCalledTimes(1);
  });
});

// ── A snapshot failure is two tabs' error, not the hub's ─────────────────────

describe('a snapshot that fails to load', () => {
  beforeEach(() => {
    postJSON.mockImplementation(async (name) => {
      if (name === 'getOpsHealthSnapshot') throw new Error('Snapshot refused: HTTP 503');
      throw new Error(`unexpected postJSON ${name}`);
    });
  });

  it('is an error on Overview and on Alerts, beside a strip that says UNKNOWN', async () => {
    renderAt();
    expect(screen.getByRole('heading', { level: 1, name: 'Health' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('Snapshot refused: HTTP 503');
    expect(screen.queryByText('Queue SLA Breaches')).toBeNull();
    // No default zeros standing in for counts nobody read.
    const glance = screen.getByRole('group', { name: 'Health at a glance' });
    expect(glance.textContent).not.toContain('Critical');
    expect(within(glance).getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);

    openTab('Alerts');
    expect(screen.getByRole('alert').textContent).toContain('Snapshot refused: HTTP 503');
    expect(screen.queryByText('Workflow Alerts')).toBeNull();
  });

  it('leaves Checks running identity and rendering Token claims', async () => {
    renderAt('checks');
    await identityLoaded();
    expect(screen.getByText('Token claims')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    openTab('Report');
    await waitFor(() => expect(copyButton().disabled).toBe(false));
    expect(reportText()).toContain('### Identity');
  });

  it('comes back on Try again', async () => {
    renderAt();
    await screen.findByRole('alert');
    postJSON.mockImplementation(snapshotAware(async () => ({})));
    fireEvent.click(screen.getByText('Try again'));
    expect(await screen.findByText('Queue SLA Breaches')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ── Alerts ────────────────────────────────────────────────────────────────────

describe('the Alerts tab', () => {
  const OPEN_ALERT = {
    id: 'alert-7',
    alertType: 'publish_failure',
    source: 'scheduler',
    severity: 'critical',
    status: 'open',
  };

  it('shows an alert action’s outcome on this tab, and re-reads the snapshot', async () => {
    let answered = false;
    postJSON.mockImplementation(async (name, body) => {
      if (name === 'getOpsHealthSnapshot') {
        return {
          ...SNAPSHOT,
          alerts: [{ ...OPEN_ALERT, status: answered ? 'acknowledged' : 'open' }],
        };
      }
      if (name === 'updateWorkflowAlert') {
        answered = true;
        return { success: true, alertId: body.alertId };
      }
      throw new Error(`unexpected postJSON ${name}`);
    });
    renderAt('alerts');

    fireEvent.click(await screen.findByText('Acknowledge'));
    expect(await screen.findByText('Acknowledged alert alert-7.')).toBeTruthy();
    expect(postJSON).toHaveBeenCalledWith('updateWorkflowAlert', {
      alertId: 'alert-7',
      action: 'acknowledge',
      resolutionNote: '',
    });
    await waitFor(() =>
      expect(postJSON.mock.calls.filter(([name]) => name === 'getOpsHealthSnapshot')).toHaveLength(
        2
      )
    );
    // The open filter no longer holds it once the re-read lands.
    await waitFor(() => expect(screen.getByText('No alerts in this filter.')).toBeTruthy());
    // Not on the smoke tests' card, which is not even on this tab.
    expect(screen.queryByText('Pipeline Smoke Tests')).toBeNull();
  });

  it('shows a refused alert action as this tab’s error', async () => {
    postJSON.mockImplementation(async (name) => {
      if (name === 'getOpsHealthSnapshot') return { ...SNAPSHOT, alerts: [OPEN_ALERT] };
      if (name === 'updateWorkflowAlert') throw new Error('Resolution note required');
      throw new Error(`unexpected postJSON ${name}`);
    });
    renderAt('alerts');
    fireEvent.click(await screen.findByText('Resolve'));
    expect(await screen.findByText('Resolution note required')).toBeTruthy();
    // The alert is still listed: a refused action does not blank the card.
    expect(screen.getByText('publish_failure')).toBeTruthy();
  });
});

// ── The probes ────────────────────────────────────────────────────────────────

describe('the Checks tab', () => {
  it('runs the identity checks on load and shows names, verdicts, and no person', async () => {
    const { container } = renderAt('checks');
    await identityLoaded();

    expect(acquireApiToken).toHaveBeenCalledTimes(1);
    expect(getJSON).toHaveBeenCalledWith('getAuthExpectations', { token: TOKEN });
    expect(authedFetch).toHaveBeenCalledWith('getCurrentAdminStatus', {
      method: 'GET',
      token: TOKEN,
    });

    seen(
      /aud, azp, email, exp, iat, iss, name, oid, preferred_username, roles, scp, sub, tid, ver/
    );
    expect(screen.getAllByText('Healthy').length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText('Critical')).toBeNull();
    expectNoSecrets(container.textContent);
  });

  it('decodes the very token it sends to getCurrentAdminStatus, from one refreshed acquisition', async () => {
    // authedFetch force-refreshes for getCurrentAdminStatus. If the panel
    // decoded a separately acquired (cached) token, a just-granted role could
    // read FAIL here while the API, on a fresh token, said isAdmin true.
    const STALE = `${b64url({ alg: 'RS256' })}.${b64url({ ...CLAIMS, roles: [] })}.sig`;
    acquireApiToken.mockReset().mockResolvedValueOnce(TOKEN).mockResolvedValue(STALE);
    renderAt('checks');
    await identityLoaded();

    // One acquisition for the whole identity run, with the refresh the API
    // call itself would have asked for.
    expect(acquireApiToken).toHaveBeenCalledTimes(1);
    expect(acquireApiToken).toHaveBeenCalledWith({ forceRefresh: true });
    // The bytes sent are the bytes decoded — handed to authedFetch as `token`,
    // which skips its own acquisition, so there is no second call at all.
    const [, init] = authedFetch.mock.calls.find(([name]) => name === 'getCurrentAdminStatus');
    expect(init.token).toBe(TOKEN);
    expect(init.token).not.toBe(STALE);
    expect(init.headers).toBeUndefined();
    // The expectations call rides the same acquisition — the run is ONE token,
    // not one per call.
    expect(expectationReads()).toHaveLength(1);
    expect(getJSON).toHaveBeenCalledWith('getAuthExpectations', { token: TOKEN });
    // And the claims panel reflects that same token: Admin present.
    expect(screen.getAllByText('Healthy').length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText('Critical')).toBeNull();
  });

  it('names a 200 with no JSON body from the status route instead of rendering a blank', async () => {
    authedFetch.mockImplementation(async (name) => {
      if (name === 'getCurrentAdminStatus') {
        return {
          status: 200,
          ok: true,
          json: async () => {
            throw new SyntaxError('Unexpected end of JSON input');
          },
        };
      }
      throw new Error(`unexpected authedFetch ${name}`);
    });
    renderAt('checks');
    await waitFor(() => seen(/status route answered 200 with no JSON body/));
    // Not an "isAdmin false" and not an empty paragraph — an explicit finding,
    // on the panel and in the report.
    expect(screen.queryByText('Caller is an admin per the registry')).toBeNull();
    openTab('Report');
    expect(reportText()).toContain(
      '- getCurrentAdminStatus: status route answered 200 with no JSON body'
    );
    expect(reportText()).toContain('- Result: Unknown (token or registry not read)');
  });

  it('reports the API refusing the token as unknown, with the refusal shown', async () => {
    getJSON.mockRejectedValue(new Error('Authentication required'));
    authedFetch.mockRejectedValue(new Error('Invalid token'));
    const { container } = renderAt('checks');
    // "Checks still running" lives on the Report tab now, so the refusal note
    // is the only role="status" here; waiting on it waits for the run to settle.
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Authentication required')
    );
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);
    // On the registry card and on the probe card that summarises it.
    expect(screen.getAllByText('Invalid token').length).toBeGreaterThanOrEqual(1);
    expectNoSecrets(container.textContent);
  });

  it('submits the probe as the Labs console would, reads it back, cancels it, and passes', async () => {
    renderAt('checks');
    await identityLoaded();

    fireEvent.click(screen.getByText('Run authenticated probe'));
    await waitFor(() => seen(/job-123/));

    expect(authedFetch).toHaveBeenCalledWith('enqueueLabJob', {
      method: 'POST',
      body: JSON.stringify(LABS_PROBE_JOB),
    });
    expect(LABS_PROBE_JOB).toEqual({ type: 'shell-echo', payload: '' });
    expect(labCallNames()).toEqual(['getLabJob', 'cancelLabJob', 'getLabJob']);
    expect(
      screen.getByText(/Authenticated no-op path — documented no-op response; document cancelled/)
    ).toBeTruthy();
  });

  it('shows a failed final read in the panel as unknown state, and fails the probe', async () => {
    let reads = 0;
    postJSON.mockImplementation(
      snapshotAware(async (name, body) => {
        if (name === 'getLabJob') {
          reads += 1;
          if (reads === 2) throw new Error('getLabJob timed out after 20s');
          return { job: { id: body.jobId, status: 'queued' } };
        }
        if (name === 'cancelLabJob') return { jobId: body.jobId, status: 'cancelled' };
        throw new Error(`unexpected postJSON ${name}`);
      })
    );
    renderAt('checks');
    await identityLoaded();

    fireEvent.click(screen.getByText('Run authenticated probe'));
    await waitFor(() => seen(/read failed \(getLabJob timed out after 20s\) — state unknown/));
    expect(verdictBadge(/Authenticated no-op path/).getByText('Critical')).toBeTruthy();
    expect(screen.queryByText(/still "queued"/)).toBeNull();
  });

  it('shows a 500 from enqueue as a failure rather than a crash', async () => {
    authedFetch.mockImplementation(async (name) => {
      if (name === 'getCurrentAdminStatus') return jsonResponse(200, ADMIN_STATUS);
      throw new Error('enqueueLabJob failed with HTTP 500. Try again or check the logs.');
    });
    renderAt('checks');
    await identityLoaded();

    fireEvent.click(screen.getByText('Run authenticated probe'));
    await waitFor(() => seen(/HTTP 500/));
    // The enqueue threw, so no lab route was reached. The snapshot read shares
    // this mock and is not part of the claim.
    expect(labCallNames()).toEqual([]);
    seen(/enqueueLabJob answered no status/);
  });

  it('sends the unauthenticated probe through plain fetch with no Authorization header', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { ok: false, error: 'Authentication required' })
    );
    vi.stubGlobal('fetch', fetchMock);
    renderAt('checks');
    await identityLoaded();
    acquireApiToken.mockClear();

    fireEvent.click(screen.getByText('Run unauthenticated probe'));
    await waitFor(() =>
      expect(screen.getByText(/HTTP 401 · Authentication required/)).toBeTruthy()
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetchMock.mock.calls;
    expect(url).toBe('https://api.example.test/api/enqueueLabJob');
    expect(init.method).toBe('POST');
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(init.body).toBe(JSON.stringify(LABS_PROBE_JOB));
    // No token was even acquired for this path.
    expect(acquireApiToken).not.toHaveBeenCalled();
    expect(screen.getByText(/Unauthenticated request refused — HTTP 401/)).toBeTruthy();
  });

  it('a probe that throws resets its busy flag, re-enables the buttons and shows the error', async () => {
    // A real seam, not a contrived one: an unset VITE_AZURE_FUNCTIONS_URL
    // makes getEndpoint throw before the request is even built.
    getEndpoint.mockImplementationOnce(() => {
      throw new Error('VITE_AZURE_FUNCTIONS_URL is not set, so enqueueLabJob cannot be called.');
    });
    vi.stubGlobal('fetch', vi.fn());
    renderAt('checks');
    await identityLoaded();

    fireEvent.click(screen.getByText('Run unauthenticated probe'));
    await waitFor(() => seen(/VITE_AZURE_FUNCTIONS_URL is not set/));

    // Not stuck: the busy flag was cleared in finally, so the button comes back.
    expect(screen.getByText('Run unauthenticated probe').closest('button').disabled).toBe(false);
    // Surfaced as a failed probe, and the report says the same.
    expect(verdictBadge(/Unauthenticated request refused/).getByText('Critical')).toBeTruthy();

    // …and so does Copy, on the tab it moved to.
    openTab('Report');
    expect(copyButton().disabled).toBe(false);
    expect(screen.queryByText(/Checks still running/)).toBeNull();
    expect(reportText()).toContain(
      'no Authorization header: Critical (VITE_AZURE_FUNCTIONS_URL is not set'
    );

    // The button is usable again: the next run goes through.
    openTab('Checks');
    fireEvent.click(screen.getByText('Run unauthenticated probe'));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it('a 200 on the unauthenticated probe is Critical, never a pass', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { jobId: 'leak' }))
    );
    renderAt('checks');
    await identityLoaded();
    fireEvent.click(screen.getByText('Run unauthenticated probe'));
    await waitFor(() =>
      expect(screen.getByText(/Unauthenticated request refused — HTTP 200/)).toBeTruthy()
    );
    expect(verdictBadge(/Unauthenticated request refused/).getByText('Critical')).toBeTruthy();
  });

  it('does not start a second identity run when Re-run is clicked during the first', async () => {
    // Hold the first run open. A second run started now would race it, and
    // whichever resolved last would win — so the click must be a no-op.
    let releaseToken;
    acquireApiToken.mockReturnValue(new Promise((resolve) => (releaseToken = resolve)));
    renderAt('checks');
    // The token is acquired after the dynamic entraAuth import resolves, so
    // the first call is a tick away from render.
    await waitFor(() => expect(acquireApiToken).toHaveBeenCalledTimes(1));

    const rerun = (await screen.findByText('Re-run identity checks')).closest('button');
    expect(rerun.disabled).toBe(true);
    // Even if the disabled attribute were bypassed, the in-flight gate holds.
    fireEvent.click(screen.getByText('Re-run identity checks'));
    fireEvent.click(screen.getByText('Re-run identity checks'));
    expect(acquireApiToken).toHaveBeenCalledTimes(1);
    expect(expectationReads()).toHaveLength(0);

    releaseToken(TOKEN);
    await identityLoaded();
    expect(acquireApiToken).toHaveBeenCalledTimes(1);
    expect(rerun.disabled).toBe(false);

    // Once settled, a click does run again — exactly once — and is gated while it runs.
    fireEvent.click(screen.getByText('Re-run identity checks'));
    await waitFor(() => expect(acquireApiToken).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText('Re-run identity checks'));
    expect(acquireApiToken).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(rerun.disabled).toBe(false));
  });
});

// ── Code and Security ────────────────────────────────────────────────────────

const codeQualityReads = () => getJSON.mock.calls.filter(([name]) => name === 'cms/code-quality');

/** Expectations for the identity run, and `body` (or a thrown error) for Qlty. */
const qltyAnswers = (answer) =>
  getJSON.mockImplementation(async (name) => {
    if (name !== 'cms/code-quality') return EXPECTATIONS;
    if (answer instanceof Error) throw answer;
    return answer;
  });

describe('the Code and Security tab', () => {
  it('is not read on page load, only when the tab is first opened, and once', async () => {
    qltyAnswers(CODE_QUALITY);
    renderAt();
    await screen.findByText('Queue SLA Breaches');
    expect(codeQualityReads()).toHaveLength(0);

    openTab('Code and Security');
    expect(await screen.findByRole('table', { name: 'Top rules' })).toBeTruthy();
    for (const label of ['Overview', 'Code and Security']) openTab(label);
    await screen.findByRole('table', { name: 'Top rules' });
    expect(codeQualityReads()).toHaveLength(1);
  });

  it('opens from ?tab=code and from an alias', async () => {
    qltyAnswers(CODE_QUALITY);
    renderAt('qlty');
    expect(selectedTab()).toBe('Code and Security');
    expect(await screen.findByRole('list', { name: 'Qlty grades' })).toBeTruthy();
  });

  it('shows not configured as a notice, not an error', async () => {
    qltyAnswers({
      ok: false,
      code: 'INTEGRATION_NOT_CONFIGURED',
      error: 'Qlty is not configured: QLTY_API_TOKEN is not set',
      projectUrl: CODE_QUALITY.projectUrl,
    });
    renderAt('code');
    expect(await screen.findByText('Qlty is not configured.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a refused read as this tab’s error and comes back on Try again', async () => {
    qltyAnswers(Object.assign(new Error('Qlty answered 502'), { status: 502 }));
    renderAt('code');
    expect((await screen.findByRole('alert')).textContent).toContain('Qlty answered 502');

    qltyAnswers(CODE_QUALITY);
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('table', { name: 'Top files' })).toBeTruthy();
  });

  it('adds its summary to the report only once it has loaded', async () => {
    qltyAnswers(CODE_QUALITY);
    renderAt('report');
    await waitFor(() => expect(copyButton().disabled).toBe(false));
    expect(reportText()).toContain('Code and Security: not loaded in this session.');
    expect(reportText()).not.toContain('### Code and Security');

    openTab('Code and Security');
    await screen.findByRole('table', { name: 'Top rules' });
    openTab('Report');
    expect(reportText()).toContain('### Code and Security — Qlty');
    expect(reportText()).toContain('- Security issues: 48');
    expect(reportText()).toContain('  - qlty:function-complexity (medium) — 400');
    expect(reportText()).not.toContain('not loaded in this session');
    expectNoSecrets(reportText());
  });
});

// ── The probe registry (ADR 0033 Platform) ───────────────────────────────────

describe('the probe registry on Checks', () => {
  const probeCard = (id) => document.querySelector(`[data-probe="${id}"]`);
  const summaryOf = (id) => within(probeCard(id)).getByTestId('probe-summary').textContent;
  const badgeOf = (id) => probeCard(id).querySelector('[data-status]').getAttribute('data-status');

  it('shows one card per hub dependency, in hub groups, each with impact, fix and a link', async () => {
    renderAt('checks');
    await identityLoaded();
    const grid = screen.getByRole('region', { name: 'Probe registry' });
    for (const hub of ['Pipeline', 'Creative', 'Amplify', 'Enhanced', 'Spotlight', 'Platform']) {
      expect(within(grid).getByText(hub)).toBeTruthy();
    }
    for (const id of [
      'publer',
      'ai-providers',
      'lab-agents',
      'cosmos',
      'runtime-config',
      'elevenlabs',
    ]) {
      const card = probeCard(id);
      expect(card, `no card for ${id}`).toBeTruthy();
      expect(within(card).getByText('Impact')).toBeTruthy();
      expect(within(card).getByText('Fix')).toBeTruthy();
      expect(within(card).getByRole('link')).toBeTruthy();
    }
  });

  it('evaluates snapshot and session probes from page state, in the shared words', async () => {
    renderAt('checks');
    await identityLoaded();
    // Snapshot-backed: readiness is configured in the fixture.
    expect(badgeOf('cosmos')).toBe('healthy');
    expect(badgeOf('runtime-config')).toBe('healthy');
    expect(badgeOf('scheduled-publishing')).toBe('degraded');
    expect(badgeOf('publishing-failures')).toBe('degraded');
    // Session-backed: the identity run passed.
    expect(badgeOf('identity-token')).toBe('healthy');
    expect(badgeOf('admin-registry')).toBe('healthy');
    // Not pressed yet.
    expect(badgeOf('labs-noop')).toBe('unknown');
    expect(badgeOf('publer')).toBe('unknown');
    expect(summaryOf('publer')).toBe('Not tested yet.');
  });

  it('runs a service probe from its card with the Integrations test, and keeps the result across tabs', async () => {
    postJSON.mockImplementation(
      snapshotAware(async (name) => {
        if (name === 'publerProxy') return { ok: true, status: 200, data: { accounts: [{}, {}] } };
        throw new Error(`unexpected postJSON ${name}`);
      })
    );
    renderAt('checks');
    await identityLoaded();
    fireEvent.click(within(probeCard('publer')).getByRole('button', { name: 'Test Publer' }));
    await waitFor(() => expect(badgeOf('publer')).toBe('healthy'));
    expect(summaryOf('publer')).toContain('2 social account(s)');
    expect(postJSON).toHaveBeenCalledWith('publerProxy', { path: '/accounts', method: 'GET' });

    openTab('Report');
    expect(reportText()).toContain('### Probe registry');
    expect(reportText()).toMatch(/- Publer: Healthy \(.+\) — Connected — 2 social account\(s\)\./);
    openTab('Checks');
    expect(badgeOf('publer')).toBe('healthy');
    // And it is recorded on the server, where a reload, a new tab or the next
    // sign-in reads it back (#1011) — the browser tab no longer holds it alone.
    await waitFor(() =>
      expect(recorded()).toContainEqual(
        expect.objectContaining({
          probeId: 'publer',
          status: 'healthy',
          summary: 'Connected — 2 social account(s).',
          durationMs: expect.any(Number),
        })
      )
    );
  });

  it('reports a refused service and a missing key as critical, and one that did not answer as offline', async () => {
    postJSON.mockImplementation(
      snapshotAware(async (name, body) => {
        if (name === 'publerProxy') return { ok: false, status: 403, error: 'Forbidden' };
        if (name === 'connectionProbe' && body.probe === 'resend') {
          return {
            ok: false,
            error: 'Resend is not configured: RESEND_API_KEY is not set',
            code: 'INTEGRATION_NOT_CONFIGURED',
          };
        }
        if (name === 'connectionProbe' && body.probe === 'telegram') {
          throw new TypeError('Failed to fetch');
        }
        throw new Error(`unexpected postJSON ${name}`);
      })
    );
    renderAt('checks');
    await identityLoaded();
    fireEvent.click(within(probeCard('publer')).getByRole('button', { name: 'Test Publer' }));
    fireEvent.click(within(probeCard('resend')).getByRole('button', { name: 'Test Resend' }));
    fireEvent.click(within(probeCard('telegram')).getByRole('button', { name: 'Test Telegram' }));
    await waitFor(() => expect(badgeOf('publer')).toBe('critical'));
    await waitFor(() => expect(badgeOf('resend')).toBe('critical'));
    await waitFor(() => expect(badgeOf('telegram')).toBe('offline'));
    expect(summaryOf('publer')).toMatch(/Forbidden/);
    // Offline looks unlike Critical, not only in colour.
    expect(within(probeCard('telegram')).getByText('Offline')).toBeTruthy();
  });

  it('shows the last recorded result on load, with its age, and a stale one as Unknown beside its last value', async () => {
    const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();
    getJSON.mockImplementation(async (name) => {
      if (name !== 'cms/health/probe-results') return EXPECTATIONS;
      return {
        success: true,
        results: {
          publer: {
            probeId: 'publer',
            status: 'healthy',
            summary: 'Connected — 3 social account(s).',
            checkedAt: minutesAgo(12),
            checkedBy: 'admin',
          },
          // Recorded by the pulse 40 minutes ago, past its 15-minute window.
          'lab-agents': {
            probeId: 'lab-agents',
            status: 'healthy',
            summary: '1 agent online.',
            checkedAt: minutesAgo(40),
            checkedBy: 'pulse',
          },
          // Stored under the word used until 2026-10-08.
          resend: {
            probeId: 'resend',
            status: 'misconfigured',
            summary: 'Resend is not configured.',
            checkedAt: minutesAgo(5),
            checkedBy: 'admin',
          },
        },
        pulse: { lastBeatAt: minutesAgo(3), intervalMs: 300000, lateAfterMs: 900000 },
      };
    });
    renderAt('checks');
    await waitFor(() => expect(badgeOf('publer')).toBe('healthy'));
    expect(summaryOf('publer')).toBe('Connected — 3 social account(s).');
    expect(within(probeCard('publer')).getByTestId('probe-checked').textContent).toMatch(
      /^12 min ago · .+ · by an admin$/
    );
    expect(badgeOf('resend')).toBe('critical');

    expect(badgeOf('lab-agents')).toBe('unknown');
    expect(summaryOf('lab-agents')).toBe('1 agent online.');
    expect(within(probeCard('lab-agents')).getByTestId('probe-stale').textContent).toMatch(
      /Stale: last Healthy, older than its 15 min window/
    );
    expect(within(probeCard('lab-agents')).getByTestId('probe-checked').textContent).toMatch(
      /^40 min ago · .+ · by the pulse$/
    );

    const pulse = screen.getByRole('group', { name: 'Health pulse' });
    expect(within(pulse).getByTestId('pulse-line').textContent).toMatch(
      /Pulse\s*Healthy\s*every 5 min, last beat 3 min ago\./
    );
  });

  it('turns the hub Offline when the pulse is late, and Unknown before it has ever beaten', async () => {
    const late = new Date(Date.now() - 47 * 60 * 1000).toISOString();
    getJSON.mockImplementation(async (name) =>
      name === 'cms/health/probe-results'
        ? { success: true, results: {}, pulse: { lastBeatAt: late, intervalMs: 300000 } }
        : EXPECTATIONS
    );
    const { unmount } = renderAt('checks');
    const hub = () => screen.getByTestId('hub-status').querySelector('[data-status]');
    await waitFor(() => expect(hub().getAttribute('data-status')).toBe('offline'));
    expect(screen.getByTestId('pulse-line').textContent).toMatch(
      /is late: every 5 min, last beat 47 min ago/
    );
    unmount();

    // The first render's read is in this tab's cache: the server's answer,
    // with no pulse in it, replaces it once it lands.
    getJSON.mockImplementation(async () => EXPECTATIONS);
    renderAt('checks');
    await identityLoaded();
    await waitFor(() => expect(hub().getAttribute('data-status')).toBe('unknown'));
    expect(screen.getByTestId('pulse-line').textContent).toMatch(/has not reported yet/);
  });

  it('records the session checks it ran — the identity read — once per run', async () => {
    renderAt('checks');
    await identityLoaded();
    await waitFor(() =>
      expect(recorded().map((body) => body.probeId)).toEqual(
        expect.arrayContaining(['identity-token', 'admin-registry'])
      )
    );
    const identityWrites = recorded().filter((body) => body.probeId === 'identity-token');
    expect(identityWrites).toHaveLength(1);
    expect(identityWrites[0]).toMatchObject({
      status: 'healthy',
      summary: 'every comparison holds',
    });
    // What is recorded is the summary the page shows: no claim value, no person.
    expectNoSecrets(JSON.stringify(recorded()));
  });

  it('leaves the probes that write or spend out of Test all, and says so on their cards', async () => {
    renderAt('checks');
    await identityLoaded();
    for (const id of ['rss-fetch', 'labs-noop', 'youtube']) {
      expect(within(probeCard(id)).getByText(/Not in Test all/)).toBeTruthy();
    }
    expect(within(probeCard('resend')).queryByText(/Not in Test all/)).toBeNull();
  });
});

// ── The report ────────────────────────────────────────────────────────────────

describe('the Report tab', () => {
  it('keeps Copy report disabled until the identity checks have settled', async () => {
    // Hold the token acquisition open so the first run cannot settle.
    let releaseToken;
    acquireApiToken.mockReturnValue(new Promise((resolve) => (releaseToken = resolve)));
    renderAt('report');
    // Nothing waits on the snapshot any more: the tab renders at once.
    const copy = copyButton();

    expect(copy.disabled).toBe(true);
    expect(screen.getByText(/Checks still running/)).toBeTruthy();
    // The on-screen report says the same thing, so a manual select-and-copy
    // cannot produce a false "could not be read" either.
    expect(reportText()).toContain('STILL RUNNING');
    expect(reportText()).not.toContain('could not be read');

    releaseToken(TOKEN);
    await waitFor(() => expect(copy.disabled).toBe(false));
    expect(screen.queryByText(/Checks still running/)).toBeNull();
  });

  it('disables Copy report again while a probe started on Checks is in flight', async () => {
    let releaseEnqueue;
    authedFetch.mockImplementation(async (name) => {
      if (name === 'getCurrentAdminStatus') return jsonResponse(200, ADMIN_STATUS);
      return new Promise((resolve) => (releaseEnqueue = resolve));
    });
    renderAt('checks');
    await identityLoaded();

    fireEvent.click(screen.getByText('Run authenticated probe'));
    // The probe belongs to the page, not the Checks panel: leaving the tab
    // neither cancels it nor lets Copy through while it runs.
    openTab('Report');
    await waitFor(() => expect(copyButton().disabled).toBe(true));
    expect(screen.getByText(/Checks still running/)).toBeTruthy();

    releaseEnqueue(jsonResponse(200, { jobId: 'job-123', type: 'shell-echo', status: 'queued' }));
    await waitFor(() => expect(copyButton().disabled).toBe(false));
    expect(reportText()).toContain('job-123');
  });

  it('reports a check run on the Checks tab', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { ok: false, error: 'Authentication required' }))
    );
    renderAt('checks');
    await identityLoaded();
    fireEvent.click(screen.getByText('Run unauthenticated probe'));
    await waitFor(() => seen(/Unauthenticated request refused — HTTP 401/));

    openTab('Report');
    await waitFor(() => expect(copyButton().disabled).toBe(false));
    expect(reportText()).toContain('- enqueueLabJob with no Authorization header: Healthy');
    expectNoSecrets(reportText());
  });

  it('copies the report — the same summary, never the token, naming no ticket', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderAt('checks');
    await identityLoaded();
    openTab('Report');

    fireEvent.click(screen.getByText('Copy report'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const [[copied]] = writeText.mock.calls;
    expect(copied).toContain('### Identity — token claims and admin registry');
    expect(copied).toContain('### Labs no-op probe');
    expect(copied).toContain('Registry uid equals token oid: Healthy');
    // #355 and #356 closed on 2026-09-07 by this page's first run. The report
    // is a repeatable check now, and names no ticket.
    expect(copied).not.toMatch(/#3\d\d/);
    expectNoSecrets(copied);
    expectNoSecrets(document.body.textContent);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Report copied' }));
  });

  it('says so when the clipboard is unavailable, and leaves the report on screen', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    renderAt('report');
    await waitFor(() => expect(copyButton().disabled).toBe(false));

    fireEvent.click(screen.getByText('Copy report'));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }))
    );
    expect(reportText()).toContain('### Identity');
  });
});
