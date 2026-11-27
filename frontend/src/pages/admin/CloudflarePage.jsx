/**
 * Cloudflare — Admin Page (/admin/cloudflare, #1905)
 *
 * The site's Cloudflare zones, administered from the portal. Cloudflare is
 * the network in front of the site: it answers for the site's addresses
 * (DNS), passes visitors on to it, caches its pages and applies its rules.
 *
 * Two zones (#1911): the site's own and the lab's certificate zone, picked
 * above the tabs (ZonePicker) and kept in the address as `?zone=`
 * (LINK_PARAMS.zone; left out for the site's zone, so older links open it).
 * Every tab reads and writes the picked zone only, through the CloudflareZone
 * context, and is drawn afresh when the zone changes, so nothing typed for
 * one zone is sent to the other.
 *
 * Tabs (components/admin/cloudflare/tabs.js), selected by `?tab=`:
 *
 *   Overview  whether the page is set up, the zone, what the admin token can
 *             read, what is locked and why, and where to go next
 *   Settings  every zone setting, saved one at a time
 *   DNS       the DNS records, 100 at a time; add one or change one, never delete
 *   Rules     the zone's rulesets by phase; replace the rules of one of the
 *             six phases on the allow-list
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
 * The status of the picked zone is read here and handed to the tabs, which
 * use its zone name and its lists of locked names and phases. If the server
 * answers for another zone (one older than #1911 knows only the site's), the
 * tabs are replaced by a note, so no change can land in the wrong zone.
 */
import React, { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import PageHeader from '@/components/admin/shared/PageHeader';
import HubTabs from '@/components/admin/HubTabs';
import { readCloudflareStatus } from '@/lib/cloudflare';
import { LINK_PARAMS } from '@/lib/itemLinks';
import EmptyState from '@/components/admin/shared/EmptyState';
import { TABS, cloudflareParams, resolveTab } from '@/components/admin/cloudflare/tabs';
import {
  DEFAULT_ZONE,
  notConfiguredHeadline,
  resolveZone,
  zoneStatus,
} from '@/components/admin/cloudflare/cloudflareView';
import { CloudflareZone, useCloudflareRead } from '@/components/admin/cloudflare/CloudflareParts';
import ZonePicker from '@/components/admin/cloudflare/ZonePicker';
import CloudflareOverview from '@/components/admin/cloudflare/CloudflareOverview';
import CloudflareSettings from '@/components/admin/cloudflare/CloudflareSettings';
import CloudflareDns from '@/components/admin/cloudflare/CloudflareDns';
import CloudflareRules from '@/components/admin/cloudflare/CloudflareRules';
import CloudflareCache from '@/components/admin/cloudflare/CloudflareCache';

const HELP = [
  'Pick the zone first: the site’s own, or the lab’s certificate zone. Every tab then shows and changes that zone only.',
  'Overview says whether the page is set up, which parts of the zone the token can read, and what is locked and why.',
  'Settings, DNS, Rules and Cache show what Cloudflare holds now. Anyone with the editor role can look; changing anything needs the super admin role.',
  'Locked records and rule phases keep the site running and are managed by Terraform. They show a lock and the reason, and the server refuses any change to them.',
  'No DNS record or ruleset can be deleted from this page, but replacing a phase’s rules removes the ones you leave out. Every change is written to the audit log.',
];

/** The header's one line for the picked zone's status. */
function headline(status, zone) {
  if (status.configured === false) return notConfiguredHeadline(status);
  const state = status.zone?.status ? `, ${status.zone.status}` : '';
  return `Zone ${status.zone?.name || zone}${state}`;
}

/** In place of the tabs while the server cannot act on the picked zone yet. */
function OtherZoneNote({ zone, onBack }) {
  return (
    <EmptyState
      title={`The server does not manage ${zone} yet`}
      description={`The site’s API answered for another zone, so nothing here would reach ${zone}. It will once the newer version of the API is deployed; try again in a few minutes.`}
      action={
        <button
          type="button"
          className="text-sm font-medium text-primary underline underline-offset-2"
          onClick={onBack}
        >
          Go back to {DEFAULT_ZONE}
        </button>
      }
    />
  );
}

/** The tabs that take the picked zone's status, by id. */
const STATUS_TABS = Object.freeze({
  settings: CloudflareSettings,
  dns: CloudflareDns,
  rules: CloudflareRules,
  cache: CloudflareCache,
});

/** The picked tab, for the picked zone. */
function ActiveTab({ tab, status, statusRead }) {
  if (tab === 'overview') return <CloudflareOverview statusRead={statusRead} />;
  const Tab = STATUS_TABS[tab] ?? CloudflareCache;
  return <Tab status={status} />;
}

export default function CloudflarePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const zone = resolveZone(searchParams.get(LINK_PARAMS.zone));
  const loadStatus = useCallback(() => readCloudflareStatus(zone), [zone]);
  const statusRead = useCloudflareRead(loadStatus, null);
  const { status, otherZone } = zoneStatus(statusRead, zone);
  // The Overview's read: this zone's answer only, a spinner until it is in hand.
  const overviewRead = { ...statusRead, data: status, loaded: status !== null };
  // Until the server has said which zone it answered for, a zone other than the
  // site's shows only the Overview (it reads nothing but that answer). A server
  // that predates ?zone= would answer for the site's zone, and a tab mounted in
  // that moment could read or change the wrong zone (#1913 review).
  const unconfirmed = zone !== DEFAULT_ZONE && status === null && !otherZone;

  const go = (changes) => setSearchParams(cloudflareParams(searchParams, changes));
  const setTab = (id) => {
    if (id !== activeTab) go({ tab: id });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        help={HELP}
        status={
          status ? <span className="text-muted-foreground">{headline(status, zone)}</span> : null
        }
      />
      <ZonePicker zone={zone} role={status?.managed?.role} onPick={(name) => go({ zone: name })} />
      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="cloudflare"
        label="Cloudflare"
      >
        <CloudflareZone.Provider value={zone}>
          <div className="pt-4" key={zone}>
            {otherZone ? (
              <OtherZoneNote zone={zone} onBack={() => go({ zone: DEFAULT_ZONE })} />
            ) : (
              <ActiveTab
                tab={unconfirmed ? 'overview' : activeTab}
                status={status}
                statusRead={overviewRead}
              />
            )}
          </div>
        </CloudflareZone.Provider>
      </HubTabs>
    </div>
  );
}
