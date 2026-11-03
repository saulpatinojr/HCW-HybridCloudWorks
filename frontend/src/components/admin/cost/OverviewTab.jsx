/**
 * Overview — the month on one screen: four tiles (Azure, AI, Services,
 * Alerts), each opening its tab; where the money goes this month, with the
 * forecast; the last closed months; and what was read, when, and whether any
 * source failed, with the Refresh button.
 *
 * Every number is the server's. The page passes the snapshot in; this tab
 * fetches nothing of its own.
 */
import React from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Bot, Cloud, CreditCard, Loader2, RefreshCw, Siren } from 'lucide-react';
import StatTile from '@/components/admin/shared/StatTile';
import { Button } from '@/components/ui/button';
import { agoLabel, budgetTone, fmtUsd, monthLabel, percent, renewalLabel } from '@/lib/cost';
import { tabHref } from './tabs';
import {
  DateText,
  Figure,
  Figures,
  Money,
  SectionCard,
  TABLE_CLASS,
  TD_CLASS,
  TEXT_CLASS,
  TH_CLASS,
} from './costShared';

/** Plain names for the sources the server reads. */
export const SOURCE_NAMES = Object.freeze({
  azure: 'Azure Cost Management',
  'ai-ledger': 'the AI usage ledger',
  elevenlabs: 'ElevenLabs',
  services: 'the services ledger',
});
const sourceName = (id) => SOURCE_NAMES[id] ?? id;

/** The four tiles, each from one corner of the snapshot. */
export function tilesFor(summary) {
  const { azure, ai, services, signals } = summary;
  const azurePct = percent(azure.totals.monthToDate, azure.totals.budget);
  const aiPct = percent(ai.monthToDate.costUsd, ai.budgetUsd);
  const nextRenewal = services.upcoming[0] ?? null;
  const critical = signals.filter((s) => s.severity === 'critical').length;
  const warning = signals.filter((s) => s.severity === 'warning').length;
  const info = signals.length - critical - warning;
  const alertNote =
    signals.length === 0
      ? 'nothing to act on'
      : [
          critical && `${critical} critical`,
          warning && `${warning} warning`,
          info && `${info} info`,
        ]
          .filter(Boolean)
          .join(', ');
  return [
    {
      to: tabHref('azure'),
      icon: Cloud,
      label: azure.available
        ? `Azure this month${azure.totals.budget ? ` of ${fmtUsd(azure.totals.budget)} budget` : ''}`
        : 'Azure this month',
      value: azure.available ? fmtUsd(azure.totals.monthToDate) : '—',
      note: azure.available
        ? `forecast ${fmtUsd(azure.totals.forecast)}${azurePct !== null ? ` · ${azurePct}% used` : ''}`
        : 'not available',
      tone: azure.available ? budgetTone(azurePct) : 'muted',
    },
    {
      to: tabHref('ai'),
      icon: Bot,
      label: ai.budgetUsd ? `AI this month of ${fmtUsd(ai.budgetUsd)} budget` : 'AI this month',
      value: fmtUsd(ai.monthToDate.costUsd),
      note: ai.budgetUsd
        ? `${aiPct}% used · ${ai.monthToDate.calls.toLocaleString('en-US')} calls`
        : `no budget set · ${ai.monthToDate.calls.toLocaleString('en-US')} calls`,
      tone: budgetTone(aiPct),
    },
    {
      to: tabHref('services'),
      icon: CreditCard,
      label: `Services per month (${services.count})`,
      value: fmtUsd(services.monthlyEquivalent),
      note: nextRenewal
        ? `next: ${nextRenewal.name} ${renewalLabel(nextRenewal.daysUntilRenewal)}`
        : 'no renewal in the next 30 days',
      tone: 'muted',
    },
    {
      to: tabHref('alerts'),
      icon: Siren,
      label: 'Alerts',
      value: String(signals.length),
      note: alertNote,
      tone: alertsTone(critical, warning),
    },
  ];
}

/** The Alerts tile reads as the worst open signal. */
function alertsTone(critical, warning) {
  if (critical) return 'bad';
  if (warning) return 'warn';
  return 'muted';
}

