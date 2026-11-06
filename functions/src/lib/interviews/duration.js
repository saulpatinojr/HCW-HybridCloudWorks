/**
 * duration.js — how long a recording is, read from its headers (ADR 0040
 * D3, #1565; design review round two).
 *
 * Gemini takes at most 9.5 hours of audio in one prompt, and every window
 * request attaches the whole file, so a longer recording would fail on the
 * first request after a 500 MiB upload. The length is read BEFORE the
 * transcription is queued, from the bytes that carry it, and stored on the
 * document as `provenance.audio.durationSec`; the enqueue route refuses a
 * recording over the cap with TOO_LONG, and the job uses the real
 * length for its cost estimate instead of a bitrate guess.
 *
 * Three formats, each read from a small slice of the file, never the whole
 * file (a range read of the first and last 256 KiB):
 *
 *   wav   the `fmt ` chunk's byte rate and the `data` chunk's size;
 *   mp3   the first frame's header for the sample rate and bitrate, and a
 *         Xing/Info header's frame count for a variable-bitrate file
 *         (constant bitrate: file size over bitrate); an ID3v2 tag at the
 *         front is skipped;
 *   m4a   the `mvhd` atom's timescale and duration, which sits at the start
 *         of the file or at its end.
 *
 * A file whose headers cannot be read answers null: unknown is allowed
 * through (the job's bitrate estimate then errs long), only a known length
 * over the cap is refused. Nothing here is logged.
 */

import { MAX_AUDIO_SECONDS } from './storage.js';

/** Gemini's cap on audio in one prompt, 9.5 hours (aistudio.google.com/docs/audio, read 2026-11-05): storage.js's, shared with the upload. */
export { MAX_AUDIO_SECONDS };

/** Bytes read from each end of the file for the headers. */
export const PROBE_BYTES = 256 * 1024;

// ── wav ─────────────────────────────────────────────────────────────────────

