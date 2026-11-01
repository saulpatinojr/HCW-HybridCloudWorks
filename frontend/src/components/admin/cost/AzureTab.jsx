/**
 * Azure — one card per scope the server reads (a subscription or a resource
 * group): its budget bar with the forecast marked, the month's figures, a
 * small daily chart and a by-service table. A scope whose read failed says so
 * on its card and the others still answer; when no scope could be read at
 * all, the tab says why and what to do.
 *
 * Two facts the reader needs and Azure does not print: cost data reaches Cost
 * Management up to a day late, and the forecast on a budget is Azure's own
 * (when the server could not read one it drew a straight line instead and
 * says so).
 */
import React, { useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CloudOff } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { fmtUsd } from '@/lib/cost';
import {
  BudgetBar,
  DateText,
  Figure,
  Figures,
  Money,
  SectionCard,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from './costShared';

/** Rows of the by-service table shown before "Show all". */
export const SERVICE_ROWS = 8;

const KIND_WORDS = { subscription: 'subscription', resourceGroup: 'resource group' };

/** What the forecast figure is, in words the card prints beside it. */
export function forecastNote(method) {
  if (method === 'azure') return "Azure's own forecast";
  if (method === 'straight-line') return 'straight-line estimate from the days so far';
  return 'no forecast';
}

/** The Azure portal's words for a day-of-month axis. */
const dayOf = (date) => String(date).slice(8, 10).replace(/^0/, '');

function DailyChart({ daily }) {
  if (!daily?.length) return null;
  const data = daily.map((point) => ({ day: dayOf(point.date), cost: point.cost }));
  return (
    <div className="h-28" aria-label="Cost per day this month" role="img">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
          <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => fmtUsd(value)} width={70} />
          <Tooltip
            formatter={(value) => [fmtUsd(value), 'Cost']}
            labelFormatter={(day) => `Day ${day}`}
            contentStyle={{ fontSize: 11 }}
          />
          <Bar dataKey="cost" fill="currentColor" className="text-sky-500" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ByServiceTable({ rows, scopeLabel }) {
  const [showAll, setShowAll] = useState(false);
  if (!rows?.length) {
    return <p className="text-xs text-muted-foreground">No cost by service yet this month.</p>;
  }
  const sorted = [...rows].sort((a, b) => b.cost - a.cost);
  const shown = showAll ? sorted : sorted.slice(0, SERVICE_ROWS);
  return (
    <div className="space-y-2">
      <table className={TABLE_CLASS} aria-label={`Cost by service: ${scopeLabel}`}>
        <thead>
          <tr className="text-left">
            <th className={TH_CLASS}>Resource group</th>
            <th className={TH_CLASS}>Service</th>
            <th className={`${TH_CLASS} text-right`}>This month</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={`${row.resourceGroup}/${row.service}`}>
              <td className={`${TD_CLASS} font-mono`}>{row.resourceGroup}</td>
              <td className={TD_CLASS}>{row.service}</td>
              <td className={`${TD_CLASS} text-right`}>
                <Money value={row.cost} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > SERVICE_ROWS ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${sorted.length}`}
        </Button>
      ) : null}
    </div>
  );
}

function BudgetFigures({ budget }) {
  if (!budget) {
    return (
      <p className="text-xs text-muted-foreground">
        No Azure budget on this scope, so there is nothing to measure the spend against. A budget is
        created in the Azure portal under Cost Management, Budgets; the page reads it on the next
        refresh.
      </p>
    );
  }
  return (
    <>
      <BudgetBar
        percent={budget.percentUsed}
        forecastPercent={budget.percentForecast}
        label={`Budget ${budget.name}: ${fmtUsd(budget.amount)}`}
      />
      <p className="text-xs text-muted-foreground">
        Budget <span className="font-mono">{budget.name}</span>, {fmtUsd(budget.amount)} a month.
        Azure alerts at {budget.thresholds.map((t) => `${t}%`).join(', ') || 'no threshold'} of the
        spend
        {budget.forecastThresholds.length
          ? ` and at ${budget.forecastThresholds.map((t) => `${t}%`).join(', ')} of the forecast`
          : ''}
        .
      </p>
    </>
  );
}

export function ScopeCard({ scope }) {
  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-baseline gap-2">
          {scope.label}
          <span className="text-xs font-normal text-muted-foreground">
            {KIND_WORDS[scope.kind] ?? scope.kind}
            {scope.name ? ` · ${scope.name}` : ''}
          </span>
        </span>
      }
    >
      {scope.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>This scope could not be read: {scope.error}</span>
        </p>
      ) : null}
      <BudgetFigures budget={scope.budget} />
      <Figures>
        <Figure label="Month to date" value={<Money value={scope.monthToDate} />} />
        <Figure
          label="Forecast for the month"
          value={<Money value={scope.forecast} />}
          note={forecastNote(scope.forecastMethod)}
        />
        <Figure label="Previous month" value={<Money value={scope.previousMonth} />} />
        <Figure label="Budget" value={<Money value={scope.budget?.amount ?? null} />} />
      </Figures>
      <DailyChart daily={scope.daily} />
      <ByServiceTable rows={scope.byService} scopeLabel={scope.label} />
    </SectionCard>
  );
}

export default function AzureTab({ summary }) {
  const { azure, period } = summary;
  if (!azure.available) {
    return (
      <div className="pt-4">
        <EmptyState
          icon={CloudOff}
          title="Azure costs are not available"
          description={`${azure.reason || 'No scope could be read.'} To fix it, give the site's identity the Cost Management Reader role on each subscription it should read and name the scopes in the COST_SCOPES setting; the Cost runbook (docs/runbooks/cost.md) has the steps.`}
        />
      </div>
    );
  }
  return (
    <div className="space-y-4 pt-4">
      <p className="text-sm text-muted-foreground">
        Azure cost data reaches Cost Management up to a day late, so today is usually missing; the
        forecast on a budget is Azure&apos;s own. Figures are for <DateText value={period.start} />{' '}
        to <DateText value={period.end} />.
      </p>
      {azure.scopes.map((scope) => (
        <ScopeCard key={scope.id} scope={scope} />
      ))}
      {azure.scopes.length === 0 ? (
        <EmptyState
          title="No scope is configured"
          description="Name the subscriptions or resource groups to read in the COST_SCOPES setting; the Cost runbook (docs/runbooks/cost.md) has the steps."
        />
      ) : null}
    </div>
  );
}
