/**
 * Programs (ADR 0033 §4): the catalogue as cards — provider, window state,
 * one line of what the program is — with Details (eligibility, criteria,
 * requirements, recommended activities, the application link, and this
 * program's readiness) and Start application. Editing the catalogue is the
 * Settings tab's job; this tab reads it.
 */
import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Play } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import {
  MEMBERSHIP_STATUS,
  PURSUING_STATUSES,
  childProgramsOf,
  programById,
  programsInPlay,
  todayIso,
  upkeepProgress,
  windowState,
} from './ambassadorModel';
import { ReadsStatus, allLanded } from './Parts';
import { AdditionalPrograms, ProgramDetails, UpkeepLine, WINDOW_BADGE } from './ProgramParts';
import { DraftForProgramButton } from './ProgramPipeline';
import { linkedId } from '@/hooks/useLinkedItem';
import { LINK_PARAMS } from '@/lib/itemLinks';
import { useToast } from '@/components/ui/use-toast';

const byIdOf = (programs) => programById(programs);

const DISABLED_BADGE = {
  id: 'disabled',
  label: 'Disabled',
  tone: 'off',
  help: 'Hidden from new applications; re-enable on Settings.',
};

function membershipBadge(program) {
  return MEMBERSHIP_STATUS[program.membershipStatus] || MEMBERSHIP_STATUS.none;
}

// Upkeep is shown for an active membership with upkeep rules, once the
// evidence read has landed.
function showsUpkeep(program, evidenceRows) {
  return program.membershipStatus === 'active' && Boolean(evidenceRows) && Boolean(program.upkeep);
}

