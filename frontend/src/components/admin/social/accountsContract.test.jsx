/**
 * The Social Hub's side of the Publer accounts contract (#397).
 *
 * #575 split SocialHubPage.jsx into one component per tab and moved this file
 * beside them. The assertions are the #397 ones unchanged, except where the
 * split moved what they read: the connected-account list left the Settings tab
 * for the new Accounts tab, so the tests that look for account names look
 * there.
 *
 * The bug these cover: both tabs tested the response with `Array.isArray`, and
 * the publerProxy answers with an envelope — `{ ok: true, status, data }`, or
 * `{ ok: false, code: 'INTEGRATION_NOT_CONFIGURED' }` when no key is seeded —
 * which is never an array. So a fully connected workspace rendered exactly like
 * an empty one, and so did a failed call. Every fixture here is therefore the
 * envelope the function actually returns; a bare array would be testing a shape
 * the server has never sent, which is how this stayed green while broken.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

import AccountsTab from './AccountsTab';
import ComposeTab from './ComposeTab';
import PublishedTab from './PublishedTab';
import QueueTab from './QueueTab';
import SettingsTab from './SettingsTab';

const getJSON = vi.fn();
const sendJSON = vi.fn();
const postJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
  postJSON: (...args) => postJSON(...args),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

// Settings links to the Accounts tab and to Integrations; there is no Router
// here, so `Link` is the anchor it renders as.
vi.mock('react-router', async () => {
  const React_ = await vi.importActual('react');
  return { Link: ({ to, children }) => React_.createElement('a', { href: to }, children) };
});

// Compose reads the published pages itself now (#575). This contract is about
// the ACCOUNTS call, so the content read is settled empty and out of the way.
vi.mock('@/lib/publicApi', () => ({ fetchPublicContentList: () => Promise.resolve([]) }));
vi.mock('@/lib/legacyBlogsTelemetry', () => ({ recordLegacyBlogsRead: vi.fn() }));

const accounts = [
  { id: 'acc-1', name: 'HCW on LinkedIn', provider: 'linkedin' },
  { id: 'acc-2', name: 'HCW on X', provider: 'twitter' },
];

/** What a configured estate returns: the envelope, with Publer's bare array inside `data`. */
const connected = { ok: true, status: 200, data: accounts };
/**
 * What an unseeded integration returns (functions/src/lib/integrations/rest-proxy.js).
 * The same code covers a missing PUBLER_API_KEY and a missing
 * PUBLER_WORKSPACE_ID; only `error` says which, so the page must not guess.
 */
const unseeded = {
  ok: false,
  code: 'INTEGRATION_NOT_CONFIGURED',
  error: 'Publer is not configured: PUBLER_WORKSPACE_ID is not set',
};
/**
 * Publer answered, and refused. The proxy passes that through as HTTP 200 with
 * `ok: false`, so this is a RESOLVED promise — nothing a `.catch()` will ever
 * see. Reading it as "no accounts" is the #397 conflation one layer down.
 */
const refused = { ok: false, status: 401, data: { error: 'Invalid API key' } };

beforeEach(() => {
  getJSON.mockReset().mockResolvedValue({ success: true, items: [] });
  sendJSON.mockReset().mockResolvedValue({ success: true });
  postJSON.mockReset().mockResolvedValue(unseeded);
  toast.mockReset();
});

