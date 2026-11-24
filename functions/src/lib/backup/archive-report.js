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
 * For EVERY container it reads it also lists the NAMES of the top-level
 * fields, and looks, at any depth, for fields whose name looks like a secret
 * or someone's contact details. It reports those in two separate lists: the
 * names that are TAKEN OUT before archiving, and the names that WOULD REMAIN
 * in the archive. For each name that would remain it says where it sits (the
 * names of the fields above it), in how many records, and what KIND of value
 * it holds (a number, true/false, a date, short or long text, a list, an
 * object), so the owner can tell a token count from a token. Only a name
 * that would remain, is not kept on purpose, and holds something other than
 * numbers and true/false is flagged.
 *
 * WHAT IT NEVER DOES. It writes nothing into `content-archive`, changes no
 * record and no backup file, and keeps no record, no id and no field value:
 * names of containers, names of fields, counts, sizes and times only.
 *
 * A FIELD NAME CAN ITSELF BE AN ID. A record shaped as a list keyed by
 * visitor id has ids for field names. So a name is printed only when it is
 * COMMON and PLAIN (`listableNames` below says exactly what that means);
 * every other name is only counted.
 *
 * WHERE THE REPORT IS KEPT, AND FOR HOW LONG. In the private
 * `cosmos-export-state` blob container, under
 * `state/archive-report/<report>/`. That container is the backup's own
 * working state (it has no rule that deletes files and none that locks
 * them), so the report does not depend on `content-archive` existing yet and
 * never mixes with a real archive. Because no storage rule deletes a report,
 * this file does: starting a dry run deletes every report older than
 * REPORT_KEEP_DAYS.
 *
 * HOW ONE RUN WORKS. The admin route (archive-handlers.js) finds the backup,
 * claims a report id by writing `run.json` create-only (so a double press
 * makes one run), and queues one platform job per container to read. Only
 * when every job row is written does it point `latest.json` at the new
 * report, so a start that broke half-way leaves the card on the report
 * before it and the button free to press again. Each
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
  SENSITIVE_KEPT_ON_PURPOSE,
  UNCLASSIFIED,
  archiveClassifiedContainers,
  archiveDecisionFor,
  archiveDocumentLabel,
  archivePlan,
  archiveRecord,
  createContentIndex,
  looksSensitive,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_ID = /^\d{8}T\d{4}Z$/;
const RUN_ID = /^\d{4}-\d{2}-\d{2}$/;

// ── Which field names may be printed ─────────────────────────────────────────

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-/i;
const HEX_RUN = /[0-9a-f]{12,}/i;

/**
 * Is this name PLAIN: one that reads like a field a programmer named, not
 * like an id, an address or text someone typed? All of these must hold:
 *
 *   - it starts with a letter and holds only letters, digits, `_` and `-`
 *     (so no `@`, no space and no dot: `jane.doe` and `a@b.c` are out);
 *   - it is at most MAX_NAME_LENGTH characters;
 *   - it has no run of four or more digits (`user_12345` is out);
 *   - it is not shaped like a UUID and has no long run of hex characters.
 *
 * @param {unknown} name
 */
export function isPlainName(name) {
  return (
    typeof name === 'string' &&
    name.length <= MAX_NAME_LENGTH &&
    /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) &&
    !/\d{4,}/.test(name) &&
    !UUID_SHAPE.test(name) &&
    !HEX_RUN.test(name)
  );
}

/** How many records must carry a name before it is printed, for a container of `read` records. */
export function nameThreshold(read) {
  return Math.max(MIN_NAME_RECORDS, Math.ceil(count(read) * MIN_NAME_SHARE));
}

/**
 * The names to print from a tally of plain names, most common first, then
 * by name. A name is printed only when it is COMMON: at least
 * MIN_NAME_RECORDS records carry it, and at least 1 in 100 of the
 * container's records. So a container with one record prints no name at
 * all, and a name only one visitor's record has is never printed.
 *
 * @param {Map<string, number>} tally - plain name → records that carry it
 * @param {number} read - records read
 * @param {number} [limit]
 * @returns {{ names: { name: string, records: number }[], truncated: boolean }}
 */
export function listableNames(tally, read, limit = MAX_FIELD_NAMES) {
  const least = nameThreshold(read);
  const common = [...tally]
    .filter(([, records]) => records >= least)
    .map(([name, records]) => ({ name, records }))
    .sort((a, b) => b.records - a.records || a.name.localeCompare(b.name));
  return { names: common.slice(0, limit), truncated: common.length > limit };
}

