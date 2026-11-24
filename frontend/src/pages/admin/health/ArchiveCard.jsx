/**
 * Archive — where the yearly content archive stands, and its dry run
 * (ADR 0046, #1811).
 *
 * The archive is a long-term copy of the site's content, made once a year
 * from the weekly database backup, with personal details and secrets taken
 * out first. This card reads `GET cms/content-archive` and shows: whether
 * the switch is on, whether an archive could start today and what stands in
 * the way, the last archive that was written (year, when, files, records,
 * size), an archive that is being written now and what it still lacks, and
 * the newest dry-run report. Nothing on this card starts an archive: it
 * starts by itself once a year when the switch is on. The Dry run button
 * (`POST cms/content-archive/dry-run`) makes the server read the newest
 * weekly backup and count what an archive would keep, change and leave out.
 * A dry run writes no archive and changes no record.
 *
 * For every container it read, the report lists the common, plain names of
 * its top-level fields, and counts the records that carry a field whose name
 * looks like a secret or someone's contact details. The containers nobody
 * has classified yet are shown first, so the owner can say what each one is.
 * It never shows a record or a value; the server does not send one.
 *
 * Both routes are super_admin, so below that role the card is not drawn.
 */
import React, { useCallback, useState } from 'react';
import { Archive, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { useAuthReady } from '@/hooks/useAuthReady';
import { useAdminRole } from '@/hooks/useAdminRole';
import { satisfiesRole } from '@/config/adminNav';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { getJSON, postJSON } from '@/lib/api';
import { refusalSentence, utcMinute } from './SentAlertsCard';

export const ARCHIVE_STATUS_ROUTE = 'cms/content-archive';
export const ARCHIVE_DRY_RUN_ROUTE = 'cms/content-archive/dry-run';
/** The role both routes need; below it the card is not drawn. */
export const ARCHIVE_ROLE = 'super_admin';
export const ARCHIVE_RUNBOOK_URL = 'https://docs.hybridcloudworks.com/runbooks/content-archive/';

/** Each thing that can stand in the way of an archive starting, in plain words. */
const BLOCKERS = Object.freeze({
  'switch-off': 'the switch is off',
  'export-off':
    'the nightly export is off (the archive is made from its weekly backup, and its timer makes the daily check)',
  'before-1-february': 'it is still January, the month of grace',
  'already-archived': 'that year is already archived',
  'archive-container-missing':
    'the archive’s storage container does not exist yet (the Terraform run that creates it has not been confirmed)',
  'archive-not-readable': 'the archive’s storage container could not be read just now',
  'no-backup': 'no complete weekly full backup was found in the last 35 days',
  'backup-too-early': 'the newest complete weekly backup is from before 2 February',
});

/** Why a record or a container is left out, in plain words. */
const REASONS = Object.freeze({
  promise: 'a promise limits keeping it',
  secret: 'it is a secret',
  'access-list': 'it is the access list',
  derived: 'a job rebuilds it',
  'working-state': 'short-lived working state',
  unclassified: 'not classified yet',
  unlisted: 'a document the list does not name',
  orphan: 'its content item is not in the backup',
});

export const blockerSentence = (blockers = []) =>
  blockers.map((code) => BLOCKERS[code] || code).join('; ');

export const reasonWords = (leftOutBy = {}) =>
  Object.entries(leftOutBy)
    .map(([reason, n]) => `${n} ${REASONS[reason] || reason}`)
    .join(', ');

/**
 * true: written; false: not written; anything else: not known. A container
 * that does not exist yet is "not known", never "not written": nothing was
 * looked at, so nothing can be said about the year.
 */
export function yearState(archived, containerExists) {
  if (containerExists === false) return 'Not known: no container yet';
  if (archived === true) return 'Written';
  if (archived === false) return 'Not written';
  return 'Not known';
}

const number = (value) => (Number.isFinite(value) ? value.toLocaleString('en-US') : '0');

/** A size in plain words: "512 bytes", "1.5 MB". */
export function sizeWords(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown size';
  if (bytes < 1024) return `${number(bytes)} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** The field names of one container, as a sentence. Nothing when the report listed none. */
function FieldNames({ part }) {
  const names = part.fieldNames || [];
  if (!names.length && !part.otherNames) return null;
  return (
    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
      {names.length ? (
        <>
          Fields: <span className="font-mono">{names.map((field) => field.name).join(', ')}</span>
        </>
      ) : (
        'No field name is common and plain enough to show.'
      )}
      {part.fieldNamesTruncated ? ' (and more; only the 100 most common are listed)' : ''}
      {part.otherNames
        ? ` (${number(part.otherNames)} more uses of names that are not shown: too rare, or shaped like an id or typed text)`
        : ''}
    </p>
  );
}

/**
 * "3 records have a field named like a secret: apiKey, token". Names only;
 * the server never sends a value.
 */
export function sensitiveSentence(sensitive) {
  if (!sensitive?.records) return '';
  const names = (sensitive.names || []).map((field) => field.name);
  const hidden = sensitive.namesNotShown
    ? `${names.length ? ', and ' : ''}${number(sensitive.namesNotShown)} not shown`
    : '';
  const kept =
    sensitive.keptRecords > 0
      ? ` ${number(sensitive.keptRecords)} of them would still carry one in the archive.`
      : ' None of those names would be in the archive.';
  return `${number(sensitive.records)} record(s) have a field named like a secret or contact details: ${names.join(', ')}${hidden}.${kept}`;
}

function SensitiveLine({ part }) {
  const sentence = sensitiveSentence(part.sensitive);
  if (!sentence) return null;
  return (
    <p
      className={`text-xs [overflow-wrap:anywhere] ${part.sensitive.keptRecords > 0 ? 'text-destructive' : 'text-muted-foreground'}`}
      data-testid="archive-sensitive"
    >
      {sentence}
    </p>
  );
}

/** One unclassified container: its count, the names of its fields, and any that look sensitive. */
function UnclassifiedRow({ part }) {
  return (
    <li className="border-b border-border/60 py-2 last:border-0" data-testid="archive-unclassified">
      <p className="text-sm">
        <span className="font-mono">{part.container}</span>
        <span className="text-muted-foreground">
          {part.inBackup === false ? ': not in the backup' : `: ${number(part.read)} records`}
        </span>
      </p>
      <FieldNames part={part} />
      <SensitiveLine part={part} />
    </li>
  );
}

/**
 * The archive itself: one being written now, the last one written, or that
 * none has been. Numbers, dates and container names only.
 */
function ArchiveProgress({ status }) {
  if (status.progressKnown === false) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="archive-progress-unknown">
        Whether an archive has been written, or is being written, could not be read just now.
      </p>
    );
  }
  const { run, lastArchive: last } = status;
  const parts = [];
  if (run) {
    const missing = Array.isArray(run.missing) ? run.missing : [];
    parts.push(
      run.late ? (
        <p
          key="run"
          className="text-sm text-destructive"
          role="status"
          data-testid="archive-run-late"
        >
          The archive of {run.year} started {utcMinute(run.startedAt) || 'at an unrecorded time'}{' '}
          and is not finished: {run.done} of {run.expected} files are written and checked.
          {missing.length ? (
            <>
              {' '}
              Missing: <span className="font-mono">{missing.join(', ')}</span>.
            </>
          ) : null}{' '}
          Nothing has been moved to the Archive tier, so every file can still be replaced. The daily
          check at 03:00 UTC queues the missing ones again; the runbook says what to do if it stays
          like this.
        </p>
      ) : (
        <p
          key="run"
          className="text-sm text-muted-foreground"
          role="status"
          data-testid="archive-run"
        >
          The archive of {run.year} is being written from the weekly backup of{' '}
          {run.sourceRun || 'an unknown date'}: {run.done} of {run.expected} files are written and
          checked. Press the refresh button in a few minutes.
        </p>
      )
    );
  }
  if (last) {
    const allOffline = last.inArchiveTier === last.containers;
    parts.push(
      <div key="last" className="space-y-1" data-testid="archive-last">
        <Row label={`Last archive: ${last.year}`}>
          <Badge variant="outline">{utcMinute(last.createdAt) || 'time not recorded'}</Badge>
        </Row>
        <p className="text-xs text-muted-foreground">
          {number(last.containers)} files (one per container), {number(last.records)} records,{' '}
          {sizeWords(last.bytes)} compressed, made from the weekly backup of{' '}
          {last.sourceRun || 'an unknown date'}.{' '}
          {allOffline
            ? 'Every file is in the Archive tier (offline; reading one back takes hours).'
            : `${number(last.inArchiveTier)} of ${number(last.containers)} files are in the Archive tier; the daily check moves the rest.`}
        </p>
        {last.missingFiles ? (
          <p className="text-xs text-destructive" data-testid="archive-last-missing">
            {number(last.missingFiles)} file(s) the archive’s list names are not in storage. Say so
            on the issue; the runbook has the link.
          </p>
        ) : null}
      </div>
    );
  }
  if (!parts.length) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="archive-none">
        No archive has been written yet.
      </p>
    );
  }
  return <div className="space-y-2">{parts}</div>;
}

function ReportBody({ latest }) {
  if (!latest) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="archive-no-report">
        No dry run yet. Press Dry run: it reads the newest weekly backup and counts what an archive
        would keep, change and leave out. It writes no archive and changes no record.
      </p>
    );
  }
  if (!latest.complete && latest.stalled) {
    const missing = Array.isArray(latest.missing) ? latest.missing : [];
    return (
      <p className="text-sm text-destructive" role="status" data-testid="archive-stalled">
        The last dry run did not finish: {latest.done} of {latest.expected} containers were read
        from the backup of {latest.sourceRun || 'an unknown date'}.
        {missing.length ? (
          <>
            {' '}
            Missing: <span className="font-mono">{missing.join(', ')}</span>.
          </>
        ) : null}{' '}
        Nothing was archived or changed. Press Dry run to start a new one.
      </p>
    );
  }
  if (!latest.complete) {
    return (
      <p className="text-sm text-muted-foreground" role="status" data-testid="archive-progress">
        A dry run is reading the backup of {latest.sourceRun || 'an unknown date'}: {latest.done} of{' '}
        {latest.expected} containers done. Press the refresh button in a few minutes.
      </p>
    );
  }
  const report = latest.report || {};
  const totals = report.totals || {};
  const containers = Array.isArray(report.containers) ? report.containers : [];
  const unclassified = containers.filter((part) => part.reason === 'unclassified');
  const read = containers.filter((part) => part.reason !== 'unclassified');
  const flagged = read.filter((part) => part.sensitive?.keptRecords > 0);
  const leftOutWhole = Array.isArray(report.leftOutWhole) ? report.leftOutWhole : [];
  return (
    <div className="space-y-3" data-testid="archive-report">
      <p className="text-xs text-muted-foreground">
        Dry run finished {utcMinute(report.completedAt) || 'at an unrecorded time'}, from the weekly
        backup of {report.sourceBackup?.runId || 'an unknown date'}.
      </p>
      <Row label="Records an archive would keep">
        <Badge variant="outline" data-testid="archive-kept">
          {number(totals.kept)}
        </Badge>
      </Row>
      <Row label="Of those, with fields taken out first">
        <Badge variant="outline">{number(totals.changed)}</Badge>
      </Row>
      <Row label="Records it would leave out">
        <Badge variant="outline">{number(totals.leftOut)}</Badge>
      </Row>
      {totals.mismatched ? (
        <p className="text-xs text-destructive" data-testid="archive-mismatch">
          {number(totals.mismatched)} container(s) held a different number of records than the
          backup’s own list says. Do not switch the archive on; the runbook says what to check.
        </p>
      ) : null}
      {totals.unreadable ? (
        <p className="text-xs text-destructive">
          {number(totals.unreadable)} line(s) of the backup could not be read as a record.
        </p>
      ) : null}
      {flagged.length ? (
        <div data-testid="archive-flagged">
          <p className="text-sm font-medium text-destructive">
            Look before switching the archive on: {flagged.length} container(s) an archive would
            keep hold a field named like a secret or contact details
          </p>
          <ul aria-label="Kept containers with a field named like a secret">
            {flagged.map((part) => (
              <li key={part.container} className="py-1">
                <p className="text-sm font-mono">{part.container}</p>
                <SensitiveLine part={part} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <p className="text-sm font-medium">
          Waiting for you: {unclassified.length} containers to classify
        </p>
        <p className="text-xs text-muted-foreground">
          No code names these today, so nothing says what they hold, and they stay out of the
          archive until you do. Counts and field names only; no record is shown. A field name is
          listed only when it is common and plain, so a name that is really an id is not shown.
        </p>
        <ul aria-label="Containers to classify">
          {unclassified.map((part) => (
            <UnclassifiedRow key={part.container} part={part} />
          ))}
        </ul>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-primary">
          Every container ({read.length} read, {leftOutWhole.length} left out whole)
        </summary>
        <table className="mt-2 w-full text-left text-xs">
          <caption className="sr-only">What the dry run found, container by container</caption>
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="py-1 pr-2 font-medium">
                Container
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                Kept
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                Changed
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                Left out
              </th>
              <th scope="col" className="py-1 font-medium">
                Fields, and names that look sensitive
              </th>
            </tr>
          </thead>
          <tbody>
            {read.map((part) => (
              <tr key={part.container} className="border-t border-border/60 align-top">
                <td className="py-1 pr-2 font-mono">{part.container}</td>
                <td className="py-1 pr-2">{number(part.kept)}</td>
                <td className="py-1 pr-2">
                  {number(part.changed)}
                  {part.changed ? ` (${Object.keys(part.removed || {}).join(', ')})` : ''}
                </td>
                <td className="py-1 pr-2">
                  {number(part.leftOut)}
                  {part.leftOut ? ` (${reasonWords(part.leftOutBy)})` : ''}
                </td>
                <td className="py-1">
                  <FieldNames part={part} />
                  <SensitiveLine part={part} />
                </td>
              </tr>
            ))}
            {leftOutWhole.map((part) => (
              <tr key={part.container} className="border-t border-border/60 align-top">
                <td className="py-1 pr-2 font-mono">{part.container}</td>
                <td className="py-1 pr-2">0</td>
                <td className="py-1 pr-2">0</td>
                <td className="py-1 pr-2">
                  all {number(part.backupDocs)} ({REASONS[part.reason] || part.reason})
                </td>
                <td className="py-1 text-muted-foreground">not read</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** The status, as read; a module-level read, as useGuardedLoad needs a stable one. */
const loadStatus = () => getJSON(ARCHIVE_STATUS_ROUTE);

function ArchiveCardBody() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const guarded = useGuardedLoad(loadStatus, {
    enabled: authReady,
    empty: null,
    describeError: refusalSentence,
  });
  const { refresh } = guarded;
  const status = guarded.data;
  const [starting, setStarting] = useState(false);

  const startDryRun = useCallback(async () => {
    setStarting(true);
    try {
      const answer = await postJSON(ARCHIVE_DRY_RUN_ROUTE, {});
      toast({
        title: 'Dry run started',
        description: `Reading the weekly backup of ${answer?.sourceBackup}: ${answer?.queued} containers. The report appears here in a few minutes.`,
      });
      await refresh();
    } catch (error) {
      toast({
        title: 'The dry run did not start',
        description: refusalSentence(error),
        variant: 'destructive',
      });
    } finally {
      setStarting(false);
    }
  }, [refresh, toast]);

  let body;
  if (guarded.loading) {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading the archive’s state
      </p>
    );
  } else if (guarded.error || !status) {
    body = (
      <p className="text-sm text-red-600">
        The archive’s state could not be read: {guarded.error || 'no answer'}
      </p>
    );
  } else {
    // A run that did not finish no longer holds the button: a new one may start.
    const running = status.latest && !status.latest.complete && !status.latest.stalled;
    body = (
      <div className="space-y-3">
        <Row label={`Switch (${status.setting})`}>
          <Badge variant={status.switchOn ? 'secondary' : 'outline'} data-testid="archive-switch">
            {status.switchOn ? 'On' : 'Off'}
          </Badge>
        </Row>
        <Row label={`Archive of ${status.year}`}>
          <Badge variant="outline" data-testid="archive-year-state">
            {yearState(status.archived, status.archiveContainerExists)}
          </Badge>
        </Row>
        <p className="text-xs text-muted-foreground" data-testid="archive-readiness">
          {status.jobBuilt === false
            ? 'The job that writes an archive is not built yet, so nothing starts whatever the switch says. '
            : ''}
          {status.wouldStart
            ? `Every condition for the archive of ${status.year} is met today.`
            : `An archive of ${status.year} could not start today: ${blockerSentence(status.blockers)}.`}
        </p>
        {status.jobBuilt === false ? null : <ArchiveProgress status={status} />}
        <ReportBody latest={status.latest} />
        {status.reports ? (
          <p className="text-xs text-muted-foreground" data-testid="archive-report-home">
            Reports are kept in the private{' '}
            <span className="font-mono">{status.reports.container}</span> storage container, under{' '}
            <span className="font-mono">{status.reports.prefix}</span>, and one older than{' '}
            {status.reports.keepDays} days is deleted when a new dry run starts.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={startDryRun}
            disabled={starting || running}
          >
            {starting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            Dry run
          </Button>
          <a
            href={ARCHIVE_RUNBOOK_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            How to read this report
          </a>
        </div>
      </div>
    );
  }

  return (
    <Card data-testid="archive-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Archive className="h-4 w-4 text-primary" aria-hidden="true" />
              Archive
            </CardTitle>
            <CardDescription>
              The yearly long-term copy of the site’s content, and a dry run that shows what it
              would hold.
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => refresh()}
            disabled={guarded.pending}
            aria-label="Read the archive’s state again"
          >
            <RefreshCw
              className={`h-4 w-4 ${guarded.pending ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </Button>
        </div>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

export default function ArchiveCard() {
  const role = useAdminRole();
  // The server checks the role on both routes. Here an unknown role (null: a
  // page outside the guard, or a test) draws nothing, because a card that
  // can only say "refused" is noise on a page every admin reads.
  if (!satisfiesRole(role, ARCHIVE_ROLE)) return null;
  return <ArchiveCardBody />;
}
