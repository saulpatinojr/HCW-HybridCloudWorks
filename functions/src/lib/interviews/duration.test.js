/**
 * The recording's length from its headers (ADR 0040 D3, review round two):
 * wav from the byte rate and data size, mp3 from the first frame (constant
 * bitrate) or the Xing frame count (variable), m4a from the mvhd atom at
 * either end of the file; unknown is null, and only a known length over
 * 9.5 hours is "too long".
 */
import { describe, it, expect, vi } from 'vitest';
import { MAX_AUDIO_SECONDS, PROBE_BYTES, audioDurationSeconds, probeAudioDuration, tooLong } from './duration.js';

/** A wav header: `byteRate` bytes a second, `dataBytes` of samples. */
function wav({ byteRate, dataBytes, extraChunk = false }) {
  const parts = [Buffer.from('RIFF\0\0\0\0WAVE', 'latin1')];
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt32LE(byteRate, 16);
  parts.push(fmt);
  if (extraChunk) {
    const list = Buffer.alloc(8 + 3 + 1);
    list.write('LIST', 0, 'latin1');
    list.writeUInt32LE(3, 4);
    parts.push(list);
  }
  const data = Buffer.alloc(8);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(dataBytes, 4);
  parts.push(data);
  return Buffer.concat(parts);
}

/** An MPEG-1 layer III frame header: 128 kbps, 44.1 kHz, stereo, no padding. */
const MP3_FRAME = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const MP3_FRAME_LENGTH = Math.floor((1152 / 8) * 128000 / 44100); // 417

/** `count` constant-bitrate frames, optionally behind an ID3v2 tag and with a Xing header in the first. */
function mp3({ frames = 3, id3 = 0, xingFrames = null } = {}) {
  const parts = [];
  if (id3) {
    const tag = Buffer.alloc(10 + id3);
    tag.write('ID3', 0, 'latin1');
    tag[3] = 4;
    tag[6] = (id3 >> 21) & 0x7f;
    tag[7] = (id3 >> 14) & 0x7f;
    tag[8] = (id3 >> 7) & 0x7f;
    tag[9] = id3 & 0x7f;
    parts.push(tag);
  }
  for (let i = 0; i < frames; i += 1) {
    const frame = Buffer.alloc(MP3_FRAME_LENGTH);
    MP3_FRAME.copy(frame, 0);
    if (i === 0 && xingFrames !== null) {
      // Side info is 32 bytes for MPEG-1 stereo; then "Xing", flags, frames.
      frame.write('Xing', 36, 'latin1');
      frame.writeUInt32BE(0x01, 40);
      frame.writeUInt32BE(xingFrames, 44);
    }
    parts.push(frame);
  }
  return Buffer.concat(parts);
}

/** An mvhd atom (version 0 or 1) inside a moov box, with junk around it. */
function m4a({ timescale, duration, version = 0, before = 0, after = 0 }) {
  const mvhd = Buffer.alloc(version === 0 ? 108 : 120);
  mvhd.writeUInt32BE(mvhd.length, 0);
  mvhd.write('mvhd', 4, 'latin1');
  mvhd[8] = version;
  if (version === 0) {
    mvhd.writeUInt32BE(timescale, 20);
    mvhd.writeUInt32BE(duration, 24);
  } else {
    mvhd.writeUInt32BE(timescale, 28);
    mvhd.writeBigUInt64BE(BigInt(duration), 32);
  }
  return Buffer.concat([Buffer.alloc(before, 0x11), Buffer.from('moov', 'latin1'), mvhd, Buffer.alloc(after, 0x22)]);
}

