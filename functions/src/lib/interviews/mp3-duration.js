/**
 * interviews/mp3-duration.js — an mp3's length from its headers, for
 * duration.js (whose header explains the probe): the first frame's header
 * for the sample rate and bitrate, and a Xing/Info header's frame count for
 * a variable-bitrate file. Pure over the bytes it is given.
 */

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

/** Where the audio starts: after an ID3v2 tag (and its footer), or at 0. */
function afterId3(head) {
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  return 10 + size + ((head[5] & 0x10) ? 10 : 0);
}

/** The first frame whose header is followed by another valid header, with where it starts; null when none is found. */
function firstFrame(head, start) {
  for (let at = start; at + 4 <= head.length && at < start + 65536; at += 1) {
    const candidate = mp3Frame(head, at);
    if (!candidate || candidate.frameLength <= 0) continue;
    const next = mp3Frame(head, at + candidate.frameLength);
    if (next || at + candidate.frameLength >= head.length) return { frame: candidate, at };
  }
  return null;
}

/** A Xing/Info header carries the frame count of a variable-bitrate file: its length in seconds, or null. */
function xingSeconds(head, frame, at) {
  const sideInfo = frame.version === 1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const xingAt = at + 4 + sideInfo;
  const tag = xingAt + 4 <= head.length ? head.toString('latin1', xingAt, xingAt + 4) : '';
  if ((tag !== 'Xing' && tag !== 'Info') || xingAt + 12 > head.length) return null;
  if (!(head.readUInt32BE(xingAt + 4) & 0x01)) return null;
  const frames = head.readUInt32BE(xingAt + 8);
  return frames > 0 ? (frames * frame.samplesPerFrame) / frame.sampleRate : null;
}

/** An mp3's length: from its Xing/Info frame count, else from the first frame's bitrate. */
export function mp3Duration(head, totalBytes) {
  const found = firstFrame(head, afterId3(head));
  if (!found) return null;
  const { frame, at } = found;
  const vbr = xingSeconds(head, frame, at);
  if (vbr !== null) return vbr;
  if (!frame.bitrate) return null;
  return ((totalBytes - at) * 8) / frame.bitrate;
}
