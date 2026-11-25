/**
 * The 4 MiB blocks an interview recording is read and sent in, and the
 * SHA-256 computed over them one slice at a time. Split out of
 * interviewUpload.js, which re-exports the public parts.
 */
import { Sha256 } from '@/lib/sha256';
import { UploadError } from './interviewAudioFile';

/** Bytes per block; the server's BLOCK_SIZE. */
export const BLOCK_SIZE = 4 * 1024 * 1024;

/** The byte range of block `index`. */
export function blockRange(size, index, blockSize = BLOCK_SIZE) {
  const start = index * blockSize;
  return [start, Math.min(size, start + blockSize)];
}

/**
 * A slice's bytes. `Blob.arrayBuffer` where it exists, a FileReader where it
 * does not. Exported for interviewUpload.js, which reads each block to send.
 */
export function readSlice(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * The file's SHA-256 as hex, read one 4 MiB slice at a time. Rejects with
 * `HASH_FAILED` when a slice cannot be read; never resolves to ''.
 *
 * @param {Blob} file
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal, blockSize?: number }} [options]
 * @returns {Promise<string>}
 */
export async function hashFile(file, { onProgress, signal, blockSize = BLOCK_SIZE } = {}) {
  const digest = new Sha256();
  const size = Number(file?.size) || 0;
  const count = Math.max(1, Math.ceil(size / blockSize));
  try {
    for (let index = 0; index < count; index += 1) {
      if (signal?.aborted) throw new UploadError('The upload was stopped.', 'ABORTED');
      const [start, end] = blockRange(size, index, blockSize);
      digest.update(new Uint8Array(await readSlice(file.slice(start, end))));
      onProgress?.(end, size);
    }
    const hex = digest.hex();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('bad digest');
    return hex;
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(
      'The recording could not be read to check it. Choose the file again and retry.',
      'HASH_FAILED'
    );
  }
}
