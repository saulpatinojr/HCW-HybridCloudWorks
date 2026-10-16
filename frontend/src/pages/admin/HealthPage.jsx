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
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import HubTabs from '@/components/admin/HubTabs';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { TabError, TabLoading } from '@/components/admin/integrations/TabNotice';
import {
  PULSE_INTERVAL_MS,
  describeAge,
  describeWindow,
  hubStatus,
  pulseStatus,
} from '@/lib/status';
import { Activity, ClipboardCopy, HeartPulse, Loader2, RefreshCw } from 'lucide-react';

import {
  OperationalSignalsCard,
  PipelineReadinessCard,
  PublishingOpsCard,
  WorkflowAlertsCard,
  alertsStatus,
  getAlertStatus,
  readinessStatus,
} from './health/signals';
import {
  AdminRegistryCard,
  LabsProbeCard,
  ProbeButton,
  SmokeActionsCard,
  TokenClaimsCard,
  buildReport,
  evaluateIdentity,
  evaluateLabsProbe,
  messageOf,
  useSmokeActions,
  verdictStatus,
} from './health/probes';
import CodeQualityTab from './health/CodeQualityTab';
import { withCodeQuality } from './health/codeQuality';
import ProbeGrid from './health/ProbeCards';
import { PROBES, probeReportLines } from './health/probeRegistry';
import { TABS, resolveTab } from './health/tabs';
import useAlertActions from './health/useAlertActions';
import useCodeQuality from './health/useCodeQuality';
import useHealthChecks from './health/useHealthChecks';
import useOpsSnapshot from './health/useOpsSnapshot';
import useProbeRunner from './health/useProbeRunner';
import useStoredResults from './health/useStoredResults';

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

function GlanceItem({ label, children }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </span>
  );
}

/**
 * The observed half and the verified half on one line.
 *
 * Deliberately mixed rather than grouped: "Runtime config Healthy" next to
 * "Identity Unknown" is the state where the estate looks fine and this
 * session cannot prove it can talk to it, and that pairing is invisible when
 * the two live on different tabs.
 *
 * The strip renders even when the snapshot has not arrived, because the two
 * verdicts do not depend on it. Its observed badges then say Unknown: the
 * zeros a missing snapshot defaults to would read as "no open alerts".
 */
function AtAGlance({
  snapshotLoaded,
  readiness,
  openAlertCount,
  signals,
  identityVerdict,
  labsVerdict,
}) {
  return (
    <div
      role="group"
      aria-label="Health at a glance"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-muted/30 px-4 py-3 text-sm"
    >
      <GlanceItem label="Runtime config">
        <StatusBadge system={snapshotLoaded ? readinessStatus(readiness) : 'unknown'} />
      </GlanceItem>
      <GlanceItem label="Open alerts">
        {snapshotLoaded ? (
          <Badge variant={openAlertCount > 0 ? 'destructive' : 'secondary'}>{openAlertCount}</Badge>
        ) : (
          <StatusBadge system="unknown" />
        )}
      </GlanceItem>
      <GlanceItem label="Publish failures">
        {snapshotLoaded ? (
          <Badge variant={signals.publishFailureCount > 0 ? 'destructive' : 'secondary'}>
            {signals.publishFailureCount || 0}
          </Badge>
        ) : (
          <StatusBadge system="unknown" />
        )}
      </GlanceItem>
      <GlanceItem label="Identity">
        <StatusBadge system={verdictStatus(identityVerdict.pass)} />
      </GlanceItem>
      <GlanceItem label="Labs probe">
        <StatusBadge system={verdictStatus(labsVerdict.pass)} />
      </GlanceItem>
    </div>
  );
}

/**
 * The pulse and the hub's one word, above every tab (#1010).
 *
 * The pulse is the server checking on its own every five minutes; this line
 * is how anyone tells "checked three minutes ago" from "nothing has checked
 * since last night". The hub's word is lib/status.js `hubStatus`: the worst
 * fresh result while the pulse beats, offline once it is late, unknown before
 * it has ever beaten.
 */
function PulseStrip({ pulse, hub, now, error }) {
  const beat = pulseStatus(pulse, now);
  const every = describeWindow(pulse?.intervalMs ?? PULSE_INTERVAL_MS);
  let line = 'has not reported yet. Results below come from checks run in a browser.';
  if (pulse) {
    const last = describeAge(pulse.lastBeatAt, now) ?? 'at an unknown time';
    line =
      beat === 'offline'
        ? `is late: every ${every}, last beat ${last}. Nothing has re-checked since.`
        : `every ${every}, last beat ${last}.`;
  }
  return (
    <div
      role="group"
      aria-label="Health pulse"
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border bg-muted/30 px-4 py-2 text-sm"
    >
      <span className="flex min-w-0 items-center gap-2" data-testid="pulse-line">
        <HeartPulse className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">Pulse</span>
        <StatusBadge system={beat} size="xs" />
        <span className="min-w-0 text-xs text-muted-foreground">
          {line}
          {error ? ` The stored results could not be re-read: ${error}` : ''}
        </span>
      </span>
      <span className="flex items-center gap-2" data-testid="hub-status">
        <span className="text-muted-foreground">Hub</span>
        <StatusBadge system={hub} size="xs" />
      </span>
    </div>
  );
}

