/**
 * Health Hub (route `/admin/health`) — what is true now, and what can be
 * verified right now.
 *
 * This replaced two pages that answered halves of one question. Ops Health
 * rendered what the estate had already written down: scheduler counts, queue
 * ages, open alerts, all of it produced by timers that ran while nobody was
 * looking. Diagnostics ran checks that only exist while an admin is signed in
 * and pressing a button — the token in this session, the registry's opinion of
 * this principal, a real job submitted to the Labs queue and cancelled again.
 *
 * Neither was a page about "health" on its own. An operator with a broken
 * pipeline had to know which of the two would have the answer, and the honest
 * answer was usually "both, in that order": read the signals, then run a probe
 * to see whether the thing is broken now or merely was.
 *
 * Until #569 the merged page was one long scroll. It now has a tab per duty,
 * at the Newsletter Hub's standard (components/admin/HubTabs):
 *
 *   Overview  the strip, then one read of `getOpsHealthSnapshot`: readiness,
 *             publishing and operational signals. Reported, not asked for.
 *             Every card says when its block was read and links to Checks.
 *   Alerts    workflow alerts, filtered, with acknowledge / resolve / reopen.
 *             Its own tab because answering one is a live action.
 *   Checks    the probe registry (health/probeRegistry.js): one card per hub
 *             dependency with the same five facts each, Test all, and under
 *             it the detailed identity, smoke-test and Labs cards those
 *             probes summarise.
 *   Code and Security
 *             Qlty's grades and open issues, condensed (health/CodeQualityTab).
 *             Read the first time the tab opens, never on page load.
 *   Report    the Markdown summary of those checks and every probe's last
 *             status, plus the Code and Security summary when that tab was
 *             read, and Copy report.
 *
 * Deep links are `?tab=`; an unknown or moved id lands where its content went
 * (health/tabs.js).
 *
 * ONE VOCABULARY (ADR 0033 §2, #1010). Every verdict, signal and probe on
 * this page renders through StatusBadge with lib/status.js's five words —
 * healthy, degraded, critical, offline, unknown — the same words the
 * Integrations page uses for the same states, with the transition rules
 * (freshness windows, critical against offline, the heartbeat) written once
 * in lib/status.js. Every card shows its word in the same place, the
 * top-right of its header (health/StatusSlot.jsx).
 *
 * MEMORY AND PULSE (#1010, #1011). Every probe's last result is kept on the
 * server (health/useStoredResults.js, cms/health/probe-results): a Test run
 * here records its result, and the server's health pulse records what it can
 * check on its own every five minutes. The page reads the store on load and
 * every minute while it is visible, shows each result's age, and shows one
 * past its freshness window as unknown with its last value. The pulse line
 * above the tabs says when the pulse last beat; when it is late, the hub as a
 * whole is offline, and before it has ever beaten, unknown.
 *
 * State the tabs read lives here, on the page, not in the tabs: the snapshot
 * feeds Overview, Alerts and the snapshot probes; the identity and Labs
 * results feed the strip, Checks and Report; the probe runner's results and
 * the stored results feed Checks and Report. So switching tabs never
 * refetches or reruns a probe, and a report copied from Report is the checks
 * just run on Checks. The header and tab bar always render; a snapshot that
 * fails to load is an error on the two tabs that show it, and Checks and
 * Report carry on.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useAuthReady } from '@/hooks/useAuthReady';
import { useToast } from '@/components/ui/use-toast';
import HubTabs from '@/components/admin/HubTabs';
import PageHeader from '@/components/admin/shared/PageHeader';
import { hubStatus } from '@/lib/status';
import { Activity } from 'lucide-react';

import { alertsStatus, getAlertStatus } from './health/signals';
import { buildReport, messageOf, useSmokeActions } from './health/probes';
import CodeQualityTab from './health/CodeQualityTab';
import { withCodeQuality } from './health/codeQuality';
import { PROBES, probeReportLines } from './health/probeRegistry';
import { TABS, resolveTab } from './health/tabs';
import useAlertActions from './health/useAlertActions';
import useCodeQuality from './health/useCodeQuality';
import useHealthChecks from './health/useHealthChecks';
import useOpsSnapshot from './health/useOpsSnapshot';
import useProbeRunner from './health/useProbeRunner';
import useStoredResults from './health/useStoredResults';
import { PulseStrip, OverviewTab, AlertsTab, ChecksTab, ReportTab } from './health/HealthTabPanels';

const HELP = [
  'Overview is what the platform wrote down while nobody watched: counts and ages from timers, with the time each block was read. Nothing here is asked for.',
  'Alerts are the workflow alerts those timers raised. Acknowledge, resolve with a note, or reopen; each writes to the alert and re-reads the snapshot.',
  'Checks is where you ask. One card per dependency, every hub, each with the same five facts: what it covers, how it is doing, when that was checked, what breaks, what to do. Test all runs everything that spends and writes nothing.',
  'Code and Security reads Qlty once, when you open it. Report is the Markdown record of all of the above, ready to copy.',
  'Every status is one of five words: Healthy, Degraded, Critical (it answered, but said no), Offline (it could not be reached, or went silent), and Unknown (never checked, or checked too long ago to trust). They mean the same thing on the Integrations page.',
  'Results are kept on the server, so they survive a reload and a new sign-in. The pulse re-checks what the server can check on its own every five minutes; the line above the tabs says when it last did.',
];

const EMPTY_READINESS = {
  functionsConfigured: false,
  publishedItems: 0,
  missingSlugCount: 0,
  rssSources: 0,
};

/** The probes whose result is page state an action changed, recorded as it changes. */
const SESSION_PROBES = PROBES.filter((probe) => probe.kind === 'session');

