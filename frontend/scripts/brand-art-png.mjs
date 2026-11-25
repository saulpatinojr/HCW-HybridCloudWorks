/**
 * A small PNG encoder for generate-brand-art.mjs: filters each row, then
 * deflates it with zlib. Split out of generate-brand-art.mjs, which
 * re-exports `encodePng`.
 */
import { crc32, deflateSync } from 'node:zlib';

/** The Paeth predictor: whichever neighbour is closest to `a + b - c`. */
function paeth(a, b, c) {
  const pp = a + b - c;
  const pa = Math.abs(pp - a);
  const pb = Math.abs(pp - b);
  const pc = Math.abs(pp - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * The byte each PNG filter predicts from the pixel to the left (`a`), above
 * (`b`) and above-left (`c`), indexed by filter type: None, Sub, Up, Average
 * and Paeth.
 */
const PREDICTORS = [() => 0, (a) => a, (a, b) => b, (a, b) => (a + b) >> 1, paeth];
const predictByte = (f, a, b, c) => PREDICTORS[f](a, b, c);

/**
 * Writes one row filtered with filter `f` into `out` and returns the sum of
 * absolute residuals, the score the smallest of which is kept.
 */
function filterRow(f, row, prev, out) {
  let sum = 0;
  for (let i = 0; i < row.length; i += 1) {
    const a = i >= 4 ? row[i - 4] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= 4 ? prev[i - 4] : 0;
    const v = (row[i] - predictByte(f, a, b, c)) & 0xff;
    out[i] = v;
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

/** One PNG chunk: length, type, data and CRC. */
function pngChunk(type, data) {
  const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(head) >>> 0);
  return Buffer.concat([len, head, crc]);
}

/**
 * Minimal PNG writer: 8-bit RGBA (colour type 6, like azure-hero/), one IDAT,
 * per-row filter chosen by the smallest sum of absolute residuals, deflate
 * level 9. Written here so the bytes depend on node:zlib alone and not on a
 * library's defaults.
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new Error(`pixel buffer is ${rgba.length} bytes, expected ${stride * height}`);
  }
  const raw = Buffer.alloc((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y += 1) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f += 1) {
      const sum = filterRow(f, row, prev, candidates[f]);
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    candidates[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
