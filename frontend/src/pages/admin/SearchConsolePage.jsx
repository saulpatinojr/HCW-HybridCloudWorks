/**
 * Search Console (route `/admin/search-console`, #1612) — what Google Search
 * knows about the public site, so the owner does not have to open Google's
 * Search Console or wait for its emails.
 *
 *   Indexing     Google's answer for every page in the sitemap (indexed or
 *                not, and why), how that moved over past runs, and pages
 *                Google shows that are not in the sitemap
 *   Performance  clicks, impressions, CTR and position for about three
 *                months, per day, and by query, page, country, device and
 *                result type
 *   Sitemaps     the sitemaps Google has, and whether it could read them
 *
 * A server timer asks Google at 00:10 and 12:10 UTC and saves one report; the
 * page reads that report (`GET cms/search-console`) and hands it to every
 * tab. Run now queues a fresh run (`POST cms/search-console/run`). The
 * server signs in to Google without a stored key; until the owner finishes
 * that setup the report says `not_configured` and the page says what to do.
 *
 * Deep links are `?tab=`; an unknown or guessed id lands where its content is
 * (lib/searchConsole.js resolveTab).
 */
import React from 'react';
import { useSearchParams } from 'react-router';
import {
  AlertTriangle,
  ExternalLink,
  Info,
  Loader2,
  Play,
  SearchCheck,
  Settings2,
} from 'lucide-react';
import PageHeader from '@/components/admin/shared/PageHeader';
import EmptyState from '@/components/admin/shared/EmptyState';
import HubTabs from '@/components/admin/HubTabs';
import RoleGate from '@/components/admin/RoleGate';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import IndexingTab from '@/components/admin/search-console/IndexingTab';
import PerformanceTab from '@/components/admin/search-console/PerformanceTab';
import SitemapsTab from '@/components/admin/search-console/SitemapsTab';
import { WhenText } from '@/components/admin/search-console/shared';
import useSearchConsole from '@/components/admin/search-console/useSearchConsole';
import {
  NOT_AVAILABLE_WORDS,
  SEARCH_CONSOLE_API_REFERENCE_URL,
  SEARCH_CONSOLE_RUNBOOK_URL,
  SEARCH_CONSOLE_URL,
  TABS,
  fmtCount,
  resolveTab,
} from '@/lib/searchConsole';

const HELP = [
  'This page shows what Google Search knows about the public site (hybridcloudworks.com): which pages Google has indexed, how people find the site in Google, and the sitemaps Google has read.',
  'The server asks Google twice a day, at 00:10 and 12:10 UTC, which is 6:10 PM and 6:10 AM Central Standard Time (7:10 PM and 7:10 AM Central Daylight Time, in summer). Run now asks straight away; a run takes a few minutes and the page updates when it lands.',
  'Indexing inspects every page in the sitemap one by one. Google answers from its saved copy of each page, not a live test, so a fix shows here only after Google crawls the page again. Pages that are not indexed are listed first.',
  'Performance is clicks (someone opened the site from a Google result), impressions (the site was shown in a result), CTR (the share of impressions that became a click) and average position (1 is the top of the first page).',
  'Some Search Console screens have no API, so they cannot be shown here; the note at the bottom says which, with a link to open them in Google.',
];

const PANELS = {
  indexing: IndexingTab,
  performance: PerformanceTab,
  sitemaps: SitemapsTab,
};

