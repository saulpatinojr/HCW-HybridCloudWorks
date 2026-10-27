/**
 * The application workspace (ADR 0033 §4): one pursuit of one program, with
 * everything a credible application needs in one place — the status and its
 * history, the dates, the requirement checklist with the evidence attached
 * to each, the written responses with character counts, files and images,
 * links, notes, reviewer feedback, a print-friendly packet and a JSON export.
 *
 * Every save is a PATCH of the fields on screen; a status change is a PATCH
 * with `status` and a note, which the API checks against its transition
 * table and appends to `history[]`. The record is private by default and is
 * never published anywhere.
 *
 * The panels are WorkspaceSections.jsx; uploads are useApplicationUpload.js
 * (images only, stored privately under `ambassador/{id}/`).
 */
import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Printer } from 'lucide-react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { TabLoading } from '@/components/admin/integrations/TabNotice';
import {
  allowedTransitions,
  ambassadorStatusInfo,
  applicationExport,
  downloadJson,
  evidenceCountsToward,
  evidenceForApplication,
  evidenceRelevant,
  sourceLabel,
  readinessPeriodFor,
  todayIso,
} from './ambassadorModel';
import { answerText, questionSections, responsesMap } from './applicationQuestions';
import { INPUT, ReadinessPanel, SelectField, TextField } from './Parts';
import useReadiness from './useReadiness';
import useApplicationUpload from './useApplicationUpload';
import {
  DatesSection,
  FilesSection,
  HistorySection,
  NotesSection,
  ResponsesSection,
  SaveRow,
  WorkspaceHeader,
} from './WorkspaceSections';

/** The editable fields of an application, as the form holds them. */
export function workspaceForm(application) {
  const a = application || {};
  return {
    title: a.title || '',
    qualificationPeriod: {
      start: a.qualificationPeriod?.start || '',
      end: a.qualificationPeriod?.end || '',
    },
    applicationDate: a.applicationDate || '',
    submissionDeadline: a.submissionDeadline || '',
    decisionDate: a.decisionDate || '',
    startDate: a.startDate || '',
    expirationDate: a.expirationDate || '',
    renewalDate: a.renewalDate || '',
    notes: a.notes || '',
    reviewerFeedback: a.reviewerFeedback || '',
    responses: (a.responses || []).map((r) => ({
      questionId: r.questionId || '',
      text: r.text || '',
    })),
    links: (a.links || []).map((l) => ({ label: l.label || '', url: l.url || '' })),
    badgeImageUrl: a.badgeImageUrl || '',
    private: a.private !== false,
  };
}

/** What a save sends: dates as plain days or null, empties as null, lists cleaned. */
export function workspacePayload(form) {
  const day = (v) => (v ? v : null);
  return {
    title: form.title.trim(),
    qualificationPeriod:
      form.qualificationPeriod.start || form.qualificationPeriod.end
        ? { start: day(form.qualificationPeriod.start), end: day(form.qualificationPeriod.end) }
        : null,
    applicationDate: day(form.applicationDate),
    submissionDeadline: day(form.submissionDeadline),
    decisionDate: day(form.decisionDate),
    startDate: day(form.startDate),
    expirationDate: day(form.expirationDate),
    renewalDate: day(form.renewalDate),
    notes: form.notes,
    reviewerFeedback: form.reviewerFeedback,
    responses: form.responses
      .filter((r) => r.questionId.trim())
      .map((r) => ({ questionId: r.questionId.trim(), text: r.text })),
    links: form.links
      .filter((l) => /^https?:\/\//i.test(l.url.trim()))
      .map((l) => ({ label: l.label.trim() || l.url.trim(), url: l.url.trim() })),
    badgeImageUrl: form.badgeImageUrl.trim() || null,
    private: form.private,
  };
}

function StatusChange({ application, onChange, busy }) {
  const [next, setNext] = useState('');
  const [note, setNote] = useState('');
  const options = allowedTransitions(application.status);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-label="Change status"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!next) return;
        const ok = await onChange({ status: next, statusNote: note.trim() });
        if (ok) {
          setNext('');
          setNote('');
        }
      }}
    >
      <SelectField
        id="application-next-status"
        label="Move to"
        value={next}
        onChange={setNext}
        options={[
          { value: '', label: 'Choose…' },
          ...options.map((s) => ({ value: s, label: ambassadorStatusInfo(s).label })),
        ]}
      />
      <TextField
        id="application-status-note"
        label="Note for the history"
        value={note}
        onChange={setNote}
        placeholder="What happened"
        className="w-full min-w-0 sm:min-w-56 sm:flex-1"
      />
      <Button type="submit" size="sm" disabled={!next || busy}>
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
        Apply
      </Button>
    </form>
  );
}

