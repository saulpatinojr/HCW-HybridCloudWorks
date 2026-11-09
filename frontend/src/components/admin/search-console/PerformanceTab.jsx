/**
 * Performance — how people find the site in Google Search, from Google's
 * Search Analytics API: clicks (someone opened the site from a result),
 * impressions (the site was shown in a result), CTR (clicks divided by
 * impressions) and average position (1 is the top of the first page).
 *
 * The totals cover about three months, with the last 28 days under each;
 * a daily line chart; and one table per breakdown (queries, pages,
 * countries, devices, search appearance).
 */
import React, { useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import EmptyState from '@/components/admin/shared/EmptyState';
import HubTabs from '@/components/admin/HubTabs';
import { Button } from '@/components/ui/button';
import {
  countryLabel,
  deviceLabel,
  fmtCount,
  fmtCtr,
  fmtPosition,
  pathOf,
  sortBreakdown,
} from '@/lib/searchConsole';
import { Section, TABLE_CLASS, TD_CLASS, TH_CLASS, Tile } from './shared';

/** Rows of a breakdown table shown before "Show all". */
export const BREAKDOWN_ROWS = 25;

/** The breakdowns, each with its column heading and how its key is shown. */
export const BREAKDOWNS = Object.freeze([
  { id: 'queries', label: 'Queries', heading: 'Search words', show: (key) => key },
  {
    id: 'pages',
    label: 'Pages',
    heading: 'Page',
    show: (key) => <span className="font-mono">{pathOf(key)}</span>,
  },
  { id: 'countries', label: 'Countries', heading: 'Country', show: countryLabel },
  { id: 'devices', label: 'Devices', heading: 'Device', show: deviceLabel },
  {
    id: 'searchAppearance',
    label: 'Search appearance',
    heading: 'Result type',
    show: (key) => <span className="font-mono">{key}</span>,
  },
]);

/** "Last 28 days: 12" under a tile. */
const last28 = (text) => `Last 28 days: ${text}`;

function TotalsTiles({ totals, totals28d }) {
  return (
    <div className="grid auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-4">
      <Tile
        testId="tile-clicks"
        label="Total clicks"
        value={fmtCount(totals.clicks)}
        note={last28(fmtCount(totals28d.clicks))}
      />
      <Tile
        testId="tile-impressions"
        label="Total impressions"
        value={fmtCount(totals.impressions)}
        note={last28(fmtCount(totals28d.impressions))}
      />
      <Tile
        testId="tile-ctr"
        label="Average CTR"
        value={fmtCtr(totals.ctr)}
        note={last28(fmtCtr(totals28d.ctr))}
      />
      <Tile
        testId="tile-position"
        label="Average position"
        value={fmtPosition(totals.position)}
        note={last28(fmtPosition(totals28d.position))}
      />
    </div>
  );
}

/** Clicks on the left axis and impressions on the right, one point a day. */
function DailyChart({ daily }) {
  if (daily.length === 0) {
    return <p className="text-xs text-muted-foreground">No daily figures from Google yet.</p>;
  }
  const data = daily.map((row) => ({
    date: row.date,
    clicks: Number(row.clicks) || 0,
    impressions: Number(row.impressions) || 0,
  }));
  return (
    <div className="h-56" role="img" aria-label="Clicks and impressions per day">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
          <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis yAxisId="clicks" tick={{ fontSize: 10 }} allowDecimals={false} width={44} />
          <YAxis
            yAxisId="impressions"
            orientation="right"
            tick={{ fontSize: 10 }}
            allowDecimals={false}
            width={52}
          />
          <Tooltip contentStyle={{ fontSize: 11 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            yAxisId="clicks"
            type="monotone"
            dataKey="clicks"
            name="Clicks (left)"
            stroke="#2563eb"
            dot={false}
            strokeWidth={2}
          />
          <Line
            yAxisId="impressions"
            type="monotone"
            dataKey="impressions"
            name="Impressions (right)"
            stroke="#7c3aed"
            dot={false}
            strokeWidth={2}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BreakdownTable({ breakdown, rows }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = sortBreakdown(rows);
  if (sorted.length === 0) {
    return (
      <EmptyState
        compact
        title={`No ${breakdown.label.toLowerCase()} from Google for this period.`}
        description="Google leaves out rows with very few searches to protect searchers' privacy, so a small site can have none here."
      />
    );
  }
  const shown = showAll ? sorted : sorted.slice(0, BREAKDOWN_ROWS);
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table
          className={TABLE_CLASS}
          aria-label={`Performance by ${breakdown.label.toLowerCase()}`}
        >
          <thead>
            <tr>
              <th className={TH_CLASS}>{breakdown.heading}</th>
              <th className={`${TH_CLASS} text-right`}>Clicks</th>
              <th className={`${TH_CLASS} text-right`}>Impressions</th>
              <th className={`${TH_CLASS} text-right`}>CTR</th>
              <th className={`${TH_CLASS} text-right`}>Position</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={`${row.key}-${index}`}>
                <td className={`${TD_CLASS} break-all`}>{breakdown.show(row.key)}</td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>{fmtCount(row.clicks)}</td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>
                  {fmtCount(row.impressions)}
                </td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>{fmtCtr(row.ctr)}</td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>
                  {fmtPosition(row.position)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > BREAKDOWN_ROWS ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${sorted.length}`}
        </Button>
      ) : null}
    </div>
  );
}

export default function PerformanceTab({ report }) {
  const { range, totals, totals28d, daily } = report.performance;
  const [active, setActive] = useState(BREAKDOWNS[0].id);
  const breakdown = BREAKDOWNS.find((b) => b.id === active) ?? BREAKDOWNS[0];
  const period =
    range.startDate && range.endDate
      ? `${range.startDate} to ${range.endDate}`
      : 'the last 3 months';
  return (
    <div className="space-y-4 pt-4">
      <p className="text-xs text-muted-foreground">
        Totals for {period}. Google&rsquo;s figures arrive two to three days late, so the newest
        days can look low.
      </p>
      <TotalsTiles totals={totals} totals28d={totals28d} />
      <Section title="Clicks and impressions per day">
        <DailyChart daily={daily} />
      </Section>
      <Section
        title="Breakdown"
        description="CTR is the share of impressions that became a click. Position is the average place in Google's results, where 1 is the top."
      >
        <HubTabs
          tabs={BREAKDOWNS}
          active={breakdown.id}
          onSelect={setActive}
          idPrefix="search-console-breakdown"
          label="Performance breakdown"
        >
          <div className="pt-3">
            <BreakdownTable
              key={breakdown.id}
              breakdown={breakdown}
              rows={report.performance[breakdown.id]}
            />
          </div>
        </HubTabs>
      </Section>
    </div>
  );
}
