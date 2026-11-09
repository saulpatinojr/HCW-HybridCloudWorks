/**
 * Indexing — what Google says about each page in the site's sitemap.
 *
 * The server asks Google's URL Inspection API about every address in the live
 * sitemap and saves the answers. This tab shows the totals as tiles, how the
 * totals moved over past runs, and one row per page, with the pages that are
 * not indexed first. Under that, the "strays": pages Google shows in search
 * results that are not in the sitemap, so were not inspected.
 *
 * Google's answer is about its saved (indexed) copy of a page, not a live test.
 */
import React, { useMemo, useState } from 'react';
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ExternalLink, Search } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import { Input } from '@/components/ui/input';
import {
  VERDICTS,
  canonicalMismatch,
  fetchFailed,
  fetchStateLabel,
  fmtCount,
  pathOf,
  sortPages,
  utcText,
  verdictOf,
} from '@/lib/searchConsole';
import {
  ChipRow,
  Section,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
  TONE_TEXT,
  Tile,
  WhenText,
} from './shared';

/** The verdict chips, in the order of the tiles. */
const VERDICT_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'PASS', label: 'Indexed' },
  { value: 'NEUTRAL', label: 'Excluded' },
  { value: 'FAIL', label: 'Error' },
  { value: 'VERDICT_UNSPECIFIED', label: 'Unknown' },
];

/** The coverage states present on the pages, most common first. */
export function coverageOptions(pages) {
  const counts = new Map();
  for (const page of pages) {
    const key = page.coverageState || 'No status from Google';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [
    { value: 'all', label: 'All' },
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => ({ value: key, label: `${key} (${count})` })),
  ];
}

/** The pages left after the chips and the search box. */
export function filterPages(pages, { verdict, coverage, query }) {
  const needle = query.trim().toLowerCase();
  return pages.filter((page) => {
    if (verdict !== 'all' && verdictOf(page) !== verdict) return false;
    if (coverage !== 'all' && (page.coverageState || 'No status from Google') !== coverage) {
      return false;
    }
    if (!needle) return true;
    return [page.url, page.coverageState, fetchStateLabel(page.pageFetchState)]
      .filter(Boolean)
      .some((text) => String(text).toLowerCase().includes(needle));
  });
}

function IndexingTiles({ summary }) {
  return (
    <div className="grid auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-4">
      <Tile
        testId="tile-indexed"
        label="Indexed"
        value={fmtCount(summary.pass)}
        tone="ok"
        note="Google can show these in results"
      />
      <Tile
        testId="tile-excluded"
        label="Excluded"
        value={fmtCount(summary.neutral)}
        note="Google chose not to index"
      />
      <Tile
        testId="tile-error"
        label="Error"
        value={fmtCount(summary.fail)}
        tone={summary.fail ? 'bad' : null}
        note="Something stops Google indexing"
      />
      <Tile
        testId="tile-unknown"
        label="Unknown"
        value={fmtCount(summary.unknown)}
        tone={summary.unknown ? 'warn' : null}
        note="Google gave no verdict"
      />
    </div>
  );
}

/** A short date for the chart's axis ("Nov 9"), from an ISO instant, in UTC. */
const shortDay = (iso) => {
  const date = new Date(iso ?? '');
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(date);
};

/**
 * Indexed against not indexed for each past run, stacked like Google's own
 * Page indexing chart. "Not indexed" is excluded plus error.
 */
