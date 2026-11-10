/**
 * transcript-text.js — a transcript the owner already has (ADR 0040 D3,
 * the last bullet; #1565).
 *
 * The form's third input: a pasted transcript, or a Plaud export, for an
 * interview whose recording was transcribed elsewhere. No audio is stored,
 * nothing is sent to Gemini; the text is written to the private container
 * as the next transcript version (1 for a fresh interview; a version after
 * the Gemini ones when the owner pastes a better transcript later, so no
 * earlier version is written over), in the same shape the transcription job
 * writes, and the interview goes straight to drafting.
 *
 *   POST /api/cms/interviews/{id}/transcript   { text }
 *     → transcripts/<id>/v<n>.json  { version: n, source: 'provided', segments, text }
 *     → the document: transcription { version: n, status: 'provided' },
 *       provenance.source 'transcript', interview.stage 'transcribed'
 *
 * The text is capped at 400,000 characters, the cap the recording draft
 * route already uses (content/draft-from-recording.js), and lines of the
 * form `Speaker N: ...` (what a Plaud export and most tools write) are kept
 * as speaker turns, so the drafting job can tell the guest from the
 * interviewer; text with no such lines is one turn of one speaker.
 *
 * The transcript is the guest's words and is personal data: it goes into
 * the container and nowhere else, and the log line carries the interview
 * id, the version and the character count.
 */
import { JobFailedError } from '../jobs.js';
import { transcriptBlobPath, INTERVIEWS_AUDIO_CONTAINER } from './storage.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The same cap as POST /api/createContentFromRecording. */
export const MAX_TRANSCRIPT_CHARS = 400_000;

/** `Speaker 2: words`, `SPEAKER_01: words`, `Alice: words` at the start of a line. */
const SPEAKER_LINE = /^\s*([A-Za-z][A-Za-z0-9 _.'-]{0,38}?)\s*:\s+(.+)$/;

/**
 * Split pasted text into speaker turns. A line that starts with a short
 * label and a colon opens a turn; every other line continues the current
 * one. With no labels at all, the whole text is one turn of `Speaker 1`.
 *
 * @param {string} text
 * @returns {Array<{ speaker: string, text: string }>}
 */
export function parseSpeakerTurns(text) {
  const turns = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = SPEAKER_LINE.exec(line);
    if (match) {
      current = { speaker: match[1].trim(), text: match[2].trim() };
      turns.push(current);
    } else if (current) {
      current.text = `${current.text} ${line}`;
    } else {
      current = { speaker: 'Speaker 1', text: line };
      turns.push(current);
    }
  }
  return turns;
}

/** The transcript document the container holds, from turns; the same shape the job assembles. */
export function transcriptDocument({ version, source, segments, model = null, provider = null, windows = null }) {
  return {
    version,
    source,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(windows !== null ? { windows } : {}),
    segments,
    text: segments.map((s) => `${s.speaker}: ${s.text}`).join('\n'),
  };
}

/**
 * Check a pasted transcript: text, non-empty, under the cap.
 *
 * @param {unknown} body
 * @returns {{ ok: true, text: string } | { ok: false, status: number, error: string }}
 */
export function checkTranscriptText(body) {
  const text = typeof body?.text === 'string' ? body.text : '';
  if (!text.trim()) return { ok: false, status: 400, error: 'text is required: paste the transcript.' };
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    return {
      ok: false,
      status: 413,
      error: `The transcript has ${text.length} characters; the most is ${MAX_TRANSCRIPT_CHARS}.`,
    };
  }
  return { ok: true, text };
}

/**
 * Store a provided transcript as version 1 and move the interview on.
 *
 * @param {object} args
 * @param {string} args.interviewId
 * @param {string} args.text - already checked by `checkTranscriptText`
 * @param {{ readDoc: Function, patchDoc: Function }} args.store
 * @param {{ uploadBlob: Function }} args.storage
 * @param {() => Date} [args.now]
 * @param {{ log?: Function }} [args.log]
 * @returns {Promise<{ interviewId: string, version: number, segments: number, chars: number }>}
 */
export async function storeProvidedTranscript({
  interviewId,
  text,
  store,
  storage,
  now = () => new Date(),
  log = null,
  container = 'content',
}) {
  const doc = await store.readDoc(container, interviewId, interviewId);
  if (!doc || doc.type !== 'interview') {
    throw new JobFailedError('No interview with that id.', { code: 'INTERVIEW_NOT_FOUND', status: 404 });
  }
  const segments = parseSpeakerTurns(text).map((turn) => ({ start: 0, end: 0, ...turn }));
  if (segments.length === 0) {
    throw new JobFailedError('The transcript has no text.', { code: 'TRANSCRIPT_EMPTY', status: 400 });
  }
  const current =
    isObject(doc.transcription) && Number.isInteger(doc.transcription.version) && doc.transcription.version > 0
      ? doc.transcription.version
      : 0;
  const version = current + 1;
  const stamp = now().toISOString();
  const transcript = transcriptDocument({ version, source: 'provided', segments });
  await storage.uploadBlob(
    INTERVIEWS_AUDIO_CONTAINER,
    transcriptBlobPath(interviewId, version),
    JSON.stringify(transcript),
    'application/json'
  );
  // Whole blocks, not dotted paths: a Cosmos patch cannot set a child of a
  // block the document does not have yet, and a fresh interview has none.
  const provenance = isObject(doc.provenance) ? doc.provenance : {};
  const interview = isObject(doc.interview) ? doc.interview : {};
  await store.patchDoc(container, interviewId, {
    transcription: { version, jobId: null, status: 'provided', transcribedAt: stamp },
    provenance: {
      ...provenance,
      source: 'transcript',
      transcription: { version, source: 'provided', transcribedAt: stamp },
    },
    interview: { ...interview, stage: 'transcribed', error: null },
  });
  log?.log?.(`interview transcript: v${version} provided (${segments.length} turns, ${text.length} chars)`);
  return { interviewId, version, segments: segments.length, chars: text.length };
}
