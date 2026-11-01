/**
 * Cost (route `/admin/cost`) — what the platform costs this month, in one
 * place (ADR 0039). Owner request 2026-11-01: a Cost page under Platform that
 * shows current and end-of-month costs for Azure, the AI providers (with
 * credits left) and the subscriptions paid outside Azure.
 *
 *   Overview  the month at a glance: Azure against its budgets, AI spend,
 *             subscriptions per month, the alerts count, the last months,
 *             and what was read when (with Refresh)
 *   Azure     one card per subscription or resource group with a budget:
 *             spend, Azure's forecast, the daily line and the top services
 *   AI        the usage ledger's estimate by provider and by task, the
 *             ElevenLabs credits, the image budget, the Foundry budget
 *   Services  the subscriptions ledger the owner keeps by hand: add, edit,
 *             remove, renewals coming up and overdue
 *   Alerts    every cost alert with its rule, and the settings that decide
 *             when one is raised and whether Telegram hears about it
 *
 * The page reads one snapshot (`GET cms/cost/summary`) and hands it to every
 * tab, so switching tabs never re-reads Azure. The snapshot is rebuilt every
 * few hours by the cost watch (functions/src/lib/cost/watch.js) and on
 * Refresh; the Services tab reads the ledger itself, live. Deep links are
 * `?tab=`; an unknown or guessed id lands where its content is (tabs.js).
 */
import React from 'react';
import { useSearchParams } from 'react-router';
import { Loader2, Wallet } from 'lucide-react';
import PageHeader from '@/components/admin/shared/PageHeader';
import EmptyState from '@/components/admin/shared/EmptyState';
import HubTabs from '@/components/admin/HubTabs';
import OverviewTab from '@/components/admin/cost/OverviewTab';
import AzureTab from '@/components/admin/cost/AzureTab';
import AiTab from '@/components/admin/cost/AiTab';
import ServicesTab from '@/components/admin/cost/ServicesTab';
import AlertsTab from '@/components/admin/cost/AlertsTab';
import useCostSummary from '@/components/admin/cost/useCostSummary';
import { TABS, resolveTab } from '@/components/admin/cost/tabs';

const HELP = [
  'Overview is the month at a glance. Each tile opens the tab with the detail. The line at the bottom says what was read and when; Refresh reads Azure again (at most once every five minutes).',
  'Azure shows each subscription or resource group with a budget: what it has spent this month, what Azure expects by the end of the month, and which services cost the most. Azure updates its cost figures a few times a day, so today’s spend can lag by up to a day.',
  'AI is the site’s own estimate from its usage ledger (every model call writes a row), plus the credits ElevenLabs reports and the monthly image budget. Most AI providers do not report a balance, so their figures are estimates, not invoices.',
  'Services is a sheet you keep: the subscriptions paid outside Azure (domain, Cloudflare, Publer and so on). Their renewal dates appear on the Calendar and raise an alert before they renew.',
  'Alerts lists everything that needs a look, worst first, with the rule behind it. Warnings and critical alerts are also sent once to Telegram, and to the dashboard’s Needs a decision list.',
];

export default function CostPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const { summary, pending, error, refresh } = useCostSummary();

  const setTab = (id) => {
    if (id !== activeTab) setSearchParams({ tab: id });
  };

  let body;
  if (error && !summary) {
    body = (
      <div className="pt-4">
        <EmptyState
          variant="error"
          title="The cost figures could not be read"
          description={error}
          onRetry={() => refresh(false)}
        />
      </div>
    );
  } else if (!summary) {
    body = (
      <div
        className="flex justify-center py-12"
        role="status"
        aria-label="Reading the cost figures"
      >
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  } else {
    body = (
      <>
        {activeTab === 'overview' && (
          <OverviewTab summary={summary} pending={pending} onRefresh={refresh} />
        )}
        {activeTab === 'azure' && <AzureTab summary={summary} />}
        {activeTab === 'ai' && <AiTab summary={summary} />}
        {activeTab === 'services' && (
          <ServicesTab summary={summary} onChanged={() => refresh(false)} />
        )}
        {activeTab === 'alerts' && <AlertsTab summary={summary} onRefresh={refresh} />}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Wallet}
        description="What the platform costs this month and what it is on course to cost by the end of it: Azure against its budgets, AI usage and credits left, and the subscriptions paid outside Azure, with alerts before anything runs over."
        help={HELP}
      />
      <HubTabs tabs={TABS} active={activeTab} onSelect={setTab} idPrefix="cost" label="Cost">
        {body}
      </HubTabs>
    </div>
  );
}
