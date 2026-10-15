/**
 * OAuth Connect on the AI Engine's MCP server cards (2026-10-08).
 *
 * Replicate's and Hostinger's hosted MCP servers accept only tokens their
 * own sign-in issues, so their cards carry a sign-in state instead of the
 * red "Error" a 401 used to leave there:
 *
 *   Not connected    amber, with Connect
 *   Sign-in expired  amber, with Connect (a refresh the vendor refused)
 *   Connected        green, the scope and when the access token expires,
 *                    with Reconnect and Disconnect
 *
 * Connect asks the API to start the sign-in and sends the browser to the
 * vendor; the vendor returns it to McpOAuthCallbackPage, whose result lands
 * in McpOAuthResultBanner on the MCP Servers tab. Tokens never reach the
 * browser: the card reads `oauth` (status, scope, expiry) and `hasOauthToken`.
 *
 * Disconnect asks first — through ConfirmModal, held open and busy while the
 * request runs (AP-F12, #936) — then deletes the token here and, where the
 * provider advertises a revocation endpoint, revokes the grant there first
 * (#1116). The toast says which happened: revoked at the provider, or deleted
 * here only — with the grant possibly still live there, for the owner to
 * revoke in that account.
 *
 * Plaud is marked OAuth too but is not Connect's: its token is pasted on the
 * Recording Hub's Connect tab (functions/src/lib/ai/mcp-policy.js
 * PASTED_TOKEN_SERVER_IDS, which aiEngine.test.js holds this list to).
 */
import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AlertTriangle, CheckCircle2, Loader2, LogIn, RefreshCw, Unplug, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { aiEngine } from '@/lib/aiEngine';
import { hardAssign } from '@/lib/hardNavigate';

export const PASTED_TOKEN_SERVER_IDS = Object.freeze(['plaud']);

/** Whether this card signs in with Connect. */
export function usesOAuthConnect(server) {
  return server?.authType === 'oauth' && !PASTED_TOKEN_SERVER_IDS.includes(server?.id);
}

/** 'connected', 'expired' or 'not_connected', from what a config read returns. */
export function oauthCardState(server) {
  if (server?.oauth?.status === 'connected' && server?.hasOauthToken) return 'connected';
  if (server?.oauth?.status === 'disconnected') return 'expired';
  return 'not_connected';
}

