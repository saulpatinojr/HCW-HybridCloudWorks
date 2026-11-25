/**
 * The PNG writer generate-brand-art.mjs encodes its art with (moved out of
 * that file by #1845). Written here so the bytes depend on node:zlib alone
 * and not on a library's defaults; generate-brand-art.mjs re-exports
 * encodePng, which generate-brand-art.test.js decodes and checks.
 */
import { crc32, deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The five PNG filter types, in their numbered order. */
const FILTER_COUNT = 5;

/**
 * The PNG Paeth predictor: of the byte to the left (a), above (b) and above
 * left (c), the one nearest to a + b - c, preferring a, then b, on a tie.
 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Each filter's guess at a byte from its left (a), above (b) and above-left (c) neighbours. */
const PREDICTORS = [
  () => 0,
  (a) => a,
  (a, b) => b,
  (a, b) => (a + b) >> 1,
  (a, b, c) => paeth(a, b, c),
];

/**
 * Write one row filtered with filter `f` into `out` and return the sum of
 * its absolute residuals, the measure the encoder picks a filter by.
 */
function filterRow(row, prev, f, out) {
  const predict = PREDICTORS[f];
  let sum = 0;
  for (let i = 0; i < row.length; i += 1) {
    const a = i >= 4 ? row[i - 4] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= 4 ? prev[i - 4] : 0;
    const v = (row[i] - predict(a, b, c)) & 0xff;
    out[i] = v;
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

/** The filter with the smallest residual sum for this row (the lowest number on a tie). */
function bestFilter(row, prev, candidates) {
  let best = 0;
  let bestSum = Infinity;
  for (let f = 0; f < FILTER_COUNT; f += 1) {
    const sum = filterRow(row, prev, f, candidates[f]);
    if (sum < bestSum) {
      bestSum = sum;
      best = f;
    }
  }
  return best;
}

/** The image data before compression: each row prefixed by the number of its filter. */
function filteredScanlines(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidates = Array.from({ length: FILTER_COUNT }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y += 1) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    const best = bestFilter(row, prev, candidates);
    raw[y * (stride + 1)] = best;
    candidates[best].copy(raw, y * (stride + 1) + 1);
  }
  return raw;
}

/** One PNG chunk: length, type, data and the CRC of type and data. */
function chunk(type, data) {
  const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(head) >>> 0);
  return Buffer.concat([len, head, crc]);
}

/** The IHDR payload for 8-bit RGBA (colour type 6) at this size. */
function headerData(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return ihdr;
}

/**
 * Minimal PNG writer: 8-bit RGBA (colour type 6, like azure-hero/), one IDAT,
 * per-row filter chosen by the smallest sum of absolute residuals, deflate
 * level 9.
 */
export function encodePng(width, height, rgba) {
  const expected = width * 4 * height;
  if (rgba.length !== expected) {
    throw new Error(`pixel buffer is ${rgba.length} bytes, expected ${expected}`);
  }
  const raw = filteredScanlines(width, height, rgba);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', headerData(width, height)),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
