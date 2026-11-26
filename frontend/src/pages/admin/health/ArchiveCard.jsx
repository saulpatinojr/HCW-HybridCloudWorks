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
 * its top-level fields, and the fields whose name looks like a secret or
 * someone's contact details, in separate lists: names that are taken out
 * before archiving, and names that WOULD REMAIN in the archive. For each
 * remaining name it shows where the field sits, in how many records, and
 * what kind of value it holds (a number, true/false, a date, short or long
 * text). Only the remaining names that are not explained are shown in red.
 * A container nobody has classified yet is shown as waiting, so the owner
 * can say what it is; a flagged container the owner already decided to keep
 * is listed under that decision and its date, not in red. It never shows a
 * record or a value; the server does not send one.
 *
 * Both routes are super_admin, so below that role the card is not drawn.
 */
import React, { useCallback, useState } from 'react';
import { Archive, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import RefreshableCard from './RefreshableCard';
import { useToast } from '@/components/ui/use-toast';
import { useAuthReady } from '@/hooks/useAuthReady';
import { useAdminRole } from '@/hooks/useAdminRole';
import { satisfiesRole } from '@/config/adminNav';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { getJSON, postJSON } from '@/lib/api';
import { refusalSentence } from './SentAlertsCard';
import { blockerSentence, yearState } from './archiveWords';
import { ArchiveProgress, Row } from './ArchiveReport';
import { ReportBody } from './ArchiveDryRun';

export const ARCHIVE_STATUS_ROUTE = 'cms/content-archive';
export const ARCHIVE_DRY_RUN_ROUTE = 'cms/content-archive/dry-run';
/** The role both routes need; below it the card is not drawn. */
export const ARCHIVE_ROLE = 'super_admin';
export {
  blockerSentence,
  isFlagged,
  kindWords,
  notShownWords,
  reasonWords,
  sensitiveSentence,
  sizeWords,
  yearState,
} from './archiveWords';

export const ARCHIVE_RUNBOOK_URL = 'https://docs.hybridcloudworks.com/runbooks/content-archive/';

/** The archive's state once read: the switch, the year, the readiness, the report and Dry run. */
function ArchiveStatus({ status, starting, onDryRun }) {
  // A run that did not finish no longer holds the button: a new one may start.
  const running = status.latest && !status.latest.complete && !status.latest.stalled;
  return (
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
          : `An archive of ${status.year} could not start today: ${blockerSentence(status.blockers, { cutShort: status.cutShort })}.`}
      </p>
      {status.jobBuilt === false ? null : <ArchiveProgress status={status} />}
      <ReportBody latest={status.latest} ownerAccepted={status.classification?.ownerAccepted} />
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
          onClick={onDryRun}
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
    body = <ArchiveStatus status={status} starting={starting} onDryRun={startDryRun} />;
  }

  return (
    <RefreshableCard
      icon={Archive}
      title="Archive"
      description="The yearly long-term copy of the site’s content, and a dry run that shows what it would hold."
      pending={guarded.pending}
      onRefresh={refresh}
      refreshLabel="Read the archive’s state again"
      testId="archive-card"
    >
      {body}
    </RefreshableCard>
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
