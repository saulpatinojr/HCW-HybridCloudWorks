/**
 * Integrations Hub (route `/admin/integrations`) — every third-party service,
 * whether it answers, and the keys it answers with.
 *
 * It replaced two pages about one subject from opposite ends: Connections
 * could tell you Publer was refusing calls, API Keys could rotate
 * `PUBLER-API-KEY`, and neither could do the other. Until #570 the merged page
 * was one long scroll. It now has a tab per duty, at the Newsletter Hub's
 * standard (components/admin/integrations):
 *
 *   Overview  every service on one grid, broken and not-configured first, with
 *             Test all (one service at a time) and when each was last tested
 *   Services  one group at a time; each card has its test, its docs link,
 *             what it is for and where it is used, and the names and lights
 *             of the keys it uses
 *   Keys      every Key Vault credential: its light, the services that use
 *             it, paste and generate, and "Other credentials"
 *   Credentials  every credential in every store (Key Vault, GitHub, HCP
 *             Terraform, the lab host and the rest): its age, its expiry,
 *             whether anything renews it, overdue in red, and a recorded
 *             rotation date for the ones only the owner renews, which moves
 *             their Telegram reminder (#1026)
 *   Identity  the Entra configuration the browser and the API run on
 *
 * Deep links are `?tab=` (and `?group=` on Services); an unknown or moved tab
 * id lands where its content went, and `/admin/connections` and
 * `/admin/api-keys` redirect to Overview and Keys (tabs.js).
 *
 * Each tab loads its own data, with its own loading and error states, so one
 * refused request never blanks another tab or the tab bar. The session's test
 * results live here, on the page, so they survive switching tabs — and since
 * ADR 0033 each is recorded to `cms/integration-status`, so the last verdict
 * survives a reload too and the Health page can show it.
 *
 * No tab shows a credential value, masked or otherwise: the API has no read
 * path for one and the app's vault role cannot read one.
 *
 * NO ACTIVITY TAB, ON PURPOSE. Key writes record only the latest
 * `lastWriteAt`/`lastWriteBy` per key (shown on each Keys row); nothing writes
 * an audit row for a key change and there is no admin route that reads
 * `admin_audit_logs`. A history tab needs that backend first — see #570.
 */

import React from 'react';
import { useSearchParams } from 'react-router';
import { Plug } from 'lucide-react';
import PageHeader from '@/components/admin/shared/PageHeader';
import IntegrationsOverview from '@/components/admin/integrations/IntegrationsOverview';
import IntegrationsDirectory from '@/components/admin/integrations/IntegrationsDirectory';
import IntegrationsServices from '@/components/admin/integrations/IntegrationsServices';
import IntegrationsKeys from '@/components/admin/integrations/IntegrationsKeys';
import IntegrationsCredentials from '@/components/admin/integrations/IntegrationsCredentials';
import IntegrationsIdentity from '@/components/admin/integrations/IntegrationsIdentity';
import useServiceTests from '@/components/admin/integrations/useServiceTests';
import { TABS, resolveTab } from '@/components/admin/integrations/tabs';
import HubTabs from '@/components/admin/HubTabs';

const HELP = [
  'Overview lists every service worst first. A red word is the one to look at; press Test all to ask every safe service at once, one at a time.',
  'Services groups the cards. Each says what the service does for the site, where it is used, which way data flows and what its key can reach, with a beaker to test it.',
  'Keys is the only place a credential is written. Paste a new value to rotate; nothing here can read one back. Disconnecting a key-based service means replacing or revoking its key.',
  'Credentials lists every credential in every store with its age and expiry; overdue is red. Record the date you rotated one the site cannot read, and its Telegram reminder moves with it.',
  'Identity shows the Entra app registrations the browser and the API run on. The Health page tests the token this session actually holds.',
  'Every test result is recorded, so "last worked" and "last failed" are still here tomorrow and on the Health page.',
];

export default function IntegrationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const tests = useServiceTests();

  // The chosen Services group rides along in the URL on every tab, so it
  // survives a click on the active tab and a trip to another tab and back.
  const setTab = (id) => {
    if (id === activeTab) return;
    const group = searchParams.get('group');
    setSearchParams(group ? { tab: id, group } : { tab: id });
  };
  const openGroup = (group) => setSearchParams({ tab: 'services', group });
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Plug}
        description="Every third-party service, whether it is answering, and the keys it answers with; the Directory explains what each one is and brings. Keys are held in Azure Key Vault and can be written here but never read back."
        help={HELP}
      />

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="integrations"
        label="Integrations Hub"
      >
        {activeTab === 'overview' && <IntegrationsOverview tests={tests} onOpenGroup={openGroup} />}
        {activeTab === 'directory' && <IntegrationsDirectory tests={tests} />}
        {activeTab === 'services' && (
          <IntegrationsServices
            group={searchParams.get('group')}
            onGroupChange={openGroup}
            onOpenKeys={() => setTab('keys')}
            tests={tests}
          />
        )}
        {activeTab === 'keys' && <IntegrationsKeys />}
        {activeTab === 'credentials' && <IntegrationsCredentials />}
        {activeTab === 'identity' && <IntegrationsIdentity />}
      </HubTabs>
    </div>
  );
}