function RequirementChecklist({ program, application, evidence, readiness, onToggle, busy }) {
  const attached = new Set(application.evidenceIds || []);
  const relevant = evidence.filter((e) => evidenceRelevant(e, program.id, program.parentProgramId));
  return (
    <div className="space-y-4">
      {(program.requirements || []).map((req) => {
        const row = readiness?.requirements?.find((r) => r.id === req.id);
        const candidates = relevant.filter((e) => evidenceCountsToward(e, req));
        return (
          <div key={req.id} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {req.label}{' '}
                <span className="text-xs text-muted-foreground">
                  · at least {req.minCount} from{' '}
                  {req.evidenceTypes.map(sourceLabel).join(', ') || 'any source'}
                </span>
              </p>
              {row && (
                <StatusBadge
                  size="xs"
                  status={{
                    id: row.met ? 'met' : 'open',
                    label: row.met
                      ? `Met · ${row.count}/${row.minCount}`
                      : `Open · ${row.count}/${row.minCount}`,
                    tone: row.met ? 'ok' : 'warn',
                    help: req.description,
                  }}
                />
              )}
            </div>
            {req.description && (
              <p className="mt-1 text-xs text-muted-foreground">{req.description}</p>
            )}
            {candidates.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                No evidence of these types yet. Import or add some on the Evidence tab.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {candidates.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 text-sm">
                    <input
                      id={`attach-${req.id}-${item.id}`}
                      type="checkbox"
                      checked={attached.has(item.id)}
                      disabled={busy}
                      onChange={() => onToggle(item.id)}
                    />
                    <label htmlFor={`attach-${req.id}-${item.id}`}>
                      {item.title}{' '}
                      <span className="text-xs text-muted-foreground">
                        · {item.date || 'undated'} · {sourceLabel(item.sourceModule)}
                        {item.verificationStatus === 'verified' ? ' · verified' : ''}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {(program.requirements || []).length === 0 && (
        <p className="text-sm text-muted-foreground">
          This program has no requirements yet; add them on Settings to get a checklist.
        </p>
      )}
    </div>
  );
}

/** The readiness summary and the requirement checklist, or the note that the program is gone. */
function ChecklistSection({ program, application, evidence, readiness, onToggle, busy }) {
  return (
    <section aria-labelledby="workspace-checklist">
      <h3 id="workspace-checklist" className="mb-2 text-sm font-semibold">
        Requirement checklist
      </h3>
      {readiness.loading && <TabLoading>Computing readiness…</TabLoading>}
      {readiness.loaded && <ReadinessPanel readiness={readiness.data} compact />}
      <div className="mt-3">
        {program ? (
          <RequirementChecklist
            program={program}
            application={application}
            evidence={evidence}
            readiness={readiness.data}
            onToggle={onToggle}
            busy={busy}
          />
        ) : (
          <p className="text-sm text-destructive">
            This application names a program that no longer exists.
          </p>
        )}
      </div>
    </section>
  );
}

/** Free-list responses as the packet prints them: the question id, then the answer. */
function FreeResponseList({ responses }) {
  return responses.map((r) => (
    <div key={r.questionId} className="mt-2">
      <p className="font-medium">{r.questionId}</p>
      <p className="whitespace-pre-wrap">{r.text}</p>
    </div>
  ));
}

/**
 * The packet's responses: the program's sections and questions when it has
 * them, with any answer written before the program had its question list
 * kept after them under "Other responses"; the free list otherwise.
 */
export function PacketResponses({ application, program, attached }) {
  const responses = application.responses || [];
  const questions = program?.applicationQuestions;
  if (Array.isArray(questions) && questions.length > 0) {
    const by = responsesMap(responses);
    const known = new Set(questions.map((q) => q.id));
    const leftovers = responses.filter((r) => !known.has(r.questionId));
    const evidenceById = new Map(attached.map((e) => [e.id, e]));
    return (
      <>
        {questionSections(questions).map(({ section, questions: list }) => (
          <section key={section}>
            <h3 className="font-semibold">{section}</h3>
            {list.map((question) => {
              const answer = answerText(question, by.get(question.id) || '', { evidenceById });
              return (
                <div key={question.id} className="mt-2">
                  <p className="font-medium">{question.prompt}</p>
                  <p className={`whitespace-pre-wrap${answer ? '' : ' text-muted-foreground'}`}>
                    {answer || '(not answered)'}
                  </p>
                </div>
              );
            })}
          </section>
        ))}
        {leftovers.length > 0 && (
          <section>
            <h3 className="font-semibold">Other responses</h3>
            <FreeResponseList responses={leftovers} />
          </section>
        )}
      </>
    );
  }
  return (
    <section>
      <h3 className="font-semibold">Responses</h3>
      {responses.length === 0 && <p className="text-muted-foreground">None written yet.</p>}
      <FreeResponseList responses={responses} />
    </section>
  );
}

function Packet({ application, program, evidence, onClose }) {
  const attached = evidenceForApplication(application, evidence);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-[calc(100%-2rem)] min-w-0 [&>*]:min-w-0 max-h-[90vh] overflow-y-auto sm:max-w-3xl print:max-h-none print:shadow-none">
        <DialogHeader>
          <DialogTitle>{program?.name || 'Application'} — application packet</DialogTitle>
        </DialogHeader>
        <article className="space-y-4 text-sm" aria-label="Application packet">
          <p className="text-muted-foreground">
            Status {ambassadorStatusInfo(application.status).label}
            {application.qualificationPeriod?.start || application.qualificationPeriod?.end
              ? ` · qualification period ${application.qualificationPeriod.start || '…'} to ${application.qualificationPeriod.end || '…'}`
              : ''}
          </p>
          <PacketResponses application={application} program={program} attached={attached} />
          <section>
            <h3 className="font-semibold">Evidence ({attached.length})</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {attached.map((e) => (
                <li key={e.id}>
                  {e.title} — {e.date || 'undated'} · {sourceLabel(e.sourceModule)}
                  {e.url ? ` · ${e.url}` : ''}
                </li>
              ))}
            </ul>
          </section>
          {(application.links || []).length > 0 && (
            <section>
              <h3 className="font-semibold">Links</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {application.links.map((l) => (
                  <li key={l.url}>
                    {l.label} — {l.url}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {application.notes && (
            <section>
              <h3 className="font-semibold">Notes</h3>
              <p className="whitespace-pre-wrap">{application.notes}</p>
            </section>
          )}
        </article>
        <div className="flex justify-end gap-2 print:hidden">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => window.print()}>
            <Printer className="mr-1 h-4 w-4" /> Print
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The export's file name: the program, kebab-cased, and the application id. */
const exportName = (program, application) =>
  `${(program?.name || 'application').replace(/\s+/g, '-').toLowerCase()}-${application.id}.json`;

export default function ApplicationWorkspace({ application, program, evidence, hub, onClose }) {
  const { toast } = useToast();
  const [form, setForm] = useState(() => workspaceForm(application));
  const [formFor, setFormFor] = useState(application.id);
  const [packet, setPacket] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const readiness = useReadiness(program?.id, readinessPeriodFor(program, application), {
    enabled: Boolean(program),
  });
  const files = useApplicationUpload(application, hub);
  const busy = hub.busyIds.has(application.id);
  const today = todayIso();

  // A different application selected: the form follows it (adjusted during render, React's rule for prop-driven state).
  if (formFor !== application.id) {
    setFormFor(application.id);
    setForm(workspaceForm(application));
  }

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const attached = useMemo(
    () => evidenceForApplication(application, evidence),
    [application, evidence]
  );
  const dirty = useMemo(
    () =>
      JSON.stringify(workspacePayload(form)) !==
      JSON.stringify(workspacePayload(workspaceForm(application))),
    [form, application]
  );

  const patch = (body, options) => hub.writes.patchApplication(application.id, body, options);

  const save = async (event) => {
    event?.preventDefault?.();
    return Boolean(await patch(workspacePayload(form)));
  };

  const changeStatus = async (body) => Boolean(await patch(body));

  const toggleEvidence = async (evidenceId) => {
    const current = application.evidenceIds || [];
    const next = current.includes(evidenceId)
      ? current.filter((id) => id !== evidenceId)
      : [...current, evidenceId];
    await patch({ evidenceIds: next }, { quiet: true });
  };

  const exportJson = () => {
    const ok = downloadJson(
      exportName(program, application),
      applicationExport(application, program, evidence)
    );
    toast(
      ok
        ? { title: 'Export downloaded' }
        : { title: 'Export is not available in this browser', variant: 'destructive' }
    );
  };

  const headerActions = {
    onPacket: () => setPacket(true),
    onExport: exportJson,
    onDelete: () => setConfirmDelete(true),
    onClose,
  };

  return (
    <Card className="border-2 border-primary/30" data-testid="application-workspace">
      <WorkspaceHeader
        application={application}
        program={program}
        today={today}
        busy={busy}
        actions={headerActions}
      >
        <StatusChange application={application} onChange={changeStatus} busy={busy} />
      </WorkspaceHeader>
      <CardContent className="space-y-6">
        <ChecklistSection
          program={program}
          application={application}
          evidence={evidence}
          readiness={readiness}
          onToggle={toggleEvidence}
          busy={busy}
        />

        <form className="space-y-6" onSubmit={save} aria-label="Application details">
          <DatesSection form={form} set={set} setForm={setForm} />
          <ResponsesSection
            responses={form.responses}
            onChange={set('responses')}
            program={program}
            evidence={attached}
            title={program ? `${program.name} — ${form.title || application.title}` : form.title}
          />
          <FilesSection application={application} files={files} form={form} set={set} busy={busy} />
          <NotesSection form={form} set={set} />
          <SaveRow busy={busy} dirty={dirty} />
        </form>

        <HistorySection history={application.history} />
      </CardContent>

      {packet && (
        <Packet
          application={application}
          program={program}
          evidence={evidence}
          onClose={() => setPacket(false)}
        />
      )}
      <ConfirmModal
        open={confirmDelete}
        title="Delete this application?"
        description="It is kept in the store with a deletion stamp and disappears from every list. Deleting needs the publisher role."
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          if (await hub.writes.deleteApplication(application.id)) onClose();
        }}
      />
      <span className="hidden">{INPUT}</span>
    </Card>
  );
}
