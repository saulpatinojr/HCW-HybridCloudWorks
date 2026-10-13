/**
 * AI Engine — Admin Page  (/admin/ai-engine)
 *
 * Five tabs (components/admin/ai-engine/tabs.js), selected by `?tab=`:
 *   1. AI Services   — the Priority list (ADR 0034 §4), feature switches,
 *                      provider cards with status, enable toggle, the
 *                      catalogue's model list, Test
 *   2. Tasks         — one row per AI task: its mode (Recommended / Global /
 *                      Custom), the effective model the router will use,
 *                      and a per-task Test (ADR 0034 §4)
 *   3. MCP Servers   — server cards with tool browser, Sync, Add Server form,
 *                      and Connect for servers that sign in with OAuth
 *                      (components/admin/ai-engine/McpOAuth.jsx)
 *   4. Playground    — one provider or MCP tool, a prompt, the answer and cost
 *   5. Usage         — every recorded call, by provider and by feature
 *
 * The model catalogue drawer (CatalogDrawer) opens from the first two tabs.
 * The "Site Services" tab that sat between them until ADR 0033 was a
 * placeholder: local state over a stale provider list that saved nothing.
 * Its address lands on Tasks, which answers the question it posed. The
 * per-feature placement selects and the cards' model pin left with ADR 0034
 * slice 4 (#859): the Priority list's per-row model and the Tasks tab
 * replaced them, and the selection document is what the router reads.
 */

