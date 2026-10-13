/**
 * Stats — the show's statistics, read from Podbean (#1115).
 *
 * Downloads by day or month over a chosen range, where listeners are, what
 * they listen on and through, how cohorts come back, and the audience
 * counts. One read (`useHostStats`), cached an hour per range on the server,
 * with a Refresh that reads live.
 *
 * Each section is independent on the server and stays so here: a section
 * whose read failed shows its own sentence in place, and the others render.
 * The chart is recharts, the one charting library the admin already carries
 * (AI Engine → Usage), in the same bar-chart shape.
 *
 * Admin page: Podbean is named. The public pages never are (vendor-guard
 * tests), and nothing here reaches them.
 */
import React, { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Loader2, RefreshCw } from 'lucide-react';
import { fmtWhen } from './recordingView';
import {
  AUDIENCE_ROWS,
  DEFAULT_RANGE,
  RANGES,
  countryName,
  downloadSeries,
  fmtSeconds,
  hasAnyData,
  rankedShares,
  retentionRows,
} from './statsView';
import useHostStats from './useHostStats';

/** The range buttons; `aria-pressed` carries the selection for a screen reader. */
function RangePicker({ range, onChange, disabled }) {
  return (
    <div className="inline-flex gap-1" role="group" aria-label="Range">
      {RANGES.map((option) => (
        <Button
          key={option.id}
          size="sm"
          variant={option.id === range ? 'default' : 'outline'}
          className="h-7 text-xs px-2"
          aria-pressed={option.id === range}
          onClick={() => onChange(option.id)}
          disabled={disabled}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** A section's own failure, in place of its figures. */
function SectionError({ error }) {
  if (!error) return null;
  return (
    <p className="text-xs text-amber-700 dark:text-amber-300">
      Could not read this from Podbean: {error.message}
    </p>
  );
}

/** A name → count map as a ranked list with the share of the total. */
function RankedList({ title, map, error, nameOf = (name) => name }) {
  const rows = rankedShares(map);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <SectionError error={error} />
        {!error && rows.length === 0 && <p className="text-xs text-slate-400">Nothing yet.</p>}
        {rows.length > 0 && (
          <ol className="space-y-1 text-xs" aria-label={title}>
            {rows.map((row) => (
              <li key={row.name} className="space-y-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate">
                    {row.name === 'Other' && row.others
                      ? `Other (${row.others} more)`
                      : nameOf(row.name)}
                  </span>
                  <span className="shrink-0 text-slate-500">
                    {row.count.toLocaleString()} · {row.share}%
                  </span>
                </div>
                <div className="h-1 rounded bg-slate-200 dark:bg-slate-700" aria-hidden="true">
                  <div
                    className="h-1 rounded bg-indigo-500"
                    style={{ width: `${Math.max(row.share, 1)}%` }}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/** Downloads over the window: the total and a bar per day or month. */
function DownloadsCard({ data }) {
  const series = downloadSeries(data.downloads?.byPeriod, data.window);
  const total = data.downloads?.total;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Downloads</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <SectionError error={data.errors?.downloads} />
        {typeof total === 'number' && (
          <p className="text-lg font-bold" aria-label="Total downloads">
            {total.toLocaleString()}
            <span className="text-xs font-normal text-slate-500">
              {' '}
              over {RANGES.find((option) => option.id === data.range)?.label || data.range}
            </span>
          </p>
        )}
        {series.length > 0 && (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={series} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={16} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                formatter={(value) => [value, 'Downloads']}
                contentStyle={{ fontSize: 11 }}
              />
              <Bar dataKey="count" fill="#6366f1" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

/** How each monthly cohort came back, as a small table. */
function RetentionCard({ retention, error }) {
  const rows = retentionRows(retention);
  if (!error && rows.length === 0) return null;
  const width = rows.reduce((max, row) => Math.max(max, row.points.length), 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Listener retention</CardTitle>
      </CardHeader>
      <CardContent>
        <SectionError error={error} />
        {rows.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 pr-2 font-medium">Cohort</th>
                <th className="py-1 pr-2 font-medium">Listeners</th>
                {Array.from({ length: width }, (_, i) => (
                  <th key={i} className="py-1 pr-2 font-medium">
                    +{i}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.cohort} className="border-t">
                  <td className="py-1 pr-2">{row.cohort}</td>
                  <td className="py-1 pr-2">{row.listeners.toLocaleString()}</td>
                  {Array.from({ length: width }, (_, i) => (
                    <td key={i} className="py-1 pr-2 text-slate-600 dark:text-slate-300">
                      {row.points[i]?.retentionPct === null || row.points[i] === undefined
                        ? '–'
                        : `${row.points[i].retentionPct}%`}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

/** Followers, likes, comments and the catalogue's length, as four tiles. */
function AudienceCard({ audience, error }) {
  const tiles = AUDIENCE_ROWS.map(({ key, label }) => ({
    label,
    value: typeof audience?.[key] === 'number' ? audience[key].toLocaleString() : '–',
  }));
  tiles.push({
    label: 'Total episode length',
    value: fmtSeconds(audience?.totalEpisodeLengthSeconds) || '–',
  });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Audience</CardTitle>
      </CardHeader>
      <CardContent>
        <SectionError error={error} />
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {tiles.map((tile) => (
            <div key={tile.label}>
              <dt className="text-xs text-slate-500">{tile.label}</dt>
              <dd className="text-lg font-bold">{tile.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** When Podbean was last read for this range, and the Refresh. */
function FetchedLine({ data, loading, onRefresh }) {
  return (
    <p className="text-xs text-slate-500 flex items-center gap-2 flex-wrap" role="status">
      <span>
        Podbean read {fmtWhen(data.fetchedAt) || 'just now'}
        {data.cached ? ' (cached)' : ''}.
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 text-xs px-2"
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh from Podbean"
      >
        {loading ? (
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
        ) : (
          <RefreshCw className="h-3 w-3 mr-1" />
        )}
        Refresh
      </Button>
    </p>
  );
}

/** The figures, once a configured read has answered. */
function Figures({ data }) {
  if (!hasAnyData(data)) {
    return (
      <p className="text-sm text-slate-400 py-6 text-center" role="status">
        No data yet: Podbean has recorded no downloads for this range.
      </p>
    );
  }
  return (
    <>
      <DownloadsCard data={data} />
      <div className="grid gap-3 md:grid-cols-3">
        <RankedList
          title="Top countries"
          map={data.countries}
          error={data.errors?.countries}
          nameOf={countryName}
        />
        <RankedList title="Platforms" map={data.platforms} error={data.errors?.platforms} />
        <RankedList title="Sources" map={data.sources} error={data.errors?.sources} />
      </div>
      <RetentionCard retention={data.retention} error={data.errors?.retention} />
      <AudienceCard audience={data.audience} error={data.errors?.audience} />
    </>
  );
}

/** Spinner, alert, not-configured sentence, or the figures. */
function Body({ stats }) {
  const { data, loading, error } = stats;
  if (error) {
    return (
      <p className="text-xs text-red-700 dark:text-red-300" role="alert">
        Could not read Podbean: {error}
      </p>
    );
  }
  if (!data) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }
  if (data.configured === false) {
    return (
      <p className="text-xs text-slate-500" role="status">
        {data.reason || 'Podbean is not configured, so there are no statistics to show.'}
      </p>
    );
  }
  return (
    <>
      <FetchedLine data={data} loading={loading} onRefresh={stats.refresh} />
      <Figures data={data} />
    </>
  );
}

export default function StatsTab() {
  const { authReady } = useAuthReady();
  const [range, setRange] = useState(DEFAULT_RANGE);
  const stats = useHostStats(authReady, range);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold text-sm">Podbean statistics</h3>
          <p className="text-xs text-slate-500">
            Downloads, where listeners are, what they listen on and through, retention and the
            audience counts. Podbean counts up to yesterday.
          </p>
        </div>
        <RangePicker range={range} onChange={setRange} disabled={stats.loading} />
      </div>
      <Body stats={stats} />
    </div>
  );
}