/**
 * The snapshot's loading line or its error, or null once it has landed. The
 * two tabs that show the snapshot each render this in place of their cards,
 * so a refused read is said where the numbers would have been.
 */
function SnapshotNotice({ ops }) {
  if (ops.loading) return <TabLoading>Reading the ops-health snapshot…</TabLoading>;
  if (ops.error) return <TabError message={ops.error} onRetry={ops.refresh} />;
  return null;
}

function TabIntro({ children }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function OverviewTab({ ops, derived, identity, labs }) {
  return (
    <div className="space-y-4">
      <AtAGlance
        snapshotLoaded={ops.loaded}
        readiness={derived.readiness}
        openAlertCount={derived.openAlertCount}
        signals={derived.operationalSignals}
        identityVerdict={evaluateIdentity(identity?.token, identity?.admin)}
        labsVerdict={evaluateLabsProbe(labs)}
      />
      <TabIntro>
        One read of the ops-health snapshot. Written by timers and schedulers that ran without
        anyone watching — reported here, not asked for. Each card says when it was read; the impact,
        the fix and a test for every row are on Checks.
      </TabIntro>
      {ops.loaded ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PipelineReadinessCard
              readiness={derived.readiness}
              digestForDisplay={derived.digestForDisplay}
            />
            <PublishingOpsCard
              publishingOps={derived.publishingOps}
              publishingWatchdog={derived.publishingWatchdog}
              digestForDisplay={derived.digestForDisplay}
            />
          </div>
          <OperationalSignalsCard signals={derived.operationalSignals} />
        </>
      ) : (
        <SnapshotNotice ops={ops} />
      )}
    </div>
  );
}

function AlertsTab({ ops, derived, alerts }) {
  return (
    <div className="space-y-4">
      <TabIntro>
        Alerts the workflows raised. Acknowledging, resolving or reopening one writes to the alert
        and re-reads the snapshot.
      </TabIntro>
      {/* Above the card rather than in it: an action can succeed and its
          re-read fail, and then this line and the error below both stand. */}
      <div aria-live="polite">
        {alerts.message && <p className="text-sm text-emerald-600">{alerts.message}</p>}
        {alerts.error && <p className="text-sm text-red-600">{alerts.error}</p>}
      </div>
      {ops.loaded ? (
        <WorkflowAlertsCard
          alertFilter={alerts.filter}
          setAlertFilter={alerts.setFilter}
          filteredAlerts={derived.filteredAlerts}
          alertActionId={alerts.actionId}
          resolutionNotes={alerts.resolutionNotes}
          setResolutionNotes={alerts.setResolutionNotes}
          handleAlertAction={alerts.handleAction}
          status={derived.alertsStatus}
        />
      ) : (
        <SnapshotNotice ops={ops} />
      )}
    </div>
  );
}

function ChecksTab({
  smoke,
  identity,
  identityRunning,
  rerunIdentity,
  probes,
  runner,
  resolve,
  now,
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <TabIntro>
          Checks that run in this signed-in session and do real work. Nothing here is true until you
          press the button that makes it true.
        </TabIntro>
        <ProbeButton busy={identityRunning} icon={RefreshCw} onClick={rerunIdentity}>
          Re-run identity checks
        </ProbeButton>
      </div>

      <ProbeGrid
        probes={PROBES}
        resolve={resolve}
        running={runner.running}
        runningAll={runner.runningAll}
        onRun={runner.runOne}
        onRunAll={runner.runAll}
        now={now}
      />

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">The detail behind the session checks</h2>
        <SmokeActionsCard
          runningAction={smoke.runningAction}
          actionInfoOpen={smoke.actionInfoOpen}
          actionMessage={smoke.actionMessage}
          actionError={smoke.actionError}
          onRunAction={smoke.runAction}
          onToggleActionInfo={smoke.toggleActionInfo}
        />

        <TokenClaimsCard identity={identity} />
        <AdminRegistryCard identity={identity} />
        <LabsProbeCard
          labs={probes.labs}
          labsBusy={probes.labsBusy}
          onLabs={probes.runLabs}
          unauth={probes.unauth}
          unauthBusy={probes.unauthBusy}
          onUnauth={probes.runUnauth}
        />
      </div>
    </div>
  );
}

function ReportTab({ report, settling, copyReport }) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-lg">Report</CardTitle>
          <CardDescription>
            What Copy report puts on the clipboard: the checks on the Checks tab as they stand,
            every probe&apos;s last status, and the Code and Security summary if that tab was read.
            Claim names, booleans, statuses, job ids and Qlty counts only. Print this page for a
            paper copy.
          </CardDescription>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            size="sm"
            onClick={copyReport}
            disabled={settling}
            title={settling ? 'Checks still running' : 'Copy the Markdown report'}
          >
            <ClipboardCopy className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> Copy report
          </Button>
          {settling ? (
            <p className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Checks still running —
              the report is not final
            </p>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <pre
          className="max-h-105 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-border bg-muted/60 p-3 font-mono text-xs print:max-h-none"
          aria-label="Diagnostics report"
        >
          {report}
        </pre>
      </CardContent>
    </Card>
  );
}

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
