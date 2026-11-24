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

/** The kinds of value the report tells apart, in plain words. */
const KIND_WORDS = Object.freeze({
  number: 'number',
  'yes-no': 'true/false',
  date: 'date-like text',
  'short-text': 'short text (under 64 characters)',
  'long-text': 'long text',
  list: 'list',
  object: 'object',
  empty: 'empty',
});

/** "short text (under 64 characters) ×12, empty ×1": the kinds of value seen, as counts. */
export const kindWords = (kinds = {}) =>
  Object.entries(kinds)
    .map(([kind, n]) => `${KIND_WORDS[kind] || kind} ×${number(n)}`)
    .join(', ');

/** "credential_register › rotated.some-name" or just the path. */
const whereWords = (entry) => (entry.document ? `${entry.document} › ${entry.path}` : entry.path);

/** Why some names are counted and not printed. Empty when none are. */
export function notShownWords(notShown = {}) {
  const parts = [];
  if (notShown.notPlain)
    parts.push(
      `${number(notShown.notPlain)} more use(s) of a name that is not shown because it is shaped like an id or typed text`
    );
  if (notShown.tooMany)
    parts.push(
      `${number(notShown.tooMany)} more use(s) not listed because this container has more than 2,000 different such names`
    );
  return parts.join('; ');
}

/** True when this container has a name that would remain and is not explained. */
export const isFlagged = (part) =>
  part?.sensitive?.remaining
    ? part.sensitive.flagged > 0
    : // A report made before the lists were split says only how many kept records carry one.
      part?.sensitive?.keptRecords > 0;

/** The names that would remain and are not explained, one line each. Red unless the owner decided. */
function RemainingFlagged({ part, flagged, hidden: remainingHidden }) {
  if (!flagged.length && !remainingHidden) return null;
  return (
    <div
      className={part.ownerAccepted ? undefined : 'text-destructive'}
      data-testid="archive-remaining-flagged"
    >
      <p>
        Would remain in the archive, named like a secret or contact details
        {part.ownerAccepted
          ? `. The owner chose to keep this container as it is on ${part.ownerAccepted}; the names are still listed so a new one is noticed`
          : ''}
        :
      </p>
      <ul className="list-disc pl-4">
        {flagged.map((entry) => (
          <li key={whereWords(entry)}>
            <span className="font-mono">{whereWords(entry)}</span> in {number(entry.records)}{' '}
            record(s); values seen: {kindWords(entry.kinds)}
          </li>
        ))}
        {remainingHidden ? <li>{remainingHidden}</li> : null}
      </ul>
    </div>
  );
}

/**
 * Everything the report says about names that look like a secret or contact
 * details, for one container: what would remain (in red when not explained),
 * what is only numbers or yes/no, what is kept on purpose, and what is taken
 * out. Names, paths, counts and kinds only.
 */
