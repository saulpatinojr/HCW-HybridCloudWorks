/**
 * archive-handlers.js — the yearly content archive's two admin routes
 * (ADR 0046, issue #1811).
 *
 *   GET  cms/content-archive           where the archive stands, and the newest dry-run report   super_admin
 *   POST cms/content-archive/dry-run   start a dry run (queues one job per container)            super_admin
 *
 * WHY SUPER_ADMIN. The report lists field names of every container it reads,
 * some of which nobody has classified yet, and a dry run makes the Function
 * App read the whole weekly backup. Both are the owner's.
 *
 * WHAT THE GET ANSWERS. The switch (on or off), the year an archive taken
 * today would be of, whether one could start today and what stands in the
 * way (archive-report.js archiveStartDecision), the newest archive that was
 * written (year, when, files, records, bytes, how many files are in the
 * Archive tier), a run that is in progress and what it is still missing
 * (archive-job.js readArchiveProgress), the classification in numbers, and
 * the newest dry-run report or how far it has got.
 *
 * There is no route that starts an archive. It starts by itself, from the
 * nightly export's timer, when the switch is on (archive-job.js).
 *
 * WHAT IS NEVER IN AN ANSWER OR A LOG. A record, an id of a record, or a
 * field's value. Answers are `Cache-Control: private, no-store`; a failure is
 * logged by its code with a correlation id (http/error-response.js).
 */
import { recordMutationAudit } from '../audit.js';
import { errorCode, errorResponse } from '../http/error-response.js';
import {
  ADMIN_CONFIG_KEEP,
  ADMIN_SETTINGS_KEEP,
  ARCHIVE_AS_IS,
  ARCHIVE_CHANGED,
  LEFT_OUT,
  UNCLASSIFIED,
} from './archive-classification.js';
import { exportEnabled } from './cosmos-export.js';
import { ARCHIVE_LATE_HOURS, readArchiveProgress } from './archive-job.js';
import {
  ARCHIVE_CONTAINER,
  ARCHIVE_SETTING,
  archiveManifestName,
  archiveStartDecision,
  archiveYearFor,
  createReportScheduler,
  findLatestFullBackup,
  readLatestReport,
  REPORT_KEEP_DAYS,
  RUN_STALE_MINUTES,
} from './archive-report.js';

export const ARCHIVE_ROLE = 'super_admin';
export const DRY_RUN_AUDIT_ACTION = 'content_archive_dry_run_started';

const privateJson = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