import React, { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import IntegrationBadge from '@/components/admin/shared/IntegrationBadge';
import { useNavigate, useSearchParams } from 'react-router';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import {
  Bot,
  Server,
  Clock,
  Loader2,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  RefreshCw,
  Play,
  Send,
  ExternalLink,
  Info,
  DollarSign,
  BookOpen,
  ToggleLeft,
} from 'lucide-react';
import {
  aiEngine,
  seedAiEngineIfEmpty,
  subscribeProviders,
  subscribeMcpServers,
} from '@/lib/aiEngine';
import { catalogEntries, describeRefresh, withCatalogModels } from '@/lib/aiEngine/catalog';
import HubTabs from '@/components/admin/HubTabs';
import PageHeader from '@/components/admin/shared/PageHeader';
import EmptyState from '@/components/admin/shared/EmptyState';
import TasksTab from '@/components/admin/ai-engine/TasksTab';
import PriorityList from '@/components/admin/ai-engine/PriorityList';
import CatalogDrawer from '@/components/admin/ai-engine/CatalogDrawer';
import useSelection from '@/components/admin/ai-engine/useSelection';
import { TABS, resolveTab } from '@/components/admin/ai-engine/tabs';
import McpOAuthPanel, {
  McpOAuthResultBanner,
  OAuthStateBadge,
  oauthCardState,
  usesOAuthConnect,
} from '@/components/admin/ai-engine/McpOAuth';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    connected: { label: 'Connected', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    error: { label: 'Error', cls: 'bg-red-100 text-red-700 border-red-200' },
    untested: { label: 'Untested', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
    unavailable: { label: 'No API yet', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
    // An OAuth Connect server nobody has signed in to, or whose sign-in
    // expired: amber, because nothing failed (mcp.js, 2026-10-08).
    needs_connection: {
      label: 'Not connected',
      cls: 'bg-amber-100 text-amber-700 border-amber-200',
    },
  };
  const { label, cls } = map[status] || map.untested;
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>
  );
}

function ProviderIcon({ provider }) {
  const icons = {
    anthropic: '🟣',
    gemini: '🔵',
    nvidia: '🟩',
    foundry: '🟦',
    perplexity: '🔍',
    azure: '🪟',
    bedrock: '🟠',
    notebooklm: '📓',
  };
  return (
    <span className="text-2xl leading-none">{provider?.icon || icons[provider?.id] || '🤖'}</span>
  );
}

function fmtCost(usd) {
  if (!usd || usd < 0.000001) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
/**
 * [below this many seconds, divide by, suffix]. Days run up to a month, so a
 * weekly probe reads "Tested 3d ago" (#701); older than that is a date.
 */
const AGO_UNITS = [
  [3600, 60, 'm'],
  [86400, 3600, 'h'],
  [30 * 86400, 86400, 'd'],
];

function timeAgo(ts, now = Date.now()) {
  if (!ts) return 'Never';
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  const secs = Math.floor((now - d) / 1000);
  if (secs < 60) return 'just now';
  const unit = AGO_UNITS.find(([below]) => secs < below);
  return unit ? `${Math.floor(secs / unit[1])}${unit[2]} ago` : d.toLocaleDateString();
}

/**
 * The card's "Tested …" line: when, and whether it was the Test button or the
 * weekly probe (#701, `lastTestedBy: 'probe'`, lib/timers/ai-provider-probe.js
 * in functions). Null when the provider has never been tested.
 */
export function describeLastTest(provider, now = Date.now()) {
  if (!provider?.lastTested) return null;
  const by = provider.lastTestedBy === 'probe' ? ' by the weekly check' : '';
  return `Tested ${timeAgo(provider.lastTested, now)}${by}`;
}

// ─── Services Tab ─────────────────────────────────────────────────────────────

const MODEL_BADGE = 'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border';
const MODEL_BADGES = {
  retired: { label: 'retired', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  unknown: { label: 'unconfirmed', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  unpriced: { label: 'unpriced', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  hidden: { label: 'hidden', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
};

function ModelBadge({ kind }) {
  const { label, cls } = MODEL_BADGES[kind];
  return <span className={`${MODEL_BADGE} ${cls}`}>{label}</span>;
}

/**
 * The card's model list from the catalogue (ADR 0034 slice 2, #857): every
 * model the provider's list endpoint has named, with the ones the API has
 * stopped listing marked retired, the ones the cost table cannot price
 * marked unpriced, and a Hide / Show per model. Hidden and retired models
 * leave the selects above; they stay here so they can be shown again, and so
 * a retirement is visible before a pinned model fails.
 */
function ModelList({ provider, entry, onHideModel }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const rows = catalogEntries(entry);
  const refreshLine = describeRefresh(entry);
  const lastError = entry?.refresh?.lastError;

  const toggle = async (model) => {
    if (!onHideModel) return;
    setBusy(model.id);
    try {
      await onHideModel(provider.id, model.id, !model.hidden);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Models for ${provider.name}`}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Models ({rows.length})<span className="text-slate-300 dark:text-slate-600">·</span>
        <span className={entry?.stale ? 'text-amber-600' : ''}>{refreshLine}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 max-h-48 overflow-y-auto">
          {rows.length === 0 && (
            <p className="text-xs text-slate-400 italic">No models listed yet.</p>
          )}
          {rows.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 dark:bg-slate-800 rounded text-xs"
            >
              <span
                className={`font-mono truncate ${
                  m.hidden || m.status === 'retired' ? 'text-slate-400 line-through' : ''
                }`}
              >
                {m.id}
              </span>
              {m.status === 'retired' && <ModelBadge kind="retired" />}
              {m.status === 'unknown' && <ModelBadge kind="unknown" />}
              {m.unpriced && <ModelBadge kind="unpriced" />}
              {m.hidden && <ModelBadge kind="hidden" />}
              <button
                type="button"
                className="ml-auto text-xs text-indigo-600 hover:underline disabled:opacity-50"
                disabled={busy === m.id || !onHideModel}
                onClick={() => toggle(m)}
                aria-label={`${m.hidden ? 'Show' : 'Hide'} ${m.id} for ${provider.name}`}
              >
                {m.hidden ? 'Show' : 'Hide'}
              </button>
            </div>
          ))}
          {lastError && (
            <p className="text-xs text-red-600 dark:text-red-400 pt-1">
              Last refresh failed: {lastError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function ProviderCard({ provider, catalogEntry = null, onToggle, onTest, onHideModel }) {
  const [testing, setTesting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();

  const handleTest = async () => {
    if (provider.status === 'unavailable') return;
    setTesting(true);
    await onTest(provider.id);
    setTesting(false);
  };

  const isUnavailable = provider.status === 'unavailable';
  const lastTest = describeLastTest(provider);
  // `lastTestError` is what testAiProvider and the weekly probe write;
  // `lastError` is the older field some stored documents still carry.
  const testError = provider.lastTestError || provider.lastError;

  return (
    <Card
      className={`transition-all ${provider.enabled ? 'ring-1 ring-indigo-400/40' : 'opacity-80'}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <ProviderIcon provider={provider} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{provider.name}</span>
              <IntegrationBadge id={provider.id} size="xs" />
              <StatusBadge status={provider.status} />
              {provider.latencyMs && provider.status === 'connected' && (
                <span className="text-xs text-slate-400">{provider.latencyMs}ms</span>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">{provider.description}</p>

            {/* The catalogue's list; the model a call uses is chosen on the Priority list and the Tasks tab */}
            {!isUnavailable && catalogEntry && (
              <ModelList provider={provider} entry={catalogEntry} onHideModel={onHideModel} />
            )}

            {/* Last tested, by the button or the weekly check */}
            {lastTest && <p className="text-xs text-slate-400 mt-1">{lastTest}</p>}
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <Switch
              checked={Boolean(provider.enabled)}
              onCheckedChange={(v) => onToggle(provider.id, v)}
              disabled={isUnavailable}
              aria-label={`Enable ${provider.name}`}
            />
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs px-2"
                onClick={handleTest}
                disabled={testing || isUnavailable || !provider.enabled}
              >
                {testing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3 mr-1" />
                )}
                Test
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-slate-400 hover:text-indigo-600"
                onClick={() => navigate(`/admin/ai-engine/docs/${provider.id}`)}
                title="View setup instructions"
                aria-label={`View docs for ${provider.name}`}
              >
                <BookOpen className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>

        {/* Notes / expand */}
        {provider.notes && (
          <button
            className="flex items-center gap-1 text-xs text-slate-400 mt-2 hover:text-slate-600 transition-colors"
            onClick={() => setExpanded((p) => !p)}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Setup notes
          </button>
        )}
        {expanded && provider.notes && (
          <div className="mt-2 p-2 bg-slate-50 dark:bg-slate-800 rounded text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            {provider.notes}
            {provider.docsUrl && (
              <a
                href={provider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 ml-2 text-indigo-600 hover:underline"
              >
                Docs <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
        )}

        {/* Error message */}
        {testError && provider.status === 'error' && (
          <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 rounded text-xs text-red-600 dark:text-red-400">
            {testError}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Which parts of the site may call a model.
 *
 * The list of switches comes from the API, not from a constant here. A copy of
 * that list kept in the browser is exactly how this page came to advertise
 * providers the server had removed, and a switch that governs nothing is worse
 * than no switch at all — it reads as working. Which provider serves a task
 * when it is on is the Tasks tab's question (ADR 0034 §4), not this card's.
 */
export function FeatureSwitches() {
  const { toast } = useToast();
  const [features, setFeatures] = useState(null);
  const [catalogue, setCatalogue] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    aiEngine
      .getAiFeatures()
      .then(({ features: f, catalogue: c }) => {
        if (cancelled) return;
        setFeatures(f);
        setCatalogue(c);
      })
      .catch((err) => !cancelled && setError(err?.message || 'Could not load AI feature settings'));
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = async (name, next) => {
    setBusy(name);
    // Optimistic, then reconciled with what the server stored. A switch that
    // springs back is the honest outcome of a failed write.
    setFeatures((prev) => ({ ...prev, [name]: next }));
    try {
      const saved = await aiEngine.setAiFeature(name, next);
      setFeatures((prev) => ({ ...prev, ...saved }));
    } catch (err) {
      setFeatures((prev) => ({ ...prev, [name]: !next }));
      toast({
        title: 'Could not save',
        description: err?.message || 'The switch has been put back.',
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-red-600 dark:text-red-400">{error}</CardContent>
      </Card>
    );
  }

  const names = Object.keys(catalogue);
  const offCount = features ? names.filter((n) => features[n] === false).length : 0;

  let summary;
  if (features === null) {
    summary = 'Loading…';
  } else if (offCount === 0) {
    summary =
      'Every AI feature is on. Switching one off stops those calls immediately — the rest of the feature keeps working.';
  } else {
    summary = `${offCount} of ${names.length} switched off.`;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ToggleLeft className="h-4 w-4" />
          Where AI is used
        </CardTitle>
        <CardDescription>{summary}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {features === null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading settings…
          </div>
        ) : (
          names.map((name) => (
            <div
              key={name}
              className="flex items-start justify-between gap-4 py-2.5 border-b last:border-b-0 border-slate-100 dark:border-slate-800"
            >
              <div className="min-w-0">
                <div className="font-medium text-sm">{catalogue[name]?.label || name}</div>
                <div className="text-xs text-slate-500 mt-0.5">{catalogue[name]?.description}</div>
                {/* The question someone actually has in front of a toggle. */}
                <div className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  {catalogue[name]?.route}
                </div>
              </div>
              <Switch
                checked={features[name] !== false}
                disabled={busy === name}
                onCheckedChange={(next) => handleToggle(name, next)}
                aria-label={catalogue[name]?.label || name}
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/** One sentence for the toast after a refresh: who listed, who was skipped, who failed. */
export function describeRefreshSummary(summary) {
  const rows = Object.entries(summary?.providers || {});
  const listed = rows.filter(([, r]) => !r?.error && !r?.skipped);
  const failed = rows.filter(([, r]) => r?.error);
  const added = listed.reduce((n, [, r]) => n + (r.added || 0), 0);
  const retired = listed.reduce((n, [, r]) => n + (r.retired || 0), 0);
  const parts = [
    `${listed.length} provider${listed.length === 1 ? '' : 's'} listed`,
    `${added} new`,
    `${retired} retired`,
  ];
  if (failed.length > 0) {
    parts.push(`failed: ${failed.map(([p, r]) => `${p} (${r.error})`).join(', ')}`);
  }
  return { text: parts.join(' · '), failed: failed.length > 0 };
}

/**
 * The provider cards in the Priority list's order (ADR 0034 §4), a provider
 * the list does not name after every one it does, in the cards' own order.
 */
export function orderByPriority(providers, selection) {
  const rank = new Map((selection?.global?.priority || []).map((s, i) => [s.provider, i]));
  return [...providers].sort(
    (a, b) =>
      (rank.get(a.id) ?? 1000 + (a.order ?? 99)) - (rank.get(b.id) ?? 1000 + (b.order ?? 99))
  );
}

function ServicesTab({
  providers,
  catalog,
  onHideModel,
  onRefreshCatalog,
  refreshing,
  onOpenCatalog,
}) {
  const { toast } = useToast();
  const { state, saving, reload, save } = useSelection();

  // Each write says so when it fails. Until ADR 0033 a rejected PATCH here
  // was an unhandled promise: the switch stayed where it was clicked while
  // the API held the old value.
  const failed = (title) => (err) =>
    toast({ title, description: err?.message || 'Nothing was changed.', variant: 'destructive' });

  const handleToggle = async (id, enabled) => {
    try {
      await aiEngine.setEnabled('ai_providers', id, enabled);
      // A switch decides who is in the Priority list; the resolver's answer
      // is read again so the list and every card agree.
      await reload();
    } catch (err) {
      failed('Could not change the provider')(err);
    }
  };

  const handleTest = async (id) => {
    try {
      const result = await aiEngine.testProvider(id);
      if (result.ok) {
        toast({ title: 'Connected ✓', description: `${result.latencyMs}ms response time` });
      } else {
        toast({ title: 'Connection failed', description: result.error, variant: 'destructive' });
      }
    } catch (err) {
      failed('The test did not run')(err);
    }
  };

  // A refused save (400) is said here; a 409 is said and reloaded by the hook.
  const handleSave = (next) =>
    save(next).catch((err) => {
      if (err?.status !== 409) failed('Could not save the Priority list')(err);
      throw err;
    });

  const ordered = orderByPriority(providers, state.selection);
  const enabledCount = ordered.filter((p) => p.enabled && p.status !== 'unavailable').length;
  const connectedCount = ordered.filter((p) => p.status === 'connected').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-lg">AI Services</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {enabledCount} enabled · {connectedCount} verified · enable a provider then click Test
            to verify your API key
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={onOpenCatalog}>
            Model catalogue
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onRefreshCatalog}
            disabled={refreshing}
            title="List every provider's models now; the weekly check does this on Mondays"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
            )}
            Refresh model lists
          </Button>
        </div>
      </div>

      <PriorityList
        providers={providers}
        catalog={catalog}
        selection={state.selection}
        effective={state.effective}
        status={state.status}
        error={state.error}
        saving={saving}
        onSave={handleSave}
        onRetry={reload}
      />

      <FeatureSwitches />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {ordered.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            catalogEntry={catalog?.providers?.[p.id] || null}
            onToggle={handleToggle}
            onTest={handleTest}
            onHideModel={onHideModel}
          />
        ))}
      </div>
    </div>
  );
}

// ─── MCP Servers Tab ──────────────────────────────────────────────────────────

/**
 * A card's badge and whether its last error shows in red. A server that
 * signs in with OAuth Connect shows its sign-in state, not the last RPC's
 * status: before Connect, a 401 is the expected answer, not an error.
 */
function mcpCardStatus(server) {
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

/**
 * One MCP server on the AI Engine's MCP Servers tab: its name, status, tools,
 * the allowed-tools count when a policy is set, its Connect state for an OAuth
 * server, and the toggle, Sync and (for a custom server only) Remove actions.
 *
 * A server is "built-in" when its id is one the seed ships
 * (`DEFAULT_MCP_SERVERS` in lib/aiEngine/seed.js), and only a custom server
 * can be removed here: a removed built-in would be re-seeded on the next load.
 *
 * @param {{ server: object, onToggle: Function, onSync: Function, onRemove: Function }} props
 */
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
                // Read-only: the API enforces the list, and only a
                // super_admin config write changes it (#995).
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

        {/* Tool list */}
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

function AddServerForm({ onAdd }) {
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

function McpTab({ servers }) {
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

  const handleRemove = async (id) => {
    if (!window.confirm('Remove this MCP server?')) return;
    try {
      await aiEngine.removeMcpServer(id);
      toast({ title: 'Server removed' });
    } catch (err) {
      toast({
        title: 'Unable to remove server',
        description: err.message,
        variant: 'destructive',
      });
    }
  };
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
            onRemove={handleRemove}
          />
        ))}
      </div>

      <AddServerForm onAdd={handleAdd} />
    </div>
  );
}

// ─── Playground Tab ───────────────────────────────────────────────────────────

function PlaygroundTab({ providers, servers }) {
  const [mode, setMode] = useState('ai'); // 'ai' | 'mcp'
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [server, setServer] = useState('');
  const [tool, setTool] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [userPrompt, setUserPrompt] = useState('');
  const [toolArgs, setToolArgs] = useState('{}');
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState(null);
  const [history, setHistory] = useState([]);
  const { toast } = useToast();

  const enabledProviders = providers.filter((p) => p.enabled && p.status !== 'unavailable');
  const enabledServers = servers.filter((s) => s.enabled && s.tools?.length > 0);

  const selectedProvider = providers.find((p) => p.id === provider);
  const selectedServer = servers.find((s) => s.id === server);

  const handleSend = async () => {
    if (mode === 'ai' && (!provider || !userPrompt)) {
      toast({ title: 'Pick a provider and write a prompt', variant: 'destructive' });
      return;
    }
    if (mode === 'mcp' && (!server || !tool)) {
      toast({ title: 'Pick a server and tool', variant: 'destructive' });
      return;
    }

    setSending(true);
    setResponse(null);
    const t0 = Date.now();

    try {
      let result;
      if (mode === 'ai') {
        result = await aiEngine.chat(provider, model, userPrompt, systemPrompt, 'admin_playground');
        const entry = {
          id: Date.now(),
          mode,
          provider,
          model,
          prompt: userPrompt,
          text: result.text,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          estimatedCostUsd: result.estimatedCostUsd,
          latencyMs: result.latencyMs || Date.now() - t0,
        };
        setResponse(entry);
        setHistory((h) => [entry, ...h.slice(0, 9)]);
      } else {
        let args = {};
        try {
          args = JSON.parse(toolArgs);
        } catch {
          /* ignore */
        }
        result = await aiEngine.mcpTool(server, tool, args);
        const entry = {
          id: Date.now(),
          mode,
          server,
          tool,
          text: result.result || JSON.stringify(result),
          latencyMs: Date.now() - t0,
        };
        setResponse(entry);
        setHistory((h) => [entry, ...h.slice(0, 9)]);
      }
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-lg">Playground</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Test any AI provider or MCP tool directly from here.
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-2">
        {[
          { id: 'ai', label: '🤖 AI Provider' },
          { id: 'mcp', label: '🔧 MCP Tool' },
        ].map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              mode === m.id
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Input panel */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{mode === 'ai' ? 'Prompt' : 'Tool Call'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {mode === 'ai' ? (
              <>
                {enabledProviders.length === 0 ? (
                  <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
                    Enable and test at least one AI provider first.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Provider</Label>
                      <Select
                        value={provider}
                        onValueChange={(nextProvider) => {
                          setProvider(nextProvider);
                          const next = providers.find((p) => p.id === nextProvider);
                          setModel(next?.models?.[0] || '');
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs mt-1">
                          <SelectValue placeholder="Pick provider" />
                        </SelectTrigger>
                        <SelectContent>
                          {enabledProviders.map((p) => (
                            <SelectItem key={p.id} value={p.id} className="text-xs">
                              {p.icon} {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Model</Label>
                      <Select value={model} onValueChange={setModel}>
                        <SelectTrigger className="h-8 text-xs mt-1">
                          <SelectValue placeholder="Model" />
                        </SelectTrigger>
                        <SelectContent>
                          {(selectedProvider?.models || []).map((m) => (
                            <SelectItem key={m} value={m} className="text-xs">
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-xs">System Prompt (optional)</Label>
                  <Textarea
                    className="text-xs mt-1 resize-none"
                    rows={2}
                    placeholder="You are a helpful assistant..."
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                  />
                </div>
                <div>
                  <Label className="text-xs">User Message *</Label>
                  <Textarea
                    className="text-xs mt-1 resize-none"
                    rows={4}
                    placeholder="What would you like to ask?"
                    value={userPrompt}
                    onChange={(e) => setUserPrompt(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <>
                {enabledServers.length === 0 ? (
                  <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
                    Enable a server and sync its tools first.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Server</Label>
                      <Select
                        value={server}
                        onValueChange={(nextServer) => {
                          setServer(nextServer);
                          const next = servers.find((s) => s.id === nextServer);
                          setTool(next?.tools?.[0]?.name || '');
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs mt-1">
                          <SelectValue placeholder="Pick server" />
                        </SelectTrigger>
                        <SelectContent>
                          {enabledServers.map((s) => (
                            <SelectItem key={s.id} value={s.id} className="text-xs">
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Tool</Label>
                      <Select value={tool} onValueChange={setTool}>
                        <SelectTrigger className="h-8 text-xs mt-1">
                          <SelectValue placeholder="Tool" />
                        </SelectTrigger>
                        <SelectContent>
                          {(selectedServer?.tools || []).map((t) => (
                            <SelectItem key={t.name} value={t.name} className="text-xs font-mono">
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                <div>
                  <Label className="text-xs">Arguments (JSON)</Label>
                  <Textarea
                    className="text-xs mt-1 font-mono resize-none"
                    rows={4}
                    placeholder='{"query": "latest cloud news"}'
                    value={toolArgs}
                    onChange={(e) => setToolArgs(e.target.value)}
                  />
                </div>
              </>
            )}

            <Button className="w-full" onClick={handleSend} disabled={sending}>
              {sending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              Send
            </Button>
          </CardContent>
        </Card>

        {/* Response panel */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center justify-between">
              <span>Response</span>
              {response && (
                <span className="flex gap-2 text-xs font-normal text-slate-500">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {response.latencyMs}ms
                  </span>
                  {response.estimatedCostUsd !== undefined && (
                    <span className="flex items-center gap-1">
                      <DollarSign className="h-3 w-3" />
                      {fmtCost(response.estimatedCostUsd)}
                    </span>
                  )}
                  {response.promptTokens > 0 && (
                    <span>
                      {fmtTokens(response.promptTokens + response.completionTokens)} tokens
                    </span>
                  )}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sending && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Waiting for response…
              </div>
            )}
            {!sending && !response && (
              <p className="text-xs text-slate-400 italic">Response will appear here.</p>
            )}
            {!sending && response && (
              <div className="text-xs whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto font-mono bg-slate-50 dark:bg-slate-900 p-3 rounded border">
                {response.text}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Recent calls this session</h3>
          <div className="space-y-1">
            {history.map((h) => (
              <button
                key={h.id}
                className="w-full text-left px-3 py-2 bg-slate-50 dark:bg-slate-800 rounded text-xs hover:bg-slate-100 transition-colors"
                onClick={() => setResponse(h)}
              >
                <span className="font-medium">
                  {h.provider || h.server}/{h.model || h.tool}
                </span>
                <span className="text-slate-400 ml-2 truncate inline-block max-w-xs">
                  {(h.prompt || h.tool || '').slice(0, 60)}
                </span>
                <span className="text-slate-400 ml-auto float-right">{h.latencyMs}ms</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const UsageTab = lazy(() => import('@/pages/admin/AIEngineUsageTab'));

// ─── Main Page ────────────────────────────────────────────────────────────────

const HELP = [
  'AI Services holds the Priority list: a call goes to P1 first and falls through in order when a provider cannot serve. Each row names the model the list uses for that provider, or leaves it on the provider’s default. The model lists come from the providers themselves, refreshed by the weekly check or the Refresh model lists button, and the Model catalogue shows every model with its price and status; a model can be hidden from the dropdowns.',
  'Tasks shows one row per AI task (drafting, grading, captions, the assistant…) with the model the router will use right now. Recommended takes the model the site recommends for the task, Global follows the Priority list, Custom names a chain of its own; a task can also exclude a provider. Test runs the task’s chain and says which candidate answered.',
  'Where AI is used (on AI Services) switches a task off entirely; Tasks decides who serves it when it is on.',
  'MCP Servers are tool servers the Playground and the bots can call; keys stay in app settings named MCP_* and are never sent to the browser.',
  'Usage & Cost lists every recorded call. Since ADR 0033 every call through the router records one row, sourced to its task.',
];

export default function AIEnginePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const [providers, setProviders] = useState([]);
  const [servers, setServers] = useState([]);
  const [seed, setSeed] = useState({ status: 'seeding', error: null });

  // Seed and subscribe on mount. A failed seed is said, with a retry: until
  // ADR 0033 the promise had no catch, so a 403 or an offline API left the
  // spinner turning forever.
  const runSeed = useCallback(() => {
    seedAiEngineIfEmpty()
      .then(() => setSeed({ status: 'ready', error: null }))
      .catch((err) =>
        setSeed({ status: 'error', error: err?.message || 'The configuration could not be read.' })
      );
  }, []);

  useEffect(() => {
    runSeed();
  }, [runSeed]);

  const retrySeed = () => {
    setSeed({ status: 'seeding', error: null });
    runSeed();
  };

  useEffect(() => {
    if (seed.status !== 'ready') return undefined;
    const unsubP = subscribeProviders(setProviders);
    const unsubS = subscribeMcpServers(setServers);
    return () => {
      unsubP();
      unsubS();
    };
  }, [seed.status]);

  // The model catalogue (#857): read once the seed is ready, and again after
  // a hide or a refresh. A catalogue that cannot be read leaves the cards on
  // whatever their stored documents carry rather than emptying the selects.
  const [catalog, setCatalog] = useState(null);
  const loadCatalog = useCallback(
    () =>
      aiEngine
        .fetchModelCatalog()
        .then(setCatalog)
        .catch((err) => console.error('[aiEngine] model catalogue load failed:', err)),
    []
  );
  useEffect(() => {
    if (seed.status !== 'ready') return;
    loadCatalog();
  }, [seed.status, loadCatalog]);

  // The one place the catalogue's lists reach the provider documents: every
  // tab below reads `provider.models` and none of them keeps a list.
  const providersWithModels = useMemo(
    () => withCatalogModels(providers, catalog),
    [providers, catalog]
  );

  // The catalogue's writes (#857) live here because two tabs and the drawer
  // share them: a hide or a refresh lands on the API, then the page
  // re-reads the document so every card and dropdown shows what it holds.
  const { toast } = useToast();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const handleHideModel = async (id, model, hidden) => {
    try {
      await aiEngine.setModelHidden(id, model, hidden);
      await loadCatalog();
    } catch (err) {
      toast({
        title: hidden ? 'Could not hide the model' : 'Could not show the model',
        description: err?.message || 'Nothing was changed.',
        variant: 'destructive',
      });
    }
  };
  const handleRefreshCatalog = async () => {
    setRefreshing(true);
    try {
      const summary = await aiEngine.refreshModelCatalog();
      const { text, failed: anyFailed } = describeRefreshSummary(summary);
      toast({
        title: anyFailed ? 'Model lists refreshed, with errors' : 'Model lists refreshed',
        description: text,
        ...(anyFailed ? { variant: 'destructive' } : {}),
      });
      await loadCatalog();
    } catch (err) {
      toast({
        title: 'Could not refresh the model lists',
        description: err?.message || 'Nothing was changed.',
        variant: 'destructive',
      });
    } finally {
      setRefreshing(false);
    }
  };

  const setTab = (id) => {
    if (id === activeTab) return;
    setSearchParams({ tab: id });
  };

  const enabledCount = providers.filter((p) => p.enabled && p.status !== 'unavailable').length;
  const mcpCount = servers.filter((s) => s.enabled).length;

  const PANELS = {
    services: () => (
      <ServicesTab
        providers={providersWithModels}
        catalog={catalog}
        onHideModel={handleHideModel}
        onRefreshCatalog={handleRefreshCatalog}
        refreshing={refreshing}
        onOpenCatalog={() => setCatalogOpen(true)}
      />
    ),
    routing: () => (
      <TasksTab
        providers={providersWithModels}
        catalog={catalog}
        onOpenCatalog={() => setCatalogOpen(true)}
      />
    ),
    mcp: () => <McpTab servers={servers} />,
    playground: () => <PlaygroundTab providers={providersWithModels} servers={servers} />,
    usage: () => (
      <Suspense
        fallback={
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        }
      >
        <UsageTab />
      </Suspense>
    ),
  };

  let body;
  if (seed.status === 'error') {
    body = (
      <EmptyState
        variant="error"
        title="The AI configuration could not be read"
        description={seed.error}
        onRetry={retrySeed}
      />
    );
  } else if (seed.status === 'seeding') {
    body = (
      <div className="flex justify-center py-12" role="status" aria-label="Reading configuration">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  } else {
    // Elements, not component types: a map of arrow components rebuilt each
    // render would remount the panel on every provider refresh and lose its
    // local state (a reorder in flight, a Playground draft).
    body = PANELS[activeTab]();
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        icon={Bot}
        title="AI Engine"
        status={
          seed.status === 'ready' ? (
            <span className="text-muted-foreground">
              {enabledCount} AI provider{enabledCount !== 1 ? 's' : ''} enabled · {mcpCount} MCP
              server{mcpCount !== 1 ? 's' : ''} active
            </span>
          ) : null
        }
        help={HELP}
      />

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="ai-engine"
        label="AI Engine"
      >
        <div className="pt-4">{body}</div>
      </HubTabs>

      <CatalogDrawer
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        catalog={catalog}
        providers={providers}
        onHideModel={handleHideModel}
        onRefresh={handleRefreshCatalog}
        refreshing={refreshing}
      />
    </div>
  );
}
