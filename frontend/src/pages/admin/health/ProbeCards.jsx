/**
 * The probe registry on screen (ADR 0033 Platform): one card per probe, in
 * hub groups, each saying the same five things — what it covers, how it is
 * doing (one StatusBadge word), when that was last true, what breaks if it is
 * not, and what to do — with a Test button where one exists and a link to
 * the page that holds the fix.
 *
 * Every card has the same three parts, in the same places (#1010):
 *
 *   header  the title and what it covers, and the status in the top-right
 *           slot (StatusSlot.jsx), which never wraps under a long sentence
 *   body    what the last check said; when that is older than its window,
 *           the value it had and that it is stale
 *   footer  when it was checked and by whom, what breaks, what to do, and
 *           the actions — pinned to the bottom, so every card in a row ends
 *           on the same line
 */

import React from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { describeAge, describeWindow, toSystemStatus } from '@/lib/status';
import { ArrowUpRight, FlaskConical, Loader2 } from 'lucide-react';
import { formatTimestamp } from './signals';
import { checkedByLabel, probesByHub } from './probeRegistry';
import StatusSlot from './StatusSlot';

/** "12 min ago · Oct 8, 10:02 · by the pulse", or "Not yet". */
export function checkedLine(result, now = Date.now()) {
  if (!result?.checkedAt) return 'Not yet';
  const age = describeAge(result.checkedAt, now);
  return `${age} · ${formatTimestamp(result.checkedAt)} · by ${checkedByLabel(result)}`;
}

function StaleNote({ result }) {
  if (!result?.stale) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="probe-stale">
      Stale: last {toSystemStatus(result.lastStatus).label}, older than its{' '}
      {describeWindow(result.windowMs)} window. Test again for a current answer.
    </p>
  );
}

function ProbeActions({ probe, running, onRun }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {probe.run ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRun(probe)}
          disabled={running}
          aria-label={running ? `Testing ${probe.label}` : `Test ${probe.label}`}
        >
          {running ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          )}
          {probe.kind === 'snapshot' ? 'Re-read' : 'Test'}
        </Button>
      ) : null}
      {probe.href ? (
        <Link
          to={probe.href.to}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {probe.href.label} <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      ) : null}
      {!probe.safe && probe.costNote ? (
        <span className="text-xs text-muted-foreground">Not in Test all: {probe.costNote}</span>
      ) : null}
    </div>
  );
}

export function ProbeCard({ probe, result, running, onRun, now }) {
  return (
    <article
      className="flex h-full flex-col rounded-lg border border-border p-3 text-sm"
      data-probe={probe.id}
      aria-label={probe.label}
      aria-busy={running || undefined}
    >
      <header className="flex items-start gap-3" data-slot="header">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold leading-tight">{probe.label}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{probe.covers}</p>
        </div>
        <StatusSlot status={result?.status ?? 'unknown'} />
      </header>
      <div className="mt-2 flex flex-1 flex-col gap-2" data-slot="body">
        <p className="wrap-break-word text-xs" data-testid="probe-summary">
          {result?.summary ?? 'Not tested yet.'}
        </p>
        <StaleNote result={result} />
        {result?.detail ? (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap wrap-break-word rounded border border-border/60 bg-muted/40 p-2 font-mono text-xs">
            {result.detail}
          </pre>
        ) : null}
      </div>
      <footer className="mt-3 space-y-2 border-t border-border/60 pt-2" data-slot="footer">
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <dt>Checked</dt>
          <dd data-testid="probe-checked">{checkedLine(result, now)}</dd>
          <dt>Impact</dt>
          <dd>{probe.impact}</dd>
          <dt>Fix</dt>
          <dd>{probe.action}</dd>
        </dl>
        <ProbeActions probe={probe} running={running} onRun={onRun} />
      </footer>
    </article>
  );
}

/** The five states in the order the strip lists them, worst first. */
const COUNT_ORDER = ['offline', 'critical', 'degraded', 'healthy', 'unknown'];

/** Counts of each status across the registry, for the strip and the intro. */
export function summarizeProbes(probes, resolve) {
  const counts = Object.fromEntries(COUNT_ORDER.map((id) => [id, 0]));
  for (const probe of probes) {
    const status = toSystemStatus(resolve(probe)?.status).id;
    counts[status] += 1;
  }
  return counts;
}

export default function ProbeGrid({ probes, resolve, running, runningAll, onRun, onRunAll, now }) {
  const groups = probesByHub(probes);
  const counts = summarizeProbes(probes, resolve);
  const safeCount = probes.filter((probe) => probe.safe).length;
  return (
    <section className="space-y-4" aria-label="Probe registry">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Every dependency, one word each</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {probes.length} probes across {groups.length} hubs. Test all runs the {safeCount} that
            spend nothing and write nothing, in parallel; the rest run from their own button and say
            why. Every result is kept on the server with its time, so it survives a reload or a new
            sign-in; one older than its window shows as Unknown with its last value.
          </p>
          <p className="flex flex-wrap gap-2 text-xs" aria-label="Probe status counts">
            {COUNT_ORDER.filter((status) => counts[status] > 0).map((status) => (
              <span key={status} className="inline-flex items-center gap-1">
                <StatusBadge system={status} size="xs" /> {counts[status]}
              </span>
            ))}
          </p>
        </div>
        <Button size="sm" onClick={onRunAll} disabled={runningAll}>
          {runningAll ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <FlaskConical className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          )}
          {runningAll ? 'Testing…' : 'Test all'}
        </Button>
      </div>
      {groups.map((group) => (
        <div key={group.id} className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {group.label}
          </h3>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.probes.map((probe) => (
              <li key={probe.id} className="min-w-0">
                <ProbeCard
                  probe={probe}
                  result={resolve(probe)}
                  running={running.has(probe.id)}
                  onRun={onRun}
                  now={now}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