/** The classification as numbers and names, for the card: no rule is restated in the page. */
function classificationSummary() {
  return {
    asIs: ARCHIVE_AS_IS.length,
    changed: Object.entries(ARCHIVE_CHANGED).map(([container, spec]) => ({
      container,
      // The only fields kept from a record, or null when every field is kept.
      keeps: spec.keeps ? [...spec.keeps] : null,
      records: spec.records,
    })),
    leftOut: Object.keys(LEFT_OUT).length - UNCLASSIFIED.length,
    unclassified: [...UNCLASSIFIED],
    adminConfigKept: ADMIN_CONFIG_KEEP.ids.length + ADMIN_CONFIG_KEEP.prefixes.length,
    adminSettingsKept: Object.keys(ADMIN_SETTINGS_KEEP.ids).length + ADMIN_SETTINGS_KEEP.prefixes.length,
  };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ upsertDoc: Function }} deps.store
 * @param {object} deps.blobs - the export blob store (the backup, and the reports)
 * @param {{ readJson: Function, containerExists: Function, listDetails: Function }} deps.archiveBlobs - a blob store on `content-archive`
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createArchiveHandlers({ guard, store, blobs, archiveBlobs, env = process.env, now = () => new Date(), uuid }) {
  /**
   * Where the archive's container stands for one year, as two separate facts:
   *
   *   containerExists  true, false, or null when that could not be asked
   *   archived         true (the year's manifest is there), false (the
   *                    container is there and the manifest is not), or null
   *                    (not known: the container is missing or unreadable)
   *
   * Asked in this order on purpose. Storage answers "not found" for a file
   * in a container that does not exist exactly as for a file that does not
   * exist, so reading the manifest alone would turn "the container was never
   * created" into "this year is not archived", which is the one answer that
   * lets an archive start.
   */
  async function archiveState(year, context) {
    let containerExists = null;
    try {
      containerExists = (await archiveBlobs.containerExists()) === true;
    } catch (error) {
      context?.warn?.(`contentArchive: could not ask whether the archive container exists (${errorCode(error)})`);
      return { containerExists: null, archived: null };
    }
    if (!containerExists) return { containerExists: false, archived: null };
    try {
      return { containerExists: true, archived: (await archiveBlobs.readJson(archiveManifestName(year))) !== null };
    } catch (error) {
      context?.warn?.(`contentArchive: the archive container could not be read (${errorCode(error)})`);
      return { containerExists: true, archived: null };
    }
  }

  return {
    /** GET cms/content-archive */
    async getStatus(request, context) {
      const auth = await guard.requireRole(request, ARCHIVE_ROLE);
      if (auth.error) return auth.error;
      try {
        const at = now();
        const year = archiveYearFor(at);
        const [backup, state, latest] = await Promise.all([
          findLatestFullBackup({ blobs, now: at }),
          archiveState(year, context),
          readLatestReport({ blobs, now: at }),
        ]);
        const { archived, containerExists } = state;
        // The newest archive and a run in progress. Read only when the
        // container is there and could be read just now; a failure to read
        // is "not known", not "none".
        let progress = { lastArchive: null, run: null };
        let progressKnown = containerExists === true && archived !== null;
        if (progressKnown) {
          try {
            progress = await readArchiveProgress({ backupBlobs: blobs, archiveBlobs, year, archived, now: at });
          } catch (error) {
            context?.warn?.(`contentArchive: the archive's progress could not be read (${errorCode(error)})`);
            progressKnown = false;
          }
        }
        const decision = archiveStartDecision({
          env,
          now: at,
          containerExists,
          manifestExists: archived,
          backupRunId: backup?.runId ?? null,
        });
        return privateJson(200, {
          ok: true,
          setting: ARCHIVE_SETTING,
          switchOn: env?.[ARCHIVE_SETTING] === 'true',
          // The job that writes an archive exists (archive-job.js). It starts
          // from the nightly export's timer, so that has to be on as well.
          jobBuilt: true,
          exportOn: exportEnabled(env || {}),
          // The newest finished archive, a run in progress, or null for each.
          // progressKnown false: they could not be read, so null says nothing.
          progressKnown,
          lastArchive: progress.lastArchive,
          run: progress.run,
          lateAfterHours: ARCHIVE_LATE_HOURS,
          archiveContainer: ARCHIVE_CONTAINER,
          year,
          archiveContainerExists: containerExists,
          archived,
          wouldStart: decision.start,
          blockers: decision.blockers,
          earliestBackup: decision.earliestBackup,
          latestBackup: backup ? { runId: backup.runId, containers: backup.containers.length } : null,
          classification: classificationSummary(),
          latest,
          // Where reports are kept and for how long, so the card can say so.
          reports: { container: 'cosmos-export-state', prefix: 'state/archive-report/', keepDays: REPORT_KEEP_DAYS, staleMinutes: RUN_STALE_MINUTES },
          checkedAt: at.toISOString(),
        });
      } catch (failure) {
        return errorResponse(context, 'Failed to read the content archive’s state', failure, 500, request);
      }
    },

    /** POST cms/content-archive/dry-run */
    async startDryRun(request, context, io = {}) {
      const auth = await guard.requireRole(request, ARCHIVE_ROLE);
      if (auth.error) return auth.error;
      if (typeof io.enqueue !== 'function') {
        context?.error?.('contentArchiveDryRun: no queue output wired');
        return privateJson(500, { ok: false, error: 'Job queue is not configured' });
      }
      try {
        const result = await createReportScheduler({
          store,
          blobs,
          enqueue: io.enqueue,
          now,
          ...(uuid ? { uuid } : {}),
        }).start({ requestedBy: auth.user ?? null });
        if (!result.started && result.reason === 'no-backup') {
          return privateJson(409, {
            ok: false,
            error: 'no_backup',
            message:
              'No complete weekly full backup was found in the last 35 days, so there is nothing to read. The nightly export has to be on, and a Sunday run has to have finished (Health, Overview, Nightly export).',
          });
        }
        if (!result.started && result.reason === 'in-progress') {
          return privateJson(409, {
            ok: false,
            error: 'in_progress',
            message: `A dry run is still reading the backup. Wait for its report, or press again once it is more than ${RUN_STALE_MINUTES} minutes old; a run that has not finished by then did not finish.`,
          });
        }
        if (!result.started) {
          return privateJson(409, {
            ok: false,
            error: 'already_started',
            message: 'A dry run was started in this same minute. Its report will appear here when it finishes.',
          });
        }
        // One row per run, with numbers only.
        await recordMutationAudit(store, {
          action: DRY_RUN_AUDIT_ACTION,
          actor: auth.user,
          resource: 'content-archive:dry-run',
          details: { sourceBackup: result.sourceRun, containersQueued: result.queued },
          now,
          ...(uuid ? { uuid } : {}),
          context,
        });
        return privateJson(202, {
          ok: true,
          started: true,
          sourceBackup: result.sourceRun,
          queued: result.queued,
        });
      } catch (failure) {
        return errorResponse(context, 'Failed to start the archive dry run', failure, 500, request);
      }
    },
  };
}