/** One program in the catalogue, with Details and Start application. */
function ProgramCard({
  program,
  programs,
  byId,
  today,
  evidenceRows,
  pursued,
  starting,
  onDetails,
  onStart,
}) {
  const disabled = program.enabled === false;
  const requirementCount = (program.requirements || []).length;
  return (
    <Card className={`min-w-0 ${disabled ? 'opacity-60' : ''}`} data-testid="program-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-start justify-between gap-3 text-base">
          <span className="min-w-0 flex-1 basis-40 break-words leading-snug">{program.name}</span>
          <span className="flex flex-wrap gap-2">
            <StatusBadge size="xs" status={membershipBadge(program)} />
            <StatusBadge
              size="xs"
              status={disabled ? DISABLED_BADGE : WINDOW_BADGE[windowState(program, today)]}
            />
          </span>
        </CardTitle>
        <CardDescription>
          {program.provider} · {program.category}
          {program.parentProgramId &&
            ` · additional to ${byId.get(program.parentProgramId)?.name || 'another program'}`}
          {pursued && ' · in progress'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="line-clamp-3 text-sm">{program.description}</p>
        <p className="text-xs text-muted-foreground">
          {requirementCount} requirement
          {requirementCount === 1 ? '' : 's'}
          {program.applicationWindow?.note ? ` · ${program.applicationWindow.note}` : ''}
        </p>
        {showsUpkeep(program, evidenceRows) && (
          <UpkeepLine
            progress={upkeepProgress(program, evidenceRows, today)}
            trackerUrl={program.contributionTrackerUrl}
          />
        )}
        <AdditionalPrograms
          program={program}
          additional={childProgramsOf(programs, program.id)}
          byId={byId}
          asLine
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onDetails(program.id)}>
            Details
          </Button>
          <Button
            size="sm"
            onClick={() => onStart(program.id)}
            disabled={disabled || starting === program.id}
          >
            {starting === program.id ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1 h-3.5 w-3.5" />
            )}
            Start application
          </Button>
          {/* A held membership starts its next piece from here, whether or not
              its program states an activity rule, and without waiting for the
              evidence list (#1886, review of #1891). */}
          {program.membershipStatus === 'active' && !disabled && (
            <DraftForProgramButton program={program} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The Programs tab: the catalogue as cards, each with its details and Start application. */
export default function ProgramsTab({ hub, nav }) {
  const { programs, applications, evidence } = hub;
  // Upkeep counts wait for the evidence read: a count taken before it lands
  // would read as nothing filed.
  const evidenceRows = evidence && allLanded([evidence]) ? evidence.data : null;
  const reads = [programs, applications];
  // `?program=<id>` opens that program's details: where a Pipeline chip that
  // says "Ambassador · <program>" leads (lib/pageLinks.js, #1886).
  const [detailsId, setDetailsId] = useState(() => linkedId(LINK_PARAMS.program));
  const [starting, setStarting] = useState(null);
  const [filing, setFiling] = useState(null);
  const { toast } = useToast();
  const today = todayIso();

  const pursuedPrograms = useMemo(
    () =>
      new Set(
        applications.data
          .filter((a) => PURSUING_STATUSES.includes(a.status))
          .map((a) => a.programId)
      ),
    [applications.data]
  );
  // Top-level programs, enabled first; a program additional to another follows
  // its parent, and only once that membership is Active (programsInPlay).
  const ordered = useMemo(() => {
    const inPlay = programsInPlay(programs.data);
    const rank = (p) =>
      Number((byIdOf(programs.data).get(p.parentProgramId) || p).enabled !== false);
    return [...inPlay].sort((a, b) => rank(b) - rank(a));
  }, [programs.data]);
  const byId = useMemo(() => programById(programs.data), [programs.data]);

  const start = async (programId) => {
    setStarting(programId);
    const created = await hub.writes.createApplication({ programId });
    setStarting(null);
    if (created) {
      setDetailsId(null);
      nav.openApplication(created.id);
    }
  };

  // From the whole list, not just the cards shown: a link may name a program
  // whose card is hidden (an additional program whose parent is not Active).
  const details = programs.data.find((p) => p.id === detailsId && !p.softDeletedAt) || null;
  const linkedMissing = Boolean(detailsId) && allLanded(reads) && !details;

  // A live piece from the Pipeline becomes evidence for this program through
  // the existing import from Published content (one row per piece, so a
  // second click finds the first row).
  const fileEvidence = async (contentId) => {
    if (!details || filing) return;
    setFiling(contentId);
    const result = await hub.writes.importEvidence('content', [contentId], [details.id]);
    setFiling(null);
    if (!result) return; // refused: the write guard's toast already said why
    // The import answers 200 whether it filed the piece or not (review of
    // #1890), so the message follows what it actually did with this id.
    const listOf = (value) => (Array.isArray(value) ? value : []);
    if (listOf(result.created).some((row) => row?.sourceId === contentId)) {
      toast({ title: `Filed as evidence for ${details.name}` });
    } else if (listOf(result.missing).includes(contentId)) {
      toast({
        title: 'Not filed',
        description: 'That piece is no longer live, so it cannot be filed as evidence.',
        variant: 'destructive',
      });
    } else {
      toast({
        title: 'Already filed',
        description: 'It was filed before; attach it to this program on the Evidence tab.',
      });
    }
  };

  return (
    <div className="space-y-4 pt-4">
      <p className="text-sm text-muted-foreground">
        The programs worth pursuing, seeded from the published program rules and edited on Settings;
        a seed added later joins the catalogue on the next read. Every requirement is a starting
        point until you match it to the program&apos;s current published rules.
      </p>
      <ReadsStatus reads={reads} label="programs" />
      {linkedMissing && (
        <p className="text-sm text-muted-foreground" role="status">
          The program that link names is no longer in the catalogue.
        </p>
      )}
      {allLanded(reads) &&
        (ordered.length === 0 ? (
          <EmptyState
            title="No programs in the catalogue."
            description="Add one on the Settings tab."
            action={
              <Button size="sm" onClick={() => nav.setTab('settings')}>
                Open Settings
              </Button>
            }
          />
        ) : (
          <div className="grid min-w-0 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {ordered.map((program) => (
              <ProgramCard
                key={program.id}
                program={program}
                programs={programs.data}
                byId={byId}
                today={today}
                evidenceRows={evidenceRows}
                pursued={pursuedPrograms.has(program.id)}
                starting={starting}
                onDetails={setDetailsId}
                onStart={start}
              />
            ))}
          </div>
        ))}
      <ProgramDetails
        program={details}
        programs={programs.data}
        evidence={evidenceRows}
        onClose={() => setDetailsId(null)}
        onStart={start}
        starting={Boolean(starting)}
        pursuing={details ? pursuedPrograms.has(details.id) : false}
        onFileEvidence={fileEvidence}
        filing={filing}
      />
    </div>
  );
}
