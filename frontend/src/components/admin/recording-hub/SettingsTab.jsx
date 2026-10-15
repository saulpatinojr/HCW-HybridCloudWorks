/**
 * Settings — the Plaud connection, and where the rest of the hub is configured
 * (#576).
 *
 * This was the Plaud tab's Connect sub-tab. It is the last tab now because
 * that is where the Newsletter Hub standard puts what is set once: the OAuth
 * token, what the 12-hour refresh timer has done with it (#358), and links to
 * the settings this hub reads but does not own.
 *
 * The MCP token rules and the CLIENT_USER_AUTH_REVOKED remedy live here,
 * beside the field that applies them.
 */
import React, { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';
import {
  AlertCircle,
  CheckCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { aiEngine, setMcpOAuthToken } from '@/lib/aiEngine';
import { describeLastRefresh, fmtWhen } from './recordingView';
import { tabHref } from './tabs';

// ─── Connect sub-tab (OAuth setup) ───────────────────────────────────────────

/**
 * What the 12-hour timer has actually done (#358).
 *
 * The rotation had NO witness before this. It writes `lastTokenRefresh` to the
 * document and logs its success at Information, and T-719 cut host verbosity
 * to Warning — so the trace is not ingested and the document was never
 * rendered. "The timer is armed" and "the timer has run" looked identical from
 * every surface a person can reach, which is the T-766 defect in a different
 * timer.
 *
 * Rendered only when the read has answered. `null` means not yet known, and
 * printing "never" for that would be a claim rather than a measurement.
 */
function RotationRecord({ refreshState, hasRefreshToken }) {
  if (!refreshState) return null;
  return (
    <div className="text-xs text-slate-500 dark:text-slate-400 space-y-1">
      {/* Only where auto-refresh can actually run. With no refresh token the
          banner above already says the access token expires on its own, and
          "last ran: not since this token was stored" beside that implies a
          refresh token exists and simply has not fired yet. The expiry row
          below is kept in that case, and matters more there than anywhere: it
          is when the connection stops working. */}
      {hasRefreshToken ? (
        <p>
          Auto-refresh last ran:{' '}
          <strong>{describeLastRefresh(refreshState.lastTokenRefresh)}</strong>
        </p>
      ) : null}
      {/* Gated on the FORMATTED string, not the raw field. An unparseable value
          formats to '' and would otherwise render the label with a blank after
          it, which reads as a broken page rather than as a missing value. */}
      {fmtWhen(refreshState.expiresAt) ? (
        <p>
          Access token expires: <strong>{fmtWhen(refreshState.expiresAt)}</strong>
        </p>
      ) : null}
      {refreshState.error ? (
        <p className="text-amber-700 dark:text-amber-400">
          Last refresh failed: {refreshState.error}
        </p>
      ) : null}
    </div>
  );
}

function ConnectTab({ isConnected, hasRefreshToken, refreshState, onConnected }) {
  const [token, setToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    if (!token.trim()) return;
    const refreshSupplied = Boolean(refreshToken.trim());
    setSaving(true);
    try {
      await setMcpOAuthToken('plaud', token.trim(), refreshToken);
      toast({ title: 'Token saved ✓', description: 'Testing connection…' });
      setToken('');
      setRefreshToken('');
      // Test immediately
      setTesting(true);
      await aiEngine.testProvider('plaud').catch(() => null);
      // testProvider works for AI providers; for MCP, use syncMcpTools
      const sync = await aiEngine.syncMcpTools('plaud');
      if (sync.ok) {
        toast({
          title: 'Connected to Plaud ✓',
          description: `${sync.tools?.length || 0} tools available`,
        });
        onConnected({ refreshSupplied });
      } else {
        toast({
          title: 'Token saved but test failed',
          description: sync.error,
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
      setTesting(false);
    }
  };

  const handleRetest = async () => {
    setTesting(true);
    const sync = await aiEngine.syncMcpTools('plaud');
    if (sync.ok) {
      toast({ title: 'Still connected ✓', description: `${sync.tools?.length || 0} tools` });
      onConnected({ refreshSupplied: false });
    } else {
      toast({ title: 'Connection failed', description: sync.error, variant: 'destructive' });
    }
    setTesting(false);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Status banner */}
      <div
        className={`flex items-center gap-3 p-3 rounded-lg border text-sm ${
          isConnected
            ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300'
            : 'bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-800 dark:border-slate-700'
        }`}
      >
        {isConnected ? (
          <>
            <CheckCircle className="h-5 w-5 shrink-0" />{' '}
            <span>
              <strong>Connected</strong> — your Plaud recordings are live in the Library tab.{' '}
              {hasRefreshToken
                ? 'Auto-refresh is armed: a refresh token is stored.'
                : 'No refresh token stored, so the access token expires on its own (about a day); paste both to keep it alive.'}
            </span>
          </>
        ) : (
          <>
            <AlertCircle className="h-5 w-5 shrink-0" />{' '}
            <span>
              <strong>Not connected</strong> — follow the steps below to authorize.
            </span>
          </>
        )}
        {isConnected && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 text-xs"
            onClick={handleRetest}
            disabled={testing}
          >
            {testing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </Button>
        )}
      </div>

      <RotationRecord refreshState={refreshState} hasRefreshToken={hasRefreshToken} />

      {/* Step-by-step setup */}
      <div className="space-y-4">
        <h3 className="font-semibold text-sm">How to connect</h3>

        <div className="space-y-3 text-sm">
          {[
            {
              n: 1,
              title: 'Install the Plaud MCP CLI',
              body: (
                <div className="mt-1 font-mono text-xs bg-slate-900 text-slate-100 rounded p-2 select-all">
                  npx -y @plaud-ai/mcp@latest install
                </div>
              ),
              note: 'Requires Node.js ≥ 20. Detects local AI clients and writes MCP config automatically. First-time setup only — re-running this does NOT repair a rejected token; see "If the Library stops working" below.',
            },
            {
              n: 2,
              title: 'Authorize in your browser',
              body: (
                <p className="text-xs text-slate-500 mt-1">
                  The installer opens a browser tab. Click <strong>Authorize</strong> to grant
                  access to your Plaud library.
                </p>
              ),
            },
            {
              n: 3,
              title: 'Copy your access token and refresh token',
              body: (
                <>
                  <p className="text-xs text-slate-500 mt-1">
                    Your tokens are saved to{' '}
                    <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">
                      ~/.plaud/tokens-mcp.json
                    </code>
                    . Copy the <code>access_token</code> and the <code>refresh_token</code>. Paste
                    both the first time — the access token connects the Library and lasts about a
                    day; the refresh token is what lets the site rotate the pair every 12 hours. An
                    access token stored on its own works until it expires and then stops, with
                    nothing able to renew it. Reconnecting later, you may leave the refresh field
                    blank to keep the one already stored; fill it whenever you have just
                    re-authorized, because that issues a new refresh token and the stored one stops
                    working.
                    <br />
                    <br />
                    To print them, in PowerShell:
                  </p>
                  <div className="mt-1 font-mono text-xs bg-slate-900 text-slate-100 rounded p-2 select-all break-all">
                    Get-Content &quot;$env:USERPROFILE\.plaud\tokens-mcp.json&quot;
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    <code>expires_at</code> in that file is in <strong>milliseconds</strong>. A
                    converter that assumes seconds returns a date tens of thousands of years out,
                    which is easily misread as the token being unusable when it has a day left.
                  </p>
                </>
              ),
            },
            {
              n: 4,
              title: 'Paste your tokens below',
              body: (
                <div className="mt-2 space-y-2">
                  <Input
                    type="password"
                    className="h-9 text-xs font-mono"
                    placeholder="access_token — eyJ…"
                    aria-label="Plaud access token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      className="h-9 text-xs font-mono flex-1"
                      placeholder="refresh_token — eyJ… (required to stay connected)"
                      aria-label="Plaud refresh token"
                      value={refreshToken}
                      onChange={(e) => setRefreshToken(e.target.value)}
                    />
                    <Button onClick={handleSave} disabled={saving || !token.trim()} className="h-9">
                      {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-4 w-4 mr-1" />
                      )}
                      Save & Test
                    </Button>
                  </div>
                  <p className="text-xs text-slate-400 flex items-center gap-1">
                    <ShieldCheck className="h-3 w-3" />
                    Both values are stored server-side in Cosmos DB and never sent back to the
                    browser after saving. Leaving the refresh field blank keeps the token already
                    stored — right when you are only replacing an expired access token, wrong after
                    re-authorizing, because that issued a new refresh token and retired the stored
                    one.
                  </p>
                </div>
              ),
            },
          ].map(({ n, title, body, note }) => (
            <div key={n} className="flex gap-3">
              <div className="w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                {n}
              </div>
              <div className="flex-1">
                <p className="font-medium text-sm">{title}</p>
                {body}
                {note && <p className="text-xs text-slate-400 mt-1">{note}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* MCP server info */}
      <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded text-xs text-blue-700 dark:text-blue-300 space-y-1">
        <p>
          <strong>MCP server:</strong> <code>https://mcp.plaud.ai/mcp</code> (Streamable HTTP)
        </p>
        <p>
          <strong>Available tools:</strong> list_files · get_file · get_note · get_transcript ·
          get_current_user
        </p>
        <p>
          <strong>Auth:</strong> OAuth — the access token lasts about a day, the refresh token about
          a week, and each refresh returns a new pair with a fresh week. With both stored, the
          12-hour <code>refreshPlaudToken</code> timer keeps the connection alive indefinitely.
          Plaud Embedded&apos;s client id and API key are a different product: they transcribe the
          audio you upload on the Upload tab and are seeded in Key Vault, not pasted here.
        </p>
        <a
          href="https://docs.plaud.ai/plaud-mcp-cli/mcp"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium hover:underline"
        >
          Full Plaud MCP docs <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/*
        Measured on 2026-09-08. Two full re-installs and a fresh browser
        authorization all produced tokens that Plaud rejected with
        CLIENT_USER_AUTH_REVOKED, because the installer reuses the existing
        client-user record rather than creating one. The MCP's own `login` tool
        cleared it in a single call. Nothing in Plaud's documentation connects
        that error to that remedy, which is why it is written down here.
      */}
      <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-800 dark:text-amber-300 space-y-1">
        <p className="font-semibold">If the Library stops working</p>
        <p>
          A 401, or <code>CLIENT_USER_AUTH_REVOKED</code> from Plaud, means the authorization was
          revoked on Plaud&apos;s side — not that the token expired. Re-running the installer does
          NOT fix it: it mints new tokens against the same revoked record.
        </p>
        <p>
          The fix is the MCP&apos;s own login tool. In an AI client that has Plaud connected (Claude
          Code, Claude Desktop, Cursor), ask it to <strong>log you into Plaud</strong>. That calls{' '}
          <code>login</code>, clears the revocation, and rewrites{' '}
          <code>~/.plaud/tokens-mcp.json</code>. Then copy both values back into the fields above.
        </p>
        <p>
          You do not need to revoke the app in Plaud&apos;s Authorized apps panel, and the grant
          staying listed there does not mean the connection works — the two are tracked separately.
        </p>
      </div>
    </div>
  );
}

export default function SettingsTab({ hub }) {
  return (
    <div className="space-y-8">
      <ConnectTab
        isConnected={hub.connection === 'connected'}
        hasRefreshToken={hub.hasRefreshToken}
        refreshState={hub.refreshState}
        onConnected={hub.markConnected}
      />

      <hr className="border-slate-200 dark:border-slate-700" />

      <div className="space-y-2 max-w-2xl">
        <h3 className="font-semibold text-sm">Where the rest is set</h3>
        <p className="text-xs text-slate-500">
          Nothing below is stored by this hub. It reads these settings; another page owns them.
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          <strong className="text-slate-900 dark:text-slate-100">Podcast feeds and voice</strong> —{' '}
          <RouterLink
            to="/admin/platform-settings?tab=audio"
            className="text-violet-600 hover:underline"
          >
            Platform settings
          </RouterLink>
          . The Podbean credentials are on{' '}
          <RouterLink to="/admin/integrations?tab=keys" className="text-violet-600 hover:underline">
            Integrations → Keys
          </RouterLink>
          .
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          <strong className="text-slate-900 dark:text-slate-100">What has been published</strong> —{' '}
          <RouterLink to={tabHref('distribution')} className="text-violet-600 hover:underline">
            the Distribution tab
          </RouterLink>
          , which reads the host record on each transcript.
        </p>
      </div>
    </div>
  );
}