function HistoryChart({ history }) {
  if (history.length < 2) {
    return (
      <p className="text-xs text-muted-foreground">
        The chart appears after two runs. Each run (twice a day) adds one bar.
      </p>
    );
  }
  const data = history.map((row) => ({
    at: row.at,
    day: shortDay(row.at),
    indexed: Number(row.pass) || 0,
    notIndexed: (Number(row.neutral) || 0) + (Number(row.fail) || 0),
  }));
  return (
    <div className="h-40" role="img" aria-label="Indexed and not indexed pages over past runs">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
          <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={44} />
          <Tooltip
            labelFormatter={(_, payload) => utcText(payload?.[0]?.payload?.at) ?? ''}
            contentStyle={{ fontSize: 11 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="notIndexed" name="Not indexed" stackId="pages" fill="#94a3b8" />
          <Bar dataKey="indexed" name="Indexed" stackId="pages" fill="#10b981" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CanonicalCell({ page }) {
  if (!canonicalMismatch(page)) return <span className="text-muted-foreground">Matches</span>;
  return (
    <span
      className={`inline-flex items-start gap-1 ${TONE_TEXT.warn}`}
      title={`The page says: ${page.userCanonical}\nGoogle chose: ${page.googleCanonical}`}
    >
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span>
        Google chose a different address:{' '}
        <span className="font-mono">{pathOf(page.googleCanonical)}</span>
      </span>
    </span>
  );
}

function PageRow({ page }) {
  const verdict = VERDICTS[verdictOf(page)];
  const failedFetch = fetchFailed(page.pageFetchState);
  return (
    <tr data-testid="indexing-row" data-verdict={verdictOf(page)}>
      <td className={`${TD_CLASS} max-w-[18rem] break-all`}>
        <a
          href={page.url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-primary hover:underline"
        >
          {pathOf(page.url)}
        </a>
      </td>
      <td className={TD_CLASS}>
        <span className={`font-medium ${TONE_TEXT[verdict.tone]}`}>{verdict.label}</span>
        {page.coverageState ? (
          <span className="block text-muted-foreground">{page.coverageState}</span>
        ) : null}
        {page.error ? (
          <span className={`block ${TONE_TEXT.bad}`}>Could not inspect: {page.error}</span>
        ) : null}
      </td>
      <td className={`${TD_CLASS} ${failedFetch ? TONE_TEXT.bad : ''}`}>
        {fetchStateLabel(page.pageFetchState)}
      </td>
      <td className={TD_CLASS}>
        <WhenText iso={page.lastCrawlTime} fallback="Never crawled" stacked />
      </td>
      <td className={TD_CLASS}>
        <CanonicalCell page={page} />
      </td>
      <td className={TD_CLASS}>
        {page.inspectionResultLink ? (
          <a
            href={page.inspectionResultLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Inspect in Google
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function PagesTable({ pages }) {
  const [verdict, setVerdict] = useState('all');
  const [coverage, setCoverage] = useState('all');
  const [query, setQuery] = useState('');
  const sorted = useMemo(() => sortPages(pages), [pages]);
  const coverageChoices = useMemo(() => coverageOptions(pages), [pages]);
  const shown = filterPages(sorted, { verdict, coverage, query });

  if (pages.length === 0) {
    return (
      <EmptyState
        compact
        title="No pages were inspected in the last run."
        description="The run reads every address in the live sitemap. If the sitemap could not be read, the run has nothing to inspect."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <label htmlFor="search-console-pages-search" className="sr-only">
          Search inspected pages
        </label>
        <Input
          id="search-console-pages-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by address, Google status or fetch result"
          className="pl-9"
        />
      </div>
      <ChipRow label="Verdict" options={VERDICT_OPTIONS} value={verdict} onChange={setVerdict} />
      <ChipRow
        label="Google status"
        options={coverageChoices}
        value={coverage}
        onChange={setCoverage}
      />
      <p className="text-xs text-muted-foreground" role="status">
        {shown.length} of {pages.length} pages shown. Pages that are not indexed come first.
      </p>
      {shown.length === 0 ? (
        <EmptyState compact variant="filtered" title="No pages match the current filter." />
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} aria-label="Inspected pages">
            <thead>
              <tr>
                <th className={TH_CLASS}>Page</th>
                <th className={TH_CLASS}>Google status</th>
                <th className={TH_CLASS}>Fetch</th>
                <th className={TH_CLASS}>Last crawled</th>
                <th className={TH_CLASS}>Canonical</th>
                <th className={TH_CLASS}>
                  <span className="sr-only">Google link</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((page) => (
                <PageRow key={page.url} page={page} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StraysTable({ strays }) {
  if (strays.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        None: every page that showed up in Google results in the Performance tab&rsquo;s period is
        in the sitemap.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASS} aria-label="Pages Google shows that are not in the sitemap">
        <thead>
          <tr>
            <th className={TH_CLASS}>Page</th>
            <th className={`${TH_CLASS} text-right`}>Clicks</th>
            <th className={`${TH_CLASS} text-right`}>Impressions</th>
          </tr>
        </thead>
        <tbody>
          {strays.map((row) => (
            <tr key={row.url}>
              <td className={`${TD_CLASS} break-all`}>
                <a
                  href={row.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-primary hover:underline"
                >
                  {pathOf(row.url)}
                </a>
              </td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{fmtCount(row.clicks)}</td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{fmtCount(row.impressions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function IndexingTab({ report }) {
  const { summary, pages, strays, history } = report.indexing;
  return (
    <div className="space-y-4 pt-4">
      <IndexingTiles summary={summary} />
      <Section
        title="Over time"
        description="Indexed and not indexed pages at each run, for the sitemap pages this page inspects."
      >
        <HistoryChart history={history} />
      </Section>
      <Section
        title="Inspected pages"
        description="Google's answer for each page in the sitemap. This is Google's saved copy of the page, not a live test, so a fix shows here only after Google crawls the page again."
      >
        <PagesTable pages={pages} />
      </Section>
      <Section
        title="Pages Google shows that are not in the sitemap"
        description="Addresses on hybridcloudworks.com that appeared in Google results in the Performance tab’s period but are not listed in the sitemap, so this page does not inspect them."
      >
        <StraysTable strays={strays} />
      </Section>
    </div>
  );
}
