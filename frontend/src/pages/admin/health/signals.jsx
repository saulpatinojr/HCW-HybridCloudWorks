/**
 * What is true now — the estate reporting on itself.
 *
 * Everything here comes from one authenticated read of `getOpsHealthSnapshot`.
 * Nothing in this file asks a question; it renders answers the platform has
 * already written down, from timers and schedulers that ran without anyone
 * watching. That is the distinction the Health page is organised around, and
 * it is why the probes live in a different file: those need the admin's own
 * session and only exist while someone is pressing the button.
 *
 * The one action here is the alert workflow — acknowledge, resolve, reopen —
 * because an alert is a live signal you answer in place, not a check you run.
 *
 * Every card here is built like a probe card (#1010): a header with the title
 * and the card's status in the top-right slot (StatusSlot.jsx), a body, and a
 * footer pinned to the bottom with when the block was read. Cards in one row
 * are the same height.
 */

import React from 'react';
import { Link } from 'react-router';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import RoleGate from '@/components/admin/RoleGate';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import useLinkedItem from '@/hooks/useLinkedItem';
import { LINK_PARAMS } from '@/lib/itemLinks';
import { describeAge, worstStatus } from '@/lib/status';
import { AlertTriangle, Bot, CheckCircle2, Workflow } from 'lucide-react';
import {
  contentAgentVerdict,
  nightlyExportVerdict,
  scheduledPublishingVerdict,
  unresolvedSplit,
} from './probeEvaluators';
import { KODA } from './probeKit';
import StatusSlot from './StatusSlot';

export const ALERT_FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
];

/**
 * A Cosmos timestamp is an ISO string; a migrated one may still be a
 * Firestore-shaped `{ toDate }` or `{ seconds }`. Until 2026-10-03 only the
 * first shape was read, so every time on this page said "Not available"
 * (ADR 0033 §1 Platform).
 */
