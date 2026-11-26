/**
 * Agents — Admin Page (/admin/agents, #1905)
 *
 * The outside agents that call this site, and the keys they call it with.
 * Tabs (components/admin/agents/tabs.js), selected by `?tab=`:
 *
 *   Overview  what an agent key is, in plain words, and every key the site
 *             can hold: its job, how many switches are on, its state, and a
 *             link to its tab (AgentsOverview.jsx)
 *   one tab per key, in the key list's order (ai-engine/agentKeys.js): Koda,
 *             Claude Publisher, Claude Network Guy. Each is the same
 *             component (ai-engine/KodaTab.jsx) over that key's own record,
 *             switches and audit trail: the one place the key is made,
 *             switched, rotated and revoked (ADR 0037).
 *
 * The key tabs were on the AI Engine page until #1905; an old address such
 * as `/admin/ai-engine?tab=koda` redirects here, to the matching tab
 * (ai-engine/tabs.js agentsPageRedirect).
 *
 * Reading is the editor's; every write on a key tab is super_admin, gated by
 * RoleGate inside KodaTab, as the server's admin-handlers.js requires.
 */
import React from 'react';
import { useSearchParams } from 'react-router';
import PageHeader from '@/components/admin/shared/PageHeader';
import HubTabs from '@/components/admin/HubTabs';
import KodaTab from '@/components/admin/ai-engine/KodaTab';
import { agentKeyTab } from '@/components/admin/ai-engine/agentKeys';
import AgentsOverview from '@/components/admin/agents/AgentsOverview';
import { TABS, resolveTab } from '@/components/admin/agents/tabs';

const HELP = [
  'An agent is a program that works on the site for you. It signs in with its own agent key, which the site shows once and then keeps only a fingerprint of.',
  'Overview lists every agent: what it is for, how many of its switches are on, and whether its key is active.',
  'Each agent’s tab makes, rotates and revokes its key, and turns its switches on and off. Those changes need the super admin role; anyone with the editor role can look.',
  'No agent key can publish, or delete a DNS record, a ruleset or any content, whatever is switched on; replacing a phase’s Cloudflare rules does remove the ones left out. Every change it makes, and every call it is refused, is in the audit log; reads are not.',
];

export default function AgentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const agent = agentKeyTab(activeTab);

  const setTab = (id) => {
    if (id === activeTab) return;
    setSearchParams({ tab: id });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader help={HELP} />
      <HubTabs tabs={TABS} active={activeTab} onSelect={setTab} idPrefix="agents" label="Agents">
        <div className="pt-4">
          {/* `key` remounts the tab per agent, so a key shown once on one
              tab never shows on another. */}
          {agent ? <KodaTab key={agent.id} agent={agent} /> : <AgentsOverview />}
        </div>
      </HubTabs>
    </div>
  );
}
