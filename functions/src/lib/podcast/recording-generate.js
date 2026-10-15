/**
 * Orchestrates one podcast transcript from one recording (#434 wiring, #442).
 *
 *   recording → dialogue → MP3 → draft transcript
 *
 * The sibling of `generate.js`, for the other source the hub presents. Two
 * doors, one pipeline:
 *
 *   `{ recordingId }`        a Plaud library recording, read server-side
 *                            through the MCP with the token the Connect tab
 *                            stored (`mcp_servers/plaud`) — `get_transcript`
 *                            first, `get_file`'s `source_list` as the
 *                            fallback, `get_file` for the title and times
 *                            either way. Stored as `plaud_<recordingId>`.
 *   `{ storedRecordingId }`  a document in the `recordings` container: a
 *                            manual paste from the Plaud tab, or an upload
 *                            Plaud Embedded transcribed (recording-upload.js).
 *                            Stored as `recording_<id>`.
 *
 * Everything after the script — voice, upload, save, spend — is
 * `finishTranscript` from generate.js, so the policies its header states
 * hold here without restating them: every audio failure degrades to a saved
 * draft carrying `audioError`, and usage rows are written only after the
 * transcript is.
 *
 * **A disconnected or rejected Plaud credential is refused before any spend.**
 * The MCP answers 401 / `CLIENT_USER_AUTH_REVOKED` when the authorization was
 * revoked on Plaud's side (measured 2026-09-08, see the Plaud tab's header),
 * and the honest outcome is one sentence naming the Connect tab — never a
 * generation against an empty transcript, which would produce a plausible
 * episode about the title. `generate` is asserted never called in that case.
 * The same refusal is available at the door (`refusalForPlaud`) so the route
 * can answer 409 without an MCP round trip.
 *
 * **The feature is declared here.** `generateRecordingScript` names none, by
 * design (its header says why); the router call this module owns carries
 * `feature: 'podcastScript'` at a literal call site so `ai-call-sites.test.js`
 * can see it and the portal toggle gates it.
 */
import { callMcpTool } from '../ai/mcp.js';
import { codeShaped } from '../http/error-response.js';
import {
  generateRecordingScript,
  normalizePlaudTranscript,
} from '../listen-and-learn/recording-script.js';
import {
  TranscriptError,
  finishTranscript,
  recordScriptFailure,
  resolvePipelineDeps,
} from './generate.js';
import { SOURCE_KINDS, describeRecordingSource, recordingKey } from './store.js';

/** The platform job that runs this. Shared with the handler that enqueues it. */
export const RECORDING_JOB_TYPE = 'generate-podcast-transcript-from-recording';

/** Where stored recordings live — what `GET/POST cms/recordings` read and write. */
export const RECORDINGS_CONTAINER = 'recordings';

/** The MCP server document the Connect tab writes the token pair onto. */
export const PLAUD_MCP_SERVER_ID = 'plaud';

/** Cosmos ids are bounded at 255 bytes; a recording id longer than this is not one. */
export const MAX_RECORDING_ID_CHARS = 200;

/**
 * The one sentence for a Plaud credential that is missing or was rejected.
 * Names the remedy, because the error Plaud gives does not.
 */
export const PLAUD_CONNECT_SENTENCE =
  'Plaud is not connected, or its authorization was revoked: reconnect on the Recording Hub → ' +
  'Plaud tab → Connect (both tokens), then script the recording again.';

/**
 * Validate the job payload: exactly one of `recordingId` / `storedRecordingId`,
 * trimmed, bounded, and usable as a transcript key. Returns `{ value }` or
 * `{ error }`, shared by the route and the worker so both refuse with the
 * same sentence.
 */
export function parseRecordingPayload(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const recordingId = typeof raw.recordingId === 'string' ? raw.recordingId.trim() : '';
  const storedRecordingId =
    typeof raw.storedRecordingId === 'string' ? raw.storedRecordingId.trim() : '';

  if (recordingId && storedRecordingId) {
    return { error: 'Send recordingId or storedRecordingId, not both' };
  }
  const which = recordingId ? 'recordingId' : 'storedRecordingId';
  const id = recordingId || storedRecordingId;
  if (!id) return { error: 'recordingId or storedRecordingId is required' };
  if (id.length > MAX_RECORDING_ID_CHARS) return { error: `${which} is too long` };
  try {
    recordingKey(id);
  } catch {
    return { error: `${which} contains characters that cannot name a transcript` };
  }
  return { value: recordingId ? { recordingId } : { storedRecordingId } };
}

