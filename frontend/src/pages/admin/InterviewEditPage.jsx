/**
 * /admin/interviews/:interviewId — one interview from recording to live page
 * (ADR 0040, D5, D7 and D10; issue #1565).
 *
 * What the owner does here, top to bottom:
 *   - Progress: the stage (uploading, transcribing, drafting, ready or
 *     stopped with a reason), checked again every five seconds while a job
 *     works. The page starts the next step itself where nothing can be lost
 *     (a new recording is transcribed, a new transcript is drafted); after
 *     that, "Transcribe again" and "Draft again" are the owner's.
 *   - Source: when the interview has neither a recording nor a transcript
 *     (the form was closed half way), the source can be given here.
 *   - Questions and answers: read, correct, reorder, and clear the flags the
 *     honesty check raised, then save.
 *   - Details: the guest, the title, the tags, the photo.
 *   - Review and publish: Send to review, Approve, Publish, Unpublish, and
 *     Delete recording.
 *   - The transcript, folded.
 *
 * The page asks before leaving with unsaved edits, and holds the status
 * moves until the edits are saved or undone, so what is published is what
 * the owner saw.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { RefreshCw } from 'lucide-react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import SharedPageHeader from '@/components/admin/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { useAuthReady } from '@/hooks/useAuthReady';
import { imageExtensionFor, publicImageFileProblem, uploadImageFile } from '@/lib/imageUpload';
import { DetailsFields, PhotoField } from '@/components/admin/interviews/InterviewFields';
import QaEditor from '@/components/admin/interviews/QaEditor';
import SourceField from '@/components/admin/interviews/SourceField';
import StagePanel, { UploadProgress } from '@/components/admin/interviews/StagePanel';
import StatusPanel from '@/components/admin/interviews/StatusPanel';
import TranscriptPanel from '@/components/admin/interviews/TranscriptPanel';
import {
  audioProblemFor,
  detailsProblems,
  interviewIdOf,
  detailsUpdates,
  formFromDoc,
  isInFlight,
  sourceProblem,
} from '@/components/admin/interviews/interviewModel';
import { useInterview } from '@/components/admin/interviews/useInterview';
import { useSourceRunner } from '@/components/admin/interviews/useSourceRunner';
import { useUnsavedGuard } from './drafts/useUnsavedGuard';

const HELP = [
  'This page follows the interview from its recording to its live page. While the site transcribes or drafts, the progress box updates by itself every few seconds.',
  'Read every answer before you send the interview to review. An answer marked “Check this answer” has words that are not in what the guest said; correct it, then press “I have checked”.',
  'Publishing needs the Publisher role. Unpublishing takes the page off the site within five minutes and deletes nothing.',
];

const NO_AUDIO = { file: null, durationSec: null, problem: '', reading: false };

/** The Send button's words for the runner's state. */
function sendLabel(runner) {
  if (runner.running) return 'Sending…';
  return runner.canResume ? 'Carry on uploading' : 'Send';
}

/** The source box, for an interview that has neither a recording nor a transcript. */
function SourceBox({ id, onSent, readDuration }) {
  const runner = useSourceRunner();
  const [form, setForm] = useState({ source: 'transcript', transcript: '', url: '' });
  const [audio, setAudio] = useState(NO_AUDIO);
  const [problem, setProblem] = useState('');

  const send = async () => {
    const found = sourceProblem(form, audioProblemFor(form.source, audio));
    setProblem(found);
    if (found) return;
    const ok = await runner.run(id, { ...form, file: audio.file, durationSec: audio.durationSec });
    if (ok) onSent();
  };

  return (
    <section aria-labelledby="interview-source" className="space-y-3 rounded-md border p-4">
      <h2 id="interview-source" className="text-base font-semibold">
        Give the interview its source
      </h2>
      <p className="text-sm text-muted-foreground">
        This interview has no recording and no transcript yet.
      </p>
      <SourceField
        form={form}
        onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
        audio={audio}
        onAudio={setAudio}
        problem={problem}
        readDuration={readDuration}
      />
      {runner.running && <UploadProgress progress={runner.progress} />}
      {runner.error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {runner.error.message}
        </p>
      )}
      <Button
        size="sm"
        disabled={runner.running || runner.error?.code === 'INTERVIEW_DELETED'}
        onClick={send}
      >
        {sendLabel(runner)}
      </Button>
    </section>
  );
}

