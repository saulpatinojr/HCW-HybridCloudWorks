/**
 * interviews/draft-text.js — the transcript as the drafting job (draft.js)
 * reads it: turn lines split into passes small enough for one request, cut
 * on sentence ends and never inside a character, and which speaker is the
 * guest. Pure; draft.js re-exports what callers use.
 */
import { MAX_TRANSCRIPT_INPUT_BYTES } from '../listen-and-learn/recording-script.js';

/** The `Speaker N: ` label at the start of a turn line, or '' when it has none. */
const LABEL = /^([^\n:]{1,60}): /;

/** A sentence end followed by space: where a long turn is best cut. */
const SENTENCE_END = /[.!?\u2026]["'\u201d\u2019)\]]*\s+/g;

/**
 * Split one text into pieces of at most `maxBytes` of UTF-8 each, losing
 * nothing: every cut is on a character boundary (never inside a multi-byte
 * character), at the last sentence end in the piece when one falls in its
 * second half, and the pieces joined back give the text exactly.
 *
 * @param {string} text
 * @param {number} maxBytes - at least 4, so any one character fits
 * @returns {string[]}
 */
export function splitText(text, maxBytes) {
  const limit = Math.max(4, Math.floor(maxBytes));
  const pieces = [];
  let rest = String(text);
  while (Buffer.byteLength(rest, 'utf8') > limit) {
    const bytes = Buffer.from(rest, 'utf8');
    // Back off from the limit to the first byte of a character.
    let cut = limit;
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
    let piece = bytes.subarray(0, cut).toString('utf8');
    // Prefer the last sentence end, when it leaves a piece at least half full.
    let best = -1;
    for (const match of piece.matchAll(SENTENCE_END)) best = match.index + match[0].length;
    if (best > piece.length / 2 && best < piece.length) piece = piece.slice(0, best);
    pieces.push(piece);
    rest = rest.slice(piece.length);
  }
  if (rest.length > 0 || pieces.length === 0) pieces.push(rest);
  return pieces;
}

/**
 * One turn line as lines of at most `maxBytes` each: the line itself when
 * it fits, else its text split by `splitText` with the turn's label on
 * every piece.
 */
export function splitTurn(line, maxBytes) {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return [line];
  const label = LABEL.exec(line)?.[0] ?? '';
  const room = maxBytes - Buffer.byteLength(label, 'utf8');
  return splitText(line.slice(label.length), room).map((piece) => `${label}${piece}`);
}

/**
 * Turn lines, split into passes under `maxBytes` each on turn boundaries;
 * a turn longer than a pass becomes several labelled turns (splitTurn),
 * so nothing is dropped and no pass is over the limit.
 */
export function splitTranscript(lines, maxBytes = MAX_TRANSCRIPT_INPUT_BYTES) {
  const passes = [];
  let current = [];
  let size = 0;
  // Each line costs its bytes plus the newline that joins it.
  for (const line of lines.flatMap((l) => splitTurn(l, maxBytes - 1))) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (size + bytes > maxBytes && current.length > 0) {
      passes.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += bytes;
  }
  if (current.length > 0) passes.push(current.join('\n'));
  return passes;
}

/**
 * The interviewer by a simple count: the speaker whose turns carry the
 * most question marks. Ties and a transcript with no questions answer
 * null, and the model's word stands.
 */
export function guessInterviewer(segments) {
  const marks = new Map();
  for (const s of segments || []) {
    const count = (String(s.text || '').match(/\?/g) || []).length;
    marks.set(s.speaker, (marks.get(s.speaker) || 0) + count);
  }
  let best = null;
  let bestCount = 0;
  let tie = false;
  for (const [speaker, count] of marks) {
    if (count > bestCount) {
      best = speaker;
      bestCount = count;
      tie = false;
    } else if (count === bestCount && count > 0) {
      tie = true;
    }
  }
  return bestCount > 0 && !tie ? best : null;
}

/**
 * Speaker to guest mapping: the model's word, checked against the count
 * (guessInterviewer). Answers the guest's label, the interviewer by count,
 * and whether the editor must be asked (`unsure`).
 */
export function guestSpeaker(segments, speakers) {
  const interviewerByCount = guessInterviewer(segments);
  const labels = [...new Set(segments.map((s) => String(s.speaker || 'Speaker 1')))];
  const named = speakers.guest && labels.includes(speakers.guest) ? speakers.guest : null;
  if (interviewerByCount && named === interviewerByCount) {
    // The model's guest asks the questions: the two disagree, the count wins, the editor is asked.
    return { guestLabel: labels.find((l) => l !== interviewerByCount) || named, interviewerByCount, unsure: true };
  }
  if (named) return { guestLabel: named, interviewerByCount, unsure: false };
  // The model named nobody, or a label the transcript does not have: the
  // count decides where it can, and the editor is asked where it cannot
  // or where the model's answer had to be ignored.
  const guestLabel = interviewerByCount ? labels.find((l) => l !== interviewerByCount) || labels[0] : labels[0];
  const unsure = labels.length > 1 && (!interviewerByCount || Boolean(speakers.guest));
  return { guestLabel, interviewerByCount, unsure };
}
