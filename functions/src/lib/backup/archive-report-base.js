/**
 * archive-report-base.js — the constants, blob names and stream readers the
 * yearly content archive's dry run shares between its parts (ADR 0046,
 * issue #1811). The dry run itself is described in archive-report.js, which
 * re-exports everything here that it exported before. It is split over a few
 * files only to keep each one short:
 *
 *   archive-report-base.js       constants, names, reading a gzip file line by line
 *   archive-report-fields.js     which field names may be printed, and which look sensitive
 *   archive-report-gate.js       when an archive may start
 *   archive-report-reading.js    the newest backup, a queue message, the newest report
 *   archive-report-worker.js     one container's part of a report, and the finished report
 *   archive-report-tally.js      the counting behind one part
 *   archive-report-name-counts.js  bounded counters of field names
 *   archive-report-summary.js    what one part says once every record is counted
 *   archive-report-scheduler.js  starting a dry run, and removing old reports
 */
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

/** The private blob container a yearly archive is written to (Terraform: infra/storage.tf). */
export const ARCHIVE_CONTAINER = 'content-archive';
/** The app setting that lets the yearly archive start. Anything but the exact text `true` is off. */
export const ARCHIVE_SETTING = 'CONTENT_ARCHIVE_ENABLED';
/** The platform job type one message per container is queued as. */
export const REPORT_JOB_TYPE = 'content-archive-dry-run';
/** Where reports live in `cosmos-export-state` (the export blob store sends `state/` names there). */
export const REPORT_PREFIX = 'state/archive-report/';
/** How far back the newest complete full backup is looked for: the backup keeps 35 days. */
export const BACKUP_LOOKBACK_DAYS = 35;
/** The most field names one container's part lists. */
export const MAX_FIELD_NAMES = 100;
/** The most distinct names counted while one file is read; past that, a new name is only counted as "other". Keeps memory flat when ids are used as names. */
export const MAX_TALLIED_NAMES = 2000;
/** The longest field name that is printed. */
export const MAX_NAME_LENGTH = 40;
/** A name is printed only when at least this many records carry it... */
export const MIN_NAME_RECORDS = 2;
/** ...and at least this share of the container's records (1 in 100), whichever is more. */
export const MIN_NAME_SHARE = 0.01;
/** The most names that look sensitive one container's part lists. */
export const MAX_SENSITIVE_NAMES = 40;
/** How deep, and how many values, one record is searched for a name that looks sensitive. */
export const SENSITIVE_MAX_DEPTH = 8;
export const SENSITIVE_MAX_NODES = 5000;
/** A dry run that has not finished after this long is called "did not finish", and a new one may start. */
export const RUN_STALE_MINUTES = 30;
/** Reports older than this are deleted when a new dry run starts. */
export const REPORT_KEEP_DAYS = 90;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const REPORT_ID = /^\d{8}T\d{4}Z$/;
export const RUN_ID = /^\d{4}-\d{2}-\d{2}$/;

export const count = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

export const bump = (map, key) => {
  map[key] = (map[key] || 0) + 1;
};

/** `20270207T0412Z`: the minute a report was asked for, in UTC. */
export function reportIdFor(date) {
  return `${new Date(date).toISOString().slice(0, 16).replace(/[-:]/g, '')}Z`;
}

/** Every blob one report touches. */
export function reportNames(reportId, container = '') {
  const prefix = `${REPORT_PREFIX}${reportId}/`;
  return {
    prefix,
    run: `${prefix}run.json`,
    part: `${prefix}${container}.part.json`,
    report: `${prefix}report.json`,
    latest: `${REPORT_PREFIX}latest.json`,
  };
}

/** `2026/manifest.json` in `content-archive`: the file whose presence means "this year is archived". */
export const archiveManifestName = (year) => `${year}/manifest.json`;

/** The year an archive taken on `now` is of: always the calendar year before, in UTC. */
export function archiveYearFor(now) {
  return new Date(now).getUTCFullYear() - 1;
}

/** The UTC time a report id names, in milliseconds, or null. */
export function reportIdTime(reportId) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(String(reportId || ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Every line of a gzip NDJSON stream, one at a time. A failure of the source
 * or of the decompression ends the loop with that error.
 * @param {import('node:stream').Readable} source
 */
export async function* gzipLines(source) {
  const gunzip = createGunzip();
  const piping = pipeline(source, gunzip);
  // The loop below sees the same failure through `gunzip`; this only stops it being reported twice.
  piping.catch(() => {});
  const decoder = new StringDecoder('utf8');
  let tail = '';
  for await (const chunk of gunzip) {
    tail += decoder.write(chunk);
    let at = tail.indexOf('\n');
    while (at >= 0) {
      yield tail.slice(0, at);
      tail = tail.slice(at + 1);
      at = tail.indexOf('\n');
    }
  }
  tail += decoder.end();
  if (tail.trim()) yield tail;
  await piping;
}

/**
 * Each non-empty line of a gzip NDJSON stream as a record, or `undefined`
 * for a line that is not JSON (the caller counts it as unreadable).
 * @param {import('node:stream').Readable} source
 * @param {AbortSignal} [signal]
 */
export async function* gzipRecords(source, signal) {
  for await (const line of gzipLines(source)) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    if (!line.trim()) continue;
    yield parsedOrUndefined(line);
  }
}

function parsedOrUndefined(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
