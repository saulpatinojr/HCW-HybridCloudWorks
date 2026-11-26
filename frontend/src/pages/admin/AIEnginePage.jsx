/**
 * AI Engine — Admin Page  (/admin/ai-engine)
 *
 * Eight tabs (components/admin/ai-engine/tabs.js), selected by `?tab=`:
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
 *   6. Koda          — the content agent's API key, what it may do, and how
 *                      the Muse connector reaches the site (ADR 0037;
 *                      components/admin/ai-engine/KodaTab.jsx)
 *   6a. Claude       — one more agent key, on the same tab component over its
 *                      own record, switches and audit trail
 *                      (components/admin/ai-engine/agentKeys.js)
 *   7. Developer API — event organizers' keys for the Developer API: make,
 *                      re-scope, rotate, revoke, and what a key can reach
 *                      (ADR 0042; components/admin/ai-engine/DeveloperApiTab.jsx)
 *
 * The model catalogue drawer (CatalogDrawer) opens from the first two tabs.
 * The "Site Services" tab that sat between them until ADR 0033 was a
 * placeholder: local state over a stale provider list that saved nothing.
 * Its address lands on Tasks, which answers the question it posed. The
 * per-feature placement selects and the cards' model pin left with ADR 0034
 * slice 4 (#859): the Priority list's per-row model and the Tasks tab
 * replaced them, and the selection document is what the router reads.
 */

import React, { useMemo, useState, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { Bot, Loader2, RefreshCw, AlertTriangle, X } from 'lucide-react';
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
import KodaTab from '@/components/admin/ai-engine/KodaTab';
import { AGENT_KEY_TABS } from '@/components/admin/ai-engine/agentKeys';
import DeveloperApiTab from '@/components/admin/ai-engine/DeveloperApiTab';
import { useAiEngineSeed, useModelCatalog } from './aiEngine/useAiEngineData';

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
  'Koda is the content agent (run by Muse) that drafts and reviews posts through its own API key. The tab makes, rotates and revokes that key, switches what it may do, and lists every address it can call; the key works on the Drafts stage and the published reads only, never on publishing or settings.',
  'Developer API holds the keys event organizers use to manage their calls for speakers from their own code. Each organizer gets one key with only the scopes they need; a key is shown once when it is made or rotated, and revoking it cuts access on its next request. No key can publish anything: publishing stays in the admin.',
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
 * The tab's body once the configuration is read; until then, the spinner or
 * the failure with a retry. `panel` builds the tab's element.
 */
function SeedGate({ seed, onRetry, panel }) {
  if (seed.status === 'error') {
    return (
      <EmptyState
        variant="error"
        title="The AI configuration could not be read"
        description={seed.error}
        onRetry={onRetry}
      />
    );
  }
  if (seed.status === 'seeding') {
    return (
      <div className="flex justify-center py-12" role="status" aria-label="Reading configuration">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }
  // Elements, not component types: a map of arrow components rebuilt each
  // render would remount the panel on every provider refresh and lose its
  // local state (a reorder in flight, a Playground draft).
  return panel();
}

/**
 * The AI Engine page: seeds the configuration, reads the catalogue, and holds
 * the writes its tabs and the drawer share, so no tab keeps a list of its own.
 */
export default function AIEnginePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const { providers, servers, seed, retrySeed } = useAiEngineSeed();
  const { toast } = useToast();
  const {
    catalog,
    catalogError,
    dismissCatalogError,
    loadCatalog,
    refreshing,
    handleHideModel,
    handleRefreshCatalog,
  } = useModelCatalog(seed.status === 'ready', toast);

  // The one place the catalogue's lists reach the provider documents: every
  // tab below reads `provider.models` and none of them keeps a list.
  const providersWithModels = useMemo(
    () => withCatalogModels(providers, catalog),
    [providers, catalog]
  );
  const [catalogOpen, setCatalogOpen] = useState(false);

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
    koda: () => <KodaTab />,
    // Every other agent key gets the same tab over its own record; `key`
    // remounts it, so a key shown once on one tab never shows on another.
    ...Object.fromEntries(
      AGENT_KEY_TABS.filter((entry) => entry.id !== 'koda').map((entry) => [
        entry.id,
        () => <KodaTab key={entry.id} agent={entry} />,
      ])
    ),
    'developer-api': () => <DeveloperApiTab />,
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
        <CatalogNotice error={catalogError} onRetry={loadCatalog} onDismiss={dismissCatalogError} />
      )}

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="ai-engine"
        label="AI Engine"
      >
        <div className="pt-4">
          <SeedGate seed={seed} onRetry={retrySeed} panel={PANELS[activeTab]} />
        </div>
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