/**
 * The names in one record, at any depth, that look like a secret or
 * someone's contact details (archive-classification.js looksSensitive).
 * Names only: a value is never read, copied or returned. Bounded, so one
 * huge record cannot hold a job: past the depth or the size limit the search
 * stops and says so.
 *
 * @param {unknown} doc
 * @returns {{ names: Set<string>, cutShort: boolean }}
 */
export function sensitiveNamesIn(doc) {
  const names = new Set();
  let nodes = 0;
  let cutShort = false;
  const stack = [[doc, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    nodes += 1;
    if (depth > SENSITIVE_MAX_DEPTH || nodes > SENSITIVE_MAX_NODES) {
      cutShort = true;
      continue;
    }
    const push = (inner) => {
      if (inner === null || typeof inner !== 'object') return;
      if (stack.length >= SENSITIVE_MAX_NODES) cutShort = true;
      else stack.push([inner, depth + 1]);
    };
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      continue;
    }
    for (const [key, inner] of Object.entries(value)) {
      if (looksSensitive(key)) names.add(key);
      push(inner);
    }
  }
  return { names, cutShort };
}

/** What a path shows in place of a field name that is not plain (it may be an id). */
export const ID_PART = '(id)';

/** The kinds of value the report tells apart. Words, never the value. */
export const VALUE_KINDS = Object.freeze(['number', 'yes-no', 'date', 'short-text', 'long-text', 'list', 'object', 'empty']);
/** Text shorter than this is "short text". A key or a token is usually shorter; a paragraph is longer. */
export const SHORT_TEXT_LENGTH = 64;
/** A field whose every value is one of these cannot hold a secret or an address: a count, or a yes/no. */
const HARMLESS_KINDS = new Set(['number', 'yes-no']);

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The kind of one value: `number`, `yes-no` (true or false), `date` (text
 * shaped like a date or a date and time), `short-text` (under
 * SHORT_TEXT_LENGTH characters), `long-text`, `list`, `object` or `empty`
 * (null, or text with nothing in it). The value itself is never returned.
 * @param {unknown} value
 */
export function valueKind(value) {
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'yes-no';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object') return 'object';
  if (typeof value !== 'string') return 'empty';
  if (DATE_LIKE.test(value)) return 'date';
  return value.length < SHORT_TEXT_LENGTH ? 'short-text' : 'long-text';
}

/**
 * Every field in one record, at any depth, whose name looks like a secret or
 * someone's contact details: where it sits and what kind of value it holds.
 *
 * `path` is the names of the fields above it and its own name, joined with
 * dots (`speakerProfile.email`). A part that is not a plain name
 * (`isPlainName`) shows as `(id)`, because a field name can itself be an id.
 * A position in a list adds no part. `plain` says whether the field's own
 * name may be printed. Bounded like `sensitiveNamesIn`.
 *
 * @param {unknown} doc
 * @returns {{ fields: Map<string, { name: string, path: string, plain: boolean, kinds: Record<string, number> }>, cutShort: boolean }}
 */
export function sensitiveFieldsIn(doc) {
  const fields = new Map();
  let nodes = 0;
  let cutShort = false;
  const stack = [[doc, 0, '']];
  while (stack.length) {
    const [value, depth, above] = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    nodes += 1;
    if (depth > SENSITIVE_MAX_DEPTH || nodes > SENSITIVE_MAX_NODES) {
      cutShort = true;
      continue;
    }
    const push = (inner, path) => {
      if (inner === null || typeof inner !== 'object') return;
      if (stack.length >= SENSITIVE_MAX_NODES) cutShort = true;
      else stack.push([inner, depth + 1, path]);
    };
    if (Array.isArray(value)) {
      for (const item of value) push(item, above);
      continue;
    }
    for (const [key, inner] of Object.entries(value)) {
      const plain = isPlainName(key);
      const path = `${above ? `${above}.` : ''}${plain ? key : ID_PART}`;
      if (looksSensitive(key)) {
        const field = fields.get(path) || { name: key, path, plain, kinds: {} };
        const kind = valueKind(inner);
        field.kinds[kind] = (field.kinds[kind] || 0) + 1;
        fields.set(path, field);
      }
      push(inner, path);
    }
  }
  return { fields, cutShort };
}

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
 * May the yearly archive start now? All five must hold:
 *
 *   1. the switch `CONTENT_ARCHIVE_ENABLED` is exactly `true`;
 *   2. today is on or after 1 February (UTC), so January is the month of grace;
 *   3. the `content-archive` container exists;
 *   4. last year's `manifest.json` does not exist (a year is archived once);
 *   5. a complete full backup dated on or after 2 February exists (the day
 *      after the yearly clean-up of talk proposals runs).
 *
 * `containerExists`, `manifestExists` and `backupRunId` are `null` when they
 * could not be read; not known is never read as "go". A container that is
 * not there is its own blocker and is NOT the same as "no manifest": storage
 * answers "not found" for a file in a missing container exactly as it does
 * for a missing file, so without condition 3 a container that was never
 * created, or was deleted, would read as "this year is not archived yet,
 * safe to start".
 *
 * @param {object} facts
 * @param {Record<string, string|undefined>} facts.env
 * @param {Date} facts.now
 * @param {boolean|null} facts.containerExists
 * @param {boolean|null} facts.manifestExists
 * @param {string|null} facts.backupRunId - the newest complete full backup's date, `YYYY-MM-DD`
 * @returns {{ start: boolean, year: number, earliestBackup: string, blockers: string[] }}
 */
