/**
 * archive-report.js — the dry run of the yearly content archive, and the
 * rule that says when an archive may start (ADR 0046, issue #1811).
 *
 * WHAT A DRY RUN IS. It reads the newest complete weekly full backup (the
 * files cosmos-export.js writes into the private `cosmos-export` blob
 * container), puts every record through the archive classification
 * (archive-classification.js), and writes down what an archive made from
 * that backup WOULD hold: per container, how many records would be kept,
 * how many would have fields taken out, how many would be left out and why.
 * For the seven containers the owner has not classified yet it also lists
 * the NAMES of the top-level fields, so the owner can say what each one is.
 *
 * WHAT IT NEVER DOES. It writes nothing into `content-archive`, changes no
 * record and no backup file, and keeps no record, no id and no field value:
 * names of containers, names of fields, counts, sizes and times only.
 *
 * WHERE THE REPORT IS KEPT. In the private `cosmos-export-state` blob
 * container, under `state/archive-report/<report>/`. That container is the
 * backup's own working state (it has no rule that deletes files and none
 * that locks them), so the report does not depend on `content-archive`
 * existing yet and never mixes with a real archive.
 *
 * HOW ONE RUN WORKS. The admin route (archive-handlers.js) finds the backup,
 * claims a report id by writing `run.json` create-only (so a double press
 * makes one run), and queues one platform job per container to read. Each
 * job streams one backup file through gunzip a line at a time, so memory
 * stays flat however large the container is, and writes one small part
 * file. The job that finds every part present writes `report.json`,
 * create-only, so two jobs finishing together cannot both write it.
 *
 * THE START RULE. `archiveStartDecision` is the whole of "once a year, never
 * in January, only when switched on" (ADR 0046 section 4). Nothing calls it
 * to start an archive yet: the job that writes one is phase 3. The status
 * route uses it to tell the owner what would happen today.
 */
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';
import { withStatus } from '../http/error-response.js';
import { blobNames } from './cosmos-export.js';
import {
  DECISIONS,
  REASONS,
  UNCLASSIFIED,
  archiveClassifiedContainers,
  archiveDecisionFor,
  archivePlan,
  archiveRecord,
  createContentIndex,
} from './archive-classification.js';

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
/** The most distinct field names one container's part lists; more than that reads as data used as names. */
export const MAX_FIELD_NAMES = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_ID = /^\d{8}T\d{4}Z$/;
const RUN_ID = /^\d{4}-\d{2}-\d{2}$/;
/** A field name that is safe to repeat: a plain identifier, not text someone typed. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

// ── Names ────────────────────────────────────────────────────────────────────

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

// ── When an archive may start (ADR 0046 section 4) ──────────────────────────

/** The year an archive taken on `now` is of: always the calendar year before, in UTC. */
export function archiveYearFor(now) {
  return new Date(now).getUTCFullYear() - 1;
}

/**
 * May the yearly archive start now? All four must hold:
 *
 *   1. the switch `CONTENT_ARCHIVE_ENABLED` is exactly `true`;
 *   2. today is on or after 1 February (UTC), so January is the month of grace;
 *   3. last year's `manifest.json` does not exist (a year is archived once);
 *   4. a complete full backup dated on or after 2 February exists (the day
 *      after the yearly clean-up of talk proposals runs).
 *
 * `manifestExists` and `backupRunId` are `null` when they could not be read;
 * not known is never read as "go".
 *
 * @param {object} facts
 * @param {Record<string, string|undefined>} facts.env
 * @param {Date} facts.now
 * @param {boolean|null} facts.manifestExists
 * @param {string|null} facts.backupRunId - the newest complete full backup's date, `YYYY-MM-DD`
 * @returns {{ start: boolean, year: number, earliestBackup: string, blockers: string[] }}
 */
export function archiveStartDecision({ env = process.env, now, manifestExists, backupRunId }) {
  const at = new Date(now);
  const year = archiveYearFor(at);
  const opens = Date.UTC(year + 1, 1, 1); // 1 February of the year after
  const earliestBackup = `${year + 1}-02-02`;
  const blockers = [];
  if (env?.[ARCHIVE_SETTING] !== 'true') blockers.push('switch-off');
  if (at.getTime() < opens) blockers.push('before-1-february');
  if (manifestExists === true) blockers.push('already-archived');
  else if (manifestExists !== false) blockers.push('archive-not-readable');
  if (typeof backupRunId !== 'string' || !RUN_ID.test(backupRunId)) blockers.push('no-backup');
  else if (backupRunId < earliestBackup) blockers.push('backup-too-early');
  return { start: blockers.length === 0, year, earliestBackup, blockers };
}

