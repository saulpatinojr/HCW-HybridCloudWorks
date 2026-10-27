/**
 * Ambassador Hub (route `/admin/ambassador`) — Spotlight (ADR 0033 §4).
 * Everything here exists to culminate in a credible application: the
 * programs worth pursuing, one application per pursuit, the evidence that
 * backs it (imported from Speaking, Certifications and Published content, or
 * added by hand), the deadlines and renewals around it, and a readiness
 * score that explains itself and never promises acceptance.
 *
 * Five tabs by duty, Settings last (components/admin/ambassador):
 *
 *   Dashboard     where every pursuit stands, what is due, what to do next
 *   Programs      the catalogue, with details, requirements and readiness
 *   Applications  the list, and the workspace for the one selected
 *   Evidence      the library, with filters and the three imports
 *   Settings      programs, requirements, evidence types, reminders, fields
 *
 * The three reads are the page's (useAmbassadorData), so switching tabs
 * never refetches and an edit on one tab is on every other. Until the
 * `ambassador` container exists the API answers NOT_PROVISIONED and the hub
 * shows that one state with the owner's plan command (§6 item 4).
 */
import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';
import { BadgeCheck } from 'lucide-react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { useToast } from '@/components/ui/use-toast';
import HubTabs from '@/components/admin/HubTabs';
import PageHeader from '@/components/admin/shared/PageHeader';
import DashboardTab from '@/components/admin/ambassador/DashboardTab';
import ProgramsTab from '@/components/admin/ambassador/ProgramsTab';
import ApplicationsTab from '@/components/admin/ambassador/ApplicationsTab';
import EvidenceTab from '@/components/admin/ambassador/EvidenceTab';
import SettingsTab from '@/components/admin/ambassador/SettingsTab';
import NotProvisioned from '@/components/admin/ambassador/NotProvisioned';
import useAmbassadorData from '@/components/admin/ambassador/useAmbassadorData';
import { TABS, resolveTab } from '@/components/admin/ambassador/tabs';

const PANELS = {
  dashboard: DashboardTab,
  programs: ProgramsTab,
  applications: ApplicationsTab,
  evidence: EvidenceTab,
  settings: SettingsTab,
};

const HELP = [
  'Everything here exists to culminate in a credible application: a program, the evidence that meets its requirements, and the written responses, submitted inside its window.',
  'Programs are seeded from the published rules, and a seed added later joins on the next read; edit their requirements on Settings to match the current published rules. A program with official application questions turns the workspace’s Responses into a guided form with Copy on every answer.',
  'Evidence is imported from Speaking, Certifications and Published content, or added by hand; attach it to an application from the requirement checklist.',
  'Readiness is computed from your own evidence and says how; acceptance is the program’s decision and this hub never promises it.',
  'Applications are private: nothing here is published. The packet view prints and the export downloads a JSON file you keep.',
];

/**
 * The Ambassador Hub page (see the header): its tabs, chosen by `?tab=`, over
 * one load of the hub's data, with the selected application and program kept in
 * the address.
 */
export default function AmbassadorPage() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const hub = useAmbassadorData(authReady, { toast });
  const [selection, setSelection] = useState({
    applicationId: searchParams.get('application') || null,
  });

  const setTab = useCallback(
    (id, extra = {}) => {
      const next = { tab: id, ...extra };
      if (selection.applicationId && !('application' in extra))
        next.application = selection.applicationId;
      setSearchParams(next);
    },
    [setSearchParams, selection.applicationId]
  );

  const openApplication = useCallback(
    (applicationId) => {
      setSelection({ applicationId });
      setSearchParams(
        applicationId
          ? { tab: 'applications', application: applicationId }
          : { tab: 'applications' }
      );
    },
    [setSearchParams]
  );

  const nav = { setTab: (id) => id !== activeTab && setTab(id), openApplication };
  const ActivePanel = PANELS[activeTab];

  return (
    <div className="space-y-6">
      <PageHeader icon={BadgeCheck} help={HELP} />
      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={nav.setTab}
        idPrefix="ambassador"
        label="Ambassador Hub"
      >
        {hub.notProvisioned ? (
          <div className="pt-4">
            <NotProvisioned onRetry={hub.refreshAll} />
          </div>
        ) : (
          <ActivePanel hub={hub} nav={nav} selection={selection} />
        )}
      </HubTabs>
    </div>
  );
}