/** Link to Google's own Search Console, used in the header and the notes. */
function OpenInGoogle({ children = 'Open Search Console' }) {
  return (
    <a
      href={SEARCH_CONSOLE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      {children}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}

function RunNowButton({ runNow, starting, waiting }) {
  return (
    <RoleGate minRole="editor" reason="Starting a run needs the editor role.">
      <Button type="button" size="sm" onClick={runNow} disabled={starting || waiting}>
        {starting || waiting ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        )}
        {waiting ? 'Run in progress' : 'Run now'}
      </Button>
    </RoleGate>
  );
}

/** The status line under the title: when the last run finished, and what it covered. */
function LastRunLine({ report }) {
  if (!report || report.status === 'not_configured' || report.status === 'never_run') return null;
  const { run } = report;
  const at = run?.finishedAt ?? report.generatedAt;
  return (
    <span className="text-muted-foreground" data-testid="last-run">
      Last run: <WhenText iso={at} fallback="time not recorded" />
      {run ? (
        <>
          {' · '}
          {fmtCount(run.inspected)} pages inspected, {fmtCount(run.failed)} could not be inspected
          {run.stale ? `, ${fmtCount(run.stale)} kept from an earlier run` : null}
        </>
      ) : null}
    </span>
  );
}

/**
 * What the last run said. A failed run is a warning; a run that worked can
 * still have something to say (a page cap, a spent daily allowance, a query
 * that failed and kept its last figures), shown as information.
 */
function RunMessage({ report }) {
  if (report.status === 'error') {
    return (
      <p
        role="alert"
        className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          The last run failed: {report.run?.message || 'the server gave no reason.'} The figures
          below are from the last run that worked, if there was one.
        </span>
      </p>
    );
  }
  if (!report.run?.message) return null;
  return (
    <p
      role="status"
      data-testid="run-note"
      className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>Note from the last run: {report.run.message}</span>
    </p>
  );
}

function NotAvailableNote({ items }) {
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Not available from Google&rsquo;s API</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {items.map((item) => (
            <li key={item}>
              <span className="font-medium text-foreground">{item}.</span>{' '}
              {NOT_AVAILABLE_WORDS[item] ?? 'Google does not offer this through its API.'}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          <OpenInGoogle>Open these in Search Console</OpenInGoogle>. What the API does offer is
          listed in{' '}
          <a
            href={SEARCH_CONSOLE_API_REFERENCE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Google&rsquo;s API reference
          </a>
          .
        </p>
      </CardContent>
    </Card>
  );
}

export default function SearchConsolePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const { report, error, refresh, runNow, starting, waiting } = useSearchConsole();

  const setTab = (id) => {
    if (id !== activeTab) setSearchParams({ tab: id });
  };

  const runButton = <RunNowButton runNow={runNow} starting={starting} waiting={waiting} />;
  const configured = report && report.status !== 'not_configured';

  let body;
  if (error && !report) {
    body = (
      <EmptyState
        variant="error"
        title="The Search Console report could not be read"
        description={error}
        onRetry={() => refresh()}
      />
    );
  } else if (!report) {
    body = (
      <div
        className="flex justify-center py-12"
        role="status"
        aria-label="Reading the Search Console report"
      >
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  } else if (report.status === 'not_configured') {
    body = (
      <EmptyState
        icon={Settings2}
        title="Google sign-in is not set up yet"
        description="The site signs in to Google with its own Azure identity, without a stored key, and that link has not been set up. Until it is, the twice-daily run does nothing. The runbook has the owner's steps."
        action={
          <a
            href={SEARCH_CONSOLE_RUNBOOK_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            Open the Search Console runbook
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        }
      />
    );
  } else if (report.status === 'never_run') {
    body = (
      <EmptyState
        title="Google has not been asked yet"
        description="The sign-in is set up, but no run has finished. The next scheduled run is at 00:10 or 12:10 UTC, whichever comes first, or start one now."
        action={runButton}
      />
    );
  } else {
    const ActivePanel = PANELS[activeTab];
    body = (
      <div className="space-y-6">
        <RunMessage report={report} />
        <HubTabs
          tabs={TABS}
          active={activeTab}
          onSelect={setTab}
          idPrefix="search-console"
          label="Search Console"
        >
          <ActivePanel report={report} />
        </HubTabs>
        <NotAvailableNote items={report.notAvailable} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={SearchCheck}
        help={HELP}
        status={<LastRunLine report={report} />}
        actions={
          <>
            <OpenInGoogle />
            {configured && report.status !== 'never_run' ? runButton : null}
          </>
        }
      />
      {body}
    </div>
  );
}
