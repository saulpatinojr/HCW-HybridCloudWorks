import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/use-toast';
import {
  Server,
  Loader2,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  RefreshCw,
  BookOpen,
  Info,
} from 'lucide-react';
import { aiEngine } from '@/lib/aiEngine';
import ConfirmModal from '@/components/admin/ConfirmModal';
import McpOAuthPanel, {
  McpOAuthResultBanner,
  OAuthStateBadge,
  oauthCardState,
  usesOAuthConnect,
} from './McpOAuth';
import { StatusBadge } from './ServicesTab';

export function mcpCardStatus(server) {
  const oauth = usesOAuthConnect(server);
  const oauthState = oauth ? oauthCardState(server) : null;
  return {
    oauth,
    badge: oauth ? <OAuthStateBadge state={oauthState} /> : <StatusBadge status={server.status} />,
    showError:
      Boolean(server.lastError) &&
      server.status === 'error' &&
      (!oauth || oauthState === 'connected'),
  };
}

export function McpServerCard({ server, onToggle, onSync, onRemove }) {
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { oauth, badge, showError } = mcpCardStatus(server);

  const handleSync = async () => {
    setSyncing(true);
    const result = await onSync(server.id);
    setSyncing(false);
    if (result?.ok) {
      toast({ title: 'Tools synced', description: `${result.tools?.length || 0} tools found` });
    } else {
      toast({ title: 'Sync failed', description: result?.error, variant: 'destructive' });
    }
  };

  const isCustom = ![
    'plaud',
    'firecrawl',
    'context7',
    'replicate-mcp',
    'aws-knowledge-mcp',
    'microsoftdocs-mcp',
    'drawio-mcp',
    'hostinger-mcp',
    'publer-mcp',
  ].includes(server.id);

  return (
    <Card className={server.enabled ? 'ring-1 ring-emerald-400/40' : 'opacity-80'}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5">
            <Server className="h-5 w-5 text-slate-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{server.name}</span>
              {badge}
              {Array.isArray(server.allowedTools) ? (
                <span className="text-xs text-slate-500">
                  {server.tools?.length > 0
                    ? `${server.allowedTools.length} of ${server.tools.length} tools allowed`
                    : `${server.allowedTools.length} tools allowed`}
                </span>
              ) : (
                server.tools?.length > 0 && (
                  <span className="text-xs text-slate-500">{server.tools.length} tools</span>
                )
              )}
            </div>
            <p className="text-xs text-slate-500 mt-0.5 truncate">{server.url}</p>
            {server.description && (
              <p className="text-xs text-slate-400 mt-0.5">{server.description}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <Switch
              checked={Boolean(server.enabled)}
              onCheckedChange={(v) => onToggle(server.id, v)}
              aria-label={`Enable ${server.name}`}
            />
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs px-2"
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                Sync Tools
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-slate-400 hover:text-indigo-600"
                onClick={() => navigate(`/admin/ai-engine/docs/${server.id}`)}
                title="View setup instructions"
                aria-label={`View docs for ${server.name}`}
              >
                <BookOpen className="h-3.5 w-3.5" />
              </Button>
              {isCustom && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-red-400 hover:text-red-600"
                  onClick={() => onRemove(server.id)}
                  title="Remove server"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        </div>

        {server.tools?.length > 0 && (
          <button
            className="flex items-center gap-1 text-xs text-slate-400 mt-2 hover:text-slate-600 transition-colors"
            onClick={() => setExpanded((p) => !p)}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {server.tools.length} tools available
          </button>
        )}
        {expanded && server.tools?.length > 0 && (
          <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
            {server.tools.map((t) => (
              <div key={t.name} className="px-2 py-1 bg-slate-50 dark:bg-slate-800 rounded text-xs">
                <span className="font-mono font-medium text-indigo-600 dark:text-indigo-400">
                  {t.name}
                </span>
                {t.description && <span className="text-slate-500 ml-2">{t.description}</span>}
              </div>
            ))}
          </div>
        )}

        {oauth && <McpOAuthPanel server={server} />}
        {server.notes && <p className="text-xs text-slate-400 mt-2 italic">{server.notes}</p>}
        {showError && (
          <div className="mt-2 p-2 bg-red-50 rounded text-xs text-red-600">{server.lastError}</div>
        )}
      </CardContent>
    </Card>
  );
}

export function AddServerForm({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', apiKeyEnvVar: '', description: '' });
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.url) return;
    setSaving(true);
    try {
      await onAdd({ ...form, transport: 'http', enabled: false, order: 99 });
      setForm({ name: '', url: '', apiKeyEnvVar: '', description: '' });
      setOpen(false);
      toast({ title: 'Server added', description: 'Click Sync Tools to fetch its tool list.' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {!open ? (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-2" /> Add MCP Server
        </Button>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Add Custom MCP Server</CardTitle>
            <CardDescription className="text-xs">
              Any MCP-compatible server using Streamable HTTP transport.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Name *</Label>
                  <Input
                    className="h-8 text-xs mt-1"
                    placeholder="My Search Server"
                    value={form.name}
                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                    required
                  />
                </div>
                <div>
                  <Label className="text-xs">Server URL *</Label>
                  <Input
                    className="h-8 text-xs mt-1"
                    placeholder="https://my-mcp.example.com/mcp"
                    value={form.url}
                    onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))}
                    required
                  />
                </div>
                <div>
                  <Label className="text-xs">API Key Env Var</Label>
                  <Input
                    className="h-8 text-xs mt-1"
                    placeholder="MY_SERVER_API_KEY"
                    value={form.apiKeyEnvVar}
                    onChange={(e) => setForm((p) => ({ ...p, apiKeyEnvVar: e.target.value }))}
                  />
                </div>
                <div>
                  <Label className="text-xs">Description</Label>
                  <Input
                    className="h-8 text-xs mt-1"
                    placeholder="Optional description"
                    value={form.description}
                    onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={saving}>
                  {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />} Save
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function McpTab({ servers }) {
  const { toast } = useToast();

  const handleToggle = async (id, enabled) => {
    try {
      await aiEngine.setEnabled('mcp_servers', id, enabled);
      toast({ title: enabled ? 'Server enabled' : 'Server disabled' });
    } catch (err) {
      toast({
        title: 'Unable to update server',
        description: err.message,
        variant: 'destructive',
      });
    }
  };

  const handleSync = async (id) => {
    try {
      return await aiEngine.syncMcpTools(id);
    } catch (err) {
      toast({ title: 'Sync failed', description: err.message, variant: 'destructive' });
      return { ok: false, error: err.message };
    }
  };

  const [pendingRemove, setPendingRemove] = useState(null);
  const [removing, setRemoving] = useState(false);
  const handleRemove = async () => {
    const id = pendingRemove;
    if (!id || removing) return;
    setRemoving(true);
    try {
      await aiEngine.removeMcpServer(id);
      toast({ title: 'Server removed' });
    } catch (err) {
      toast({
        title: 'Unable to remove server',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setRemoving(false);
      setPendingRemove(null);
    }
  };
  const pendingRemoveName = servers.find((s) => s.id === pendingRemove)?.name || 'The server';
  const handleAdd = (data) => aiEngine.addMcpServer(data);

  const enabledCount = servers.filter((s) => s.enabled).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-lg">MCP Servers</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {enabledCount} enabled — all tool calls proxy through the Azure Functions API so
            credentials never reach the browser
          </p>
        </div>
      </div>

      <McpOAuthResultBanner />

      <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-xs text-blue-700 dark:text-blue-300 flex gap-2">
        <Info className="h-4 w-4 shrink-0 mt-0.5" />
        <div>
          <strong>Transport:</strong> MCP requests go through the{' '}
          <strong>Azure Functions API</strong>. Each server uses its configured transport
          (Streamable HTTP or SSE). API keys come from Azure Function App settings / Key Vault
          references, and OAuth tokens are stored in Cosmos DB — never exposed to the browser.
          Servers that sign in with OAuth show <em>Connect</em>: sign in at the provider once, and
          the API keeps and renews the token. Click <em>Sync Tools</em> to fetch the tool list
          server-side.
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {servers.map((s) => (
          <McpServerCard
            key={s.id}
            server={s}
            onToggle={handleToggle}
            onSync={handleSync}
            onRemove={setPendingRemove}
          />
        ))}
      </div>

      <AddServerForm onAdd={handleAdd} />

      <ConfirmModal
        open={pendingRemove !== null}
        title="Remove this MCP server?"
        description={`${pendingRemoveName} and its tool list leave the configuration; the Playground and the bots can no longer call it.`}
        confirmLabel="Remove"
        busy={removing}
        busyLabel="Removing…"
        onConfirm={handleRemove}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}
