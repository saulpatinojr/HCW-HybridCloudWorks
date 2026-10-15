/**
 * The three outcomes the guard used to collapse into one (#503).
 *
 * The owner opened /admin/integrations, was told "Access Denied —
 * spatino@hybridcloudworks.com is not authorized", and was offered "Bootstrap
 * My Admin Access". His `admins` record was fine; the token had expired.
 * Signing out and back in "fixed" a problem that was never authorization.
 *
 * So these tests are written against the distinction rather than the wording:
 * a rejected token must never produce a denial, and the bootstrap button must
 * appear only when the server says bootstrapping would actually succeed. They
 * drive the real `useAdminAuth` — mocking the hook would test the mock, and
 * the defect lived in the seam between the hook and this component.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import AdminAuthGuard from './AdminAuthGuard';
import { clearAdminStatusCache } from '@/hooks/useAdminAuth';
import { useAdminRole } from '@/hooks/useAdminRole';

const authedFetch = vi.fn();
const postJSON = vi.fn();
const signIn = vi.fn();
const signOutUser = vi.fn();
const reauthenticateForApi = vi.fn();

let currentUser = { uid: 'oid-1', email: 'spatino@hybridcloudworks.com', displayName: 'Owner' };

vi.mock('@/lib/api', () => ({
  authedFetch: (...args) => authedFetch(...args),
  postJSON: (...args) => postJSON(...args),
}));

vi.mock('@/lib/entraAuth', () => ({
  onAuthStateChanged: (callback) => {
    callback(currentUser);
    return () => {};
  },
  signIn: (...args) => signIn(...args),
  signOutUser: (...args) => signOutUser(...args),
  reauthenticateForApi: (...args) => reauthenticateForApi(...args),
}));

/** What `authedFetch` resolves with on a 2xx: a Response-ish with .json(). */
const answers = (body) => authedFetch.mockResolvedValue({ json: async () => body });

/**
 * What `authedFetch` throws on a non-2xx — an Error carrying the status and,
 * since #517, whatever the API said in `WWW-Authenticate`.
 */
const fails = (status, message, wwwAuthenticate = {}) =>
  authedFetch.mockImplementation(async () => {
    const err = new Error(message);
    err.status = status;
    err.wwwAuthenticate = wwwAuthenticate;
    throw err;
  });

const Portal = () => <div>Admin portal</div>;
const renderGuard = () =>
  render(
    <AdminAuthGuard>
      <Portal />
    </AdminAuthGuard>
  );

beforeEach(() => {
  vi.clearAllMocks();
  clearAdminStatusCache();
  window.sessionStorage.clear();
  currentUser = { uid: 'oid-1', email: 'spatino@hybridcloudworks.com', displayName: 'Owner' };
  // The auto-recovery redirect never resolves in a browser — the page
  // navigates away. Resolving is close enough and keeps the test finite.
  reauthenticateForApi.mockResolvedValue(null);
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe('a rejected or unobtainable token', () => {
  it('never renders Access Denied — it re-authenticates instead', async () => {
    fails(401, 'Authentication required');
    renderGuard();

    await waitFor(() => expect(reauthenticateForApi).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Access Denied')).toBeNull();
    expect(screen.queryByRole('button', { name: /bootstrap/i })).toBeNull();
  });

  it('re-authenticates at most once per tab, then says so honestly', async () => {
    // The state after the redirect has already come back and the token is
    // still rejected — a misconfigured audience, not an expired session. The
    // second attempt would be an infinite redirect loop.
    window.sessionStorage.setItem('hcw.admin.session-recovery-attempted', '1');
    fails(401, 'Authentication required');
    renderGuard();

    expect(await screen.findByText('Could not verify your access')).toBeTruthy();
    expect(reauthenticateForApi).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /sign in again/i })).toBeTruthy();
    expect(screen.queryByText('Access Denied')).toBeNull();
    expect(screen.queryByRole('button', { name: /bootstrap/i })).toBeNull();
  });

  it('a token that could not be acquired at all is unknown, not denied', async () => {
    window.sessionStorage.setItem('hcw.admin.session-recovery-attempted', '1');
    authedFetch.mockImplementation(async () => {
      const err = new Error('Not authenticated. Please sign in.');
      err.authRecovery = 'reauthenticate';
      throw err;
    });
    renderGuard();

    expect(await screen.findByText('Could not verify your access')).toBeTruthy();
    expect(screen.queryByText('Access Denied')).toBeNull();
  });
});