// ── Finding the backup ───────────────────────────────────────────────────────

const count = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

/**
 * The newest complete weekly full backup, or null. A full run is complete
 * when its `manifest.json` exists: the exporter writes it only after every
 * container's file is written (cosmos-export.js completeRunIfLast).
 *
 * @param {object} deps
 * @param {{ readJson: Function }} deps.blobs - the export blob store
 * @param {Date} deps.now
 * @param {number} [deps.lookbackDays]
 * @returns {Promise<{ runId: string, containers: { container: string, docs: number, bytes: number }[] }|null>}
 */
export async function findLatestFullBackup({ blobs, now, lookbackDays = BACKUP_LOOKBACK_DAYS }) {
  const start = new Date(now).getTime();
  for (let back = 0; back <= lookbackDays; back += 1) {
    const day = new Date(start - back * DAY_MS);
    if (day.getUTCDay() !== 0) continue; // the weekly full is Sunday's (cosmos-export.js modeFor)
    const runId = day.toISOString().slice(0, 10);
    const manifest = await blobs.readJson(blobNames({ mode: 'full', runId, container: '' }).manifest);
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.containers)) continue;
    const containers = manifest.containers
      .filter((row) => typeof row?.container === 'string' && row.container)
      .map((row) => ({ container: row.container, docs: count(row.docs), bytes: count(row.bytes) }));
    return { runId, containers };
  }
  return null;
}

// ── Reading one backup file ──────────────────────────────────────────────────

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

/** Validate a queue payload into `{ reportId, runId, container }`; throws (400) on anything else. */
export function parseReportPayload(payload = {}) {
  const reportId = String(payload?.reportId || '');
  const runId = String(payload?.runId || '');
  const container = String(payload?.container || '');
  if (!REPORT_ID.test(reportId)) throw withStatus(new Error('reportId is not a report id'), 400);
  if (!RUN_ID.test(runId)) throw withStatus(new Error('runId must be a UTC date, YYYY-MM-DD'), 400);
  if (!reportContainers().includes(container)) {
    throw withStatus(new Error('that container is not read by the archive dry run'), 400);
  }
  return { reportId, runId, container };
}

/**
 * The containers a dry run reads a backup file for: the ones an archive
 * would write, and the seven waiting for the owner. A container that is left
 * out for a known reason is not read at all; its count comes from the
 * backup's own manifest.
 */
export function reportContainers() {
  return [...archivePlan(), ...UNCLASSIFIED].sort();
}

const bump = (map, key) => {
  map[key] = (map[key] || 0) + 1;
};