function wavDuration(head, totalBytes) {
  if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= head.length) {
    const id = head.toString('latin1', offset, offset + 4);
    const size = head.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= head.length) byteRate = head.readUInt32LE(offset + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      // A streamed wav writes 0 or 0xFFFFFFFF for the size it did not know.
      const dataBytes = size === 0 || size === 0xffffffff ? Math.max(0, totalBytes - (offset + 8)) : size;
      return dataBytes / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

// ── mp3 ─────────────────────────────────────────────────────────────────────

const MPEG_BITRATES = {
  // [version][layer] → kbps by index 1..14 (MPEG1 layer III, MPEG2/2.5 layer III)
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
};
const MPEG_SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

/** The frame header at `offset`, or null when the bytes are not one. */
function mp3Frame(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const b1 = buf[offset];
  const b2 = buf[offset + 1];
  const b3 = buf[offset + 2];
  const b4 = buf[offset + 3];
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null;
  const versionBits = (b2 >> 3) & 0x03;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : versionBits === 0 ? 2.5 : null;
  const layer = 4 - ((b2 >> 1) & 0x03);
  if (version === null || layer === 4) return null;
  const bitrateIndex = (b3 >> 4) & 0x0f;
  const sampleIndex = (b3 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const table = MPEG_BITRATES[`${version === 1 ? 1 : 2}-${layer}`];
  const bitrate = table[bitrateIndex] * 1000;
  const sampleRate = MPEG_SAMPLE_RATES[version][sampleIndex];
  const padding = (b3 >> 1) & 0x01;
  const channelMode = (b4 >> 6) & 0x03;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 || version === 1 ? 1152 : 576;
  const frameLength =
    layer === 1 ? Math.floor((12 * bitrate) / sampleRate + padding) * 4 : Math.floor((samplesPerFrame / 8) * bitrate / sampleRate + padding);
  return { version, layer, bitrate, sampleRate, samplesPerFrame, frameLength, mono: channelMode === 3 };
}

function mp3Duration(head, totalBytes) {
  let start = 0;
  if (head.length >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    start = 10 + size + ((head[5] & 0x10) ? 10 : 0);
  }
  // The first frame whose header is followed by another valid header.
  let frame = null;
  let at = start;
  for (; at + 4 <= head.length && at < start + 65536; at += 1) {
    const candidate = mp3Frame(head, at);
    if (!candidate || candidate.frameLength <= 0) continue;
    const next = mp3Frame(head, at + candidate.frameLength);
    if (next || at + candidate.frameLength >= head.length) {
      frame = candidate;
      break;
    }
  }
  if (!frame) return null;
  // A Xing/Info header carries the frame count of a variable-bitrate file.
  const sideInfo = frame.version === 1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const xingAt = at + 4 + sideInfo;
  const tag = xingAt + 4 <= head.length ? head.toString('latin1', xingAt, xingAt + 4) : '';
  if ((tag === 'Xing' || tag === 'Info') && xingAt + 12 <= head.length) {
    const flags = head.readUInt32BE(xingAt + 4);
    if (flags & 0x01) {
      const frames = head.readUInt32BE(xingAt + 8);
      if (frames > 0) return (frames * frame.samplesPerFrame) / frame.sampleRate;
    }
  }
  if (!frame.bitrate) return null;
  return ((totalBytes - at) * 8) / frame.bitrate;
}

// ── m4a (MP4) ───────────────────────────────────────────────────────────────

function mvhdDuration(buf) {
  const at = buf.indexOf('mvhd', 0, 'latin1');
  if (at < 0 || at + 32 > buf.length) return null;
  const version = buf[at + 4];
  if (version === 0) {
    const timescale = buf.readUInt32BE(at + 16);
    const duration = buf.readUInt32BE(at + 20);
    return timescale > 0 ? duration / timescale : null;
  }
  if (version === 1 && at + 36 <= buf.length) {
    const timescale = buf.readUInt32BE(at + 24);
    const duration = Number(buf.readBigUInt64BE(at + 28));
    return timescale > 0 ? duration / timescale : null;
  }
  return null;
}

function mp4Duration(head, tail) {
  return mvhdDuration(head) ?? (tail ? mvhdDuration(tail) : null);
}

/**
 * The recording's length in seconds from its headers, or null when they
 * cannot be read.
 *
 * @param {{ contentType: string, bytes: number, head: Buffer, tail?: Buffer|null }} file
 * @returns {number|null}
 */
export function audioDurationSeconds({ contentType, bytes, head, tail = null }) {
  if (!Buffer.isBuffer(head) || head.length === 0) return null;
  const total = Number(bytes) || head.length;
  let seconds = null;
  try {
    if (contentType === 'audio/wav') seconds = wavDuration(head, total);
    else if (contentType === 'audio/mpeg') seconds = mp3Duration(head, total);
    else if (contentType === 'audio/mp4') seconds = mp4Duration(head, tail);
  } catch {
    seconds = null;
  }
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Read the headers of a blob and answer its length, or null.
 *
 * @param {{ readBlobRangeForDelivery: Function }} storage
 * @param {{ container: string, path: string, contentType: string, bytes: number }} audio
 * @returns {Promise<number|null>}
 */
export async function probeAudioDuration(storage, { container, path, contentType, bytes }) {
  const total = Number(bytes) || 0;
  const headEnd = Math.min(PROBE_BYTES, Math.max(total, 1)) - 1;
  const head = await storage.readBlobRangeForDelivery(container, path, { start: 0, end: headEnd });
  if (!head?.body) return null;
  let tail = null;
  if (contentType === 'audio/mp4' && total > PROBE_BYTES) {
    const tailRange = await storage.readBlobRangeForDelivery(container, path, { start: total - PROBE_BYTES, end: total - 1 });
    tail = tailRange?.body ?? null;
  }
  return audioDurationSeconds({ contentType, bytes: total, head: head.body, tail });
}

/** True when a known length is over Gemini's cap. */
export const tooLong = (seconds) => Number.isFinite(seconds) && seconds > MAX_AUDIO_SECONDS;