export function archiveStartDecision({ env = process.env, now, containerExists, manifestExists, backupRunId }) {
  const at = new Date(now);
  const year = archiveYearFor(at);
  const opens = Date.UTC(year + 1, 1, 1); // 1 February of the year after
  const earliestBackup = `${year + 1}-02-02`;
  const blockers = [];
  if (env?.[ARCHIVE_SETTING] !== 'true') blockers.push('switch-off');
  if (at.getTime() < opens) blockers.push('before-1-february');
  if (containerExists === false) blockers.push('archive-container-missing');
  else if (containerExists !== true) blockers.push('archive-not-readable');
  else if (manifestExists === true) blockers.push('already-archived');
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
 * would write, and the ones waiting for the owner. A container that is left
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
    // Plain top-level names → records that carry each. Bounded (MAX_TALLIED_NAMES).
    const tally = new Map();
    let nameUses = 0;
    // Names that look sensitive, at any depth, in the records as read.
    const sensitive = { records: 0, keptRecords: 0, cutShort: 0, tally: new Map(), otherNames: 0 };
    const tallyName = (tally, name) => {
      if (tally.has(name)) tally.set(name, tally.get(name) + 1);
      else if (tally.size < MAX_TALLIED_NAMES) tally.set(name, 1);
      else return false;
      return true;
    };
    const noteSensitive = (names) => {
      for (const name of names) {
        if (!isPlainName(name) || !tallyName(sensitive.tally, name)) sensitive.otherNames += 1;
      }
    };
    // The same names, split by what happens to them: taken out before
    // archiving, or still there in what an archive would keep.
    const takenOut = { tally: new Map(), notPlain: 0, tooMany: 0 };
    const remaining = { entries: new Map(), notPlain: 0, tooMany: 0 };
    const onPurpose = SENSITIVE_KEPT_ON_PURPOSE[container] || {};
    const noteTakenOut = (names) => {
      for (const name of names) {
        if (!isPlainName(name)) takenOut.notPlain += 1;
        else if (!tallyName(takenOut.tally, name)) takenOut.tooMany += 1;
      }
    };
    const noteRemaining = (fields, document) => {
      for (const field of fields.values()) {
        // A name that is not plain may be an id or text someone typed: counted, never printed.
        if (!field.plain) {
          remaining.notPlain += 1;
          continue;
        }
        const key = `${document ?? ''}\u0000${field.path}`;
        let entry = remaining.entries.get(key);
        if (!entry) {
          if (remaining.entries.size >= MAX_TALLIED_NAMES) {
            remaining.tooMany += 1;
            continue;
          }
          entry = { document, path: field.path, name: field.name, records: 0, kinds: {} };
          remaining.entries.set(key, entry);
        }
        entry.records += 1;
        for (const [kind, n] of Object.entries(field.kinds)) entry.kinds[kind] = (entry.kinds[kind] || 0) + n;
      }
    };
    const namesOf = (fields) => new Set([...fields.values()].map((field) => field.name));

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
        let found = null;
        if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
          for (const key of Object.keys(doc)) {
            if (key.startsWith('_')) continue; // the database's own fields (_ts, _etag, _rid)
            nameUses += 1;
            if (!isPlainName(key)) continue;
            if (tally.has(key)) tally.set(key, tally.get(key) + 1);
            else if (tally.size < MAX_TALLIED_NAMES) tally.set(key, 1);
          }
          found = sensitiveFieldsIn(doc);
          if (found.cutShort) sensitive.cutShort += 1;
          if (found.fields.size) {
            sensitive.records += 1;
            noteSensitive(namesOf(found.fields));
          }
        }
        const result = archiveRecord(container, doc, { contentIndex });
        // The same question about what an archive would actually keep.
        const kept = !result.keep ? null : result.doc === doc && found ? found : sensitiveFieldsIn(result.doc);
        if (kept?.fields.size) {
          sensitive.keptRecords += 1;
          noteRemaining(kept.fields, archiveDocumentLabel(container, doc?.id));
        }
        if (found?.fields.size) {
          // Taken out: a name the record carried that what is kept no longer carries.
          const still = kept ? namesOf(kept.fields) : new Set();
          noteTakenOut([...namesOf(found.fields)].filter((name) => !still.has(name)));
        }
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
    // Field names, for every container read: only the common, plain ones (listableNames).
    const listed = listableNames(tally, part.read);
    part.fieldNames = listed.names;
    part.fieldNamesTruncated = listed.truncated;
    // How many times a field was met whose name is not printed above.
    part.otherNames = nameUses - listed.names.reduce((n, field) => n + field.records, 0);
    // Names that look like a secret or contact details. They come from a
    // fixed word list, so one record is enough to print a name, but the name
    // still has to be plain (an id that happens to contain "token" is only counted).
    const sensitiveNames = [...sensitive.tally]
      .map(([name, records]) => ({ name, records }))
      .sort((a, b) => b.records - a.records || a.name.localeCompare(b.name));
    // What would remain, one line per place a name sits. `quiet`: every value
    // seen was a number or true/false (a token COUNT, an "email verified"
    // switch), so it cannot be a secret or an address. `keptOnPurpose`: the
    // classification keeps it deliberately and says why. Neither is flagged.
    const remainingList = [...remaining.entries.values()]
      .map((entry) => {
        const kinds = Object.keys(entry.kinds).filter((kind) => kind !== 'empty');
        const quiet = kinds.length > 0 && kinds.every((kind) => HARMLESS_KINDS.has(kind));
        const keptOnPurpose = entry.path === entry.name && Object.hasOwn(onPurpose, entry.name) ? onPurpose[entry.name] : null;
        return { ...entry, quiet, keptOnPurpose, flagged: !quiet && !keptOnPurpose };
      })
      .sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.records - a.records || a.path.localeCompare(b.path) || String(a.document).localeCompare(String(b.document)));
    part.sensitive = {
      records: sensitive.records,
      keptRecords: sensitive.keptRecords,
      // The names as read, before anything is taken out (what earlier reports listed).
      names: sensitiveNames.slice(0, MAX_SENSITIVE_NAMES),
      namesNotShown: sensitive.otherNames + Math.max(0, sensitiveNames.length - MAX_SENSITIVE_NAMES),
      // Taken out before archiving: the record is left out, or the field is dropped.
      takenOut: [...takenOut.tally].map(([name, records]) => ({ name, records })).sort((a, b) => b.records - a.records || a.name.localeCompare(b.name)),
      // Uses of a name that is not printed, and why: it is shaped like an id
      // or typed text (`notPlain`), or the container has more different
      // names than one report tallies (`tooMany`).
      takenOutNotShown: { notPlain: takenOut.notPlain, tooMany: takenOut.tooMany },
      remaining: remainingList,
      remainingNotShown: { notPlain: remaining.notPlain, tooMany: remaining.tooMany },
      // What the red block is driven by: names that would remain and are not
      // explained, plus any that would remain and cannot be printed.
      flagged: remainingList.filter((entry) => entry.flagged).length + (remaining.notPlain || remaining.tooMany ? 1 : 0),
      cutShort: sensitive.cutShort,
    };
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
        sensitiveRecords: containers.reduce((n, c) => n + count(c.sensitive?.records), 0),
        sensitiveKeptRecords: containers.reduce((n, c) => n + count(c.sensitive?.keptRecords), 0),
        // Containers an archive would keep that hold a name to look at (see `flagged` in a part).
        flaggedContainers: containers.filter((c) => c.decision !== DECISIONS.leaveOut && count(c.sensitive?.flagged) > 0).length,
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
 * @param {{ readJson: Function, putJson: Function, listNames: Function, deleteReportFile?: Function }} deps.blobs - the export blob store
 * @param {(messages: {jobId: string, type: string}[]) => void} deps.enqueue
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createReportScheduler({ store, blobs, enqueue, now = () => new Date(), uuid = randomUUID }) {
  /**
   * Claim a report and queue its jobs.
   * @param {{ requestedBy?: object|null }} [options]
   * @returns {Promise<{ started: boolean, reason?: string, reportId?: string, sourceRun?: string, queued?: number, removedReports?: number }>}
   */
  async function start({ requestedBy = null } = {}) {
    const at = now();
    // One dry run at a time: while the newest one is still reading and is
    // young, a second would read the whole backup again for nothing.
    const newest = await readLatestReport({ blobs, now: at });
    if (newest && !newest.complete && !newest.stalled) {
      return { started: false, reason: 'in-progress', reportId: newest.reportId };
    }
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
    // Only now is the new report the newest one. If anything above failed,
    // `latest.json` still names the report before it: the card keeps showing
    // that one, nothing reads as "running", and the button can be pressed
    // again a minute later. The half-started folder is removed with the old
    // reports, below, once it is old enough.
    await blobs.putJson(names.latest, { reportId, startedAt: at.toISOString() });
    const removedReports = await removeOldReports({ keep: reportId, at }).catch(() => 0);
    return { started: true, reportId, sourceRun: backup.runId, queued: messages.length, removedReports };
  }

  /**
   * Delete every report older than REPORT_KEEP_DAYS. A report's age is read
   * from its own name (the minute it was asked for). Best effort: a failure
   * here never fails the dry run that was just started.
   */
  async function removeOldReports({ keep, at }) {
    if (typeof blobs.deleteReportFile !== 'function') return 0;
    const cutoff = at.getTime() - REPORT_KEEP_DAYS * DAY_MS;
    const old = new Set();
    for (const name of await blobs.listNames(REPORT_PREFIX)) {
      const id = name.slice(REPORT_PREFIX.length).split('/')[0];
      if (id === keep || !REPORT_ID.test(id)) continue;
      const asked = reportIdTime(id);
      if (asked === null || asked >= cutoff) continue;
      await blobs.deleteReportFile(name);
      old.add(id);
    }
    return old.size;
  }

  return { start, removeOldReports };
}

