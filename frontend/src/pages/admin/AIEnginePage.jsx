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

import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { Bot, Loader2, RefreshCw, AlertTriangle, X } from 'lucide-react';
import {
  aiEngine,
  seedAiEngineIfEmpty,
  subscribeProviders,
  subscribeMcpServers,
} from '@/lib/aiEngine';
import { withCatalogModels } from '@/lib/aiEngine/catalog';
import HubTabs from '@/components/admin/HubTabs';
import PageHeader from '@/components/admin/shared/PageHeader';
import EmptyState from '@/components/admin/shared/EmptyState';
import TasksTab from '@/components/admin/ai-engine/TasksTab';
import CatalogDrawer from '@/components/admin/ai-engine/CatalogDrawer';
import { TABS, resolveTab } from '@/components/admin/ai-engine/tabs';

import ServicesTab, {
  describeLastTest,
  describeRefreshSummary,
  orderByPriority,
  ProviderCard,
  FeatureSwitches,
} from '@/components/admin/ai-engine/ServicesTab';
import McpTab, { McpServerCard } from '@/components/admin/ai-engine/McpTab';
import PlaygroundTab from '@/components/admin/ai-engine/PlaygroundTab';

export {
  FeatureSwitches,
  McpServerCard,
  ProviderCard,
  describeLastTest,
  describeRefreshSummary,
  orderByPriority,
};

const UsageTab = lazy(() => import('@/pages/admin/AIEngineUsageTab'));

// ─── Main Page ────────────────────────────────────────────────────────────────

const HELP = [
  'AI Services holds the Priority list: a call goes to P1 first and falls through in order when a provider cannot serve. Each row names the model the list uses for that provider, or leaves it on the provider’s default. The model lists come from the providers themselves, refreshed by the weekly check or the Refresh model lists button, and the Model catalogue shows every model with its price and status; a model can be hidden from the dropdowns.',
  'Tasks shows one row per AI task (drafting, grading, captions, the assistant…) with the model the router will use right now. Recommended takes the model the site recommends for the task, Global follows the Priority list, Custom names a chain of its own; a task can also exclude a provider. Test runs the task’s chain and says which candidate answered.',
  'Where AI is used (on AI Services) switches a task off entirely; Tasks decides who serves it when it is on.',
  'MCP Servers are tool servers the Playground and the bots can call; keys stay in app settings named MCP_* and are never sent to the browser.',
  'Usage & Cost lists every recorded call. Since ADR 0033 every call through the router records one row, sourced to its task.',
];

/**
 * The catalogue's failure, shown rather than logged (AP-F12, #936). It names
 * what still works — every tab, on the lists the stored documents carry —
 * and what needs the catalogue: the drawer, Hide and Refresh. Dismissible,
 * and back on the next failed read; the shape is McpOAuthResultBanner's.
 */
function CatalogNotice({ error, onRetry, onDismiss }) {
  return (
    <div
      role="alert"
      className="p-3 border rounded-lg text-sm flex items-start gap-2 bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-300"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="font-medium">The model catalogue could not be loaded.</p>
        <p className="text-xs font-mono break-words">{error}</p>
        <p className="text-xs">
          The provider cards and the Tasks tab show the model lists their stored documents carry,
          and every tab still works. The Model catalogue drawer, hiding a model and refreshing the
          lists need the catalogue.
        </p>
        <Button size="sm" variant="outline" className="h-7 text-xs px-2" onClick={onRetry}>
          <RefreshCw className="h-3 w-3 mr-1" aria-hidden="true" /> Try again
        </Button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 opacity-70 hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * The AI Engine page: seeds the configuration, reads the catalogue, and holds
 * the writes its tabs and the drawer share, so no tab keeps a list of its own.
 */
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
  // whatever their stored documents carry rather than emptying the selects —
  // and says so (AP-F12, #936). The failure used to be logged and nothing
  // else, so a page whose dropdowns held only the provider default looked
  // like a page with no models rather than a page that could not read them.
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState(null);
  // ONLY THE LATEST READ LANDS (AP-F12, #936). Try again pressed twice, or a
  // hide's re-read beside a refresh's, puts two reads in flight, and they can
  // settle in either order: an earlier failure would bring the notice back
  // over a later success, and an older catalogue could replace a newer one.
  // Each read takes a number; one that is no longer the latest is logged if
  // it failed and otherwise ignored.
  const catalogRead = useRef(0);
  /** Read the catalogue and show it, or say it failed — unless a newer read has started since. */
  const loadCatalog = useCallback(() => {
    const read = ++catalogRead.current;
    const latest = () => read === catalogRead.current;
    return aiEngine
      .fetchModelCatalog()
      .then((next) => {
        if (!latest()) return;
        setCatalog(next);
        setCatalogError(null);
      })
      .catch((err) => {
        console.error('[aiEngine] model catalogue load failed:', err);
        if (!latest()) return;
        setCatalogError(err?.message || 'The model catalogue could not be read.');
      });
  }, []);
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

      {seed.status === 'ready' && catalogError && (
        <CatalogNotice
          error={catalogError}
          onRetry={loadCatalog}
          onDismiss={() => setCatalogError(null)}
        />
      )}

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
