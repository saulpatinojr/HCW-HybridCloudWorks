/**
 * Where the interview comes from (ADR 0040, D7): exactly one of a pasted
 * transcript, an audio file uploaded from this computer, or a link the
 * server downloads. Choosing a file reads its length straight away, so a
 * recording longer than 9.5 hours (or one whose length cannot be read) is
 * refused here, before anything is created or sent.
 */
import React, { useId, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  audioFileProblem,
  durationProblem,
  formatDuration,
  readAudioDuration,
} from '@/lib/interviewUpload';
import { LIMITS } from './interviewModel';

const CHOICES = [
  ['transcript', 'Paste a transcript', 'A transcript you already have, or a Plaud export.'],
  ['file', 'Upload a recording', 'An MP3, M4A or WAV file of up to 500 MB and 9.5 hours.'],
  ['url', 'Link to a recording', 'An https:// address the site downloads the recording from.'],
];

/**
 * @param {object} props
 * @param {object} props.form - `source`, `transcript`, `url`
 * @param {(patch: object) => void} props.onChange
 * @param {{ file: File|null, durationSec: number|null, problem: string, reading: boolean }} props.audio
 * @param {(audio: object) => void} props.onAudio
 * @param {string} [props.problem]
 * @param {(file: Blob) => Promise<number>} [props.readDuration]
 */
/** The recording's own problem, unless it repeats the source problem shown below it. */
function shownFileProblem(form, audio, problem) {
  return form.source === 'file' && audio?.problem && !audio.reading && audio.problem !== problem;
}

/** Ties the file picker to the problems shown for it, for a screen reader. */
function problemLinks(id, fileProblem, problem) {
  const ids = [fileProblem && `${id}-file-problem`, problem && `${id}-source-problem`].filter(
    Boolean
  );
  return ids.length ? { 'aria-invalid': true, 'aria-describedby': ids.join(' ') } : {};
}

export default function SourceField({
  form,
  onChange,
  audio,
  onAudio,
  problem,
  readDuration = readAudioDuration,
}) {
  const id = useId();
  // The recording's own problem, shown under the picker unless it is the
  // same sentence as the source problem below it.
  const fileProblemShown = shownFileProblem(form, audio, problem);
  // The latest choice wins: a slow length read of a file the owner has
  // since replaced is dropped rather than shown against the new one.
  const latest = useRef(0);

  const chooseFile = async (file) => {
    latest.current += 1;
    const token = latest.current;
    if (!file) {
      onAudio({ file: null, durationSec: null, problem: '', reading: false });
      return;
    }
    const fileProblem = audioFileProblem(file);
    if (fileProblem) {
      onAudio({ file, durationSec: null, problem: fileProblem, reading: false });
      return;
    }
    onAudio({ file, durationSec: null, problem: '', reading: true });
    let seconds = null;
    try {
      seconds = await readDuration(file);
    } catch {
      seconds = null;
    }
    if (token !== latest.current) return;
    onAudio({ file, durationSec: seconds, problem: durationProblem(seconds), reading: false });
  };

  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <legend className="px-1 text-sm font-semibold">Where the interview comes from</legend>
      <div className="grid gap-2 md:grid-cols-3">
        {CHOICES.map(([value, label, hint]) => (
          <div
            key={value}
            className="flex items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary"
          >
            <input
              id={`${id}-choice-${value}`}
              type="radio"
              name={`${id}-source`}
              value={value}
              className="mt-1"
              checked={form.source === value}
              aria-describedby={`${id}-choice-${value}-hint`}
              onChange={() => onChange({ source: value })}
            />
            <div>
              <label htmlFor={`${id}-choice-${value}`} className="block cursor-pointer font-medium">
                {label}
              </label>
              <p id={`${id}-choice-${value}-hint`} className="text-xs text-muted-foreground">
                {hint}
              </p>
            </div>
          </div>
        ))}
      </div>

      {form.source === 'transcript' && (
        <div className="space-y-1">
          <label htmlFor={`${id}-transcript`} className="text-sm font-medium">
            Transcript
          </label>
          <Textarea
            id={`${id}-transcript`}
            rows={10}
            value={form.transcript || ''}
            maxLength={LIMITS.MAX_TRANSCRIPT}
            onChange={(event) => onChange({ transcript: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Lines that start with a speaker&apos;s name and a colon (for example &quot;Speaker 1:
            &quot;) are kept as that speaker.
          </p>
        </div>
      )}

      {form.source === 'url' && (
        <div className="space-y-1">
          <label htmlFor={`${id}-url`} className="text-sm font-medium">
            Recording link
          </label>
          <Input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            placeholder="https://"
            value={form.url || ''}
            onChange={(event) => onChange({ url: event.target.value })}
          />
        </div>
      )}

      {form.source === 'file' && (
        <div className="space-y-1">
          <label htmlFor={`${id}-file`} className="text-sm font-medium">
            Recording file
          </label>
          <input
            id={`${id}-file`}
            type="file"
            accept=".mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/wav"
            className="block w-full text-sm"
            {...problemLinks(id, fileProblemShown, problem)}
            onChange={(event) => chooseFile(event.target.files?.[0] || null)}
          />
          {audio?.reading && (
            <p role="status" className="text-xs text-muted-foreground">
              Reading the recording’s length…
            </p>
          )}
          {audio?.file && !audio.reading && !audio.problem && audio.durationSec && (
            <p className="text-xs text-muted-foreground">
              Length: {formatDuration(audio.durationSec)}. Size:{' '}
              {(audio.file.size / (1024 * 1024)).toFixed(1)} MB.
            </p>
          )}
        </div>
      )}

      {fileProblemShown && (
        <p id={`${id}-file-problem`} className="text-sm text-red-700 dark:text-red-400">
          {audio.problem}
        </p>
      )}
      {problem && (
        <p id={`${id}-source-problem`} className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
