/**
 * gemini-audio.js — reading the audio out of a Gemini speech reply: finding
 * the audio blocks, decoding raw PCM or a WAV container, checking the
 * format, and mixing down to mono for mp3.js. Also the error every Gemini
 * speech step throws. gemini.js says how a dialogue is voiced and exports
 * all of this again.
 */

/**
 * What the speech guide says the models produce, and the rate assumed for a
 * raw-PCM block that carries no `sample_rate`. A block that carries one wins.
 */
export const PCM_SAMPLE_RATE = 24000;

/** Mime types that mean headerless signed 16-bit little-endian PCM. */
const RAW_PCM_MIMES = new Set(['audio/l16', 'audio/pcm', 'audio/x-pcm', 'audio/raw']);
/** Mime types that mean a RIFF/WAVE container around the same samples. */
const WAV_MIMES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

export class GeminiSpeechError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'SpeechError';
    this.status = status;
    this.provider = 'gemini';
  }
}

/**
 * Every audio content block in the reply, in the order the model produced it.
 *
 * The SDK-style `output_audio` accessor is checked first so that a REST
 * revision adding it keeps working; otherwise the `model_output` steps are
 * walked. Anything that is not audio — text, a tool call — is skipped here
 * and named by `describeShape` when nothing is left. An audio item with no
 * `data` is not skipped: that is a malformed block, and dropping it would
 * report the generic "no audio" for a reply that did try to carry some.
 */
function audioBlocks(payload) {
  if (payload?.output_audio?.data) return [payload.output_audio];
  const blocks = [];
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  steps.forEach((step, stepIndex) => {
    if (step?.type !== 'model_output' || !Array.isArray(step.content)) return;
    step.content.forEach((item, itemIndex) => {
      if (item?.type !== 'audio') return;
      if (!item.data) {
        throw new GeminiSpeechError(
          `Gemini returned an audio block with no data (step ${stepIndex + 1}, item ${itemIndex + 1}; mime ${String(item.mime_type || 'unspecified').slice(0, 40)})`
        );
      }
      blocks.push(item);
    });
  });
  return blocks;
}

function isRiffWave(bytes) {
  return (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WAVE'
  );
}

/**
 * Read a RIFF/WAVE header for its format and return the samples after it.
 *
 * The canonical header is 44 bytes — `RIFF`, size, `WAVE`, a 16-byte `fmt `
 * chunk and the `data` chunk header — but the chunks are walked rather than
 * read at fixed offsets, because an encoder is free to put a `LIST` chunk
 * before `data`, and a fixed 44-byte skip would then hand the encoder a
 * header as if it were samples.
 *
 * @param {Buffer} bytes
 * @returns {{pcm: Buffer, sampleRate: number, channels: number}}
 */
export function parseWav(bytes) {
  if (!isRiffWave(bytes)) {
    throw new GeminiSpeechError('Gemini labelled the audio as WAV but it has no RIFF/WAVE header');
  }
  let format = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = readFmtChunk(bytes, body, size);
    } else if (id === 'data') {
      return dataChunk(bytes, body, size, format);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new GeminiSpeechError('WAV audio has no data chunk');
}

/** The format a `fmt ` chunk declares, rejected before any sample is read. */
function readFmtChunk(bytes, body, size) {
  // The chunk declares its own size; a short one must not be read into
  // the chunk after it and passed off as a sample rate.
  if (size < 16 || body + 16 > bytes.length) {
    throw new GeminiSpeechError('malformed WAV: fmt chunk too short');
  }
  const format = {
    codec: bytes.readUInt16LE(body),
    channels: bytes.readUInt16LE(body + 2),
    sampleRate: bytes.readUInt32LE(body + 4),
    bitsPerSample: bytes.readUInt16LE(body + 14),
  };
  // Rejected here, before any sample is read: a header is untrusted
  // input, and 0 Hz or 0 channels would otherwise reach the duration
  // arithmetic and the encoder as a divide-by-zero.
  if (format.codec !== 1 || format.bitsPerSample !== 16) {
    throw new GeminiSpeechError(
      `WAV audio is format ${format.codec} at ${format.bitsPerSample}-bit; only 16-bit PCM can be encoded`
    );
  }
  assertFormat(format, 'WAV audio');
  return format;
}

/** The samples a `data` chunk carries, in the format the `fmt ` chunk declared. */
function dataChunk(bytes, body, size, format) {
  if (!format) throw new GeminiSpeechError('WAV audio has a data chunk before its fmt chunk');
  // A streaming writer may leave the size 0 or 0xFFFFFFFF; the bytes that
  // are actually present are the truth either way.
  const end = size === 0 || body + size > bytes.length ? bytes.length : body + size;
  return {
    pcm: bytes.subarray(body, end),
    sampleRate: format.sampleRate,
    channels: format.channels,
  };
}

/**
 * The band of sample rates this module will encode. 8 kHz is telephone
 * speech and 96 kHz is studio; a value outside it is a corrupt header or a
 * field the API has started using differently, not a rate to trust.
 */
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 96000;

