/**
 * Where an MCP server's vendor sends the browser back after Connect
 * (/admin/ai-engine/oauth/callback, 2026-10-08).
 *
 * The vendor's redirect carries `code` and `state` (and `iss`, from servers
 * that implement RFC 9207), or `error` (and perhaps `error_description`)
 * when the sign-in was declined or failed. This page
 * hands the code and state to the API, which checks the state (this admin,
 * under ten minutes, once), exchanges the code and syncs the server's tools,
 * then returns to the MCP Servers tab with the result in router state for
 * McpOAuthResultBanner. The page itself is only a spinner.
 *
 * It leaves with `replace`, so the address carrying the code is not left in
 * history for Back to re-submit. The provider's own error text is shown as
 * text, clipped, never as markup.
 *
 * Admin-guarded like its siblings: it sits under AdminAuthGuard in App.jsx,
 * and MSAL keeps its session in sessionStorage (#935), which survives a
 * same-tab navigation away and back. Connect leaves with `hardAssign`, in
 * this tab, and the vendor returns the same tab here, so the round trip does
 * not sign the owner out. A vendor opened in a new tab would land here with
 * no session; that is why Connect does not open one.
 */
import React, { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import { aiEngine } from '@/lib/aiEngine';
import { tabHref } from '@/components/admin/ai-engine/tabs';

const clip = (text, max = 300) => {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/** The sentence for a sign-in the provider ended with `error`. */
export function providerErrorMessage(error, description) {
  if (error === 'access_denied' && !description) {
    return 'The sign-in was declined at the provider, so nothing was connected.';
  }
  return `The sign-in was not completed. The provider said: ${clip(description || error)}`;
}

/** The banner for a completed connection: `{ tone, message }`. */
export function connectedResult(result) {
  const name = result?.serverName || 'The server';
  if (result?.syncError) {
    return {
      tone: 'warning',
      message: `${name} is connected, but its tool sync failed: ${clip(result.syncError)} Press Sync Tools on its card to try again.`,
    };
  }
  const count = Number(result?.toolCount) || 0;
  return {
    tone: 'success',
    message: `${name} is connected. ${count} tool${count === 1 ? '' : 's'} synced.`,
  };
}

export default function McpOAuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // One completion per visit, even where React runs effects twice: the
  // state is single-use, so a second POST could only ever be refused.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const finish = (mcpOAuth) => navigate(tabHref('mcp'), { replace: true, state: { mcpOAuth } });

    const error = params.get('error');
    if (error) {
      finish({
        tone: 'error',
        message: providerErrorMessage(error, params.get('error_description')),
      });
      return;
    }
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      finish({
        tone: 'error',
        message:
          'The sign-in came back without a code. Press Connect on the server card to start again.',
      });
      return;
    }
    // `iss` (RFC 9207) rides along when the provider sent it; the API
    // checks it against the issuer the sign-in started with.
    aiEngine
      .completeMcpOAuth({ state, code, iss: params.get('iss') || undefined })
      .then((result) => finish(connectedResult(result)))
      .catch((err) =>
        finish({
          tone: 'error',
          message:
            err?.message ||
            'The sign-in could not be completed. Press Connect on the card to try again.',
        })
      );
  }, [navigate, params]);

  return (
    <div
      role="status"
      className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-slate-500"
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      Finishing sign-in…
    </div>
  );
}