// ── Reading the newest report ────────────────────────────────────────────────

/** The UTC time a report id names, in milliseconds, or null. */
export function reportIdTime(reportId) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(String(reportId || ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The newest report, finished or not. One that is not finished also says
 * which containers are still missing, and `stalled: true` once it is older
 * than RUN_STALE_MINUTES: a job has 28 minutes at most, so by then the run
 * did not finish and will not.
 *
 * @param {{ blobs: { readJson: Function, listNames: Function }, now?: Date }} deps
 * @returns {Promise<null | { reportId: string, complete: boolean, report?: object, startedAt?: string|null, sourceRun?: string|null, done?: number, expected?: number, missing?: string[], stalled?: boolean }>}
 */
export async function readLatestReport({ blobs, now = new Date() }) {
  const latest = await blobs.readJson(reportNames('x').latest);
  const reportId = typeof latest?.reportId === 'string' && REPORT_ID.test(latest.reportId) ? latest.reportId : null;
  if (!reportId) return null;
  const names = reportNames(reportId);
  const report = await blobs.readJson(names.report);
  if (report && typeof report === 'object') return { reportId, complete: true, report };
  const run = await blobs.readJson(names.run);
  const wanted = Array.isArray(run?.containers) ? run.containers.filter((c) => typeof c === 'string') : [];
  const present = new Set(await blobs.listNames(names.prefix));
  const missing = wanted.filter((container) => !present.has(reportNames(reportId, container).part));
  const asked = reportIdTime(reportId);
  return {
    reportId,
    complete: false,
    startedAt: typeof run?.startedAt === 'string' ? run.startedAt : null,
    sourceRun: typeof run?.backup?.runId === 'string' ? run.backup.runId : null,
    done: wanted.length - missing.length,
    expected: wanted.length,
    // Container names only; they are this repository's own names.
    missing,
    stalled: asked === null || new Date(now).getTime() - asked >= RUN_STALE_MINUTES * 60 * 1000,
  };
}