describe('audioDurationSeconds', () => {
  it('wav: data bytes over the byte rate, skipping other chunks, and the file size for a streamed header', () => {
    expect(audioDurationSeconds({ contentType: 'audio/wav', bytes: 0, head: wav({ byteRate: 32000, dataBytes: 320_000 }) })).toBe(10);
    expect(audioDurationSeconds({ contentType: 'audio/wav', bytes: 0, head: wav({ byteRate: 176_400, dataBytes: 176_400 * 3, extraChunk: true }) })).toBe(3);
    const streamed = wav({ byteRate: 32000, dataBytes: 0xffffffff });
    expect(audioDurationSeconds({ contentType: 'audio/wav', bytes: streamed.length + 64_000, head: streamed })).toBe(2);
    expect(audioDurationSeconds({ contentType: 'audio/wav', bytes: 0, head: Buffer.from('RIFF....WAVEjunk') })).toBeNull();
  });

  it('mp3: file size over the bitrate for constant bitrate, the Xing frame count for variable, an ID3 tag skipped', () => {
    const cbr = mp3({ frames: 3 });
    // 3 frames at 128 kbps: 3 × 417 bytes × 8 / 128000 ≈ 0.078 s; the file size rules, so a 1,600,000-byte file at 128 kbps is 100 s.
    expect(audioDurationSeconds({ contentType: 'audio/mpeg', bytes: 1_600_000, head: cbr })).toBeCloseTo(100, 6);
    const tagged = mp3({ frames: 3, id3: 500 });
    expect(audioDurationSeconds({ contentType: 'audio/mpeg', bytes: 1_600_000 + 510, head: tagged })).toBeCloseTo(100, 6);
    const vbr = mp3({ frames: 2, xingFrames: 4410 });
    // 4410 frames × 1152 samples at 44.1 kHz = 115.2 s, whatever the size says.
    expect(audioDurationSeconds({ contentType: 'audio/mpeg', bytes: 99, head: vbr })).toBeCloseTo(115.2, 6);
    expect(audioDurationSeconds({ contentType: 'audio/mpeg', bytes: 100, head: Buffer.from('not an mp3 at all, no sync word here') })).toBeNull();
  });

  it('m4a: the mvhd atom at the front or the back of the file, in both versions', () => {
    expect(audioDurationSeconds({ contentType: 'audio/mp4', bytes: 0, head: m4a({ timescale: 1000, duration: 90_000 }) })).toBe(90);
    expect(audioDurationSeconds({ contentType: 'audio/mp4', bytes: 0, head: m4a({ timescale: 48000, duration: 48000 * 7, version: 1, before: 300 }) })).toBe(7);
    const atEnd = m4a({ timescale: 1000, duration: 5000 });
    expect(audioDurationSeconds({ contentType: 'audio/mp4', bytes: 0, head: Buffer.alloc(64, 0x33), tail: atEnd })).toBe(5);
    expect(audioDurationSeconds({ contentType: 'audio/mp4', bytes: 0, head: Buffer.alloc(64, 0x33) })).toBeNull();
    expect(audioDurationSeconds({ contentType: 'audio/mp4', bytes: 0, head: m4a({ timescale: 0, duration: 5 }) })).toBeNull();
  });

  it('answers null for an unknown type, an empty head or a header that throws, never a guess', () => {
    expect(audioDurationSeconds({ contentType: 'audio/ogg', bytes: 10, head: Buffer.from('OggS') })).toBeNull();
    expect(audioDurationSeconds({ contentType: 'audio/wav', bytes: 10, head: Buffer.alloc(0) })).toBeNull();
    expect(audioDurationSeconds({ contentType: 'audio/wav', bytes: 10, head: 'not a buffer' })).toBeNull();
    expect(audioDurationSeconds({ contentType: 'audio/mp4', bytes: 10, head: Buffer.from('mvhd', 'latin1') })).toBeNull();
  });

  it('tooLong holds the 9.5-hour line exactly and ignores an unknown length', () => {
    expect(MAX_AUDIO_SECONDS).toBe(34_200);
    expect(tooLong(MAX_AUDIO_SECONDS)).toBe(false);
    expect(tooLong(MAX_AUDIO_SECONDS + 0.001)).toBe(true);
    expect(tooLong(null)).toBe(false);
    expect(tooLong(undefined)).toBe(false);
  });
});

