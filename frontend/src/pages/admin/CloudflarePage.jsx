/**
 * Cloudflare — Admin Page (/admin/cloudflare, #1905)
 *
 * The site's Cloudflare zone, administered from the portal. Cloudflare is
 * the network in front of the site: it answers for the site's addresses
 * (DNS), passes visitors on to it, caches its pages and applies its rules.
 * Tabs (components/admin/cloudflare/tabs.js), selected by `?tab=`:
 *
 *   Overview  whether the page is set up, the zone, what the admin token can
 *             read, what is locked and why, and where to go next
 *   Settings  every zone setting, saved one at a time
 *   DNS       every DNS record; add one or change one, never delete
 *   Rules     the zone's rulesets by phase; replace the rules of one of the
 *             five phases on the allow-list
 *   Cache     empty the whole cache, or up to 30 addresses
 *
 * Every call goes through the server's `cms/cloudflare/` routes, which hold
 * the admin token (Key Vault, CLOUDFLARE-ADMIN-TOKEN) and never send it to
 * the browser. Reading is the editor's; every change is super_admin, gated
 * by RoleGate here and refused by the server below that role. The server
 * decides what is locked (the site's own names, the records and rules
 * Terraform manages) and refuses a change to it; there is no delete route.
 * Claude Network Guy, an agent key on the Agents page, uses the same routes.
 *
 * The status is read once here and handed to the tabs, which use its zone
 * name and its lists of locked names and phases.
 */
import React from 'react';
import { useSearchParams } from 'react-router';
import PageHeader from '@/components/admin/shared/PageHeader';
import HubTabs from '@/components/admin/HubTabs';
import { readCloudflareStatus } from '@/lib/cloudflare';
import { TABS, resolveTab } from '@/components/admin/cloudflare/tabs';
import { notConfiguredHeadline } from '@/components/admin/cloudflare/cloudflareView';
import { useCloudflareRead } from '@/components/admin/cloudflare/CloudflareParts';
import CloudflareOverview from '@/components/admin/cloudflare/CloudflareOverview';
import CloudflareSettings from '@/components/admin/cloudflare/CloudflareSettings';
import CloudflareDns from '@/components/admin/cloudflare/CloudflareDns';
import CloudflareRules from '@/components/admin/cloudflare/CloudflareRules';
import CloudflareCache from '@/components/admin/cloudflare/CloudflareCache';

const HELP = [
  'Overview says whether the page is set up, which parts of the zone the token can read, and what is locked and why.',
  'Settings, DNS, Rules and Cache show what Cloudflare holds now. Anyone with the editor role can look; changing anything needs the super admin role.',
  'Locked records and rule phases keep the site running and are managed by Terraform. They show a lock and the reason, and the server refuses any change to them.',
  'No DNS record or ruleset can be deleted from this page, but replacing a phase’s rules removes the ones you leave out. Every change is written to the audit log.',
];

export default function CloudflarePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const statusRead = useCloudflareRead(readCloudflareStatus, null);
  const status = statusRead.loaded ? statusRead.data : null;

  const setTab = (id) => {
    if (id === activeTab) return;
    setSearchParams({ tab: id });
  };

  const zone = status?.zone?.name;
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        help={HELP}
        status={
          status ? (
            <span className="text-muted-foreground">
              {status.configured === false
                ? notConfiguredHeadline(status)
                : `Zone ${zone || 'unknown'}${status.zone?.status ? `, ${status.zone.status}` : ''}`}
            </span>
          ) : null
        }
      />
      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="cloudflare"
        label="Cloudflare"
      >
        <div className="pt-4">
          {activeTab === 'overview' && <CloudflareOverview statusRead={statusRead} />}
          {activeTab === 'settings' && <CloudflareSettings status={status} />}
          {activeTab === 'dns' && <CloudflareDns status={status} />}
          {activeTab === 'rules' && <CloudflareRules status={status} />}
          {activeTab === 'cache' && <CloudflareCache status={status} />}
        </div>
      </HubTabs>
    </div>
  );
}
