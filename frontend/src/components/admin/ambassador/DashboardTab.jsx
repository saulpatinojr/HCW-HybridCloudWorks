/**
 * Dashboard (ADR 0033 §4): where every pursuit stands at a glance — the
 * programs in play, readiness per pursued program with what is missing,
 * what is dated and coming (deadlines, renewals, windows), evidence about to
 * stop counting, what was added lately, the next actions in words, and the
 * status overview. Everything here points at the tab that acts on it.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowRight } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { TabLoading } from '@/components/admin/integrations/TabNotice';
import {
  APPLICATION_STATUSES,
  HOLDING_STATUSES,
  PURSUING_STATUSES,
  ambassadorStatusInfo,
  expiringEvidence,
  programById,
  programsInPlay,
  recentEvidence,
  recommendedActions,
  sourceLabel,
  readinessPeriodFor,
  statusCounts,
  todayIso,
  upcomingDeadlines,
} from './ambassadorModel';
import { ReadinessPanel, ReadsStatus, allLanded, whenText } from './Parts';
import useReadiness from './useReadiness';

function Stat({ label, value, hint }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** One pursued program's readiness; reports the result up for the recommended actions. */
function ProgramReadiness({ program, application, onLoaded, onOpen }) {
  const readiness = useReadiness(program.id, readinessPeriodFor(program, application));
  useEffect(() => {
    if (readiness.loaded) onLoaded(program.id, readiness.data);
  }, [program.id, readiness.loaded, readiness.data, onLoaded]);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 pb-2">
        <div>
          <CardTitle className="text-base">{program.name}</CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-2">
            {program.provider}
            <StatusBadge size="xs" status={ambassadorStatusInfo(application.status)} />
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => onOpen(application.id)}>
          Open application <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </CardHeader>
      <CardContent>
        {readiness.loading && <TabLoading>Computing readiness…</TabLoading>}
        {readiness.error && <p className="text-sm text-destructive">{readiness.error}</p>}
        {readiness.loaded && <ReadinessPanel readiness={readiness.data} compact />}
        {readiness.loaded && readiness.data.missing.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Missing:{' '}
            {readiness.data.missing
              .map((m) => `${m.shortfall} more ${m.label.toLowerCase()}`)
              .join(', ')}
            .
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DatedList({ title, items, empty, render }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-1.5 text-sm">{items.map(render)}</ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardTab({ hub, nav }) {
  const { programs, applications, evidence } = hub;
  const reads = [programs, applications, evidence];
  const [readinessById, setReadinessById] = useState({});
  const onLoaded = React.useCallback((programId, data) => {
    setReadinessById((current) =>
      current[programId] === data ? current : { ...current, [programId]: data }
    );
  }, []);
  const today = todayIso();

  const pursued = useMemo(
    () => applications.data.filter((a) => PURSUING_STATUSES.includes(a.status)),
    [applications.data]
  );
  const held = useMemo(
    () => applications.data.filter((a) => HOLDING_STATUSES.includes(a.status)),
    [applications.data]
  );
  const byId = useMemo(() => programById(programs.data), [programs.data]);
  const deadlines = useMemo(
    () => upcomingDeadlines(applications.data, programs.data, { today }),
    [applications.data, programs.data, today]
  );
  const expiring = useMemo(
    () => expiringEvidence(evidence.data, { today }),
    [evidence.data, today]
  );
  const recent = useMemo(() => recentEvidence(evidence.data), [evidence.data]);
  const actions = useMemo(
    () =>
      recommendedActions({
        applications: applications.data,
        programs: programs.data,
        evidence: evidence.data,
        readinessById,
        today,
      }),
    [applications.data, programs.data, evidence.data, readinessById, today]
  );
  const counts = useMemo(() => statusCounts(applications.data), [applications.data]);

  return (
    <div className="space-y-6 pt-4">
      <ReadsStatus reads={reads} label="the Ambassador hub" />
      {allLanded(reads) && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" role="group" aria-label="Overview">
            <Stat
              label="Programs"
              value={programsInPlay(programs.data).filter((p) => p.enabled !== false).length}
              hint={`${programs.data.length} in the catalogue`}
            />
            <Stat label="Pursued" value={pursued.length} hint="applications in progress" />
            <Stat label="Held" value={held.length} hint="awards active or renewing" />
            <Stat
              label="Evidence"
              value={evidence.data.length}
              hint={`${expiring.length} aging out soon`}
            />
          </div>

          <section className="space-y-3" aria-labelledby="ambassador-readiness-heading">
            <h2
              id="ambassador-readiness-heading"
              className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Readiness per pursued program
            </h2>
            {pursued.length === 0 ? (
              <EmptyState
                compact
                title="Nothing is being pursued yet."
                description="Pick a program on the Programs tab and start an application; readiness appears here."
                action={
                  <Button size="sm" onClick={() => nav.setTab('programs')}>
                    Browse programs
                  </Button>
                }
              />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {pursued.map((application) => {
                  const program = byId.get(application.programId);
                  return program ? (
                    <ProgramReadiness
                      key={application.id}
                      program={program}
                      application={application}
                      onLoaded={onLoaded}
                      onOpen={nav.openApplication}
                    />
                  ) : null;
                })}
              </div>
            )}
          </section>

          <div className="grid gap-3 md:grid-cols-2">
            <DatedList
              title="Coming up"
              items={deadlines}
              empty="No deadlines, renewals or windows in the next 120 days."
              render={(item) => (
                <li
                  key={`${item.kind}-${item.href}-${item.date}`}
                  className="flex justify-between gap-2"
                >
                  <span>{item.label}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {whenText(item.date, today)}
                  </span>
                </li>
              )}
            />
            <DatedList
              title="Recommended next actions"
              items={actions}
              empty="Nothing outstanding from what the hub can see."
              render={(action) => <li key={action}>{action}</li>}
            />
            <DatedList
              title="Evidence about to stop counting"
              items={expiring}
              empty="No evidence is ten to twelve months old."
              render={(item) => (
                <li key={item.id} className="flex justify-between gap-2">
                  <span>{item.title}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {item.date}
                  </span>
                </li>
              )}
            />
            <DatedList
              title="Recent evidence"
              items={recent}
              empty="No evidence yet. Import talks, certifications and articles on the Evidence tab."
              render={(item) => (
                <li key={item.id} className="flex justify-between gap-2">
                  <span>
                    {item.title}{' '}
                    <span className="text-xs text-muted-foreground">
                      · {sourceLabel(item.sourceModule)}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {item.date || '—'}
                  </span>
                </li>
              )}
            />
          </div>

          <section aria-labelledby="ambassador-status-heading" className="space-y-2">
            <h2
              id="ambassador-status-heading"
              className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Status overview
            </h2>
            <div className="flex flex-wrap gap-2">
              {APPLICATION_STATUSES.filter((s) => counts[s] > 0).map((status) => (
                <span key={status} className="flex items-center gap-1 text-sm">
                  <StatusBadge size="xs" status={ambassadorStatusInfo(status)} />
                  <span className="tabular-nums">{counts[status]}</span>
                </span>
              ))}
              {applications.data.length === 0 && (
                <p className="text-sm text-muted-foreground">No applications yet.</p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
