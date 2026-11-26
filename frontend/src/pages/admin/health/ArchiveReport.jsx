/**
 * The Archive card's report: the archive being written, the decisions the
 * owner has to make, and the dry run's container-by-container table. Names,
 * paths, counts and kinds only; never a record or a value. Moved out of
 * ArchiveCard.jsx when that file grew too long.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { utcMinute } from './SentAlertsCard';
import {
  kindWords,
  notShownWords,
  number,
  sensitiveSentence,
  sizeWords,
  whereWords,
} from './archiveWords';

export function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** The field names of one container, as a sentence. Nothing when the report listed none. */
export function FieldNames({ part }) {
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

/** An older report's one sentence about field names that look sensitive. */
function SensitiveSentence({ sensitive }) {
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

/** The names taken out before archiving (or found and not archived), with their counts. */
function TakenOutLine({ part, takenOut, hidden }) {
  return (
    <p className="text-muted-foreground" data-testid="archive-taken-out">
      {part.decision === 'leave-out' ? 'Found, and not archived' : 'Taken out before archiving'}:{' '}
      <span className="font-mono">
        {takenOut.map((field) => `${field.name} (${number(field.records)})`).join(', ')}
      </span>
      {hidden ? `${takenOut.length ? '; ' : ''}${hidden}` : ''}
    </p>
  );
}

/**
 * How many of a kept container's records were too large or too deep to
 * search whole. Any such record stops the archive (`report-cut-short`), so
 * the line is red. A container that is left out is not archived, so it says
 * nothing. A count only; never which record.
 */
export function CutShortLine({ part }) {
  const records = Number(part.sensitive?.cutShort) || 0;
  if (records <= 0 || part.decision === 'leave-out') return null;
  return (
    <p className="text-xs text-destructive" data-testid="archive-cut-short">
      {number(records)} record{records === 1 ? ' was' : 's were'} too large to search whole for
      names that look like a secret, so the archive cannot start until a dry run searches{' '}
      {records === 1 ? 'it' : 'them'} whole
    </p>
  );
}

/**
 * Everything the report says about names that look like a secret or contact
 * details, for one container: what would remain (in red when not explained),
 * what is only numbers or yes/no, what is kept on purpose, and what is taken
 * out. Names, paths, counts and kinds only.
 */
export function SensitiveLine({ part }) {
  const { sensitive } = part;
  // A report made before the lists were split: one sentence, as it was.
  if (!sensitive?.remaining) return <SensitiveSentence sensitive={sensitive} />;
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
        <TakenOutLine part={part} takenOut={takenOut} hidden={takenOutHidden} />
      ) : null}
    </div>
  );
}

/**
 * The archive itself: one being written now, the last one written, or that
 * none has been. Numbers, dates and container names only.
 */
export function ArchiveProgress({ status }) {
  if (status.progressKnown === false) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="archive-progress-unknown">
        Whether an archive has been written, or is being written, could not be read just now.
      </p>
    );
  }
  const { run, lastArchive: last } = status;
  const parts = [];
  if (run?.unlistedFiles) {
    parts.push(
      <p key="unlisted" className="text-sm text-destructive" data-testid="archive-run-unlisted">
        The folder of the archive of {run.year} holds {number(run.unlistedFiles)} file(s) its list
        does not name: a container that was archived when the run started and has since been taken
        off the list. The archive cannot finish while it is there, and nothing deletes it by itself.
        The runbook, “A file that should not be there”, has the steps.
      </p>
    );
  }
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