/** The details section: the guest, the title, the tags and the photo. */
function DetailsBox({ doc, saving, onSave, onDirty }) {
  // The owner's edits, or null while there are none (then the stored values show).
  const [edited, setEdited] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [problems, setProblems] = useState({});
  const form = edited ?? formFromDoc(doc);
  const dirty = edited !== null || photo !== null;

  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const change = (patch) => setEdited({ ...form, ...patch });
  const reset = () => {
    setEdited(null);
    setPhoto(null);
    setProblems({});
  };

  const save = async () => {
    const found = detailsProblems(form);
    if (photo) {
      const photoProblem = publicImageFileProblem(photo);
      if (photoProblem) found.photo = photoProblem;
      if (!String(form.photoAlt || '').trim()) {
        found.photoAlt = 'Describe the photo in a few words, for people who cannot see it.';
      }
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    const updates = detailsUpdates(form);
    if (photo) {
      const uploaded = await uploadImageFile({
        container: 'covers',
        path: `interviews/${doc.id}/guest-${Date.now()}.${imageExtensionFor(photo)}`,
        file: photo,
      }).catch(() => null);
      if (!uploaded?.url) {
        setProblems({ photo: 'The photo could not be uploaded. Try again.' });
        return;
      }
      updates.image = { src: uploaded.url, alt: String(form.photoAlt).trim() };
    } else if (doc.image?.src && String(form.photoAlt || '').trim() !== doc.image.alt) {
      updates.image = { src: doc.image.src, alt: String(form.photoAlt || '').trim() };
    }
    const ok = await onSave(updates, 'Details saved');
    if (ok) reset();
  };

  return (
    <section aria-labelledby="interview-details" className="space-y-4 rounded-md border p-4">
      <h2 id="interview-details" className="text-base font-semibold">
        The guest and the interview
      </h2>
      <DetailsFields form={form} onChange={change} problems={problems} />
      {doc.image?.src && (
        <p className="text-sm text-muted-foreground">
          Current photo: <span className="break-all">{doc.image.src}</span>
        </p>
      )}
      <PhotoField
        form={form}
        onChange={change}
        photo={photo || (doc.image?.src ? doc.image : null)}
        onPhoto={setPhoto}
        problems={problems}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save details'}
        </Button>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={reset}>
            Undo changes
          </Button>
        )}
      </div>
    </section>
  );
}

/** The consent record, read only: it was written once, from the sign-in, when the interview was made. */
function ConsentSummary({ consent }) {
  if (!consent?.confirmed) {
    return (
      <p className="rounded-md border border-red-300 p-3 text-sm">
        No consent record: this interview cannot be published.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      The guest agreed to publication on {consent.date} (wording {consent.wording}).
    </p>
  );
}

export default function InterviewEditPage({ readDuration, pollMs }) {
  const { interviewId: routeId = '' } = useParams();
  // Only an id shaped like one reaches the API: `..` in the address would
  // otherwise turn the route into another path on the same API.
  const interviewId = interviewIdOf(routeId);
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const view = useInterview(interviewId, { authReady, toast, pollMs });
  const [qaDirty, setQaDirty] = useState(false);
  const [detailsDirty, setDetailsDirty] = useState(false);
  const dirty = qaDirty || detailsDirty;
  const leave = useUnsavedGuard(dirty);
  const onQaDirty = useCallback((value) => setQaDirty(value), []);
  const onDetailsDirty = useCallback((value) => setDetailsDirty(value), []);

  const { doc, data } = view;
  const header = (
    <SharedPageHeader
      title={doc ? doc.title || doc.Title || 'Interview' : 'Interview'}
      help={HELP}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={view.reload} className="gap-1">
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link to="/admin/interviews">All interviews</Link>
          </Button>
        </div>
      }
    />
  );

  if (!doc) {
    return (
      <div className="max-w-5xl space-y-6">
        {header}
        {view.loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the interview…
          </p>
        ) : (
          <p role="alert" className="rounded-md border border-red-300 p-3 text-sm">
            {view.loadError || 'No interview has that address.'}
          </p>
        )}
      </div>
    );
  }

  const hasTranscript = Number.isInteger(doc.transcription?.version);
  const needsSource = !doc.provenance?.audio?.path && !hasTranscript && !isInFlight(doc);

  return (
    <div className="max-w-5xl space-y-6">
      {header}
      {doc.guest?.name && (
        <p className="text-sm">
          With {doc.guest.name}
          {doc.guest.role ? `, ${doc.guest.role}` : ''}.
        </p>
      )}
      <ConsentSummary consent={doc.consent} />
      {view.actionError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-red-300 p-3 text-sm"
        >
          <span>{view.actionError}</span>
          <Button size="sm" variant="ghost" onClick={view.clearActionError}>
            Dismiss
          </Button>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <StagePanel
          doc={doc}
          busy={view.busy}
          onTranscribe={view.transcribeAgain}
          onDraft={view.draftAgain}
        />
        <StatusPanel
          doc={doc}
          busy={view.busy}
          blocked={dirty}
          onTransition={view.transition}
          onPublish={view.publish}
          onUnpublish={view.unpublish}
          onDeleteAudio={view.deleteAudio}
        />
      </div>
      {needsSource && <SourceBox id={doc.id} onSent={view.reload} readDuration={readDuration} />}
      <QaEditor
        doc={doc}
        saving={view.busy === 'save'}
        onSave={(qa) => view.saveUpdates({ qa }, 'Questions and answers saved')}
        onDirty={onQaDirty}
      />
      <DetailsBox
        doc={doc}
        saving={view.busy === 'save'}
        onSave={view.saveUpdates}
        onDirty={onDetailsDirty}
      />
      <TranscriptPanel transcript={data?.transcript} />
      <ConfirmModal
        open={leave.leaving}
        title="Leave this page?"
        description="There are changes that are not saved. Leave without saving them?"
        confirmLabel="Leave without saving"
        onConfirm={leave.confirmLeave}
        onCancel={leave.cancelLeave}
      />
    </div>
  );
}
