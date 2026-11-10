/**
 * Indexing — what Google says about each page of the site.
 *
 * The server asks Google's URL Inspection API about every address in the live
 * sitemap, then about up to 150 "strays" (pages on hybridcloudworks.com or a
 * subdomain that Google shows in search results but the sitemap does not
 * list), and saves the answers. This tab shows the totals as tiles, how the
 * totals moved over past runs, and one row per page, with the pages that are
 * not indexed first, each saying its host and where it came from. Under that,
 * the full list of strays with their search figures.
 *
 * Google's answer is about its saved (indexed) copy of a page, not a live test.
 */
import React, { useMemo, useState } from 'react';
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ExternalLink, Search } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import { Input } from '@/components/ui/input';
import {
  SOURCES,
  VERDICTS,
  canonicalMismatch,
  fetchFailed,
  fetchStateLabel,
  fmtCount,
  inspectionHref,
  pageLabel,
  sitePageHref,
  sortPages,
  sourceOf,
  utcText,
  verdictOf,
} from '@/lib/searchConsole';
import {
  ChipRow,
  Section,
  Breakable,
  NOWRAP_CELL_CLASS,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
  URL_CELL_CLASS,
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

/** What the host chips call a page whose address has no host on the site. */
const NO_HOST = 'Other address';

/** The hosts present on the pages, most pages first, then by name. */
export function hostOptions(pages) {
  const counts = new Map();
  for (const page of pages) {
    const key = page.host || NO_HOST;
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
export function filterPages(pages, { verdict, coverage, host = 'all', query }) {
  const needle = query.trim().toLowerCase();
  return pages.filter((page) => {
    if (verdict !== 'all' && verdictOf(page) !== verdict) return false;
    if (coverage !== 'all' && (page.coverageState || 'No status from Google') !== coverage) {
      return false;
    }
    if (host !== 'all' && (page.host || NO_HOST) !== host) return false;
    if (!needle) return true;
    return [
      page.url,
      page.coverageState,
      fetchStateLabel(page.pageFetchState),
      SOURCES[sourceOf(page)].label,
    ]
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
        <span className="font-mono">{pageLabel(page.googleCanonical)}</span>
      </span>
    </span>
  );
}

/**
 * The small marker on a page whose answer is from an earlier run: this run
 * could not ask Google again (the page's error line says why).
 */
function StaleMarker({ page }) {
  const when = utcText(page.inspectedAt);
  return (
    <span
      data-testid="stale-marker"
      className="ml-1.5 inline-block rounded border border-amber-300 px-1 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:border-amber-800 dark:text-amber-300"
      title={
        when
          ? `This answer is from an earlier run (${when}); the last run could not ask Google again.`
          : 'This answer is from an earlier run; the last run could not ask Google again.'
      }
    >
      stale
    </span>
  );
}

/**
 * Why a page has no fresh answer. On a stale page it is a plain note (the
 * answer shown is still Google's, from an earlier run); on a page with no
 * answer at all it is the failure.
 */
function PageError({ page }) {
  if (!page.error) return null;
  if (page.stale) return <span className="block text-muted-foreground">{page.error}</span>;
  return <span className={`block ${TONE_TEXT.bad}`}>Could not inspect: {page.error}</span>;
}

function PageRow({ page }) {
  const verdict = VERDICTS[verdictOf(page)];
  const failedFetch = fetchFailed(page.pageFetchState);
  const pageHref = sitePageHref(page.url);
  const googleHref = inspectionHref(page.inspectionResultLink);
  const source = SOURCES[sourceOf(page)];
  return (
    <tr
      data-testid="indexing-row"
      data-verdict={verdictOf(page)}
      data-stale={page.stale ? 'true' : 'false'}
      data-source={sourceOf(page)}
    >
      <td className={`${TD_CLASS} ${URL_CELL_CLASS} max-w-[24rem]`}>
        {pageHref ? (
          <a
            href={pageHref}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-primary hover:underline"
          >
            <Breakable text={pageLabel(page.url)} />
          </a>
        ) : (
          <span className="font-mono">
            <Breakable text={page.url} />
          </span>
        )}
      </td>
      <td
        className={`${TD_CLASS} ${NOWRAP_CELL_CLASS}`}
        data-testid="indexing-source"
        title={source.note}
      >
        {source.label}
      </td>
      <td className={`${TD_CLASS} min-w-[8rem]`}>
        <span className={`font-medium ${TONE_TEXT[verdict.tone]}`}>{verdict.label}</span>
        {page.stale ? <StaleMarker page={page} /> : null}
        {page.coverageState ? (
          <span className="block text-muted-foreground">{page.coverageState}</span>
        ) : null}
        <PageError page={page} />
      </td>
      <td className={`${TD_CLASS} ${failedFetch ? TONE_TEXT.bad : ''}`}>
        {fetchStateLabel(page.pageFetchState)}
      </td>
      <td className={`${TD_CLASS} ${NOWRAP_CELL_CLASS}`}>
        <WhenText iso={page.lastCrawlTime} fallback="Never crawled" stacked />
      </td>
      <td className={`${TD_CLASS} min-w-[8rem]`}>
        <CanonicalCell page={page} />
      </td>
      <td className={`${TD_CLASS} ${NOWRAP_CELL_CLASS}`}>
        {googleHref ? (
          <a
            href={googleHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Inspect in Google"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            {/* "Inspect" on screen keeps the column narrow; aria-label gives the full name. */}
            Inspect
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
  const [host, setHost] = useState('all');
  const [query, setQuery] = useState('');
  const sorted = useMemo(() => sortPages(pages), [pages]);
  const coverageChoices = useMemo(() => coverageOptions(pages), [pages]);
  const hostChoices = useMemo(() => hostOptions(pages), [pages]);
  const shown = filterPages(sorted, { verdict, coverage, host, query });

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
          placeholder="Search by address, Google status, fetch result or source"
          className="pl-9"
        />
      </div>
      <ChipRow label="Verdict" options={VERDICT_OPTIONS} value={verdict} onChange={setVerdict} />
      <ChipRow label="Host" options={hostChoices} value={host} onChange={setHost} />
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
                <th className={TH_CLASS}>Source</th>
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
              <td className={`${TD_CLASS} ${URL_CELL_CLASS}`}>
                {sitePageHref(row.url) ? (
                  <a
                    href={sitePageHref(row.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-primary hover:underline"
                  >
                    <Breakable text={pageLabel(row.url)} />
                  </a>
                ) : (
                  <span className="font-mono">
                    <Breakable text={row.url} />
                  </span>
                )}
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
        description="Indexed and not indexed pages at each run, for the pages this page inspects."
      >
        <HistoryChart history={history} />
      </Section>
      <Section
        title="Inspected pages"
        description="Google's answer for each page in the sitemap, and for up to 150 pages found in search that the sitemap does not list, on hybridcloudworks.com and its subdomains. This is Google's saved copy of the page, not a live test, so a fix shows here only after Google crawls the page again."
      >
        <PagesTable pages={pages} />
      </Section>
      <Section
        title="Pages Google shows that are not in the sitemap"
        description="Addresses on hybridcloudworks.com and its subdomains that appeared in Google results in the Performance tab’s period but are not listed in the sitemap. The 150 with the most impressions are inspected too, and appear above as Found in search."
      >
        <StraysTable strays={strays} />
      </Section>
    </div>
  );
}
