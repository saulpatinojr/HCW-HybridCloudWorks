/**
 * The Archive card's dry-run report: what needs the owner's decision, the
 * containers waiting to be classified, and the table of every container.
 * Names, paths, counts and kinds only. Moved out of ArchiveCard.jsx when
 * that file grew too long.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import ColumnHeads from '@/pages/shared/ColumnHeads';
import { FieldNames, Row, SensitiveLine } from './ArchiveReport';
import { isFlagged, number, REASONS, reasonWords } from './archiveWords';
import { utcMinute } from './SentAlertsCard';

/** The columns of the every-container table. */
const CONTAINER_COLUMNS = [
  ['Container', 'py-1 pr-2 font-medium'],
  ['Kept', 'py-1 pr-2 font-medium'],
  ['Changed', 'py-1 pr-2 font-medium'],
  ['Left out', 'py-1 pr-2 font-medium'],
  ['Fields, and names that look sensitive', 'py-1 font-medium'],
];

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

export function ReportBody({ latest, ownerAccepted }) {
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
          <ColumnHeads className="text-muted-foreground" columns={CONTAINER_COLUMNS} />
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