describe('probeAudioDuration', () => {
  it('reads the first 256 KiB, and the last 256 KiB too for an m4a larger than that, by range', async () => {
    const atEnd = m4a({ timescale: 1000, duration: 12_000 });
    const storage = {
      readBlobRangeForDelivery: vi.fn(async (container, path, { start }) => ({ body: start === 0 ? Buffer.alloc(64, 0x33) : atEnd })),
    };
    const total = PROBE_BYTES * 3;
    await expect(probeAudioDuration(storage, { container: 'interviews-audio', path: 'audio/x.m4a', contentType: 'audio/mp4', bytes: total })).resolves.toBe(12);
    expect(storage.readBlobRangeForDelivery.mock.calls.map(([, , range]) => range)).toEqual([
      { start: 0, end: PROBE_BYTES - 1 },
      { start: total - PROBE_BYTES, end: total - 1 },
    ]);
    const small = { readBlobRangeForDelivery: vi.fn(async () => ({ body: wav({ byteRate: 32000, dataBytes: 32000 }) })) };
    await expect(probeAudioDuration(small, { container: 'c', path: 'p', contentType: 'audio/wav', bytes: 44 })).resolves.toBe(1);
    expect(small.readBlobRangeForDelivery).toHaveBeenCalledWith('c', 'p', { start: 0, end: 43 });
  });

  it('answers null for a blob that is missing or unreadable', async () => {
    await expect(probeAudioDuration({ readBlobRangeForDelivery: vi.fn(async () => null) }, { container: 'c', path: 'p', contentType: 'audio/wav', bytes: 10 })).resolves.toBeNull();
    await expect(probeAudioDuration({ readBlobRangeForDelivery: vi.fn(async () => ({ unsatisfiable: true })) }, { container: 'c', path: 'p', contentType: 'audio/wav', bytes: 10 })).resolves.toBeNull();
  });
});

describe('mp3 frame headers of every kind', () => {
  const frames = (header, length, count = 3) => Buffer.concat(Array.from({ length: count }, () => Buffer.concat([header, Buffer.alloc(length - 4)])));

  it('reads MPEG-2 layer III mono, MPEG-1 layer II and layer I, and a padded frame', () => {
    // MPEG-2 (0xf3: version 10, layer III), 64 kbps (index 8), 22.05 kHz, mono: 576 samples a frame, 72 × 64000 / 22050 = 208 bytes.
    const mpeg2 = Buffer.from([0xff, 0xf3, 0x80, 0xc0]);
    expect(audioDurationSeconds({ contentType: 'audio/mpeg', bytes: 800_000, head: frames(mpeg2, 208) })).toBeCloseTo(100, 6);
    // MPEG-1 layer II (0xfd), 192 kbps (index 10), 44.1 kHz: 1152 samples, 144 × 192000 / 44100 = 626 bytes.
    const layer2 = Buffer.from([0xff, 0xfd, 0xa0, 0x00]);
    expect(audioDurationSeconds({ contentType: 'audio/mpeg', bytes: 2_400_000, head: frames(layer2, 626) })).toBeCloseTo(100, 6);
    // MPEG-1 layer I (0xff), 384 kbps (index 12), 44.1 kHz: 12 × 384000 / 44100 = 104 slots × 4 = 416 bytes.
    const layer1 = Buffer.from([0xff, 0xff, 0xc0, 0x00]);
    expect(audioDurationSeconds({ contentType: 'audio/mpeg', bytes: 4_800_000, head: frames(layer1, 416) })).toBeCloseTo(100, 6);
    // Padding bit set on the 128 kbps frame: 417.96 + 1 → 418 bytes a frame.
    const padded = Buffer.from([0xff, 0xfb, 0x92, 0x00]);
    expect(audioDurationSeconds({ contentType: 'audio/mpeg', bytes: 1_600_000, head: frames(padded, 418) })).toBeCloseTo(100, 6);
  });

  it('skips a header with a reserved version, layer, bitrate or sample rate, and a Xing header without a frame count', () => {
    for (const header of [
      Buffer.from([0xff, 0xeb, 0x90, 0x00]), // version bits 01: reserved
      Buffer.from([0xff, 0xf9, 0x90, 0x00]), // layer bits 00: reserved
      Buffer.from([0xff, 0xfb, 0xf0, 0x00]), // bitrate index 15: bad
      Buffer.from([0xff, 0xfb, 0x9c, 0x00]), // sample rate index 3: reserved
      Buffer.from([0xff, 0xfb, 0x00, 0x00]), // bitrate index 0: free format, not sized
    ]) {
      expect(audioDurationSeconds({ contentType: 'audio/mpeg', bytes: 1_000_000, head: Buffer.concat([header, Buffer.alloc(2000)]) }), header.toString('hex')).toBeNull();
    }
    const noCount = frames(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 417, 2);
    noCount.write('Xing', 36, 'latin1');
    noCount.writeUInt32BE(0x02, 40); // bytes flag only, no frames
    expect(audioDurationSeconds({ contentType: 'audio/mpeg', bytes: 1_600_000, head: noCount })).toBeCloseTo(100, 6);
  });
});
