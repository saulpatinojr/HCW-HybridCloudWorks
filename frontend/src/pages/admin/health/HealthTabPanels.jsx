import React from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { TabError, TabLoading } from '@/components/admin/integrations/TabNotice';
import { PULSE_INTERVAL_MS, describeAge, describeWindow, pulseStatus } from '@/lib/status';
import { ClipboardCopy, HeartPulse, Loader2, RefreshCw } from 'lucide-react';
import {
  OperationalSignalsCard,
  PipelineReadinessCard,
  PublishingOpsCard,
  WorkflowAlertsCard,
  readinessStatus,
} from './signals';
import {
  AdminRegistryCard,
  LabsProbeCard,
  ProbeButton,
  SmokeActionsCard,
  TokenClaimsCard,
  evaluateIdentity,
  evaluateLabsProbe,
  verdictStatus,
} from './probes';
import ProbeGrid from './ProbeCards';
import { PROBES } from './probeRegistry';

export function GlanceItem({ label, children }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </span>
  );
}

/**
 * The observed half and the verified half on one line.
 */
export function AtAGlance({
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
 */
export function PulseStrip({ pulse, hub, now, error }) {
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
 * The snapshot's loading line or its error, or null once it has landed.
 */
export function SnapshotNotice({ ops }) {
  if (ops.loading) return <TabLoading>Reading the ops-health snapshot…</TabLoading>;
  if (ops.error) return <TabError message={ops.error} onRetry={ops.refresh} />;
  return null;
}

export function TabIntro({ children }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function OverviewTab({ ops, derived, identity, labs }) {
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

export function AlertsTab({ ops, derived, alerts }) {
  return (
    <div className="space-y-4">
      <TabIntro>
        Alerts the workflows raised. Acknowledging, resolving or reopening one writes to the alert
        and re-reads the snapshot.
      </TabIntro>
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

export function ChecksTab({
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

export function ReportTab({ report, settling, copyReport }) {
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