describe('the Compose tab account picker', () => {
  it('lists the accounts a configured Publer returns inside the proxy envelope', async () => {
    postJSON.mockResolvedValue(connected);
    render(<ComposeTab />);

    expect(await screen.findByRole('button', { name: /HCW on LinkedIn/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /HCW on X/ })).toBeTruthy();
    expect(screen.queryByText(/No accounts found/)).toBeNull();
    expect(postJSON).toHaveBeenCalledWith('publerProxy', {
      path: '/accounts',
      method: 'GET',
      body: undefined,
    });
  });

  it('says the integration is unconfigured, naming the setting the server named', async () => {
    postJSON.mockResolvedValue(unseeded);
    render(<ComposeTab />);

    expect(await screen.findByText(/Publer is not connected/)).toBeTruthy();
    expect(screen.getByText(/PUBLER_WORKSPACE_ID is not set/)).toBeTruthy();
    expect(screen.getByText(/Connect it on the Accounts tab/)).toBeTruthy();
    // The two other empty states are wrong answers here and must not appear.
    expect(screen.queryByText(/No accounts found/)).toBeNull();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it('does not claim it is the API key when the server did not say which setting', async () => {
    postJSON.mockResolvedValue({ ok: false, code: 'INTEGRATION_NOT_CONFIGURED' });
    render(<ComposeTab />);

    // Either setting can produce this code, so the copy names both.
    expect(
      await screen.findByText(/PUBLER_API_KEY or PUBLER_WORKSPACE_ID is not set/)
    ).toBeTruthy();
  });

  it('says the call failed rather than showing an empty list', async () => {
    postJSON.mockRejectedValue(new Error('403 Forbidden'));
    render(<ComposeTab />);

    expect(await screen.findByText(/Publer accounts could not be loaded/)).toBeTruthy();
    expect(screen.getByText(/403 Forbidden/)).toBeTruthy();
    expect(screen.queryByText(/No accounts found/)).toBeNull();
  });

  it('treats a resolved not-ok envelope as a failure, with the upstream status', async () => {
    // The regression Copilot found on #402: this call RESOLVES, so a page that
    // only catches rejections shows a Publer 401 as an empty workspace.
    postJSON.mockResolvedValue(refused);
    render(<ComposeTab />);

    expect(await screen.findByText(/Publer accounts could not be loaded/)).toBeTruthy();
    expect(screen.getByText(/Publer answered 401/)).toBeTruthy();
    expect(screen.queryByText(/No accounts found/)).toBeNull();
    expect(screen.queryByText(/Publer is not connected/)).toBeNull();
  });

  it('says the workspace is empty only when Publer answered with no accounts', async () => {
    postJSON.mockResolvedValue({ ok: true, status: 200, data: [] });
    render(<ComposeTab />);

    expect(await screen.findByText(/No accounts found/)).toBeTruthy();
    expect(screen.queryByText(/Publer is not connected/)).toBeNull();
  });
});

describe('the Accounts tab', () => {
  it('lists the connected accounts from the envelope', async () => {
    postJSON.mockResolvedValue(connected);
    render(<AccountsTab />);

    expect(await screen.findByText('HCW on LinkedIn')).toBeTruthy();
    expect(screen.getByText('HCW on X')).toBeTruthy();
    // Supported Platforms is derived from the accounts, so it only appears once
    // the list is actually read.
    expect(screen.getByText('Supported Platforms')).toBeTruthy();
  });

  it('reports an unseeded key as unconfigured, naming the setting the server named', async () => {
    postJSON.mockResolvedValue(unseeded);
    render(<AccountsTab />);

    expect(await screen.findByText(/Publer is not connected/)).toBeTruthy();
    expect(screen.getByText(/PUBLER_WORKSPACE_ID is not set/)).toBeTruthy();
    // This tab holds the fix, so pointing at the Accounts tab would be a loop.
    expect(screen.queryByText(/Connect it on the Accounts tab/)).toBeNull();
    expect(screen.getByText(/Set both on the function app/)).toBeTruthy();
  });

  it('distinguishes a failed call from an empty workspace', async () => {
    postJSON.mockRejectedValue(new Error('upstream 500'));
    render(<AccountsTab />);

    expect(await screen.findByText(/Publer accounts could not be loaded/)).toBeTruthy();
    expect(screen.getByText(/upstream 500/)).toBeTruthy();
    expect(screen.queryByText(/No accounts found/)).toBeNull();
  });

  it('treats a resolved not-ok envelope as a failure', async () => {
    postJSON.mockResolvedValue(refused);
    render(<AccountsTab />);

    expect(await screen.findByText(/Publer accounts could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/No accounts found/)).toBeNull();
    // A rejected key is not an absent one; Supported Platforms stays away too.
    expect(screen.queryByText('Supported Platforms')).toBeNull();
    expect(screen.queryByText(/Publer is not connected/)).toBeNull();
  });
});

describe('the Settings tab', () => {
  it('reports the credential as usable when Publer answered', async () => {
    postJSON.mockResolvedValue(connected);
    render(<SettingsTab />);

    expect(
      await screen.findByText(/the proxy resolved its credentials and Publer answered/)
    ).toBeTruthy();
    // The account names moved to the Accounts tab; this one points at it
    // rather than listing them a second time.
    expect(screen.queryByText('HCW on LinkedIn')).toBeNull();
    expect(screen.getByRole('link', { name: /Accounts tab/ }).getAttribute('href')).toBe(
      '/admin/social-hub?tab=accounts'
    );
  });

  it('renders without a ReferenceError and reports an unseeded key as unconfigured', async () => {
    // The card used to call publerKey() and publerWsId(), neither of which is
    // defined anywhere in the bundle, so this tab threw before it painted.
    postJSON.mockResolvedValue(unseeded);
    render(<SettingsTab />);

    expect(await screen.findByText(/a required app setting is missing/)).toBeTruthy();
    // The tile names whichever setting the server named, so an operator does
    // not have to visit another tab to learn which one is missing.
    expect(screen.getByText(/PUBLER_WORKSPACE_ID is not set/)).toBeTruthy();
  });

  it('says the accounts call failed, with its reason, rather than going quiet', async () => {
    postJSON.mockRejectedValue(new Error('upstream 500'));
    render(<SettingsTab />);

    expect(await screen.findByText(/The accounts call failed/)).toBeTruthy();
    expect(screen.getByText(/upstream 500/)).toBeTruthy();
  });

  it('treats a resolved not-ok envelope as a failure, with the upstream status', async () => {
    postJSON.mockResolvedValue(refused);
    render(<SettingsTab />);

    // The tile carries the upstream status, so the operator can see that the
    // key was rejected rather than absent.
    expect(await screen.findByText(/The accounts call failed — Publer answered 401/)).toBeTruthy();
    expect(screen.queryByText(/a required app setting is missing/)).toBeNull();
  });

  it('asks the proxy exactly once', async () => {
    postJSON.mockResolvedValue(connected);
    render(<SettingsTab />);

    await screen.findByText(/the proxy resolved its credentials and Publer answered/);
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
  });
});

describe('the Scheduled Queue tab', () => {
  const scheduled = (overrides = {}) => ({
    id: 'post-1',
    text: 'New Azure article is live',
    network: 'linkedin',
    scheduled_at: '2026-09-20T10:00:00Z',
    accounts: [{ id: 'acc-1', name: 'HCW on LinkedIn' }],
    ...overrides,
  });

  it('renders Publer posts from { posts, total } instead of crashing on .map', async () => {
    postJSON.mockResolvedValue({ ok: true, status: 200, data: { posts: [scheduled()], total: 1 } });
    render(<QueueTab />);
    expect(await screen.findByText('New Azure article is live')).toBeTruthy();
    expect(screen.getByText('HCW on LinkedIn')).toBeTruthy();
    expect(postJSON).toHaveBeenCalledWith(
      'publerProxy',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('survives a malformed date and non-string fields in a Publer post', async () => {
    postJSON.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        posts: [
          scheduled({
            scheduled_at: 'not a date',
            text: { html: '<b>x</b>' },
            network: 42,
            accounts: [null],
          }),
        ],
      },
    });
    render(<QueueTab />);
    // No throw: the card renders with its fallbacks.
    expect(await screen.findByText('Publer Queue')).toBeTruthy();
    expect(screen.getAllByText('\u2014').length).toBeGreaterThan(0);
  });

  it('says Publer refused rather than showing an empty queue', async () => {
    postJSON.mockResolvedValue(refused);
    render(<QueueTab />);
    expect(await screen.findByText(/Could not read Publer: Publer answered 401/)).toBeTruthy();
    expect(screen.queryByText('No scheduled posts in Publer')).toBeNull();
  });

  it("says not configured, with the proxy's own sentence, for an unseeded key", async () => {
    postJSON.mockResolvedValue(unseeded);
    render(<QueueTab />);
    expect(await screen.findByText(/PUBLER_WORKSPACE_ID is not set/)).toBeTruthy();
  });
});

describe('the Published tab', () => {
  const published = (over = {}) => ({
    id: 'p-1',
    text: 'Shipped the Terraform module',
    network: 'linkedin',
    published_at: '2026-09-12T10:00:00Z',
    accounts: [{ id: 'acc-1', name: 'HCW on LinkedIn' }],
    ...over,
  });

  it('groups posts under the day they went out', async () => {
    getJSON.mockResolvedValue({ success: true, items: [] });
    postJSON.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        posts: [
          published(),
          published({ id: 'p-2', text: 'Older post', published_at: '2026-09-10T10:00:00Z' }),
        ],
      },
    });
    render(<PublishedTab ready={false} />);

    expect(await screen.findByText('Shipped the Terraform module')).toBeTruthy();
    // One labelled section per day, newest day first — the calendar #575 asked
    // for. The labels themselves are the viewer's local dates, so the ordering
    // is asserted through the posts rather than through a hard-coded date.
    const days = screen.getAllByRole('region');
    expect(days).toHaveLength(2);
    expect(within(days[0]).getByText('Shipped the Terraform module')).toBeTruthy();
    expect(within(days[1]).getByText('Older post')).toBeTruthy();
    expect(days[0].getAttribute('aria-label')).not.toBe(days[1].getAttribute('aria-label'));
  });

  it('shows a per-account failure Publer reported, rather than the post reading as sent', async () => {
    // The #463 mistake one layer up: a job whose accounts failed was reported
    // to the operator as a success.
    getJSON.mockResolvedValue({ success: true, items: [] });
    postJSON.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        posts: [
          published({
            accounts: [{ id: 'acc-1', name: 'HCW on X', status: 'failed', error: 'token expired' }],
          }),
        ],
      },
    });
    render(<PublishedTab ready={false} />);

    expect(await screen.findByText(/HCW on X: token expired/)).toBeTruthy();
  });

  it('says Publer refused rather than showing an empty history', async () => {
    getJSON.mockResolvedValue({ success: true, items: [] });
    postJSON.mockResolvedValue(refused);
    render(<PublishedTab ready={false} />);

    expect(await screen.findByText(/Could not read Publer: Publer answered 401/)).toBeTruthy();
    expect(screen.queryByText(/No published posts in Publer yet/)).toBeNull();
  });
});