/**
 * A format read from a WAV header or an audio block is untrusted input.
 * Mono or stereo only, because that is what downmixToMono knows how to fold,
 * and a rate inside the band above — 0 Hz, NaN or 0 channels would reach
 * pcmDurationSeconds and the encoder as a divide-by-zero.
 */
function assertFormat({ sampleRate, channels }, where) {
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new GeminiSpeechError(`${where}: ${channels} channels is not mono or stereo`);
  }
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate < MIN_SAMPLE_RATE ||
    sampleRate > MAX_SAMPLE_RATE
  ) {
    throw new GeminiSpeechError(
      `${where}: ${sampleRate} Hz is outside the ${MIN_SAMPLE_RATE}–${MAX_SAMPLE_RATE} Hz band this module encodes`
    );
  }
}

/** A field that is present, as a number; null when the block omits it. */
function fieldNumber(value) {
  return value === undefined || value === null || value === '' ? null : Number(value);
}

/**
 * 16-bit PCM is whole samples or it is not audio. An odd length is a truncated
 * download or a format that is not what was assumed; encoding it anyway
 * produces noise at the end rather than an error, so it is refused here, as a
 * speech error, before the encoder sees it.
 */
export function assertPcm16(pcm, where) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
    throw new GeminiSpeechError(`${where}: no PCM samples`);
  }
  if (pcm.length % 2 !== 0) {
    throw new GeminiSpeechError(
      `${where}: ${pcm.length} bytes is not a whole number of 16-bit samples`
    );
  }
}

/** One audio block → headerless PCM plus what the block or its header said about it. */
function decodeBlock(block) {
  const bytes = Buffer.from(String(block.data), 'base64');
  if (bytes.length === 0) {
    // Buffer.from skips characters that are not base64 instead of throwing,
    // so a block whose `data` is present but not base64 decodes to nothing.
    throw new GeminiSpeechError(
      'Gemini returned an audio block whose data is empty or not valid base64'
    );
  }
  const [mime, ...params] = String(block.mime_type || '')
    .toLowerCase()
    .split(';')
    .map((part) => part.trim());

  if (isRiffWave(bytes) || WAV_MIMES.has(mime)) {
    const parsed = parseWav(bytes);
    assertPcm16(parsed.pcm, 'Gemini WAV audio');
    return parsed;
  }

  if (mime && !RAW_PCM_MIMES.has(mime)) {
    throw new GeminiSpeechError(
      `Gemini returned audio as ${mime}, which this module cannot decode (it expects raw PCM or WAV)`
    );
  }

  // RFC 2586 lets audio/L16 carry its rate as a parameter; the block's own
  // sample_rate field is the documented place and wins when both are present.
  // A field that is present is validated as written — a `0` is a malformed
  // block, not a request for the default — and only an absent one defaults.
  const rateParam = params.find((p) => p.startsWith('rate='));
  const sampleRate =
    fieldNumber(block.sample_rate) ??
    (rateParam ? Number(rateParam.slice('rate='.length)) : null) ??
    PCM_SAMPLE_RATE;
  const channels = fieldNumber(block.channels) ?? 1;
  assertFormat({ sampleRate, channels }, 'Gemini audio block');
  assertPcm16(bytes, 'Gemini audio block');
  return { pcm: bytes, sampleRate, channels };
}

/**
 * The audio in an Interactions reply as one PCM buffer, or null if it has none.
 *
 * Pure: reads the payload, touches no network. Several audio blocks are joined
 * in order; blocks that disagree on rate or channel count cannot be joined
 * without resampling and are refused rather than played at the wrong speed.
 *
 * @param {object} payload the parsed Interaction object
 * @returns {{pcm: Buffer, sampleRate: number, channels: number} | null}
 *   interleaved signed 16-bit little-endian samples, header stripped
 */
export function extractAudio(payload) {
  const parts = audioBlocks(payload).map(decodeBlock);
  if (parts.length === 0) return null;

  const [{ sampleRate, channels }] = parts;
  const odd = parts.find((p) => p.sampleRate !== sampleRate || p.channels !== channels);
  if (odd) {
    throw new GeminiSpeechError(
      `Gemini returned audio blocks in different formats (${sampleRate} Hz ${channels}-channel and ${odd.sampleRate} Hz ${odd.channels}-channel), which cannot be joined`
    );
  }

  const pcm = parts.length === 1 ? parts[0].pcm : Buffer.concat(parts.map((p) => p.pcm));
  return { pcm, sampleRate, channels };
}

/**
 * Average interleaved channels into one, because mp3.js encodes mono.
 * A dialogue is one sound stage, so nothing a listener would miss is lost.
 *
 * @param {Buffer} pcm interleaved signed 16-bit little-endian samples
 * @param {number} channels
 * @returns {Buffer} mono samples; the same buffer when it already was
 */
export function downmixToMono(pcm, channels) {
  if (!(channels > 1)) return pcm;
  const frameBytes = channels * 2;
  if (pcm.length % frameBytes !== 0) {
    throw new GeminiSpeechError(
      `${pcm.length} bytes is not a whole number of ${channels}-channel 16-bit frames`
    );
  }
  const frames = pcm.length / frameBytes;
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm.readInt16LE(i * frameBytes + c * 2);
    mono.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return mono;
}