/**
 * Did the MCP refuse the credential? The proxy maps 401/402/403 and
 * `invalid_token` to `UNAUTHENTICATED`; Plaud's own revocation code arrives
 * as text on a tool error, so both are read.
 */
export function isPlaudCredentialFailure(outcome) {
  if (!outcome || outcome.ok) return false;
  if (outcome.code === 'UNAUTHENTICATED') return true;
  const text = String(outcome.error || '');
  return /CLIENT_USER_AUTH_REVOKED/i.test(text) || /\b401\b/.test(text);
}

/**
 * The refusal the route can give without calling Plaud: no token stored means
 * nothing to call with. Returns the sentence, or null when a call is worth
 * making (a stored token can still be rejected — the job handles that).
 */
export function refusalForPlaud(server) {
  if (!server || !String(server.oauthToken || '').trim()) return PLAUD_CONNECT_SENTENCE;
  return null;
}

/**
 * The MCP hands back JSON as text (`content[0].text`), and some servers also
 * set `structuredContent`. Prefer the structured form; parse the text
 * otherwise; null when it is neither.
 */
export function parseToolResult(outcome) {
  const structured = outcome?.raw?.structuredContent;
  if (structured && typeof structured === 'object') return structured;
  const text = String(outcome?.result || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Why a Plaud tool call failed, as the transcript will store it: the connect
 * sentence for a refused credential, else the tool, the recording and the
 * answer's code. The tool's own text stays out (#945).
 *
 * @param {{ code?: string|number|null }} outcome - callMcpTool's failure
 * @param {string} tool - the tool called
 * @param {string} recordingId - the recording asked for
 * @returns {TranscriptError}
 */
function explainToolFailure(outcome, tool, recordingId) {
  if (isPlaudCredentialFailure(outcome)) return new TranscriptError(PLAUD_CONNECT_SENTENCE);
  const code = codeShaped(outcome?.code);
  const note = code ? ` (${code})` : '';
  return new TranscriptError(`Plaud could not return ${tool} for recording ${recordingId}${note}.`);
}

/**
 * Read one library recording through the MCP into `{ recording, segments }`.
 *
 * `get_file` is called first because it carries the title and times the
 * transcript lacks, and because a credential failure shows up on the first
 * call — before anything else is attempted. `get_transcript` is the
 * dependable read for the utterances (measured 2026-09-09: both `get_file`
 * samples had an empty `source_list`); when it fails for a non-credential
 * reason or comes back empty, the file's `source_list` is the fallback.
 *
 * @param {object} params
 * @param {(args: { tool: string, arguments: object }) => Promise<object>} params.callTool
 * @param {string} params.recordingId
 */
export async function readPlaudRecording({ callTool, recordingId }) {
  const fileOutcome = await callTool({ tool: 'get_file', arguments: { file_id: recordingId } });
  if (!fileOutcome.ok) throw explainToolFailure(fileOutcome, 'get_file', recordingId);
  const file = parseToolResult(fileOutcome);

  const transcriptOutcome = await callTool({
    tool: 'get_transcript',
    arguments: { file_id: recordingId },
  });
  if (!transcriptOutcome.ok && isPlaudCredentialFailure(transcriptOutcome)) {
    throw new TranscriptError(PLAUD_CONNECT_SENTENCE);
  }

  const transcript = transcriptOutcome.ok ? parseToolResult(transcriptOutcome) : null;
  let normalized = normalizePlaudTranscript(transcript ?? {}, file);
  if (normalized.segments.length === 0 && file) {
    normalized = normalizePlaudTranscript(file, file);
  }
  if (!normalized.recording.id) normalized.recording.id = recordingId;
  return normalized;
}

/**
 * Read one stored recording into `{ recording, segments }`.
 *
 * An upload Plaud Embedded transcribed carries `segments` already in the
 * normalised shape; a manual paste carries `transcript` as text, which the
 * normaliser reads with its `Label:` and `[mm:ss]` rules.
 */
export async function readStoredRecording({ store, storedRecordingId }) {
  const doc = await store.readDoc(RECORDINGS_CONTAINER, storedRecordingId, storedRecordingId);
  if (!doc) {
    throw new TranscriptError(`Recording ${storedRecordingId} was not found in the recordings container`);
  }
  const recording = {
    id: doc.id,
    title: doc.title ?? null,
    recordedAt: doc.recordedAt ?? doc.createdAt ?? null,
    durationMs: doc.durationMs ?? doc.duration ?? null,
  };
  const raw = Array.isArray(doc.segments)
    ? { recording, segments: doc.segments }
    : { transcript: typeof doc.transcript === 'string' ? doc.transcript : '' };
  return normalizePlaudTranscript(raw, recording);
}

/**
 * Generate the transcript for one recording.
 *
 * @param {object} params
 * @param {string} [params.recordingId] a Plaud library recording
 * @param {string} [params.storedRecordingId] a `recordings` document
 * @param {{ readDoc: Function, upsertDoc: Function }} params.store
 * @param {{ uploadBlob: Function }} params.storage
 * @param {{ generateJsonResponse: Function, getCostEstimate: Function }} params.ai
 * @param {object} [params.env]
 * @param {string} [params.now]
 * @param {object} [params.deps] test seams; `callTool` replaces the MCP client
 * @returns {Promise<object>} a small report; the document is the record
 */
export async function generateTranscriptFromRecording({
  recordingId,
  storedRecordingId,
  store,
  storage,
  ai,
  env = process.env,
  now = new Date().toISOString(),
  deps = {},
  signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseRecordingPayload({ recordingId, storedRecordingId });
  if (parsed.error) throw new TranscriptError(parsed.error);

  const resolved = resolvePipelineDeps(deps, { writeScript: generateRecordingScript });
  const { writeScript, persistFailure } = resolved;
  const callTool =
    deps.callTool ||
    ((args) => callMcpTool({ store, serverId: PLAUD_MCP_SERVER_ID, env, ...args }));

  // Read before anything is spent. Both readers throw a TranscriptError
  // naming the remedy, and neither has called the model.
  const fromLibrary = Boolean(parsed.value.recordingId);
  const { recording, segments } = fromLibrary
    ? await readPlaudRecording({ callTool, recordingId: parsed.value.recordingId })
    : await readStoredRecording({ store, storedRecordingId: parsed.value.storedRecordingId });

  const source = describeRecordingSource({
    kind: fromLibrary ? SOURCE_KINDS.plaud : SOURCE_KINDS.recording,
    recordingId: fromLibrary ? parsed.value.recordingId : parsed.value.storedRecordingId,
    title: recording.title,
  });

  // The product declares the feature, not the generator — see the header.
  // A literal call site, because ai-call-sites.test.js reads the source.
  const generate = (params) => ai.generateJsonResponse({ ...params, feature: 'podcastScript' });

  const scriptUsage = [];
  let script;
  try {
    // The generator refuses an empty or trivially short transcript before
    // calling `generate`, so a device check or a revoked read that slipped
    // through as "no segments" still costs nothing.
    script = await writeScript({
      recording: { ...recording, id: source.id },
      segments,
      generate,
      usageOut: scriptUsage,
    });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError' || err?.message === 'aborted') throw err;
    await recordScriptFailure({ store, source, error: err, now, persistFailure });
  }

  const report = await finishTranscript({
    source,
    script,
    scriptUsage,
    store,
    storage,
    ai,
    env,
    now,
    deps: resolved,
    signal,
  });

  return {
    ...report,
    recordingId: fromLibrary ? parsed.value.recordingId : null,
    storedRecordingId: fromLibrary ? null : parsed.value.storedRecordingId,
    attributionLeaks: Array.isArray(script.attributionLeaks) ? script.attributionLeaks : [],
  };
}