/** An ISO instant as "2026-10-08 13:00 UTC" — every time in this app is UTC. */
export function formatUtc(iso) {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return null;
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const isHttpsUrl = (value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/** The host of an issuer URL ("mcp.podbean.com"), for the toast; the fallback when it is not a URL. */
export function issuerHost(issuer, fallback) {
  try {
    return new URL(issuer).host || fallback;
  } catch {
    return fallback;
  }
}

/**
 * What the Disconnect toast says, from the API's `{ revoked, issuer, reason }`.
 * Revoked at the provider, deleted here only (the grant may still be live
 * there), or — a provider with no revocation endpoint, or an older API —
 * just the title.
 */
export function disconnectToast(name, result) {
  const title = `${name} disconnected`;
  const where = issuerHost(result?.issuer, name);
  if (result?.revoked === true) {
    return { title, description: `Disconnected and revoked at ${where}.` };
  }
  if (result?.revoked === false) {
    return {
      title: `${name} disconnected here`,
      description: `Disconnected here; the grant may still be live at ${where} — revoke it in your ${where} account.`,
    };
  }
  // No revocation endpoint (or a server connected before one was recorded):
  // the grant outlives this delete until it is removed at the provider.
  return {
    title: `${name} disconnected here`,
    description: result?.issuer
      ? `Disconnected here. ${where} offers no revocation, so remove this site from your ${where} account to end the grant.`
      : 'Disconnected here. The provider offers no revocation, so remove this site from your account there to end the grant.',
  };
}

const BADGES = {
  connected: { label: 'Connected', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  not_connected: { label: 'Not connected', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  expired: { label: 'Sign-in expired', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
};

export function OAuthStateBadge({ state }) {
  const { label, cls } = BADGES[state] || BADGES.not_connected;
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>
  );
}

const smallButton = 'h-7 text-xs px-2';

/** The sign-in state and its buttons, under a Connect server's card header. */
export default function McpOAuthPanel({ server }) {
  const state = oauthCardState(server);
  const [busy, setBusy] = useState(null);
  // Whether Disconnect is waiting on its confirmation (ADR 0033 §2: state,
  // not a browser dialog). The modal stays open, busy, until the request
  // settles.
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const { toast } = useToast();
  const name = server?.name || server?.id;

  const connect = async () => {
    setBusy('connect');
    try {
      const url = await aiEngine.startMcpOAuth(server.id);
      if (!isHttpsUrl(url)) throw new Error('The API returned no sign-in address.');
      // Stays busy: the page is about to leave for the vendor's sign-in.
      hardAssign(url);
    } catch (err) {
      toast({
        title: `Could not start the sign-in for ${name}`,
        description: err.message,
        variant: 'destructive',
      });
      setBusy(null);
    }
  };

  /** Disconnect once the modal is confirmed, and close it only when the request has settled. */
  const disconnect = async () => {
    setBusy('disconnect');
    try {
      const result = await aiEngine.disconnectMcpOAuth(server.id);
      toast(disconnectToast(name, result));
    } catch (err) {
      toast({
        title: `Could not disconnect ${name}`,
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
      setConfirmingDisconnect(false);
    }
  };

  const connectButton = (label) => {
    const Icon = label === 'Reconnect' ? RefreshCw : LogIn;
    return (
      <Button
        size="sm"
        variant="outline"
        className={smallButton}
        onClick={connect}
        disabled={Boolean(busy)}
        aria-label={`${label} ${name}`}
      >
        {busy === 'connect' ? (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        ) : (
          <Icon className="h-3 w-3 mr-1" />
        )}
        {label}
      </Button>
    );
  };

  if (state === 'connected') {
    const expires = formatUtc(server.oauth?.expiresAt);
    const scope = server.oauth?.scope;
    return (
      <div className="mt-2 p-2 rounded border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-300">
        <p>
          Signed in{scope ? ' with scope ' : '.'}
          {scope && <code className="font-mono">{scope}</code>}
        </p>
        <p className="mt-0.5">
          {expires
            ? `The access token expires ${expires} and renews automatically.`
            : 'The access token renews automatically.'}
        </p>
        <div className="mt-2 flex items-center gap-1">
          {connectButton('Reconnect')}
          <Button
            size="sm"
            variant="ghost"
            className={`${smallButton} text-slate-500 hover:text-red-600`}
            onClick={() => setConfirmingDisconnect(true)}
            disabled={Boolean(busy)}
            aria-label={`Disconnect ${name}`}
          >
            {busy === 'disconnect' ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Unplug className="h-3 w-3 mr-1" />
            )}
            Disconnect
          </Button>
        </div>
        <ConfirmModal
          open={confirmingDisconnect}
          title={`Disconnect ${name}?`}
          description="Its token is deleted here and, where the provider allows it, revoked there; nothing can call it until someone presses Connect again."
          confirmLabel="Disconnect"
          busy={busy === 'disconnect'}
          busyLabel="Disconnecting…"
          onConfirm={disconnect}
          onCancel={() => setConfirmingDisconnect(false)}
        />
      </div>
    );
  }

  const expired = state === 'expired';
  return (
    <div className="mt-2 p-2 rounded border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
      <p>
        {expired
          ? 'Sign-in expired: the provider refused to renew the token. Press Connect to sign in again.'
          : 'Not connected. Press Connect, sign in with your account at the provider and approve. The token is kept on the server, never in this browser.'}
      </p>
      <div className="mt-2">{connectButton('Connect')}</div>
    </div>
  );
}

const TONES = {
  success: {
    cls: 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300',
    Icon: CheckCircle2,
  },
  warning: {
    cls: 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-300',
    Icon: AlertTriangle,
  },
  error: {
    cls: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300',
    Icon: AlertTriangle,
  },
};

/**
 * The result the callback page navigated back with (router state
 * `mcpOAuth: { tone, message }`), until dismissed.
 */
export function McpOAuthResultBanner() {
  const location = useLocation();
  const navigate = useNavigate();
  const result = location.state?.mcpOAuth;
  if (!result || typeof result.message !== 'string') return null;
  const { cls, Icon } = TONES[result.tone] || TONES.error;
  const dismiss = () =>
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  return (
    <div role="status" className={`p-3 border rounded-lg text-sm flex items-start gap-2 ${cls}`}>
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <p className="flex-1">{result.message}</p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 opacity-70 hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
