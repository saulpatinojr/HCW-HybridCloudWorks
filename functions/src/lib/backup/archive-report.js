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
 * in January, only when switched on" (ADR 0046 section 4). The daily check
 * that starts an archive (archive-job.js) asks it, and the status route uses
 * it to tell the owner what would happen today.
 *
 * WHERE THE CODE IS. This file is the dry run's front door and re-exports
 * the rest, which is split over a few files only to keep each one short
 * (archive-report-base.js lists them).
 */
export {
  ARCHIVE_CONTAINER,
  ARCHIVE_SETTING,
  BACKUP_LOOKBACK_DAYS,
  MAX_FIELD_NAMES,
  MAX_NAME_LENGTH,
  MAX_SENSITIVE_NAMES,
  MAX_TALLIED_NAMES,
  MIN_NAME_RECORDS,
  MIN_NAME_SHARE,
  REPORT_JOB_TYPE,
  REPORT_KEEP_DAYS,
  REPORT_PREFIX,
  RUN_STALE_MINUTES,
  SENSITIVE_MAX_DEPTH,
  SENSITIVE_MAX_NODES,
  archiveManifestName,
  archiveYearFor,
  gzipLines,
  reportIdFor,
  reportIdTime,
  reportNames,
} from './archive-report-base.js';
export {
  ID_PART,
  SHORT_TEXT_LENGTH,
  VALUE_KINDS,
  isPlainName,
  listableNames,
  nameThreshold,
  sensitiveFieldsIn,
  sensitiveNamesIn,
  valueKind,
} from './archive-report-fields.js';
export { archiveStartDecision, reportGate } from './archive-report-gate.js';
export {
  findLatestFullBackup,
  isUnnamedContainer,
  parseReportPayload,
  readLatestReport,
  reportContainers,
} from './archive-report-reading.js';
export { createReportWorker } from './archive-report-worker.js';
export { createReportScheduler } from './archive-report-scheduler.js';
