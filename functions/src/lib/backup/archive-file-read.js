/**
 * archive-file-read.js — reading the files the yearly content archive works
 * with: a weekly backup's file, record by record, and an archive file read
 * back after it is written (ADR 0046 section 4, issue #1811). Used by
 * archive-worker.js; the whole job is described in archive-job.js.
 *
 * Each function takes the worker's `deps` first (only the blob stores are read).
 */
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { blobNames } from './cosmos-export.js';
import { createContentIndex } from './archive-classification.js';
import { gzipLines, gzipRecords } from './archive-report-base.js';

/** Each line of one backup file as a record, or `undefined` for a line that is not JSON. */
export async function* backupRecords({ backupBlobs }, runId, container, signal) {
  const source = await backupBlobs.readGzipStream(blobNames({ mode: 'full', runId, container }).data);
  if (!source) throw new Error('the backup file for this container is not there');
  yield* gzipRecords(source, signal);
}

/** The ids of `content` the versions rule needs, read from the same backup. */
export async function contentIndexFor(deps, runId, signal) {
  const index = createContentIndex();
  for await (const doc of backupRecords(deps, runId, 'content', signal)) index.add(doc);
  return index;
}

/** Read a written file back: its sha256, its size, and how many records it holds. */
export async function readBack({ archiveBlobs }, name) {
  const source = await archiveBlobs.readGzipStream(name);
  if (!source) return null;
  const hash = createHash('sha256');
  let bytes = 0;
  let records = 0;
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  const piping = pipeline(source, tap);
  // The loop below sees the same failure through `tap`; this only stops it being reported twice.
  piping.catch(() => {});
  for await (const line of gzipLines(tap)) if (line.trim()) records += 1;
  await piping;
  return { sha256: hash.digest('hex'), bytes, records };
}
