/**
 * The incremental SHA-256 the interview upload declares (lib/sha256.js),
 * checked against the FIPS 180-4 example vectors and against Node's own
 * implementation over random input cut into uneven pieces, including the
 * padding edges (55, 56 and 64 bytes) where a hand-written digest goes wrong.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Sha256, sha256Hex } from '@/lib/sha256';

const utf8 = (text) => new TextEncoder().encode(text);
const nodeHex = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('Sha256', () => {
  it('matches the standard’s example vectors', () => {
    expect(sha256Hex(utf8(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(sha256Hex(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    );
  });

  it('matches a million "a" fed in pieces', () => {
    const digest = new Sha256();
    const piece = utf8('a'.repeat(1000));
    for (let i = 0; i < 1000; i += 1) digest.update(piece);
    expect(digest.hex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('agrees with Node at every padding edge', () => {
    for (const size of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const bytes = randomBytes(size);
      expect(sha256Hex(bytes), String(size)).toBe(nodeHex(bytes));
    }
  });

  it('gives the same digest however the input is cut', () => {
    const bytes = randomBytes(10_000);
    const expected = nodeHex(bytes);
    for (const cut of [1, 3, 63, 64, 65, 1000, 4096]) {
      const digest = new Sha256();
      for (let start = 0; start < bytes.length; start += cut) {
        digest.update(bytes.subarray(start, start + cut));
      }
      expect(digest.hex(), String(cut)).toBe(expected);
    }
  });

  it('takes an ArrayBuffer as well as a Uint8Array', () => {
    const bytes = randomBytes(200);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(new Sha256().update(buffer).hex()).toBe(nodeHex(bytes));
  });

  it('refuses to be used after it is finished, rather than give a wrong digest', () => {
    const digest = new Sha256().update(utf8('abc'));
    digest.hex();
    expect(() => digest.update(utf8('d'))).toThrow(/already finished/);
    expect(() => digest.hex()).toThrow(/already finished/);
  });
});