/**
 * @param {object} deps
 * @param {{ readJson: Function, putJson: Function, listNames: Function, readGzipStream: Function }} deps.blobs
 * @param {() => Date} [deps.now]
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 */
export function createReportWorker({ blobs, now = () => new Date(), log = {} }) {
  async function* records(runId, container, signal) {
    const name = blobNames({ mode: 'full', runId, container }).data;
    const source = await blobs.readGzipStream(name);
    if (!source) return;
    for await (const line of gzipLines(source)) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      if (!line.trim()) continue;
      let doc;
      try {
        doc = JSON.parse(line);
      } catch {
        doc = undefined; // counted as unreadable by the caller
      }
      yield doc;
    }
  }

  /** The ids of `content` the versions rule needs, from the same backup. */
  async function contentIndexFor(runId, signal) {
    const index = createContentIndex();
    for await (const doc of records(runId, 'content', signal)) index.add(doc);
    return index;
  }

  /**
   * Read one container's backup file and write its part of the report.
   * @param {{ reportId: string, runId: string, container: string, signal?: AbortSignal }} job
   */
  async function readContainer({ reportId, runId, container, signal }) {
    const startedAt = now();
    const decision = archiveDecisionFor(container);
    const unclassified = decision?.reason === REASONS.unclassified;
    const names = reportNames(reportId, container);
    const part = {
      container,
      decision: decision?.decision || DECISIONS.leaveOut,
      reason: decision?.reason || null,
      inBackup: true,
      read: 0,
      kept: 0,
      changed: 0,
      leftOut: 0,
      leftOutBy: {},
      removed: {},
      unreadable: 0,
    };
    const fieldNames = {};
    let otherNames = 0;
    let truncated = false;

    const exists = (await blobs.listNames(blobNames({ mode: 'full', runId, container }).data)).length > 0;
    if (!exists) {
      part.inBackup = false;
    } else {
      const contentIndex = container === 'content_versions' ? await contentIndexFor(runId, signal) : null;
      for await (const doc of records(runId, container, signal)) {
        part.read += 1;
        if (doc === undefined) {
          part.unreadable += 1;
          continue;
        }
        if (unclassified && doc && typeof doc === 'object' && !Array.isArray(doc)) {
          for (const key of Object.keys(doc)) {
            if (key.startsWith('_')) continue; // the database's own fields (_ts, _etag, _rid)
            if (!FIELD_NAME.test(key)) otherNames += 1;
            else if (Object.hasOwn(fieldNames, key)) fieldNames[key] += 1;
            else if (Object.keys(fieldNames).length < MAX_FIELD_NAMES) fieldNames[key] = 1;
            else truncated = true;
          }
        }
        const result = archiveRecord(container, doc, { contentIndex });
        if (!result.keep) {
          part.leftOut += 1;
          bump(part.leftOutBy, result.reason || REASONS.unlisted);
          continue;
        }
        part.kept += 1;
        if (result.removed.length) {
          part.changed += 1;
          for (const field of result.removed) bump(part.removed, field);
        }
      }
    }
    if (unclassified) {
      part.fieldNames = Object.entries(fieldNames)
        .map(([name, records]) => ({ name, records }))
        .sort((a, b) => a.name.localeCompare(b.name));
      part.fieldNamesTruncated = truncated;
      part.otherNames = otherNames;
    }
    part.durationMs = now().getTime() - startedAt.getTime();
    part.completedAt = now().toISOString();
    await blobs.putJson(names.part, part);
    log.log?.(
      `[archiveReport] ${container}: ${part.read} read, ${part.kept} would be kept, ${part.changed} with fields removed, ${part.leftOut} left out, ${part.durationMs} ms`
    );
    const completion = await completeIfLast({ reportId });
    // The job's own result: counts only. The field names stay in the part file.
    return {
      container,
      read: part.read,
      kept: part.kept,
      changed: part.changed,
      leftOut: part.leftOut,
      unreadable: part.unreadable,
      durationMs: part.durationMs,
      reportWritten: completion.written,
    };
  }

  /** Write `report.json` if every part is present and nobody has written it yet. */
  async function completeIfLast({ reportId }) {
    const names = reportNames(reportId);
    const run = await blobs.readJson(names.run);
    if (!run || !Array.isArray(run.containers)) return { written: false, reason: 'no-run' };
    const present = new Set(await blobs.listNames(names.prefix));
    if (present.has(names.report)) return { written: false, reason: 'exists' };
    const missing = run.containers.filter((c) => !present.has(reportNames(reportId, c).part));
    if (missing.length) return { written: false, reason: 'incomplete', missing: missing.length };

    const backupDocs = new Map((run.backup?.containers || []).map((row) => [row.container, count(row.docs)]));
    const containers = [];
    for (const container of run.containers) {
      const part = (await blobs.readJson(reportNames(reportId, container).part)) || {};
      const expected = backupDocs.has(container) ? backupDocs.get(container) : null;
      containers.push({
        ...part,
        container,
        backupDocs: expected,
        // ADR 0046, "validated when": what the dry run read is what the backup says it wrote.
        matchesBackup: expected === null ? null : expected === count(part.read),
      });
    }
    const sum = (key) => containers.reduce((n, c) => n + count(c[key]), 0);
    const report = {
      reportId,
      sourceBackup: { mode: 'full', runId: run.backup?.runId || null },
      startedAt: run.startedAt || null,
      completedAt: now().toISOString(),
      totals: {
        containersRead: containers.length,
        read: sum('read'),
        kept: sum('kept'),
        changed: sum('changed'),
        leftOut: sum('leftOut'),
        unreadable: sum('unreadable'),
        mismatched: containers.filter((c) => c.matchesBackup === false).length,
      },
      containers,
      leftOutWhole: run.leftOutWhole || [],
      notInBackup: run.notInBackup || [],
    };
    const won = await blobs.putJson(names.report, report, { overwrite: false });
    if (!won) return { written: false, reason: 'lost-race' };
    log.log?.(
      `[archiveReport] report complete: ${containers.length} containers read, ${report.totals.read} records, ${report.totals.kept} would be kept, ${report.totals.leftOut} left out`
    );
    return { written: true };
  }

  return { readContainer, completeIfLast };
}

