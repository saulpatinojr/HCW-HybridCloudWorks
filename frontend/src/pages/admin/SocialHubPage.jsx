/**
 * Social Hub (route `/admin/social-hub`) — schedule HCW articles to LinkedIn, X,
 * Facebook, Instagram, Threads and YouTube through Publer, and see what went
 * out.
 *
 * Until #575 this was one 1,551-line component holding the Publer client, the
 * view helpers and four tabs' worth of JSX. It now has a tab per duty, at the
 * Newsletter Hub's standard (components/admin/social):
 *
 *   Compose    pick a published page, choose accounts, write the caption and
 *              schedule it — or publish it now
 *   Queue      what Publer is holding, and this hub's own records of it, each
 *              editable and movable
 *   Published  the history, by day, with the per-account outcomes Publer sent
 *   Accounts   the connected profiles and which platforms they cover
 *   Settings   whether the proxy can use its credentials, and where the rest
 *              of it is set
 *
 * Deep links are `?tab=`; the old id `settings` still lands on Settings, and
 * the words for content that moved (connection, profiles, calendar) land where
 * it went (social/tabs.js). `?contentId=` preselects a page on Compose; the
 * Calendar's Share and Schedule Social carry it.
 *
 * The header's connection state is the ACCOUNTS CALL's answer (ADR 0033
 * Amplify slice). Until 2026-10-03 it was a constant `true`, so a missing key
 * and a refused one both read as connected.
 *
 * Publer credentials are function-app settings resolved by the `publerProxy`
 * Azure Function and are never bundled into the client (FINDING-04):
 *   PUBLER_API_KEY        — Publer API key
 *   PUBLER_WORKSPACE_ID   — Publer workspace ID
 */

import React from 'react';
import { useSearchParams } from 'react-router';
import { Share2 } from 'lucide-react';
import { useAuthReady } from '@/hooks/useAuthReady';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import HubTabs from '@/components/admin/HubTabs';
import ComposeTab from '@/components/admin/social/ComposeTab';
import QueueTab from '@/components/admin/social/QueueTab';
import PublishedTab from '@/components/admin/social/PublishedTab';
import AccountsTab from '@/components/admin/social/AccountsTab';
import SettingsTab from '@/components/admin/social/SettingsTab';
import usePublerAccounts from '@/components/admin/social/usePublerAccounts';
import { TABS, resolveTab } from '@/components/admin/social/tabs';

/**
 * Each tab's panel, by id. With TABS in social/tabs.js this is the whole of
 * adding a tab: every panel is handed the same two props — whether auth is
 * ready, and the `?contentId=` a deep link from the publish flow carries — and
 * reads whatever else it needs itself.
 */
const PANELS = {
  compose: ComposeTab,
  queue: QueueTab,
  published: PublishedTab,
  accounts: AccountsTab,
  settings: SettingsTab,
};

/** The accounts read's four states as the shared system vocabulary. */
export const HEADER_STATUS = Object.freeze({
  loading: { system: 'unknown', text: 'Checking Publer…' },
  ready: { system: 'healthy', text: 'Publer connected' },
  not_configured: { system: 'critical', text: 'Publer not connected — see Accounts' },
  error: { system: 'offline', text: 'Publer could not be reached' },
});

const HELP = [
  'Compose: pick a live page, choose the Publer accounts, write (or generate) a caption, and post now or at a time. The Calendar’s Share button lands here with the page preselected.',
  'Queue: what Publer will post, and this hub’s own records of it. Edit a caption or move a record’s time here; Publer is updated through the change feed.',
  'Published: what went out, by day, with each account’s outcome as Publer reported it.',
  'Accounts: the profiles connected in Publer. Add or remove them there; this hub only reads the list.',
  'Settings: whether the server can use its Publer key and workspace id, and where those are set.',
];

export default function SocialHubPage() {
  const { authReady } = useAuthReady();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const { status, error, reason } = usePublerAccounts();
  const header = HEADER_STATUS[status] || HEADER_STATUS.loading;

  const setTab = (id) => {
    if (id === activeTab) return;
    setSearchParams({ tab: id });
  };

  const ActivePanel = PANELS[activeTab];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Share2}
        help={HELP}
        status={
          <>
            <StatusBadge system={header.system} />
            <span className="text-muted-foreground" title={error || reason || undefined}>
              {header.text}
            </span>
          </>
        }
      />

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="social"
        label="Social Hub"
      >
        <ActivePanel ready={authReady} contentId={searchParams.get('contentId') || ''} />
      </HubTabs>
    </div>
  );
}
