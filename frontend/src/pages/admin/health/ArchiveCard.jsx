/**
 * Archive — where the yearly content archive stands, and its dry run
 * (ADR 0046, #1811).
 *
 * The archive is a long-term copy of the site's content, made once a year
 * from the weekly database backup, with personal details and secrets taken
 * out first. This card reads `GET cms/content-archive` and shows: whether
 * the switch is on, whether an archive could start today and what stands in
 * the way, and the newest dry-run report. The Dry run button
 * (`POST cms/content-archive/dry-run`) makes the server read the newest
 * weekly backup and count what an archive would keep, change and leave out.
 * A dry run writes no archive and changes no record.
 *
 * For the seven containers nobody has classified yet, the report lists the
 * names of their top-level fields so the owner can say what each one is. It
 * never shows a record or a value; the server does not send one.
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
  'before-1-february': 'it is still January, the month of grace',
  'already-archived': 'that year is already archived',
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

/** true: written; false: not written; anything else: the container could not be read. */
export function yearState(archived) {
  if (archived === true) return 'Written';
  if (archived === false) return 'Not written';
  return 'Not known';
}

const number = (value) => (Number.isFinite(value) ? value.toLocaleString('en-US') : '0');

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** One unclassified container: its count and the names of its fields. */
function UnclassifiedRow({ part }) {
  const names = part.fieldNames || [];
  return (
    <li className="border-b border-border/60 py-2 last:border-0" data-testid="archive-unclassified">
      <p className="text-sm">
        <span className="font-mono">{part.container}</span>
        <span className="text-muted-foreground">
          {part.inBackup === false ? ': not in the backup' : `: ${number(part.read)} records`}
        </span>
      </p>
      {names.length ? (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          Fields: <span className="font-mono">{names.map((field) => field.name).join(', ')}</span>
          {part.fieldNamesTruncated ? ' (and more; only the first 100 names are listed)' : ''}
          {part.otherNames
            ? ` (${number(part.otherNames)} names not shown: they read like typed text)`
            : ''}
        </p>
      ) : null}
    </li>
  );
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
      <div>
        <p className="text-sm font-medium">
          Waiting for you: {unclassified.length} containers to classify
        </p>
        <p className="text-xs text-muted-foreground">
          The code cannot say what these hold, so they stay out of the archive until you do. Counts
          and field names only; no record is shown.
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
              <th scope="col" className="py-1 font-medium">
                Left out
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
                <td className="py-1">
                  {number(part.leftOut)}
                  {part.leftOut ? ` (${reasonWords(part.leftOutBy)})` : ''}
                </td>
              </tr>
            ))}
            {leftOutWhole.map((part) => (
              <tr key={part.container} className="border-t border-border/60 align-top">
                <td className="py-1 pr-2 font-mono">{part.container}</td>
                <td className="py-1 pr-2">0</td>
                <td className="py-1 pr-2">0</td>
                <td className="py-1">
                  all {number(part.backupDocs)} ({REASONS[part.reason] || part.reason})
                </td>
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
    const running = status.latest && !status.latest.complete;
    body = (
      <div className="space-y-3">
        <Row label={`Switch (${status.setting})`}>
          <Badge variant={status.switchOn ? 'secondary' : 'outline'} data-testid="archive-switch">
            {status.switchOn ? 'On' : 'Off'}
          </Badge>
        </Row>
        <Row label={`Archive of ${status.year}`}>
          <Badge variant="outline" data-testid="archive-year-state">
            {yearState(status.archived)}
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
        <ReportBody latest={status.latest} />
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
