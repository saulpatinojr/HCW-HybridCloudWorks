/**
 * The OAuth Connect states on an MCP server card (2026-10-08): amber
 * "Not connected" with Connect, amber "Sign-in expired" with Connect, green
 * Connected with the scope, the token's expiry, Reconnect and Disconnect —
 * and the banner the callback page's result lands in.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const startMcpOAuth = vi.fn();
const disconnectMcpOAuth = vi.fn();
const toast = vi.fn();
const hardAssign = vi.fn();

vi.mock('@/lib/aiEngine', () => ({
  aiEngine: {
    startMcpOAuth: (...a) => startMcpOAuth(...a),
    disconnectMcpOAuth: (...a) => disconnectMcpOAuth(...a),
  },
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/hardNavigate', () => ({ hardAssign: (...a) => hardAssign(...a) }));

const {
  default: McpOAuthPanel,
  McpOAuthResultBanner,
  OAuthStateBadge,
  disconnectToast,
  formatUtc,
  issuerHost,
  oauthCardState,
  usesOAuthConnect,
} = await import('./McpOAuth.jsx');

const hostinger = (over = {}) => ({
  id: 'hostinger-mcp',
  name: 'Hostinger MCP',
  url: 'https://mcp.hostinger.com',
  authType: 'oauth',
  ...over,
});
const connected = (over = {}) =>
  hostinger({
    hasOauthToken: true,
    oauth: { status: 'connected', scope: 'mcp:use', expiresAt: '2026-10-08T13:00:00.000Z' },
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('which cards use Connect, and in what state', () => {
  it('is Connect for authType oauth, except Plaud’s pasted token', () => {
    expect(usesOAuthConnect(hostinger())).toBe(true);
    expect(usesOAuthConnect({ id: 'plaud', authType: 'oauth' })).toBe(false);
    expect(usesOAuthConnect({ id: 'firecrawl', apiKeyEnvVar: 'FIRECRAWL_API_KEY' })).toBe(false);
  });

  it('reads the state from the readable oauth fields and the token’s presence', () => {
    expect(oauthCardState(hostinger())).toBe('not_connected');
    expect(oauthCardState(connected())).toBe('connected');
    // The metadata alone, without a stored token, is not a connection.
    expect(oauthCardState(connected({ hasOauthToken: false }))).toBe('not_connected');
    expect(oauthCardState(hostinger({ oauth: { status: 'disconnected' } }))).toBe('expired');
    expect(formatUtc('2026-10-08T13:00:00.000Z')).toBe('2026-10-08 13:00 UTC');
    expect(formatUtc(null)).toBeNull();
  });

  it('labels the badge amber or green, never “Error”', () => {
    const { rerender } = render(<OAuthStateBadge state="not_connected" />);
    expect(screen.getByText('Not connected').className).toMatch(/amber/);
    rerender(<OAuthStateBadge state="expired" />);
    expect(screen.getByText('Sign-in expired').className).toMatch(/amber/);
    rerender(<OAuthStateBadge state="connected" />);
    expect(screen.getByText('Connected').className).toMatch(/emerald/);
  });
});

describe('McpOAuthPanel', () => {
  it('not connected: says so in amber and offers Connect only', () => {
    render(<McpOAuthPanel server={hostinger()} />);
    expect(screen.getByText(/^Not connected\. Press Connect/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Hostinger MCP' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  });

  it('Connect starts the sign-in and sends the browser to the provider', async () => {
    const url = 'https://auth.hostinger.com/api/external/v1/oauth-server/authorize?client_id=x';
    startMcpOAuth.mockResolvedValue(url);
    render(<McpOAuthPanel server={hostinger()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Hostinger MCP' }));
    await waitFor(() => expect(hardAssign).toHaveBeenCalledWith(url));
    expect(startMcpOAuth).toHaveBeenCalledWith('hostinger-mcp');
    expect(toast).not.toHaveBeenCalled();
  });

  it('refuses to navigate anywhere but an https sign-in page', async () => {
    startMcpOAuth.mockResolvedValue('javascript:alert(1)');
    render(<McpOAuthPanel server={hostinger()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Hostinger MCP' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(hardAssign).not.toHaveBeenCalled();
    expect(toast.mock.calls[0][0]).toMatchObject({ variant: 'destructive' });
  });

  it('says why when the API cannot start the sign-in', async () => {
    startMcpOAuth.mockRejectedValue(
      new Error("Hostinger MCP's sign-in server does not offer PKCE with S256.")
    );
    render(<McpOAuthPanel server={hostinger()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Hostinger MCP' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: expect.stringMatching(/PKCE with S256/) })
      )
    );
    expect(screen.getByRole('button', { name: 'Connect Hostinger MCP' }).disabled).toBe(false);
  });

  it('expired: says the sign-in expired and offers Connect', () => {
    render(
      <McpOAuthPanel
        server={hostinger({ oauth: { status: 'disconnected' }, hasOauthToken: false })}
      />
    );
    expect(screen.getByText(/^Sign-in expired/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Hostinger MCP' })).toBeTruthy();
  });

  it('connected: shows the scope and expiry, with Reconnect and Disconnect', () => {
    render(<McpOAuthPanel server={connected()} />);
    expect(screen.getByText('mcp:use')).toBeTruthy();
    expect(screen.getByText(/expires 2026-10-08 13:00 UTC and renews automatically/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect Hostinger MCP' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect Hostinger MCP' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Hostinger MCP' })).toBeNull();
  });

  it('connected without a scope or an expiry says only that the token renews', () => {
    render(<McpOAuthPanel server={connected({ oauth: { status: 'connected' } })} />);
    expect(screen.getByText('Signed in.')).toBeTruthy();
    expect(screen.getByText('The access token renews automatically.')).toBeTruthy();
  });

  it('Disconnect asks first, then disconnects', async () => {
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    disconnectMcpOAuth.mockResolvedValue(undefined);
    render(<McpOAuthPanel server={connected()} />);
    const button = screen.getByRole('button', { name: 'Disconnect Hostinger MCP' });
    fireEvent.click(button);
    expect(disconnectMcpOAuth).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(disconnectMcpOAuth).toHaveBeenCalledWith('hostinger-mcp'));
    expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({ title: 'Hostinger MCP disconnected' })
    );
  });

  describe('what Disconnect says about the grant at the provider (#1116)', () => {
    const podbean = () =>
      connected({ id: 'podbean-mcp', name: 'Podbean MCP', url: 'https://mcp.podbean.com/mcp' });
    const pressDisconnect = async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<McpOAuthPanel server={podbean()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect Podbean MCP' }));
      await waitFor(() => expect(toast).toHaveBeenCalled());
      return toast.mock.calls[0][0];
    };

    it('revoked at the provider: says so, naming the issuer', async () => {
      disconnectMcpOAuth.mockResolvedValue({
        disconnected: true,
        revoked: true,
        issuer: 'https://mcp.podbean.com',
      });
      expect(await pressDisconnect()).toEqual({
        title: 'Podbean MCP disconnected',
        description: 'Disconnected and revoked at mcp.podbean.com.',
      });
    });

    it('not revoked: says the grant may still be live there, and where to revoke it', async () => {
      disconnectMcpOAuth.mockResolvedValue({
        disconnected: true,
        revoked: false,
        issuer: 'https://mcp.podbean.com',
        reason: 'https://mcp.podbean.com/revoke did not answer in time.',
      });
      expect(await pressDisconnect()).toEqual({
        title: 'Podbean MCP disconnected here',
        description:
          'Disconnected here; the grant may still be live at mcp.podbean.com — revoke it in your mcp.podbean.com account.',
      });
    });

    it('no revocation endpoint, or an older API: the title alone, as before', () => {
      expect(
        disconnectToast('Hostinger MCP', { disconnected: true, revoked: null, issuer: null })
      ).toEqual({
        title: 'Hostinger MCP disconnected',
      });
      expect(disconnectToast('Hostinger MCP', undefined)).toEqual({
        title: 'Hostinger MCP disconnected',
      });
      // Without a usable issuer the server's name stands in.
      expect(disconnectToast('Podbean MCP', { revoked: true, issuer: null }).description).toBe(
        'Disconnected and revoked at Podbean MCP.'
      );
      expect(issuerHost('https://auth.hostinger.com', 'x')).toBe('auth.hostinger.com');
      expect(issuerHost('not a url', 'x')).toBe('x');
    });
  });
});

describe('McpOAuthResultBanner', () => {
  function Where() {
    const location = useLocation();
    return <span data-testid="state">{JSON.stringify(location.state)}</span>;
  }
  const renderAt = (state) =>
    render(
      <MemoryRouter initialEntries={[{ pathname: '/admin/ai-engine', search: '?tab=mcp', state }]}>
        <Routes>
          <Route
            path="/admin/ai-engine"
            element={
              <>
                <McpOAuthResultBanner />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );

  it('shows the callback’s result and clears it on dismiss', () => {
    renderAt({
      mcpOAuth: { tone: 'success', message: 'Hostinger MCP is connected. 12 tools synced.' },
    });
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('Hostinger MCP is connected. 12 tools synced.');
    expect(banner.className).toMatch(/emerald/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('state').textContent).toBe('null');
  });

  it('shows a failure in red, and nothing when there is no result', () => {
    renderAt({ mcpOAuth: { tone: 'error', message: 'The sign-in was declined at the provider.' } });
    expect(screen.getByRole('status').className).toMatch(/red/);
  });

  it('renders nothing without a result', () => {
    renderAt(null);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