function SensitiveLine({ part }) {
  const { sensitive } = part;
  if (!sensitive?.remaining) {
    // A report made before the lists were split: one sentence, as it was.
    const sentence = sensitiveSentence(sensitive);
    if (!sentence) return null;
    return (
      <p
        className={`text-xs [overflow-wrap:anywhere] ${sensitive.keptRecords > 0 ? 'text-destructive' : 'text-muted-foreground'}`}
        data-testid="archive-sensitive"
      >
        {sentence}
      </p>
    );
  }
  const flagged = sensitive.remaining.filter((entry) => entry.flagged);
  const quiet = sensitive.remaining.filter((entry) => entry.quiet && !entry.keptOnPurpose);
  const onPurpose = sensitive.remaining.filter((entry) => entry.keptOnPurpose);
  const takenOut = sensitive.takenOut || [];
  const remainingHidden = notShownWords(sensitive.remainingNotShown);
  const takenOutHidden = notShownWords(sensitive.takenOutNotShown);
  if (!sensitive.remaining.length && !takenOut.length && !remainingHidden && !takenOutHidden)
    return null;
  return (
    <div className="space-y-1 text-xs [overflow-wrap:anywhere]" data-testid="archive-sensitive">
      <RemainingFlagged part={part} flagged={flagged} hidden={remainingHidden} />
      {quiet.length ? (
        <p className="text-muted-foreground" data-testid="archive-remaining-quiet">
          Named like one, but only numbers or yes/no:{' '}
          <span className="font-mono">{quiet.map(whereWords).join(', ')}</span>
        </p>
      ) : null}
      {onPurpose.map((entry) => (
        <p
          key={whereWords(entry)}
          className="text-muted-foreground"
          data-testid="archive-kept-on-purpose"
        >
          Kept on purpose: <span className="font-mono">{whereWords(entry)}</span> in{' '}
          {number(entry.records)} record(s) ({entry.keptOnPurpose})
        </p>
      ))}
      {takenOut.length || takenOutHidden ? (
        <p className="text-muted-foreground" data-testid="archive-taken-out">
          {part.decision === 'leave-out' ? 'Found, and not archived' : 'Taken out before archiving'}
          :{' '}
          <span className="font-mono">
            {takenOut.map((field) => `${field.name} (${number(field.records)})`).join(', ')}
          </span>
          {takenOutHidden ? `${takenOut.length ? '; ' : ''}${takenOutHidden}` : ''}
        </p>
      ) : null}
    </div>
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
 * What needs a decision and what already has one: the red block, the
 * containers the owner chose to keep, and the waiting list (or that it is
 * empty).
 */
function DecisionBlocks({ flagged, accepted, unclassified, ownerAccepted }) {
  return (
    <>
      {flagged.length ? (
        <div data-testid="archive-flagged">
          <p className="text-sm font-medium text-destructive">
            Look before switching the archive on: {flagged.length} container(s) an archive would
            keep hold a field that would remain, is named like a secret or contact details, and
            holds more than numbers or yes/no
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
      {accepted.length ? (
        <div data-testid="archive-owner-accepted">
          <p className="text-sm font-medium">
            The owner chose to keep these, {accepted[0].ownerAccepted}: {accepted.length}{' '}
            container(s) an archive keeps hold a field that would remain and is named like a secret
            or contact details
          </p>
          <p className="text-xs text-muted-foreground">
            That decision was for each container as the dry run showed it, not for each name one by
            one. The names and the kinds of value are listed every time, so one that appears later
            is seen.
          </p>
          <ul aria-label="Kept by the owner’s decision, with a field named like a secret">
            {accepted.map((part) => (
              <li key={part.container} className="py-1">
                <p className="text-sm font-mono">{part.container}</p>
                <SensitiveLine part={part} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {unclassified.length ? (
        <div>
          <p className="text-sm font-medium">
            Waiting for you: {unclassified.length} container(s) to classify
          </p>
          <p className="text-xs text-muted-foreground">
            Nothing in the code says what these hold, so they stay out of the archive until you say.
            Counts and field names only; no record is shown. A field name is listed only when it is
            common and plain, so a name that is really an id is not shown.
          </p>
          <ul aria-label="Containers to classify">
            {unclassified.map((part) => (
              <UnclassifiedRow key={part.container} part={part} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm" data-testid="archive-nothing-waiting">
          Nothing is waiting for you: every container is classified.
          {ownerAccepted?.wereWaiting
            ? ` On ${ownerAccepted.date} the owner chose to keep, whole, the ${ownerAccepted.wereWaiting} that were waiting.`
            : ''}{' '}
          A container added later is left out and listed here until it is decided.
        </p>
      )}
    </>
  );
}

function ReportBody({ latest, ownerAccepted }) {
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
  // A flagged container the owner has already decided to keep as it is, is
  // listed on its own, not in red: the question was answered. Its names are
  // still shown.
  const flagged = read.filter((part) => isFlagged(part) && !part.ownerAccepted);
  const accepted = read.filter((part) => isFlagged(part) && part.ownerAccepted);
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
      <DecisionBlocks
        flagged={flagged}
        accepted={accepted}
        unclassified={unclassified}
        ownerAccepted={ownerAccepted}
      />
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