export function formatTimestamp(value) {
  let date = null;
  if (typeof value?.toDate === 'function') date = value.toDate();
  else if (value && typeof value === 'object' && typeof value.seconds === 'number')
    date = new Date(value.seconds * 1000);
  else if (typeof value === 'string' || typeof value === 'number') date = new Date(value);
  if (!date || Number.isNaN(date.getTime())) return 'Not available';

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Every Overview card ends the same way (ADR 0033 §1 Platform): when the
 * block it shows was read — its age as well as its time (#1010) — and where
 * its probes, impacts and fixes live. Pinned to the bottom of the card.
 */
export function CheckedFooter({ at, probeLabel }) {
  const age = describeAge(typeof at === 'string' ? at : null);
  return (
    <p className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
      <span>
        Checked {age ? `${age} · ` : ''}
        {formatTimestamp(at)}
      </span>
      <Link
        to="/admin/health?tab=checks"
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        {probeLabel ?? 'Impact, fixes and tests on Checks'}
      </Link>
    </p>
  );
}

/**
 * A signal card's header: the title, and the card's status in the slot every
 * Health Hub card keeps in the same place (StatusSlot.jsx).
 */
function SignalCardHeader({ icon = null, title, status }) {
  return (
    <CardHeader className="flex-row items-start gap-3 space-y-0" data-slot="header">
      <CardTitle className="flex min-w-0 flex-1 items-center gap-2 text-lg">
        {icon}
        {title}
      </CardTitle>
      <StatusSlot status={status} size="sm" />
    </CardHeader>
  );
}

/** The one word for the runtime-configuration readiness (ADR 0033, lib/status.js). */
export function readinessStatus(readiness) {
  if (!readiness) return 'unknown';
  if (readiness.functionsConfigured) return 'healthy';
  // An unresolved Key Vault reference, or a configuration stamp that never
  // arrived: the worker answered, with the wrong settings. Critical.
  return 'critical';
}

/** A count that is fine at zero and worth a look above it. */
const countStatus = (count, above = 'degraded') => ((Number(count) || 0) > 0 ? above : 'healthy');

/**
 * The four tiles' words, the publish-failure count and the day's jobs, worst
 * first: the card's status. A jobs read that failed is degraded, not unknown:
 * worstStatus lets unknown count only when nothing else is known, so an
 * unknown here would hide behind the healthy tiles and the header would say
 * Healthy over a body that says it could not count (#1491).
 */
export function signalsStatus(signals) {
  const jobsUnreadable = Boolean(signals?.failedJobsUnavailable || signals?.jobs24h?.unavailable);
  return worstStatus([
    countStatus(signals?.queueBreachCount),
    stagedAgeStatus(signals?.oldestStagedHours),
    (signals?.openAlertAgeHours || 0) > 24 ? 'degraded' : 'healthy',
    countStatus(signals?.orphanedGeneratedImages),
    countStatus(signals?.publishFailureCount),
    countStatus((signals?.failedJobs || []).length),
    countStatus(signals?.jobs24h?.failed),
    jobsUnreadable ? 'degraded' : 'healthy',
  ]);
}

/**
 * The Workflow Alerts card's status over every alert, not the filtered few:
 * nothing open is healthy, an open critical alert is critical, anything else
 * open is worth a look.
 */
export function alertsStatus(alerts) {
  const open = (alerts ?? []).filter((alert) => getAlertStatus(alert) !== 'resolved');
  if (open.length === 0) return 'healthy';
  return open.some((alert) => alert.severity === 'critical') ? 'critical' : 'degraded';
}

export function getAlertActionLabel(action) {
  if (action === 'resolve') return 'Resolved';
  if (action === 'acknowledge') return 'Acknowledged';
  return 'Updated';
}

export function getAlertStatus(alert) {
  return alert.status || (alert.active === false ? 'resolved' : 'open');
}

function getBadgeVariantByCount(count, positiveVariant) {
  if (count > 0) return positiveVariant;
  return 'secondary';
}

function getDigestDocLabel(digestDate) {
  if (!digestDate) return '';
  return ` (digest doc: ${digestDate})`;
}

/**
 * The waiting-to-go-live tile's word, and its share of the card's header:
 * degraded past three days, and degraded when items wait but none carries a
 * time (#1516). Not unknown: worstStatus counts unknown only when nothing
 * else is known, so the header would read Healthy over the tile, and
 * "unknown" there means "never checked", which this is not (the #1491 rule
 * for a read that could not count).
 */
function stagedAgeStatus(hours) {
  if (hours === null) return 'degraded';
  return (hours || 0) > 72 ? 'degraded' : 'healthy';
}

function formatHours(value) {
  if (!value) return '0h';
  return `${value}h`;
}

function renderPublishingHint(publishingOps) {
  if (!publishingOps) {
    return (
      <p className="text-xs text-muted-foreground pb-1">
        The scheduler records every run here, every 15 minutes, nothing due included. No values
        means no run is recorded in the latest digest — the scheduler is off or has not run today.
        The Watchdog rows below still report overdue items.
      </p>
    );
  }
  // All zeros reads like a broken card. It is the scheduler's own ledger: it
  // counts items in Approved whose publish time has come, and nothing else.
  // Drafts, reviews, Koda's work and background jobs are on other cards (#1491).
  // Only a run that completed can say nothing was due: a run that broke
  // records zeros too (scheduled-publish.js), and those zeros say nothing.
  const ranClean = publishingOps.status !== 'failed' && !publishingOps.error;
  if (ranClean && !publishingOps.due && !publishingOps.failed) {
    return (
      <p className="text-xs text-muted-foreground pb-1" data-testid="publishing-nothing-due">
        Nothing was due: these counts belong to the scheduler alone, items in Approved with a
        publish time that has come. Drafts, reviews and background jobs are counted on the other
        cards.
      </p>
    );
  }
  return null;
}

/** The badge for the scheduler's one-word run status (scheduled-publish.js publishingStatus). */
const RUN_STATUS_VARIANT = Object.freeze({
  success: 'secondary',
  degraded: 'outline',
  failed: 'destructive',
});

/** The scheduler's own word for its last run, and the sentence it recorded when the run broke. */
function renderPublishingRun(publishingOps) {
  if (!publishingOps?.status && !publishingOps?.error) return null;
  const status = String(publishingOps.status || '');
  const variant = RUN_STATUS_VARIANT[status] || 'outline';
  return (
    <div className="space-y-1" data-testid="publishing-run">
      <div className="flex items-center justify-between">
        <span>Last run</span>
        <Badge variant={variant}>{status || 'not recorded'}</Badge>
      </div>
      {publishingOps.error ? (
        <p className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {publishingOps.error}
        </p>
      ) : null}
    </div>
  );
}

/** The reason an expected name is unresolved, from the snapshot. */
const reasonOf = (readiness, name) =>
  (readiness.expectedUnresolved || []).find((entry) => entry?.name === name)?.reason || '';

/**
 * Unresolved Key Vault references in two rows (#1512): the ones nobody meant,
 * red and counted, then the ones unresolved on purpose (on the list the
 * nightly monitor reads), named with their reason and not counted as a fault.
 * The expected row is left out when there are none.
 */
function UnresolvedRows({ readiness }) {
  const { expected, unexpected } = unresolvedSplit(readiness);
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span>Unresolved, not expected</span>
        <span className="flex items-center gap-2 text-right text-xs">
          {unexpected.length ? (
            <span className="font-mono text-muted-foreground">{unexpected.join(', ')}</span>
          ) : null}
          <Badge
            variant={unexpected.length ? 'destructive' : 'secondary'}
            data-testid="unresolved-unexpected-count"
          >
            {unexpected.length}
          </Badge>
        </span>
      </div>
      {expected.length ? (
        <div className="space-y-1" data-testid="unresolved-expected">
          <div className="flex items-center justify-between gap-3">
            <span>Unresolved on purpose</span>
            <Badge variant="outline">{expected.length}</Badge>
          </div>
          <ul className="space-y-1 text-xs">
            {expected.map((name) => (
              <li key={name}>
                <span className="font-mono">{name}</span>
                <span className="block text-muted-foreground">{reasonOf(readiness, name)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Each waits on the owner to create or buy it. The nightly monitor reads the same list,
            and any name not on it shows above in red.
          </p>
        </div>
      ) : null}
    </>
  );
}

export function PipelineReadinessCard({ readiness, digestForDisplay }) {
  return (
    <Card className="flex h-full flex-col">
      <SignalCardHeader title="Pipeline Readiness" status={readinessStatus(readiness)} />
      <CardContent className="flex flex-1 flex-col gap-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span>Runtime config</span>
          <span className="text-right text-xs text-muted-foreground">
            {readiness.configGeneration
              ? `${readiness.configGeneration} · ${readiness.configWriter}`
              : 'Generation not reported'}
          </span>
        </div>
        <UnresolvedRows readiness={readiness} />
        <div className="flex items-center justify-between">
          <span>Published Entries</span>
          <Badge variant="outline">{readiness.publishedItems}</Badge>
        </div>
        <div className="flex items-center justify-between">
          <span>RSS-sourced Entries</span>
          <Badge variant="outline">{readiness.rssSources}</Badge>
        </div>
        <div className="flex items-center justify-between">
          <span>Missing Slug Signals</span>
          <Badge variant={readiness.missingSlugCount > 0 ? 'destructive' : 'secondary'}>
            {readiness.missingSlugCount}
          </Badge>
        </div>
        <div className="flex items-center justify-between">
          <span>Reviewer Digest</span>
          {digestForDisplay?.digestDate ? (
            <span className="text-xs text-right">
              <Badge variant="secondary">{digestForDisplay.digestDate}</Badge>
              <span className="block text-muted-foreground mt-0.5">
                {digestForDisplay.totalQueued ?? '—'} queued ·{' '}
                {digestForDisplay.recentRssCount ?? '—'} RSS
              </span>
            </span>
          ) : (
            <Badge variant="outline">Run digest action to generate</Badge>
          )}
        </div>
        <CheckedFooter at={readiness.lastCheckedAt} />
      </CardContent>
    </Card>
  );
}

/** The six counters the publishing card shows, zero where a block is absent. */
export function publishingMetrics(publishingOps, publishingWatchdog) {
  return {
    due: publishingOps?.due || 0,
    published: publishingOps?.published || 0,
    skipped: publishingOps?.skipped || 0,
    failed: publishingOps?.failed || 0,
    overdue: publishingWatchdog?.overdueScheduledCount || 0,
    stagedTooLong: publishingWatchdog?.stagedTooLongCount || 0,
    stagedTooLongBounded: Boolean(publishingWatchdog?.stagedTooLongBounded),
  };
}

export function PublishingOpsCard({ publishingOps, publishingWatchdog, digestForDisplay }) {
  const metrics = publishingMetrics(publishingOps, publishingWatchdog);
  // The same verdict as the Scheduled publishing probe on Checks, so the two
  // never disagree about the scheduler.
  const verdict = scheduledPublishingVerdict(
    { publishingOps, publishingWatchdog },
    digestForDisplay?.lastCheckedAt ?? null
  );

  return (
    <Card className="flex h-full flex-col">
      <SignalCardHeader
        icon={<Workflow className="h-4 w-4 text-sky-500" aria-hidden="true" />}
        title="Publishing Operations"
        status={verdict.status}
      />
      <CardContent className="flex flex-1 flex-col gap-3 text-sm">
        {renderPublishingHint(publishingOps)}
        {renderPublishingRun(publishingOps)}
        <p className="text-xs text-muted-foreground" data-testid="scheduler-verdict">
          {verdict.summary}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 border rounded-lg">
            <p className="text-muted-foreground text-xs">Due</p>
            <p className="text-xl font-bold">{metrics.due}</p>
          </div>
          <div className="p-3 border rounded-lg">
            <p className="text-muted-foreground text-xs">Published</p>
            <p className="text-xl font-bold text-emerald-600">{metrics.published}</p>
          </div>
          <div className="p-3 border rounded-lg">
            <p className="text-muted-foreground text-xs">Skipped</p>
            <p className="text-xl font-bold text-amber-600">{metrics.skipped}</p>
          </div>
          <div className="p-3 border rounded-lg">
            <p className="text-muted-foreground text-xs">Failed</p>
            <p className="text-xl font-bold text-red-600">{metrics.failed}</p>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span>Overdue Scheduled</span>
          <Badge variant={getBadgeVariantByCount(metrics.overdue, 'destructive')}>
            {metrics.overdue}
          </Badge>
        </div>
        <div className="flex items-center justify-between">
          <span title="Marked published but not live, with no schedule, for more than six hours (the watchdog's count)">
            Published, Not Live (6 h+)
          </span>
          <Badge
            variant={getBadgeVariantByCount(metrics.stagedTooLong, 'outline')}
            data-testid="published-not-live-count"
          >
            {metrics.stagedTooLong}
            {metrics.stagedTooLongBounded ? '+' : ''}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {/* publishingOps.lastRunAt is written by every scheduler run (#1010);
              publishingWatchdog.lastRunAt (every 6h) stands in while none is
              recorded in this digest. */}
          Last activity:{' '}
          {formatTimestamp(publishingOps?.lastRunAt || publishingWatchdog?.lastRunAt)}
          {getDigestDocLabel(digestForDisplay?.digestDate)}
        </p>
        <CheckedFooter at={digestForDisplay?.lastCheckedAt} />
      </CardContent>
    </Card>
  );
}

/** The last day's platform jobs by status (#1491), or the fact that they could not be counted. */
function JobsStrip({ jobs }) {
  if (jobs.unavailable) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="jobs-unavailable">
        The jobs container did not answer, so the jobs of the last day could not be counted.
      </p>
    );
  }
  const tiles = [
    ['Queued', jobs.queued, 'healthy'],
    ['Running', jobs.running, 'healthy'],
    ['Succeeded', jobs.succeeded, 'healthy'],
    ['Failed', jobs.failed, countStatus(jobs.failed)],
  ];
  return (
    <div className="space-y-1.5" data-testid="jobs-24h">
      <div className="flex items-center justify-between">
        <span className="font-medium">Platform jobs, last 24 h</span>
        <Badge variant="outline">{jobs.total || 0} total</Badge>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tiles.map(([label, count, status]) => (
          <div key={label} className="p-3 border rounded-lg">
            <p className="text-muted-foreground text-xs">{label}</p>
            <p className="text-xl font-bold">{count || 0}</p>
            <StatusBadge system={status} size="xs" />
          </div>
        ))}
      </div>
      {jobs.other ? (
        <p className="text-xs text-muted-foreground">
          {jobs.other} in other states (cancelled or unknown).
        </p>
      ) : null}
    </div>
  );
}

/** The key's one word and the badge colour that goes with it. */
function keyBadge(key) {
  if (key.unavailable) return { word: 'could not be read', variant: 'outline' };
  if (!key.present) return { word: 'none', variant: 'outline' };
  if (key.active) return { word: 'active', variant: 'secondary' };
  return { word: 'revoked', variant: 'destructive' };
}

/** One label/value row of the card, in the shape the sibling cards use. */
function CardRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      {children}
    </div>
  );
}