const EMPTY_SIGNALS = {
  queueBreachCount: 0,
  oldestStagedHours: 0,
  openAlertAgeHours: 0,
  publishFailureCount: 0,
  orphanedGeneratedImages: 0,
  failedJobs: [],
  lastSchedulerSuccessAt: null,
};

/**
 * Each tab's panel, by id. With TABS in health/tabs.js this is the whole of
 * adding a tab: every panel receives the same page state and takes what it
 * needs.
 */
const PANELS = {
  overview: OverviewTab,
  alerts: AlertsTab,
  checks: ChecksTab,
  code: CodeQualityTab,
  report: ReportTab,
};

export default function HealthPage() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));

  const setTab = (id) => {
    if (id === activeTab) return;
    setSearchParams({ tab: id });
  };

  const ops = useOpsSnapshot(authReady);
  const alerts = useAlertActions(ops);
  const checks = useHealthChecks(authReady);
  // Qlty is paged and cached server-side, so it is read only once the Code
  // and Security tab has been opened, and then kept across tab switches.
  const code = useCodeQuality(authReady && activeTab === 'code');
  const { identity, identityBusy, labs, labsBusy, unauth, unauthBusy } = checks;

  // A smoke action writes what the snapshot reads, so it re-reads it — through
  // the same generation guard as every other read.
  const smoke = useSmokeActions(ops.refresh);

  const { snapshot } = ops;
  const readiness = snapshot.readiness || EMPTY_READINESS;
  const digestForDisplay = snapshot.digest || null;
  const allAlerts = snapshot.alerts || [];
  const derived = {
    readiness,
    digestForDisplay,
    operationalSignals: snapshot.operationalSignals || EMPTY_SIGNALS,
    filteredAlerts: allAlerts.filter((row) => getAlertStatus(row) === alerts.filter),
    openAlertCount: allAlerts.filter((row) => getAlertStatus(row) === 'open').length,
    alertsStatus: alertsStatus(allAlerts),
    publishingOps: digestForDisplay?.publishingOps || null,
    publishingWatchdog: digestForDisplay?.publishingWatchdog || null,
  };

  // Every probe's last recorded result and the pulse's heartbeat, re-read
  // every minute while the page is visible (#1010, #1011).
  const stored = useStoredResults(authReady);
  const { record } = stored;

  // What the probe registry reads: the page's state, and the actions that
  // change it. Held in a ref so a probe started now reads the state as it is
  // when it runs, not as it was when the button rendered.
  const probeContext = {
    snapshot: ops.loaded ? snapshot : null,
    ops,
    identity,
    labs,
    unauth,
    smoke: { lastRuns: smoke.lastRuns, runningAction: smoke.runningAction },
    actions: {
      rerunIdentity: checks.rerunIdentity,
      runLabs: checks.runLabs,
      runUnauth: checks.runUnauth,
      runSmoke: smoke.runAction,
    },
  };
  const contextRef = useRef(probeContext);
  useEffect(() => {
    contextRef.current = probeContext;
  });
  const getContext = useCallback(() => contextRef.current, []);
  // A live result is recorded the moment it lands, with how long it took.
  const runner = useProbeRunner(PROBES, getContext, {
    onResult: (probe, outcome, durationMs) => record(probe.id, outcome, durationMs),
  });
  const resolve = (probe) => runner.resolve(probe, probeContext, stored.results, stored.now);

  // A session probe's result is the page state its action changed (the
  // identity read, a Labs round trip, a smoke test), so it is recorded when
  // that state does: once per run, keyed by the run's own time.
  const recordedRuns = useRef(new Map());
  const smokeRuns = smoke.lastRuns;
  useEffect(() => {
    const ctx = { identity, labs, unauth, smoke: { lastRuns: smokeRuns } };
    for (const probe of SESSION_PROBES) {
      const local = probe.evaluate(ctx);
      if (!local?.checkedAt || recordedRuns.current.get(probe.id) === local.checkedAt) continue;
      recordedRuns.current.set(probe.id, local.checkedAt);
      record(probe.id, local, local.durationMs);
    }
  }, [identity, labs, unauth, smokeRuns, record]);

  const hub = hubStatus(
    stored.pulse,
    PROBES.map((probe) => resolve(probe).status),
    stored.now
  );

  // Nothing may be copied while a check is in flight: a report taken mid-run
  // would say a token "could not be read" or a probe was "not run" for work
  // that is merely pending, and that is what would end up in the record.
  const identityPending = identity === null;
  const checksBusy = identityBusy || labsBusy || unauthBusy;
  const probesRunning = runner.running.size > 0;
  const settling = identityPending || checksBusy || probesRunning;

  const report = withCodeQuality(
    [
      buildReport({
        generatedAt: new Date().toISOString(),
        identityPending: identity === null,
        ...(identity || {}),
        labs,
        unauth,
      }),
      '',
      ...probeReportLines(PROBES, resolve, { pulse: stored.pulse, now: stored.now }),
    ].join('\n'),
    code.data
  );

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      toast({
        title: 'Report copied',
        description: 'Paste it wherever this run needs recording.',
      });
    } catch (err) {
      toast({
        title: 'Clipboard unavailable',
        description: messageOf(err, 'Select the report text below and copy it by hand.'),
        variant: 'destructive',
      });
    }
  };

  const ActivePanel = PANELS[activeTab];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Activity}
        description="What the platform reports about itself, and the checks you can run against it from this session. The token behind those checks is decoded here and reduced to claim names; it is never displayed, and only the summary on the Report tab is copied."
        help={HELP}
      />

      <PulseStrip pulse={stored.pulse} hub={hub} now={stored.now} error={stored.error} />

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="health"
        label="Health Hub"
      >
        <ActivePanel
          ops={ops}
          derived={derived}
          alerts={alerts}
          smoke={smoke}
          identity={identity}
          identityRunning={checks.identityRunning}
          rerunIdentity={checks.rerunIdentity}
          labs={labs}
          probes={checks}
          runner={runner}
          resolve={resolve}
          report={report}
          settling={settling}
          copyReport={copyReport}
          code={code}
          now={stored.now}
        />
      </HubTabs>
    </div>
  );
}
