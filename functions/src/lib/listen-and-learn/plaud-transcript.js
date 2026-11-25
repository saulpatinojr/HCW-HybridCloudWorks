/**
 * plaud-transcript.js — turning whatever a Plaud recording's transcript
 * arrives as (its segments, utterances nested somewhere in the answer, or
 * plain "Name: words" lines) into one shape: a title and timed segments,
 * each with a speaker. recording-script.js writes the episode script from
 * it, and exports normalizePlaudTranscript and oneLineTitle again.
 */

/** A finite non-negative number, or null. Plaud times are integers in ms. */
export function msOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** `[00:03]`, `1:02:15`, `00:03.500` → ms; anything else → null. */
function clockToMs(clock) {
  if (!clock) return null;
  const parts = clock.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  const [s, m = 0, h = 0] = parts.reverse();
  return Math.round(((h * 60 + m) * 60 + s) * 1000);
}

/** Plaud's `2026-08-06T21:21:40.133000` has no zone; keep the string as is. */
export function stringOrNull(value) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  return s || null;
}

/**
 * A title on one line.
 *
 * Plaud's `name` is free text the owner typed, and a paste can carry
 * anything. A newline inside it would spill the title across lines inside
 * the fence — breaking the prompt's claim that the FIRST line is the
 * SESSION TITLE — and would store a multi-line `source.title`. Every
 * whitespace run, newlines and tabs included, collapses to one space; the
 * same helper serves the prompt, the result and the normaliser so the three
 * cannot disagree about what the title is.
 */
export function oneLineTitle(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The one notion of "same speaker" in this module.
 *
 * Plaud's labels are consistent, but a paste is not: "Speaker 1", "speaker 1"
 * and "Speaker 1 " are one voice. Two places need to agree on that — the
 * paragraph break `renderTranscriptForPrompt` puts where the speaker changes
 * (a spurious break tells the model a second person spoke) and the
 * de-duplication in `findAttributionLeaks` (a spurious duplicate inflates the
 * count a reviewer reads). One key function, so they cannot drift apart.
 */
export function speakerKey(label) {
  return oneLineTitle(label).toLowerCase();
}

/** One Plaud utterance → one normalised segment, or null if it says nothing. */
function fromPlaudSegment(item) {
  if (!item || typeof item !== 'object') return null;
  const text = String(item.content ?? item.text ?? '').trim();
  if (!text) return null;
  const speaker = String(item.speaker ?? item.original_speaker ?? '').trim() || null;
  return {
    startMs: msOrNull(item.start_time ?? item.startMs),
    endMs: msOrNull(item.end_time ?? item.endMs),
    text,
    speaker,
  };
}

/** Does this look like the utterance array Plaud returns? */
function looksLikeUtterances(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item && typeof item === 'object') &&
    value.some((item) => 'content' in item || 'text' in item)
  );
}

/**
 * The utterance array inside a `get_file` `source_list` entry.
 *
 * The utterance shape itself is measured (#442, 2026-09-08). The key that
 * holds the array inside a `data_type: "transaction"` entry is NOT — both
 * files sampled while writing this had an empty `source_list` — so this looks
 * for the array by shape rather than by name, and a wiring that learns the
 * key can tighten it. Prefers named candidates, then any array-valued field.
 */
function findUtterances(entry) {
  if (!entry || typeof entry !== 'object') return null;
  for (const key of ['segments', 'data', 'content', 'list', 'items', 'utterances']) {
    if (looksLikeUtterances(entry[key])) return entry[key];
  }
  for (const value of Object.values(entry)) {
    if (looksLikeUtterances(value)) return value;
  }
  return null;
}

/**
 * A pasted transcript: one segment per non-empty line.
 *
 * Accepts an optional leading clock and an optional `Label:` — the two things
 * every transcript export puts at the start of a line. The label is kept as
 * `speaker` so the normalised shape is honest about what the text carried;
 * `renderTranscriptForPrompt` is where it is dropped.
 *
 * Only something that reads as a speaker counts as a label: `Speaker 2` in
 * either case, or up to three name-like tokens, each a dotted initial
 * (`J.`) or an uppercase-initial word with at least one lowercase letter in
 * it (`Maria`, `O'Brien`, `McDonald`). An all-caps token followed by a colon
 * — `AWS: the region…`, `TODO: fix this` — is a topical prefix and stays in
 * the text. Copilot on #446 caught the earlier pattern stripping those.
 *
 * The letter classes are Unicode property escapes, not `[A-Z]`/`[a-z]`/`\w`.
 * An ASCII matcher does not see `Zoë:` or `Łukasz:` as a name, so it leaves
 * the label in the segment text — a leading label this module says it
 * strips. "Uppercase initial with at least one lowercase letter" is the same
 * rule in any script that has case; `ÉCOLE:` stays in the text like `AWS:`.
 * The bound is the header's: leading labels of the recognised shapes, not
 * every name a transcript can contain.
 */