/**
 * The rows that describe a key the snapshot has: when it was last used, when
 * it was rotated (or, for a key never rotated, when it was created, said as
 * such) and which switches are off. Nothing here is shown for a key that is
 * absent or unread, because none of it would be a fact.
 */
function KeyRows({ keyState, sectionsOff }) {
  return (
    <>
      <CardRow label="Last used">
        <Badge variant="outline">{formatTimestamp(keyState.lastUsedAt)}</Badge>
      </CardRow>
      {keyState.rotatedAt ? (
        <CardRow label="Rotated">
          <Badge variant="outline">{formatTimestamp(keyState.rotatedAt)}</Badge>
        </CardRow>
      ) : (
        <CardRow label="Created, never rotated">
          <Badge variant="outline">{formatTimestamp(keyState.createdAt)}</Badge>
        </CardRow>
      )}
      <CardRow label="Switches off">
        <span className="text-right text-xs text-muted-foreground" data-testid="agent-switches-off">
          {sectionsOff.length
            ? sectionsOff.map((section) => section.label).join(', ')
            : 'none, every switch is on'}
        </span>
      </CardRow>
    </>
  );
}

/** The refusal count, or the fact that it could not be made. */
function RefusalsBadge({ denials }) {
  if (denials.unavailable) return <Badge variant="outline">could not be counted</Badge>;
  const total = denials.total || 0;
  return (
    <Badge variant={getBadgeVariantByCount(total, 'destructive')}>
      {total}
      {denials.bounded ? '+' : ''}
    </Badge>
  );
}

