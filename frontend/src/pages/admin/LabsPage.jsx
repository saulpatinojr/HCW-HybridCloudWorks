/**
 * Labs Hub (route `/admin/labs`) — the labs the site offers and the two
 * services behind them: the Desktop a learner opens and the Agent that
 * checks their work (ADR 0033 "Labs"; the runner-only hub of #577 before).
 *
 * Six tabs by duty (components/admin/labs):
 *
 *   Catalogue  every lab, its providers, difficulty, steps, where it is
 *              published, and Validate: run its check on the runner
 *   Dashboard  is the fleet up, is anything moving, and what Agent,
 *              Desktop and Lab mean, each with its live state
 *   Jobs       every run the snapshot carries, expandable to what it printed
 *   Console    submit a job and watch it run
 *   Agents     which agents can be reached, and what to do when one cannot
 *   Settings   how a new VPS agent is provisioned
 *
 * This page validates `?tab=`, and an id that USED to be a tab goes where
 * its content went (labs/tabs.js). `?job=<id>` opens the Console on a job:
 * the Catalogue's Validate enqueues a lab's check and sends the operator
 * there to watch it.
 *
 * The snapshot is read once, here, because every tab is a view of it — and its
 * staleness clock is deliberately independent of the fetch, so that during an
 * outage `now` keeps advancing and agents stop looking connected (T-309).
 */
import React from 'react';
import { useSearchParams } from 'react-router';
import { FlaskConical } from 'lucide-react';
import { useAuthReady } from '@/hooks/useAuthReady';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import HubTabs from '@/components/admin/HubTabs';
import CatalogueTab from '@/components/admin/labs/CatalogueTab';
import DashboardTab from '@/components/admin/labs/DashboardTab';
import JobsTab from '@/components/admin/labs/JobsTab';
import ConsoleTab from '@/components/admin/labs/ConsoleTab';
import AgentsTab from '@/components/admin/labs/AgentsTab';
import SettingsTab from '@/components/admin/labs/SettingsTab';
import CoderTab from '@/components/admin/labs/CoderTab';
import useLabsLive from '@/components/admin/labs/useLabsLive';
import { FALLBACK_JOB_TYPES, fleetState, fleetStatusWord } from '@/components/admin/labs/labsView';
import { TABS, resolveTab } from '@/components/admin/labs/tabs';
import { availableLabs } from '@/data/labs/catalogue';

/**
 * Each tab's panel, by id. With TABS in labs/tabs.js this is the whole of
 * adding a tab: every panel receives the same hub state.
 */
const PANELS = {
  catalogue: CatalogueTab,
  dashboard: DashboardTab,
  jobs: JobsTab,
  console: ConsoleTab,
  agents: AgentsTab,
  settings: SettingsTab,
  coder: CoderTab,
};

/** The "How this works" lines a first-time operator reads. */
const HELP = [
  'A Lab is a catalogue row (frontend/src/data/labs/catalogue.js): providers, objectives, steps and the runner check that confirms the work. It is published under each provider’s Learn section, at /<provider>/education/labs.',
  'The Desktop is the Coder workspace a learner opens from a lab’s page: VS Code in the browser, one container per learner per lab, GitHub sign-in, autostop after an hour. Its state is the public coder-status read.',
  'The Agent is the job runner on the lab host (vps-agent). It claims jobs of the types it is registered for, runs one fixed sandboxed command per job, and reports the result; the Agents tab registers and diagnoses it.',
  'Validate on the Catalogue tab enqueues a lab’s check with its sample payload and opens the Console on the job, so you see what a learner’s check would return.',
  'Adding a lab is one catalogue row plus one entry in the workspace template and the launcher map: no new route or page.',
  'Coder’s own pages open only inside the site. The Coder tab frames the dashboard, signed in as you, with Workspaces, Templates, Your tokens, Users and the audit log one click away; the status-token renewal starts on Your tokens.',
];

export default function LabsPage() {
  const { authReady } = useAuthReady();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const live = useLabsLive(authReady);

  const setTab = (id) => {
    if (id === activeTab) return;
    setSearchParams({ tab: id });
  };

  // The Catalogue's Validate lands on the Console watching the job it queued.
  const watchJob = searchParams.get('job')
    ? { jobId: searchParams.get('job'), type: searchParams.get('type') || undefined }
    : null;
  const onWatchJob = (jobId, type) => {
    const next = { tab: 'console', job: jobId };
    if (type) next.type = type;
    setSearchParams(next);
  };

  // The server's allowlist when it sent one, the built-in list otherwise: the
  // Console must offer something to submit even before the first snapshot.
  const hub = {
    ...live,
    jobTypes: live.jobTypes.length ? live.jobTypes : FALLBACK_JOB_TYPES,
    watchJob,
    onWatchJob,
  };
  const ActivePanel = PANELS[activeTab];
  const fleet = fleetState(hub.agents, hub.now);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FlaskConical}
        description="Hands-on learning environments per provider, and the agent and desktop behind them."
        status={
          <>
            <span className="text-muted-foreground">Agent</span>
            <StatusBadge system={fleetStatusWord(fleet)} size="xs" />
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              {availableLabs.length} {availableLabs.length === 1 ? 'lab' : 'labs'} listed
            </span>
          </>
        }
        help={HELP}
      />

      <HubTabs tabs={TABS} active={activeTab} onSelect={setTab} idPrefix="labs" label="Labs Hub">
        <ActivePanel hub={hub} />
      </HubTabs>
    </div>
  );
}
