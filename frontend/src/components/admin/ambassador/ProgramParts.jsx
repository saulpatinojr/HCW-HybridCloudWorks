/**
 * The Programs tab's details dialog and the small pieces it shares with the
 * program cards (window badge, additional programs, upkeep line).
 */
import React, { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ExternalLink, Loader2, Play } from 'lucide-react';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { TabLoading } from '@/components/admin/integrations/TabNotice';
import {
  childProgramsOf,
  programById,
  programGate,
  sourceLabel,
  readinessPeriodFor,
  todayIso,
  upkeepProgress,
} from './ambassadorModel';
import { ReadinessPanel } from './Parts';
import useReadiness from './useReadiness';
import ProgramPipeline from './ProgramPipeline';

export const WINDOW_BADGE = {
  open: { id: 'open', label: 'Window open', tone: 'ok', help: 'Applications are being taken now.' },
  closed: {
    id: 'closed',
    label: 'Window closed',
    tone: 'off',
    help: 'Outside the application dates.',
  },
  rolling: {
    id: 'rolling',
    label: 'Rolling',
    tone: 'muted',
    help: 'No fixed window; nominations or applications any time.',
  },
};

function Bullets({ title, items }) {
  if (!items?.length) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The programs additional to this one, each with whether this membership has
 * opened it (ProgramDetails), or the sentence a card carries about them.
 */
export function AdditionalPrograms({ program, additional, byId, asLine = false }) {
  if (!additional.length) return null;
  const { unlocked } = programGate(additional[0], byId);
  const names = additional.map((c) => c.name).join(', ');
  if (asLine) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="additional-programs">
        {unlocked
          ? `Additional requirements open: ${names}.`
          : `Additional requirements — ${names} — open when this membership is Active.`}
      </p>
    );
  }
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Additional programs
      </h4>
      <ul className="mt-1 space-y-0.5 text-sm">
        {additional.map((child) => (
          <li key={child.id} className="flex flex-wrap items-center gap-2">
            <span>{child.name}</span>
            <StatusBadge
              size="xs"
              status={
                unlocked
                  ? {
                      id: 'open',
                      label: 'Open',
                      tone: 'ok',
                      help: `Shown as its own card now that ${program.name} is Active.`,
                    }
                  : {
                      id: 'locked',
                      label: 'Opens when Active',
                      tone: 'off',
                      help: `Set the ${program.name} membership to Active on Settings and this appears with its own requirements and application.`,
                    }
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The window and expiry lines of the details dialog, when the program has them. */
function WindowAndExpiry({ program }) {
  return (
    <>
      {program.applicationWindow?.note && (
        <p className="text-xs text-muted-foreground">
          Window: {program.applicationWindow.opens || '—'} to{' '}
          {program.applicationWindow.closes || '—'} · {program.applicationWindow.note}
        </p>
      )}
      {program.expirationRule && (
        <p className="text-xs text-muted-foreground">Expiry: {program.expirationRule}</p>
      )}
    </>
  );
}

/** The one line a program additional to another opens with. */
function ParentNote({ gate }) {
  if (!gate.gated) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="program-parent">
      Additional to {gate.parent.name || gate.parent.id}: the requirements and questions here come
      on top of that program&apos;s, and its evidence counts here too.
    </p>
  );
}

/** The tracker link, when the owner has set one on Settings. */
function TrackerLink({ url }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline"
    >
      Contribution tracker <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/**
 * A held membership's upkeep on its card: this period's count of evidence
 * filed under the program against the minimum, the day it is due, and the
 * tracker to log each piece on.
 */
export function UpkeepLine({ progress, trackerUrl }) {
  const { current, minCount } = progress;
  return (
    <p
      className={`text-xs ${current.met ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400'}`}
      data-testid="program-upkeep"
    >
      {current.label}: {current.count} of {minCount} filed here · due {current.end}
      {trackerUrl && (
        <>
          {' · '}
          <TrackerLink url={trackerUrl} />
        </>
      )}
    </p>
  );
}

/**
 * The details dialog's upkeep: what the program asks, and, for a held
 * membership, this period's count and the last one's, with the tracker.
 */
function UpkeepSection({ program, progress }) {
  if (!program.upkeep) return null;
  const held = program.membershipStatus === 'active';
  return (
    <div className="rounded-md border border-border p-3" data-testid="program-upkeep-details">
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Activity requirement
      </h4>
      <p className="text-sm">
        At least {program.upkeep.minCount} every {program.upkeep.period}. {program.upkeep.note}
      </p>
      {held && progress && (
        <ul className="mt-2 space-y-0.5 text-sm">
          <li>
            {progress.current.label}: {progress.current.count} of {progress.minCount} filed under
            this program, due {progress.current.end}
            {progress.current.met ? ' · met' : ''}
          </li>
          <li className="text-muted-foreground">
            {progress.previous.label}: {progress.previous.count} filed
            {progress.previous.met ? ' · met' : ''}
          </li>
        </ul>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        {program.contributionTrackerUrl ? (
          <TrackerLink url={program.contributionTrackerUrl} />
        ) : (
          'No contribution tracker set: add its link to this program on Settings.'
        )}
      </p>
    </div>
  );
}

/**
 * One program's details dialog: its rules, requirements, upkeep, the programs
 * additional to it, and the readiness from the evidence on file, with Start
 * application. `evidence` is the hub's evidence once it has landed, or null.
 */
export function ProgramDetails({
  program,
  programs,
  evidence = null,
  onClose,
  onStart,
  starting,
  pursuing,
  onFileEvidence,
  filing = null,
}) {
  const readiness = useReadiness(program?.id, readinessPeriodFor(program), {
    enabled: Boolean(program),
  });
  const byId = useMemo(() => programById(programs), [programs]);
  if (!program) return null;
  const gate = programGate(program, byId);
  const additional = childProgramsOf(programs, program.id);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-[calc(100%-2rem)] min-w-0 [&>*]:min-w-0 max-h-[90vh] overflow-y-auto break-words sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{program.name}</DialogTitle>
          <DialogDescription>
            {program.provider} · {program.category}
            {program.renewalCadence ? ` · renews ${program.renewalCadence}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ParentNote gate={gate} />
          <p className="text-sm">{program.description}</p>
          {program.applicationUrl && (
            <a
              href={program.applicationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm underline"
            >
              Program page <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <WindowAndExpiry program={program} />
          <Bullets title="Eligibility" items={program.eligibility} />
          <Bullets title="Criteria" items={program.criteria} />
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Requirements
            </h4>
            <ul className="mt-1 space-y-1 text-sm">
              {(program.requirements || []).map((req) => (
                <li key={req.id}>
                  <span className="font-medium">{req.label}</span> — at least {req.minCount} from{' '}
                  {req.evidenceTypes.map(sourceLabel).join(', ') || 'any source'} (weight{' '}
                  {req.weight})
                  {req.description && (
                    <p className="text-xs text-muted-foreground">{req.description}</p>
                  )}
                </li>
              ))}
              {(program.requirements || []).length === 0 && (
                <li className="text-muted-foreground">
                  No requirements set. Add them on Settings.
                </li>
              )}
            </ul>
          </div>
          <Bullets title="Recommended activities" items={program.recommendedActivities} />
          <UpkeepSection
            program={program}
            progress={evidence ? upkeepProgress(program, evidence, todayIso()) : null}
          />
          <AdditionalPrograms program={program} additional={additional} byId={byId} />
          {onFileEvidence && (
            <ProgramPipeline
              program={program}
              evidenceRows={evidence}
              onFileEvidence={onFileEvidence}
              filing={filing}
            />
          )}
          <div className="rounded-md border border-border p-3">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Readiness from your evidence
            </h4>
            {readiness.loading && <TabLoading>Computing readiness…</TabLoading>}
            {readiness.error && <p className="text-sm text-destructive">{readiness.error}</p>}
            {readiness.loaded && <ReadinessPanel readiness={readiness.data} />}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button
              onClick={() => onStart(program.id)}
              disabled={starting || program.enabled === false || !gate.unlocked}
            >
              {starting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1 h-4 w-4" />
              )}
              {pursuing ? 'Start another application' : 'Start application'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
