import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import IntegrationBadge from '@/components/admin/shared/IntegrationBadge';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/use-toast';
import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Play,
  ExternalLink,
  BookOpen,
  ToggleLeft,
  Loader2,
} from 'lucide-react';
import { aiEngine } from '@/lib/aiEngine';
import { catalogEntries, describeRefresh } from '@/lib/aiEngine/catalog';
import PriorityList from './PriorityList';
import useSelection from './useSelection';

export function StatusBadge({ status }) {
  const map = {
    connected: { label: 'Connected', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    error: { label: 'Error', cls: 'bg-red-100 text-red-700 border-red-200' },
    untested: { label: 'Untested', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
    unavailable: { label: 'No API yet', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
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

export function ProviderIcon({ provider }) {
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

export function describeLastTest(provider, now = Date.now()) {
  if (!provider?.lastTested) return null;
  const by = provider.lastTestedBy === 'probe' ? ' by the weekly check' : '';
  return `Tested ${timeAgo(provider.lastTested, now)}${by}`;
}

const MODEL_BADGE = 'text-xs uppercase tracking-wide px-1.5 py-0.5 rounded border';
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

            {!isUnavailable && catalogEntry && (
              <ModelList provider={provider} entry={catalogEntry} onHideModel={onHideModel} />
            )}

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

        {testError && provider.status === 'error' && (
          <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 rounded text-xs text-red-600 dark:text-red-400">
            {testError}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

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

export function orderByPriority(providers, selection) {
  const rank = new Map((selection?.global?.priority || []).map((s, i) => [s.provider, i]));
  return [...providers].sort(
    (a, b) =>
      (rank.get(a.id) ?? 1000 + (a.order ?? 99)) - (rank.get(b.id) ?? 1000 + (b.order ?? 99))
  );
}

export default function ServicesTab({
  providers,
  catalog,
  onHideModel,
  onRefreshCatalog,
  refreshing,
  onOpenCatalog,
}) {
  const { toast } = useToast();
  const { state, saving, reload, save } = useSelection();

  const failed = (title) => (err) =>
    toast({ title, description: err?.message || 'Nothing was changed.', variant: 'destructive' });

  const handleToggle = async (id, enabled) => {
    try {
      await aiEngine.setEnabled('ai_providers', id, enabled);
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