describe('a 401 that says why (#517)', () => {
  // The distinction the whole of #517 exists to make. `insufficient_scope`
  // means the token verified and lacks a permission, so re-acquiring it returns
  // the same token and the same refusal. Redirecting would be a wasted round
  // trip that teaches the operator nothing.
  it('does not re-authenticate on insufficient_scope — the same token would come back', async () => {
    fails(401, 'Authentication required', {
      error: 'insufficient_scope',
      error_description: 'The access token is missing the access_as_admin scope.',
    });
    renderGuard();

    expect(await screen.findByText('Admin access is misconfigured')).toBeTruthy();
    expect(reauthenticateForApi).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /sign in again/i })).toBeNull();
    expect(screen.queryByText('Access Denied')).toBeNull();
  });

  it('shows what the API said, because someone has to go and change it', async () => {
    fails(401, 'Authentication required', {
      error: 'insufficient_scope',
      error_description: 'The access token is missing the access_as_admin scope.',
    });
    renderGuard();

    expect(await screen.findByText(/missing the access_as_admin scope/i)).toBeTruthy();
  });

  // A configuration failure must not burn the one automatic recovery either —
  // it is not a session problem, so the flag stays clean for a later expiry.
  it('leaves the once-per-tab recovery unspent', async () => {
    fails(401, 'Authentication required', { error: 'insufficient_scope' });
    renderGuard();

    await screen.findByText('Admin access is misconfigured');
    expect(window.sessionStorage.getItem('hcw.admin.session-recovery-attempted')).toBeNull();
  });

  it('still re-authenticates on invalid_token, which signing in does fix', async () => {
    fails(401, 'Authentication required', {
      error: 'invalid_token',
      error_description: 'jwt expired',
    });
    renderGuard();

    await waitFor(() => expect(reauthenticateForApi).toHaveBeenCalledTimes(1));
  });

  // An older API, or a proxy that strips the header, must behave exactly as it
  // did before #517 rather than falling into the new branch.
  it('treats a 401 with no challenge as a session problem, as before', async () => {
    fails(401, 'Authentication required');
    renderGuard();

    await waitFor(() => expect(reauthenticateForApi).toHaveBeenCalledTimes(1));
  });
});

describe('a check that could not run for any other reason', () => {
  it('offers a retry and never redirects — a 500 is not an expired session', async () => {
    fails(500, 'Failed to get admin status');
    renderGuard();

    expect(await screen.findByText('Could not verify your access')).toBeTruthy();
    expect(reauthenticateForApi).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByText('Access Denied')).toBeNull();
  });

  it('does not cache the failure, so the retry actually re-asks', async () => {
    fails(503, 'Service unavailable');
    renderGuard();
    await screen.findByText('Could not verify your access');
    const callsAfterFirstCheck = authedFetch.mock.calls.length;

    answers({ isAdmin: true, role: 'super_admin', permissions: ['manage:admins'] });
    screen.getByRole('button', { name: /try again/i }).click();

    expect(await screen.findByText('Admin portal')).toBeTruthy();
    expect(authedFetch.mock.calls.length).toBeGreaterThan(callsAfterFirstCheck);
  });
});

describe('an answer from the registry', () => {
  it('renders the portal for an admin', async () => {
    answers({ isAdmin: true, role: 'super_admin', permissions: ['manage:admins'] });
    renderGuard();

    expect(await screen.findByText('Admin portal')).toBeTruthy();
    expect(reauthenticateForApi).not.toHaveBeenCalled();
  });

  it('hands the verified role down to the portal, so the menu and the gates read it (AP-F4)', async () => {
    answers({ isAdmin: true, role: 'editor', permissions: [] });
    /** Prints the context's role, so the case reads what the guard handed down rather than what it fetched. */
    const RoleReader = () => <div>Role: {useAdminRole() ?? 'none'}</div>;
    render(
      <AdminAuthGuard>
        <RoleReader />
      </AdminAuthGuard>
    );

    expect(await screen.findByText('Role: editor')).toBeTruthy();
  });

  it('denies a genuine non-admin, and offers no bootstrap when the server says it would fail', async () => {
    answers({ isAdmin: false, uid: 'oid-1', email: 'someone@example.com', canBootstrap: false });
    renderGuard();

    expect(await screen.findByText('Access Denied')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /bootstrap/i })).toBeNull();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
  });

  it('offers bootstrap only when the server says it would succeed', async () => {
    answers({ isAdmin: false, uid: 'oid-1', email: 'first@example.com', canBootstrap: true });
    renderGuard();

    expect(await screen.findByText('Access Denied')).toBeTruthy();
    expect(screen.getByRole('button', { name: /bootstrap my admin access/i })).toBeTruthy();
  });

  it('re-arms the one automatic recovery, so the next expiry is handled quietly too', async () => {
    window.sessionStorage.setItem('hcw.admin.session-recovery-attempted', '1');
    answers({ isAdmin: true, role: 'editor', permissions: [] });
    renderGuard();

    await screen.findByText('Admin portal');
    expect(window.sessionStorage.getItem('hcw.admin.session-recovery-attempted')).toBeNull();
  });
});

describe('no session at all', () => {
  it('asks the visitor to sign in rather than telling them they are unauthorized', async () => {
    currentUser = null;
    renderGuard();

    expect(await screen.findByText('Admin Access Required')).toBeTruthy();
    expect(screen.queryByText('Access Denied')).toBeNull();
    expect(authedFetch).not.toHaveBeenCalled();
  });
});

describe('while the check runs (AP-F12, #936)', () => {
  it('shows a loading state with a status role and a label, not a bare ring', async () => {
    authedFetch.mockImplementation(() => new Promise(() => {}));
    renderGuard();

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Checking your access');
    expect(screen.queryByText('Admin portal')).toBeNull();
    expect(screen.queryByText('Access Denied')).toBeNull();
  });
});
