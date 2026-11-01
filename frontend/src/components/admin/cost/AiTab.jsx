/**
 * AI — what the AI providers cost this month: the figures from the site's own
 * usage ledger, one card per provider drawn by what that provider can tell us
 * (credits left, a budget, an Azure budget on the Azure tab, or only the
 * ledger), then the ledger by provider and by what spent it. The full ledger,
 * call by call, is the AI Engine's Usage tab.
 */
import React from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { labelForSource } from '@/pages/admin/AIEngineUsageTab';
import { fmtUsd, percent } from '@/lib/cost';
import { tabHref } from './tabs';
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
  fmtCount,
} from './costShared';

export const USAGE_LEDGER_HREF = '/admin/ai-engine?tab=usage';

/** The one line each provider card says under its figures. */
function Note({ children }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function CreditsCard({ provider }) {
  if (provider.error) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Credits could not be read: {provider.error}</span>
      </p>
    );
  }
  const used = Number.isFinite(provider.percentLeft) ? 100 - provider.percentLeft : null;
  return (
    <>
      <BudgetBar percent={used} label={`${provider.label} credits used`} />
      <Figures>
        <Figure label="Credits left" value={fmtCount(provider.left)} />
        <Figure label="Of" value={fmtCount(provider.limit)} note={`${provider.plan} plan`} />
        <Figure label="Resets" value={<DateText value={provider.resetAt} />} />
        <Figure label="Ledger spend" value={<Money value={provider.monthToDate} />} />
      </Figures>
      <Note>
        Credits are what the plan includes each period; the ledger spend is what the site&apos;s own
        records say the calls would cost.
      </Note>
    </>
  );
}

function BudgetCard({ provider }) {
  return (
    <>
      <BudgetBar
        percent={provider.percentUsed ?? percent(provider.monthToDate, provider.budget)}
        label={`${provider.label} budget`}
      />
      <Figures>
        <Figure label="This month" value={<Money value={provider.monthToDate} />} />
        <Figure label="Budget" value={<Money value={provider.budget} />} />
        <Figure label="Images" value={fmtCount(provider.images)} />
        <Figure label="Per image" value={<Money value={provider.unitCostUsd} />} />
      </Figures>
    </>
  );
}

function AzureBudgetCard({ provider }) {
  return (
    <>
      <BudgetBar
        percent={percent(provider.monthToDate, provider.budget)}
        forecastPercent={percent(provider.forecast, provider.budget)}
        label={`${provider.label} budget`}
      />
      <Figures>
        <Figure label="This month" value={<Money value={provider.monthToDate} />} />
        <Figure label="Forecast" value={<Money value={provider.forecast} />} />
        <Figure label="Budget" value={<Money value={provider.budget} />} />
      </Figures>
      <Note>
        {provider.note}{' '}
        {provider.scopeId ? (
          <Link to={tabHref('azure')} className="underline">
            Open the Azure tab
          </Link>
        ) : null}
      </Note>
    </>
  );
}

function LedgerCard({ provider }) {
  return (
    <>
      <Figures>
        <Figure label="This month" value={<Money value={provider.monthToDate} />} />
        <Figure label="Calls" value={fmtCount(provider.calls)} />
      </Figures>
      {provider.note ? <Note>{provider.note}</Note> : null}
    </>
  );
}

const CARD_BY_KIND = {
  credits: CreditsCard,
  budget: BudgetCard,
  'azure-budget': AzureBudgetCard,
  ledger: LedgerCard,
  free: LedgerCard,
};

export function ProviderCard({ provider }) {
  const Body = CARD_BY_KIND[provider.kind] ?? LedgerCard;
  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-baseline gap-2">
          {provider.label}
          {!provider.configured ? (
            <span className="text-xs font-normal text-muted-foreground">not configured</span>
          ) : null}
        </span>
      }
      className="h-full"
    >
      <Body provider={provider} />
    </SectionCard>
  );
}

