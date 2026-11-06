/**
 * /admin/interviews/new — the form that starts an interview (ADR 0040, D7,
 * D8 and D9; issue #1565).
 *
 * The owner fills in the guest, ticks the consent box with the date the
 * guest agreed, optionally adds a photo, and gives exactly one source: a
 * pasted transcript, a recording file, or a link to one. On "Create
 * interview" the page:
 *
 *   1. creates the interview (POST cms/interviews; the server records who
 *      confirmed the consent from the sign-in, never from the form);
 *   2. uploads the photo, if any, through the existing image upload
 *      (POST cms/uploads/covers) and stores its address on the interview;
 *   3. sends the source (lib/interviewUpload.js for a file, then the
 *      transcription is queued; the server downloads a link; a transcript
 *      is stored as it is);
 *   4. opens the interview's own page, which follows the transcription and
 *      the draft until the questions and answers are ready.
 *
 * A file is checked as soon as it is chosen: its type, its size, and its
 * length, which the browser reads from the file. A recording longer than 9.5
 * hours is refused there, before anything is created.
 *
 * If step 2 or 3 fails, the interview already exists: the page says so,
 * offers "Try again" (an interrupted upload carries on from the blocks the
 * server already has) and a link to the interview's page. Pressing Create
 * again never makes a second interview.
 */
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import SharedPageHeader from '@/components/admin/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { postJSON } from '@/lib/api';
import { imageExtensionFor, publicImageFileProblem, uploadImageFile } from '@/lib/imageUpload';
import {
  ConsentField,
  DetailsFields,
  PhotoField,
} from '@/components/admin/interviews/InterviewFields';
import SourceField from '@/components/admin/interviews/SourceField';
import { UploadProgress } from '@/components/admin/interviews/StagePanel';
import {
  audioProblemFor,
  createBody,
  emptyForm,
  formProblems,
} from '@/components/admin/interviews/interviewModel';
import { useSourceRunner } from '@/components/admin/interviews/useSourceRunner';

const HELP = [
  'Fill in who the guest is, tick the agreement box with the date the guest said yes, and give the interview one source: a transcript you already have, a recording file, or a link to a recording.',
  'A recording is transcribed by the site and then turned into a draft of questions and answers. Both take a few minutes; the interview’s page shows the progress and you can leave and come back.',
  'Nothing is published until you publish it from the interview’s page. The recording is kept privately and never shown on the site.',
];

const NO_AUDIO = { file: null, durationSec: null, problem: '', reading: false };

/** The main button's words: create first, then retry or carry on an upload. */
function submitLabel({ working, createdId, canResume }) {
  if (working) return 'Working…';
  if (!createdId) return 'Create interview';
  return canResume ? 'Carry on uploading' : 'Try again';
}

export default function InterviewNewPage({ readDuration }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const runner = useSourceRunner();
  const [form, setForm] = useState(() => emptyForm());
  const [audio, setAudio] = useState(NO_AUDIO);
  const [photo, setPhoto] = useState(null);
  const [problems, setProblems] = useState({});
  const [createdId, setCreatedId] = useState('');
  const [photoDone, setPhotoDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onChange = (patch) => {
    if (createdId) return;
    setForm((current) => ({ ...current, ...patch }));
  };

  const savePhoto = async (id) => {
    if (!photo || photoDone) return;
    try {
      const uploaded = await uploadImageFile({
        container: 'covers',
        path: `interviews/${id}/guest-${Date.now()}.${imageExtensionFor(photo)}`,
        file: photo,
      });
      if (!uploaded?.url) throw new Error('The photo was stored without an address.');
      await postJSON('updateContentItem', {
        contentId: id,
        updates: { image: { src: uploaded.url, alt: String(form.photoAlt).trim() } },
      });
      setPhotoDone(true);
    } catch (failure) {
      // The interview is fine without its photo; say so and carry on.
      toast({
        title: 'The photo was not added',
        description: `${failure?.message || 'The upload failed.'} Add it later from the interview’s page.`,
        variant: 'destructive',
      });
      setPhotoDone(true);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    const found = formProblems(form, { audioProblem: audioProblemFor(form.source, audio), photo });
    const photoProblem = photo ? publicImageFileProblem(photo) : '';
    if (photoProblem) found.photo = photoProblem;
    setProblems(found);
    if (Object.keys(found).length > 0) {
      setError('Some fields need attention; each says what is missing.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      let id = createdId;
      if (!id) {
        const created = await postJSON('cms/interviews', createBody(form));
        id = created?.id;
        if (!id) throw new Error('The interview was not created. Try again.');
        setCreatedId(id);
      }
      await savePhoto(id);
      const ok = await runner.run(id, {
        source: form.source,
        transcript: form.transcript,
        url: form.url,
        file: audio.file,
        durationSec: audio.durationSec,
      });
      if (ok) {
        toast({ title: 'Interview created', description: 'Its page shows the progress.' });
        navigate(`/admin/interviews/${encodeURIComponent(id)}`);
      }
    } catch (failure) {
      setError(failure?.message || 'The interview could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const runnerError = runner.error;
  const stopped = runnerError?.code === 'INTERVIEW_DELETED';

  return (
    <div className="max-w-4xl space-y-6">
      <SharedPageHeader title="New interview" help={HELP} />
      <form onSubmit={submit} noValidate className="space-y-6" aria-label="New interview">
        <fieldset disabled={Boolean(createdId)} className="space-y-6">
          <section aria-labelledby="new-guest" className="space-y-4">
            <h2 id="new-guest" className="text-base font-semibold">
              The guest and the interview
            </h2>
            <DetailsFields form={form} onChange={onChange} problems={problems} />
          </section>
          <ConsentField form={form} onChange={onChange} problem={problems.consent} />
          <PhotoField
            form={form}
            onChange={onChange}
            photo={photo}
            onPhoto={setPhoto}
            problems={problems}
          />
          <SourceField
            form={form}
            onChange={onChange}
            audio={audio}
            onAudio={setAudio}
            problem={problems.source}
            readDuration={readDuration}
          />
        </fieldset>

        {createdId && (
          <p className="rounded-md border p-3 text-sm">
            The interview is created. Its details are changed from{' '}
            <Link className="underline" to={`/admin/interviews/${encodeURIComponent(createdId)}`}>
              its own page
            </Link>
            .
          </p>
        )}
        {runner.running && <UploadProgress progress={runner.progress} />}
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        {runnerError && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-red-300 p-3 text-sm text-red-900 dark:text-red-100"
          >
            <p>{runnerError.message}</p>
            {!stopped && (
              <p>
                The interview is saved. Press{' '}
                {runner.canResume ? 'Carry on uploading' : 'Try again'} to send it again, or open{' '}
                <Link
                  className="underline"
                  to={`/admin/interviews/${encodeURIComponent(createdId)}`}
                >
                  the interview’s page
                </Link>{' '}
                and add the source there.
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {!stopped && (
            <Button type="submit" disabled={busy || runner.running}>
              {submitLabel({
                working: busy || runner.running,
                createdId,
                canResume: runner.canResume,
              })}
            </Button>
          )}
          {runner.running && form.source === 'file' && (
            <Button type="button" variant="outline" onClick={runner.stop}>
              Stop the upload
            </Button>
          )}
          <Button asChild variant="ghost">
            <Link to="/admin/interviews">Back to interviews</Link>
          </Button>
        </div>
      </form>
    </div>
  );
}
