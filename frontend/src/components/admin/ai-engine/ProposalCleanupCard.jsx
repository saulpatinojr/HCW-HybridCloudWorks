/**
 * The yearly clean-up of talk proposals, on the Developer API tab (#1777).
 *
 * Once a proposal's calendar year is over, plus January as a month of grace,
 * a proposal that was not accepted loses the speaker's name, email and bio
 * and the organizer's review note; the talk's title and abstract stay. An
 * accepted proposal is never touched. The job runs once a day and ships
 * switched off: until the owner switches it on it only counts what it would
 * strip (functions/src/lib/timers/proposal-strip.js).
 *
 * This card shows what the newest run did, counts only, so the owner can
 * read a dry-run number before switching it on. It reads nothing itself: the
 * numbers arrive with the keys list (`proposalCleanup`). Switching it on is
 * not done here; the steps are in docs/runbooks/developer-api.md.
 */
import React from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { CalendarClock } from 'lucide-react';
import { whenText } from './developerApiView';

const RUNBOOK =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/developer-api.md#the-yearly-clean-up-of-proposals';

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * The newest run as one label and one sentence.
 *
 * @param {{ ranAt?: string|null, dryRun?: boolean, cycleYear?: number|null, eligibleCount?: number,
 *   strippedCount?: number, leftCount?: number, hasMore?: boolean } | null | undefined} run
 * @returns {{ label: string, sentence: string }}
 */
export function cleanupSummary(run) {
  if (!run) {
    return {
      label: 'No run recorded yet',
      sentence:
        'The clean-up has not run since it was added. It runs once a day at 04:00 UTC, after the next functions deploy.',
    };
  }
  const when = whenText(run.ranAt);
  const through = run.cycleYear ? ` for cycles up to ${run.cycleYear}` : '';
  const more = run.hasMore ? ' There is more to do; the next daily run carries on.' : '';
  if (run.dryRun !== false) {
    return {
      label: 'Switched off (dry run)',
      sentence: `The last run, ${when}, changed nothing. Switched on, it would have stripped ${plural(run.eligibleCount || 0, 'proposal', 'proposals')}${through}.${more}`,
    };
  }
  const left = run.leftCount
    ? ` ${plural(run.leftCount, 'proposal was', 'proposals were')} left for the next run.`
    : '';
  return {
    label: 'Switched on',
    sentence: `The last run, ${when}, stripped ${plural(run.strippedCount || 0, 'proposal', 'proposals')}${through}.${left}${more}`,
  };
}

export default function ProposalCleanupCard({ run }) {
  const { label, sentence } = cleanupSummary(run);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <CalendarClock className="h-5 w-5" aria-hidden="true" />
          Yearly clean-up of proposals
        </CardTitle>
        <CardDescription>
          A proposal’s cycle is the calendar year its call closed in. On 1 February of the next
          year, a proposal that was not accepted is stripped: the speaker’s name, email and bio and
          the review note are removed for good, and the talk’s title and abstract are kept. Accepted
          proposals are never stripped.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p>
          <span className="font-medium">{label}.</span> {sentence}
        </p>
        <p className="text-muted-foreground">
          Stripping cannot be undone, so it stays switched off until you ask for it. The steps are
          in the{' '}
          <a className="underline" href={RUNBOOK} target="_blank" rel="noreferrer">
            Developer API runbook
          </a>
          .
        </p>
      </CardContent>
    </Card>
  );
}