function ProvidersTable({ rows }) {
  if (!rows?.length) return <Note>No priced call this month.</Note>;
  return (
    <table className={TABLE_CLASS} aria-label="This month by provider">
      <thead>
        <tr className="text-left">
          <th className={TH_CLASS}>Provider</th>
          <th className={`${TH_CLASS} text-right`}>Calls</th>
          <th className={`${TH_CLASS} text-right`}>Tokens</th>
          <th className={`${TH_CLASS} text-right`}>Estimated cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.provider}>
            <td className={`${TD_CLASS} font-medium`}>{row.provider}</td>
            <td className={`${TD_CLASS} text-right`}>{fmtCount(row.calls)}</td>
            <td className={`${TD_CLASS} text-right`}>{fmtCount(row.tokens)}</td>
            <td className={`${TD_CLASS} text-right`}>
              <Money value={row.costUsd} />
              {row.unpricedCalls > 0 ? (
                <span
                  className="ml-1 text-amber-700 dark:text-amber-400"
                  title={`${row.unpricedCalls} calls have no known price and are not in this figure`}
                >
                  + {row.unpricedCalls} unpriced
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SourcesTable({ rows }) {
  if (!rows?.length) return <Note>No priced call this month.</Note>;
  return (
    <table className={TABLE_CLASS} aria-label="This month by what spent it">
      <thead>
        <tr className="text-left">
          <th className={TH_CLASS}>What spent it</th>
          <th className={`${TH_CLASS} text-right`}>Calls</th>
          <th className={`${TH_CLASS} text-right`}>Tokens</th>
          <th className={`${TH_CLASS} text-right`}>Estimated cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.source}>
            <td className={`${TD_CLASS} font-medium`}>{labelForSource(row.source)}</td>
            <td className={`${TD_CLASS} text-right`}>{fmtCount(row.calls)}</td>
            <td className={`${TD_CLASS} text-right`}>{fmtCount(row.tokens)}</td>
            <td className={`${TD_CLASS} text-right`}>
              <Money value={row.costUsd} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AiTab({ summary }) {
  const { ai } = summary;
  const month = ai.monthToDate;
  const pct = percent(month.costUsd, ai.budgetUsd);
  return (
    <div className="space-y-4 pt-4">
      <p className="text-sm text-muted-foreground">
        Estimates from the site&apos;s own usage ledger, not a provider&apos;s invoice: each call is
        priced at the published rate when one is known. Calls with no known price are counted but
        not costed.
      </p>
      <Figures className="rounded-md border border-border p-3">
        <Figure
          label="Estimated spend this month"
          value={<Money value={month.costUsd} />}
          note={
            ai.previousMonth
              ? `last month ${fmtUsd(ai.previousMonth.costUsd)}`
              : 'last month unknown'
          }
        />
        <Figure
          label="Calls"
          value={fmtCount(month.calls)}
          note={`${fmtCount(month.tokens)} tokens`}
        />
        <Figure
          label="Unpriced calls"
          value={fmtCount(month.unpricedCalls)}
          note={month.unpricedCalls > 0 ? 'not in the spend figure' : null}
        />
        <Figure
          label="Monthly AI budget"
          value={ai.budgetUsd ? <Money value={ai.budgetUsd} /> : 'no budget set'}
          note={
            ai.budgetUsd ? (
              `${pct}% used`
            ) : (
              <Link to={tabHref('alerts')} className="underline">
                Set one under Alerts
              </Link>
            )
          }
        />
      </Figures>
      {ai.budgetUsd ? <BudgetBar percent={pct} label="Monthly AI budget" /> : null}

      <div className="grid gap-4 md:grid-cols-2">
        {ai.providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} />
        ))}
      </div>

      <SectionCard title="By provider" description="Who was paid this month, from the ledger.">
        <ProvidersTable rows={month.byProvider} />
      </SectionCard>
      <SectionCard
        title="By what spent it"
        description="Which task spent the money, rather than which vendor was paid."
      >
        <SourcesTable rows={month.bySource} />
        <Note>
          <Link to={USAGE_LEDGER_HREF} className="inline-flex items-center gap-1 underline">
            Open the full ledger, call by call{' '}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Link>
        </Note>
      </SectionCard>
    </div>
  );
}