// ── Starting a dry run ───────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {{ upsertDoc: Function }} deps.store - the `jobs` container writer
 * @param {{ readJson: Function, putJson: Function }} deps.blobs - the export blob store
 * @param {(messages: {jobId: string, type: string}[]) => void} deps.enqueue
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createReportScheduler({ store, blobs, enqueue, now = () => new Date(), uuid = randomUUID }) {
  /**
   * Claim a report and queue its jobs.
   * @param {{ requestedBy?: object|null }} [options]
   * @returns {Promise<{ started: boolean, reason?: string, reportId?: string, sourceRun?: string, queued?: number }>}
   */
  async function start({ requestedBy = null } = {}) {
    const at = now();
    const backup = await findLatestFullBackup({ blobs, now: at });
    if (!backup) return { started: false, reason: 'no-backup' };

    const inBackup = new Set(backup.containers.map((row) => row.container));
    const docsOf = new Map(backup.containers.map((row) => [row.container, row.docs]));
    const containers = reportContainers().filter((name) => inBackup.has(name));
    const wanted = new Set(reportContainers());
    // Left out whole for a known reason: not read, counted from the backup's own manifest.
    const leftOutWhole = backup.containers
      .filter((row) => !wanted.has(row.container))
      .map((row) => ({
        container: row.container,
        reason: archiveDecisionFor(row.container)?.reason || REASONS.unclassified,
        backupDocs: row.docs,
      }));
    // Named by the classification and absent from the backup: nothing to read.
    const notInBackup = archiveClassifiedContainers()
      .filter((name) => !inBackup.has(name))
      .map((name) => {
        const decision = archiveDecisionFor(name);
        return { container: name, decision: decision.decision, reason: decision.reason };
      });

    const reportId = reportIdFor(at);
    const names = reportNames(reportId);
    const claimed = await blobs.putJson(
      names.run,
      {
        reportId,
        startedAt: at.toISOString(),
        backup: { runId: backup.runId, containers: backup.containers.map((row) => ({ container: row.container, docs: docsOf.get(row.container) })) },
        containers,
        leftOutWhole,
        notInBackup,
      },
      { overwrite: false }
    );
    if (!claimed) return { started: false, reason: 'already-started', reportId };
    await blobs.putJson(names.latest, { reportId, startedAt: at.toISOString() });

    const messages = [];
    for (const container of containers) {
      const jobId = uuid();
      await store.upsertDoc(
        JOBS_CONTAINER,
        newJobDoc({
          id: jobId,
          type: REPORT_JOB_TYPE,
          payload: { reportId, runId: backup.runId, container },
          requestedBy,
          createdAt: now().toISOString(),
        })
      );
      messages.push({ jobId, type: REPORT_JOB_TYPE });
    }
    if (messages.length) enqueue(messages);
    return { started: true, reportId, sourceRun: backup.runId, queued: messages.length };
  }

  return { start };
}

// ── Reading the newest report ────────────────────────────────────────────────

/**
 * The newest report, finished or not.
 * @param {{ blobs: { readJson: Function, listNames: Function } }} deps
 * @returns {Promise<null | { reportId: string, complete: boolean, report?: object, startedAt?: string|null, sourceRun?: string|null, done?: number, expected?: number }>}
 */
export async function readLatestReport({ blobs }) {
  const latest = await blobs.readJson(reportNames('x').latest);
  const reportId = typeof latest?.reportId === 'string' && REPORT_ID.test(latest.reportId) ? latest.reportId : null;
  if (!reportId) return null;
  const names = reportNames(reportId);
  const report = await blobs.readJson(names.report);
  if (report && typeof report === 'object') return { reportId, complete: true, report };
  const run = await blobs.readJson(names.run);
  const expected = Array.isArray(run?.containers) ? run.containers.length : 0;
  const present = await blobs.listNames(names.prefix);
  return {
    reportId,
    complete: false,
    startedAt: typeof run?.startedAt === 'string' ? run.startedAt : null,
    sourceRun: typeof run?.backup?.runId === 'string' ? run.backup.runId : null,
    done: present.filter((name) => name.endsWith('.part.json')).length,
    expected,
  };
}