/**
 * The reasons, most frequent first, when the read made it and found any. At
 * the read's bound each count is a floor, like the total, so it carries the
 * same "+".
 */
function RefusalReasons({ denials }) {
  if (denials.unavailable || !denials.byReason?.length) return null;
  const floor = denials.bounded ? '+' : '';
  return (
    <ul className="space-y-1 text-xs" data-testid="agent-denials-by-reason">
      {denials.byReason.slice(0, 6).map((row) => (
        <li key={row.reason} className="flex items-center justify-between font-mono">
          <span>{row.reason}</span>
          <span className="text-muted-foreground">
            {row.count}
            {floor}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The content agent (Koda): its key, the switches that are off and the day's
 * refusals by reason, from the snapshot's `agent` block (#1491). The same
 * verdict as the Content agent probe on Checks. Never the key or its hint:
 * that is the Koda tab's, behind super_admin. A snapshot without the block
 * (one written before this card existed) gets the verdict sentence and the
 * link only: rows of "none" and "0" would read as findings.
 */
export function ContentAgentCard({ agent }) {
  const verdict = contentAgentVerdict(agent);
  const key = agent?.key || {};
  const denials = agent?.denials || {};
  const badge = keyBadge(key);
  const sectionsOff = agent?.sectionsOff || [];
  const kodaLink = (
    <p className="text-xs">
      <Link to={KODA.to} className="font-medium text-primary underline-offset-2 hover:underline">
        {KODA.label}: the key, its switches and the route list
      </Link>
    </p>
  );
  return (
    <Card className="flex h-full flex-col" data-testid="content-agent-card">
      <SignalCardHeader
        icon={<Bot className="h-4 w-4 text-violet-500" aria-hidden="true" />}
        title={`Content agent (${agent?.label || 'Koda'})`}
        status={verdict.status}
      />
      <CardContent className="flex flex-1 flex-col gap-2 text-sm">
        <p className="text-xs text-muted-foreground">{verdict.summary}</p>
        {agent ? (
          <>
            <CardRow label="Key">
              <Badge variant={badge.variant}>{badge.word}</Badge>
            </CardRow>
            {key.present ? <KeyRows keyState={key} sectionsOff={sectionsOff} /> : null}
            <CardRow label="Refusals, last 24 h">
              <RefusalsBadge denials={denials} />
            </CardRow>
            <RefusalReasons denials={denials} />
            {denials.lastAt ? (
              <p className="text-xs text-muted-foreground">
                Last refusal {formatTimestamp(denials.lastAt)}.
              </p>
            ) : null}
          </>
        ) : null}
        {kodaLink}
        <CheckedFooter at={agent?.lastCheckedAt} />
      </CardContent>
    </Card>
  );
}

/**
 * Last night's Cosmos export, from the snapshot's `backups` block (#1409):
 * the newest completed run, when it finished, how many containers it holds,
 * whether every authored container is in it, and brain_records on its own
 * with its partition key. The same verdict as the Nightly export probe on
 * Checks. Names and counts only; a snapshot without the block (one written
 * before this section existed) gets the verdict sentence and nothing that
 * would read as a finding.
 */
function NightlyExportSection({ backups }) {
  const verdict = nightlyExportVerdict(backups);
  const last = backups?.lastCompleted || null;
  const missing = last?.authored?.missing || [];
  const watched = last?.watched || null;
  return (
    <div className="space-y-2 pt-2 border-t" data-testid="nightly-export">
      <div className="flex items-center justify-between">
        <span className="font-medium">Nightly export</span>
        <StatusBadge system={verdict.status} size="xs" />
      </div>
      <p className="text-xs text-muted-foreground" data-testid="nightly-export-summary">
        {verdict.summary}
      </p>
      {last ? (
        <>
          <CardRow label="Last completed run">
            <Badge variant="outline" data-testid="nightly-export-run">
              {last.mode}/{last.runId}
            </Badge>
          </CardRow>
          <CardRow label="Finished">
            <Badge variant="outline">{formatTimestamp(last.completedAt)}</Badge>
          </CardRow>
          <CardRow label="Containers in the run">
            <Badge variant="outline">
              {last.containerCount}
              {Number.isFinite(last.expectedCount) ? ` of ${last.expectedCount} planned` : ''}
            </Badge>
          </CardRow>
          <CardRow label="Authored containers">
            <Badge
              variant={missing.length ? 'destructive' : 'secondary'}
              data-testid="nightly-export-authored"
            >
              {last.authored?.present ?? 0} of {last.authored?.expected ?? 0}
            </Badge>
          </CardRow>
          {missing.length ? (
            <p className="text-xs text-destructive font-mono" data-testid="nightly-export-missing">
              Missing: {missing.join(', ')}
            </p>
          ) : null}
          {watched ? (
            <CardRow label={`${watched.container} (partition key ${watched.partitionKey})`}>
              <Badge
                variant={watched.present ? 'secondary' : 'destructive'}
                data-testid="nightly-export-watched"
              >
                {watched.present ? `${watched.docs ?? 0} records` : 'not in the run'}
              </Badge>
            </CardRow>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function OperationalSignalsCard({ signals, backups = null }) {
  return (
    <Card className="flex h-full flex-col">
      <SignalCardHeader
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />}
        title="Operational Signals"
        status={worstStatus([signalsStatus(signals), nightlyExportVerdict(backups).status])}
      />
      <CardContent className="flex flex-1 flex-col gap-3 text-sm">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 border rounded-lg">
            <p className="text-muted-foreground text-xs">Queue SLA Breaches</p>
            <p className="text-xl font-bold">{signals.queueBreachCount || 0}</p>
            <StatusBadge system={countStatus(signals.queueBreachCount)} size="xs" />
          </div>
          <div className="p-3 border rounded-lg">
            <p className="text-muted-foreground text-xs">Oldest Waiting to Go Live</p>
            <p className="text-xl font-bold" data-testid="oldest-staged-age">
              {signals.oldestStagedHours === null
                ? 'no recorded time'
                : formatHours(signals.oldestStagedHours)}
            </p>
            {Number.isFinite(signals.stagedWaitingCount) ? (
              <p className="text-muted-foreground text-xs" data-testid="staged-waiting-count">
                {signals.stagedWaitingCount} approved or published, not live, not scheduled
              </p>
            ) : null}
            <StatusBadge system={stagedAgeStatus(signals.oldestStagedHours)} size="xs" />
          </div>
          <div className="p-3 border rounded-lg">
            <p className="text-muted-foreground text-xs">Open Alert Age</p>
            <p className="text-xl font-bold">{formatHours(signals.openAlertAgeHours)}</p>
            <StatusBadge
              system={(signals.openAlertAgeHours || 0) > 24 ? 'degraded' : 'healthy'}
              size="xs"
            />
          </div>
          <div className="p-3 border rounded-lg">
            <p className="text-muted-foreground text-xs">Orphaned Images</p>
            <p className="text-xl font-bold">{signals.orphanedGeneratedImages || 0}</p>
            <StatusBadge system={countStatus(signals.orphanedGeneratedImages)} size="xs" />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span>Publish Failure Alerts</span>
          <Badge variant={getBadgeVariantByCount(signals.publishFailureCount || 0, 'destructive')}>
            {signals.publishFailureCount || 0}
          </Badge>
        </div>
        <div className="flex items-center justify-between">
          <span>Last Scheduler Success</span>
          <Badge variant="outline">{formatTimestamp(signals.lastSchedulerSuccessAt)}</Badge>
        </div>
        {signals?.jobs24h ? <JobsStrip jobs={signals.jobs24h} /> : null}
        <NightlyExportSection backups={backups} />
        {signals?.failedJobsUnavailable ? (
          <p
            className="text-xs text-amber-700 dark:text-amber-400"
            data-testid="failed-jobs-unavailable"
          >
            The failed-jobs read did not answer, so no failed job can be listed here. That is not
            the same as none; check again, and the Cosmos DB probe on Checks.
          </p>
        ) : null}
        {(signals?.failedJobs || []).length > 0 && (
          <div className="space-y-2 pt-2 border-t" data-testid="failed-jobs-section">
            <div className="flex items-center justify-between">
              <span className="font-medium text-destructive">Failed Platform Jobs</span>
              <Badge variant="destructive">{signals.failedJobs.length}</Badge>
            </div>
            <div className="space-y-1.5">
              {signals.failedJobs.map((job) => (
                <div
                  key={job.id}
                  className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs"
                  data-testid={`failed-job-${job.id}`}
                >
                  <div className="flex items-center justify-between font-mono font-medium">
                    <span>
                      {job.type} ({job.id})
                    </span>
                    <span className="text-muted-foreground">
                      {formatTimestamp(job.finishedAt || job.createdAt)}
                    </span>
                  </div>
                  {job.error && (
                    <p className="mt-1 font-mono text-xs text-destructive break-all">{job.error}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <CheckedFooter at={signals.lastCheckedAt} />
      </CardContent>
    </Card>
  );
}

/** One workflow alert with its state changes, gated together because the hub is a viewer read and updateWorkflowAlert is publisher. */
function AlertRow({
  alert,
  alertActionId,
  resolutionNotes,
  setResolutionNotes,
  handleAlertAction,
}) {
  const status = getAlertStatus(alert);
  // `?alert=<id>` (the dashboard's Decision Center) scrolls to this alert and rings it.
  const { ref, linkedProps, linkedClassName } = useLinkedItem(LINK_PARAMS.alert, alert.id);
  return (
    <div
      key={alert.id}
      ref={ref}
      {...linkedProps}
      className={`rounded-lg border p-3 ${linkedClassName}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{alert.alertType || 'workflow_alert'}</p>
          <p className="text-xs text-muted-foreground">
            {alert.source || 'unknown source'} ·{' '}
            {formatTimestamp(alert.updatedAt || alert.firstSeenAt)}
          </p>
        </div>
        <Badge variant={alert.severity === 'critical' ? 'destructive' : 'outline'}>
          {alert.severity || 'warning'}
        </Badge>
      </div>
      {status !== 'resolved' && (
        <div className="mt-3">
          <Input
            value={resolutionNotes[alert.id] || ''}
            onChange={(e) =>
              setResolutionNotes((prev) => ({ ...prev, [alert.id]: e.target.value }))
            }
            placeholder="Resolution note (required to resolve)"
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {/* The hub is readable by a viewer; updateWorkflowAlert is publisher
            (lib/ops-health.js), so the three state changes say so together. */}
        <RoleGate minRole="publisher" reason="Changing an alert's state needs the publisher role.">
          {status === 'open' && (
            <Button
              size="sm"
              variant="outline"
              disabled={alertActionId !== ''}
              onClick={() => handleAlertAction(alert.id, 'acknowledge')}
            >
              {alertActionId === `${alert.id}:acknowledge` ? 'Acknowledging...' : 'Acknowledge'}
            </Button>
          )}
          {status !== 'resolved' && (
            <Button
              size="sm"
              disabled={alertActionId !== ''}
              onClick={() => handleAlertAction(alert.id, 'resolve')}
            >
              {alertActionId === `${alert.id}:resolve` ? 'Resolving...' : 'Resolve'}
            </Button>
          )}
          {status === 'resolved' && (
            <Button
              size="sm"
              variant="outline"
              disabled={alertActionId !== ''}
              onClick={() => handleAlertAction(alert.id, 'reopen')}
            >
              {alertActionId === `${alert.id}:reopen` ? 'Reopening...' : 'Reopen'}
            </Button>
          )}
        </RoleGate>
        <Badge variant="secondary">{status}</Badge>
      </div>
    </div>
  );
}

export function WorkflowAlertsCard({
  alertFilter,
  setAlertFilter,
  filteredAlerts,
  alertActionId,
  resolutionNotes,
  setResolutionNotes,
  handleAlertAction,
  status = 'unknown',
}) {
  return (
    <Card>
      <SignalCardHeader
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />}
        title="Workflow Alerts"
        status={status}
      />
      <CardContent>
        <div className="mb-4 flex flex-wrap gap-2">
          {ALERT_FILTERS.map((filter) => (
            <Button
              key={filter.value}
              size="sm"
              variant={alertFilter === filter.value ? 'default' : 'outline'}
              onClick={() => setAlertFilter(filter.value)}
            >
              {filter.label}
            </Button>
          ))}
        </div>
        {filteredAlerts.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-emerald-600">
            <CheckCircle2 className="h-4 w-4" /> No alerts in this filter.
          </div>
        ) : (
          <div className="space-y-3">
            {filteredAlerts.map((alert) => (
              <AlertRow
                key={alert.id}
                alert={alert}
                alertActionId={alertActionId}
                resolutionNotes={resolutionNotes}
                setResolutionNotes={setResolutionNotes}
                handleAlertAction={handleAlertAction}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
