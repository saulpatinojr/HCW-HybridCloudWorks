/**
 * Decision Center — the dashboard's "Needs a decision", grown from the
 * newest Review Queue items into every decision waiting across the platform
 * (#1013, #1014). One read, POST getDecisionCenter
 * (functions/src/lib/decision-center.js), in six tabs:
 *
 *   Needs a Decision  everything, newest first
 *   Frameworks        framework items awaiting review
 *   Queues            the Review Queue (in_review included) and Editor work
 *   Pipelines         forge-ready and staged content, transcripts, chapters,
 *                     newsletter issues, social posts, Forge Studio failures
 *   Governance        open workflow alerts, unresolved Key Vault references
 *   Other Actions     Coder Corner reviews, due reminders, Ambassador deadlines
 *
 * Each row opens that item at its stage (lib/itemLinks.js decisionHref), and
 * the selected tab lives in the address as `?decisions=`, so Back from the
 * item returns to the dashboard on the same tab. A source that could not be
 * read is named above the rows, with its own page to open instead; the rest
 * still show.
 */
import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AlertTriangle, CheckCircle, ListChecks, Loader2, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import HubTabs from '@/components/admin/HubTabs';
import EmptyState from '@/components/admin/shared/EmptyState';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { postJSON } from '@/lib/api';
import { decisionHref } from '@/lib/itemLinks';
import {
  DECISIONS_PARAM,
  DECISION_TABS,
  DEFAULT_DECISION_TAB,
  EMPTY_TEXT,
  SOURCE_PAGES,
  VISIBLE_ROWS,
  itemsForTab,
  kindLabel,
  resolveDecisionTab,
  sourcesForTab,
  stageLabel,
  waitingLabel,
} from './decisionCenterModel';

const EMPTY = Object.freeze({ items: [], counts: {}, sources: [], errors: [] });
const loadDecisions = () => postJSON('getDecisionCenter', {});
const describeError = (err) => err?.message || 'The decisions waiting could not be read.';

/** The priority cue: words and an icon, never colour alone. Normal says nothing. */
function PriorityCue({ priority }) {
  if (priority === 'high') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/40 bg-destructive/5 px-2 py-0.5 text-xs font-medium text-destructive">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> High
      </span>
    );
  }
  if (priority === 'low') {
    return (
      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
        Low
      </span>
    );
  }
  return null;
}

function DecisionRow({ item, nowMs }) {
  const waiting = waitingLabel(item.waitingSince, nowMs);
  const context = [kindLabel(item.kind), stageLabel(item.stage), item.detail]
    .filter(Boolean)
    .join(' · ');
  return (
    <li>
      <Link
        to={decisionHref(item)}
        className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium transition-colors group-hover:text-primary">
            {item.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">{context}</p>
        </div>
        <PriorityCue priority={item.priority} />
        {waiting && (
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {waiting}
          </span>
        )}
      </Link>
    </li>
  );
}

/** The sources this tab could not read, each with its own page to open instead. */
function SourceErrors({ rows, onRetry }) {
  if (rows.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      <ul className="min-w-0 space-y-1">
        {rows.map((row) => (
          <li key={row.id}>
            {row.error}{' '}
            {SOURCE_PAGES[row.id] && (
              <Link to={SOURCE_PAGES[row.id]} className="underline underline-offset-2">
                Open {row.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Try again
      </Button>
    </div>
  );
}

/** Sources whose read window was full: there may be more than shown. */
function MoreThanShown({ rows }) {
  if (rows.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Showing the newest items from{' '}
      {rows.map((row, index) => (
        <React.Fragment key={row.id}>
          {index > 0 && ', '}
          <Link to={SOURCE_PAGES[row.id] ?? '/admin'} className="underline underline-offset-2">
            {row.label}
          </Link>
        </React.Fragment>
      ))}
      ; open a list for all of it.
    </p>
  );
}

function RestrictedNote({ rows }) {
  if (rows.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Not shown for your role: {rows.map((row) => row.label).join(', ')}.
    </p>
  );
}

function DecisionList({ items, tab, nowMs }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) {
    const empty = EMPTY_TEXT[tab] ?? EMPTY_TEXT[DEFAULT_DECISION_TAB];
    return (
      <EmptyState compact icon={CheckCircle} title={empty.title} description={empty.description} />
    );
  }
  const shown = expanded ? items : items.slice(0, VISIBLE_ROWS);
  return (
    <>
      <ul className="divide-y divide-border/50" aria-label="Decisions waiting">
        {shown.map((item) => (
          <DecisionRow key={item.id} item={item} nowMs={nowMs} />
        ))}
      </ul>
      {items.length > shown.length && (
        <div className="flex justify-center pt-2">
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            Show all {items.length}
          </Button>
        </div>
      )}
    </>
  );
}

function TabLabel({ label, count }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span className="min-w-5 rounded-full bg-muted px-1.5 text-xs font-semibold text-muted-foreground">
        {count}
      </span>
    </span>
  );
}

function DecisionBody({ load, tab, nowMs }) {
  const data = load.data || EMPTY;
  if (load.loading) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading what is waiting…
      </p>
    );
  }
  if (load.error) {
    return (
      <EmptyState
        compact
        variant="error"
        title="The decisions waiting could not be read"
        description={load.error}
        onRetry={load.refresh}
      />
    );
  }
  const rows = sourcesForTab(data.sources || [], tab);
  return (
    <div className="space-y-3">
      <SourceErrors rows={rows.filter((row) => row.error)} onRetry={load.refresh} />
      <DecisionList key={tab} items={itemsForTab(data.items || [], tab)} tab={tab} nowMs={nowMs} />
      <MoreThanShown rows={rows.filter((row) => row.truncated)} />
      <RestrictedNote rows={rows.filter((row) => row.restricted)} />
    </div>
  );
}

/**
 * @param {{ enabled?: boolean, now?: () => number }} props `now` is for tests
 */
export default function DecisionCenter({ enabled = true, now = Date.now }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = resolveDecisionTab(searchParams.get(DECISIONS_PARAM));
  const load = useGuardedLoad(loadDecisions, { enabled, empty: EMPTY, describeError });
  const counts = (load.data || EMPTY).counts || {};

  // Replace, not push: Back from an item lands on the dashboard at this tab
  // without first stepping back through every tab clicked on the way.
  const selectTab = (id) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id === DEFAULT_DECISION_TAB) next.delete(DECISIONS_PARAM);
        else next.set(DECISIONS_PARAM, id);
        return next;
      },
      { replace: true }
    );
  };

  const tabs = DECISION_TABS.map(({ id, label }) => ({
    id,
    label: <TabLabel label={label} count={counts[id] ?? 0} />,
  }));

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ListChecks className="h-4 w-4 text-amber-500" aria-hidden="true" />
            Needs a decision
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Everything across the platform waiting on you, newest first. Open one to decide it where
            it waits; Back returns here.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={load.refresh}
          disabled={load.pending}
          aria-label="Refresh the decisions"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${load.pending ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
        </Button>
      </CardHeader>
      <CardContent>
        <HubTabs
          tabs={tabs}
          active={tab}
          onSelect={selectTab}
          idPrefix="decisions"
          label="Decisions by area"
        >
          <div className="pt-3">
            <DecisionBody load={load} tab={tab} nowMs={now()} />
          </div>
        </HubTabs>
      </CardContent>
    </Card>
  );
}