// Three token shapes: a dotted initial (`J.`), an honorific or other
// abbreviation — uppercase initial, one to four lowercase letters, a period
// (`Dr.`, `Mrs.`, `Prof.`, `St.`) — and a name-like word.
const NAME_TOKEN = String.raw`(?:\p{Lu}\.|\p{Lu}\p{Ll}{1,4}\.|\p{Lu}[\p{L}\p{N}'-]*\p{Ll}[\p{L}\p{N}'-]*)`;
const PLAIN_LINE = new RegExp(
  String.raw`^\s*(?:\[?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\]?\s*[-–—]?\s*)?(?:((?:[Ss]peaker\s*\d+)|(?:${NAME_TOKEN}(?:\s+${NAME_TOKEN}){0,2})):\s+)?(.*\S)\s*$`,
  'u'
);

function fromPlainText(text) {
  const segments = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = PLAIN_LINE.exec(line);
    if (!match) continue;
    const [, clock, label, body] = match;
    segments.push({
      startMs: clockToMs(clock),
      endMs: null,
      text: body.trim(),
      speaker: label ? label.trim() : null,
    });
  }
  return segments;
}

/**
 * Recording metadata from whatever Plaud record is to hand.
 *
 * `list_files` and `get_file` both return `{ id, name, start_at, duration }`
 * (measured 2026-09-08, `duration` in ms); `get_transcript` returns only
 * `file_id`. An already-normalised `recording` passes through.
 */
function recordingFrom(...sources) {
  const out = { id: null, title: null, recordedAt: null, durationMs: null };
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    out.id = out.id || stringOrNull(src.id ?? src.file_id ?? src.recordingId);
    out.title = out.title || oneLineTitle(src.title ?? src.name) || null;
    out.recordedAt =
      out.recordedAt || stringOrNull(src.recordedAt ?? src.start_at ?? src.created_at);
    out.durationMs = out.durationMs ?? msOrNull(src.durationMs ?? src.duration);
  }
  return out;
}

/**
 * Turn what Plaud (or a paste) returned into `{ recording, segments }`.
 *
 * Accepts, in order of how the wiring is likely to hold it:
 *   - the `get_transcript` result — `{ file_id, segments: [...] }`, measured;
 *   - the `get_file` result — `{ id, name, start_at, duration, source_list }`
 *     with a `data_type: "transaction"` entry carrying the utterances;
 *   - a bare utterance array;
 *   - a plain-text transcript (the Upload tab, or a `.txt` export), as a
 *     string or as `{ transcript }`, which is what `POST cms/recordings`
 *     already stores;
 *   - an already-normalised `{ recording, segments }`, unchanged.
 *
 * `file` is the `list_files` or `get_file` record for the same recording, for
 * the shapes that do not carry their own title and times. Segments are kept
 * in transcript order; Plaud already sorts by `start_time`, and re-sorting a
 * paste with no times would be a no-op that hides a bug.
 *
 * @param {unknown} raw
 * @param {object} [file]
 * @returns {{ recording: { id: string|null, title: string|null, recordedAt: string|null, durationMs: number|null }, segments: object[] }}
 */
export function normalizePlaudTranscript(raw, file = null) {
  let utterances = null;
  let segments = null;

  if (typeof raw === 'string') {
    segments = fromPlainText(raw);
  } else if (Array.isArray(raw)) {
    utterances = raw;
  } else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.segments) && raw.recording && typeof raw.recording === 'object') {
      // Already ours. Re-run the per-segment cleaning so a caller cannot
      // smuggle an empty text through by presenting the normalised shape.
      segments = raw.segments.map(fromPlaudSegment).filter(Boolean);
      return { recording: recordingFrom(raw.recording, file), segments };
    }
    if (looksLikeUtterances(raw.segments)) {
      utterances = raw.segments;
    } else if (Array.isArray(raw.source_list)) {
      // Select by shape across EVERY entry, preferring a `transaction` block
      // that actually yields utterances. Preferring the first block by name
      // alone was wrong: a `transaction` entry can be present and empty (a
      // pending or failed pass) beside a `transaction_polish` entry that
      // holds the whole transcript, and the name-first pick returned nothing.
      const yielding = raw.source_list.map((e) => findUtterances(e));
      const preferred = raw.source_list.findIndex(
        (e, i) => e?.data_type === 'transaction' && yielding[i]
      );
      const any = yielding.findIndex(Boolean);
      utterances = yielding[preferred >= 0 ? preferred : any] || [];
    } else if (typeof raw.transcript === 'string') {
      segments = fromPlainText(raw.transcript);
    } else {
      utterances = findUtterances(raw) || [];
    }
  } else {
    segments = [];
  }

  if (!segments) segments = (utterances || []).map(fromPlaudSegment).filter(Boolean);
  return { recording: recordingFrom(raw, file), segments };
}