function WhereTheMoneyGoes({ summary }) {
  const { azure, ai, services } = summary;
  const rows = [
    {
      id: 'azure',
      label: 'Azure',
      value: azure.available ? azure.totals.monthToDate : null,
      forecast: azure.available ? azure.totals.forecast : null,
      href: tabHref('azure'),
    },
    {
      id: 'ai',
      label: 'AI providers (priced calls)',
      value: ai.monthToDate.costUsd,
      forecast: null,
      href: tabHref('ai'),
    },
    {
      id: 'services',
      label: 'Services (monthly equivalent)',
      value: services.monthlyEquivalent,
      forecast: services.monthlyEquivalent,
      href: tabHref('services'),
    },
  ];
  const total = rows.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0);
  return (
    <SectionCard
      title="Where the money goes"
      description="This month so far, by what is paid for. Azure's forecast is Azure's own; the services line is the same every month until a subscription changes."
    >
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {rows.map((row, index) => {
          const share = total > 0 && Number.isFinite(row.value) ? (row.value / total) * 100 : 0;
          const colour = ['bg-sky-500', 'bg-violet-500', 'bg-emerald-500'][index];
          return <div key={row.id} className={colour} style={{ width: `${share}%` }} />;
        })}
      </div>
      <table className={TABLE_CLASS}>
        <thead>
          <tr className="text-left">
            <th className={TH_CLASS}>What</th>
            <th className={`${TH_CLASS} text-right`}>So far</th>
            <th className={`${TH_CLASS} text-right`}>Share</th>
            <th className={`${TH_CLASS} text-right`}>Month forecast</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className={TD_CLASS}>
                <Link to={row.href} className="underline-offset-2 hover:underline">
                  {row.label}
                </Link>
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money value={row.value} />
              </td>
              <td className={`${TD_CLASS} text-right tabular-nums text-muted-foreground`}>
                {total > 0 && Number.isFinite(row.value) ? `${percent(row.value, total)}%` : '—'}
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money value={row.forecast} />
              </td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="py-1.5">Total so far</td>
            <td className="py-1.5 text-right">
              <Money value={total} />
            </td>
            <td />
            <td />
          </tr>
        </tbody>
      </table>
    </SectionCard>
  );
}

function LastMonths({ history }) {
  if (!history?.length) return null;
  return (
    <SectionCard
      title="Last months"
      description="The closing figures of each month the page has seen, newest first."
    >
      <table className={TABLE_CLASS}>
        <thead>
          <tr className="text-left">
            <th className={TH_CLASS}>Month</th>
            <th className={`${TH_CLASS} text-right`}>Azure</th>
            <th className={`${TH_CLASS} text-right`}>AI</th>
            <th className={`${TH_CLASS} text-right`}>Services</th>
          </tr>
        </thead>
        <tbody>
          {history.map((row) => (
            <tr key={row.month}>
              <td className={TD_CLASS}>{monthLabel(row.month)}</td>
              <td className={`${TD_CLASS} text-right`}>
                <Money value={row.azureMonthToDate} />
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money value={row.aiCostUsd} />
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money value={row.servicesMonthly} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionCard>
  );
}

/** What was read, when, which source failed, and the Refresh button. */
export function SourcesLine({ summary, pending, onRefresh }) {
  const failed = summary.sources.filter((s) => !s.ok);
  const okNames = summary.sources.filter((s) => s.ok).map((s) => sourceName(s.id));
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3 text-xs">
      <div className="space-y-1">
        <p>
          Read {okNames.length ? okNames.join(', ') : 'nothing'}
          {summary.readAt ? (
            <>
              {' '}
              <span title={summary.readAt}>{agoLabel(summary.readAt)}</span> (
              <DateText value={summary.readAt} withTime />)
            </>
          ) : (
            ' — never read yet'
          )}
          . Azure cost figures lag by up to a day.
        </p>
        {failed.map((source) => (
          <p
            key={source.id}
            className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {sourceName(source.id).replace(/^the /, 'The ')} could not be read: {source.error}
            </span>
          </p>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => onRefresh(true)}
        title="Ask the server to read Azure, the AI ledger and ElevenLabs again now"
      >
        {pending ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        )}
        Refresh
      </Button>
    </div>
  );
}

export default function OverviewTab({ summary, pending, onRefresh }) {
  const tiles = tilesFor(summary);
  return (
    <div className="space-y-6 pt-4">
      {summary.stale ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            These figures are more than 36 hours old
            {summary.readAt ? (
              <>
                {' '}
                (read <DateText value={summary.readAt} withTime />)
              </>
            ) : null}
            . Press Refresh to read the sources again; if that fails, the Alerts tab says which
            source refused.
          </span>
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 auto-rows-fr lg:grid-cols-4">
        {tiles.map(({ tone, ...tile }) => (
          <StatTile
            key={tile.label}
            {...tile}
            iconClassName={TEXT_CLASS[tone]}
            noteClassName={tone === 'muted' ? undefined : TEXT_CLASS[tone]}
          />
        ))}
      </div>
      <Figures>
        <Figure
          label="Month"
          value={monthLabel(summary.period.month)}
          note={`day ${summary.period.daysElapsed} of ${summary.period.daysInMonth}`}
        />
        <Figure
          label="Azure last month"
          value={<Money value={summary.azure.totals.previousMonth} />}
        />
        <Figure
          label="AI last month"
          value={<Money value={summary.ai.previousMonth?.costUsd ?? null} />}
          note={
            summary.ai.previousMonth
              ? `${summary.ai.previousMonth.calls.toLocaleString('en-US')} calls`
              : 'not readable'
          }
        />
        <Figure
          label="Services per year"
          value={<Money value={summary.services.annualEquivalent} />}
        />
      </Figures>
      <WhereTheMoneyGoes summary={summary} />
      <LastMonths history={summary.history} />
      <SourcesLine summary={summary} pending={pending} onRefresh={onRefresh} />
    </div>
  );
}
