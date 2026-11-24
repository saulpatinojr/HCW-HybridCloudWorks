/**
 * archive-handlers.js — the yearly content archive's two admin routes
 * (ADR 0046, issue #1811).
 *
 *   GET  cms/content-archive           where the archive stands, and the newest dry-run report   super_admin
 *   POST cms/content-archive/dry-run   start a dry run (queues one job per container)            super_admin
 *
 * WHY SUPER_ADMIN. The report lists the field names of containers nobody has
 * classified yet, and a dry run makes the Function App read the whole weekly
 * backup. Both are the owner's.
 *
 * WHAT THE GET ANSWERS. The switch (on or off), the year an archive taken
 * today would be of, whether one could start today and what stands in the
 * way (archive-report.js archiveStartDecision), the classification in
 * numbers, and the newest dry-run report or how far it has got. It also says
 * plainly that the job that writes an archive is not built yet: until phase
 * 3 of ADR 0046 the switch starts nothing.
 *
 * WHAT IS NEVER IN AN ANSWER OR A LOG. A record, an id of a record, or a
 * field's value. Answers are `Cache-Control: private, no-store`; a failure is
 * logged by its code with a correlation id (http/error-response.js).
 */
import { recordMutationAudit } from '../audit.js';
import { errorCode, errorResponse } from '../http/error-response.js';
import {
  ADMIN_CONFIG_KEEP,
  ARCHIVE_AS_IS,
  ARCHIVE_CHANGED,
  LEFT_OUT,
  UNCLASSIFIED,
} from './archive-classification.js';
import {
  ARCHIVE_CONTAINER,
  ARCHIVE_SETTING,
  archiveManifestName,
  archiveStartDecision,
  archiveYearFor,
  createReportScheduler,
  findLatestFullBackup,
  readLatestReport,
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
      fields: [...spec.fields],
      records: spec.records,
    })),
    leftOut: Object.keys(LEFT_OUT).length - UNCLASSIFIED.length,
    unclassified: [...UNCLASSIFIED],
    adminConfigKept: ADMIN_CONFIG_KEEP.ids.length + ADMIN_CONFIG_KEEP.prefixes.length,
  };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ upsertDoc: Function }} deps.store
 * @param {object} deps.blobs - the export blob store (the backup, and the reports)
 * @param {{ readJson: Function }} deps.archiveBlobs - a blob store on `content-archive`
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createArchiveHandlers({ guard, store, blobs, archiveBlobs, env = process.env, now = () => new Date(), uuid }) {
  /** true, false, or null when the container could not be read (it may not exist yet). */
  async function manifestExists(year, context) {
    try {
      return (await archiveBlobs.readJson(archiveManifestName(year))) !== null;
    } catch (error) {
      context?.warn?.(`contentArchive: the archive container could not be read (${errorCode(error)})`);
      return null;
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
        const [backup, archived, latest] = await Promise.all([
          findLatestFullBackup({ blobs, now: at }),
          manifestExists(year, context),
          readLatestReport({ blobs }),
        ]);
        const decision = archiveStartDecision({
          env,
          now: at,
          manifestExists: archived,
          backupRunId: backup?.runId ?? null,
        });
        return privateJson(200, {
          ok: true,
          setting: ARCHIVE_SETTING,
          switchOn: env?.[ARCHIVE_SETTING] === 'true',
          // Phase 3 of ADR 0046 builds the job. Until then the switch starts nothing.
          jobBuilt: false,
          archiveContainer: ARCHIVE_CONTAINER,
          year,
          archived,
          wouldStart: decision.start,
          blockers: decision.blockers,
          earliestBackup: decision.earliestBackup,
          latestBackup: backup ? { runId: backup.runId, containers: backup.containers.length } : null,
          classification: classificationSummary(),
          latest,
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
