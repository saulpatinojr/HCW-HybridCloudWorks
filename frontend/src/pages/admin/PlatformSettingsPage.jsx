/**
 * Platform Settings Hub (route `/admin/platform-settings`) — the `admin_config`
 * documents the pipeline reads on every run, one tab per concern (#571), at
 * the Newsletter Hub's level of separation (components/admin/platform-settings):
 *
 *   All settings       the index: every setting document, where it is stored,
 *                      where it is edited, and a deep link (ADR 0033 Platform)
 *   Content defaults   default covers; a link to the newsletter's own settings
 *   Content types      what an item becomes and how it became an idea (ADR 0033)
 *   Social automation  autoposting to Publer on a live publish
 *   Audio              podcast feeds and the Listen & Learn voice
 *   Reminders          dated things not to forget, said on Telegram by the daily check
 *   Change history     every save, who made it and what it recorded — including
 *                      the Sessionize speaker id saved on Integrations
 *
 * Each tab mounts only while it is open and loads its own settings, with its
 * own loading and error states, so a failure in one never blanks another.
 * Tabs deep-link with `?tab=`; an id this page does not know lands on the
 * index rather than on a blank page.
 *
 * Settings stay where the thing they configure is seen working — the Audio
 * tab, the Newsletter Hub, AI Engine, Integrations — and the index is the map.
 * There is no single provider here, so the header names none: Publer is named
 * where it is used, on Social automation.
 */

import React from 'react';
import { useSearchParams } from 'react-router';
import { SlidersHorizontal } from 'lucide-react';
import PageHeader from '@/components/admin/shared/PageHeader';
import AllSettingsTab from '@/components/admin/platform-settings/AllSettingsTab';
import ContentDefaultsTab from '@/components/admin/platform-settings/ContentDefaultsTab';
import SocialAutomationTab from '@/components/admin/platform-settings/SocialAutomationTab';
import AudioTab from '@/components/admin/platform-settings/AudioTab';
import ChangeHistoryTab from '@/components/admin/platform-settings/ChangeHistoryTab';
import RemindersTab from '@/components/admin/platform-settings/RemindersTab';
import TaxonomyTab from '@/components/admin/platform-settings/TaxonomyTab';
import HubTabs from '@/components/admin/HubTabs';

export const TABS = Object.freeze([
  { id: 'index', label: 'All settings', Component: AllSettingsTab },
  { id: 'content', label: 'Content defaults', Component: ContentDefaultsTab },
  { id: 'taxonomy', label: 'Content types & origins', Component: TaxonomyTab },
  { id: 'social', label: 'Social automation', Component: SocialAutomationTab },
  { id: 'audio', label: 'Audio', Component: AudioTab },
  { id: 'reminders', label: 'Reminders', Component: RemindersTab },
  { id: 'history', label: 'Change history', Component: ChangeHistoryTab },
]);

const HELP = [
  'All settings is the map: every configuration document the platform reads, where it is stored, where it is edited, and a link. Nothing is edited on that tab.',
  'Content defaults, Content types & origins, Social automation and Audio each edit one group of documents. A save is checked against the exact shape the code reads, replaces the document whole, and is listed under Change history.',
  'Settings that belong to another hub — newsletter, AI Engine, Sessionize, gallery folders, Plaud, Labs — are edited there and listed here, so the index is complete without moving them.',
  'Change history lists every save with who made it and what it recorded (counts and choices, never contents), including the Sessionize speaker id saved on Integrations.',
];

/** The tab a `?tab=` value opens: a known id, else the index. */
export function resolveTab(requested) {
  return TABS.find((tab) => tab.id === requested) ?? TABS[0];
}

export default function PlatformSettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = resolveTab(searchParams.get('tab'));
  const ActiveTab = active.Component;
  return (
    <div className="space-y-6">
      <PageHeader
        icon={SlidersHorizontal}
        description="Documents the pipeline reads on every run. Each save is checked against the exact shape the code expects before it is stored, replaces the document whole, and is listed under Change history."
        help={HELP}
      />

      <HubTabs
        tabs={TABS}
        active={active.id}
        onSelect={(id) => setSearchParams({ tab: id })}
        idPrefix="platform"
        label="Platform settings"
      >
        <ActiveTab key={active.id} />
      </HubTabs>
    </div>
  );
}
